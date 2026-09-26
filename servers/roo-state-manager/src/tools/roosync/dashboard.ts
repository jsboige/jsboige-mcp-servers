/**
 * Outil MCP : roosync_dashboard
 *
 * Dashboards markdown partagés pour la collaboration cross-machine.
 * Support 3 types : global, machine, workspace.
 *
 * Architecture stockage :
 *   .shared-state/dashboards/
 *     global.md
 *     machine-{machineId}.md
 *     workspace-{workspaceName}.md
 *     archive/
 *       {key}-{date}.md
 *
 * Format fichier Markdown avec frontmatter YAML :
 *   ---
 *   type: workspace
 *   lastModified: 2026-03-19T08:30:00Z
 *   lastModifiedBy:
 *     machineId: myia-po-2023
 *     workspace: roo-extensions
 *   ---
 *
 *   ## Status
 *   ...
 *
 *   ## Intercom
 *   ...
 *
 * @module tools/roosync/dashboard
 * @version 2.0.0
 * @issue #675
 */

import { z } from 'zod';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import * as yaml from 'js-yaml';
import { getSharedStatePath, assertSharedStoreAccessible, ensureStoreSubdir } from '../../utils/shared-state-path.js';
import { createKnownValueMasker, maskSecretTextForPublication, FORM_LAYER_MARKER } from '../../utils/secret-redaction.js';
import { redactSecrets } from '../../services/task-indexer/EmbeddingValidator.js';
import { getLocalMachineId, getLocalWorkspaceId } from '../../utils/message-helpers.js';
import { createLogger, Logger } from '../../utils/logger.js';
import { getChatOpenAIClient, getLLMModelId, getFallbackChatOpenAIClient, getFallbackLLMModelId } from '../../services/openai.js';
import {
  sendMentionNotificationsAsync,
  sendStructuredMentionNotificationsAsync,
  resolveMentionTarget
} from '../../utils/dashboard-helpers.js';
import type OpenAI from 'openai';
import { recordRooSyncActivityAsync } from './heartbeat-activity.js';
// #3226(a): global read cursor — advances ONLY on an effective read of the
// global dashboard so the [NOTIF] footer can report what the reader has missed.
import { advanceGlobalSeenCursor } from '../../notifications/GlobalNotifState.js';
// #3151 Phase C: PG persistence for dashboards (read PG-primary, dual-write)
import {
  readDashboardFromPg,
  dualWriteDashboardSync,
  dualWriteDashboardDelete,
  getDashboardPgReader,
  dualWriteDashboardSyncChecked,
  probeDashboardJournalForHydration,
  getDashboardRetirement,
  listRetiredDashboardKeys,
  retireDashboardKeyChecked,
} from '../../services/unified-store/roosync-dashboard-store.js';
// #3782: journal-level retirement mark (mark, never DELETE — gel des purges)
import type { DashboardRetirementMark } from '../../services/unified-store/types.js';
// #3482-follow: the fork predicate + root recovery live in the reconcile
// module, which owns the "fork by construction" policy. Sharing them keeps the
// enumeration-side detector and the pass that refuses to touch forks in sync
// (import is acyclic: that module imports dashboard-markdown + the store, never
// this file).
import {
  isGdriveConflictCopyFile,
  canonicalKeyOfFork,
} from '../../services/unified-store/roosync-dashboard-reconcile.js';
// #3151 Phase C: markdown parsing + message-id generation extracted to a
// dependency-light module (backfill script imports it without pulling the LLM
// client wiring of this tool module).
import {
  parseDashboardMarkdown,
  generateMessageId,
} from './dashboard-markdown.js';

// #1470: Single source of truth schemas from dedicated module
// No handler logic imported — safe circular-dep-free module
import {
  AuthorSchema,
  IntercomMessageSchema,
  UserIdSchema,
  MentionSchema,
  CrossPostSchema,
  DashboardArgsSchema,
  TeamStageSchema,
  type Author,
  type IntercomMessage,
  type UserId,
  type Mention,
  type CrossPost,
  type Dashboard,
  type DashboardFrontmatter,
  type DashboardArgs,
  type TeamStage
} from './dashboard-schemas.js';

// Re-export schemas and types for backward compatibility
export {
  AuthorSchema,
  IntercomMessageSchema,
  UserIdSchema,
  MentionSchema,
  CrossPostSchema,
  DashboardArgsSchema,
  TeamStageSchema,
  type Author,
  type IntercomMessage,
  type UserId,
  type Mention,
  type CrossPost,
  type Dashboard,
  type DashboardFrontmatter,
  type DashboardArgs,
  type TeamStage
};

const logger: Logger = createLogger('DashboardTool');

// Auto-condensation: size-based (50KB) + keep 10 most recent messages
// When dashboard file exceeds MAX_DASHBOARD_SIZE_BYTES, condense old messages
// into the status section via LLM, keeping only CONDENSE_KEEP recent messages.
const MAX_DASHBOARD_SIZE_BYTES = 50 * 1024; // 50 KB
const CONDENSE_KEEP = 10;

// #2598: Byte-budget the kept-message window. The old policy kept a FIXED
// CONDENSE_KEEP (10) most-recent messages regardless of their byte size.
// Combined with the 15KB status cap, that pinned the post-condense floor at
// ~15KB (status) + 10×~3KB (kept messages) ≈ 45KB — essentially equal to the
// 46KB preemptive threshold. With zero headroom, every subsequent post
// re-crossed the threshold and re-condensed (observed on workspace-CoursIA:
// condensation on nearly every append, each a multi-second LLM round-trip).
// Retaining the most-recent messages up to a byte budget instead caps the
// intercom contribution to the floor: floor ≈ 15KB status + 16KB intercom
// = 31KB, ~15KB below the threshold = several posts between condensations.
const CONDENSE_KEEP_MIN = 4;                       // always keep >= this many recent messages
const KEEP_INTERCOM_BUDGET_BYTES = 16 * 1024;      // 16 KB target for retained intercom

// #1497: Preemptive condensation threshold (92% of MAX)
// Triggered BEFORE appending a new message when the dashboard is near-full, so
// that the condense (which can take ~30s via LLM) completes on smaller data
// and does not timeout the client call at 96%+ utilization (reported by
// nanoclaw-cluster, 2026-04-17T22:17Z). Rationale: appending to a 96% dashboard
// forces condense of ~50 messages at LLM speed; pre-condensing at 92% keeps
// the working set smaller and shifts the latency into more predictable slots.
const PREEMPTIVE_CONDENSE_THRESHOLD_BYTES = Math.floor(MAX_DASHBOARD_SIZE_BYTES * 0.92); // ~46 KB

// #1589: Per-message size cap. Messages larger than this are split into multiple
// parts at append time, so each part is subject to the CONDENSE_KEEP slice policy
// independently. Prevents the pathological case where 3 "recent" 15KB dispatches
// protect themselves from archival (all within the CONDENSE_KEEP=10 window) while
// the dashboard sits above the 50KB threshold, producing an infinite condensation
// loop (reported on workspace-CoursIA + po-2025, 2026-04-20, 10+min appends).
const MAX_INDIVIDUAL_MESSAGE_BYTES = 4 * 1024; // 4 KB per part

// Size limits for LLM outputs (bytes). If exceeded, retry with a stricter prompt.
const MAX_STATUS_SIZE_BYTES = 15 * 1024;  // 15 KB
const MAX_SUMMARY_SIZE_BYTES = 5 * 1024;  // 5 KB
const LLM_MAX_RETRIES = 3;
const LLM_INITIAL_BACKOFF_MS = 2000; // 2s, doubles each retry
// #2998: Cloud fallback retry — the fallback endpoint (z.ai) intermittently returns
// 429 (service overloaded) which is transient by definition. Retry up to 3 times
// with exponential backoff, matching the primary's retry pattern. Only 429 and 5xx
// are retried — 401/403 (auth) won't heal with a backoff.
const FB_MAX_ATTEMPTS = 3;
const FB_INITIAL_BACKOFF_MS = 2000;

// #2267 follow-up: per-request timeout for condensation LLM calls. Runaway
// generation is already bounded UNDER the ~600s IIS→vLLM gateway by
// CONDENSE_LLM_MAX_TOKENS, so the only thing the old 1800s/900s ceilings ever
// caught was a TRUE hang (socket held open, neither a response nor a 502). Sit
// just above the gateway (default 720s) so legitimate slow-but-completing
// condensations (user mandate: "qu'elle prenne longtemps… mais elle doit
// aboutir") and gateway-502 runaways still succeed / retry stochastically, while
// a real hang fast-fails to the #1792 truncation fallback in ~12 min instead of
// blocking the dashboard the full 1800s registry ceiling (#2267 incident).
// Env-overridable (raise to tolerate slower GPUs).
const CONDENSE_LLM_TIMEOUT_MS = Number(process.env.CONDENSE_LLM_TIMEOUT_MS) || 720000;

// #2818: TTL for the cross-process condensation file-lock. A live holder always
// releases in its `finally`; this TTL only recovers a lock left behind by a
// CRASHED holder (process killed mid-condense). Set comfortably above one full
// LLM timeout (720s) so a legitimately slow-but-completing condensation is never
// mistaken for a crash and stolen out from under. A false steal costs only a
// redundant condense (never correctness — applyCondensedWithMerge/#2328 remains
// the merge backstop), so we err on the generous side. Env-overridable.
const CONDENSE_LOCK_TTL_MS = Number(process.env.CONDENSE_LOCK_TTL_MS) || (CONDENSE_LLM_TIMEOUT_MS + 180000); // ~15 min

// #2818 follow-up (GDrive): `wx` exclusive-create is atomic on a local FS, but
// this lock lives on DriveFS — a caching sync layer, not a POSIX-coherent shared
// filesystem. Two machines can each succeed against their own mirror. Settle
// delay before confirming sole ownership; the mirrors converge to ONE payload,
// and exactly its owner proceeds. Read at CALL time (not module load) so the
// fleet can tune it without an MCP restart, and tests can zero it.
const condenseLockConfirmDelayMs = (): number => {
  const raw = process.env.CONDENSE_LOCK_CONFIRM_DELAY_MS;
  if (raw === undefined || raw === '') return 1500;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 1500;
};

// #2818 follow-up: `acquiredAt` is stamped by the HOLDER's clock and compared
// against OURS. A holder whose clock lags inflates the computed age and gets its
// live lock stolen mid-condense. Tolerance added to the TTL before declaring a
// lock stale — err toward respecting a lock, since a false steal costs a
// redundant multi-minute LLM pass.
const condenseLockClockSkewMs = (): number => {
  const raw = process.env.CONDENSE_LOCK_CLOCK_SKEW_MS;
  if (raw === undefined || raw === '') return 120000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 120000;
};

// #3205 write-side: cross-process file-lock for the dashboard append read→rename
// window. Unlike the condense lock (first-wins, others SKIP — safe, the message
// is already persisted), an append lock holder is serializing a write that has
// NOT happened yet: a concurrent appender must WAIT, because skipping is
// exactly the silent last-writer-wins loss observed fleet-wide (po-2026 22/08:
// two agents' appends, both `Tool call OK`, one message gone). Hold time is
// ms-scale locally but DriveFS can stretch it — TTL 30s recovers a crashed
// holder without ever stealing a live one. Env-overridable at CALL time (not
// module load): a long-lived MCP host must pick up fleet tuning without a
// restart, and tests shorten the budget.
const appendLockTtlMs = (): number => Number(process.env.APPEND_LOCK_TTL_MS) || 30000;
const appendLockAcquireBudgetMs = (): number => Number(process.env.APPEND_LOCK_ACQUIRE_BUDGET_MS) || 5000;
const appendLockRetryMs = (): number => Number(process.env.APPEND_LOCK_RETRY_MS) || 150;

// Max tokens for every condensation LLM call (summary, status, text-condense).
//
// 2026-05-26: thinking mode disabled at every call site (see chat_template_kwargs
// below). Per user mandate "passe la condensation en non thinking, vue la situation
// catastrophique du cluster ce sera un moindre mal" — Qwen3.6 thinking-loop hang
// was bringing the whole dashboard channel down during the orphan-leak crisis.
// With thinking off, generation is direct markdown output (~700-1500 tokens for a
// status/summary; ~4000 only for a very large condense), so 7200 is ample headroom.
//
// 2026-07-04: lowered 12000 → 7200 (#2557) — a conservative 40% first cut. The
// 12000 cap was a runaway-guard, not a normal budget (real non-thinking summaries
// are ~700-1500 tokens; the cap is only reached in the known Qwen3.6 thinking-loop
// repetition failure). Two effects: (1) the runaway guard tightens ~325s → ~195s
// (7200 × ~37 tok/s), still well under the ~600s IIS→vLLM gateway; (2) a lower
// max_tokens reduces per-sequence KV reservation, giving more concurrency headroom
// — plausible help for the prefill-burst-starves-decode wedge (project-engine-wedge
// onset 07:10:03Z: prompt_rate 419.7 tok/s, gen 0.12). Conservative on purpose:
// measure the effect on condensation success rate + wedge frequency before cutting
// further. No truncation risk: thinking is off and real summaries are << 7200.
//
// History (kept for context — apply *with* enable_thinking=false now):
// 2026-05-23: regression fix. Commit 9beb7e93 (2026-04-20) bumped this 10000 →
// 30000 to "give Qwen3.6 thinking room". That was the bug behind "la condensation
// n'aboutit plus d'elle-même quand on poste": qwen3.6 has a known thinking-loop
// repetition failure mode (vLLM+Qwen) where a runaway generation walks all the way
// to max_tokens. 30000 tokens × ~37 tok/s = ~810s, > 600s gateway = HTTP 502.
// Bounding at 12000 capped a runaway at ~325s; 7200 caps it at ~195s (2026-07-04).
const CONDENSE_LLM_MAX_TOKENS = 7200;

// #2426 Phase C+ follow-up: Detect LLM provider for thinking-mode control.
// vLLM (local) supports chat_template_kwargs; z.ai and other remote APIs reject it (400).
// When NOT vLLM, prepend /no_think to user prompt instead (same effect, compatible).
const isOpenAICompatVLlm = (): boolean => {
  const baseUrl = process.env.OPENAI_BASE_URL || '';
  // vLLM local endpoints typically contain 'text-generation-webui', 'localhost', or private IPs
  return baseUrl.includes('text-generation-webui') ||
         baseUrl.includes('localhost') ||
         baseUrl.includes('127.0.0.1') ||
         baseUrl.includes('192.168.') ||
         baseUrl.includes('10.0.') ||
         baseUrl.includes('172.');
};

/** Build LLM params for thinking-mode control based on provider. */
function buildThinkingControl(isVllm: boolean): {
  chatTemplateKwargs?: Record<string, boolean>;
  promptPrefix: string;
} {
  if (isVllm) {
    return {
      chatTemplateKwargs: { enable_thinking: false },
      promptPrefix: '',
    };
  }
  // z.ai / remote: use /no_think prefix (same as LLMService.ts #954)
  return { chatTemplateKwargs: undefined, promptPrefix: '/no_think\n' };
}

// #2719: Cloud fallback for condensation when the primary (local vLLM) LLM is down.
// When the primary condensation LLM has exhausted its retries and returned null, we
// make ONE attempt against a cloud provider (z.ai / OpenAI-compatible) so the dashboard
// still gets condensed instead of wedging.
//
// Inert-safe: getFallbackChatOpenAIClient() returns null when no fallback key
// (ZAI_API_KEY / FALLBACK_API_KEY) is configured, so cloudCondenseOnce() is a no-op and
// behaviour is identical to pre-#2719 until the fleet secrets are provisioned.

/**
 * One cloud-fallback condensation attempt. Returns the condensed content (+ timing and
 * model) on success, or null when the fallback is unconfigured, returns empty, or throws.
 * Never throws — the caller keeps its existing primary-failure handling.
 *
 * For non-reasoning fallbacks (GLM / Qwen flash) the user prompt is prefixed with
 * `/no_think` and the call uses `max_tokens` + `temperature`. gpt-5 / o-series
 * reasoning models reject both (`max_completion_tokens` only, temperature must be
 * the default 1), so the params are branched on the configured model.
 */
let cloudFallbackDisabledLogged = false;

/**
 * #2998: Classify whether a cloud fallback error is worth retrying.
 * 429 (rate limit) and 5xx (server errors) are transient by definition.
 * 4xx auth/client errors (401, 403) won't heal with backoff.
 *
 * #3011: Connection errors (no HTTP status) are split — a HUNG endpoint
 * (timeout) must NOT be retried, mirroring the primary's #2267 rule. A hung
 * endpoint won't recover in a 2-8s backoff, so retrying just burns another
 * full FALLBACK_TIMEOUT_MS (~120s each at the #3016 default → ~6 min for 3 attempts). A
 * FAILED-FAST connection (ECONNREFUSED / ENOTFOUND) is still retryable: it
 * rejects immediately, so the retry is cheap and can ride out a brief blip.
 * Exported for direct unit testing of the classification (#3011 bite-test).
 *
 * #3011 second tour: detection reads `constructor.name`, NOT `error.name`.
 * The OpenAI SDK never assigns `this.name` on its error subclasses (verified
 * against openai@4.104.0 error.js — `grep "this.name"` → 0 hits), so every
 * subclass instance inherits `Error.prototype.name` = `"Error"`. The real
 * subclass type lives on `constructor.name` (e.g. "APIConnectionTimeoutError").
 * The first attempt read `error.name`: that matched the SYNTHETIC test error
 * (`Object.assign(new Error, { name })` → name set, constructor.name="Error")
 * but was exactly inverted — and dead — on the REAL SDK error
 * (`new APIConnectionTimeoutError` → name="Error", constructor.name set). CI
 * was green, production retried the timeout anyway. Matching `constructor.name`
 * fixes both. See the #3012 sibling fix `isLLMTimeoutError` for the same root
 * cause on the primary path.
 */
export function isRetryableFallbackError(error: unknown): boolean {
  if (error && typeof error === 'object' && 'status' in error) {
    const status = (error as Record<string, unknown>).status;
    if (typeof status === 'number') {
      return status === 429 || status >= 500;
    }
    // `status` is declared on the SDK's APIError base class but `undefined` for a
    // connection/timeout error → fall through to the connection-class check below.
  }
  // Connection-class error (no usable HTTP status). Distinguish hung from failed-fast.
  if (error instanceof Error) {
    // constructor.name is the production-stable type signal (see JSDoc). It also
    // survives a duplicate `openai` package instance in node_modules, which would
    // defeat an `instanceof` check across the two prototypes.
    const ctorName = (error as { constructor?: { name?: string } })?.constructor?.name;
    if (ctorName === 'APIConnectionTimeoutError') return false;
    // A genuine AbortController abort sets error.name = 'AbortError' (native fetch /
    // browser paths). Retained though the fallback client doesn't use a signal today.
    if (error.name === 'AbortError') return false;
  }
  // ECONNREFUSED / ENOTFOUND / etc. → fail fast → retryable.
  return true;
}

/** Result of a single cloud fallback attempt. */
type CloudCondenseOnceResult =
  | { ok: true; content: string; elapsedMs: number; model: string }
  | { ok: false; retryable: boolean; error: string; elapsedMs: number; model: string }
  | null; // unconfigured (no API key)

async function cloudCondenseOnce(
  systemPrompt: string,
  userPrompt: string,
  opts: { maxTokens: number; temperature: number },
  fbModel: string,
): Promise<CloudCondenseOnceResult> {
  const fallbackClient = getFallbackChatOpenAIClient();
  if (!fallbackClient) {
    // #2719 visibility: a missing FALLBACK_API_KEY (or ZAI_API_KEY) makes the
    // cloud fallback a SILENT no-op — every primary LLM failure then falls
    // straight to lossy truncation with no log. Emit one WARN per process so
    // "fallback never runs" is diagnosable instead of invisible.
    if (!cloudFallbackDisabledLogged) {
      cloudFallbackDisabledLogged = true;
      logger.warn('Cloud condensation fallback DISABLED — FALLBACK_API_KEY (or ZAI_API_KEY) not set in env; primary LLM failures will truncate instead of falling back to cloud', {
        fbModel: getFallbackLLMModelId(),
      });
    }
    return null;
  }
  const fbStart = Date.now();
  try {
    // gpt-5 / o-series reasoning models reject `max_tokens` (require
    // `max_completion_tokens`) and any `temperature` != 1. Classic OpenAI-compat /
    // GLM / Qwen models use `max_tokens` + `temperature` and honour `/no_think`.
    const isReasoningModel = /^(gpt-5|o[1-9])/i.test(fbModel);
    const response = await fallbackClient.chat.completions.create(
      isReasoningModel
        ? {
            model: fbModel,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
            max_completion_tokens: opts.maxTokens,
          }
        : {
            model: fbModel,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: '/no_think\n' + userPrompt },
            ],
            max_tokens: opts.maxTokens,
            temperature: opts.temperature,
          },
    );
    const content = response.choices[0]?.message?.content;
    const elapsedMs = Date.now() - fbStart;
    if (!content) {
      logger.warn('#2719 cloud fallback returned empty content', { fbModel, elapsed: `${elapsedMs}ms` });
      // #2719 discriminant fix (2026-09-19, po-2024 spec from the po-2027 datapoint):
      // return a stamped NON-RETRYABLE error instead of the null "unconfigured" shape,
      // so the archive frontmatter distinguishes "cloud answered 200 with no content"
      // from "cloud never configured in this process". Retry stays disabled (#3011):
      // an empty body is a SUCCESSFUL HTTP round-trip — the model chose to emit
      // nothing, and a backoff is unlikely to change that (contrast with 429/5xx
      // where the transport itself was rejected and retrying may heal).
      return { ok: false, retryable: false, error: 'empty-content (HTTP 200, 0-byte completion)', elapsedMs, model: fbModel };
    }
    logger.info('#2719 cloud fallback condensation succeeded', {
      fbModel,
      elapsed: `${elapsedMs}ms`,
      sizeKB: `${(Buffer.byteLength(content, 'utf8') / 1024).toFixed(1)}KB`,
    });
    return { ok: true, content, elapsedMs, model: fbModel };
  } catch (error: unknown) {
    const errStr = safeErrorString(error);
    const elapsedMs = Date.now() - fbStart;
    const retryable = isRetryableFallbackError(error);
    logger.error('#2719 cloud fallback condensation failed', { fbModel, error: truncateError(errStr), retryable, elapsed: `${elapsedMs}ms` });
    return { ok: false, retryable, error: truncateError(errStr), elapsedMs, model: fbModel };
  }
}

/**
 * #2719 (22/09): the cloud tier's model CHAIN. `FALLBACK_LLM_MODEL_ID` accepts a
 * comma-separated list (e.g. `glm-4.7,deepseek-v4-flash` against the hub): each
 * model is tried in order and the next one takes over on ANY failure of the
 * previous — including an empty 200 body, a timeout or a quota error, which a
 * single-model tier could only turn into truncation. The next model only survives
 * a quota if it sits with ANOTHER provider: on the hub, `claude-sonnet-*` names are
 * served by glm-5.3 (measured 22/09). A single value behaves exactly as before.
 */
function getFallbackModelChain(): string[] {
  const models = getFallbackLLMModelId().split(',').map(m => m.trim()).filter(Boolean);
  return models.length > 0 ? models : [getFallbackLLMModelId()];
}

/**
 * #2998: Cloud condensation with retry on transient errors (429/5xx).
 * Wraps cloudCondenseOnce with up to FB_MAX_ATTEMPTS attempts and exponential
 * backoff on the first model of the chain; every next model gets ONE attempt
 * (#2719): the chain already is the retry, and three attempts per model would
 * multiply the worst-case wait by the chain length. Returns the first successful
 * result, the errors of every model tried (if all failed), or null when the
 * fallback is unconfigured.
 */
async function cloudCondenseWithRetry(
  systemPrompt: string,
  userPrompt: string,
  opts: { maxTokens: number; temperature: number },
): Promise<{ content: string; elapsedMs: number; model: string } | { error: string; attempts: number } | null> {
  const modelErrors: string[] = [];
  let attempts = 0;
  for (const [position, fbModel] of getFallbackModelChain().entries()) {
    const maxAttempts = position === 0 ? FB_MAX_ATTEMPTS : 1;
    let lastError: string | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const result = await cloudCondenseOnce(systemPrompt, userPrompt, opts, fbModel);
      if (result === null) return null; // unconfigured (empty content is a stamped non-retryable error since the #2719 discriminant fix)
      if (result.ok) return result; // success
      attempts++;
      lastError = result.error;
      if (!result.retryable || attempt >= maxAttempts) break;
      const backoff = FB_INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1);
      logger.info(`#2998 cloud fallback retrying in ${backoff}ms (attempt ${attempt}/${maxAttempts})`, {
        model: result.model, error: result.error,
      });
      await new Promise(resolve => setTimeout(resolve, backoff));
    }
    modelErrors.push(`${fbModel}: ${lastError ?? 'unknown error'}`);
  }
  // A single-model chain keeps its historical error shape (no model prefix).
  const error = modelErrors.length === 1
    ? modelErrors[0].slice(modelErrors[0].indexOf(': ') + 2)
    : modelErrors.join(' | ');
  return { error, attempts };
}

/**
 * Stats-aware wrapper around cloudCondenseWithRetry for the LLMCallResult condensers
 * (generateLLMSummary / generateStatusUpdate). On fallback success, stamps the fallback
 * fields + 'ok-with-fallback' outcome and returns the result; otherwise returns null so
 * the caller returns its original primary-failure result (and its diagnostic stats) unchanged.
 *
 * #2998: On fallback failure, stamps `fallbackAttempted` + `fallbackError` in stats so
 * the diagnostic distinguishes "fallback unconfigured" from "fallback attempted but rejected".
 */
async function tryCloudCondenseFallback(
  systemPrompt: string,
  userPrompt: string,
  opts: { maxTokens: number; temperature: number },
  stats: LLMCallStats,
  callStart: number,
): Promise<LLMCallResult | null> {
  const fb = await cloudCondenseWithRetry(systemPrompt, userPrompt, opts);
  if (fb && 'content' in fb) {
    stats.fallbackUsed = true;
    stats.fallbackModel = fb.model;
    stats.fallbackElapsedMs = fb.elapsedMs;
    stats.finalOutcome = 'ok-with-fallback';
    stats.elapsedMs = Date.now() - callStart;
    return { content: fb.content, stats };
  }
  // #2998: record fallback failure so diagnostics can distinguish "unconfigured"
  // (fb === null) from "attempted but rejected" (fb has error).
  if (fb && 'error' in fb) {
    stats.fallbackAttempted = true;
    stats.fallbackError = fb.error;
  }
  return null;
}

/**
 * #2719: result of a call whose primary was skipped (circuit breaker open) and whose
 * cloud tier did not deliver. Says WHY in `lastError` — without it the notice read
 * "circuit-open (0 attempts, 0s)" and named no cause.
 */
function circuitOpenFailure(stats: LLMCallStats, callStart: number): LLMCallResult {
  stats.elapsedMs = Date.now() - callStart;
  stats.lastError = 'primary skipped (circuit breaker open)'
    + (stats.fallbackError ? `; cloud: ${stats.fallbackError}` : '; cloud tier unconfigured');
  return { content: null, stats };
}

// Dedup window for [ERROR] CONDENSATION CANCELLED system messages (prevent loop
// when LLM is down and every append re-triggers a failed condensation).
// 2026-04-20: bumped 5min → 20min. A single append triggers up to 2 condense
// passes (preemptive + reactive). Each pass can burn several minutes in LLM
// retries when Qwen thinking mode eats max_tokens on a 40KB prompt. With a
// 5min window, the 2nd pass fell outside and injected a 2nd error message →
// archivedCount went to -2 (math correct, semantics broken). 20min covers both
// passes even under worst-case LLM latency while still allowing legitimate
// retries after a user-driven restart of the MCP / LLM endpoint.
const CONDENSATION_ERROR_DEDUP_MS = 20 * 60 * 1000; // 20 minutes

// #1792: Circuit breaker for condensation LLM calls. When the LLM endpoint is
// down, repeated LLM retries (3× per condense pass, ~69s each) waste time and
// the dashboard keeps growing (error messages add to bloat). After N consecutive
// failures, switch to truncation-only mode (no LLM), auto-reset after cooldown.
const CONDENSE_CB_OPEN_THRESHOLD = 3;   // Open after 3 consecutive LLM failures
const CONDENSE_CB_RESET_TTL_MS = 30 * 60 * 1000; // 30 min cooldown before retrying LLM

interface CondenseCircuitBreaker {
  consecutiveFailures: number;
  lastFailureTime: number;
  isOpen: boolean;
}

const condenseCB: CondenseCircuitBreaker = {
  consecutiveFailures: 0,
  lastFailureTime: 0,
  isOpen: false,
};

function condenseCBRecordFailure(): void {
  condenseCB.consecutiveFailures++;
  condenseCB.lastFailureTime = Date.now();
  if (condenseCB.consecutiveFailures >= CONDENSE_CB_OPEN_THRESHOLD) {
    condenseCB.isOpen = true;
    logger.warn('Condensation circuit breaker OPENED', {
      consecutiveFailures: condenseCB.consecutiveFailures,
      resetAfterMs: CONDENSE_CB_RESET_TTL_MS,
    });
  }
}

function condenseCBRecordSuccess(): void {
  if (condenseCB.consecutiveFailures > 0 || condenseCB.isOpen) {
    logger.info('Condensation circuit breaker RESET (LLM success)', {
      previousFailures: condenseCB.consecutiveFailures,
    });
  }
  condenseCB.consecutiveFailures = 0;
  condenseCB.isOpen = false;
}

function condenseCBShouldBypass(): boolean {
  if (!condenseCB.isOpen) return false;
  // Auto-half-open after cooldown
  if (Date.now() - condenseCB.lastFailureTime > CONDENSE_CB_RESET_TTL_MS) {
    logger.info('Condensation circuit breaker HALF-OPEN (cooldown elapsed), retrying LLM');
    condenseCB.isOpen = false;
    condenseCB.consecutiveFailures = 0;
    return false;
  }
  return true;
}

/** Reset circuit breaker state (for testing). */
export function resetCondenseCircuitBreaker(): void {
  condenseCB.consecutiveFailures = 0;
  condenseCB.lastFailureTime = 0;
  condenseCB.isOpen = false;
}

// === Per-key mutex ===
//
// Prevents concurrent condensations/writes on the same dashboard key within
// this process. Without this, two concurrent append() calls that both detect
// the 50KB threshold will:
//   1. Both run condenseIntercom in parallel (two 3-min LLM calls)
//   2. Each write its own archive file (same source messages, different
//      timestamp) — producing duplicate archives
//   3. Race on writeDashboardFile, the second overwriting the first
//
// Cross-process / cross-machine races on GDrive are NOT solved here (that
// would require a file-based lock with stale detection, tracked separately).
const perKeyLocks = new Map<string, Promise<unknown>>();

/**
 * Serialize async operations per key.
 * Callers with the same key run one-at-a-time in arrival order.
 * Errors don't poison the chain: the next caller proceeds regardless.
 */
async function withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = perKeyLocks.get(key) ?? Promise.resolve();
  // Chain: run fn() whether `previous` resolved or rejected
  const current = previous.then(() => fn(), () => fn());
  // Best-effort cleanup: remove from map once settled, if we're still the tail
  const stored = current.then(
    () => undefined,
    () => undefined
  ).finally(() => {
    if (perKeyLocks.get(key) === stored) {
      perKeyLocks.delete(key);
    }
  });
  perKeyLocks.set(key, stored);
  return current;
}

// Track custom messageIds for dashboard messages by key
// This ensures custom IDs are available across function boundaries
const pendingMessageIds = new Map<string, string>();

/**
 * #3537 §6.2 — verrou in-process sur DEUX clés (merge source → cible).
 * Ordre lexicographique FIXE : deux merges concurrents A→B et B→A acquièrent
 * dans le même ordre, sinon ils s'interbloqueraient chacun sur la clé que
 * l'autre tient.
 */
async function withTwoKeyLocks<T>(keyA: string, keyB: string, fn: () => Promise<T>): Promise<T> {
  if (keyA === keyB) return withKeyLock(keyA, fn);
  const [first, second] = [keyA, keyB].sort();
  return withKeyLock(first, () => withKeyLock(second, fn));
}

// #2464: Condensation loop prevention — hash cache.
// Before each condensation, compute SHA-256 of the messages that would be
// condensed (toArchive). If the hash matches the last successful condensation
// for this key, skip the LLM calls — the result would be identical.
// Prevents repeated condensation on unchanged content (3-4x per 30min observed).
const lastCondenseHash = new Map<string, string>();

// === Utilitaires ===

// #3537 §6.3 — normalisation des entrées de dérivation. Chaque règle ci-dessous
// répond à une classe de pollution mesurée dans le recensement des 61 clés
// (issue §4) ; les entrées propres passent inchangées (les règles sont des
// no-ops sur elles). Cas laissé DEHORS, délibérément : la casse (cf. 2026-05-23
// ci-dessous — lowercaser forkerait les clés case-preserved existantes) et le
// rewrite po-XXXX → myia-po-XXXX (convention flotte, pas une propriété du
// serveur ; réconcilier les clés EXISTANTES relève de l'action merge §6.2).

/**
 * Résidu d'encodage URL mesuré dans le recensement : '%3A' (deux-points de
 * l'adressage composé). Décodage VOLONTAIREMENT restreint à ce seul token —
 * un decodeURIComponent complet décoderait aussi des '%XX' littéraux
 * légitimes ('100%20' → espace), une classe de mutisation silencieuse sans
 * pollution mesurée derrière (revue #1134, suggestion mineure).
 */
function decodeUrlResidue(value: string): string {
  return value.replace(/%3A/gi, ':');
}

/**
 * Résidu de nom de fichier promu au rang de clé ('workspace-CoursIA.md.bak',
 * 'workspace-CoursIA-2.md.bak.c360') : retire les segments '.md' / '.bak' /
 * '.bak.<seg>' finaux, itérativement. Un nom légitime 'foo.md' est plié vers
 * 'foo' — normalisation voulue : '.md' n'est pas un nom de workspace, c'est le
 * reflet d'un caller qui a passé un chemin de FICHIER dashboard.
 */
function stripFilenameResidue(value: string): string {
  let out = value;
  for (;;) {
    if (/\.md$/i.test(out)) {
      out = out.slice(0, -3);
      continue;
    }
    const bak = out.match(/\.bak(\.[A-Za-z0-9]+)?$/i);
    if (bak) {
      out = out.slice(0, out.length - bak[0].length);
      continue;
    }
    return out;
  }
}

/** Suffixe plateforme-arch ('myia-po-2025-win32-x64' → 'myia-po-2025'). */
const PLATFORM_ARCH_SUFFIX = /-(?:win32|linux|darwin|freebsd|openbsd)-(?:x64|arm64|ia32|ppc64|s390x)$/;

function normalizeMachineIdInput(machineId: string): string {
  let value = decodeUrlResidue(machineId.trim());
  value = value.replace(PLATFORM_ARCH_SUFFIX, '');
  // Symétrie avec la branche workspace : le résidu '.md'/'.bak' n'a pas de
  // classe mesurée côté machine dans le recensement, mais le même caller qui
  // pollue un workspace polluerait un machineId — la garde est gratuite.
  return stripFilenameResidue(value);
}

function normalizeWorkspaceInput(workspace: string): string {
  const value = decodeUrlResidue(workspace.trim());
  // Formes composées portant un ':' — adressage RooSync 'machine:workspace'
  // ('myia-po-2025%3ACoursIA-2' mesuré dans le recensement) et lettres de
  // lecteur ('C:\...'). La composante utile est APRÈS le dernier ':' dans les
  // deux cas. Bonus Windows : un ':' est illégal dans un nom de fichier NTFS —
  // le garder produirait une clé impossible à matérialiser en fichier.
  const colon = value.lastIndexOf(':');
  if (colon !== -1) {
    return value.slice(colon + 1);
  }
  return value;
}

/**
 * Construit la clé dashboard à partir du type et des paramètres
 *
 * Exporté pour les tests de normalisation #3537 §6.3 : la dérivation est une
 * fonction pure, la tester directement évite de passer par des écritures de
 * fichiers juste pour lire la clé résultante.
 */
export function buildDashboardKey(
  type: DashboardArgs['type'],
  machineId: string,
  workspace: string
): string {
  switch (type) {
    case 'global':
      return 'global';
    case 'machine': {
      // #3537 §6.3 — trim + décodage URL + retrait du suffixe plateforme-arch,
      // PUIS guard anti double-préfixe (e.g., machine-machine-foo)
      const normalized = normalizeMachineIdInput(machineId);
      const cleanMachineId = normalized.startsWith('machine-') ? normalized.slice('machine-'.length) : normalized;
      return `machine-${cleanMachineId}`;
    }
    case 'workspace': {
      // #3537 §6.3 — trim + décodage URL + split ':' composé/lecteur, PUIS
      // guard anti double-préfixe, PUIS basename, PUIS retrait du résidu
      // '.md'/'.bak' final.
      const normalized = normalizeWorkspaceInput(workspace);
      // Guard against double-prefix (e.g., workspace-workspace-Argumentum → #1409 item 2)
      const cleanWorkspace = normalized.startsWith('workspace-') ? normalized.slice('workspace-'.length) : normalized;
      // 2026-05-23: collapse to the directory basename only. Callers sometimes pass
      // a full path-style workspace (d:\CoursIA, g:\Mon Drive\...\CoursIA) which used
      // to produce scattered orphan dashboards (workspace-d--CoursIA.md,
      // workspace-g--Mon-Drive-CoursIA.md). User mandate: "on a dit qu'on ne retenait
      // que le nom de répertoire collapsé". basename() (case-preserved) folds every
      // path form for the same project onto one key. NOT normalizeWorkspaceId() — that
      // lowercases, which would mismatch the existing case-preserved files (CoursIA,
      // Argumentum, 2025-Epita-Intelligence-Symbolique). If the value is already a bare
      // name (no separators), basename() returns it unchanged.
      const baseName = stripFilenameResidue(path.basename(cleanWorkspace.replace(/\\/g, '/')));
      return `workspace-${baseName}`;
    }
    default:
      throw new Error(`Type dashboard inconnu: ${type}`);
  }
}

/**
 * Convertit la clé en nom de fichier Markdown
 */
function keyToFilename(key: string): string {
  return `${key}.md`;
}

/**
 * Retourne le chemin complet du répertoire dashboards dans .shared-state
 */
function getDashboardsDir(): string {
  const sharedStatePath = getSharedStatePath();
  return path.join(sharedStatePath, 'dashboards');
}

/**
 * Retourne le chemin complet d'un dashboard
 */
function getDashboardPath(key: string): string {
  return path.join(getDashboardsDir(), keyToFilename(key));
}

/**
 * Retourne le chemin du répertoire d'archive
 */
function getArchiveDir(): string {
  return path.join(getDashboardsDir(), 'archive');
}

// === Cross-process condensation file-lock (#2818) ===
//
// The in-process `withKeyLock` above serializes condensations WITHIN one MCP
// process. But each Claude session runs its own roo-state-manager process, and
// the dashboards live on GDrive-shared `.shared-state/` written by 6 machines.
// Without a shared lock, N agents that all hit the 92% threshold each run the
// full multi-minute LLM condense concurrently; N−1 results are then discarded by
// the applyCondensedWithMerge/#2328 `lastCondensedAt` guard — AFTER the tokens
// and wall-clock are already spent. This lock is the "file-based lock with stale
// detection" the perKeyLocks comment (above) said was "tracked separately".
//
// Contract:
//   - First appender to reach condense wins the lock and condenses.
//   - Losers SKIP the condense entirely. Their message is already persisted
//     (append-first, before this point), and the winner's condensation re-reads
//     disk and stitches it back in via applyCondensedWithMerge (#2328). So a skip
//     is not a loss — it just declines to run a redundant LLM pass.
//   - A crashed holder (never released) is recovered after CONDENSE_LOCK_TTL_MS.
//
// Guarantees: `fs.open(path, 'wx')` (O_CREAT|O_EXCL) is atomic on a single
// machine → fully solves the common multi-session/multi-cron-worker case. Across
// machines it is best-effort (GDrive replication lag can briefly hide a peer's
// lock); there, the #2328 merge guard remains the correctness backstop. Strict
// improvement, zero regression: worst case is the pre-existing behavior (a
// redundant condense that #2328 discards).

// Exported (with tryAcquire/release below) for unit tests — the cross-process
// contract is pure filesystem and is verified directly rather than by driving
// the full append+LLM path.
export interface CondenseLockInfo {
  machineId: string;
  workspace: string;
  pid: number;
  acquiredAt: string; // ISO 8601
}

/**
 * Lock file path for a dashboard key. Uses `.condense.lock` (not `.md`) so
 * handleList / archive scans — which match `*.md` — never pick it up.
 */
export function getCondenseLockPath(key: string): string {
  return path.join(getDashboardsDir(), `${key}.condense.lock`);
}

/**
 * Identity predicate for a lock holder, shared by the condense and append locks
 * (both stamp a `CondenseLockInfo`). The same triple governs "did my payload
 * survive the DriveFS merge" and "may I delete this lock" — keeping it in one
 * place stops the two from drifting apart.
 */
function sameLockHolder(a: CondenseLockInfo, b: CondenseLockInfo): boolean {
  return a.machineId === b.machineId && a.pid === b.pid && a.acquiredAt === b.acquiredAt;
}

/**
 * Is an existing condense lock old enough to be treated as abandoned by a
 * crashed holder? An unparseable timestamp counts as stale: reclaiming garbage
 * beats letting it wedge condensation for a saturated dashboard.
 */
function isCondenseLockStale(existing: CondenseLockInfo): boolean {
  const ageMs = Date.now() - new Date(existing.acquiredAt).getTime();
  if (!Number.isFinite(ageMs)) return true;
  return ageMs >= CONDENSE_LOCK_TTL_MS + condenseLockClockSkewMs();
}

/**
 * #2818 follow-up: confirm we are the SOLE holder after writing our payload.
 *
 * On GDrive two writers can both believe they created the file. After a settle
 * delay the mirrors converge to one payload; its owner proceeds and the other
 * backs off. This cannot wedge: the surviving owner holds a real lock and
 * releases it in its `finally`. Before the delay elapses the behaviour simply
 * degrades to the pre-existing one (both condense) — never worse.
 *
 * Fail-OPEN on any read/parse failure, matching the rest of this lock layer.
 */
async function confirmSoleCondenseHolder(
  key: string,
  lockPath: string,
  holder: CondenseLockInfo
): Promise<boolean> {
  const delayMs = condenseLockConfirmDelayMs();
  if (delayMs > 0) {
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  let onDisk: CondenseLockInfo;
  try {
    onDisk = JSON.parse(await fs.readFile(lockPath, 'utf8')) as CondenseLockInfo;
  } catch {
    // Vanished or unreadable between write and confirm — fail open.
    return true;
  }
  if (sameLockHolder(onDisk, holder)) {
    return true;
  }
  if (isCondenseLockStale(onDisk)) {
    // The payload that survived belongs to a crashed holder — reclaim it.
    logger.warn('Condense lock: survivor payload is stale — reclaiming (#2818 GDrive confirm)', {
      key, survivor: `${onDisk.machineId}:${onDisk.workspace}#${onDisk.pid}`
    });
    try {
      await fs.writeFile(lockPath, JSON.stringify(holder), { encoding: 'utf8', flag: 'w' });
    } catch { /* best-effort */ }
    return true;
  }
  // Another holder's payload won the mirror merge: it condenses, we skip. Our
  // message is already persisted (append-first) and #2328 stitches it back in.
  logger.info('Condense lock: lost the GDrive merge to a concurrent holder — skipping (#2818 GDrive confirm)', {
    key,
    wonBy: `${onDisk.machineId}:${onDisk.workspace}#${onDisk.pid}`,
    ours: `${holder.machineId}:${holder.workspace}#${holder.pid}`
  });
  return false;
}

/**
 * Try to acquire the cross-process condensation lock for `key`.
 * Returns true if this caller now holds the lock (and MUST release it), false if
 * a fresh holder already owns it (caller should skip condensing).
 *
 * Fail-OPEN: on any unexpected filesystem error we return true (proceed to
 * condense). A bug in the locking layer must never be able to wedge condensation
 * for a saturated dashboard — the pre-lock behavior (everyone condenses) is the
 * safe fallback.
 */
export async function tryAcquireCondenseLock(key: string, holder: CondenseLockInfo): Promise<boolean> {
  const lockPath = getCondenseLockPath(key);
  const payload = JSON.stringify(holder);
  try {
    // Atomic exclusive-create: fails with EEXIST if a lock file already exists.
    await fs.writeFile(lockPath, payload, { encoding: 'utf8', flag: 'wx' });
    // Observed twice in production (2026-08-30 19:22Z, 2026-09-01 05:05Z): both
    // holders condensed and #2328 discarded one multi-minute result. Confirm.
    return await confirmSoleCondenseHolder(key, lockPath, holder);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'EEXIST') {
      // Unexpected FS error (permissions, GDrive hiccup) — fail open.
      logger.debug('Condense lock acquire errored, failing open (will condense)', {
        key, error: err instanceof Error ? err.message : String(err)
      });
      return true;
    }
    // Lock exists — inspect its age.
    try {
      const raw = await fs.readFile(lockPath, 'utf8');
      const existing = JSON.parse(raw) as CondenseLockInfo;
      const ageMs = Date.now() - new Date(existing.acquiredAt).getTime();
      if (!isCondenseLockStale(existing)) {
        // Fresh holder — respect it, skip condensing.
        logger.info('Condense lock held by fresh holder — skipping redundant condense (#2818)', {
          key,
          heldBy: `${existing.machineId}:${existing.workspace}#${existing.pid}`,
          ageSeconds: Math.round(ageMs / 1000)
        });
        return false;
      }
      // Stale (holder likely crashed) — steal by overwriting, then proceed.
      logger.warn('Condense lock is stale — stealing (previous holder likely crashed) (#2818)', {
        key,
        stolenFrom: `${existing.machineId}:${existing.workspace}#${existing.pid}`,
        ageSeconds: Number.isFinite(ageMs) ? Math.round(ageMs / 1000) : 'unparseable',
        ttlSeconds: Math.round(CONDENSE_LOCK_TTL_MS / 1000)
      });
      await fs.writeFile(lockPath, payload, { encoding: 'utf8', flag: 'w' });
      return await confirmSoleCondenseHolder(key, lockPath, holder);
    } catch (inner: unknown) {
      // Could not read/parse the existing lock (corrupt or vanished mid-check).
      // Reclaim it so a garbage lock can't wedge condensation forever.
      logger.warn('Condense lock unreadable — reclaiming (#2818)', {
        key, error: inner instanceof Error ? inner.message : String(inner)
      });
      try {
        await fs.writeFile(lockPath, payload, { encoding: 'utf8', flag: 'w' });
      } catch { /* best-effort */ }
      return true;
    }
  }
}

/**
 * Release the condensation lock for `key`, but ONLY if we still own it (same
 * machineId + pid + acquiredAt). This avoids deleting a lock that a stealer legitimately
 * took over after our TTL expired. Best-effort: a failed unlink is harmless
 * (the next holder's TTL check recovers it).
 */
export async function releaseCondenseLock(key: string, holder: CondenseLockInfo): Promise<void> {
  const lockPath = getCondenseLockPath(key);
  try {
    const raw = await fs.readFile(lockPath, 'utf8');
    const existing = JSON.parse(raw) as CondenseLockInfo;
    if (sameLockHolder(existing, holder)) {
      await fs.unlink(lockPath);
    } else {
      logger.debug('Condense lock not released — owned by another holder now (#2818)', {
        key,
        currentHolder: `${existing.machineId}:${existing.workspace}#${existing.pid}`
      });
    }
  } catch {
    // Lock already gone or unreadable — nothing to release.
  }
}

// === Cross-process append file-lock (#3205 write-side) ===
// Same lock-file family as the #2818 condense lock (wx exclusive-create, TTL
// steal, ownership-checked release) but with WAIT semantics: a concurrent
// appender retries until the holder releases, because skipping an append IS
// the message loss this lock exists to prevent.

/**
 * Lock file path for a dashboard key's append window. `.append.lock` (not
 * `.md`) so handleList / archive scans never pick it up.
 */
export function getAppendLockPath(key: string): string {
  return path.join(getDashboardsDir(), `${key}.append.lock`);
}

/**
 * Try to acquire the cross-process append lock for `key`, retrying while a
 * fresh holder owns it.
 *
 * @returns true if this caller now holds the lock (and MUST release it in a
 *   `finally`); false if the acquire budget was exhausted — the caller should
 *   then proceed WITHOUT the lock (fail-OPEN) and MUST NOT release it. A rare
 *   unserialized race is strictly better than a blocked append: the pre-lock
 *   behavior is the fallback.
 */
export async function acquireAppendLock(key: string, holder: CondenseLockInfo): Promise<boolean> {
  const lockPath = getAppendLockPath(key);
  const payload = JSON.stringify(holder);
  const deadline = Date.now() + appendLockAcquireBudgetMs();
  for (;;) {
    try {
      await fs.writeFile(lockPath, payload, { encoding: 'utf8', flag: 'wx' });
      return true;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') {
        // Unexpected FS error — fail open, proceed unserialized.
        logger.debug('Append lock acquire errored, failing open (#3205 write)', {
          key, error: err instanceof Error ? err.message : String(err)
        });
        return false;
      }
    }
    // Held — fresh or stale?
    try {
      const raw = await fs.readFile(lockPath, 'utf8');
      let existing: CondenseLockInfo;
      try {
        existing = JSON.parse(raw) as CondenseLockInfo;
      } catch {
        // Garbage holder (web1 c.318): a parsed lock is a valid holder that
        // releaseAppendLock can clean up, but an unparsable one never will be —
        // so the TTL comment's promise only holds if we steal it here. Otherwise
        // every append pays the full budget, forever, until a human deletes it.
        logger.warn('Append lock unparsable — stealing (garbage holder) (#3205 write)', { key });
        await fs.writeFile(lockPath, payload, { encoding: 'utf8', flag: 'w' });
        return true;
      }
      const ageMs = Date.now() - new Date(existing.acquiredAt).getTime();
      if (!(Number.isFinite(ageMs) && ageMs < appendLockTtlMs())) {
        logger.warn('Append lock stale — stealing (holder likely crashed) (#3205 write)', {
          key,
          stolenFrom: `${existing.machineId}:${existing.workspace}#${existing.pid}`,
          ageSeconds: Number.isFinite(ageMs) ? Math.round(ageMs / 1000) : 'unparseable',
          ttlSeconds: Math.round(appendLockTtlMs() / 1000)
        });
        await fs.writeFile(lockPath, payload, { encoding: 'utf8', flag: 'w' });
        return true;
      }
    } catch {
      // Vanished mid-check (ENOENT) or a transient read error — loop: the next
      // wx either wins the path or re-enters the held branch. Garbage is stolen
      // at the parse above, never here.
    }
    if (Date.now() >= deadline) {
      logger.warn('Append lock budget exhausted — proceeding unserialized (fail-open) (#3205 write)', {
        key,
        budgetMs: appendLockAcquireBudgetMs()
      });
      return false;
    }
    await new Promise(resolve => setTimeout(resolve, appendLockRetryMs()));
  }
}

/**
 * Release the append lock for `key`, only if still owned (same machineId +
 * pid + acquiredAt). A failed unlink is harmless — the TTL steal recovers.
 */
export async function releaseAppendLock(key: string, holder: CondenseLockInfo): Promise<void> {
  const lockPath = getAppendLockPath(key);
  try {
    const raw = await fs.readFile(lockPath, 'utf8');
    const existing = JSON.parse(raw) as CondenseLockInfo;
    if (sameLockHolder(existing, holder)) {
      await fs.unlink(lockPath);
    }
  } catch {
    // Lock already gone or unreadable — nothing to release.
  }
}

/**
 * #3205 résiduel write-side : sérialise une lecture-modification-écriture du
 * dashboard sous le verrou append #1033/#1034. acquireAppendLock échoue
 * ouvert (budget épuisé / erreur FS) — dans ce cas on exécute quand même,
 * exactement comme un append non verrouillé d'avant le fix.
 */
export async function withAppendLock<T>(
  key: string,
  holder: CondenseLockInfo,
  fn: () => Promise<T>
): Promise<T> {
  const lockOwned = await acquireAppendLock(key, holder);
  try {
    return await fn();
  } finally {
    if (lockOwned) {
      await releaseAppendLock(key, holder);
    }
  }
}

/**
 * Thrown by withAppendLockRequired when the cross-process append lock could
 * NOT be acquired (budget exhausted / FS error). Distinct class so the merge
 * dispatcher can convert it into a structured REFUSÉ result instead of a raw
 * tool error (rework #1134, review ask 1).
 */
export class AppendLockUnavailableError extends Error {
  constructor(public readonly lockKey: string) {
    super(`Verrou append non acquis pour '${lockKey}'`);
    this.name = 'AppendLockUnavailableError';
  }
}

/**
 * FAIL-CLOSED sibling of withAppendLock, for DESTRUCTIVE read-modify-writes
 * only (rework #1134, review ask 1). withAppendLock executes its callback even
 * when the lock acquisition failed — the right trade-off for an append (a rare
 * unserialized append beats a dropped message), but the wrong one for the
 * merge: unserialized, it would overwrite concurrent appends AND then remove
 * the source key. Here, no lock ⇒ no callback, ever.
 */
export async function withAppendLockRequired<T>(
  key: string,
  holder: CondenseLockInfo,
  fn: () => Promise<T>
): Promise<T> {
  const lockOwned = await acquireAppendLock(key, holder);
  if (!lockOwned) {
    throw new AppendLockUnavailableError(key);
  }
  try {
    return await fn();
  } finally {
    await releaseAppendLock(key, holder);
  }
}

/**
 * Lit un dashboard : PG d'abord (#3151 Phase C, gate
 * UNIFIED_STORE_DASHBOARD_READ_PG), puis fichier Markdown GDrive en fallback.
 * Retourne null si inexistant partout.
 *
 * #3782 — une clé retirée (marque active en base, posée par un merge) est
 * INVISIBLE ici dans les DEUX moitiés : ses lignes restent en base (gel des
 * purges) mais le choke point rend la clé absente pour read/append/merge.
 * Fail-open : lookup PG injoignable ⇒ clé traitée comme non retirée (comportement d'avant).
 */
async function readDashboardFile(key: string): Promise<Dashboard | null> {
  // #3782 — retired key: ignore it before touching either half. The retained
  // PG rows would otherwise serve the fork (the rows survive the mark by
  // design), and the preserved file (deleteSource:false) would serve it too.
  const retirement = await getDashboardRetirement(key);
  if (retirement) {
    logger.debug('[retirement #3782] clé retirée ignorée à la lecture', {
      key,
      targetKey: retirement.targetKey,
      retiredAt: retirement.retiredAt,
    });
    return null;
  }
  // #3151 Phase C — PG-primary read, GDrive fallback (dégradation gracieuse).
  // readDashboardFromPg returns null when the gate is off, PG fails, or the
  // key has no row — all three mean "not authoritative", fall through to the
  // file. Under-show protection mirrors the Phase B message channel: a store
  // that was never backfilled must NOT present as an empty dashboard.
  const pgDashboard = await readDashboardFromPg(key);
  if (pgDashboard !== null) return pgDashboard;
  return readDashboardFromGdrive(key);
}

/**
 * #3782 — suit la chaîne des marques de retraite (A→B, B→C) et rend la marque
 * DERNIÈRE résolue : `targetKey` est la cible finale, non une clé elle-même
 * retirée. Borné (5 sauts) + garde de cycle — une base marquée en boucle ne
 * doit jamais boucler l'écriture.
 */
async function resolveRetirementRedirect(
  key: string
): Promise<DashboardRetirementMark | null> {
  const visited = new Set<string>([key]);
  let currentKey = key;
  let activeMark: DashboardRetirementMark | null = null;
  for (let hop = 0; hop < 5; hop++) {
    const mark = await getDashboardRetirement(currentKey);
    if (!mark) break;
    activeMark = mark;
    if (visited.has(mark.targetKey)) {
      logger.warn('[retirement #3782] cycle de marques — redirection arrêtée sur la dernière cible résolue', {
        requestedKey: key,
        resolvedTarget: mark.targetKey,
      });
      break;
    }
    visited.add(mark.targetKey);
    currentKey = mark.targetKey;
  }
  return activeMark;
}

/** #3782 — préfixe la note de redirection au message de la réponse écrite. */
async function withRedirectNote(
  note: string | undefined,
  run: Promise<DashboardResult>
): Promise<DashboardResult> {
  const result = await run;
  if (note && result && typeof result.message === 'string') {
    result.message = `${note} ${result.message}`;
  }
  return result;
}

/**
 * #3226(a): snapshot of the global dashboard intercom for the background
 * notification check (ToolUsageInterceptor tick). Same read path as an agent
 * read (PG-primary, GDrive fallback). Returns null when global does not exist
 * yet — nothing to notify about.
 */
export async function readGlobalIntercomMessages(): Promise<IntercomMessage[] | null> {
  const dashboard = await readDashboardFile('global');
  return dashboard ? dashboard.intercom.messages : null;
}

// #3205 résiduel : lectures transitoires du fichier partagé (course write→rename
// entre machines + hydratation DriveFS) — mesuré 15→22/08 : échec puis succès au
// 2e/3e appel à 1-3 s d'intervalle. Backoff calé sur cette fenêtre observée.
const DASHBOARD_READ_MAX_ATTEMPTS = 3;
const DASHBOARD_READ_BACKOFF_MS = [500, 1500];

/**
 * Lit un dashboard depuis le stockage Markdown GDrive. Retourne null si inexistant.
 */
async function readDashboardFromGdrive(key: string): Promise<Dashboard | null> {
  const filePath = getDashboardPath(key);
  let lastError: unknown;
  // #3404 : l'échelle de retry (#1032/#3205) couvre les erreurs fs de LECTURE
  // uniquement (EBUSY, course write→rename, hydratation DriveFS). Le parse est
  // sorti du try : une erreur de parse signifie que le contenu a été LU — un
  // fichier durablement malformant re-lu 3× avec 2 s de backoff ne peut jamais
  // réussir. Mesuré sur ai-01 : 2 fichiers malformés (rapports compare_config
  // vidés dans dashboards/) × (500+1500) ms de sleep = 4 s DÉTERMINISTES sur
  // CHAQUE roosync_dashboard(list) — la marche E2E 277 ms → ~4 340 ms du
  // 24/08 (bump #1032) au 04/09. Semblable à ENOENT : échec certain → pas de retry.
  let content: string | null = null;
  for (let attempt = 1; attempt <= DASHBOARD_READ_MAX_ATTEMPTS; attempt++) {
    try {
      content = (await fs.readFile(filePath, 'utf8')).replace(/\r\n/g, '\n');
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      lastError = error;
      logger.warn(`Lecture dashboard échouée (tentative ${attempt}/${DASHBOARD_READ_MAX_ATTEMPTS})`, {
        key,
        error: error instanceof Error ? error.message : String(error)
      });
      if (attempt < DASHBOARD_READ_MAX_ATTEMPTS) {
        await new Promise(resolve => setTimeout(resolve, DASHBOARD_READ_BACKOFF_MS[attempt - 1]));
      }
    }
  }
  if (content === null) {
    logger.error('Erreur lecture dashboard', lastError, { key });
    throw lastError;
  }
  return parseDashboardMarkdown(content, key);
}

/**
 * #3482 — Résultat de la vérification post-écriture (garde anti-fork DriveFS).
 *
 * #3774 — étendu : le verdict porte désormais sur **deux surfaces** (le fichier
 * `.md` et le store PG qui fait autorité pour la flotte), et il nomme le
 * **lieu d'atterrissage** réel des messages neufs — c'est lui le discriminant
 * (`chemin écrit == chemin demandé`), pas un compteur écrit par le writer.
 */
export interface WriteVerifyResult {
  forkSuspected: boolean;
  forkDetail?: string;
  forkPath?: string;
  /**
   * #3774 — chemin où les messages neufs ont réellement été retrouvés.
   * Égal au chemin demandé ⇒ atterrissage nominal (aucune alerte).
   */
  landedPath?: string;
  /** #3774 — surface ayant armé le verdict (diagnostic, jamais bloquant). */
  signal?: 'file' | 'store' | 'file+store';
  /**
   * #3774 critère 2 — `false` quand la relecture du store autoritaire n'a PAS
   * pu être faite (porte PG off, store indisponible). Limite **assumée et
   * visible** : un `pgChecked:false` n'est jamais un succès implicite.
   */
  pgChecked?: boolean;
}

/**
 * #3482 — Vérifie qu'une écriture dashboard a bien atterri sur le fichier
 * canonique et n'a pas été déviée par DriveFS/Windows vers un fork
 * `<stem> (N).md` (incident mesuré 06/09 : un [ASK USER] urgent est resté
 * invisible du canonique pendant que le writer croyait réussir).
 *
 * Deux discriminateurs, dans l'ordre :
 * 1. Relire l'en-tête du canonique. `totalMessages` est un compteur monotone
 *    flotte — un found PLUS PETIT que l'attendu signifie que NOTRE écriture
 *    n'y est pas ; un found plus GRAND signifie qu'un writer concurrent a
 *    gagné APRÈS notre rename (nominal, pas un fork). Clock-independent,
 *    contrairement à lastModified (skew inter-machines, cf heartbeats c.303).
 *    Fallback lastModified (compare lexicographique ISO) si totalMessages
 *    absent de l'en-tête.
 * 2. Scanner le répertoire pour un sibling de collision Windows
 *    `<stem> (N).md` dont le mtime tombe dans la fenêtre de CETTE écriture —
 *    un fork archivé ancien ne doit pas armer la garde.
 *
 * Jamais throw : une vérification elle-même défaillante rend
 * { forkSuspected: false } (invérifiable ≠ suspecté) pour ne pas casser le
 * chemin d'écriture.
 */
export async function verifyDashboardWriteLanded(
  filePath: string,
  expected: { lastModified: string; totalMessages: number },
  writeStartedAtMs: number,
  landedIds?: readonly string[]
): Promise<WriteVerifyResult> {
  try {
    // #3774 critère 1 — DISCRIMINANT PRINCIPAL : le lieu d'atterrissage des
    // octets, pas un compteur. `lastModified`/`totalMessages` sont écrits PAR
    // LE WRITER : dans un fork ils valent exactement ce qu'il attendait, donc
    // ils ne peuvent pas détecter sa propre déviation (arbitrage 06/09). On
    // cherche donc les ids des messages neufs — que le writer seul a produits —
    // AU CHEMIN DEMANDÉ. Présents ⇒ l'égalité `chemin écrit == chemin demandé`
    // est établie par les octets. Absents ⇒ on NOMME le chemin réel.
    // Aucune dépendance à un motif de suffixe (` (N)`) : le scan ci-dessous
    // cherche le CONTENU, quel que soit le nom que DriveFS a choisi.
    // Le verdict NOMINAL, lui, ne court-circuite PAS les contrôles historiques :
    // un writer qui réécrit un dashboard déjà sur disque (status, scrub,
    // condensation) y retrouve par construction des messages qui étaient DÉJÀ
    // là — le contrôle d'id y serait vacant, et l'utiliser comme sortie
    // anticipée affaiblirait la garde au lieu de la renforcer.
    let idNominalAt: string | undefined;
    if (landedIds && landedIds.length > 0) {
      const dir = path.dirname(filePath);
      let requestedBody: string | null = null;
      try {
        requestedBody = await fs.readFile(filePath, 'utf8');
      } catch {
        requestedBody = null;
      }
      const carries = (body: string): boolean =>
        landedIds.every(id => body.includes(`[msg: ${id}]`));

      if (requestedBody !== null && carries(requestedBody)) {
        idNominalAt = filePath;
      } else {
        let entries: string[];
        try {
          entries = await fs.readdir(dir);
        } catch {
          // #3774 review ai-01 (m2) — l'écriture vient de RÉUSSIR dans ce
          // répertoire : un readdir qui échoue juste après est anormal, et le
          // défaut de cette garde est silencieux par nature (3 semaines sans
          // alarme). Direction conservatrice des deux côtés : alarme.
          return {
            forkSuspected: true,
            signal: 'file',
            forkDetail: `répertoire '${dir}' illisible au moment de la vérification alors que l'écriture vient d'y réussir — vérification impossible, direction conservatrice`
          };
        }
        for (const entry of entries) {
          if (!entry.endsWith('.md') || entry.endsWith('.tmp')) continue;
          const candidate = path.join(dir, entry);
          if (candidate === filePath) continue;
          try {
            const body = await fs.readFile(candidate, 'utf8');
            if (landedIds.some(id => body.includes(`[msg: ${id}]`))) {
              // #3774 review ai-01 (MAJEUR) — PAS de `forkPath` ici. Ce champ
              // alimente la décision de suppression de source du merge
              // (`suspectedForeignFork = forkSuspected && forkPath !== sourcePath`).
              // Dans un merge, l'union est triée par timestamp : le DERNIER
              // message vient de la clé la plus récente — la SOURCE — qui porte
              // donc l'id cherché PAR CONSTRUCTION, avant même l'écriture. La
              // nommer `forkPath` ferait basculer `suspectedForeignFork` à
              // false et POURSUIVRAIT la suppression : inversion du
              // fail-closed de la base, sur le scénario #3774 lui-même (et
              // dépendant de l'ordre d'énumération de readdir, donc non
              // reproductible à la demande). `forkPath` garde son sens
              // historique — un fork `(N)` ÉTRANGER vu par le contrôle hérité
              // — et `landedPath` porte la localisation.
              return {
                forkSuspected: true,
                signal: 'file',
                landedPath: candidate,
                forkDetail: `ids attendus absents du chemin demandé '${path.basename(filePath)}' mais présents dans '${entry}' — égalité chemin écrit == chemin demandé rompue ('${entry}' peut être un porteur préexistant, ex. source d'un merge, pas nécessairement le lieu d'atterrissage)`
              };
            }
          } catch {
            // sibling illisible : on poursuit le scan, il peut être le porteur
          }
        }

        return {
          forkSuspected: true,
          signal: 'file',
          forkDetail: `messages neufs introuvables — ni au chemin demandé, ni dans un sibling .md (ids: ${landedIds.join(', ')})`
        };
      }
    }

    const fh = await fs.open(filePath, 'r');
    let foundTotal: number | null = null;
    let foundLastModified: string | null = null;
    try {
      const buf = Buffer.alloc(1024);
      const { bytesRead } = await fh.read(buf, 0, 1024, 0);
      const head = buf.toString('utf8', 0, bytesRead);
      const mTotal = head.match(/^totalMessages:\s*(\d+)\s*$/m);
      if (mTotal) foundTotal = parseInt(mTotal[1], 10);
      const mLm = head.match(/^lastModified:\s*(?:'([^']+)'|"([^"]+)"|(\S+))/m);
      foundLastModified = mLm ? (mLm[1] ?? mLm[2] ?? mLm[3] ?? null) : null;
    } finally {
      await fh.close();
    }

    if (foundTotal !== null) {
      if (foundTotal < expected.totalMessages) {
        return {
          forkSuspected: true,
          forkDetail: `totalMessages canonique ${foundTotal} < attendu ${expected.totalMessages} — l'écriture n'a pas atterri sur le canonique`
        };
      }
    } else if (foundLastModified !== null && foundLastModified < expected.lastModified) {
      return {
        forkSuspected: true,
        forkDetail: `lastModified canonique '${foundLastModified}' antérieur à l'écriture '${expected.lastModified}'`
      };
    }

    const dir = path.dirname(filePath);
    const stem = path.basename(filePath).replace(/\.md$/, '');
    const forkRe = new RegExp(
      '^' + stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\(\\d+\\)\\.md$'
    );
    const entries = await fs.readdir(dir);
    for (const entry of entries) {
      if (!forkRe.test(entry)) continue;
      const forkPath = path.join(dir, entry);
      const st = await fs.stat(forkPath);
      if (st.mtimeMs >= writeStartedAtMs - 1000) {
        return {
          forkSuspected: true,
          forkDetail: `fork frais dans la fenêtre d'écriture: ${entry}`,
          forkPath
        };
      }
    }
    return { forkSuspected: false, landedPath: idNominalAt };
  } catch (err) {
    // #3774 review ai-01 (m2) — asymétrie assumée et documentée : le chemin
    // d'id alerte quand le répertoire devient illisible (ci-dessus, l'écriture
    // vient d'y réussir), mais ce catch ultime — erreurs inattendues du chemin
    // HÉRITÉ (open/stat du canonique) — rend « invérifiable », pas « suspecté » :
    // ce chemin est celui de la base #3482, son contrat (ne jamais casser
    // l'écriture, jamais de faux positif sur instrument défaillant) est épinglé
    // par ses tests historiques. Un verdict suspecté ici régresserait le
    // comportement de la base pour tous les appelants sans ids.
    logger.debug('Vérification post-écriture impossible (non bloquant)', {
      filePath,
      error: err instanceof Error ? err.message : String(err)
    });
    return { forkSuspected: false };
  }
}

function logForkSuspicion(key: string, filePath: string, wv: WriteVerifyResult): void {
  logger.error('[DASHBOARD-FORK] écriture possiblement déviée (#3482) — le canonique ne reflète pas cette écriture', {
    key,
    path: filePath,
    detail: wv.forkDetail,
    forkPath: wv.forkPath,
    remediation: 'DriveFS local probablement wedgé — relire le canonique, redémarrer DriveFS/VS Code de la machine, puis re-poster si absent (intercom-protocol §append expiré)'
  });
}

/**
 * #3774 critère 2 — vérifie l'écriture sur le substrat qui fait **autorité** :
 * le store PG, que la flotte lit en primaire (`UNIFIED_STORE_DASHBOARD_READ_PG`),
 * et non la seule projection `.md` (arbitrage : « toute réparation par
 * manipulation de fichiers est inopérante sur ce que la flotte lit réellement »).
 *
 * Contrat de retour, explicite par construction :
 * - `pgChecked:false` — la relecture n'a PAS eu lieu (porte PG off, store
 *   injoignable, aucun id à vérifier). **Limite assumée**, jamais un succès
 *   implicite : l'appelant peut la rendre visible.
 * - `pgChecked:true` + `storeKey === key` — les messages neufs sont lisibles
 *   sous la clé demandée dans le store.
 * - `pgChecked:true` + `storeKey === ''` — le store répond mais **sans** nos
 *   messages : la flotte ne les lira pas, quoi que dise le fichier.
 */
export async function verifyWriteVisibleInStore(
  key: string,
  landedIds?: readonly string[]
): Promise<{ pgChecked: boolean; storeKey?: string; detail?: string }> {
  if (!landedIds || landedIds.length === 0) return { pgChecked: false };
  let stored: Dashboard | null = null;
  try {
    stored = await readDashboardFromPg(key);
  } catch {
    stored = null;
  }
  if (!stored) {
    return {
      pgChecked: false,
      detail: 'store PG illisible ou porte off — substrat autoritaire NON vérifié (limite assumée, #3774 critère 2)'
    };
  }
  const present = new Set(stored.intercom.messages.map(m => m.id));
  if (landedIds.every(id => present.has(id))) return { pgChecked: true, storeKey: key };
  return {
    pgChecked: true,
    storeKey: '',
    detail: `messages neufs absents du journal PG de '${key}' — la flotte (lecture PG-primaire) ne les verra pas`
  };
}

/**
 * #3774 — fusionne le verdict fichier (#3482) et le verdict store (#3774) en un
 * résultat unique. Aucun des deux ne peut effacer l'autre : un atterrissage
 * fichier nominal ne masque pas une absence dans le store (c'est le cas qui a
 * coûté 3 semaines), et une absence fichier n'est pas pardonnée par le store.
 */
export function mergeStoreVerification(
  wv: WriteVerifyResult,
  store: { pgChecked: boolean; storeKey?: string; detail?: string }
): WriteVerifyResult {
  const out: WriteVerifyResult = { ...wv, pgChecked: store.pgChecked };
  if (!store.pgChecked) return out;
  if (store.storeKey !== undefined && store.storeKey !== '') return out;
  return {
    ...out,
    forkSuspected: true,
    signal: wv.forkSuspected ? 'file+store' : 'store',
    forkDetail: `${wv.forkDetail ? `${wv.forkDetail} | ` : ''}${store.detail ?? 'absent du store PG'}`
  };
}

/**
 * #3584 — masquage à la frontière de publication, définition UNIQUE dans
 * `utils/secret-redaction.ts` (deux couches : formes auto-descriptives +
 * valeurs connues du process ; la seconde seule attrape une valeur nue).
 * Les call-sites du dashboard gardent le nom court.
 */
const maskSecretText = maskSecretTextForPublication;

/**
 * Masque une LISTE de messages, et rend la liste d'origine — par identité de
 * référence — quand rien n'a bougé, pour que l'appelant puisse le tester.
 *
 * Extrait de `redactForPublication` parce que l'append n'a à masquer QUE ses messages
 * NEUFS : les anciens ont déjà traversé cette même frontière à leur propre écriture
 * et sont relus du disque déjà masqués. Repasser tout l'intercom à chaque append est
 * quadratique : mesuré le 11/09 sur le test « breaks the vicious circle » de
 * `dashboard.test.ts` — 8243 ms sans, 14121 ms avec (+71 %) — contre un `testTimeout`
 * de 15 000 ms. C'est un rouge CI déterministe, pas un flake : rerun sur le MÊME
 * commit, même jeu d'échecs.
 */
function redactMessagesForPublication(key: string, messages: IntercomMessage[]): IntercomMessage[] {
  // L'index des valeurs secrètes connues est préconstruit UNE fois pour tout
  // l'intercom : le reconstruire par message est du travail perdu (~0,31 ms × N,
  // mesuré sur un `env` de 128 entrées). Voir `createKnownValueMasker`.
  const maskKnownValues = createKnownValueMasker();
  const maskOne = (text: string): string =>
    maskKnownValues(FORM_LAYER_MARKER.test(text) ? redactSecrets(text) : text);

  let messagesMasked = 0;
  const masked = messages.map(msg => {
    const raw = msg.content ?? '';
    const out = maskOne(raw);
    if (out === raw) return msg;
    messagesMasked++;
    return { ...msg, content: out };
  });

  if (messagesMasked === 0) return messages;

  // Jamais la valeur, ni sa longueur, ni son empreinte : le NOM de variable et le
  // compte suffisent à l'opérateur. Ce log est le seul signal qu'un auteur reçoit
  // que son message a été altéré — sans lui, il croirait avoir publié tel quel.
  logger.warn('[DASHBOARD-REDACTION] secret masqué à la publication (#3584)', {
    key,
    statusMasked: false,
    messagesMasked
  });

  return masked;
}

function redactForPublication(key: string, dashboard: Dashboard): Dashboard {
  const statusRaw = dashboard.status.markdown ?? '';
  const statusMasked = maskSecretText(statusRaw);
  const statusChanged = statusMasked !== statusRaw;

  const messages = redactMessagesForPublication(key, dashboard.intercom.messages);
  const messagesChanged = messages !== dashboard.intercom.messages;

  if (statusChanged) {
    logger.warn('[DASHBOARD-REDACTION] secret masqué à la publication (#3584)', {
      key,
      statusMasked: true,
      messagesMasked: 0
    });
  }

  if (!statusChanged && !messagesChanged) return dashboard;

  return {
    ...dashboard,
    status: statusChanged ? { ...dashboard.status, markdown: statusMasked } : dashboard.status,
    intercom: messagesChanged ? { ...dashboard.intercom, messages } : dashboard.intercom
  };
}

/**
 * Sérialise un Dashboard en markdown sur disque (frontmatter + Status +
 * Intercom). Extrait de writeDashboardFile pour #3782 garde (a) : le
 * write-back d'hydratation produit des fichiers byte-identiques via UN seul
 * sérialiseur — deux constructeurs dériveraient.
 */
function buildDashboardMarkdown(dashboard: Dashboard): string {
  const frontmatter: DashboardFrontmatter = {
    type: dashboard.type,
    lastModified: dashboard.lastModified,
    lastModifiedBy: dashboard.lastModifiedBy,
    totalMessages: dashboard.intercom.totalMessages,
    lastCondensedAt: dashboard.intercom.lastCondensedAt
  };

  const yamlFrontmatter = yaml.dump(frontmatter);
  const statusSection = dashboard.status.markdown || '*Aucun contenu.*';

  // FIX #1123: Escape "### [" at line start in content to prevent false message splits
  const escapeContent = (text: string): string =>
    text.replace(/^### \[/gm, '\\#\\#\\# [');
  const intercomSection = dashboard.intercom.messages.length > 0
    ? dashboard.intercom.messages.map(msg => {
        // v3 (#1363): persist message id on a dedicated line below header
        // #1956: persist reply_to and acknowledged_at metadata
        let metaLines = `### [${msg.timestamp}] ${msg.author.machineId}|${msg.author.workspace}\n[msg: ${msg.id}]`;
        if (msg.reply_to) metaLines += `\n[reply-to: ${msg.reply_to}]`;
        if (msg.acknowledged_at && Object.keys(msg.acknowledged_at).length > 0) {
          const ackStr = Object.entries(msg.acknowledged_at).map(([m, t]) => `${m}:${t}`).join(', ');
          metaLines += `\n[ack: ${ackStr}]`;
        }
        return `${metaLines}\n\n${escapeContent(msg.content)}`;
      }).join('\n\n---\n\n')
    : '*Aucun message.*';

  return `---
${yamlFrontmatter.trim()}
---

## Status

${statusSection}

## Intercom (${dashboard.intercom.messages.length} messages)

${intercomSection}
`;
}

/**
 * Écrit un dashboard dans le stockage au format Markdown avec frontmatter YAML
 */
async function writeDashboardFile(
  key: string,
  dashboard: Dashboard,
  opts?: { condensed?: boolean }
): Promise<WriteVerifyResult> {
  // #3584 — masquer AVANT toute persistance : ce choke point alimente à la fois le
  // fichier partagé et le miroir PostgreSQL (`dualWriteDashboardSync` ci-dessous), et
  // tous les chemins d'écriture (append, write, merge, cross-post, condensation) le
  // traversent. Un masquage posé plus haut ne couvrirait que l'append.
  dashboard = redactForPublication(key, dashboard);

  const dir = getDashboardsDir();
  ensureStoreSubdir(getSharedStatePath(), 'dashboards');
  const filePath = getDashboardPath(key);
  const tmpPath = `${filePath}.tmp`;

  const content = buildDashboardMarkdown(dashboard);

  const writeStartedAtMs = Date.now();
  await fs.writeFile(tmpPath, content, 'utf8');
  await fs.rename(tmpPath, filePath);
  logger.debug('Dashboard écrit', { key, path: filePath });

  // #3482 — post-write guard: a rename "succeeded" by DriveFS can have landed
  // on a ` (N).md` fork. Loud error + result flag; never throws (the write
  // itself must not be undone by its verification).
  // #3774 — jeton d'atterrissage : l'id du DERNIER message de l'instantané écrit.
  // Pour un APPEND il est neuf par construction (produit par ce process, absent
  // de toute version antérieure) et la comparaison de chemin est concluante. Ce
  // n'est PAS vrai des writers qui réécrivent un dashboard déjà sur disque
  // (status, scrub, condensation) : leurs messages sont déjà là, l'id est
  // retrouvé au chemin demandé quoi qu'il arrive — c'est précisément pourquoi la
  // garde ne sort PAS sur ce verdict nominal et laisse parler les contrôles
  // historiques (cf. verifyDashboardWriteLanded).
  const landedIds = dashboard.intercom.messages.length > 0
    ? [dashboard.intercom.messages[dashboard.intercom.messages.length - 1].id]
    : undefined;
  let wv = await verifyDashboardWriteLanded(filePath, {
    lastModified: dashboard.lastModified,
    totalMessages: dashboard.intercom.totalMessages
  }, writeStartedAtMs, landedIds);

  // #3151 Phase C — dual-write to PG (roosync_dashboards + journal). AWAITED,
  // never-throwing: PG becomes the read-primary store, so the mirror must be
  // consistent before the caller returns. A hard PG failure still degrades to
  // the GDrive-only behavior (dualWriteDashboardSync swallows its errors and
  // the writer's circuit breaker caps the retry cost).
  // `opts.condensed` (threaded from applyCondensedWithMerge) is the only mode
  // allowed to stamp archived_at — a plain write's snapshot can lag concurrent
  // appends from the other machines (GDrive parity: condensation is the sole
  // operation that removes intercom messages).
  await dualWriteDashboardSync(dashboard, opts);

  // #3774 critère 2 — relecture du substrat autoritaire, fusionnée AVANT la
  // journalisation (cf. appendDashboardIncremental : même contrat).
  wv = mergeStoreVerification(wv, await verifyWriteVisibleInStore(key, landedIds));
  if (wv.forkSuspected) logForkSuspicion(key, filePath, wv);
  return wv;
}

/**
 * #2328: Apply condensed dashboard with smart-merge to avoid overwriting
 * concurrent appends from other machines during the LLM condensation window (~9 min).
 *
 * Before overwriting, re-reads the file from disk and stitches any messages
 * appended by other machines (identified by msg.id) into the condensed result.
 * Also guards against double-condensation (skips if another condensation won).
 */
async function applyCondensedWithMerge(
  key: string,
  snapshotBefore: Dashboard,
  condensedDashboard: Dashboard
): Promise<WriteVerifyResult | undefined> {
  // #3151 Phase C: anchor the delta on the artifact this function is about to
  // OVERWRITE -- the GDrive file. readDashboardFile() became PG-primary once
  // UNIFIED_STORE_DASHBOARD_READ_PG shipped, so on a key where PG and the file
  // diverge it stitches the PG view over the file and drops every message that
  // exists only on disk. Measured on ai-01 (07/09): 15 of 63 dashboards diverge;
  // on workspace-CoursIA the two journals share ZERO messages, so a condensation
  // from a PG-reading host would have erased 23 messages of three other machines.
  // The docstring above always said "re-reads the file from disk" -- the read gate
  // silently changed the source, not the intent.
  const current = await readDashboardFromGdrive(key);
  if (!current) {
    return await writeDashboardFile(key, condensedDashboard, { condensed: true });
  }

  // Guard: if another condensation completed while our LLM was running,
  // don't overwrite with our stale result.
  if (
    current.intercom.lastCondensedAt &&
    current.intercom.lastCondensedAt > (snapshotBefore.intercom.lastCondensedAt ?? '')
  ) {
    logger.warn('[COLLISION] concurrent condensation won — skipping stale overwrite', { key });
    return undefined;
  }

  // Delta = messages on disk that weren't in our pre-condensation snapshot.
  // append-only => these are concurrent appends => always a suffix.
  const seen = new Set(snapshotBefore.intercom.messages.map(m => m.id));
  const delta = current.intercom.messages.filter(m => !seen.has(m.id));

  if (delta.length === 0) {
    return await writeDashboardFile(key, condensedDashboard, { condensed: true });
  }

  logger.warn('[COLLISION] stitching concurrent appends into condensed result', {
    key, deltaCount: delta.length, deltaIds: delta.map(m => m.id)
  });

  const merged: Dashboard = {
    ...condensedDashboard,
    lastModified: current.lastModified > condensedDashboard.lastModified
      ? current.lastModified
      : condensedDashboard.lastModified,
    intercom: {
      messages: [...condensedDashboard.intercom.messages, ...delta],
      totalMessages: condensedDashboard.intercom.totalMessages + delta.length,
      lastCondensedAt: condensedDashboard.intercom.lastCondensedAt,
    },
  };
  return await writeDashboardFile(key, merged, { condensed: true });
}

/**
 * Append messages to the dashboard file without rewriting existing content.
 * Only updates frontmatter (in-place regex) and appends new messages at the end.
 * Used by handleAppend when no condensation occurred (the common case).
 * #2121: Reduces GDrive sync traffic by avoiding full content re-serialization.
 */
async function appendDashboardIncremental(
  key: string,
  dashboard: Dashboard,
  newMessageCount: number
): Promise<WriteVerifyResult> {
  const dir = getDashboardsDir();
  ensureStoreSubdir(getSharedStatePath(), 'dashboards');
  const filePath = getDashboardPath(key);
  const tmpPath = `${filePath}.tmp`;

  // #3205 write-side — the read→rename window below is the last-writer-wins
  // race: two processes/machines appending inside the same window each succeed
  // locally and the later rename silently drops the earlier message (`Tool
  // call OK`, message gone — po-2026 22/08). The cross-process append lock
  // serializes it; the PG dual-write stays OUTSIDE so the hold time is pure fs.
  const holder: CondenseLockInfo = {
    machineId: dashboard.lastModifiedBy?.machineId ?? 'unknown',
    workspace: dashboard.lastModifiedBy?.workspace ?? 'unknown',
    pid: process.pid,
    acquiredAt: new Date().toISOString()
  };
  const lockOwned = await acquireAppendLock(key, holder);
  let wv: WriteVerifyResult = { forkSuspected: false };
  // #3774 — ids des messages NEUFS de cet append : le seul jeton que le writer
  // produit lui-même, donc le seul qui puisse établir où ses octets ont atterri.
  let landedIds: string[] = [];
  try {
    let existing: string;
    try {
      existing = await fs.readFile(filePath, 'utf8');
    } catch {
      return writeDashboardFile(key, dashboard);
    }

    const frontmatter: DashboardFrontmatter = {
      type: dashboard.type,
      lastModified: dashboard.lastModified,
      lastModifiedBy: dashboard.lastModifiedBy,
      totalMessages: dashboard.intercom.totalMessages,
      lastCondensedAt: dashboard.intercom.lastCondensedAt
    };
    const newFm = `---\n${yaml.dump(frontmatter).trim()}\n---`;

    const fmReplaced = existing.replace(/^---\n[\s\S]+?\n---/, newFm);

    const escapeContent = (text: string): string =>
      text.replace(/^### \[/gm, '\\#\\#\\# [');

    const newMessages = dashboard.intercom.messages.slice(-newMessageCount);
    const newBlock = newMessages.map(msg => {
      let metaLines = `### [${msg.timestamp}] ${msg.author.machineId}|${msg.author.workspace}\n[msg: ${msg.id}]`;
      if (msg.reply_to) metaLines += `\n[reply-to: ${msg.reply_to}]`;
      if (msg.acknowledged_at && Object.keys(msg.acknowledged_at).length > 0) {
        const ackStr = Object.entries(msg.acknowledged_at).map(([m, t]) => `${m}:${t}`).join(', ');
        metaLines += `\n[ack: ${ackStr}]`;
      }
      return `${metaLines}\n\n${escapeContent(msg.content)}`;
    }).join('\n\n---\n\n');

    let result: string;
    if (fmReplaced.includes('*Aucun message.*')) {
      result = fmReplaced.replace('*Aucun message.*', newBlock);
    } else {
      result = fmReplaced.trimEnd() + '\n\n---\n\n' + newBlock + '\n';
    }

    const writeStartedAtMs = Date.now();
    await fs.writeFile(tmpPath, result, 'utf8');
    await fs.rename(tmpPath, filePath);
    logger.debug('Dashboard append incrémental', { key, path: filePath, newMessages: newMessageCount });

    // #3482 — post-write guard (même contrat que writeDashboardFile) : un
    // append « réussi » peut avoir été dévié vers un fork ` (N).md`.
    landedIds = newMessages.map(m => m.id);
    wv = await verifyDashboardWriteLanded(filePath, {
      lastModified: dashboard.lastModified,
      totalMessages: dashboard.intercom.totalMessages
    }, writeStartedAtMs, landedIds);
  } finally {
    if (lockOwned) {
      await releaseAppendLock(key, holder);
    }
  }

  // #3151 Phase C — dual-write the appended journal rows to PG. Same awaited,
  // never-throwing contract as writeDashboardFile: the incremental file append
  // stays the primary write; PG mirrors it (append-first is what makes the
  // condense-after phase below safe to fail).
  await dualWriteDashboardSync(dashboard);

  // #3774 critère 2 — le verdict n'est complet qu'APRÈS la relecture du store
  // autoritaire (le dual-write vient d'avoir lieu : la clé est interrogeable).
  // Fusionné AVANT la journalisation, pour que le log et la réponse de l'outil
  // portent le verdict des DEUX surfaces ; sans ce contrôle, un atterrissage
  // fichier nominal masquait une absence côté store — le cas qui a vécu 3 semaines.
  wv = mergeStoreVerification(wv, await verifyWriteVisibleInStore(key, landedIds));
  if (wv.forkSuspected) logForkSuspicion(key, filePath, wv);
  return wv;
}

/**
 * Crée un dashboard vide avec les valeurs par défaut.
 *
 * #3537 §6.4 — une clé de dashboard naît **implicitement** de la première
 * écriture qui la nomme : rien n'échoue, un espace de noms inédit apparaît, et
 * aucun lecteur n'apprend jamais qu'il existe. C'est ce silence — pas le fork
 * DriveFS — qui a laissé `workspace-CoursIA (1)`, `workspace-` (nom vide),
 * `workspace-jsboi` (tronqué), `workspace-…%3ACoursIA-2` (URL-encodé) et des
 * résidus `.bak` vivre des mois durant au rang de clés de plein droit.
 *
 * Le WARN vit ici, dans la fabrique, et non aux trois sites d'appel (write,
 * append, cross-post) : une quatrième création future est bruyante sans que
 * personne ait à y penser. La fabrique n'est appelée que dans les branches
 * `if (!dashboard)` — elle ne peut donc pas japper sur une clé existante.
 *
 * #3537 §6.3 (borne vide) — création-seule, par construction : cette fabrique
 * n'est appelée que sur les branches `if (!dashboard)` des trois chemins de
 * création (handleWrite, handleAppend, cross-post). Read, delete, read_archive,
 * read_overview et list ne l'appellent jamais — une garde ici ne peut donc pas
 * rendre une clé historique illisible.
 *
 * Invariant volontairement minimal : refuser de CRÉER un espace de noms dont
 * le segment de nom est vide ou whitespace (`workspace-`, `machine-`,
 * `workspace- `). Le schéma accepte `workspace: ""` (z.string().optional(),
 * sans .min(1)) et le `??` du handler ne remplace pas une chaîne vide — la
 * fabrique est la seule porte qui ferme ce chemin (clé `workspace-` recensée
 * dans le store, #3537 §4). Tout le reste passe inchangé : casse (mandat
 * 2026-05-23), suffixes ` (1)` (deux écrivains vivants, #3482 — fusion =
 * §6.2 explicite), `.md`/`.bak`/`%3A` — ces formes restent lisibles à jamais
 * et ne sont JAMAIS rejetées à la dérivation.
 *
 * Ordre délibéré garde → WARN : une clé refusée ne jette AUCUN `[NEW-KEY]` —
 * l'erreur de refus est le signal plus fort ; le WARN ne parle que des clés
 * qui passent la garde.
 */
export function createEmptyDashboard(
  type: NonNullable<DashboardArgs['type']>,
  key: string,
  author: Author
): Dashboard {
  const prefix = type === 'workspace' ? 'workspace-' : type === 'machine' ? 'machine-' : null;
  if (prefix !== null && key.startsWith(prefix) && key.slice(prefix.length).trim() === '') {
    throw new Error(
      `Refus de créer un dashboard ${type} à nom vide : clé dérivée '${key}' ` +
      `(machineId='${author.machineId}', workspace='${author.workspace}'). ` +
      `L'appelant a passé workspace/machineId vide — '??' ne remplace pas une chaîne vide (#3537 §6.3).`
    );
  }
  logger.warn(
    `[NEW-KEY] création d'un espace de noms dashboard inédit : '${key}' — aucun lecteur ne le connaît`,
    { key, type, machineId: author.machineId, workspace: author.workspace }
  );
  const now = new Date().toISOString();
  return {
    type,
    key,
    lastModified: now,
    lastModifiedBy: author,
    status: {
      markdown: `# Dashboard ${key}\n\n*Aucun contenu.*\n`
    },
    intercom: {
      messages: [],
      totalMessages: 0
    }
  };
}

/**
 * Détecte les mentions dans un contenu de message
 * Patterns supportés:
 * - @myia-ai-01 (machine)
 * - @myia-po-2025 (machine)
 * - @myia-web1 (machine)
 * - @roo-myia-ai-01 (agent Roo)
 * - @claude-myia-ai-01 (agent Claude)
 * - @jsboige (utilisateur)
 * - @msg:ic-20260413T0830-a1b2 (référence message)
 */
interface ParsedMention {
  type: 'machine' | 'agent' | 'user' | 'message';
  target: string; // machine ID, agent ID, user ID, ou message ID
  pattern: string; // exact pattern matched
}

function parseMentions(content: string): ParsedMention[] {
  const mentions: ParsedMention[] = [];
  let match;

  // Pattern 1: @roo-<machine-id> or @claude-<machine-id> (check this FIRST)
  // Matches: @roo-myia-ai-01, @claude-test-machine, etc.
  const agentPattern = /@(roo|claude)-([a-zA-Z0-9][a-zA-Z0-9\-]*)/g;
  while ((match = agentPattern.exec(content)) !== null) {
    mentions.push({
      type: 'agent',
      target: `${match[1]}-${match[2]}`,
      pattern: match[0]
    });
  }

  // Pattern 2: @msg:id (message references)
  // Matches: @msg:ic-2026-04-13-101530, @msg:issue-1234
  const messagePattern = /@msg:([a-zA-Z0-9][a-zA-Z0-9\-]*)/g;
  while ((match = messagePattern.exec(content)) !== null) {
    mentions.push({
      type: 'message',
      target: match[1],
      pattern: match[0]
    });
  }

  // Pattern 3: @jsboige (known usernames)
  const userPattern = /@(jsboige)/g;
  while ((match = userPattern.exec(content)) !== null) {
    mentions.push({
      type: 'user',
      target: match[1],
      pattern: match[0]
    });
  }

  // Pattern 4: @machine-id (catch-all for any other @mention)
  // Matches: @myia-ai-01, @test-machine, @myia-po-2025, etc.
  // But skips matches already captured above
  const generalPattern = /@([a-zA-Z0-9][a-zA-Z0-9\-]*)/g;
  const capturedPatterns = new Set(mentions.map(m => m.pattern));
  while ((match = generalPattern.exec(content)) !== null) {
    const target = match[1];
    const pattern = match[0];
    // Skip if already captured by agent or message pattern
    if (!capturedPatterns.has(pattern)) {
      mentions.push({
        type: 'machine',
        target,
        pattern
      });
      capturedPatterns.add(pattern);
    }
  }

  // Deduplicate mentions by pattern
  const uniqueMentions = new Map<string, ParsedMention>();
  for (const mention of mentions) {
    if (!uniqueMentions.has(mention.pattern)) {
      uniqueMentions.set(mention.pattern, mention);
    }
  }

  return Array.from(uniqueMentions.values());
}

/**
 * Détermine si un message mentionne la machine/agent courant
 */
function isMentioned(mentions: ParsedMention[], localMachineId: string, localWorkspaceId: string): boolean {
  for (const mention of mentions) {
    switch (mention.type) {
      case 'machine':
        if (mention.target === localMachineId) return true;
        break;
      case 'agent':
        // Check both roo-<machineId> and claude-<machineId>
        if (mention.target === `roo-${localMachineId}` ||
            mention.target === `claude-${localMachineId}`) {
          return true;
        }
        break;
      case 'user':
        // Users mentioned (@jsboige) are always considered "for them"
        // but for read filtering, we skip user mentions (not machine-specific)
        break;
      case 'message':
        // Message references don't trigger "mentioned" status
        break;
    }
  }
  return false;
}

/**
 * Per-condense-pass telemetry bubbled up to the tool result. Populated by
 * `condenseIntercom` via an optional accumulator argument (non-breaking change
 * to preserve the Dashboard return type consumed by legacy paths).
 *
 * Outcomes:
 *   - `condensed`         : LLM succeeded (primary), archive written, status updated
 *   - `fallback-cloud`    : #2719 primary (local vLLM) failed but the cloud fallback
 *                           (z.ai glm-4.7-flash) salvaged the condensation — the
 *                           dashboard still got an LLM summary, just not from the
 *                           primary. Distinguishable from `fallback-truncated` (which
 *                           means even the cloud failed → lossy truncation).
 *   - `no-op`             : messages ≤ keepCount, nothing to do
 *   - `llm-failed-dedup`  : LLM failed but a recent CONDENSATION CANCELLED
 *                           already exists within CONDENSATION_ERROR_DEDUP_MS
 *                           → dashboard returned unchanged, no extra error msg
 *   - `llm-failed-injected`: LLM failed, no recent error → new CONDENSATION
 *                            CANCELLED system message appended
 *   - `fallback-truncated`  : #1792 circuit breaker open or LLM failed → simple
 *                            truncation without LLM (keep last N, template summary)
 *   - `skipped-lock-held`   : #2818 another process holds the condense file-lock
 *                            → skipped the redundant LLM pass; this message is
 *                            already persisted (append-first) and will be merged
 *                            into the holder's condensed result by #2328.
 */
export interface CondenseAttemptInfo {
  phase: 'preemptive' | 'reactive' | 'manual' | 'post-append';
  outcome: 'condensed' | 'no-op' | 'llm-failed-dedup' | 'llm-failed-injected' | 'fallback-truncated' | 'fallback-cloud' | 'skipped-lock-held';
  elapsedMs: number;
  archivedMessageCount: number;
  llm?: {
    summary?: LLMCallStats;
    status?: LLMCallStats;
  };
}

function newDiagnostic(phase: CondenseAttemptInfo['phase']): CondenseAttemptInfo {
  return { phase, outcome: 'no-op', elapsedMs: 0, archivedMessageCount: 0 };
}

/**
 * Per-phase LLM call telemetry. Populated by `generateLLMSummary` /
 * `generateStatusUpdate` and bubbled up through `condenseIntercom` → the
 * dashboard tool result so operators can distinguish "LLM down" from "LLM
 * returned null content because thinking ate max_tokens" from "prompt too
 * large" without tailing server logs.
 */
export interface LLMCallStats {
  /** Number of attempts made (1..LLM_MAX_RETRIES). */
  attempts: number;
  /** Total wall-clock elapsed including backoffs (ms). */
  elapsedMs: number;
  /** How many attempts returned a null/empty content (thinking overran max_tokens, etc.). */
  nullCount: number;
  /** How many attempts threw (connection, 4xx/5xx, JSON parse). */
  errorCount: number;
  /** Subset of errorCount: attempts that aborted on timeout. */
  timeoutCount: number;
  /** Truncated last error message (first 240 chars). Only set when final outcome is error/timeout. */
  lastError?: string;
  /** Final outcome. */
  finalOutcome: 'ok' | 'null' | 'error' | 'timeout' | 'client-init-failed' | 'circuit-open' | 'ok-with-fallback';
  // #2719: Cloud fallback fields
  /** Whether the cloud fallback (z.ai / OpenAI) was used for this call. */
  fallbackUsed?: boolean;
  /** Model name used for the fallback attempt (e.g. "glm-4.7-flash"). */
  fallbackModel?: string;
  /** Wall-clock time for the successful fallback attempt (ms). */
  fallbackElapsedMs?: number;
  // #2998: Cloud fallback diagnostic fields — distinguish "fallback unconfigured"
  // (fallbackAttempted absent) from "fallback attempted but rejected" (fallbackAttempted
  // true, fallbackError set) from "fallback succeeded" (fallbackUsed true).
  /** Whether the cloud fallback was attempted but failed (set only when fallbackUsed is not true). */
  fallbackAttempted?: boolean;
  /** Error message from the last failed fallback attempt (truncated). */
  fallbackError?: string;
}

/**
 * Result wrapper for an LLM generation call.
 */
interface LLMCallResult {
  content: string | null;
  stats: LLMCallStats;
}

function emptyLLMStats(outcome: LLMCallStats['finalOutcome']): LLMCallStats {
  return { attempts: 0, elapsedMs: 0, nullCount: 0, errorCount: 0, timeoutCount: 0, finalOutcome: outcome };
}

function truncateError(msg: string): string {
  return msg.length > 240 ? `${msg.slice(0, 237)}...` : msg;
}

/**
 * Robust error → string. The OpenAI SDK can throw non-`Error` objects on
 * connection-level failures (fetch/socket), which `String()` renders as the
 * useless "[object Object]" — hiding the real cause of a condensation failure.
 * This surfaces .message / .error.message / .status / .code, falling back to
 * JSON so the operator actually sees what failed. See describeLLMError for the
 * fuller treatment used in stats.lastError.
 */
function safeErrorString(error: unknown): string {
  if (error instanceof Error) return error.message || error.toString();
  if (typeof error === 'string') return error;
  const e = error as { message?: string; error?: { message?: string }; status?: number; code?: string };
  const direct = e?.error?.message || e?.message;
  if (direct) {
    const prefix = [typeof e?.status === 'number' ? `HTTP ${e.status}` : null, e?.code ? `code=${e.code}` : null]
      .filter(Boolean).join(' ');
    return prefix ? `${prefix}: ${direct}` : direct;
  }
  try { return JSON.stringify(error) || String(error); } catch { return String(error); }
}

/** Host[:port] of the condensation LLM endpoint — for explicit error context (host only, no secret). */
export function condenseEndpointHost(): string {
  const raw = process.env.OPENAI_BASE_URL || '';
  try { return new URL(raw).host || '(OPENAI_BASE_URL unset)'; }
  catch { return raw || '(OPENAI_BASE_URL unset)'; }
}

/**
 * Detect whether a caught error is a condensation LLM timeout.
 *
 * #3012: The primary condensation path passes `{ timeout: ms }` to the OpenAI SDK
 * (no AbortController). On a hung endpoint the SDK throws `APIConnectionTimeoutError`,
 * which inherits `Error.prototype.name` — i.e. `error.name === "Error"`, NOT
 * `"AbortError"`. The previous guard (`error.name === 'AbortError'`) never fired on
 * the primary path, so the #2267 "do not retry a timeout" guard was dead code: every
 * real timeout was retried 3× (~3 × CONDENSE_LLM_TIMEOUT_MS = ~36 min) before falling
 * back to truncation, instead of failing fast.
 *
 * Detection strategy:
 *   - `error.constructor?.name === 'APIConnectionTimeoutError'` — identifies the
 *     SDK timeout class by its constructor name. This works even when a double
 *     copy of the SDK in `node_modules` defeats `instanceof` (duplicate package
 *     instances have different prototypes). It also avoids a static value import
 *     from `openai`, which would interact with the test suite's module mocks.
 *   - `error.name === 'AbortError'` — kept for the day an `AbortController`/`signal`
 *     is introduced on this path; today nothing produces it here.
 *
 * Measured on `openai@4.104.0`: `new APIConnectionTimeoutError({}).name === "Error"`
 * but `.constructor.name === "APIConnectionTimeoutError"`. The SDK never sets
 * `this.name`, so `Error.prototype.name` ("Error") is inherited — the old check
 * was structurally unable to match.
 *
 * Shared by `generateLLMSummary` and `generateStatusUpdate` so the two twin call
 * sites cannot silently diverge again.
 */
function isLLMTimeoutError(error: unknown): boolean {
  // Primary signal: constructor.name identifies the SDK class even across
  // duplicate module copies (where instanceof fails due to different prototypes).
  const ctorName = (error as { constructor?: { name?: string } })?.constructor?.name;
  if (ctorName === 'APIConnectionTimeoutError') return true;
  // Legacy AbortController signal path (currently unused on the primary, kept
  // so a future `signal` introduction doesn't silently regress the guard).
  if (error instanceof Error && error.name === 'AbortError') return true;
  return false;
}

/**
 * Build an EXPLICIT, human-readable failure string for a failed condensation LLM call.
 *
 * User mandate 2026-06-01: "le condenser doit exploser avec des erreurs explicites le
 * cas échéant, pas nous mettre des timeout dont on ne sait ce qu'il y a derrière."
 * A bare "timeout" tells the operator nothing — this surfaces WHAT failed (HTTP status,
 * provider body, or a socket hang), against WHICH endpoint/model, and after how long.
 */
export function describeLLMError(
  error: unknown,
  opts: { isTimeout: boolean; timeoutMs: number; elapsedMs: number; model: string }
): string {
  const host = condenseEndpointHost();
  const provider = isOpenAICompatVLlm() ? 'vLLM' : 'remote';
  const ctx = `[${provider} ${host} model=${opts.model}]`;
  if (opts.isTimeout) {
    return `TIMEOUT after ${Math.round(opts.elapsedMs / 1000)}s (limit ${Math.round(opts.timeoutMs / 1000)}s): `
      + `no response — socket held open, neither a completion nor an HTTP error. `
      + `Endpoint likely hung (check vLLM/gateway health). ${ctx}`;
  }
  // OpenAI SDK APIError exposes .status (HTTP code) / .code / .error.message
  const e = error as { status?: number; code?: string; message?: string; error?: { message?: string } };
  const httpStatus = typeof e?.status === 'number' ? `HTTP ${e.status}` : '';
  const code = e?.code ? `code=${e.code}` : '';
  const body = e?.error?.message || e?.message || String(error);
  const prefix = [httpStatus, code].filter(Boolean).join(' ');
  return truncateError(`${prefix ? prefix + ': ' : ''}${body} ${ctx}`);
}

/**
 * Génère un résumé LLM des messages intercom (#858)
 *
 * @param messages - Messages à résumer
 * @returns Résumé markdown + stats. content = null si échec (3 retries failed).
 */
async function generateLLMSummary(messages: IntercomMessage[], opts?: { skipPrimary?: boolean }): Promise<LLMCallResult> {
  // #2267 follow-up: was 1800s (#1497). The 1800s ceiling only ever caught a TRUE
  // hang — CONDENSE_LLM_MAX_TOKENS already bounds a runaway under the ~600s gateway.
  // See CONDENSE_LLM_TIMEOUT_MS definition for the full rationale.
  const timeoutMs = CONDENSE_LLM_TIMEOUT_MS;

  // Construire le prompt avec les messages
  const messagesContent = messages.map(msg => {
    const header = `[${msg.timestamp}] ${msg.author.machineId}|${msg.author.workspace}`;
    return `${header}\n${msg.content}`;
  }).join('\n\n---\n\n');

  const systemPrompt = `Tu es un expert en synthèse de communications inter-agents.

CONTEXTE : Ces messages viennent d'être RETIRÉS d'un dashboard de coordination et archivés.
Ce résumé sera le SEUL enregistrement visible de ces messages dans le dashboard.

EXIGENCES :
- ZÉRO perte d'information actionnable (décisions, résultats, blocages résolus)
- Regrouper par THÈMES, pas par message individuel
- Préserver les métriques chiffrées exactes (scores, taux, nombres)
- Préserver les dates des événements importants
- Maximum 20 lignes. Pas d'emojis. Pas de prose, que du factuel.
- Le résumé DOIT faire moins de 5 Ko. Être CONCIS mais COMPLET.
- Ne JAMAIS inventer d'informations absentes des messages

INTERDICTION STRICTE — ÉTATS GITHUB NON-SOURCÉS (#3771) :
Tu n'as PAS accès à l'API GitHub. Tu ne peux donc PAS affirmer qu'une PR ou une issue est
dans un état terminal (MERGÉ, FERMÉ/CLOSED, « Merge validé », « CLEAN », etc.) à moins
qu'un message source ne le dise EXPLICITEMENT (verbatim ou paraphrase traçable).
- Si un message dit « [DONE] PR #1234 mergée », tu peux écrire « PR #1234 mergée ».
- Si AUCUN message ne mentionne l'état de la PR #1234, tu dois écrire « PR #1234 (état non
  vérifié dans ce résumé) » ou omettre l'état.
- N'infère JAMAIS un merge à partir d'indices lexicaux (discussion d'un AUTRE merge,
  mention « doublon », « pas de nouvelle PR »).
- Cette consigne prime sur la concision : un état non vérifié est PRÉFÉRABLE à un état faux.

FORMAT :
## Résumé des ${messages.length} messages archivés

### Thèmes principaux
- [thème] : synthèse factuelle

### Actions et résultats
- [DONE/BLOCKED/EN COURS] description avec dates

### Décisions et métriques
- Décisions prises, valeurs chiffrées, résultats mesurés`;

  const userPrompt = `${messages.length} messages retirés du dashboard à synthétiser :\n\n${messagesContent}\n\nRésume ces messages archivés. Ce résumé sera la seule trace visible dans le dashboard.`;

  logger.info('Calling LLM for intercom summary', { messageCount: messages.length });

  const callStart = Date.now();
  const stats: LLMCallStats = emptyLLMStats('null');

  // #2719 (22/09): the primary's circuit breaker is OPEN — skip the primary, but the
  // cloud tier is an independent provider: try it before resigning to truncation.
  if (opts?.skipPrimary) {
    stats.finalOutcome = 'circuit-open';
    const fb = await tryCloudCondenseFallback(systemPrompt, userPrompt, { maxTokens: CONDENSE_LLM_MAX_TOKENS, temperature: 0.3 }, stats, callStart);
    return fb ?? circuitOpenFailure(stats, callStart);
  }

  let openai: OpenAI;
  try {
    openai = getChatOpenAIClient();
  } catch (error) {
    const errStr = safeErrorString(error);
    logger.error('LLM client init failed for summary', { error: errStr });
    // #2719: primary chat client can't init (missing/bad OPENAI_API_KEY) — the
    // cloud fallback has its OWN key (FALLBACK_API_KEY), so it may still succeed.
    // Try it before resigning to lossy truncation. Previously this returned null
    // immediately → guaranteed truncation even when the fallback was fully armed.
    stats.finalOutcome = 'client-init-failed';
    stats.lastError = truncateError(errStr);
    stats.elapsedMs = Date.now() - callStart;
    const fb = await tryCloudCondenseFallback(systemPrompt, userPrompt, { maxTokens: CONDENSE_LLM_MAX_TOKENS, temperature: 0.3 }, stats, callStart);
    return fb ?? { content: null, stats };
  }
  const modelId = getLLMModelId();

  // Retry with exponential backoff (error/empty only — size handled post-hoc)
  for (let attempt = 1; attempt <= LLM_MAX_RETRIES; attempt++) {
    stats.attempts = attempt;
    const startTime = Date.now();
    try {
      const thinkingCtrl = buildThinkingControl(isOpenAICompatVLlm());
      const response = await openai.chat.completions.create({
        model: modelId,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: thinkingCtrl.promptPrefix + userPrompt }
        ],
        // See CONDENSE_LLM_MAX_TOKENS: bounded so a runaway thinking loop returns
        // before the ~600s reverse-proxy gateway timeout (502) — lets condensation
        // actually complete instead of dying mid-thinking and falling to truncation.
        max_tokens: CONDENSE_LLM_MAX_TOKENS,
        temperature: 0.3,
        // Disable Qwen3.6 thinking mode (user mandate 2026-05-26): thinking-loop
        // runaway repetition causes null content (finish_reason=length) and chains
        // of retries that hang the dashboard append. Non-thinking trades nuance for
        // reliability — "moindre mal" while the cluster is in crisis.
        ...(thinkingCtrl.chatTemplateKwargs ? { chat_template_kwargs: thinkingCtrl.chatTemplateKwargs } : {})
      }, {
        timeout: timeoutMs
      });

      const summary = response.choices[0]?.message?.content;
      if (!summary) {
        stats.nullCount += 1;
        logger.warn('LLM returned empty summary', { attempt, finishReason: response.choices[0]?.finish_reason });
        if (attempt < LLM_MAX_RETRIES) {
          const backoff = LLM_INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1);
          logger.info(`Retrying summary in ${backoff}ms...`, { attempt, backoff });
          await new Promise(resolve => setTimeout(resolve, backoff));
          continue;
        }
        stats.finalOutcome = 'null';
        stats.elapsedMs = Date.now() - callStart;
        stats.lastError = `LLM returned null content ${stats.nullCount}× (finish_reason likely "length" — thinking consumed max_tokens=${CONDENSE_LLM_MAX_TOKENS})`;
        // #2719: primary exhausted with null content (likely thinking-loop) → cloud fallback
        const fbNull = await tryCloudCondenseFallback(systemPrompt, userPrompt, { maxTokens: CONDENSE_LLM_MAX_TOKENS, temperature: 0.3 }, stats, callStart);
        if (fbNull) return fbNull;
        return { content: null, stats };
      }

      const sizeBytes = Buffer.byteLength(summary, 'utf8');
      const elapsed = Date.now() - startTime;
      logger.info('LLM summary generated', { attempt, elapsed: `${elapsed}ms`, summaryLength: summary.length, sizeKB: `${(sizeBytes / 1024).toFixed(1)}KB` });
      stats.finalOutcome = 'ok';
      stats.elapsedMs = Date.now() - callStart;
      return { content: summary, stats };

    } catch (error: unknown) {
      const elapsed = Date.now() - startTime;
      const errStr = safeErrorString(error);
      stats.errorCount += 1;
      // #3012: use class-identity detection — see isLLMTimeoutError. The previous
      // `error.name === 'AbortError'` test never fired here because the SDK throws
      // APIConnectionTimeoutError (whose `.name` inherits "Error").
      const isTimeout = isLLMTimeoutError(error);
      if (isTimeout) {
        stats.timeoutCount += 1;
        logger.warn('LLM summary timeout', { attempt, timeout: timeoutMs, elapsed: `${elapsed}ms` });
      } else {
        logger.error('LLM summary error', { attempt, elapsed: `${elapsed}ms`, error: errStr });
      }
      // #2267 follow-up: do NOT retry a timeout. A hung endpoint won't recover in a
      // 2-8s backoff — retrying just burns another full CONDENSE_LLM_TIMEOUT_MS. Fail
      // fast to the truncation fallback. (502/empty errors still retry below.)
      // #1130: also fail fast on non-retryable errors (401/403 auth): reuses the
      // fallback's classifier so a dead primary fails over to the cloud fallback on
      // attempt 1 instead of burning LLM_MAX_RETRIES on a call that can't heal.
      if (!isTimeout && isRetryableFallbackError(error) && attempt < LLM_MAX_RETRIES) {
        const backoff = LLM_INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1);
        logger.info(`Retrying summary in ${backoff}ms...`, { attempt, backoff });
        await new Promise(resolve => setTimeout(resolve, backoff));
        continue;
      }
      stats.finalOutcome = isTimeout ? 'timeout' : 'error';
      stats.elapsedMs = Date.now() - callStart;
      stats.lastError = describeLLMError(error, { isTimeout, timeoutMs, elapsedMs: stats.elapsedMs, model: modelId });
      // #2719: primary endpoint failed (down/timeout) → cloud fallback before giving up
      const fbErr = await tryCloudCondenseFallback(systemPrompt, userPrompt, { maxTokens: CONDENSE_LLM_MAX_TOKENS, temperature: 0.3 }, stats, callStart);
      if (fbErr) return fbErr;
      return { content: null, stats };
    }
  }

  stats.finalOutcome = 'null';
  stats.elapsedMs = Date.now() - callStart;
  return { content: null, stats };
}

/**
 * Génère une mise à jour du statut dashboard à partir de la version précédente
 * et des messages condensés (#858 Phase 2)
 *
 * @param previousStatus - Contenu markdown du statut précédent
 * @param archivedMessages - Messages qui vont être archivés
 * @returns Nouveau statut markdown ou null si échec (fallback = statut inchangé)
 */
async function generateStatusUpdate(
  previousStatus: string,
  allMessages: IntercomMessage[],
  archivedCount: number,
  dashboardKey: string,
  opts?: { skipPrimary?: boolean }
): Promise<LLMCallResult> {
  // #2267 follow-up: was 1800s (#1497) — see generateLLMSummary / CONDENSE_LLM_TIMEOUT_MS.
  const timeoutMs = CONDENSE_LLM_TIMEOUT_MS;

  // Format messages with archive/keep annotations
  const messagesContent = allMessages.map((msg, index) => {
    const annotation = index < archivedCount ? '[SERA ARCHIVÉ]' : '[CONSERVÉ]';
    const header = `${annotation} [${msg.timestamp}] ${msg.author.machineId}|${msg.author.workspace}`;
    return `${header}\n${msg.content}`;
  }).join('\n\n---\n\n');

  // Extract lastDate from the last message timestamp
  const lastDate = allMessages.length > 0 ? allMessages[allMessages.length - 1].timestamp : new Date().toISOString();

  const systemPrompt = `Tu es un expert en synthèse de dashboards de coordination multi-agents.

CONTEXTE : Le dashboard contient un STATUT et des MESSAGES INTERCOM, qui jouent des rôles distincts :
- Les **MESSAGES** sont l'activité courte du moment (rapports de cycle, claims, livrables individuels) — ils sont périodiquement archivés.
- Le **STATUT est la MÉMOIRE LONG-TERME du projet** sur plusieurs semaines/mois. Il porte les décisions actées, les blocages structurels qui durent, les configurations en vigueur, les seuils de référence, les patterns/anti-patterns appris, les jalons d'architecture. Ce n'est PAS un résumé des messages récents.

Les messages les plus anciens vont être archivés. Ta mission : faire ÉVOLUER le statut en HÉRITANT de l'ancien et en y intégrant ce qui a valeur durable dans les messages [SERA ARCHIVÉ]. Tu ne réécris PAS depuis zéro.

La taille du statut est gérée ailleurs — préfère un statut un peu plus volumineux à la perte d'informations historiques importantes. Le fine détail des cycles reste dans les messages (eux-mêmes condensés en cascade).

RÈGLE ABSOLUE — LAST-KNOWN-STATE WINS (#1502) :
Pour CHAQUE sujet (machine, service, tâche), SEUL le dernier état connu doit apparaître.
- Si un message récent dit "vLLM UP" et l'ancien statut dit "vLLM DOWN" → écrire "vLLM UP" UNIQUEMENT.
- Si un message récent dit "[DONE] tâche X" → la tâche X est TERMINÉE, pas "en cours".
- SUPPRIMER explicitement tout fait contredit par une source plus récente. Ne PAS garder les deux versions.

PRINCIPE INVERSE — SILENCE ≠ OBSOLESCENCE :
Si un fait de l'ancien statut N'EST PAS contredit par les messages récents (juste pas mentionné), il RESTE DANS LE STATUT. Une décision architecturale, un seuil de configuration, un pattern appris, une métrique de référence ne disparaissent pas parce qu'aucun cycle récent n'en parle. Seule une contradiction explicite ou une expiration documentée (ex: "X retiré au profit de Y") justifie une suppression.

EXIGENCES :
1. HÉRITAGE : partir de l'ancien statut, l'enrichir, NE PAS réécrire depuis zéro
2. ZÉRO perte d'information stratégique multi-cycles (décisions architecturales, blocages structurels, métriques de référence, patterns appris, configurations en vigueur)
3. CONTRADICTIONS : messages récents ont TOUJOURS RAISON — SUPPRIMER les faits obsolètes de l'ancien statut
4. [DONE] dans messages récents → TERMINÉ dans statut (JAMAIS "en cours")
5. Métriques chiffrées EXACTES préservées
6. INTÉGRER les infos durables des messages [SERA ARCHIVÉ] sinon perdues (le détail tactique disparaît, le savoir stratégique reste)
7. DATES : timestamps messages récents > dates ancien statut pour les faits mis à jour ; dates d'origine préservées pour les décisions historiques
8. Pas d'emojis. Factuel et structuré.
9. INTERDICTION D'EXTRAPOLER : ne rien afficher qui ne soit pas EXPLICITEMENT dans les sources (ancien statut + messages)

STRUCTURE :
## [${dashboardKey}] — État au ${lastDate}

### Résumé
[2-3 phrases INTERPRÉTATIVES : état global, tendance — clairement séparé des faits ci-dessous]

### État des systèmes
[FACTUEL uniquement : par entité (machine/service), dernier état connu avec date source]
Format : "- **entité** : état (source: [date])"

### Décisions actées
[Choix d'architecture/process qui restent valides — préserver à travers les cycles tant que non contredits ; inclure la date d'origine et le contexte]

### Blocages structurels
[Problèmes qui durent au-delà d'un cycle — distinguer des frictions ponctuelles]

### Livrables récents
[Réalisations avec dates — synthétiser par thème, pas par PR/commit individuel]

### En cours
[Tâches actives avec responsable — uniquement celles sans [DONE] récent]

### Métriques de référence
[Seuils, chiffres clés, configurations en vigueur — préservés à travers les cycles tant que non révisés]

### Patterns appris
[Anti-patterns identifiés, conventions établies, leçons consolidées — mémoire durable du projet]

INTERDIT :
- Réécrire le statut comme si l'ancien n'existait pas (HÉRITER ET ENRICHIR)
- Garder un fait contredit par un message plus récent (ex: "X DOWN" si un message dit "X UP")
- Retirer une décision architecturale, un seuil de configuration, une métrique de référence ou un pattern appris parce qu'aucun message récent n'en parle (silence ≠ obsolescence)
- Garder des tâches achevées sans valeur de référence (l'achevé non-instructif disparaît, l'architecture décidée reste)
- Lister chaque commit/PR individuellement
- Inventer des informations absentes des sources
- Inférer un état à partir d'informations partielles (extrapolation)

INTERDICTION STRICTE — ÉTATS GITHUB NON-SOURCÉS (#3771) :
Tu n'as PAS accès à l'API GitHub. Tu ne peux donc PAS affirmer qu'une PR ou une issue est
dans un état terminal (MERGÉ, FERMÉ/CLOSED, « Merge validé », « CLEAN », etc.) dans la
section « Livrables récents » ou ailleurs, à moins que :
1. Un message [SERA ARCHIVÉ] / [CONSERVÉ] ne le dise EXPLICITEMENT (verbatim ou paraphrase traçable), OU
2. L'ancien statut ne l'ait déjà acté.
- Datapoints mesurés : la condensation a halluciné « #17167 : MERGÉ » alors que la PR était
  OPEN (merged=false), et a même auto-contredit le statut dans la même régénération.
- N'infère JAMAIS un merge à partir d'indices lexicaux (discussion d'un AUTRE merge,
  mention « doublon », « pas de nouvelle PR », silence sur une PR).
- Si l'état est incertain, écris « #17167 (état non vérifié dans cette condensation) » ou
  omet le qualificatif d'état. Un état non vérifié est PRÉFÉRABLE à un état faux.
- Cette consigne prime sur la concision : ne JAMAIS écrire MERGÉ/CLOSED pour un PR/issue
  sans source verbatim. La section « Livrables récents » est particulièrement sensible :
  une PR listée là sera lue comme « la condensation me confirme qu'elle est mergée » —
  d'où le garde post-synthèse qui strippe toute ligne non sourcée. Tu n'as qu'à NE PAS
  en générer pour éviter le strip.`;

  const userPrompt = `**Statut précédent :**
${previousStatus}

**${allMessages.length} messages intercom (dont ${archivedCount} seront archivés, ${allMessages.length - archivedCount} conservés) :**
${messagesContent}

Mets à jour le statut en intégrant les informations des messages [SERA ARCHIVÉ]. Date de référence : ${lastDate}.`;

  logger.info('Calling LLM for status update', {
    previousStatusLength: previousStatus.length,
    messageCount: allMessages.length,
    archivedCount
  });

  const callStart = Date.now();
  const stats: LLMCallStats = emptyLLMStats('null');

  // #2719 (22/09): the primary's circuit breaker is OPEN — skip the primary, but the
  // cloud tier is an independent provider: try it before resigning to truncation.
  if (opts?.skipPrimary) {
    stats.finalOutcome = 'circuit-open';
    const fb = await tryCloudCondenseFallback(systemPrompt, userPrompt, { maxTokens: CONDENSE_LLM_MAX_TOKENS, temperature: 0.3 }, stats, callStart);
    return fb ?? circuitOpenFailure(stats, callStart);
  }

  let openai: OpenAI;
  try {
    openai = getChatOpenAIClient();
  } catch (error) {
    const errStr = safeErrorString(error);
    logger.error('LLM client init failed for status update', { error: errStr });
    // #2719: primary chat client can't init (missing/bad OPENAI_API_KEY) — the
    // cloud fallback has its OWN key (FALLBACK_API_KEY), so it may still succeed.
    // Try it before resigning to lossy truncation.
    stats.finalOutcome = 'client-init-failed';
    stats.lastError = truncateError(errStr);
    stats.elapsedMs = Date.now() - callStart;
    const fb = await tryCloudCondenseFallback(systemPrompt, userPrompt, { maxTokens: CONDENSE_LLM_MAX_TOKENS, temperature: 0.3 }, stats, callStart);
    return fb ?? { content: null, stats };
  }
  const modelId = getLLMModelId();

  // Retry with exponential backoff
  for (let attempt = 1; attempt <= LLM_MAX_RETRIES; attempt++) {
    stats.attempts = attempt;
    const startTime = Date.now();
    try {
      const thinkingCtrl = buildThinkingControl(isOpenAICompatVLlm());
      const response = await openai.chat.completions.create({
        model: modelId,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: thinkingCtrl.promptPrefix + userPrompt }
        ],
        // Bounded under the ~600s gateway timeout (see CONDENSE_LLM_MAX_TOKENS).
        max_tokens: CONDENSE_LLM_MAX_TOKENS,
        temperature: 0.3,
        // Disable Qwen3.6 thinking mode (user mandate 2026-05-26).
        ...(thinkingCtrl.chatTemplateKwargs ? { chat_template_kwargs: thinkingCtrl.chatTemplateKwargs } : {})
      }, {
        timeout: timeoutMs
      });

      const newStatus = response.choices[0]?.message?.content;
      if (!newStatus) {
        stats.nullCount += 1;
        logger.warn('LLM returned empty status update', { attempt, finishReason: response.choices[0]?.finish_reason });
        if (attempt < LLM_MAX_RETRIES) {
          const backoff = LLM_INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1);
          logger.info(`Retrying status update in ${backoff}ms...`, { attempt, backoff });
          await new Promise(resolve => setTimeout(resolve, backoff));
          continue;
        }
        stats.finalOutcome = 'null';
        stats.elapsedMs = Date.now() - callStart;
        stats.lastError = `LLM returned null content ${stats.nullCount}× (finish_reason likely "length" — thinking consumed max_tokens=${CONDENSE_LLM_MAX_TOKENS})`;
        // #2719: primary exhausted with null content (likely thinking-loop) → cloud fallback
        const fbNull = await tryCloudCondenseFallback(systemPrompt, userPrompt, { maxTokens: CONDENSE_LLM_MAX_TOKENS, temperature: 0.3 }, stats, callStart);
        if (fbNull) return fbNull;
        return { content: null, stats };
      }

      const sizeBytes = Buffer.byteLength(newStatus, 'utf8');
      const elapsed = Date.now() - startTime;
      logger.info('LLM status update generated', { attempt, elapsed: `${elapsed}ms`, newStatusLength: newStatus.length, sizeKB: `${(sizeBytes / 1024).toFixed(1)}KB` });
      stats.finalOutcome = 'ok';
      stats.elapsedMs = Date.now() - callStart;
      return { content: newStatus, stats };

    } catch (error: unknown) {
      const elapsed = Date.now() - startTime;
      const errStr = safeErrorString(error);
      stats.errorCount += 1;
      // #3012: use class-identity detection — see isLLMTimeoutError.
      const isTimeout = isLLMTimeoutError(error);
      if (isTimeout) {
        stats.timeoutCount += 1;
        logger.warn('LLM status update timeout', { attempt, timeout: timeoutMs, elapsed: `${elapsed}ms` });
      } else {
        logger.error('LLM status update error', { attempt, elapsed: `${elapsed}ms`, error: errStr });
      }
      // #2267 follow-up: do NOT retry a timeout (see generateLLMSummary catch).
      // #1130: also fail fast on non-retryable errors (401/403 auth) — see generateLLMSummary.
      if (!isTimeout && isRetryableFallbackError(error) && attempt < LLM_MAX_RETRIES) {
        const backoff = LLM_INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1);
        logger.info(`Retrying status update in ${backoff}ms...`, { attempt, backoff });
        await new Promise(resolve => setTimeout(resolve, backoff));
        continue;
      }
      stats.finalOutcome = isTimeout ? 'timeout' : 'error';
      stats.elapsedMs = Date.now() - callStart;
      stats.lastError = describeLLMError(error, { isTimeout, timeoutMs, elapsedMs: stats.elapsedMs, model: modelId });
      // #2719: primary endpoint failed (down/timeout) → cloud fallback before giving up
      const fbErr = await tryCloudCondenseFallback(systemPrompt, userPrompt, { maxTokens: CONDENSE_LLM_MAX_TOKENS, temperature: 0.3 }, stats, callStart);
      if (fbErr) return fbErr;
      return { content: null, stats };
    }
  }

  stats.finalOutcome = 'null';
  stats.elapsedMs = Date.now() - callStart;
  return { content: null, stats };
}

/**
 * Auto-condense a text (status or summary) if it exceeds maxSizeBytes.
 * Uses a dedicated LLM call asking to compress the text while preserving all info.
 * Returns the condensed text, or the original if condensation fails.
 */
export async function condenseTextIfTooLarge(
  text: string,
  maxSizeBytes: number,
  label: string
): Promise<string> {
  const sizeBytes = Buffer.byteLength(text, 'utf8');
  if (sizeBytes <= maxSizeBytes) return text;

  logger.info(`${label} exceeds size limit, auto-condensing`, { sizeBytes, limit: maxSizeBytes, sizeKB: `${(sizeBytes / 1024).toFixed(1)}KB` });

  // #2598 follow-up — Mechanism 2 (the dedicated "too big" condenser) is the ONLY
  // size guardian and MUST make the cap a HARD guarantee, not best-effort. Every
  // exit below returns <= maxSizeBytes. The LLM is the intelligent primary; the
  // deterministic truncateToMaxSize floor is the last resort when it can't converge
  // (no client / empty output / exception / still-over-cap after a bounded retry).
  // (Status GROWTH is Mechanism 1's business — see generateStatusUpdate; not touched here.)
  let openai: OpenAI;
  try {
    openai = getChatOpenAIClient();
  } catch {
    logger.warn(`Cannot auto-condense ${label}: no LLM client — applying deterministic truncation`);
    return truncateToMaxSize(text, maxSizeBytes, label);
  }
  const modelId = getLLMModelId();
  const capKb = Math.round(maxSizeBytes / 1024);

  // Up to 2 LLM attempts. The 2nd targets a tighter budget (~80% of the cap) with a
  // stronger instruction, used only if the 1st came back still over the limit.
  const MAX_ATTEMPTS = 2;
  let bestCandidate = text;
  let bestSize = sizeBytes;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const targetKb = attempt === 1 ? capKb : Math.max(1, Math.floor((maxSizeBytes * 0.8) / 1024));
    const aggressiveNote = attempt === 1
      ? ''
      : `\n\nCRITIQUE : la version précédente dépassait ENCORE la limite. Sois plus agressif — vise ${targetKb} Ko, fusionne/supprime davantage de redondance, SANS perdre aucune décision, métrique chiffrée ni blocage.`;

    const systemPrompt = `Tu es un expert en synthèse. Le texte suivant dépasse la limite de ${capKb} Ko.

MISSION : Condenser ce texte en dessous de ${targetKb} Ko tout en préservant TOUTE l'information critique.

RÈGLES :
- Préserver les métriques chiffrées exactes
- Préserver les dates et décisions
- Fusionner les éléments redondants
- Supprimer les formulations verbeuses, garder le factuel
- Supprimer les sections obsolètes (tâches terminées sans valeur de référence)
- Pas d'emojis, pas de prose
- Le résultat DOIT être plus court que l'original
- LAST-KNOWN-STATE WINS : pour chaque sujet, ne garder QUE le dernier état connu (#1502)
- INTERDICTION D'EXTRAPOLER : ne rien afficher qui ne soit pas dans le texte source (#1502)
- SUPPRIMER les faits contredits par des informations plus récentes dans le texte (#1502)${aggressiveNote}`;

    const startTime = Date.now();
    try {
      const thinkingCtrl = buildThinkingControl(isOpenAICompatVLlm());
      const response = await openai.chat.completions.create({
        model: modelId,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: thinkingCtrl.promptPrefix + text }
        ],
        // Bounded under the ~600s gateway timeout (see CONDENSE_LLM_MAX_TOKENS).
        max_tokens: CONDENSE_LLM_MAX_TOKENS,
        temperature: 0.3,
        // Disable Qwen3.6 thinking mode (user mandate 2026-05-26).
        ...(thinkingCtrl.chatTemplateKwargs ? { chat_template_kwargs: thinkingCtrl.chatTemplateKwargs } : {})
      }, {
        timeout: CONDENSE_LLM_TIMEOUT_MS  // #2267 follow-up: bounded so a hung endpoint fast-fails (was 900000)
      });

      const condensed = response.choices[0]?.message?.content;
      const elapsed = Date.now() - startTime;
      if (!condensed) {
        logger.warn(`Auto-condense ${label} attempt ${attempt}: LLM returned empty`, { elapsed: `${elapsed}ms` });
        continue;
      }

      const newSize = Buffer.byteLength(condensed, 'utf8');
      logger.info(`Auto-condensed ${label} (attempt ${attempt})`, {
        elapsed: `${elapsed}ms`,
        beforeKB: `${(sizeBytes / 1024).toFixed(1)}KB`,
        afterKB: `${(newSize / 1024).toFixed(1)}KB`,
        reduction: `${Math.round((1 - newSize / sizeBytes) * 100)}%`,
        targetKB: targetKb
      });

      if (newSize <= maxSizeBytes) return condensed;  // converged under cap — done

      // Still over cap: keep the smallest candidate seen, then retry tighter (or fall through).
      if (newSize < bestSize) { bestCandidate = condensed; bestSize = newSize; }
      logger.warn(`Auto-condense ${label} attempt ${attempt} still over cap`, {
        afterKB: `${(newSize / 1024).toFixed(1)}KB`, capKB: `${capKb}KB`
      });
    } catch (error) {
      const elapsed = Date.now() - startTime;
      logger.warn(`Auto-condense ${label} attempt ${attempt} failed`, {
        elapsed: `${elapsed}ms`,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  // #2719: primary LLM never converged (down / empty / still oversized) → cloud
  // fallback before falling to lossy truncation. The cloud result must still
  // respect the HARD cap (#2598): use it only if under cap, else keep it as the best
  // candidate for the deterministic backstop below.
  // #2998: cloudCondenseWithRetry retries on 429/5xx instead of a single attempt.
  const fbCloud = await cloudCondenseWithRetry(
    `Tu es un expert en synthèse. Condense le texte sous ${capKb} Ko en préservant TOUTE information critique (décisions, métriques chiffrées, dates, blocages). Fusionne les redondances, supprime le verbeux. Pas d'emojis, pas de prose. LAST-KNOWN-STATE WINS (#1502). N'extrapole rien qui ne soit pas dans le texte source.`,
    text,
    { maxTokens: CONDENSE_LLM_MAX_TOKENS, temperature: 0.3 },
  );
  if (fbCloud && 'content' in fbCloud) {
    const fbSize = Buffer.byteLength(fbCloud.content, 'utf8');
    if (fbSize <= maxSizeBytes) {
      logger.info(`#2719 cloud fallback condensed ${label} under cap`, { afterKB: `${(fbSize / 1024).toFixed(1)}KB`, capKB: `${capKb}KB` });
      return fbCloud.content;
    }
    if (fbSize < bestSize) { bestCandidate = fbCloud.content; bestSize = fbSize; }
  }

  // LLM never converged under the cap (down, empty, or still oversized) → deterministic
  // backstop on the smallest candidate so ${label} NEVER exceeds its cap (the #2598 bug).
  logger.warn(`Auto-condense ${label}: LLM did not converge under ${capKb}KB, applying deterministic truncation`, {
    bestKB: `${(bestSize / 1024).toFixed(1)}KB`
  });
  return truncateToMaxSize(bestCandidate, maxSizeBytes, label);
}

/**
 * Détecte les contradictions dans un statut généré (#1502).
 * Vérifie que chaque entité connue n'apparaît qu'avec un seul état (le plus récent).
 * Retourne la liste des contradictions trouvées pour logging et marquage.
 */
export function detectStatusContradictions(status: string): Array<{ entity: string; conflictingStates: string[] }> {
  const contradictions: Array<{ entity: string; conflictingStates: string[] }> = [];

  // Paires d'états contradictoires (positif vs négatif)
  const statePairs: Array<{ positive: string[]; negative: string[] }> = [
    { positive: ['UP', 'running', 'actif', 'active', 'online', 'ok', 'opérationnel'], negative: ['DOWN', 'stopped', 'inactif', 'inactive', 'offline', 'ko', 'hs', 'error', 'panne'] },
    { positive: ['terminé', 'done', 'complété', 'résolu', 'closed', 'merged'], negative: ['en cours', 'in progress', 'open', 'bloqué', 'blocked', 'todo'] },
  ];

  // Entités connues à surveiller (machines + services)
  const knownEntities = [
    'vllm', 'ollama', 'qdrant',
    'myia-ai-01', 'myia-po-2023', 'myia-po-2024', 'myia-po-2025', 'myia-po-2026', 'myia-web1',
    'ai-01', 'po-2023', 'po-2024', 'po-2025', 'po-2026', 'web1'
  ];

  const lines = status.split('\n');

  for (const entity of knownEntities) {
    const entityLower = entity.toLowerCase();
    const matchingLines = lines.filter(l => l.toLowerCase().includes(entityLower));

    if (matchingLines.length < 2) continue; // Besoin d'au moins 2 lignes pour une contradiction

    for (const { positive, negative } of statePairs) {
      const foundPositive = matchingLines.some(line =>
        positive.some(p => line.toLowerCase().includes(p.toLowerCase()))
      );
      const foundNegative = matchingLines.some(line =>
        negative.some(n => line.toLowerCase().includes(n.toLowerCase()))
      );

      if (foundPositive && foundNegative) {
        const posStates = positive.filter(p => matchingLines.some(l => l.toLowerCase().includes(p.toLowerCase())));
        const negStates = negative.filter(n => matchingLines.some(l => l.toLowerCase().includes(n.toLowerCase())));
        contradictions.push({
          entity,
          conflictingStates: [...posStates, ...negStates]
        });
      }
    }
  }

  return contradictions;
}

/**
 * #3803 (règle user RX38, 24/09) : réconciliation déterministe des contradictions
 * détectées par detectStatusContradictions. Pour une entité donnée, quand TOUTES
 * les lignes contradictoires portent un horodatage comparable, le DERNIER ÉTAT
 * DATÉ gagne et les lignes plus anciennes sont retirées. Sans horodatage comparable
 * (lignes non datées, précisions hétérogènes, égalité stricte) : RIEN n'est effacé —
 * l'entité reste non réconciliée et le marqueur #1502 continue d'être émis.
 *
 * Sémantique tout-ou-rien par entité : une seule ligne non datée parmi les
 * participantes bloque la réconciliation (on ne fond jamais partiellement).
 * La polarité ne décide jamais seule : un état négatif plus récent gagne contre
 * un état positif plus ancien (c'est la date qui tranche, pas le signe).
 */
export interface LineTimestamp {
  /** Minuit UTC du jour porté par l'horodatage. */
  dayMs: number;
  /** Vrai si l'horodatage porte une heure (précision minute). */
  hasTime: boolean;
  /** Minutes depuis minuit (uniquement si hasTime). */
  timeMin?: number;
}

export interface ReconciledEntity {
  entity: string;
  keptLine: string;
  keptTimestamp: string;
  droppedLines: Array<{ line: string; timestamp: string }>;
}

export interface StatusReconciliation {
  status: string;
  reconciled: ReconciledEntity[];
}

interface TsCandidate {
  start: number;
  end: number;
  priority: number; // 0 = ISO date+heure, 1 = FR date+heure, 2 = ISO date, 3 = FR date, 4 = heure seule
  ts: LineTimestamp;
}

function isValidDateParts(y: number, mo: number, d: number): boolean {
  return mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && y >= 2000 && y <= 2100;
}

function isValidTimeParts(h: number, mi: number): boolean {
  return h >= 0 && h <= 23 && mi >= 0 && mi <= 59;
}

/**
 * Résout le jour d'une date FR « JJ/MM » : année = celle de la date de référence
 * du status (header « État au »), avec retour d'un an si la date résolue tombe
 * plus de ~6 mois dans le futur (31/12 mentionné dans un status de janvier).
 */
function resolveFrDay(day: number, month: number, refDayMs: number | null): number | null {
  const ref = refDayMs ?? Date.now();
  const refYear = new Date(ref).getUTCFullYear();
  for (const year of [refYear, refYear - 1]) {
    const ms = Date.UTC(year, month - 1, day);
    if (ms <= ref + 183 * 86400000) return ms;
  }
  return null;
}

/**
 * Extrait l'horodatage « pertinent » d'une ligne : parmi les candidats valides
 * (dates ISO ou FR, heure seule résolue par la date de référence), on garde
 * celui le plus proche d'un mot-clé d'état — l'heure citée est celle de l'état,
 * pas d'un fait adjacent de la même ligne. Déterministe.
 */
export function extractLineTimestamp(
  line: string,
  keywords: string[],
  refDayMs: number | null
): LineTimestamp | null {
  const candidates: TsCandidate[] = [];
  const push = (matches: IterableIterator<RegExpMatchArray>, priority: number, parse: (g: string[]) => LineTimestamp | null) => {
    for (const m of matches) {
      const ts = parse(m.slice(1));
      if (ts === null) continue; // Champs invalides (ex. « 13/14 ») : le candidat n'existe pas
      candidates.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, priority, ts });
    }
  };

  push(line.matchAll(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/g), 0, g => {
    const [y, mo, d, h, mi] = g.map(Number);
    if (!isValidDateParts(y, mo, d) || !isValidTimeParts(h, mi)) return null;
    return { dayMs: Date.UTC(y, mo - 1, d), hasTime: true, timeMin: h * 60 + mi };
  });
  push(line.matchAll(/(\d{1,2})\/(\d{1,2})\s+(?:à\s+)?(\d{1,2})[h:](\d{2})/g), 1, g => {
    const [d, mo, h, mi] = g.map(Number);
    if (mo > 12 || d < 1 || d > 31 || !isValidTimeParts(h, mi)) return null;
    const dayMs = resolveFrDay(d, mo, refDayMs);
    return dayMs === null ? null : { dayMs, hasTime: true, timeMin: h * 60 + mi };
  });
  push(line.matchAll(/(\d{4})-(\d{2})-(\d{2})/g), 2, g => {
    const [y, mo, d] = g.map(Number);
    if (!isValidDateParts(y, mo, d)) return null;
    return { dayMs: Date.UTC(y, mo - 1, d), hasTime: false };
  });
  push(line.matchAll(/(\d{1,2})\/(\d{1,2})/g), 3, g => {
    const [d, mo] = g.map(Number);
    if (mo > 12 || d < 1 || d > 31) return null;
    const dayMs = resolveFrDay(d, mo, refDayMs);
    return dayMs === null ? null : { dayMs, hasTime: false };
  });
  push(line.matchAll(/(\d{1,2})[h:](\d{2})/g), 4, g => {
    const h = Number(g[0]);
    const mi = Number(g[1]);
    if (!isValidTimeParts(h, mi) || refDayMs === null) return null; // Heure sans jour de référence : non datable
    return { dayMs: refDayMs, hasTime: true, timeMin: h * 60 + mi };
  });

  if (candidates.length === 0) return null;

  // Un candidat chevauchant un candidat de priorité supérieure est un fragment
  // du même horodatage (ex. « 14:16 » dans « 2026-09-24T14:16 ») : on l'écarte.
  const kept: TsCandidate[] = [];
  for (const c of candidates.sort((a, b) => a.priority - b.priority || a.start - b.start)) {
    if (!kept.some(k => c.start < k.end && k.start < c.end)) kept.push(c);
  }

  const lower = line.toLowerCase();
  const kwPositions: number[] = [];
  for (const k of keywords) {
    let from = 0;
    for (;;) {
      const p = lower.indexOf(k.toLowerCase(), from);
      if (p === -1) break;
      kwPositions.push(p);
      from = p + k.length;
    }
  }
  if (kwPositions.length === 0) return kept[0].ts;

  // Dans un status français, l'horodatage de l'état SUIT le mot-clé
  // (« opérationnel depuis 12:11Z », « DOWN (08:00Z) ») : on préfère le
  // candidat situé APRÈS un mot-clé ; à défaut (mot-clé en fin de ligne),
  // on retombe sur le plus proche.
  const after = kept.filter(c => kwPositions.some(p => c.start > p));
  const pool = after.length > 0 ? after : kept;
  let best = pool[0];
  let bestDist = Infinity;
  for (const c of pool) {
    for (const p of kwPositions) {
      const dist = Math.min(Math.abs(c.start - p), Math.abs(c.end - p));
      if (dist < bestDist) {
        bestDist = dist;
        best = c;
      }
    }
  }
  return best.ts;
}

function formatTimestamp(ts: LineTimestamp): string {
  const d = new Date(ts.dayMs);
  const iso = d.toISOString().substring(0, 10);
  if (!ts.hasTime) return iso;
  const h = Math.floor((ts.timeMin ?? 0) / 60).toString().padStart(2, '0');
  const mi = ((ts.timeMin ?? 0) % 60).toString().padStart(2, '0');
  return `${iso} ${h}:${mi}`;
}

/**
 * Réconcilie les contradictions d'un status : pour chaque entité contradictoire,
 * si toutes ses lignes participantes portent un horodatage comparable ET qu'il
 * existe un gagnant strictement unique (le plus récent), les lignes perdantes
 * sont retirées. Retourne le status réécrit et la liste des réconciliations
 * effectuées (piste d'audit pour le marqueur #3803).
 */
export function reconcileStatusContradictions(
  status: string,
  contradictions: Array<{ entity: string; conflictingStates: string[] }>
): StatusReconciliation {
  if (contradictions.length === 0) return { status, reconciled: [] };

  const refDayMatch = status.match(/État au (\d{4})-(\d{2})-(\d{2})/);
  const refDayMs = refDayMatch
    ? Date.UTC(Number(refDayMatch[1]), Number(refDayMatch[2]) - 1, Number(refDayMatch[3]))
    : null;

  // Fusion des mots-clés par entité (une entité peut avoir une entrée par paire d'états)
  const entityKeywords = new Map<string, string[]>();
  for (const c of contradictions) {
    const existing = entityKeywords.get(c.entity) ?? [];
    for (const s of c.conflictingStates) {
      if (!existing.includes(s)) existing.push(s);
    }
    entityKeywords.set(c.entity, existing);
  }

  const lines = status.split('\n');
  const droppedIdx = new Set<number>();
  const reconciled: ReconciledEntity[] = [];

  const strictlyAfter = (a: LineTimestamp, b: LineTimestamp): boolean => {
    if (a.dayMs !== b.dayMs) return a.dayMs > b.dayMs;
    if (!a.hasTime || !b.hasTime) return false; // Précisions incomparables ou égalité
    return (a.timeMin ?? 0) > (b.timeMin ?? 0);
  };

  // knownEntities liste les formes longues avant les courtes (« myia-po-2024 »
  // avant « po-2024 ») : la réconciliation de la forme longue retire les lignes
  // avant que la forme courte ne les revoie — un seul marqueur par incident.
  for (const [entity, keywords] of entityKeywords) {
    const entityLower = entity.toLowerCase();
    const participating: Array<{ idx: number; ts: LineTimestamp }> = [];
    let blocked = false;
    for (let i = 0; i < lines.length; i++) {
      if (droppedIdx.has(i)) continue;
      const lower = lines[i].toLowerCase();
      if (!lower.includes(entityLower)) continue;
      if (!keywords.some(k => lower.includes(k.toLowerCase()))) continue;
      const ts = extractLineTimestamp(lines[i], keywords, refDayMs);
      if (ts === null) {
        blocked = true; // Tout-ou-rien : une ligne non datée bloque l'entité
        break;
      }
      participating.push({ idx: i, ts });
    }
    if (blocked || participating.length < 2) continue;

    const winners = participating.filter(w =>
      participating.every(l => l === w || strictlyAfter(w.ts, l.ts))
    );
    if (winners.length !== 1) continue; // Pas de gagnant unique strict : rien n'est effacé

    const winner = winners[0];
    const droppedLines: ReconciledEntity['droppedLines'] = [];
    for (const p of participating) {
      if (p === winner) continue;
      droppedIdx.add(p.idx);
      droppedLines.push({ line: lines[p.idx].trim(), timestamp: formatTimestamp(p.ts) });
    }
    reconciled.push({
      entity,
      keptLine: lines[winner.idx].trim(),
      keptTimestamp: formatTimestamp(winner.ts),
      droppedLines,
    });
  }

  if (droppedIdx.size === 0) return { status, reconciled: [] };
  return { status: lines.filter((_, i) => !droppedIdx.has(i)).join('\n'), reconciled };
}

/**
 * #3771: Strip terminal-state assertions on PR/issue numbers that the LLM condensation
 * has NO source for. The LLM has no API access to GitHub, but infers merge/close states
 * from lexical cues (discussion of OTHER merges, mentions of "doublon", "pas de nouvelle
 * PR"), and re-classifies open PRs as merged. 4 datapoints measured 2026-09-21 on
 * workspace-cluster-coordination, including an auto-contradiction in the same regenerated
 * status.
 *
 * The guard is a STRIPPER, not a fact-checker: it can only detect that a line asserts
 * a terminal state on a `#NNNN` token (PR or issue number), and verify whether SOME
 * source string (verbatim or its lowercased form) is present in `sources`. If not, the
 * line is removed and replaced with a `[unsourced state stripped #3771]` marker. The
 * downstream reader still sees the PR was discussed, just not falsely tagged MERGÉ.
 *
 * Pattern coverage:
 *  - `#NNNN : MERGÉ / FERMÉ / CLOSED / « Merge validé » / CLEAN / DONE+merged`
 *  - `Issue #NNNN : close / closed` (the #3 datapoint from Hermes)
 *  - `PR #NNNN : ...` followed by any terminal state keyword
 *
 * Whitelisted (kept): lines whose PR/issue number already appears in a source with a
 * matching terminal-state keyword, OR whose line is verbatim present in a source.
 *
 * @param llmOutput - The text produced by the LLM (status or summary).
 * @param sources   - The texts that WERE fed to the LLM (previousStatus, all messages
 *                    joined, etc.). Terminal-state assertions without a source hit are
 *                    stripped.
 * @returns Object with the scrubbed text + a count of stripped lines for telemetry.
 */
export function scrubFabricatedGitHubStates(
  llmOutput: string,
  sources: readonly string[]
): { scrubbed: string; stripped: number; strippedRefs: string[] } {
  // Build the lowercase source corpus ONCE.
  const sourceBag = sources.map(s => (s || '').toLowerCase()).join('\n');

  // Terminal-state keyword set. Keep case-preserving on the OUTPUT (we don't lowercase
  // the assertion, we only verify the SOURCE has some lowercase keyword near the same PR).
  // The source side is lowercased to do a fuzzy check.
  const TERMINAL_KEYWORDS = [
    'mergé', 'merged', 'merge validé', 'merge valide',
    'fermé', 'closed', 'close',
    'clean',
    'complété',
    'resolved',
  ];

  // Build a regex that matches a line asserting a terminal state on a PR/issue number.
  // Anchor on line start (`-` bullet OR beginning of line) to avoid catching prose like
  // "le merge de #17167" (which is not a state assertion). The PR/issue reference can
  // be PR/Issue #NNNN, or pull/issue #NNNN, optionally prefixed by an owner/repo
  // (e.g. "CoursIA #17167" or "owner/repo#17167" inside the bullet). The owner/repo
  // token is `[A-Za-z0-9_.-]+\s+` so we accept "CoursIA " (no slash) as well as
  // "owner/repo" (with slash).
  // Group 1: the PR/issue number digits (3-6).
  const STATE_REF_RE = /^[ \t]*(?:[-*]|\d+\.)\s+(?:[^*\n]*?)(?:PR|pull request|issue|issues|fix|prs|PRs)\s+(?:(?:[A-Za-z0-9_.-]+\s+)|(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\s*))?#(\d{3,6})([^*\n]*?)$/i;

  // Also catch the "#NNNN : state" inline pattern (no bullet) used in some condensed
  // summaries. This catches the case where the LLM wrote a sub-line "**#17167** : MERGÉ".
  // Note: the trailing capture is `[^(\n]{0,80}` to LIMIT the strip window to the immediate
  // assertion, NOT the comment context. Otherwise a line like "- **#17167** : OPEN /
  // HEAD d2e2035c (n'est pas MERGÉ, état erroné)" would be wrongly stripped because the
  // word "MERGÉ" appears in the parenthetical self-correction note.
  const INLINE_STATE_RE = /(?:^|\s)(?:#\d{3,6}|\b[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d{3,6})\s*[:\-—]\s*[A-Za-zÀ-ÿ][^(\n]{0,80}/g;

  const strippedRefs: string[] = [];
  let strippedCount = 0;

  const lines = llmOutput.split('\n');
  const outLines: string[] = [];
  for (const rawLine of lines) {
    const line = rawLine;
    const lower = line.toLowerCase();

    // #3771 review (po-2026, 22/09): markdown bold is the dominant idiom of our real
    // status sections ("Livrables récents", "Décisions actées") and neither regex above
    // can cross a `**` — the raw-line detection missed the majority of the live class.
    // Detection runs on a bold-free copy (detLine); emission keeps the ORIGINAL line.
    // detToOrig maps each detLine index back to its original index so the inline stage
    // can replace the exact original span.
    let detLine = '';
    const detToOrig: number[] = [];
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '*' && line[i + 1] === '*') { i++; continue; }
      detToOrig.push(i);
      detLine += line[i];
    }

    // Step 1: bullet-line assertions (PR #N / Issue #N …)
    const bulletMatch = detLine.match(STATE_REF_RE);
    if (bulletMatch) {
      // Group 1 = the PR/issue number digits (3-6), already validated by the regex.
      const refNum = bulletMatch[1];

      // Does the line mention any terminal keyword?
      const hasTerminal = TERMINAL_KEYWORDS.some(kw => lower.includes(kw.toLowerCase()));

      if (hasTerminal && refNum) {
        // Sourcing: does ANY source contain (a) the same PR ref number and (b) a
        // terminal-state keyword in the same vicinity (≤200 chars)?
        const sourced = isRefSourced(refNum, sourceBag);
        if (!sourced) {
          strippedCount++;
          strippedRefs.push(refNum);
          // Replace the stripped line with a marker so the cycle is auditable, but
          // don't carry the false state forward. The original line is preserved as a
          // comment-like marker, prefixed by `- ` so it stays a valid bullet but
          // visually flagged as audit-only (no longer load-bearing as a state claim).
          outLines.push(`- [unsourced state stripped #3771] ${line.trim().replace(/^[-*]\s+/, '')}`);
          continue;
        }
      }
    }

    // Step 2: inline "#NNNN : STATE" pattern (no bullet prefix) — strip if unsourced.
    // We only act if a terminal keyword is present. Detection runs on detLine; the
    // strip is applied to the ORIGINAL line at the mapped span.
    const inlineMatches = [...detLine.matchAll(INLINE_STATE_RE)];
    if (inlineMatches.length > 0) {
      const spans: Array<[number, number]> = []; // [origStart, origEndExclusive)
      for (const m of inlineMatches) {
        const fullMatch = m[0];
        const lowerMatch = fullMatch.toLowerCase();
        const hasTerminal = TERMINAL_KEYWORDS.some(kw => lowerMatch.includes(kw.toLowerCase()));
        if (!hasTerminal) continue;

        // Pull the #NNN out of the match.
        const numMatch = fullMatch.match(/#(\d{3,6})/);
        if (!numMatch) continue;
        const refNum = numMatch[1];

        const sourced = isRefSourced(refNum, sourceBag);
        if (!sourced) {
          strippedCount++;
          strippedRefs.push(refNum);
          // Map the detLine match back to its original span (right-to-left below).
          const start = detToOrig[m.index];
          const end = detToOrig[m.index + fullMatch.length - 1] + 1;
          spans.push([start, end]);
        }
      }
      if (spans.length > 0) {
        // Replace right-to-left so earlier spans' indices stay valid.
        spans.sort((a, b) => b[0] - a[0]);
        let modifiedLine = line;
        for (const [start, end] of spans) {
          modifiedLine = modifiedLine.slice(0, start) + '[unsourced #3771]' + modifiedLine.slice(end);
        }
        outLines.push(modifiedLine);
        continue;
      }
    }

    outLines.push(line);
  }

  return {
    scrubbed: outLines.join('\n'),
    stripped: strippedCount,
    strippedRefs,
  };
}

/**
 * Helper for #3771 guardrail: given a PR/issue number (digits only) and a pre-lowercased
 * source corpus, does the corpus contain the number AND a terminal-state keyword
 * WITHIN THE SAME PARAGRAPH (line) as the number?
 *
 * "Same paragraph" matters: a ±200 char window around the first occurrence is too
 * generous when sources are short — a terminal keyword from a DIFFERENT PR's line
 * will pollute the context. We split sources into lines/paragraphs and check ONLY
 * within the line(s) that contain the refNum.
 *
 * Substring false positive: looking for "200" must not match "12000" — guarded by
 * negative lookbehind/lookahead for digits.
 */
function isRefSourced(refNum: string, lowerSourceBag: string): boolean {
  if (!lowerSourceBag) return false;

  // Build the search regex with digit boundary anchors.
  const refRegex = new RegExp(`(?<![\\d])${refNum}(?![\\d])`);
  const TERMINAL_KEYWORDS_LOWER = [
    'mergé', 'merged', 'merge validé', 'merge valide',
    'fermé', 'closed', 'close',
    'clean',
    'complété',
    'resolved',
  ];

  // Split sources into lines (paragraphs are joined by \n in sourceBag). We check
  // ONLY the line(s) that contain a non-substring occurrence of refNum — adjacent
  // lines are NOT pulled into the context.
  const lines = lowerSourceBag.split('\n');
  for (const line of lines) {
    if (!refRegex.test(line)) continue;
    if (TERMINAL_KEYWORDS_LOWER.some(kw => line.includes(kw))) {
      return true;
    }
  }
  return false;
}

/**
 * #1792: Truncation fallback when LLM condensation is unavailable (circuit breaker
 * open or LLM call failed). Keeps the last `keepCount` messages, archives the rest
 * with a simple template summary (no LLM). Prevents dashboard from growing unbounded
 * during LLM outages.
 */
/**
 * Deterministic (non-LLM) truncation: keeps the most recent lines that fit within maxSizeBytes.
 * Used when LLM condensation fails (#2463 — status should never exceed its cap, even in fallback).
 */
export function truncateToMaxSize(text: string, maxSizeBytes: number, label: string): string {
  const sizeBytes = Buffer.byteLength(text, 'utf8');
  if (sizeBytes <= maxSizeBytes) return text;

  const lines = text.split('\n');
  // Keep lines from the end (most recent) until we fit
  let result = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    const candidate = lines.slice(i).join('\n');
    if (Buffer.byteLength(candidate, 'utf8') > maxSizeBytes) break;
    result = candidate;
  }

  // #2463: If even the last single line exceeds the cap (e.g. a single long line),
  // hard-truncate it by character count (UTF-8 safe: worst case 4 bytes/char).
  if (!result) {
    const lastLine = lines[lines.length - 1] || '';
    const maxChars = Math.floor(maxSizeBytes / 2); // safe for any UTF-8 (2 bytes min for supplementary)
    result = lastLine.length > maxChars
      ? lastLine.slice(-maxChars)
      : lastLine;
  }

  const truncated = result;
  logger.info(`Deterministic truncation applied to ${label}`, {
    originalBytes: sizeBytes,
    truncatedBytes: Buffer.byteLength(truncated, 'utf8'),
    limitBytes: maxSizeBytes,
    linesRemoved: lines.length - truncated.split('\n').length,
  });

  return truncated;
}

/**
 * #2719 (web1 c.450 §3, mesuré 14/09): sentinel prefix of the persistent Status-block
 * marker. Its job is to be findable where the truncation is *read*, and strippable so a
 * single marker always describes the LATEST pass (never an accumulation).
 */
const STATUS_FALLBACK_MARKER_PREFIX = '> [!WARNING] **lastCondense: fallback-truncated**';

/**
 * #2719 (web1 c.450 §3): the truncation notice lives in the intercom, which is
 * ephemeral BY CONSTRUCTION — the next condensation archives it, and when the LLM
 * stays down it archives it *by truncation*, with no successor. Measured on
 * `workspace-roo-extensions` (14/09): the `## Status` block — the surface the rules
 * designate as the primary read — carried ZERO occurrence of "truncation|fallback"
 * after two fallback archives. A Status-only reader could not tell a hole had been
 * dug. This stamps the outcome into the Status itself.
 *
 * Self-clearing by design: the next SUCCESSFUL pass regenerates the status from the
 * LLM and the marker is gone; an explicit `update` replaces the section too. Only a
 * repeat truncation re-stamps it (after stripping the previous one), so the block
 * never accumulates stale markers.
 *
 * `truncateToMaxSize` keeps lines from the **end**, so the marker must be prepended
 * AFTER truncation — hence the caller reserves `markerBytes` out of the cap rather
 * than truncating to the full budget (#2463's ≤15 KB invariant is preserved for the
 * whole block, marker included).
 */
export function buildStatusFallbackMarker(
  now: string,
  archivedCount: number,
  legs: { primary: string; cloud: string },
): string {
  const breaker = `${condenseCB.consecutiveFailures}/${CONDENSE_CB_OPEN_THRESHOLD}`
    + (condenseCB.isOpen ? ' OPEN' : '');
  // Both legs are named, each bounded independently: appending the cloud discriminant
  // AFTER a bounded primary would let a long primary error (a 502 HTML page) truncate
  // away the very field that separates "cloud unconfigured" from "cloud rejected".
  return `${STATUS_FALLBACK_MARKER_PREFIX} @${now} — ${archivedCount} message`
    + `${archivedCount === 1 ? '' : 's'} archived without LLM summary`
    + ` (breaker ${breaker}; primary: ${truncateError(legs.primary || 'failed')}`
    + `; cloud: ${truncateError(legs.cloud)})`;
}

/**
 * Remove a previously stamped truncation marker so at most one survives. Line-anchored
 * on the sentinel, so LLM prose quoting the phrase is not mistaken for a marker.
 */
export function stripStatusFallbackMarker(text: string): string {
  return text
    .split('\n')
    .filter(line => !line.startsWith(STATUS_FALLBACK_MARKER_PREFIX))
    .join('\n');
}

async function executeTruncationFallback(
  key: string,
  dashboard: Dashboard,
  toArchive: IntercomMessage[],
  toKeep: IntercomMessage[],
  diagnostic: CondenseAttemptInfo | undefined,
  condensationStart: number,
  failedCalls?: { statusCall?: LLMCallResult; summaryCall?: LLMCallResult }
): Promise<Dashboard> {
  const now = new Date().toISOString();
  const fallbackSummary = `[FALLBACK TRUNCATION] ${toArchive.length} messages archived without LLM summary.`
    + ` Circuit breaker failures: ${condenseCB.consecutiveFailures}.`
    + (condenseCB.isOpen ? ` Circuit breaker OPEN (resets after ${Math.round(CONDENSE_CB_RESET_TTL_MS / 60000)}min).` : '');

  // Write archive file with template summary
  const archiveDir = getArchiveDir();
  ensureStoreSubdir(getSharedStatePath(), 'dashboards', 'archive');
  const dateStr = now.replace(/[:.]/g, '-').substring(0, 19);
  const archivePath = path.join(archiveDir, `${key}-${dateStr}-fallback.md`);

  // #2719 (2026-09-03, web1 meta-analysis + po-2024 investigation): the fallback
  // archive frontmatter carried no machine identity and no cloud-fallback outcome,
  // making fleet datapoints unattributable — 5 truncation archives could not be
  // tied to a machine, and "cloud attempted but rejected" was indistinguishable
  // from "cloud never configured in that process". condensedBy + fallbackError
  // close both gaps; the archive alone now answers who truncated and why.
  //
  // #2719 discriminant fix (2026-09-19, po-2024 spec — po-2027 datapoint 2026-09-07):
  // the discriminator below was built exclusively on `fallbackAttempted`, which is
  // stamped ONLY on a failed cloud attempt. Three distinct states therefore collapsed
  // into 'not-attempted-or-unconfigured': (1) cloud genuinely unconfigured,
  // (2) cloud answered 200 with EMPTY content (was a silent null, now stamped as
  // an 'empty-content' error upstream), (3) cloud SUCCEEDED on the other call of
  // the same pass (`fallbackUsed` never entered the disambiguation — the po-2027
  // archive said "not attempted" while gpt-5-mini had just salvaged the summary).
  // The `fallbackUsed` branch closes (3); the upstream empty-content stamping closes (2).
  const fbStats = [failedCalls?.summaryCall?.stats, failedCalls?.statusCall?.stats];
  const fbErrorCaptured = fbStats.find(s => s?.fallbackAttempted && s.fallbackError);
  const fallbackError = fbErrorCaptured?.fallbackError
    ? truncateError(fbErrorCaptured.fallbackError)
    : fbStats.some(s => s?.fallbackAttempted) ? 'attempted-no-error-captured'
    : fbStats.some(s => s?.fallbackUsed) ? 'no-fallback-failure-captured'
    : 'not-attempted-or-unconfigured';

  const archiveFrontmatter = yaml.dump({
    type: 'archive',
    originalKey: key,
    archivedAt: now,
    messageCount: toArchive.length,
    llmGenerated: false,
    fallbackTruncation: true,
    circuitBreakerOpen: condenseCB.isOpen,
    condensedBy: process.env.ROOSYNC_MACHINE_ID || 'unknown',
    fallbackError,
  });

  const archiveMessages = toArchive.map(msg => {
    return `### [${msg.timestamp}] ${msg.author.machineId}|${msg.author.workspace}\n\n${msg.content}`;
  }).join('\n\n---\n\n');

  const archiveContent = `---
${archiveFrontmatter.trim()}
---

# Archive (fallback): ${key}

Archived: ${now}
Messages: ${toArchive.length}
Method: Truncation fallback (LLM unavailable)

${fallbackSummary}

---

${archiveMessages}
`;

  await fs.writeFile(archivePath, archiveContent, 'utf8');
  logger.info('Fallback truncation archive written', { key, count: toArchive.length, archivePath });

  // #2825 (volet A / G5+G6): write a synthetic "task" mirroring the archive content
  // into the first detected Roo storage location, so the existing background indexer
  // (startSkeletonRefreshWorker, see background-services.ts ~L460) picks it up on its
  // next scan and emits a `chunk_type: 'task_summary'` chunk in Qdrant. The archive
  // .md stays as a human-readable artifact; the synthetic task is what makes the
  // summary searchable. Best-effort: any failure here is logged but does not abort
  // the condensation flow (the archive file is the source of truth for humans).
  try {
    const syntheticTaskId = `_cond-${key.replace(/[^a-zA-Z0-9_-]/g, '_')}-${now.replace(/[:.]/g, '-').substring(0, 19)}`;
    const { RooStorageDetector } = await import('../../utils/roo-storage-detector.js');
    const locations = await RooStorageDetector.detectStorageLocations();
    if (locations.length > 0) {
      const syntheticDir = path.join(locations[0], 'tasks', syntheticTaskId);
      // #2828 nit 3: log the resolved path BEFORE writing so a stale/read-only
      // location is debuggable even if mkdir/writeFile silently fail.
      logger.info('Condensation synthetic task resolving', {
        key,
        syntheticTaskId,
        syntheticDir,
        storageLocation: locations[0],
      });
      await fs.mkdir(syntheticDir, { recursive: true });
      // task_metadata.json — mirrors the contract expected by RooStorageDetector.analyzeConversation
      const metadata = {
        taskId: syntheticTaskId,
        title: `[Condensation summary] ${key}`,
        workspace: 'system',
        parent_task_id: null,
        root_task_id: null,
        source: 'condensation-fallback',
        condensation: {
          originalDashboardKey: key,
          messageCount: toArchive.length,
          fallbackTruncation: true,
          circuitBreakerOpen: condenseCB.isOpen,
          archivePath: archivePath,
        },
        // Synthetic message count = 1 (the summary itself).
        messageCount: 1,
        actionCount: 0,
        createdAt: now,
        lastActivity: now,
      };
      await fs.writeFile(
        path.join(syntheticDir, 'task_metadata.json'),
        JSON.stringify(metadata, null, 2),
        'utf8'
      );
      // api_conversation_history.json — single user/assistant exchange carrying the
      // archive content. The user message is "[ARCHIVED CONTENT]" + summary metadata;
      // the assistant message is the full archived body so ChunkExtractor indexes
      // every archived message verbatim (no truncation, no summary lossy transform).
      const apiHistory = [
        {
          role: 'user',
          content: `[CONDENSATION ARCHIVE] ${toArchive.length} messages from dashboard '${key}' archived via fallback (circuit breaker ${condenseCB.isOpen ? 'OPEN' : 'CLOSED'}). See archive path for full text.`,
          timestamp: now,
        },
        {
          role: 'assistant',
          // #2825 (G5): the assistant message is the FULL fallback summary + the
          // archive body verbatim — the indexer will split this into multiple chunks
          // (splitChunk, MAX_CHUNK_SIZE=800) but never truncate it.
          content: `${fallbackSummary}\n\n---\n\n${archiveMessages}`,
          timestamp: now,
        },
      ];
      await fs.writeFile(
        path.join(syntheticDir, 'api_conversation_history.json'),
        JSON.stringify(apiHistory, null, 2),
        'utf8'
      );
      logger.info('Condensation synthetic task written', {
        key,
        syntheticTaskId,
        syntheticDir,
        archivedMessageCount: toArchive.length,
      });
    } else {
      logger.warn('No Roo storage location detected — condensation synthetic task skipped', { key });
    }
  } catch (syntheticErr) {
    logger.warn('Failed to write condensation synthetic task (non-fatal)', {
      key,
      error: syntheticErr instanceof Error ? syntheticErr.message : String(syntheticErr),
    });
  }

  // Build system notice message
  const totalElapsed = Date.now() - condensationStart;
  let errorDetail = '';
  if (failedCalls) {
    // Surface the EXPLICIT cause (HTTP status / timeout+endpoint), not just the outcome
    // label — user mandate 2026-06-01: no opaque "timeout" without what's behind it.
    const fmtFail = (label: string, c?: LLMCallResult): string => {
      if (!c) return '';
      const st = c.stats;
      if (st.finalOutcome === 'ok') return `${label}: ok.\n`;
      const why = st.lastError ? ` — ${st.lastError}` : '';
      return `${label}: ${st.finalOutcome} (${st.attempts} attempt${st.attempts === 1 ? '' : 's'}, ${Math.round(st.elapsedMs / 1000)}s)${why}\n`;
    };
    errorDetail = fmtFail('Status', failedCalls.statusCall) + fmtFail('Summary', failedCalls.summaryCall);
  }

  const noticeMessage: IntercomMessage = {
    id: generateMessageId('system', 'system'),
    timestamp: now,
    author: { machineId: 'system', workspace: 'system' },
    content: `**[WARN] FALLBACK TRUNCATION** - ${now}\n\n`
      + `${toArchive.length} messages archived without LLM summary (truncation fallback).\n`
      + `${toKeep.length} messages retained.\n`
      + `${errorDetail}`
      + `Circuit breaker: ${condenseCB.consecutiveFailures}/${CONDENSE_CB_OPEN_THRESHOLD} failures`
      + (condenseCB.isOpen ? ' (OPEN)' : '') + '.\n'
      + `Duration: ${Math.round(totalElapsed / 1000)}s\n`
      + `Archive: \`archive/${path.basename(archivePath)}\``
  };

  if (diagnostic) {
    diagnostic.outcome = 'fallback-truncated';
    diagnostic.elapsedMs = totalElapsed;
    diagnostic.archivedMessageCount = toArchive.length;
    // #2998: Surface LLM stats (including fallbackAttempted/fallbackError) in the
    // truncation diagnostic so operators can distinguish "fallback unconfigured"
    // from "fallback attempted but rejected" — not just "LLM failed → truncated".
    if (failedCalls) {
      diagnostic.llm = {
        summary: failedCalls.summaryCall?.stats,
        status: failedCalls.statusCall?.stats,
      };
    }
  }

  // #2463: Deterministic status truncation — never let status exceed its cap,
  // even when LLM is unavailable (the exact scenario where truncation matters most).
  // #2719 (web1 c.450 §3): the budget is reduced by the marker's own size so the
  // ≤15 KB invariant holds for the WHOLE block, marker included. The previous
  // marker is stripped first: at most one must survive, describing the latest pass.
  const statusMarker = buildStatusFallbackMarker(now, toArchive.length, {
    primary: errorDetail.replace(/\s*\n\s*/g, ' ').trim(),
    // The same discriminant the archive frontmatter carries (empty-content /
    // attempted-no-error-captured / no-fallback-failure-captured / unconfigured),
    // so the Status line and the archive cannot disagree about the cloud leg.
    cloud: fallbackError,
  });
  const markerBytes = Buffer.byteLength(statusMarker + '\n', 'utf8');
  const truncatedStatus = truncateToMaxSize(
    stripStatusFallbackMarker(dashboard.status.markdown),
    Math.max(0, MAX_STATUS_SIZE_BYTES - markerBytes),
    'Status (fallback)'
  );

  return {
    ...dashboard,
    status: { ...dashboard.status, markdown: `${statusMarker}\n${truncatedStatus}` },
    lastModified: now,
    intercom: {
      messages: [noticeMessage, ...toKeep],
      totalMessages: dashboard.intercom.totalMessages,
      lastCondensedAt: now,
    },
  };
}

/**
 * #2598: Compute how many of the most-recent intercom messages to retain when
 * condensing, based on a byte budget rather than a fixed count. Walks from the
 * newest message backward, accumulating UTF-8 byte size, and keeps messages
 * while under `budgetBytes` — but never fewer than `minKeep` and never more than
 * `maxKeep` (default CONDENSE_KEEP). This is always <= the old fixed keep: for
 * small messages it keeps up to `maxKeep` (unchanged behaviour); for large
 * messages it keeps fewer, capping the intercom contribution to the
 * post-condense size floor and preventing the perpetual re-condensation loop.
 */
export function computeKeepCount(
  messages: Pick<IntercomMessage, 'content'>[],
  maxKeep: number = CONDENSE_KEEP,
  budgetBytes: number = KEEP_INTERCOM_BUDGET_BYTES,
  minKeep: number = CONDENSE_KEEP_MIN
): number {
  const n = messages.length;
  if (n === 0) return 0;
  const minK = Math.min(minKeep, n);
  let bytes = 0;
  let kept = 0;
  for (let i = n - 1; i >= 0 && kept < maxKeep; i--) {
    const msgBytes = Buffer.byteLength(messages[i].content || '', 'utf8');
    // Past the guaranteed minimum, stop before exceeding the byte budget.
    if (kept >= minK && bytes + msgBytes > budgetBytes) break;
    bytes += msgBytes;
    kept++;
  }
  return kept;
}

/**
 * Condense les messages intercom : archive les anciens, conserve les récents.
 * Met à jour le statut avec les informations des messages archivés (#858 Phase 2).
 * Si le statut ou le résumé dépasse les limites de taille, auto-condense via LLM.
 * Retourne le dashboard condensé.
 */
async function condenseIntercom(
  key: string,
  dashboard: Dashboard,
  keepCount: number,
  diagnostic?: CondenseAttemptInfo
): Promise<Dashboard> {
  const condensationStart = Date.now();
  const messages = dashboard.intercom.messages;
  if (messages.length <= keepCount) {
    if (diagnostic) {
      diagnostic.outcome = 'no-op';
      diagnostic.elapsedMs = Date.now() - condensationStart;
      diagnostic.archivedMessageCount = 0;
    }
    return dashboard; // Rien à condenser
  }

  // #3584 (volet rétention) — masquer AVANT toute dérivation. Les messages écrits
  // avant le garde de publication (#1144, posé dans writeDashboardFile) n'ont
  // jamais traversé la frontière ; or TOUS les dérivés de la condensation partent
  // de ces valeurs : prompts LLM (generateStatusUpdate / generateLLMSummary — le
  // secret ne doit pas transiter vers le provider, limite 2 de #1144), archives
  // des chemins succès ET fallback — écrites par fs.writeFile direct, hors
  // writeDashboardFile (limite 3) —, tâche synthétique Qdrant du fallback, et
  // intercom réécrit au retour (auto-nettoyage du dashboard vivant au premier
  // cycle qui suit une fuite).
  const safeMessages = redactMessagesForPublication(key, messages);
  const previousStatus = maskSecretText(dashboard.status.markdown);

  const toArchive = safeMessages.slice(0, safeMessages.length - keepCount);
  const toKeep = safeMessages.slice(safeMessages.length - keepCount);

  // #1792: If circuit breaker is open, skip the PRIMARY LLM calls.
  // #2719 (22/09): ...but not the cloud tier. The breaker measures the primary; skipping
  // the fallback with it made every sustained primary outage — exactly when the fallback
  // is needed — end in truncation (archives stamped 'not-attempted-or-unconfigured').
  const primaryCircuitOpen = condenseCBShouldBypass();
  if (primaryCircuitOpen) {
    logger.info('Condensation circuit breaker OPEN — primary skipped, trying cloud tier before truncation', {
      key,
      toArchive: toArchive.length,
      toKeep: toKeep.length,
    });
  }

  // #1497: Run the 2 LLM calls in parallel (status update + summary) — they are
  // independent (both take messages as input, neither depends on the other's
  // output). Halves wall-clock latency from ~2×T to ~T, critical when condense
  // races the client timeout. A single failing call still cancels condensation
  // via the existing null-check below.
  const tParallel = Date.now();
  const [statusCall, summaryCall] = await Promise.all([
    generateStatusUpdate(previousStatus, safeMessages, toArchive.length, key, { skipPrimary: primaryCircuitOpen }),
    generateLLMSummary(toArchive, { skipPrimary: primaryCircuitOpen })
  ]);
  if (diagnostic) {
    diagnostic.llm = { summary: summaryCall.stats, status: statusCall.stats };
  }
  let newStatus = statusCall.content;
  let llmSummary = summaryCall.content;
  const tParallelElapsed = Date.now() - tParallel;
  logger.info('LLM calls completed (parallel)', {
    elapsed: `${tParallelElapsed}ms`,
    statusOk: newStatus !== null,
    summaryOk: llmSummary !== null,
    statusOutcome: statusCall.stats.finalOutcome,
    summaryOutcome: summaryCall.stats.finalOutcome
  });

  // Both LLM calls are MANDATORY — if either fails, use truncation fallback
  if (!llmSummary || !newStatus) {
    logger.warn('LLM call failed, using truncation fallback (#1792)', {
      key,
      messageCount: toArchive.length,
      summaryOk: !!llmSummary,
      statusOk: !!newStatus,
      summaryOutcome: summaryCall.stats.finalOutcome,
      statusOutcome: statusCall.stats.finalOutcome
    });
    // The breaker tracks the primary: a pass that never called it records nothing.
    if (!primaryCircuitOpen) condenseCBRecordFailure();
    return executeTruncationFallback(
      key, dashboard, toArchive, toKeep, diagnostic, condensationStart,
      { statusCall, summaryCall }
    );
  }

  // LLM succeeded — reset circuit breaker (only a pass that exercised the primary
  // can vouch for it; a cloud-only pass leaves the breaker to its half-open timer).
  if (!primaryCircuitOpen) condenseCBRecordSuccess();

  // Both operations succeeded — now auto-condense if outputs exceed size limits
  newStatus = await condenseTextIfTooLarge(newStatus, MAX_STATUS_SIZE_BYTES, 'Status');
  llmSummary = await condenseTextIfTooLarge(llmSummary, MAX_SUMMARY_SIZE_BYTES, 'Summary');

  // #3771: Post-LLM guardrail — the LLM has no GitHub API access and has been measured
  // fabricating terminal states (MERGÉ/CLOSED/« Merge validé ») for PR/issue numbers
  // that were OPEN. Strip any line that asserts a terminal state on a #NNNN token without
  // verbatim sourcing in the messages or previous status.
  {
      const statusScrub = scrubFabricatedGitHubStates(newStatus, [previousStatus, ...safeMessages.map(m => m.content)]);
      const summaryScrub = scrubFabricatedGitHubStates(llmSummary, [previousStatus, ...safeMessages.map(m => m.content)]);
      const totalStripped = statusScrub.stripped + summaryScrub.stripped;
      if (totalStripped > 0) {
        logger.warn('Stripped fabricated GitHub terminal-state assertions (#3771)', {
          key,
          strippedStatus: statusScrub.stripped,
          strippedSummary: summaryScrub.stripped,
          strippedRefs: [...statusScrub.strippedRefs, ...summaryScrub.strippedRefs],
        });
      }
      newStatus = statusScrub.scrubbed;
      llmSummary = summaryScrub.scrubbed;
    }

  // #1502: Detect contradictions in generated status before committing.
  // #3329 (RECIDIVE): the previous guard appended HTML comment markers but
  // never stripped them on the next cycle, so they accumulated (7 entities ×
  // 2 cycles = 14 lines in workspace status, 3 in global). This is the
  // minimal dedup + branchement: strip stale markers before re-emitting so
  // each cycle's status carries exactly one fresh marker per conflicting
  // entity, and escalate to logger.error so the existing guard is no
  // longer a silent journal.
  // #3803 (RX38, 24/09): après détection, réconciliation déterministe — quand
  // toutes les lignes contradictoires d'une entité portent un horodatage
  // comparable, le dernier état daté gagne et les lignes plus anciennes sont
  // retirées. Sans horodatage comparable, RIEN n'est effacé et le marqueur
  // #1502 reste émis (règle approuvée par le user, arbitrage RX38).
  newStatus = newStatus!.replace(/^[ \t]*<!-- #1502 CONTRADICTION:.*-->[ \t]*\n?/gm, '').trimEnd();
  newStatus = newStatus!.replace(/^[ \t]*<!-- #3803 RECONCILED:.*-->[ \t]*\n?/gm, '').trimEnd();
  let detectedContradictions = detectStatusContradictions(newStatus!);
  let reconciledMarkers: string[] = [];
  if (detectedContradictions.length > 0) {
    const reconciliation = reconcileStatusContradictions(newStatus!, detectedContradictions);
    if (reconciliation.reconciled.length > 0) {
      logger.warn('Status contradictions reconciled — latest dated state wins (#3803)', {
        key,
        reconciled: reconciliation.reconciled.map(r =>
          `${r.entity}: kept ${r.keptTimestamp}, dropped ${r.droppedLines.length} older line(s)`
        ),
      });
      newStatus = reconciliation.status;
      detectedContradictions = detectStatusContradictions(newStatus);
      const snippet = (s: string) =>
        s.replace(/\s+/g, ' ').slice(0, 100).replace(/--+/g, '—').replace(/>/g, '');
      reconciledMarkers = reconciliation.reconciled.map(r =>
        `<!-- #3803 RECONCILED: ${r.entity} kept «${snippet(r.keptLine)}» (${r.keptTimestamp}) — dropped ${r.droppedLines.length} older contradictory line(s): ${r.droppedLines.slice(0, 2).map(d => `«${snippet(d.line)}» (${d.timestamp})`).join(' ; ')} -->`
      );
    }
  }
  if (detectedContradictions.length > 0) {
    logger.error('Status contradictions detected after LLM generation (#1502/#3329)', {
      contradictionCount: detectedContradictions.length,
      contradictions: detectedContradictions.map(c => `${c.entity}: ${c.conflictingStates.join(' vs ')}`)
    });
    // Append HTML comment markers for visibility to next readers
    const warningLines = detectedContradictions.map(c =>
      `<!-- #1502 CONTRADICTION: ${c.entity} has conflicting states: ${c.conflictingStates.join(' vs ')} -->`
    ).join('\n');
    newStatus = newStatus + '\n\n' + warningLines;
  }
  if (reconciledMarkers.length > 0) {
    newStatus = newStatus + '\n\n' + reconciledMarkers.join('\n');
  }

  const statusUpdated = true;

  // Archiver les anciens messages (format Markdown)
  const archiveDir = getArchiveDir();
  ensureStoreSubdir(getSharedStatePath(), 'dashboards', 'archive');
  const dateStr = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
  const archivePath = path.join(archiveDir, `${key}-${dateStr}.md`);

  // Construire le contenu markdown de l'archive
  const archiveFrontmatter = yaml.dump({
    type: 'archive',
    originalKey: key,
    archivedAt: new Date().toISOString(),
    messageCount: toArchive.length,
    llmGenerated: !!llmSummary,
    statusUpdated
  });

  const archiveMessages = toArchive.map(msg => {
    return `### [${msg.timestamp}] ${msg.author.machineId}|${msg.author.workspace}\n\n${msg.content}`;
  }).join('\n\n---\n\n');

  const archiveContent = `---
${archiveFrontmatter.trim()}
---

# Archive : ${key}

Archivé le : ${new Date().toISOString()}
Messages : ${toArchive.length}

---

${archiveMessages}
`;

  await fs.writeFile(archivePath, archiveContent, 'utf8');
  logger.info('Messages archivés', { key, count: toArchive.length, archivePath });

  // Créer les messages système de condensation
  const now = new Date().toISOString();
  const systemMessages: IntercomMessage[] = [];

  // Ajouter le résumé LLM si disponible (#858)
  if (llmSummary) {
    const summaryMessage: IntercomMessage = {
      id: generateMessageId('system', 'system'),
      timestamp: now,
      author: {
        machineId: 'system',
        workspace: 'system'
      },
      content: `**CONDENSATION-SUMMARY** - ${now}\n\n${llmSummary}`
    };
    systemMessages.push(summaryMessage);
    logger.info('LLM summary added to dashboard', { summaryLength: llmSummary.length });
  } else {
    logger.info('LLM summary failed, but status updated - proceeding with archive', { archivedCount: toArchive.length });
  }

  const statusSizeBytes = Buffer.byteLength(newStatus!, 'utf8');
  const summarySizeBytes = Buffer.byteLength(llmSummary ?? '', 'utf8');
  logger.info('Status updated from archived messages', {
    previousLength: previousStatus.length,
    newLength: newStatus!.length,
    statusSizeKB: `${(statusSizeBytes / 1024).toFixed(1)}KB`,
    summarySizeKB: `${(summarySizeBytes / 1024).toFixed(1)}KB`
  });

  // Ajouter le message de condensation standard avec timing et tailles
  // #2719 (ask CoursIA 25/09 20:10Z, dispatch ai-01 26/09) : le notice ne doit
  // plus revendiquer « résumé LLM généré » quel que soit le résultat. Les chemins
  // qui atteignent ce bloc ont toujours un résumé (le garde !llmSummary dévie vers
  // executeTruncationFallback, qui poste son propre [WARN] FALLBACK TRUNCATION) —
  // mais la provenance compte : un résumé sauvé par le fallback cloud est un
  // résultat dégradé, pas un succès primaire. La branche sans résumé reste
  // défensive : elle nomme l'archive au lieu de mentir avec 0.0KB.
  const summaryViaCloud = summaryCall.stats.fallbackUsed === true;
  // #2719 review follow-up (ai-01, #1233 non-blocking): the notice must carry the
  // same algebra as the outcome below — a STATUS leg salvaged by the cloud fallback
  // makes the pass `fallback-cloud` even when the summary came from the primary.
  // Qualify the status line with its own provenance so the two surfaces agree.
  const statusViaCloud = statusCall.stats.fallbackUsed === true;
  const summaryClause = !llmSummary
    ? `RÉSUMÉ ABSENT (échec LLM) — messages archivés SANS résumé : \`archive/${path.basename(archivePath)}\``
    : summaryViaCloud
      ? `résumé généré via fallback cloud (${(summarySizeBytes / 1024).toFixed(1)}KB, modèle primaire en échec)`
      : `résumé LLM généré (${(summarySizeBytes / 1024).toFixed(1)}KB)`;
  const totalElapsed = Date.now() - condensationStart;
  const condenseNotice: IntercomMessage = {
    id: generateMessageId('system', 'system'),
    timestamp: now,
    author: {
      machineId: 'system',
      workspace: 'system'
    },
    content: `**CONDENSATION** - ${now}\n\n${toArchive.length} messages archivés dans \`archive/${path.basename(archivePath)}\`\n${toKeep.length} messages conservés (plus récents)\nStatut mis à jour${statusViaCloud ? ' via fallback cloud' : ''} (${(statusSizeBytes / 1024).toFixed(1)}KB), ${summaryClause}\nDurée: ${Math.round(totalElapsed / 1000)}s (status + summary parallèle: ${Math.round(tParallelElapsed / 1000)}s)`
  };
  systemMessages.push(condenseNotice);

  logger.info('Condensation completed', { totalElapsed: `${totalElapsed}ms` });

  if (diagnostic) {
    // #2719: distinguish a condensation salvaged by the cloud fallback (primary
    // vLLM down, z.ai glm-4.7-flash succeeded) from a clean primary success, so
    // operators can see "cloud saved it" without drilling into llm.stats.fallbackUsed.
    const usedFallback = statusCall.stats.fallbackUsed === true
      || summaryCall.stats.fallbackUsed === true;
    diagnostic.outcome = usedFallback ? 'fallback-cloud' : 'condensed';
    diagnostic.elapsedMs = totalElapsed;
    diagnostic.archivedMessageCount = toArchive.length;
  }

  return {
    ...dashboard,
    lastModified: now,
    status: {
      ...dashboard.status,
      markdown: newStatus!
    },
    intercom: {
      messages: [...systemMessages, ...toKeep],
      totalMessages: dashboard.intercom.totalMessages,
      lastCondensedAt: now
    }
  };
}

// === Handler principal ===

/**
 * Résumé d'un dashboard (pour action=list)
 */
export interface DashboardSummary {
  key: string;
  type: string;
  lastModified: string;
  lastModifiedBy: Author;
  messageCount: number;
  statusLength: number;
  intercomLength?: number;
  totalLength?: number;
  utilizationPct?: number;
}

/** Echo of effective request parameters (after defaults applied) */
export interface DashboardRequestEcho {
  action: string;
  type?: string;
  machineId?: string;
  workspace?: string;
  section?: string | null;
  intercomLimit?: number | null;
}

/** Size metrics for dashboard content */
export interface DashboardSizes {
  statusLength: number;
  intercomLength: number;
  totalLength: number;
  /**
   * #3174 defect 5 — the threshold that STRIKES FIRST. The preemptive condense
   * (the LLM pass that bills minutes to the in-flight append) fires here, not at
   * the hard cap; the field previously reported the cap, describing no observable
   * event. utilizationPct keeps the hard cap as denominator, so the exact point
   * where condensation starts reads 92.0% — arithmetically consistent with this
   * field (47104/51200).
   */
  condensationThreshold: number;
  /** The hard ceiling behind the preemptive threshold (MAX_DASHBOARD_SIZE_BYTES). */
  hardCapBytes: number;
  utilizationPct: number;
}

/**
 * Résultat de l'outil roosync_dashboard
 */
export interface DashboardResult {
  success: boolean;
  action: string;
  key: string;
  type: string;
  request?: DashboardRequestEcho;
  sizes?: DashboardSizes;
  data?: Partial<Dashboard>;
  messageCount?: number;
  condensed?: boolean;
  archivedCount?: number;
  /**
   * #2719 (ask CoursIA 25/09 20:10Z, dispatch ai-01 26/09) — true when a
   * condensation pass archived messages WITHOUT any LLM summary (truncation
   * fallback). `condensed: true` alone reads as success; this field exposes
   * the summary loss at the top level for consumers that don't drill into
   * condenseDiagnostic. Deliberately absent (not false) on clean passes to
   * keep the historical payload shape.
   */
  summaryFailed?: boolean;
  message?: string;
  dashboards?: DashboardSummary[];
  /**
   * #3482-follow — DriveFS conflict-copy families found while listing. Present
   * ONLY when at least one fork exists, so a clean store keeps the historical
   * payload shape. A non-empty array means the same logical dashboard is
   * readable under several keys and writers may be diverging between them.
   */
  forks?: DashboardForkGroup[];
  archives?: string[];
  archiveData?: { key: string; archivedAt: string; messageCount: number; messages: IntercomMessage[] };
  overview?: Record<string, {
    key: string;
    status: string;
    intercom: { totalMessages: number; recentMessages: IntercomMessage[] };
    lastModified: string;
    lastModifiedBy: Author;
  } | null>;
  /** Per-target cross-post outcomes (v3 #1363). Present only when args.crossPost was used. */
  crossPost?: Array<{ key: string; ok: boolean; error?: string; writeVerification?: WriteVerifyResult }>;
  /**
   * Raw markdown content (#1832). Present only when format='markdown' (default)
   * for read/read_overview. When present, registry returns this directly as text
   * instead of JSON.stringify of the full DashboardResult.
   */
  markdownContent?: string;
  /**
   * Per-pass condensation telemetry (2026-04-20). Present whenever condensation
   * was attempted (append with size over threshold, or explicit condense
   * action). Each entry reports phase + outcome + LLM call stats so operators
   * can tell "LLM down" from "LLM returned null content" without tailing logs.
   *
   * An append can have up to 2 entries (preemptive + reactive). A condense
   * action has 1 (manual). No entry means no condensation was attempted.
   */
  condenseDiagnostic?: CondenseAttemptInfo[];
  /**
   * Count of parts the incoming content was split into (#1589). `1` means no
   * split was performed (content fit under MAX_INDIVIDUAL_MESSAGE_BYTES).
   * Present only on `append` results.
   */
  splitCount?: number;
  /**
   * #3482 — post-write fork verification. Present ONLY when the write is
   * suspected to have been deviated by DriveFS/Windows to a ` (N).md` fork
   * (canonical didn't reflect our write, or a fresh collision-named sibling
   * appeared in the write window). Absent = write verified landed (or the
   * verification itself was unavailable — never blocks the write path).
   */
  writeVerification?: WriteVerifyResult;
  /**
   * Wall-clock breakdown of the append call (#1589). Populated on every
   * `append` result so operators can attribute latency to condensation phases
   * vs disk write vs other work without tailing MCP logs. Times are in ms.
   */
  durationBreakdown?: {
    totalMs: number;
    preemptiveCondenseMs: number;
    reactiveCondenseMs: number;
    writeMs: number;
  };
  /** Advisory warning (#2306). Non-blocking hint for agents about suboptimal usage patterns. */
  warning?: string;
  /**
   * #3276 idempotent append: true when the append was SKIPPED because an entry
   * with the same caller-provided `messageId` already exists (transcript-fork
   * double-execution guard). Present only on `append` results, and only when
   * the caller passed an explicit messageId.
   */
  deduplicated?: boolean;
}

/**
 * Build request echo from effective args (after defaults applied).
 */
function buildRequestEcho(args: DashboardArgs): DashboardRequestEcho {
  const echo: DashboardRequestEcho = {
    action: args.action,
    type: args.type,
    section: args.section ?? null,
    intercomLimit: args.intercomLimit ?? null,
  };
  if (args.machineId) echo.machineId = args.machineId;
  if (args.workspace) echo.workspace = args.workspace;
  return echo;
}

/**
 * Build size metrics from a dashboard object.
 */
function buildSizes(dashboard: Dashboard): DashboardSizes {
  const statusLength = dashboard.status.markdown.length;
  const intercomLength = dashboard.intercom.messages.reduce(
    (sum, msg) => sum + msg.content.length + 110, 0
  );
  const totalLength = statusLength + intercomLength + 200;
  return {
    statusLength,
    intercomLength,
    totalLength,
    condensationThreshold: PREEMPTIVE_CONDENSE_THRESHOLD_BYTES,
    hardCapBytes: MAX_DASHBOARD_SIZE_BYTES,
    utilizationPct: Math.round((totalLength / MAX_DASHBOARD_SIZE_BYTES) * 1000) / 10
  };
}

/**
 * Handler pour l'outil roosync_dashboard
 */
export async function roosyncDashboard(rawArgs: unknown): Promise<DashboardResult> {
  // Capture messageId BEFORE Zod parsing to preserve custom IDs
  const customMessageId = typeof rawArgs === 'object' && rawArgs !== null && 'messageId' in rawArgs
    ? (rawArgs as any).messageId
    : undefined;

  if (customMessageId) {
    logger.debug('Custom messageId captured', { customMessageId, rawArgsType: typeof rawArgs });
  }

  // Validate args using Zod schema to ensure type safety
  let args: DashboardArgs;
  try {
    args = DashboardArgsSchema.parse(rawArgs);
  } catch (e) {
    logger.error('Invalid args for roosync_dashboard', { error: String(e) });
    throw new Error(`Invalid arguments: ${String(e)}`);
  }

  // The custom messageId is stored in pendingMessageIds Map after key is computed
  // This happens below when handling the append action

  // Build request echo for all responses
  const requestEcho = buildRequestEcho(args);

  // action=list et read_overview ne nécessitent pas de type
  if (args.action === 'list') {
    return handleList(requestEcho);
  }
  if (args.action === 'read_overview') {
    const resolvedMachineId = args.machineId ?? getLocalMachineId();
    const resolvedWorkspace = args.workspace ?? getLocalWorkspaceId();
    return handleReadOverview(resolvedMachineId, resolvedWorkspace, args, requestEcho);
  }

  // #1935 Cluster B: refresh delegates to the inventory tool (no dashboard key).
  // update (#3549 Option A) rejoint le chemin v3 commun : type requis, même
  // buildDashboardKey que read/write/append, mêmes verrous — routé dans le
  // switch ci-dessous. La délégation legacy vers DASHBOARD.md est supprimée.
  if (args.action === 'refresh') {
    return handleRefresh(args, requestEcho);
  }

  if (!args.type) {
    throw new Error('type est requis pour action=' + args.action);
  }

  const resolvedMachineId = args.machineId ?? getLocalMachineId();
  const resolvedWorkspace = args.workspace ?? getLocalWorkspaceId();
  let key = buildDashboardKey(args.type, resolvedMachineId, resolvedWorkspace);
  const createIfNotExists = args.createIfNotExists !== false; // défaut: true

  // #3782 — anti-rebirth : une écriture adressée à une clé retirée (marque
  // active posée par un merge) atterrit sur sa cible. AVANT les verrous et le
  // registre pendingMessageIds — tout le downstream (lock, handler, réponse)
  // ne voit que la clé finale. Read/merge/delete ne redirigent PAS : read
  // ignore la clé (readDashboardFile), merge refuse une source retirée,
  // delete reste un geste opérateur explicite sur le fichier.
  let retiredRedirectNote: string | undefined;
  if (
    args.action === 'append' ||
    args.action === 'write' ||
    args.action === 'update' ||
    args.action === 'scrub'
  ) {
    const mark = await resolveRetirementRedirect(key);
    if (mark) {
      retiredRedirectNote =
        `⚠️ [retirement #3782] clé '${mark.sourceKey}' retirée (merge vers '${mark.targetKey}' par ${mark.retiredBy}) — ` +
        `écriture REDIRIGÉE vers la cible (hôte écrivain : ${resolvedMachineId}:${resolvedWorkspace}).`;
      logger.warn(
        "[retirement #3782] écriture adressée à une clé retirée — redirection vers la cible",
        {
          requestedKey: key,
          targetKey: mark.targetKey,
          writingHost: `${resolvedMachineId}:${resolvedWorkspace}`,
          retiredAt: mark.retiredAt,
        }
      );
      key = mark.targetKey;
    }
  }

  // Store pending custom messageId for append action
  if (customMessageId && args.action === 'append') {
    pendingMessageIds.set(key, customMessageId);
  }

  logger.info('roosync_dashboard appelé', { action: args.action, key });

  try {
    switch (args.action) {
      case 'read':
        return handleRead(key, args, resolvedMachineId, resolvedWorkspace, requestEcho);
      case 'write':
        // Serialized: read-modify-write races can overwrite concurrent updates
        return withKeyLock(key, () =>
          withRedirectNote(retiredRedirectNote,
            handleWrite(key, args, createIfNotExists, resolvedMachineId, resolvedWorkspace, requestEcho))
        );
      case 'append':
        // Serialized: prevents concurrent condensations producing duplicate archives
        return withKeyLock(key, () =>
          withRedirectNote(retiredRedirectNote,
            handleAppend(key, args, createIfNotExists, resolvedMachineId, resolvedWorkspace, requestEcho))
        );
      case 'update':
        // #3549: update = read-modify-write v3, même discipline de sérialisation
        // que write/append (per-key + cross-process append lock dans le handler)
        return withKeyLock(key, () =>
          withRedirectNote(retiredRedirectNote,
            handleUpdate(key, args, createIfNotExists, resolvedMachineId, resolvedWorkspace, requestEcho))
        );
      case 'scrub':
        // #3584 (retrait) : même discipline read-modify-write sérialisée que write.
        return withKeyLock(key, () =>
          withRedirectNote(retiredRedirectNote,
            handleScrub(key, args, resolvedMachineId, resolvedWorkspace, requestEcho))
        );

    case 'delete':
      return withKeyLock(key, () => handleDelete(key, args, requestEcho));
      case 'merge': {
        // #3537 §6.2 — les gardes PURES d'abord (validation de sourceKey,
        // store joignable, asymétrie PG) : elles doivent trancher AVANT toute
        // acquisition de verrou — getAppendLock ferait un path.join sur la
        // clé brute, et un traversal y écrirait un fichier de verrou HORS du
        // store ; un répertoire dashboards absent y masquerait le refus
        // métier derrière un refus de verrou.
        const sourceKey = String((args as Record<string, unknown>).sourceKey ?? '').trim();
        const guardRefusal = mergeGuardRefusal(sourceKey, key, args);
        if (guardRefusal) return guardRefusal;

        // Verrou in-process sur les DEUX clés (ordre trié anti-interblocage),
        // puis verrou append CROSS-PROCESS sur les deux clés, en mode
        // FAIL-CLOSED (rework #1134, review ask 1) : le merge est un
        // read-modify-write destructif — sans exclusion, un append concurrent
        // dans la fenêtre lecture→écriture serait écrasé puis la source
        // retirée. Pas de verrou ⇒ pas de merge (jamais fail-open).
        const lockKeys = [...new Set([key, sourceKey])].sort();
        ensureStoreSubdir(getSharedStatePath(), 'dashboards');
        return withTwoKeyLocks(sourceKey, key, async () => {
          const lockHolder: CondenseLockInfo = {
            machineId: resolvedMachineId,
            workspace: resolvedWorkspace,
            pid: process.pid,
            acquiredAt: new Date().toISOString()
          };
          const acquireAll = async (i: number): Promise<DashboardResult> => {
            if (i >= lockKeys.length) {
              return handleMerge(key, args, resolvedMachineId, resolvedWorkspace, requestEcho);
            }
            return withAppendLockRequired(lockKeys[i], lockHolder, () => acquireAll(i + 1));
          };
          try {
            return await acquireAll(0);
          } catch (err) {
            if (err instanceof AppendLockUnavailableError) {
              return {
                success: false,
                action: 'merge',
                key,
                type: args.type ?? '',
                request: requestEcho,
                message:
                  `⛔ REFUSÉ: verrou append non acquis pour '${err.lockKey}' (budget épuisé ou erreur FS) — ` +
                  `le merge est un read-modify-write destructif : sans exclusion cross-process, un append ` +
                  `concurrent serait écrasé puis la source supprimée. Aucune écriture effectuée (fail-closed, ` +
                  `revue #1134). Réessayer dans quelques secondes.`
              } satisfies DashboardResult;
            }
            throw err;
          }
        });
      }
      case 'read_archive':
        return handleReadArchive(key, args, requestEcho);
      default:
        throw new Error(`Action inconnue: ${(args as any).action}`);
    }
  } finally {
    // Clean up pending messageId after append completes
    if (args.action === 'append') {
      pendingMessageIds.delete(key);
    }
  }
}

/**
 * Estimates the serialized file size of a dashboard (in bytes).
 * Used to decide when to trigger size-based condensation.
 */
function estimateDashboardSize(dashboard: Dashboard): number {
  // Approximate: frontmatter (~200B) + status + messages serialized as markdown
  let size = 200; // frontmatter overhead
  size += Buffer.byteLength(dashboard.status.markdown || '', 'utf8');
  for (const msg of dashboard.intercom.messages) {
    // Each message: header (~100B) + content + separator (~10B)
    size += 110;
    size += Buffer.byteLength(msg.content || '', 'utf8');
  }
  return size;
}

/**
 * Split a message body into smaller parts, each <= MAX_INDIVIDUAL_MESSAGE_BYTES.
 *
 * Strategy: prefer line-boundary splits (preserves markdown readability); fall
 * back to hard char-slice for individual lines that exceed the cap.
 *
 * Returns a single-element array when the body already fits. Otherwise each
 * part is prefixed with `**[PART n/N]**` so readers can reassemble the original
 * and so dashboard readers see the message structure without surprise.
 *
 * Trailing whitespace on each part is trimmed. Parts are guaranteed non-empty.
 */
export function splitLargeMessage(
  content: string,
  maxBytes: number = MAX_INDIVIDUAL_MESSAGE_BYTES
): string[] {
  if (Buffer.byteLength(content, 'utf8') <= maxBytes) {
    return [content];
  }

  const rawParts: string[] = [];
  const lines = content.split('\n');
  let buffer = '';
  let bufferBytes = 0;

  const flush = () => {
    const trimmed = buffer.replace(/\n+$/, '');
    if (trimmed.length > 0) {
      rawParts.push(trimmed);
    }
    buffer = '';
    bufferBytes = 0;
  };

  for (const line of lines) {
    const lineWithNl = line + '\n';
    const lineBytes = Buffer.byteLength(lineWithNl, 'utf8');

    if (lineBytes > maxBytes) {
      // Single line too big — flush current buffer, then hard-slice the line.
      flush();
      let remainder = line;
      while (Buffer.byteLength(remainder, 'utf8') > maxBytes) {
        // Binary search a char-boundary cut under the byte cap
        let lo = 1;
        let hi = remainder.length;
        while (lo < hi) {
          const mid = Math.ceil((lo + hi) / 2);
          if (Buffer.byteLength(remainder.slice(0, mid), 'utf8') <= maxBytes) {
            lo = mid;
          } else {
            hi = mid - 1;
          }
        }
        rawParts.push(remainder.slice(0, lo));
        remainder = remainder.slice(lo);
      }
      if (remainder.length > 0) {
        buffer = remainder + '\n';
        bufferBytes = Buffer.byteLength(buffer, 'utf8');
      }
      continue;
    }

    if (bufferBytes + lineBytes > maxBytes) {
      flush();
    }
    buffer += lineWithNl;
    bufferBytes += lineBytes;
  }
  flush();

  if (rawParts.length === 0) {
    // Should not happen given the input-size guard above, but keep contract
    return [content];
  }

  const total = rawParts.length;
  return rawParts.map((part, idx) => `**[PART ${idx + 1}/${total}]**\n\n${part}`);
}

/**
 * Build human-readable markdown from a Dashboard object (#1832).
 * Reconstructs the same layout as the on-disk format for agent consumption.
 */
function buildMarkdownOutput(
  dashboard: Dashboard,
  section: 'status' | 'intercom' | 'all',
  filteredMessages?: IntercomMessage[]
): string {
  const parts: string[] = [];

  if (section === 'status' || section === 'all') {
    parts.push('## Status\n');
    parts.push(dashboard.status.markdown || '*Aucun contenu.*');
  }

  if (section === 'intercom' || section === 'all') {
    const messages = filteredMessages ?? dashboard.intercom.messages;
    parts.push('\n## Intercom\n');
    if (messages.length === 0) {
      parts.push('*Aucun message.*');
    } else {
      for (const msg of messages) {
        parts.push(`### [${msg.timestamp}] ${msg.author.machineId}|${msg.author.workspace}\n`);
        // #1956: show ACK status if present
        if (msg.acknowledged_at && Object.keys(msg.acknowledged_at).length > 0) {
          const ackMachines = Object.keys(msg.acknowledged_at).join(', ');
          parts.push(`*(ACKed by: ${ackMachines})*\n`);
        }
        parts.push(msg.content);
        parts.push('');
      }
    }
  }

  return parts.join('\n');
}

// #1956 + #3205 résiduel : détection/application de l'Auto-ACK isolées pour
// être rejouables sous verrou sur un état fraîchement relu.
function ackHasUnackedReplies(dashboard: Dashboard, resolvedMachineId: string): boolean {
  const myMessageIds = new Set(
    dashboard.intercom.messages
      .filter(m => m.author.machineId === resolvedMachineId)
      .map(m => m.id)
  );
  return dashboard.intercom.messages.some(
    m => m.reply_to && myMessageIds.has(m.reply_to) &&
      (!m.acknowledged_at || !m.acknowledged_at[resolvedMachineId])
  );
}

function ackMark(dashboard: Dashboard, resolvedMachineId: string): boolean {
  const myMessageIds = new Set(
    dashboard.intercom.messages
      .filter(m => m.author.machineId === resolvedMachineId)
      .map(m => m.id)
  );
  let ackDirty = false;
  const now = new Date().toISOString();
  for (const msg of dashboard.intercom.messages) {
    if (msg.reply_to && myMessageIds.has(msg.reply_to)) {
      if (!msg.acknowledged_at || !msg.acknowledged_at[resolvedMachineId]) {
        msg.acknowledged_at = { ...(msg.acknowledged_at || {}), [resolvedMachineId]: now };
        ackDirty = true;
      }
    }
  }
  return ackDirty;
}

async function handleRead(
  key: string,
  args: DashboardArgs,
  resolvedMachineId: string,
  resolvedWorkspace: string,
  requestEcho: DashboardRequestEcho
): Promise<DashboardResult> {
  // #3459: fail-closed. When the shared store root is unreachable, an agent must
  // be STOPPED, not reassured with "dashboard not found — use createIfNotExists".
  try {
    assertSharedStoreAccessible();
  } catch (err) {
    return {
      success: false,
      action: 'read',
      key,
      type: args.type!,
      request: requestEcho,
      message: (err as Error).message
    };
  }

  let dashboard = await readDashboardFile(key);
  if (!dashboard) {
    return {
      success: false,
      action: 'read',
      key,
      type: args.type!,
      request: requestEcho,
      message: `Dashboard '${key}' introuvable. Utilisez createIfNotExists: true lors d'un write/append pour le créer.`
    };
  }

  const section = args.section ?? 'all';
  // #1935: section now includes update-specific values — narrow to read-safe values
  const readSection = (section === 'status' || section === 'intercom' || section === 'all') ? section : 'all';

  // #1956: Auto-ACK — when reading intercom, mark replies to our messages as
  // acknowledged. #3205 résiduel write-side : la marque s'applique sous le
  // verrou append sur un état RELU — sinon un append concurrent entre le read
  // initial et ce write est écrasé par le snapshot pré-verrou. On sert ensuite
  // l'état post-ack, pas le snapshot périmé.
  if ((readSection === 'intercom' || readSection === 'all') && ackHasUnackedReplies(dashboard, resolvedMachineId)) {
    try {
      const holder: CondenseLockInfo = {
        machineId: resolvedMachineId,
        workspace: resolvedWorkspace,
        pid: process.pid,
        acquiredAt: new Date().toISOString()
      };
      await withAppendLock(key, holder, async () => {
        const fresh = await readDashboardFile(key);
        if (!fresh) return; // disparu entre-temps — rien à ack-er
        if (ackMark(fresh, resolvedMachineId)) {
          await writeDashboardFile(key, fresh);
        }
        dashboard = fresh; // servir l'état post-ack, pas le snapshot pré-verrou
      });
    } catch (err) {
      logger.warn('Auto-ACK write failed', { key, error: String(err) });
    }
  }
  // intercomLimit is kept as an optional safety net but defaults to returning ALL messages.
  // The dashboard should stay under 50KB thanks to size-based condensation,
  // so agents always see the full picture without needing to paginate.
  const intercomLimit = args.intercomLimit;
  let data: Partial<Dashboard> = {};

  if (readSection === 'status' || readSection === 'all') {
    data.status = dashboard.status;
  }
  if (readSection === 'intercom' || readSection === 'all') {
    let messages = dashboard.intercom.messages;

    // mentionsOnly must filter the full history BEFORE the slice, otherwise
    // intercomLimit takes the raw tail and older mentions vanish silently.
    if (args.mentionsOnly) {
      messages = messages.filter(msg => {
        const mentions = parseMentions(msg.content);
        return isMentioned(mentions, resolvedMachineId, resolvedWorkspace);
      });
    }

    if (intercomLimit) {
      messages = messages.slice(-intercomLimit);
    }

    data.intercom = {
      ...dashboard.intercom,
      messages
    };
  }
  if (readSection === 'all') {
    data = {
      type: dashboard.type,
      key: dashboard.key,
      lastModified: dashboard.lastModified,
      lastModifiedBy: dashboard.lastModifiedBy,
      ...data
    };
  }

  const jsonResult: DashboardResult = {
    success: true,
    action: 'read',
    key,
    type: args.type!,
    request: requestEcho,
    sizes: buildSizes(dashboard),
    data,
    messageCount: dashboard.intercom.messages.length
  };

  // #2306: Warn when reading only the status section — it may be stale
  if (readSection === 'status') {
    jsonResult.warning = 'Status section may be stale — use section: "all" or "intercom" for latest messages.';
  }

  // #1832: markdown format (default) — return human-readable markdown instead of JSON envelope
  if (args.format !== 'json') {
    jsonResult.markdownContent = buildMarkdownOutput(dashboard, readSection, data.intercom?.messages);
  }

  // #3226(a): an effective read of the global dashboard advances the reader's
  // lastGlobalSeenAt cursor — the ONLY thing that advances it. Status-only reads
  // do NOT count (the #2306 warning applies: status may be stale, the news is in
  // the intercom). A local sub-ms write; never fails the read it belongs to.
  if (args.type === 'global' && (readSection === 'intercom' || readSection === 'all')) {
    try {
      const messages = dashboard.intercom.messages;
      // Max timestamp, not the last element: cross-machine appends are
      // serialized by the lock but each is stamped by its author's local clock,
      // so the last array element is not necessarily the newest (clock skew).
      // Using lastModified as the seed also covers the empty case.
      const seenUpTo = messages.reduce(
        (max, m) => (m.timestamp > max ? m.timestamp : max),
        dashboard.lastModified
      );
      await advanceGlobalSeenCursor(resolvedMachineId, resolvedWorkspace, seenUpTo);
    } catch (err) {
      logger.warn('Global read cursor advance failed (non-critical)', { key, error: String(err) });
    }
  }

  return jsonResult;
}

async function handleWrite(
  key: string,
  args: DashboardArgs,
  createIfNotExists: boolean,
  resolvedMachineId: string,
  resolvedWorkspace: string,
  requestEcho: DashboardRequestEcho
): Promise<DashboardResult> {
  if (!args.content) {
    throw new Error('content est requis pour action=write');
  }
  const author: Author = args.author ?? {
    machineId: resolvedMachineId,
    workspace: resolvedWorkspace
  };
  const content = args.content;

  // #3459: refuser de créer un dashboard fantôme quand le magasin est absent.
  // createIfNotExists est un piège actif ici : l'appliquer écrit un fichier
  // dans un store injoignable qui masquera le vrai au retour du montage.
  try {
    assertSharedStoreAccessible();
  } catch (err) {
    return {
      success: false,
      action: 'write',
      key,
      type: args.type!,
      request: requestEcho,
      message: (err as Error).message
    };
  }

  // #3205 résiduel write-side : read-modify-write sous le verrou append —
  // sans lui, un append concurrent entre le read et le write est écrasé
  // (last-writer-wins), exactement la classe de perte que #1033 corrigeait
  // pour le seul chemin append.
  let notFound = false;
  let dashboard: Dashboard | null = null;
  const holder: CondenseLockInfo = {
    machineId: author.machineId,
    workspace: author.workspace,
    pid: process.pid,
    acquiredAt: new Date().toISOString()
  };
  await withAppendLock(key, holder, async () => {
    let current = await readDashboardFile(key);
    if (!current) {
      if (!createIfNotExists) {
        notFound = true;
        return;
      }
      current = createEmptyDashboard(args.type!, key, author);
    }
    const updated: Dashboard = {
      ...current,
      lastModified: new Date().toISOString(),
      lastModifiedBy: author,
      status: {
        markdown: content,
        lastDiffCommit: current.status.lastDiffCommit
      }
    };
    await writeDashboardFile(key, updated);
    dashboard = updated;
  });

  if (notFound || !dashboard) {
    return {
      success: false,
      action: 'write',
      key,
      type: args.type!,
      request: requestEcho,
      message: `Dashboard '${key}' introuvable et createIfNotExists=false`
    };
  }

  // #1791: Auto-register heartbeat on dashboard write (fire-and-forget)
  recordRooSyncActivityAsync('dashboard-write', { key, type: args.type });

  return {
    success: true,
    action: 'write',
    key,
    type: args.type!,
    request: requestEcho,
    sizes: buildSizes(dashboard),
    message: `Status mis à jour pour dashboard '${key}'`
  };
}

/**
 * #3584 (volet retrait) — action `scrub` : masque RÉTROACTIVEMENT le dashboard vivant.
 *
 * Le garde #1144 masque à l'écriture ; la condensation masque à la relecture depuis
 * #3584-rétention ; entre les deux, un secret publié AVANT ces gardes reste lisible
 * dans l'intercom vivant — potentiellement des jours, si le seuil de condensation
 * de 92 % n'est pas franchi. `scrub` referme cette fenêtre À LA DEMANDE : relire,
 * masquer, réécrire via writeDashboardFile — donc fichier G: ET miroir PG d'un
 * coup, sous les mêmes verrous que write (read-modify-write).
 *
 * Le masquage par valeur ne connaît que les secrets que CE process détient dans
 * son `process.env` (cf. utils/secret-redaction.ts) : l'exécuter depuis un siège
 * NON-détenteur ne masque rien — et ne prouve donc rien. Ne couvre QUE le
 * dashboard vivant — archives et journal PG historique relèvent de la procédure
 * manuelle (docs/harness/reference/secret-withdrawal-procedure.md, repo parent).
 */
async function handleScrub(
  key: string,
  args: DashboardArgs,
  resolvedMachineId: string,
  resolvedWorkspace: string,
  requestEcho: DashboardRequestEcho
): Promise<DashboardResult> {
  // #3459: même fail-closed que write/append — pas de scrub d'un store injoignable.
  try {
    assertSharedStoreAccessible();
  } catch (err) {
    return {
      success: false,
      action: 'scrub',
      key,
      type: args.type!,
      request: requestEcho,
      message: (err as Error).message
    };
  }

  const holder: CondenseLockInfo = {
    machineId: resolvedMachineId,
    workspace: resolvedWorkspace,
    pid: process.pid,
    acquiredAt: new Date().toISOString()
  };

  let notFound = false;
  let statusMasked = false;
  let messagesMasked = 0;

  await withAppendLock(key, holder, async () => {
    const current = await readDashboardFile(key);
    if (!current) {
      notFound = true;
      return;
    }

    const statusRaw = current.status.markdown ?? '';
    const statusOut = maskSecretText(statusRaw);
    statusMasked = statusOut !== statusRaw;

    let maskedCount = 0;
    const maskedMessages = current.intercom.messages.map(msg => {
      const raw = msg.content ?? '';
      const out = maskSecretText(raw);
      if (out === raw) return msg;
      maskedCount++;
      return { ...msg, content: out };
    });
    messagesMasked = maskedCount;

    const updated: Dashboard = {
      ...current,
      lastModified: new Date().toISOString(),
      lastModifiedBy: { machineId: resolvedMachineId, workspace: resolvedWorkspace },
      status: statusMasked ? { ...current.status, markdown: statusOut } : current.status,
      intercom: { ...current.intercom, messages: maskedMessages }
    };
    await writeDashboardFile(key, updated);
  });

  if (notFound) {
    return {
      success: false,
      action: 'scrub',
      key,
      type: args.type!,
      request: requestEcho,
      message: `Dashboard '${key}' introuvable`
    };
  }

  logger.warn('[DASHBOARD-SCRUB] retrait rétroactif exécuté (#3584)', {
    key,
    statusMasked,
    messagesMasked
  });

  return {
    success: true,
    action: 'scrub',
    key,
    type: args.type!,
    request: requestEcho,
    message: `Scrub #3584 '${key}' : ${messagesMasked} message(s) masqué(s)`
      + `${statusMasked ? ' + section status' : ''} — fichier et miroir PG réécrits. `
      + `Archives et journal PG historiques : voir secret-withdrawal-procedure (repo parent).`
  };
}

async function handleAppend(
  key: string,
  args: DashboardArgs,
  createIfNotExists: boolean,
  resolvedMachineId: string,
  resolvedWorkspace: string,
  requestEcho: DashboardRequestEcho
): Promise<DashboardResult> {
  if (!args.content) {
    throw new Error('content est requis pour action=append');
  }
  const appendStart = Date.now();
  let preemptiveCondenseMs = 0;
  let reactiveCondenseMs = 0;
  let writeMs = 0;
  const author: Author = args.author ?? {
    machineId: resolvedMachineId,
    workspace: resolvedWorkspace
  };

  // #3459: refuser de créer un dashboard fantôme quand le magasin est absent.
  // createIfNotExists est un piège actif ici : l'appliquer écrit un fichier
  // dans un store injoignable qui masquera le vrai au retour du montage.
  try {
    assertSharedStoreAccessible();
  } catch (err) {
    return {
      success: false,
      action: 'append',
      key,
      type: args.type!,
      request: requestEcho,
      message: (err as Error).message
    };
  }

  let dashboard = await readDashboardFile(key);
  let guardAWarning: string | undefined;
  if (!dashboard) {
    if (!createIfNotExists) {
      return {
        success: false,
        action: 'append',
        key,
        type: args.type!,
        request: requestEcho,
        message: `Dashboard '${key}' introuvable et createIfNotExists=false`
      };
    }
    // #3782 garde (a2) — un fichier absent n'est pas forcément une clé neuve.
    // Le createIfNotExists inconditionnel recréait une coquille vide sur une
    // clé en cours de disparition DriveFS alors que le journal PG portait tout
    // le contenu (incident 23/09 00:54Z : workspace-CoursIA recréé coquille,
    // 9 762 msgs vivants en PG). Avant de créer : sonder le journal PG
    // (bornée, SANS la porte READ_PG — c'est une entrée de décision interne du
    // chemin append, qui parle déjà à PG via le dual-write).
    const probe = await probeDashboardJournalForHydration(key);
    if (probe.kind === 'disappeared') {
      try {
        ensureStoreSubdir(getSharedStatePath(), 'dashboards');
        await fs.writeFile(getDashboardPath(key), buildDashboardMarkdown(probe.dashboard), {
          encoding: 'utf8',
          flag: 'wx', // O_EXCL — ne jamais écraser un fichier qui revient
        });
        dashboard = probe.dashboard;
        guardAWarning = `[guard-a #3782] clé '${key}' absente du disque mais vivante en PG (${probe.rows} messages) — réinstallée par hydratation O_EXCL avant l'append (disparition DriveFS probable)`;
        logger.warn('[guard-a] hydratation avant append — clé disparue du disque, journal PG réinstallé', {
          key,
          rehydratedRows: probe.rows,
          case: 'disappeared',
        });
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') {
          // GO #3782 condition 2 : le fichier est réapparu entre le contrôle
          // d'absence et l'écriture (DriveFS résout son conflit) — l'append
          // va au fichier qui est revenu, jamais à une coquille.
          const back = await readDashboardFile(key);
          if (back) {
            dashboard = back;
            guardAWarning = `[guard-a #3782] course EEXIST sur '${key}' — fichier réapparu pendant l'hydratation, append appliqué au fichier de retour`;
            logger.warn('[guard-a] course EEXIST — fichier réapparu, append sur le fichier de retour', {
              key,
              case: 'eexist-race',
            });
          } else {
            dashboard = createEmptyDashboard(args.type!, key, author);
            guardAWarning = `[guard-a #3782] course EEXIST sur '${key}' mais relecture introuvable — création normale, cas à observer`;
            logger.warn('[guard-a] course EEXIST puis relecture absente — création normale', {
              key,
              case: 'eexist-race-no-reread',
            });
          }
        } else {
          dashboard = createEmptyDashboard(args.type!, key, author);
          guardAWarning = `[guard-a #3782] échec d'écriture d'hydratation sur '${key}' (${(err as Error).message}) — création normale, comportement inchangé`;
          logger.warn("[guard-a] écriture d'hydratation échouée — création normale", {
            key,
            case: 'hydration-write-failed',
            error: String(err),
          });
        }
      }
    } else if (probe.kind === 'unreachable') {
      dashboard = createEmptyDashboard(args.type!, key, author);
      guardAWarning = `[guard-a #3782] PG injoignable pendant la sonde sur '${key}' — comportement actuel conservé (création normale)`;
      logger.warn('[guard-a] sonde PG injoignable — création normale, canal non bloqué', {
        key,
        case: 'pg-unreachable',
      });
    } else if (probe.kind === 'stale') {
      dashboard = createEmptyDashboard(args.type!, key, author);
      guardAWarning = `[guard-a #3782] PG porte ${probe.rows} messages non récents pour '${key}' — création normale (seuil design), à observer`;
      logger.warn('[guard-a] journal PG présent mais non récent — création normale (seuil design)', {
        key,
        rows: probe.rows,
        case: 'pg-stale',
      });
    } else {
      // pg-off / empty : clé réellement neuve — création normale, inchangée,
      // sans bruit (la création légitime est le cas courant).
      dashboard = createEmptyDashboard(args.type!, key, author);
    }
  }

  // Append-first architecture: the message is persisted to disk BEFORE any
  // condensation attempt. Condensation (LLM calls that can take minutes) is
  // best-effort after the write. This guarantees no message is lost even if
  // condensation times out or the LLM is unavailable.
  const condenseDiagnostics: CondenseAttemptInfo[] = [];

  // Use provided messageId or generate a new one
  // Check in order:
  // 1. Pending messageId from the Map (custom ID provided to append)
  // 2. args.messageId property (from schema)
  // 3. Generate new ID as fallback
  const pendingCustomId = pendingMessageIds.get(key);
  const schemaCustomId = (args as any).messageId as string | undefined;
  const messageIdValue = pendingCustomId || schemaCustomId || generateMessageId(author.machineId, author.workspace);

  // #3276: idempotent append on caller-provided messageId. The transcript-fork
  // double-execution bug (roo-extensions#3276) executes the same tool_use twice;
  // both executions run in this process, serialized by withKeyLock (measured
  // handoff +6/+7 ms), so the second one re-reads the dashboard AFTER the first
  // persisted its entry. An explicit messageId is therefore honored as an
  // idempotency key: an id already present in intercom → skip the append
  // entirely (no second GDrive write, no PG dual-write, no repeated
  // mentions/cross-posts). Auto-generated ids are unique per call and can
  // never trip this guard — only opted-in deterministic ids are affected.
  if (pendingCustomId || schemaCustomId) {
    const existing = dashboard.intercom.messages.find(m => m.id === messageIdValue);
    if (existing) {
      const contentMismatch = (existing.content || '') !== (args.content || '');
      logger.info('Append deduplicated — explicit messageId already present (#3276)', {
        key,
        messageId: messageIdValue,
        existingTimestamp: existing.timestamp,
        contentMismatch
      });
      return {
        success: true,
        action: 'append',
        key,
        type: args.type!,
        request: requestEcho,
        deduplicated: true,
        messageCount: dashboard.intercom.messages.length,
        sizes: buildSizes(dashboard),
        warning: contentMismatch
          ? `messageId '${messageIdValue}' existait déjà avec un CONTENU DIFFÉRENT — entrée existante (${existing.timestamp}) conservée, append ignoré`
          : undefined,
        durationBreakdown: {
          totalMs: Date.now() - appendStart,
          preemptiveCondenseMs: 0,
          reactiveCondenseMs: 0,
          writeMs: 0
        },
        message: `Message dédupliqué — id '${messageIdValue}' déjà présent (ajouté ${existing.timestamp}) : append ignoré (#3276 idempotence)`
      };
    }
  }

  // #1589: Split messages above MAX_INDIVIDUAL_MESSAGE_BYTES into multiple
  // IntercomMessage entries. Each part is an independent message subject to
  // the CONDENSE_KEEP slice policy, so oversized dispatches no longer
  // indefinitely protect themselves from archival by virtue of being recent.
  const contentParts = splitLargeMessage(args.content);
  const isMultiPart = contentParts.length > 1;
  if (isMultiPart) {
    logger.info('Large message split at append time (#1589)', {
      key,
      originalSizeKB: `${(Buffer.byteLength(args.content, 'utf8') / 1024).toFixed(1)}KB`,
      partCount: contentParts.length,
      perPartCapKB: `${(MAX_INDIVIDUAL_MESSAGE_BYTES / 1024).toFixed(0)}KB`
    });
  }

  const nowDate = new Date();
  const newMessages: IntercomMessage[] = contentParts.map((partContent, idx) => ({
    // First part inherits the caller-provided messageId (so consumers that
    // referenced it via `messageId` still resolve). Subsequent parts get fresh
    // generated IDs keyed to the same author.
    id: idx === 0
      ? messageIdValue
      : generateMessageId(author.machineId, author.workspace),
    // Stagger per-part timestamps by 1ms so insertion order survives any
    // later sort that keys on timestamp alone.
    timestamp: new Date(nowDate.getTime() + idx).toISOString(),
    author,
    content: partContent,
    // #1853: Team pipeline stage tracking
    teamStage: (args as any).teamStage
  }));

  // Use the FIRST part as the "primary" message for mention/crossPost wiring —
  // it carries the caller-provided messageId and is the natural anchor in the
  // intercom stream.
  const message = newMessages[0];

  // Parse mentions on the FULL original content (not on a single part) so
  // @-mentions that happen to cross a part boundary still fire exactly once.
  const mentions = parseMentions(args.content);
  if (mentions.length > 0) {
    logger.debug('Mentions detected in dashboard message', {
      messageId: message.id,
      mentionCount: mentions.length,
      mentions: mentions.map(m => m.pattern),
      isMultiPart
    });
  }

  const now = nowDate.toISOString();

  // #1956: If mentions reference a messageId, set reply_to on the primary message
  if (args.mentions && args.mentions.length > 0) {
    const msgRef = args.mentions.find(m => m.messageId !== undefined);
    if (msgRef && msgRef.messageId) {
      message.reply_to = msgRef.messageId;
    }
  }

  // #3584 — masquer ICI, sur l'objet, et non seulement dans `writeDashboardFile`.
  // Le chemin d'append primaire (`appendDashboardIncremental`, #3151) ne traverse
  // `writeDashboardFile` qu'en **fallback**, quand le fichier est absent ; dès qu'il
  // existe — le cas de production, et celui de la fuite fondatrice — il rend le bloc
  // neuf et alimente `dualWriteDashboardSync` sans masque. Poser le masque sur
  // l'objet couvre les deux sinks d'un seul geste, et fait en outre que la
  // condensation ci-dessous n'envoie plus la valeur brute au provider LLM.
  //
  // Seuls les messages NEUFS sont masqués : les anciens sont relus du disque, où ils
  // sont déjà passés par cette frontière. Masquer tout l'intercom à chaque append
  // coûtait +71 % sur le plus gros test d'append (cf. `redactMessagesForPublication`).
  const redactedNewMessages = redactMessagesForPublication(key, newMessages);

  const updatedDashboard: Dashboard = {
    ...dashboard,
    lastModified: now,
    lastModifiedBy: author,
    intercom: {
      messages: [...dashboard.intercom.messages, ...redactedNewMessages],
      totalMessages: dashboard.intercom.totalMessages + newMessages.length,
      lastCondensedAt: dashboard.intercom.lastCondensedAt
    }
  };

  // === WRITE-FIRST: persist message to disk immediately ===
  // The message is guaranteed to be on disk before any condensation attempt.
  // If condensation below fails or times out, the message is NOT lost.
  let condensed = false;
  let archivedCount = 0;
  let finalDashboard = updatedDashboard;

  const tWrite = Date.now();
  let writeVerify = await appendDashboardIncremental(key, updatedDashboard, newMessages.length);
  writeMs = Date.now() - tWrite;

  // === CONDENSE-AFTER: best-effort condensation ===
  // Now that the message is safely persisted, attempt condensation if the
  // dashboard exceeds the threshold. If condensation succeeds, it overwrites
  // the file with the condensed version. If it fails, the incremental append
  // above is the authoritative state — no message loss.
  const estimatedSize = estimateDashboardSize(updatedDashboard);
  // #2598: the retained-message window is byte-budgeted (computeKeepCount), not a
  // fixed CONDENSE_KEEP. Using the same effectiveKeep for the trigger gate, the
  // #2464 hash payload and the condenseIntercom call keeps all three consistent
  // with the slice that condenseIntercom will actually perform.
  const effectiveKeep = computeKeepCount(updatedDashboard.intercom.messages);
  const needsCondense = estimatedSize >= PREEMPTIVE_CONDENSE_THRESHOLD_BYTES
    && updatedDashboard.intercom.messages.length > effectiveKeep;

  if (needsCondense) {
    // #2464: Hash-based skip — if the messages to condense + current status haven't
    // changed since the last successful condensation, skip the LLM calls entirely.
    // This prevents the observed loop where condensation fires 3-4× per 30min on
    // unchanged content, burning ~350KB prompts + 12K output tokens each time.
    const toArchiveCount = updatedDashboard.intercom.messages.length - effectiveKeep;
    const condensePayload = updatedDashboard.intercom.messages
      .slice(0, toArchiveCount)
      .map(m => `${m.timestamp || ''}|${m.content || ''}`)
      .join('\n')
      + '\n[STATUS]\n'
      + (updatedDashboard.status?.markdown || '');
    const payloadHash = createHash('sha256').update(condensePayload).digest('hex').substring(0, 16);
    const lastHash = lastCondenseHash.get(key);

    if (lastHash === payloadHash) {
      logger.info('Condensation skipped — content unchanged since last pass (#2464)', {
        key,
        payloadHash,
        estimatedSize: `${Math.round(estimatedSize / 1024)}KB`,
        messageCount: updatedDashboard.intercom.messages.length
      });
      condensed = false;
      archivedCount = 0;
    } else {
      logger.info('Post-append condensation triggered (append-first)', {
        key,
        estimatedSize: `${Math.round(estimatedSize / 1024)}KB`,
        threshold: `${Math.round(PREEMPTIVE_CONDENSE_THRESHOLD_BYTES / 1024)}KB`,
        messageCount: updatedDashboard.intercom.messages.length,
        payloadHash,
        lastHash: lastHash || '(none)'
      });
      // #2818: Cross-process lock — only ONE agent condenses this saturated
      // dashboard. Losers skip the redundant multi-minute LLM pass; their message
      // is already persisted (append-first) and the winner stitches it back in
      // via applyCondensedWithMerge (#2328). The in-process withKeyLock guards the
      // same-process case; this guards across sessions/machines on GDrive.
      const lockHolder: CondenseLockInfo = {
        machineId: author.machineId,
        workspace: author.workspace,
        pid: process.pid,
        acquiredAt: new Date().toISOString()
      };
      const gotCondenseLock = await tryAcquireCondenseLock(key, lockHolder);
      if (!gotCondenseLock) {
        // Another agent holds the condense lock. Skip — message is already on disk
        // and will be merged into the holder's condensed result (#2328).
        condensed = false;
        archivedCount = 0;
        const skippedDiag = newDiagnostic('post-append');
        skippedDiag.outcome = 'skipped-lock-held';
        condenseDiagnostics.push(skippedDiag);
      } else {
        try {
          const beforeCount = updatedDashboard.intercom.messages.length;
          const condenseDiag = newDiagnostic('post-append');
          const tCondense = Date.now();
          finalDashboard = await condenseIntercom(key, updatedDashboard, effectiveKeep, condenseDiag);
          preemptiveCondenseMs = Date.now() - tCondense;
          condenseDiagnostics.push(condenseDiag);
          const newlyArchived = beforeCount - finalDashboard.intercom.messages.length;
          archivedCount = newlyArchived;
          condensed = newlyArchived > 0;

          // #2464: Update hash cache after successful condensation
          if (condensed) {
            lastCondenseHash.set(key, payloadHash);
          }

          // If condensation succeeded, merge-write (re-read disk to avoid overwriting concurrent appends #2328)
          if (condensed) {
            const condenseWv = await applyCondensedWithMerge(key, updatedDashboard, finalDashboard);
            // #3774 critère 3 — la condensation RÉÉCRIT tout le fichier APRÈS la
            // vérification de l'append : son verdict était jeté, donc un fork
            // apparu pendant la fenêtre de condensation (~9 min) restait
            // invisible alors que l'append rapportait un succès. Aucun des deux
            // verdicts n'efface l'autre : on accumule les détails.
            if (condenseWv?.forkSuspected) {
              writeVerify = writeVerify.forkSuspected
                ? {
                    ...writeVerify,
                    forkDetail: `${writeVerify.forkDetail} | (post-condensation) ${condenseWv.forkDetail ?? 'détection sans détail'}`
                  }
                : condenseWv;
            }
          }
        } catch (condenseErr) {
          // Condensation failed — message is already persisted, log and continue
          logger.warn('Post-append condensation failed (message already persisted, no data loss)', {
            key,
            error: condenseErr instanceof Error ? condenseErr.message : String(condenseErr)
          });
          const failedDiag = newDiagnostic('post-append');
          failedDiag.outcome = 'llm-failed-injected';
          failedDiag.elapsedMs = 0;
          condenseDiagnostics.push(failedDiag);
        } finally {
          // Release only if we still own it (releaseCondenseLock verifies pid+acquiredAt).
          await releaseCondenseLock(key, lockHolder);
        }
      }
    } // else (hash mismatch → condensation attempted)
  } // if (needsCondense)

  // Fire-and-forget: Send mention notifications if mentions were detected
  if (mentions.length > 0) {
    sendMentionNotificationsAsync(
      message.id,
      mentions,
      key,
      args.content
    ).catch((err: Error) => {
      logger.debug('Mention notification failed (non-critical)', {
        error: String(err),
        messageId: message.id
      });
    });
  }

  // #1442: Record scheduler cycle outcome when a worker posts [DONE]/[IDLE]/[BLOCKED]
  if (args.tags && args.tags.length > 0) {
    const tagStr = args.tags.join(' ').toUpperCase();
    const isSchedulerCycle = tagStr.includes('DONE') || tagStr.includes('IDLE') || tagStr.includes('BLOCKED');
    if (isSchedulerCycle) {
      const success = tagStr.includes('DONE');
      const idle = tagStr.includes('IDLE');
      import('./heartbeat-activity.js').then(({ recordSchedulerRunAsync }) => {
        recordSchedulerRunAsync(
          author.machineId,
          success,
          {
            error: idle ? 'idle-cycle' : undefined,
          }
        );
      }).catch(() => { /* non-critical */ });
    }
  }

  // v3 (#1363) — Structured mentions: resolve each to UserId and notify via RooSync.
  // Fire-and-forget, same robustness pattern as v1.
  const crossPostResults: Array<{ key: string; ok: boolean; error?: string; writeVerification?: WriteVerifyResult }> = [];
  if (args.mentions && args.mentions.length > 0) {
    try {
      const targets = args.mentions.map(m => resolveMentionTarget(m));
      sendStructuredMentionNotificationsAsync(
        { machineId: author.machineId, workspace: author.workspace },
        message.id,
        targets,
        key,
        args.content
      ).catch((err: Error) => {
        logger.debug('Structured mention notification failed (non-critical)', {
          error: String(err),
          messageId: message.id
        });
      });
    } catch (err) {
      // resolveMentionTarget can throw on malformed messageId — log but do not fail the append.
      logger.debug('Structured mention resolution failed (non-critical)', {
        error: String(err),
        messageId: message.id
      });
    }
  }

  // v3 (#1363) — Cross-post: replicate the same message (same id, timestamp, author, content)
  // into additional dashboards WITHOUT firing notifications. Each target is independent:
  // a failure on one target must not abort the others nor the primary append result.
  if (args.crossPost && args.crossPost.length > 0) {
    for (const target of args.crossPost) {
      let targetKey = '';
      try {
        const targetMachineId = target.machineId ?? resolvedMachineId;
        const targetWorkspace = target.workspace ?? resolvedWorkspace;
        targetKey = buildDashboardKey(target.type, targetMachineId, targetWorkspace);
        if (targetKey === key) {
          // Skip self-cross-post (the primary write already covered it)
          crossPostResults.push({ key: targetKey, ok: true });
          continue;
        }

        // #3205 résiduel write-side : read-modify-write de la cible sous le
        // verrou append de CETTE cible (pas de nesting — le verrou source est
        // déjà relâché ici). Sans lui, un append concurrent sur la cible entre
        // le read et le write est écrasé.
        const targetHolder: CondenseLockInfo = {
          machineId: author.machineId,
          workspace: author.workspace,
          pid: process.pid,
          acquiredAt: new Date().toISOString()
        };
        let targetMissing = false;
        // #3774 critère 3 — le verdict de CETTE écriture (message neuf dans une
        // autre dashboard) était jeté : une escalade cross-post pouvait dévier
        // vers un fork sans que l'appelant en sache rien, alors même que la
        // réponse porte déjà un résultat par cible.
        let targetWv: WriteVerifyResult | undefined;
        await withAppendLock(targetKey, targetHolder, async () => {
          let targetDashboard = await readDashboardFile(targetKey);
          if (!targetDashboard) {
            if (!createIfNotExists) {
              targetMissing = true;
              return;
            }
            targetDashboard = createEmptyDashboard(target.type, targetKey, author);
          }

          const crossPosted: Dashboard = {
            ...targetDashboard,
            lastModified: now,
            lastModifiedBy: author,
            intercom: {
              messages: [...targetDashboard.intercom.messages, message],
              totalMessages: targetDashboard.intercom.totalMessages + 1,
              lastCondensedAt: targetDashboard.intercom.lastCondensedAt
            }
          };

          targetWv = await writeDashboardFile(targetKey, crossPosted);
        });
        if (targetMissing) {
          crossPostResults.push({
            key: targetKey,
            ok: false,
            error: `Dashboard introuvable et createIfNotExists=false`
          });
          continue;
        }
        crossPostResults.push({
          key: targetKey,
          ok: true,
          writeVerification: targetWv?.forkSuspected ? targetWv : undefined
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.debug('Cross-post target failed (non-fatal)', {
          sourceKey: key,
          targetKey,
          messageId: message.id,
          error: errMsg
        });
        crossPostResults.push({ key: targetKey || 'unknown', ok: false, error: errMsg });
      }
    }
  }

  const crossPostOk = crossPostResults.filter(r => r.ok).length;
  const crossPostFail = crossPostResults.length - crossPostOk;
  // #3774 critère 3 — le drapeau redevient visible côté appelant : une escalade
  // cross-post qui dévie vers un fork est une escalade qui n'a pas eu lieu.
  const crossPostForked = crossPostResults.filter(r => r.writeVerification);
  const crossPostForkSuffix = crossPostForked.length > 0
    ? ` — 🚨 [FORK SUSPECTÉ #3482] cross-post: ${crossPostForked.map(r => r.key).join(', ')} (${crossPostForked[0].writeVerification?.forkDetail ?? 'détection sans détail'}). RELIRE ces canoniques avant tout retry.`
    : '';
  const crossPostSuffix = crossPostResults.length > 0
    ? ` (cross-post: ${crossPostOk}/${crossPostResults.length} OK${crossPostFail > 0 ? `, ${crossPostFail} échecs` : ''})${crossPostForkSuffix}`
    : '';

  // 2026-04-20: Clamp archivedCount to non-negative. When LLM failure injects
  // an [ERROR] CONDENSATION CANCELLED message, `newlyArchived = beforeCount -
  // finalDashboard.intercom.messages.length` goes negative (the +1 system
  // message). That's mathematically consistent but misleads clients that read
  // `archivedCount` as "messages archived". The truth lives in
  // `condenseDiagnostic[].outcome`. Clients needing the signed delta can
  // compute it from sizes.
  const reportedArchivedCount = Math.max(0, archivedCount);

  // Build a diagnostic suffix for the human message whenever condensation was
  // attempted — so the failure mode is visible in the primary tool result
  // (not just in condenseDiagnostic which some consumers won't inspect).
  // Surface condensation failures in the PRIMARY tool result regardless of the
  // `condensed` flag. The truncation fallback archives messages (so condensed=true)
  // yet the LLM failed — without this, the agent sees "auto-condensation OK" and never
  // learns the summary was brute-truncated. User mandate 2026-06-01: explicit, not opaque.
  let diagSuffix = '';
  const failedDiags = condenseDiagnostics.filter(d =>
    d.outcome === 'llm-failed-dedup' || d.outcome === 'llm-failed-injected' || d.outcome === 'fallback-truncated'
  );
  if (failedDiags.length > 0) {
    const first = failedDiags[0];
    const totalS = Math.round(failedDiags.reduce((sum, d) => sum + d.elapsedMs, 0) / 1000);
    const summary = first.llm?.summary;
    const status = first.llm?.status;
    const llmBits: string[] = [];
    if (summary) llmBits.push(`summary=${summary.finalOutcome}×${summary.attempts}`);
    if (status) llmBits.push(`status=${status.finalOutcome}×${status.attempts}`);
    // Explicit underlying cause — HTTP status / timeout+endpoint — not just the label.
    const why = summary?.lastError || status?.lastError || '';
    const dedupNote = failedDiags.some(d => d.outcome === 'llm-failed-dedup')
      ? ' [recent error msg within dedup window → not re-injected]' : '';
    const truncNote = failedDiags.some(d => d.outcome === 'fallback-truncated')
      ? ' [truncation fallback: messages archived WITHOUT LLM summary]' : '';
    const head = llmBits.length > 0 ? `LLM échoué (${totalS}s, ${llmBits.join(', ')})` : `condensation dégradée (${totalS}s)`;
    diagSuffix = ` — ⚠️ ${head}${why ? `: ${why}` : ''}${dedupNote}${truncNote}`;
  }

  // #2719 review follow-up (ai-01, #1233 non-blocking): a `fallback-cloud` pass left
  // no trace in the primary tool-result message — the degraded provenance was only
  // visible in condenseDiagnostic[].outcome. Neutral marker (no ⚠️): messages were
  // NOT lost, the salvage succeeded — but the caller should know it ran on the cloud.
  const cloudSalvaged = condenseDiagnostics.filter(d => d.outcome === 'fallback-cloud');
  const cloudSuffix = cloudSalvaged.length > 0
    ? ` — [cloud fallback: primary LLM down, condensation salvaged by cloud (${cloudSalvaged.length} dashboard${cloudSalvaged.length > 1 ? 's' : ''})]`
    : '';

  const totalMs = Date.now() - appendStart;
  const splitSuffix = isMultiPart ? ` [split en ${newMessages.length} parts]` : '';

  // #1791: Auto-register heartbeat on dashboard append (fire-and-forget)
  recordRooSyncActivityAsync('dashboard-append', { key, type: args.type });

  // #2719 (dispatch ai-01 26/09): structured top-level exposure of the summary
  // loss — condensed stays true (the archive DID happen, and a false would imply
  // the messages are still visible), but the silent-success shape is gone.
  const summaryFailed = condenseDiagnostics.some(d => d.outcome === 'fallback-truncated');

  return {
    success: true,
    action: 'append',
    key,
    type: args.type!,
    request: requestEcho,
    sizes: buildSizes(finalDashboard),
    messageCount: finalDashboard.intercom.messages.length,
    condensed,
    archivedCount: reportedArchivedCount,
    summaryFailed: summaryFailed || undefined,
    crossPost: crossPostResults.length > 0 ? crossPostResults : undefined,
    condenseDiagnostic: condenseDiagnostics.length > 0 ? condenseDiagnostics : undefined,
    splitCount: newMessages.length,
    warning: guardAWarning,
    writeVerification: writeVerify.forkSuspected ? writeVerify : undefined,
    durationBreakdown: {
      totalMs,
      preemptiveCondenseMs,
      reactiveCondenseMs,
      writeMs
    },
    message: `Message ajouté au dashboard '${key}'${splitSuffix}${condensed ? ` (auto-condensation: ${reportedArchivedCount} messages archivés, taille réduite)` : ''}${diagSuffix}${cloudSuffix}${crossPostSuffix}${writeVerify.forkSuspected ? ` — 🚨 [FORK SUSPECTÉ #3482] ${writeVerify.forkDetail ?? ''}${writeVerify.forkPath ? ` (${writeVerify.forkPath})` : ''}. L'écriture a peut-être dévié vers un fork DriveFS : RELIRE le canonique avant tout retry — re-poster seulement si le message y est absent (intercom-protocol §append expiré).` : ''}`
  };
}

/**
 * read_overview: Vue concaténée des 3 niveaux de dashboard en un seul appel.
 * Retourne global + machine + workspace avec troncature.
 * (#808 Proposition 1)
 */
async function handleReadOverview(
  resolvedMachineId: string,
  resolvedWorkspace: string,
  args: DashboardArgs,
  requestEcho: DashboardRequestEcho
): Promise<DashboardResult> {
  // #3459: fail-closed — a missing store must not render as "0/3 dashboards".
  try {
    assertSharedStoreAccessible();
  } catch (err) {
    return {
      success: false,
      action: 'read_overview',
      key: `overview-${resolvedMachineId}-${resolvedWorkspace}`,
      type: 'overview',
      request: requestEcho,
      message: (err as Error).message
    };
  }

  // read_overview still uses a small limit since it combines 3 dashboards
  const intercomLimit = args.intercomLimit ?? 5;
  const STATUS_MAX_LENGTH = 2000;

  const dashboardTypes: Array<{ type: Dashboard['type']; label: string }> = [
    { type: 'global', label: 'Global' },
    { type: 'machine', label: 'Machine' },
    { type: 'workspace', label: 'Workspace' },
  ];

  const overview: Record<string, {
    key: string;
    status: string;
    intercom: { totalMessages: number; recentMessages: IntercomMessage[] };
    lastModified: string;
    lastModifiedBy: Author;
  } | null> = {};

  let foundCount = 0;

  for (const { type } of dashboardTypes) {
    const key = buildDashboardKey(type, resolvedMachineId, resolvedWorkspace);
    const dashboard = await readDashboardFile(key);

    if (dashboard) {
      foundCount++;
      const statusText = dashboard.status.markdown;
      overview[type] = {
        key,
        status: statusText.length > STATUS_MAX_LENGTH
          ? statusText.substring(0, STATUS_MAX_LENGTH) + `\n\n... (tronqué, ${statusText.length} chars total)`
          : statusText,
        intercom: {
          totalMessages: dashboard.intercom.messages.length,
          recentMessages: dashboard.intercom.messages.slice(-intercomLimit)
        },
        lastModified: dashboard.lastModified,
        lastModifiedBy: dashboard.lastModifiedBy
      };
    } else {
      overview[type] = null;
    }
  }

  const jsonResult: DashboardResult = {
    success: true,
    action: 'read_overview',
    key: `overview-${resolvedMachineId}-${resolvedWorkspace}`,
    type: 'overview',
    request: requestEcho,
    overview,
    message: `Vue d'ensemble: ${foundCount}/3 dashboards trouvés (machine: ${resolvedMachineId}, workspace: ${resolvedWorkspace})`
  };

  // #1832: markdown format (default) for read_overview
  if (args.format !== 'json') {
    const parts: string[] = [`# Dashboard Overview (${resolvedMachineId}/${resolvedWorkspace})\n`];
    for (const { type, label } of dashboardTypes) {
      const entry = overview[type];
      parts.push(`## ${label}${entry ? '' : ' — *non trouvé*'}\n`);
      if (entry) {
        parts.push(entry.status);
        if (entry.intercom.totalMessages > 0) {
          parts.push(`\n### Intercom (${entry.intercom.totalMessages} messages, ${entry.intercom.recentMessages.length} récents)\n`);
          for (const msg of entry.intercom.recentMessages) {
            parts.push(`- **[${msg.timestamp}]** ${msg.author.machineId}|${msg.author.workspace}: ${msg.content.split('\n')[0]}`);
          }
        }
      }
      parts.push('');
    }
    jsonResult.markdownContent = parts.join('\n');
  }

  return jsonResult;
}

/**
 * #3482-follow — a canonical dashboard key whose folder also holds DriveFS
 * conflict copies (`<key> (N).md`).
 *
 * WHY this exists: the fork guard of #3482 only fires AFTER a write has been
 * deviated (post-write verification), i.e. once the damage is done and a
 * message may be invisible to the canonical. `action:"list"` is the first call
 * an agent makes, and until now it reported the forks as ordinary dashboards —
 * a reader could not tell `workspace-CoursIA` from `workspace-CoursIA (2)`.
 *
 * Measured on po-2024 (2026-09-21): 5 forked keys on 72 dashboards, two of them
 * STILL receiving writes hours after the collision, and one family nested two
 * levels deep (` (1) (1)`).
 *
 * Detection is filesystem-only and cannot fail the listing: it is a signal for
 * the operator, and the remedy stays `roosync_dashboard merge` (the fork's own
 * content may or may not be entirely contained in the canonical — the merge
 * report is what tells them apart).
 */
export interface DashboardForkGroup {
  /** Canonical key the conflict copies belong to (all ` (N)` markers stripped). */
  canonical: string;
  /** False when only the copies exist — the canonical file itself is missing. */
  canonicalPresent: boolean;
  /** The conflict-copy keys, sorted. */
  forks: string[];
}

/** Group forked keys by the canonical key they shadow. Pure — no I/O. */
export function detectDashboardForks(keys: string[]): DashboardForkGroup[] {
  const present = new Set(keys);
  const byCanonical = new Map<string, string[]>();
  for (const key of keys) {
    if (!isGdriveConflictCopyFile(key)) continue;
    const canonical = canonicalKeyOfFork(key);
    const forks = byCanonical.get(canonical);
    if (forks) forks.push(key);
    else byCanonical.set(canonical, [key]);
  }
  return [...byCanonical.entries()]
    .map(([canonical, forks]) => ({
      canonical,
      canonicalPresent: present.has(canonical),
      forks: forks.sort(),
    }))
    .sort((a, b) => a.canonical.localeCompare(b.canonical));
}

async function handleList(requestEcho: DashboardRequestEcho): Promise<DashboardResult> {
  // #3459: fail-closed. A missing store must never be reported as "0 dashboards".
  try {
    assertSharedStoreAccessible();
  } catch (err) {
    return {
      success: false,
      action: 'list',
      key: '',
      type: '',
      request: requestEcho,
      dashboards: [],
      message: (err as Error).message
    };
  }

  // #1410 item 4: auto-cleanup stale worktree dashboards before listing
  const cleanedUp = await cleanupStaleWorktreeDashboards();

  const dir = getDashboardsDir();
  try {
    ensureStoreSubdir(getSharedStatePath(), 'dashboards');
    const files = await fs.readdir(dir);
    const mdFiles = files.filter(f => f.endsWith('.md') && !f.endsWith('.tmp'));
    // #3782 — les clés retirées (marque active, posée par un merge) n'existent
    // pas pour un lecteur : ni dans les résumés, ni dans les familles de forks.
    // Le FICHIER reste (deleteSource gouverne le fichier, la marque gouverne la
    // visibilité) — un opérateur qui lève la marque rend la clé listable à nouveau.
    const retiredKeys = await listRetiredDashboardKeys();
    const summaries: DashboardSummary[] = [];

    for (const file of mdFiles) {
      const key = file.replace(/\.md$/, '');
      if (retiredKeys.has(key)) continue;
      try {
        const dashboard = await readDashboardFile(key);
        if (dashboard) {
          const sizes = buildSizes(dashboard);
          summaries.push({
            key: dashboard.key,
            type: dashboard.type,
            lastModified: dashboard.lastModified,
            lastModifiedBy: dashboard.lastModifiedBy,
            messageCount: dashboard.intercom.messages.length,
            statusLength: sizes.statusLength,
            intercomLength: sizes.intercomLength,
            totalLength: sizes.totalLength,
            utilizationPct: sizes.utilizationPct
          });
        }
      } catch {
        // Skip malformed dashboards
      }
    }

    summaries.sort((a, b) => b.lastModified.localeCompare(a.lastModified));
    const cleanupNote = cleanedUp > 0 ? ` (${cleanedUp} worktree(s) expiré(s) archivé(s))` : '';

    // #3482-follow — enumerate conflict copies so a reader can tell a fork from
    // its canonical. Purely informational: never touches the store, never fails
    // the listing (a detector that can break `list` would be a regression).
    let forks: DashboardForkGroup[] = [];
    try {
      forks = detectDashboardForks(
        mdFiles.map(f => f.replace(/\.md$/, '')).filter(k => !retiredKeys.has(k))
      );
      for (const group of forks) {
        logger.warn('[DASHBOARD-FORK] clé(s) forkée(s) détectée(s) (#3482) — writers potentiellement divergents', {
          canonical: group.canonical,
          forks: group.forks,
          canonicalPresent: group.canonicalPresent
        });
      }
    } catch (err) {
      logger.debug('Détection de forks impossible (non bloquant)', {
        error: err instanceof Error ? err.message : String(err)
      });
    }
    const forkNote = forks.length > 0
      ? ` — 🚨 ${forks.length} famille(s) forkée(s) [FORK #3482]: ${forks
          .map(g => `${g.canonical}${g.canonicalPresent ? '' : ' (canonique ABSENT)'} ← ${g.forks.join(', ')}`)
          .join(' | ')}. Le même dashboard est lisible sous plusieurs clés : RELIRE le canonique avant d'agir sur un fork, et remède = roosync_dashboard merge (le rapport de merge dit si le contenu du fork est déjà contenu dans le canonique).`
      : '';

    return {
      success: true,
      action: 'list',
      key: '',
      type: '',
      request: requestEcho,
      dashboards: summaries,
      ...(forks.length > 0 ? { forks } : {}),
      message: `${summaries.length} dashboard(s) trouvé(s)${cleanupNote}${forkNote}`
    };
  } catch (error) {
    return {
      success: true,
      action: 'list',
      key: '',
      type: '',
      request: requestEcho,
      dashboards: [],
      message: 'Répertoire dashboards vide ou inexistant'
    };
  }
}

/**
 * Safety threshold: dashboards modified within this period cannot be deleted.
 * Protection against accidental mass-deletion by agents (incident 2026-04-05 #1128).
 */
const DASHBOARD_PROTECTION_DAYS = 7;

// #1410 item 4: Worktree dashboard cleanup thresholds
const WORKTREE_DASHBOARD_PATTERN = /^workspace-wt-/;
const WORKTREE_CLEANUP_MAX_STATUS_LENGTH = 100;

/**
 * #1410 item 4: Clean up stale worktree dashboards.
 *
 * When agents run in worktrees (.claude/worktrees/wt-*), the worktree detection
 * (#1364) resolves the parent workspace. But before that fix, or if detection fails,
 * orphan dashboard files like `workspace-wt-worker-*` accumulate. This function
 * archives dashboards matching the worktree pattern that are both:
 *   - Older than DASHBOARD_PROTECTION_DAYS (7 days)
 *   - Have a status section shorter than WORKTREE_CLEANUP_MAX_STATUS_LENGTH chars
 *
 * Called during `list` action so stale entries don't pollute the dashboard list.
 * Archives (not deletes) for safety.
 */
async function cleanupStaleWorktreeDashboards(): Promise<number> {
  const dir = getDashboardsDir();
  try {
    const files = await fs.readdir(dir);
    const wtFiles = files.filter(f =>
      f.endsWith('.md') && WORKTREE_DASHBOARD_PATTERN.test(f.replace(/\.md$/, ''))
    );

    if (wtFiles.length === 0) return 0;

    let archived = 0;
    const now = Date.now();

    for (const file of wtFiles) {
      const key = file.replace(/\.md$/, '');
      try {
        const dashboard = await readDashboardFile(key);
        if (!dashboard) continue;

        const ageMs = now - new Date(dashboard.lastModified).getTime();
        const ageDays = ageMs / (1000 * 60 * 60 * 24);
        const sizes = buildSizes(dashboard);

        if (ageDays >= DASHBOARD_PROTECTION_DAYS && sizes.statusLength < WORKTREE_CLEANUP_MAX_STATUS_LENGTH) {
          const archiveDir = getArchiveDir();
          ensureStoreSubdir(getSharedStatePath(), 'dashboards', 'archive');
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
          const archivePath = path.join(archiveDir, `${key}-wt-cleanup-${timestamp}.md`);
          const originalPath = path.join(dir, file);
          const content = await fs.readFile(originalPath, 'utf8');
          // #3584 (rétention) — copie hors writeDashboardFile : masquer (cf. pre-delete).
          await fs.writeFile(archivePath, maskSecretText(content), 'utf8');
          await fs.unlink(originalPath);
          archived++;
          logger.info('Archived stale worktree dashboard', {
            key, ageDays: ageDays.toFixed(1), statusLength: sizes.statusLength
          });
        }
      } catch (e) {
        logger.warn('Failed to process worktree dashboard for cleanup', {
          key, error: e instanceof Error ? e.message : String(e)
        });
      }
    }
    return archived;
  } catch {
    return 0;
  }
}

/**
 * #3537 §6.2 — gardes PURES du merge (validation d'entrée, store joignable,
 * asymétrie PG). Exécutées par le dispatcher AVANT toute acquisition de verrou
 * append : une clé brute traversante ne doit jamais atteindre un path.join
 * (fichier de verrou écrit hors store), et un refus métier ne doit pas se
 * laisser masquer par un refus de verrou sur un répertoire absent.
 *
 * @returns le résultat REFUSÉ, ou null si les gardes passent.
 */
function mergeGuardRefusal(
  sourceKey: string,
  key: string,
  args: DashboardArgs
): DashboardResult | null {
  const base: Pick<DashboardResult, 'action' | 'key' | 'type'> = {
    action: 'merge',
    key,
    type: args.type ?? ''
  };
  if (!sourceKey) {
    return {
      ...base,
      success: false,
      message: "⛔ REFUSÉ: sourceKey est requis pour action=merge — clé brute telle que listée par action=list (ex. 'machine-myia-po-2025 (1)')."
    };
  }
  if (sourceKey === key) {
    return {
      ...base,
      success: false,
      message: `⛔ REFUSÉ: la source '${sourceKey}' EST la clé cible — rien à fusionner.`
    };
  }
  // Revue #1134 — assainissement : sourceKey est la SEULE entrée de chemin
  // brut de cet outil (toutes les autres actions dérivent leur clé d'entrées
  // contraintes). Refuser séparateurs, '..' et ':' avant TOUT path.join — un
  // traversal ne doit ni verrouiller, ni lire, ni archiver, ni unlink hors du
  // store. (':' est de toute façon illégal dans un nom de fichier de la flotte
  // Windows.)
  if (/[\\/:]/.test(sourceKey) || sourceKey.includes('..')) {
    return {
      ...base,
      success: false,
      message: `⛔ REFUSÉ: sourceKey '${sourceKey}' contient des caractères de chemin (séparateur, '..' ou ':') — une clé est un nom plat tel que listé par action=list, jamais un chemin.`
    };
  }
  // #3459: fail-closed — ne pas réparer des clés dans un store injoignable.
  try {
    assertSharedStoreAccessible();
  } catch (err) {
    return { ...base, success: false, message: (err as Error).message };
  }
  // Revue #1134 — garde anti-écrasement-à-l'aveugle : un hôte qui DUAL-ÉCRIT
  // PG sans le LIRE (porte UNIFIED_STORE_DASHBOARD_READ_PG fermée) ferait une
  // union qui ne voit que les fichiers, puis dualWriteDashboardSync
  // remplacerait le journal PG de la cible — anéantissant tout message vivant
  // uniquement en PG, sans archive. Conditions lues sur l'env (miroir exact du
  // writer-factory, sans l'instantier) : refuser l'asymétrie écrit-sans-lire ;
  // un monde sans PG du tout reste légitime (rien à écraser).
  const pgReadable = getDashboardPgReader() !== null;
  const pgWritable = process.env.UNIFIED_STORE_DUAL_WRITE === '1' && !!process.env.UNIFIED_STORE_PG_URL;
  if (pgWritable && !pgReadable) {
    return {
      ...base,
      success: false,
      message:
        "⛔ REFUSÉ: cet hôte dual-écrit PG (UNIFIED_STORE_DUAL_WRITE=1) sans le lire " +
        '(UNIFIED_STORE_DASHBOARD_READ_PG≠1) — le merge ferait une union aveugle aux messages présents ' +
        'uniquement en PG, puis écraserait leur journal. Exécuter le merge depuis un hôte qui LIT le ' +
        'store PG (UNIFIED_STORE_DASHBOARD_READ_PG=1), ou désactiver le dual-write ici.'
    };
  }
  return null;
}

/**
 * #3537 §6.2 — Fusion d'une clé fork/parasite dans la clé cible.
 *
 * Pourquoi cette action existe : un dashboard vit dans DEUX artefacts co-égaux
 * (fichier GDrive `.shared-state/dashboards/<key>.md` + tables PG
 * `roosync_dashboards`/`roosync_dashboard_messages`, #3151 Phase C). Un geste
 * de système de fichiers (renommer/supprimer un ` (1)`) ne répare que la moitié
 * fichier et laisse la moitié PG — celle que servent les hôtes à porte PG
 * ouverte — intacte, SANS erreur. Seul le canal API écrit les deux
 * (writeDashboardFile → dualWriteDashboardSync ; retrait du journal → MARQUE
 * `roosync_dashboard_retirements` #3782, jamais un DELETE — les lignes
 * restent en base, gel des purges, geste réversible par `lifted_at`).
 *
 * Sémantique :
 *   - journal : union par id de message sur les QUATRE vues distinctes (PG +
 *     fichier de chaque clé) ; sur doublon, la copie au timestamp le plus
 *     récent gagne (égalité → cible). Tri par timestamp.
 *   - statut : celui de la vue au STATUT le plus récent — horodatage de
 *     condensation (lastCondensedAt) en premier critère quand les deux vues
 *     de la paire en portent un, repli lastModified sinon (#3782 §3).
 *   - cible absente : chemin RENAME pur (le contenu de la source devient la
 *     cible sous la clé canonique — cas po-2025 : canonique manquant).
 *   - `deleteSource` ne gouverne QUE LE FICHIER (#3782, arbitrage 5844675985) :
 *     true (défaut) → archivage par RENOMMAGE ATOMIQUE puis retrait du
 *     fichier ; false → fichier préservé tel quel. Dans les DEUX cas le
 *     JOURNAL retire la source par une MARQUE `roosync_dashboard_retirements`
 *     (posée en DERNIER, gated sur la persistance vérifiée de l'union) : les
 *     lignes restent en base, mais read/list/fork-detector ignorent la clé et
 *     les écritures adressées à la clé atterrissent sur la cible (anti-rebirth).
 *
 * Trois gardes d'intégrité (revue #1134 + rework) :
 *   1. ANTI-ÉCRASEMENT À L'AVEUGLE : un hôte qui dual-écrit PG sans le lire
 *      (porte UNIFIED_STORE_DASHBOARD_READ_PG fermée) ferait une union aveugle
 *      aux messages vivant uniquement en PG, puis écraserait leur journal —
 *      refus net ; le merge court sur un hôte qui voit ce qu'il écrase, ou
 *      dans un monde sans PG.
 *   2. PERSISTANCE PG VÉRIFIÉE (rework, ask 2) : la marque de retraite de la
 *      source ne se pose que si le upsert PG de la cible est CONFIRMÉ (outcome
 *      `written` ou `disabled` — pas de moitié PG sur cet hôte). L'ancien chemin
 *      avalait les échecs (dualWriteDashboardSync → withRetry void) : un merge
 *      sous breaker OPEN aurait retiré la source pendant que l'union n'existe
 *      nulle part en PG. Sur échec : union écrite dans le FICHIER cible,
 *      source INTACTE, rapport honnête.
 *   3. ARCHIVE PAR RENOMMAGE ATOMIQUE (rework, ask 1) : l'archive EST le
 *      geste de retrait du fichier — un seul syscall, pas de fenêtre
 *      read→write→unlink. Un append concurrent d'une autre machine DANS la
 *      fenêtre lecture→rename est rattrapé par la re-union post-rename (les
 *      octets archivés sont re-parsés ; tout message absent de l'union y est
 *      réintégré et la cible réécrite) ; un append APRÈS le rename recrée le
 *      fichier source — détecté par re-stat après la marque et rapporté
 *      non-silencieusement (jamais écrasé : c'est une écriture vivante ; la
 *      marque redirige désormais les appends suivants vers la cible).
 *
 * Le verrou append cross-process sur les DEUX clés est acquis en amont par le
 * dispatcher, en mode FAIL-CLOSED (withAppendLockRequired) — pas de merge sans
 * exclusion.
 *
 * Pas de gate d'âge type DASHBOARD_PROTECTION_DAYS : contrairement à delete, le
 * contenu n'est PAS perdu (union dans la cible + archive de sécurité) — fusionner
 * un fork VIVANT est précisément le cas d'usage (la recréation silencieuse reste
 * couverte par le WARN [NEW-KEY] de createEmptyDashboard, #3537 §6.4).
 */
async function handleMerge(
  key: string,
  args: DashboardArgs,
  resolvedMachineId: string,
  resolvedWorkspace: string,
  requestEcho: DashboardRequestEcho
): Promise<DashboardResult> {
  // Gardes pures (mergeGuardRefusal) déjà passées par le dispatcher AVANT les
  // verrous ; sourceKey est ici non vide, plate, ≠ cible, store joignable,
  // asymétrie PG impossible.
  const sourceKey = String(args.sourceKey ?? '').trim();
  const deleteSource = args.deleteSource !== false; // défaut: true
  const author: Author = args.author ?? {
    machineId: resolvedMachineId,
    workspace: resolvedWorkspace
  };
  const base: Pick<DashboardResult, 'action' | 'key' | 'type' | 'request'> = {
    action: 'merge',
    key,
    type: args.type ?? '',
    request: requestEcho
  };

  // Relecture des DEUX vues de CHAQUE clé (revue #1134) : vue PG (si la porte
  // du hôte l'expose) ET vue fichier. Sur une clé où fichier et PG divergent
  // (15/63 mesurés, #3537 §2), une union fondée sur une seule vue écraserait
  // les messages vivant uniquement dans l'autre artefact.
  const sourcePg = await readDashboardFromPg(sourceKey);
  const sourceFileView = await readDashboardFromGdrive(sourceKey);
  if (!sourcePg && !sourceFileView) {
    return {
      ...base,
      success: false,
      message: `⛔ REFUSÉ: le dashboard source '${sourceKey}' n'existe ni dans le store PG ni sur GDrive — rien à fusionner (les clés listées par action=list font foi).`
    };
  }
  const targetPg = await readDashboardFromPg(key);
  const targetFileView = await readDashboardFromGdrive(key);

  // Ordre = priorité d'insertion dans l'union (la copie déjà en place gagne
  // les égalités de timestamp → cible avant source) ET déduplication par
  // IDENTITÉ d'objet : porte PG fermée, la vue « autoritaire » EST la vue
  // fichier — la compter deux fois gonflerait les doublons du rapport.
  const distinctViews: Dashboard[] = [];
  for (const v of [targetPg ?? targetFileView, targetFileView, sourcePg ?? sourceFileView, sourceFileView]) {
    if (v && !distinctViews.includes(v)) distinctViews.push(v);
  }

  const source = (sourcePg ?? sourceFileView)!;
  const target = targetPg ?? targetFileView ?? null;
  const sourceViews = new Set<Dashboard>(
    [sourcePg, sourceFileView].filter((v): v is Dashboard => v !== null)
  );

  // Garde de type : fusionner un workspace dans une clé machine est une erreur
  // d'opérateur, pas une réparation.
  const targetType = target?.type ?? args.type!;
  if (source.type !== targetType) {
    return {
      ...base,
      success: false,
      message: `⛔ REFUSÉ: type mismatch — la source '${sourceKey}' est de type '${source.type}', la cible '${key}' de type '${targetType}'.`
    };
  }

  // --- Union des journaux de toutes les vues distinctes, par id, la copie au
  // timestamp le plus récent gagne (égalité → première insérée : cible d'abord) ---
  const byId = new Map<string, IntercomMessage>();
  let totalSeen = 0;
  let newerSourceWins = 0;
  for (const view of distinctViews) {
    totalSeen += view.intercom.messages.length;
    for (const m of view.intercom.messages) {
      const existing = byId.get(m.id);
      if (!existing) {
        byId.set(m.id, m);
      } else if (m.timestamp > existing.timestamp) {
        byId.set(m.id, m);
        if (sourceViews.has(view)) newerSourceWins++;
      } // égalité → la copie déjà en place reste
    }
  }
  let mergedMessages = [...byId.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const deduped = totalSeen - mergedMessages.length;

  // --- Statut : celui de la vue dont le STATUT est le plus récent, pas celle
  // dont le fichier l'est. `lastModified` est bumpé par TOUTE écriture, appends
  // compris : un fork vivant l'emportait alors qu'il porte une copie FIGÉE du
  // statut (#3782 §3 — mesuré le 23/09 : 11 964 caractères dans le fork contre
  // 14 993 sur la clé canonique ; le fork gagnait parce qu'il recevait des
  // appends, et le statut union aurait régressé de 3 Ko).
  // `intercom.lastCondensedAt` est le seul horodatage du statut lui-même : il
  // n'est posé que par les chemins de condensation, qui sont les seuls à
  // réécrire le statut automatiquement. Il tranche donc les vues qui en portent
  // un toutes les deux (le fork d'un incident DriveFS porte celui de la copie
  // qu'il a gelée, donc antérieur). Hors de ce cas — une vue jamais condensée,
  // ou deux horodatages égaux — le critère reste `lastModified` : une vue sans
  // horodatage ne porte aucune preuve de fraîcheur de statut, et son statut peut
  // avoir été écrit par `write`/`update`, qui n'en posent pas.
  // NB : js-yaml parse les timestamps frontmatter non quotés en Date — et
  // `Date > string ISO` rend TOUJOURS false en JS. Normaliser en ISO avant
  // toute comparaison.
  const lastModifiedIso = (v: string | Date | undefined): string =>
    v instanceof Date ? v.toISOString() : String(v ?? '');
  const statusStamp = (v: Dashboard): string | undefined =>
    v.intercom.lastCondensedAt === undefined ? undefined : lastModifiedIso(v.intercom.lastCondensedAt);
  const fresherBy = (v: Dashboard, best: Dashboard): 'stamp' | 'lastModified' | null => {
    const vStamp = statusStamp(v);
    const bestStamp = statusStamp(best);
    if (vStamp !== undefined && bestStamp !== undefined && vStamp !== bestStamp) {
      return vStamp > bestStamp ? 'stamp' : null;
    }
    return lastModifiedIso(v.lastModified) > lastModifiedIso(best.lastModified) ? 'lastModified' : null;
  };
  // Le critère rapporté est celui de la DERNIÈRE paire évaluée : le choix se
  // fait par paire (`fresherBy`), et avec des vues mixtes — certaines
  // horodatées, d'autres non — une reconstitution globale annoncerait
  // `lastModified` alors que la paire finale a pu être tranchée par
  // l'horodatage. Null = vue unique, aucun arbitrage n'a eu lieu.
  let statusBasis: 'stamp' | 'lastModified' | null = null;
  const pairBasis = (v: Dashboard, best: Dashboard): 'stamp' | 'lastModified' => {
    const vStamp = statusStamp(v);
    const bestStamp = statusStamp(best);
    return vStamp !== undefined && bestStamp !== undefined && vStamp !== bestStamp ? 'stamp' : 'lastModified';
  };
  const statusHolder = distinctViews.reduce<Dashboard>(
    (best, v) => {
      if (v === best) return best; // seed = distinctViews[0] : la 1re paire est une self-paire
      statusBasis = pairBasis(v, best);
      return fresherBy(v, best) === null ? best : v;
    },
    distinctViews[0]
  );
  const statusFromSource = sourceViews.has(statusHolder);
  const lastDiffCommit =
    targetPg?.status.lastDiffCommit ??
    targetFileView?.status.lastDiffCommit ??
    source.status.lastDiffCommit;
  const lastCondensedAt = distinctViews
    .map(v => v.intercom.lastCondensedAt)
    .filter((v): v is string => v !== undefined)
    .map(lastModifiedIso)
    .sort()
    .pop();

  let merged: Dashboard = {
    type: targetType,
    key,
    lastModified: new Date().toISOString(),
    lastModifiedBy: author,
    status: {
      markdown: statusHolder?.status.markdown ?? '',
      ...(lastDiffCommit !== undefined ? { lastDiffCommit } : {})
    },
    intercom: {
      messages: mergedMessages,
      // Compteur monotone flotte (#3482 verify guard) : ne jamais régresser.
      totalMessages: Math.max(
        ...distinctViews.map(v => v.intercom.totalMessages ?? 0),
        mergedMessages.length
      ),
      ...(lastCondensedAt !== undefined ? { lastCondensedAt } : {})
    }
  };

  const writeVerification = await writeDashboardFile(key, merged);

  // Rework #1134 (ask 2) — persistance PG VÉRIFIÉE : writeDashboardFile vient
  // de dual-écrire en mode avalé ; la variante checked rejoue le même upsert
  // (idempotent : upsert + ON CONFLICT) et rend l'issue. La suppression de la
  // source est GATING sur ce résultat : sous breaker OPEN, erreur déterministe
  // #3342 ou épuisement des retries, l'union n'est pas garanties en PG —
  // retirer la source détruirait alors des messages qui n'existent plus que
  // dans son journal PG.
  const pgOutcome = await dualWriteDashboardSyncChecked(merged);
  const pgPersisted = pgOutcome.ok || pgOutcome.reason === 'disabled';
  if (!pgPersisted) {
    logger.error(
      `[MERGE] #3537 §6.2 — union écrite dans le FICHIER cible mais PG ne l'a PAS persistée : suppression de la source DIFFÉRÉE`,
      {
        sourceKey,
        targetKey: key,
        pgOutcome,
        mergedMessages: mergedMessages.length
      }
    );
    return {
      ...base,
      success: true,
      messageCount: mergedMessages.length,
      writeVerification: writeVerification.forkSuspected ? writeVerification : undefined,
      message:
        `Clé '${sourceKey}' fusionnée dans '${key}' côté FICHIER : ${mergedMessages.length} msg après union ` +
        `(${deduped} doublon(s) par id, ${newerSourceWins} résolu(s) vers la copie plus récente). ` +
        `⛔ MAIS la moitié PG n'a PAS persisté l'union (${pgOutcome.reason}${pgOutcome.detail ? ` : ${pgOutcome.detail}` : ''}) — ` +
        `SUPPRESSION DE LA SOURCE DIFFÉRÉE : son journal PG reste la seule trace des messages non encore dans la cible. ` +
        `Source INTACTE. Réessayer le merge une fois PG revenu (l'union est idempotente).`
    };
  }

  // Revue #1134 — honore le drapeau #3482 : si l'écriture cible est SOUPÇONNÉE
  // d'avoir été déviée vers un fork DriveFS ÉTRANGER, la suppression de la
  // source est abandonnée (irréversible, et le canonique ne reflète peut-être
  // pas l'union). Exception voulue : si le fork soupçonné EST la source
  // elle-même, c'est la configuration attendue d'une réparation de fork
  // vivant — le fichier ` (1)` est frais dans le répertoire par construction.
  // #3774 review ai-01 (MAJEUR) — ce prédicat ne voit que le `forkPath` du
  // contrôle HÉRITÉ (regex `(N)` + fenêtre d'écriture). Le scan d'id ne remplit
  // JAMAIS `forkPath` : la source d'un merge porte l'id d'atterrissage PAR
  // CONSTRUCTION (union triée : le dernier message vient de la clé la plus
  // récente), la nommer ferait poursuivre la suppression — inversion du
  // fail-closed. Tout verdict d'id laisse donc `forkPath` undefined ⇒
  // `suspectedForeignFork` vrai ⇒ abandon.
  const sourcePath = getDashboardPath(sourceKey);
  const suspectedForeignFork =
    writeVerification.forkSuspected === true && writeVerification.forkPath !== sourcePath;
  if (deleteSource && suspectedForeignFork) {
    logger.error(
      `[MERGE] #3537 §6.2 — suppression de la source ABANDONNÉE : écriture cible soupçonnée d'avoir été déviée (#3482)`,
      {
        sourceKey,
        targetKey: key,
        forkDetail: writeVerification.forkDetail,
        forkPath: writeVerification.forkPath,
        remediation:
          'DriveFS local probablement wedgé — relire le canonique, redémarrer DriveFS/VS Code, puis re-merger (la source est intacte)'
      }
    );
    return {
      ...base,
      success: true,
      messageCount: mergedMessages.length,
      writeVerification,
      message:
        `Clé '${sourceKey}' fusionnée dans '${key}' : ${mergedMessages.length} msg après union — mais ` +
        `SUPPRESSION DE LA SOURCE ABANDONNÉE : l'écriture cible est soupçonnée d'avoir été déviée par ` +
        `DriveFS (#3482 : ${writeVerification.forkDetail ?? 'détection sans détail'}). La source est ` +
        `INTACTE — relire le canonique, redémarrer DriveFS/VS Code, puis re-merger.`
    };
  }

  let archiveFile: string | null = null;
  let sourceDisposition = '';

  if (!deleteSource) {
    // #3782 (arbitrage 5844675985) — `deleteSource` ne gouverne plus que le
    // FICHIER. Le journal retire la source dans les DEUX cas, par une MARQUE
    // (jamais un DELETE — gel des purges, geste réversible) : l'union PG est
    // déjà vérifiée ci-dessus (early return sinon), les lignes restent en
    // base, seule la visibilité change. Sans marque, un hôte qui lit le
    // fichier préservé continue de nourrir le fork (mesuré J+2 : 101,8 %).
    const retireOutcome = await retireDashboardKeyChecked(
      sourceKey,
      key,
      `${author.machineId}:${author.workspace}`
    );
    const journalRetired = retireOutcome.ok || retireOutcome.reason === 'disabled';
    sourceDisposition = journalRetired
      ? `Source préservée (deleteSource=false) — journal RETIRÉ par marque #3782 vers '${key}' (lignes conservées en base).`
      : `Source préservée (deleteSource=false) — ⚠️ marque de retraite #3782 NON POSÉE (${retireOutcome.reason}${retireOutcome.detail ? ` : ${retireOutcome.detail}` : ''}) : la clé reste visible, réessayer le merge une fois PG revenu (l'union est idempotente).`;
    logger.warn(
      `[MERGE] #3537 §6.2 — clé '${sourceKey}' fusionnée dans '${key}' ; source PRÉSERVÉE (deleteSource=false), journal retiré par marque #3782 (${journalRetired ? 'ok' : 'différé'})`,
      {
        sourceKey,
        targetKey: key,
        mergedMessages: mergedMessages.length,
        retireOutcome,
      }
    );
  } else {
    // Rework #1134 (ask 1) — retrait du fichier source par RENOMMAGE ATOMIQUE
    // vers l'archive : l'archive et le retrait sont UN SEUL geste (plus de
    // fenêtre read→write→unlink). Un append concurrent APRÈS le rename recrée
    // le fichier source — détecté par re-stat après la suppression PG.
    const archiveDir = getArchiveDir();
    ensureStoreSubdir(getSharedStatePath(), 'dashboards', 'archive');
    const now = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    archiveFile = `${sourceKey}-pre-merge-${now}.md`;
    const archivePath = path.join(archiveDir, archiveFile);

    const sourceHasContent =
      source.intercom.messages.length > 0 || (source.status.markdown ?? '').trim().length > 0;
    let renamedFromDisk = false;
    try {
      await fs.rename(sourcePath, archivePath);
      renamedFromDisk = true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        // Échec de renommage ≠ ENOENT (verrou FS, permissions…) : ABANDON du
        // retrait — la source reste intacte, rapport honnête.
        logger.error(`[MERGE] #3537 §6.2 — archivage par renommage échoué, retrait ABANDONNÉ`, {
          sourceKey,
          archivePath,
          error: String(error)
        });
        return {
          ...base,
          success: true,
          messageCount: mergedMessages.length,
          writeVerification: writeVerification.forkSuspected ? writeVerification : undefined,
          message:
            `Clé '${sourceKey}' fusionnée dans '${key}' : ${mergedMessages.length} msg après union ` +
            `(${deduped} doublon(s) par id, ${newerSourceWins} résolu(s) vers la copie plus récente). ` +
            `⛔ Retrait de la source ABANDONNÉ : archivage par renommage échoué (${String(error)}). ` +
            `Source INTACTE — réessayer.`
        };
      }
      // ENOENT : la source n'existe pas en fichier (clé PG-only ou déjà
      // retirée) — sérialiser la vue PG pour que l'archive ne soit jamais
      // vide par construction.
      if (sourceHasContent) {
        // #3584 (rétention) — sérialisation de la vue PG hors writeDashboardFile : masquer.
        await fs.writeFile(
          archivePath,
          maskSecretText(`---\ntype: ${source.type}\nlastModified: ${source.lastModified}\nsourceKey: ${sourceKey}\nmergedInto: ${key}\n---\n\n## Status\n\n${source.status.markdown || '*Aucun contenu.*'}\n\n## Intercom (${source.intercom.messages.length} messages)\n\n${source.intercom.messages
            .map(m => `### [${m.timestamp}] ${m.author.machineId}|${m.author.workspace}\n[msg: ${m.id}]\n\n${m.content}`)
            .join('\n\n---\n\n')}\n`),
          'utf8'
        );
      } else {
        archiveFile = null; // rien à préserver : ni fichier, ni contenu PG
      }
    }

    // Rework #1134 (ask 1) — re-union post-rename : les octets archivés sont
    // la vérité du MOMENT DU RENOMMAGE. S'ils contiennent des messages que la
    // lecture initiale n'avait pas vus (append concurrent dans la fenêtre
    // lecture→rename), ils sont réintégrés et la cible réécrite — le retrait
    // ne doit jamais être l'occasion de perdre une écriture vivante.
    let reUnionedCount = 0;
    let reUnionPersisted = true;
    let reUnionFailDetail: string | null = null;
    if (renamedFromDisk) {
      try {
        const archivedText = await fs.readFile(archivePath, 'utf8');
        const reparsed = parseDashboardMarkdown(archivedText, sourceKey);
        const unseen = reparsed.intercom.messages.filter(m => !byId.has(m.id));
        if (unseen.length > 0) {
          reUnionedCount = unseen.length;
          reUnionPersisted = false; // fail-closed : ne compte comme persistée qu'une fois confirmée en PG
          for (const m of unseen) byId.set(m.id, m);
          mergedMessages = [...byId.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
          merged = {
            ...merged,
            lastModified: new Date().toISOString(),
            intercom: {
              ...merged.intercom,
              messages: mergedMessages,
              totalMessages: Math.max(merged.intercom.totalMessages ?? 0, mergedMessages.length)
            }
          };
          await writeDashboardFile(key, merged);
          // Rework #1134 (review ai-01 11/09) — même geste que le chemin nominal :
          // l'outcome du re-sync PG décide. Sur une erreur déterministe (liée au
          // payload réintégré), le delete — qui ne porte pas ce payload — réussirait
          // quand même et détruirait la seule ligne PG détentrice de ces messages ;
          // les writes suivants rejoueraient la même erreur : pas de cicatrisation.
          const reSyncOutcome = await dualWriteDashboardSyncChecked(merged);
          const reSyncPersisted = reSyncOutcome.ok || reSyncOutcome.reason === 'disabled';
          reUnionPersisted = reSyncPersisted;
          if (!reSyncPersisted) {
            reUnionFailDetail = ` (${reSyncOutcome.reason}${reSyncOutcome.detail ? ` : ${reSyncOutcome.detail}` : ''})`;
            logger.error(
              `[MERGE] #3537 §6.2 — re-union post-rename écrite dans le FICHIER cible mais PG ne l'a PAS persistée : suppression de la ligne PG source DIFFÉRÉE`,
              {
                sourceKey,
                targetKey: key,
                reSyncOutcome,
                reUnionedCount
              }
            );
          }
        }
      } catch (error) {
        // La re-union est un filet : son échec n'invalide pas le merge (l'union
        // initiale est déjà écrite), mais il DOIT être visible. Si des messages
        // avaient été réclamés (reUnionedCount > 0) sans confirmation du sync,
        // reUnionPersisted reste false — le delete PG sera différé.
        logger.warn('[MERGE] re-union post-rename : re-parse ou réécriture de l\'archive échoué', {
          sourceKey,
          archivePath,
          error: String(error)
        });
      }
    }

    // Retrait journal en DERNIER, par MARQUE #3782 (jamais un DELETE — gel des
    // purges : les lignes dashboard + journal restent en base, seules les
    // lectures/listings/détecteur cessent de voir la clé et les écritures sont
    // redirigées vers la cible). Gate re-union (review ai-01) inchangée : si la
    // re-union n'est pas confirmée en PG, le journal de la source reste la
    // seule trace PG des messages réintégrés — marquer la clé la rendrait
    // invisible alors que son contenu n'est pas encore dans la cible ; la
    // marque ne se pose pas (retrait partiel, rapporté ci-dessous).
    const retireOutcome = reUnionPersisted
      ? await retireDashboardKeyChecked(sourceKey, key, `${author.machineId}:${author.workspace}`)
      : undefined;
    const journalRetired = retireOutcome !== undefined && (retireOutcome.ok || retireOutcome.reason === 'disabled');
    let pgDispositionNote = '';
    if (retireOutcome === undefined) {
      pgDispositionNote =
        `. ⚠️ Marque de retraite #3782 DIFFÉRÉE : la re-union post-rename ` +
        `(${reUnionedCount} msg réintégré(s)) n'est pas confirmée en PG` +
        `${reUnionFailDetail ?? ' (chaîne interrompue avant confirmation)'} — le journal de la source ` +
        `est la seule trace PG des messages réintégrés. Réessayer le merge une fois PG revenu (l'union est idempotente).`;
    } else if (!(retireOutcome.ok || retireOutcome.reason === 'disabled')) {
      pgDispositionNote =
        `. ⚠️ La marque de retraite #3782 n'a PAS été posée (${retireOutcome.reason}${retireOutcome.detail ? ` : ${retireOutcome.detail}` : ''}) — ` +
        `retrait partiel : moitié fichier faite, journal encore visible sous la clé source. Le contenu est préservé (union + archive + lignes en base).`;
    }

    // Re-stat : un append concurrent post-rename recrée le fichier source.
    // C'est une écriture VIVANTE (jamais écrasée) — mais l'opérateur doit
    // savoir que la clé fork respire encore. Avec la marque posée, un tel
    // append est redirigé vers la cible (#3782 anti-rebirth) — le fichier
    // recréé reste un cadavre froid que seul un opérateur verra.
    let sourceRecreated = false;
    try {
      await fs.stat(sourcePath);
      sourceRecreated = true;
    } catch {
      // absent — chemin nominal
    }

    logger.warn(
      journalRetired
        ? `[MERGE] #3537 §6.2 — clé '${sourceKey}' fusionnée dans '${key}' ; fichier retiré + journal retiré par marque #3782 (lignes conservées)`
        : `[MERGE] #3537 §6.2 — clé '${sourceKey}' fusionnée dans '${key}' ; marque #3782 ÉCHOUÉE/DIFFÉRÉE — journal encore visible`,
      {
        sourceKey,
        targetKey: key,
        sourceMessages: source.intercom.messages.length,
        targetMessages: target?.intercom.messages.length ?? 0,
        mergedMessages: mergedMessages.length,
        deduped,
        archiveFile,
        reUnionedCount,
        retireOutcome:
          retireOutcome ?? { ok: false, reason: 'deferred-reunion-sync', detail: 're-union post-rename non confirmée en PG' },
        sourceRecreated,
        by: author
      }
    );

    sourceDisposition =
      (archiveFile
        ? `Source archivée (${archiveFile}) par renommage atomique, fichier retiré et journal retiré par marque #3782 vers '${key}' (lignes conservées en base)`
        : `Source retirée des deux artefacts (aucun contenu à archiver) — journal retiré par marque #3782 (lignes conservées en base)`) +
      (reUnionedCount > 0 ? ` — re-union post-rename : ${reUnionedCount} msg(s) réintégré(s)` : '') +
      pgDispositionNote +
      (sourceRecreated
        ? `. ⚠️ Le fichier source a été RECREE après le merge (append concurrent pré-marque) — la marque #3782 redirige désormais les écritures vers '${key}' ; le fichier recréé est un cadavre froid, supprimable à la main.`
        : '');
  }

  return {
    ...base,
    success: true,
    messageCount: mergedMessages.length,
    writeVerification: writeVerification.forkSuspected ? writeVerification : undefined,
    message:
      `Clé '${sourceKey}' fusionnée dans '${key}' : ${source.intercom.messages.length} msg(source) ∪ ` +
      `${target?.intercom.messages.length ?? 0} msg(cible) → ${mergedMessages.length} msg ` +
      `(${deduped} doublon(s) par id, ${newerSourceWins} résolu(s) vers la copie plus récente ; ` +
      `${target ? 'cible existante' : 'RENAME — cible créée depuis la source'}). ` +
      `Statut retenu : ${statusFromSource ? 'source' : 'cible'} ` +
      `(arbitré par ${statusBasis === 'stamp' ? "l'horodatage de condensation" : statusBasis === 'lastModified' ? 'lastModified' : 'aucune concurrence — vue unique'}). ` +
      sourceDisposition
  };
}

async function handleDelete(key: string, args: DashboardArgs, requestEcho: DashboardRequestEcho): Promise<DashboardResult> {
  const filePath = getDashboardPath(key);

  // Safety check: read the dashboard to verify it's not recently active (#1128).
  // #3782 — lecture GDrive DIRECTE (pas readDashboardFile) : le delete est un
  // geste opérateur explicite qui doit continuer de voir le fichier réel —
  // y compris celui d'une clé retirée (deleteSource=false a préservé le
  // fichier, la marque ne rend pas le geste aveugle : protection #1128 et
  // archive pré-suppression s'appliquent au fichier sur disque).
  try {
    const dashboard = await readDashboardFromGdrive(key);
    if (dashboard) {
      const lastModified = new Date(dashboard.lastModified);
      const ageMs = Date.now() - lastModified.getTime();
      const ageDays = ageMs / (1000 * 60 * 60 * 24);

      const messageCount = dashboard.intercom?.messages?.length ?? 0;
      if (ageDays < DASHBOARD_PROTECTION_DAYS && messageCount > 0) {
        logger.warn('Delete blocked: dashboard recently active with messages', { key, ageDays: ageDays.toFixed(1), messageCount });
        return {
          success: false,
          action: 'delete',
          key,
          type: args.type ?? '',
          request: requestEcho,
          message: `⛔ REFUSÉ: Dashboard '${key}' modifié il y a ${ageDays.toFixed(1)} jours (seuil: ${DASHBOARD_PROTECTION_DAYS}j). ${messageCount} messages seraient perdus. Attendez que le dashboard soit inactif depuis plus de ${DASHBOARD_PROTECTION_DAYS}j : l'archivage automatique se fera alors avant suppression (l'action 'condense' manuelle n'existe plus, remplacée par l'auto-condensation préemptive à 92%).`
        };
      }

      // Archive before deleting (safety net for dashboards older than threshold)
      if (dashboard.intercom?.messages?.length > 0) {
        const archiveDir = getArchiveDir();
        ensureStoreSubdir(getSharedStatePath(), 'dashboards', 'archive');
        const now = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const archivePath = path.join(archiveDir, `${key}-pre-delete-${now}.md`);
        const originalContent = await fs.readFile(filePath, 'utf8');
        // #3584 (rétention) — cette copie ne traverse PAS writeDashboardFile :
        // masquer ici, sinon un secret publié avant le garde #1144 repart en
        // copie intégrale au moment même où l'original est détruit.
        await fs.writeFile(archivePath, maskSecretText(originalContent), 'utf8');
        logger.info('Dashboard archived before deletion', { key, archivePath, messageCount: dashboard.intercom.messages.length });
      }
    }
  } catch (readError) {
    // If we can't read the dashboard, still allow deletion (file may be corrupted)
    logger.warn('Could not read dashboard before delete, proceeding', { key, error: String(readError) });
  }

  try {
    await fs.unlink(filePath);
    logger.info('Dashboard supprimé', { key });
    // #3151 Phase C — mirror the deletion to PG (row + journal cascade). The
    // pre-delete GDrive archive above keeps the legacy copy (Phase D keeps
    // GDrive as the read-only archive tier). Never throws.
    await dualWriteDashboardDelete(key);
    return {
      success: true,
      action: 'delete',
      key,
      type: args.type ?? '',
      request: requestEcho,
      message: `Dashboard '${key}' supprimé (archivé en sécurité avant suppression)`
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        success: false,
        action: 'delete',
        key,
        type: args.type ?? '',
        request: requestEcho,
        message: `Dashboard '${key}' introuvable`
      };
    }
    throw error;
  }
}

async function handleReadArchive(key: string, args: DashboardArgs, requestEcho: DashboardRequestEcho): Promise<DashboardResult> {
  // #3459: fail-closed. Le mkdir récursif ci-dessous recréerait la racine du store
  // et rendrait `existsSync(sharedPath)` vrai pour toutes les autres gardes.
  try {
    assertSharedStoreAccessible();
  } catch (err) {
    return {
      success: false,
      action: 'read_archive',
      key,
      type: args.type ?? '',
      request: requestEcho,
      archives: [],
      message: (err as Error).message
    };
  }

  const archiveDir = getArchiveDir();
  ensureStoreSubdir(getSharedStatePath(), 'dashboards', 'archive');

  if (!args.archiveFile) {
    // Lister toutes les archives pour cette clé
    try {
      const files = await fs.readdir(archiveDir);
      const keyPrefix = key + '-';
      const archives = files
        .filter(f => f.startsWith(keyPrefix) && f.endsWith('.md'))
        .sort()
        .reverse(); // Plus récents en premier
      return {
        success: true,
        action: 'read_archive',
        key,
        type: args.type ?? '',
        request: requestEcho,
        archives,
        message: `${archives.length} archive(s) trouvée(s) pour '${key}'`
      };
    } catch {
      return {
        success: true,
        action: 'read_archive',
        key,
        type: args.type ?? '',
        request: requestEcho,
        archives: [],
        message: `Aucune archive pour '${key}'`
      };
    }
  }

  // Lire une archive spécifique (format Markdown)
  const archivePath = path.join(archiveDir, args.archiveFile);
  try {
    const content = (await fs.readFile(archivePath, 'utf8')).replace(/\r\n/g, '\n');

    // Parser le frontmatter
    const frontmatterMatch = content.match(/^---\n([\s\S]+?)\n---/);
    if (!frontmatterMatch) {
      throw new Error(`Format archive invalide: frontmatter manquant dans ${archivePath}`);
    }

    const archiveFrontmatter = yaml.load(frontmatterMatch[1]) as {
      type: string;
      originalKey: string;
      archivedAt: string;
      messageCount: number;
    };

    // Extraire les messages intercom
    const markdownContent = content.slice(frontmatterMatch[0].length);
    const messages: IntercomMessage[] = [];

    // Split on message headers instead of `---` to avoid content interference
    // Legacy format `### [ts] machine|workspace [TAGS]` is still parsed (tags discarded).
    const messageBlocks = markdownContent.split(/(?=^### \[)/m).filter(b => b.trim());
    for (const rawBlock of messageBlocks) {
      const block = rawBlock.replace(/\n---\s*$/, '').trim();
      // v3 (#1363) + #1956: parse header then metadata lines
      const headerMatch = block.match(/### \[([^\]]+)\]\s+([^|]+)\|([^|\s]+)(\s+\[[^\]]+\])?\n([\s\S]+)/);
      if (headerMatch) {
        const [, timestamp, machineId, workspace, , afterHeader] = headerMatch;
        let persistedId: string | undefined;
        let replyTo: string | undefined;
        let remaining = afterHeader;

        const msgMatch = remaining.match(/^\[msg: ([^\]]+)\]\n([\s\S]*)/);
        if (msgMatch) { persistedId = msgMatch[1]; remaining = msgMatch[2]; }
        const replyMatch = remaining.match(/^\[reply-to: ([^\]]+)\]\n([\s\S]*)/);
        if (replyMatch) { replyTo = replyMatch[1]; remaining = replyMatch[2]; }
        // Skip [ack:] for archive reading — not needed

        const content = remaining.replace(/^\n/, '').trim();
        const msg: IntercomMessage = {
          id: persistedId || generateMessageId(machineId, workspace),
          timestamp,
          author: { machineId, workspace },
          content
        };
        if (replyTo) msg.reply_to = replyTo;
        messages.push(msg);
      }
    }

    return {
      success: true,
      action: 'read_archive',
      key,
      type: args.type ?? '',
      request: requestEcho,
      archiveData: {
        key: archiveFrontmatter.originalKey,
        archivedAt: archiveFrontmatter.archivedAt,
        messageCount: archiveFrontmatter.messageCount,
        messages
      },
      message: `Archive '${args.archiveFile}' lue (${archiveFrontmatter.messageCount} messages)`
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        success: false,
        action: 'read_archive',
        key,
        type: args.type ?? '',
        request: requestEcho,
        message: `Archive '${args.archiveFile}' introuvable`
      };
    }
    throw error;
  }
}

// === #1935 Cluster B: refresh handler (update a rejoint le chemin v3 commun, #3549) ===

async function handleRefresh(
  args: DashboardArgs,
  requestEcho: DashboardRequestEcho
): Promise<DashboardResult> {
  const { roosyncRefreshDashboard } = await import('./refresh-dashboard.js');
  const result = await roosyncRefreshDashboard({
    baseline: args.baseline,
    outputDir: args.outputDir
  });
  return {
    success: result.success,
    action: 'refresh',
    key: 'mcp-inventory',
    type: 'inventory',
    request: requestEcho,
    data: result as unknown as Partial<Dashboard>,
    message: result.success
      ? `Dashboard MCP rafraîchi: ${result.metrics.totalMachines} machines`
      : `Erreur rafraîchissement: ${(result as any).message ?? 'unknown'}`
  };
}

/**
 * #3549 Option A — update v3 create-or-replace.
 *
 * Même contrat que write/append : clé dérivée par buildDashboardKey (le
 * routage principal l'a déjà calculée), verrou append cross-process pour le
 * read-modify-write, dual-write fichier + PostgreSQL via writeDashboardFile,
 * garde anti-fork #3482 et garde store #3459 héritées gratuitement.
 *
 * Sémantique create-or-replace : un dashboard absent est créé avec le contenu
 * fourni (mode ignoré — il n'y a rien à fusionner) ; un dashboard existant
 * voit sa section ciblée fusionnée selon mode. Les sections legacy
 * machine/global/decisions/metrics du DASHBOARD.md monolithique n'existent
 * pas dans le store v3 : elles sont rejetées avec guidage, sans fallback.
 */
async function handleUpdate(
  key: string,
  args: DashboardArgs,
  createIfNotExists: boolean,
  resolvedMachineId: string,
  resolvedWorkspace: string,
  requestEcho: DashboardRequestEcho
): Promise<DashboardResult> {
  const section = args.section ?? 'status';
  if (section !== 'status') {
    if (section === 'intercom') {
      throw new Error(
        "action=update ne cible pas la section intercom : l'intercom v3 est append-only (action=append crée les messages, la condensation est le seul retrait)."
      );
    }
    throw new Error(
      `action=update cible les sections v3 (section='status' par défaut). ` +
      `La section '${section}' n'existe pas dans le store v3 : machine/global/decisions/metrics ` +
      `étaient des titres du DASHBOARD.md monolithique legacy, retiré. ` +
      `Utiliser type=global|machine|workspace + section=status pour éditer le statut du dashboard correspondant.`
    );
  }
  if (!args.content) {
    throw new Error('content est requis pour action=update');
  }

  const mode = args.mode ?? 'replace';
  const author: Author = args.author ?? {
    machineId: resolvedMachineId,
    workspace: resolvedWorkspace
  };
  const content = args.content;

  // #3459 (parité write) : refuser de créer un dashboard fantôme quand le
  // magasin est absent — l'écriture atterrirait dans un store injoignable.
  try {
    assertSharedStoreAccessible();
  } catch (err) {
    return {
      success: false,
      action: 'update',
      key,
      type: args.type!,
      request: requestEcho,
      message: (err as Error).message
    };
  }

  // Read-modify-write sous le verrou append cross-process — sans lui, un
  // append concurrent entre le read et le write serait écrasé (même classe
  // de perte que #3205/#1033, parité write).
  let notFound = false;
  let dashboard: Dashboard | null = null;
  const holder: CondenseLockInfo = {
    machineId: author.machineId,
    workspace: author.workspace,
    pid: process.pid,
    acquiredAt: new Date().toISOString()
  };
  await withAppendLock(key, holder, async () => {
    let current = await readDashboardFile(key);
    let created = false;
    if (!current) {
      if (!createIfNotExists) {
        notFound = true;
        return;
      }
      current = createEmptyDashboard(args.type!, key, author);
      created = true;
    }
    const existing = current.status.markdown;
    // Create-or-replace : sur création, le contenu fourni EST la section —
    // fusionner avec le placeholder '*Aucun contenu.*' n'a pas de sens.
    let merged: string;
    if (created || mode === 'replace') {
      merged = content;
    } else if (mode === 'append') {
      merged = `${existing}\n\n${content}`;
    } else {
      merged = `${content}\n\n${existing}`;
    }
    const updated: Dashboard = {
      ...current,
      lastModified: new Date().toISOString(),
      lastModifiedBy: author,
      status: {
        markdown: merged,
        lastDiffCommit: current.status.lastDiffCommit
      }
    };
    await writeDashboardFile(key, updated);
    dashboard = updated;
  });

  if (notFound || !dashboard) {
    return {
      success: false,
      action: 'update',
      key,
      type: args.type!,
      request: requestEcho,
      message: `Dashboard '${key}' introuvable et createIfNotExists=false`
    };
  }

  // #1791 (parité write) : auto-register heartbeat, fire-and-forget
  recordRooSyncActivityAsync('dashboard-write', { key, type: args.type, action: 'update' });

  return {
    success: true,
    action: 'update',
    key,
    type: args.type!,
    request: requestEcho,
    sizes: buildSizes(dashboard),
    message: `Section 'status' mise à jour (${mode}) pour dashboard '${key}'`
  };
}
