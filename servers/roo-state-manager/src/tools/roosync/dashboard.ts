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
import { getSharedStatePath } from '../../utils/shared-state-path.js';
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

async function cloudCondenseOnce(
  systemPrompt: string,
  userPrompt: string,
  opts: { maxTokens: number; temperature: number },
): Promise<{ content: string; elapsedMs: number; model: string } | null> {
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
  const fbModel = getFallbackLLMModelId();
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
      return null;
    }
    logger.info('#2719 cloud fallback condensation succeeded', {
      fbModel,
      elapsed: `${elapsedMs}ms`,
      sizeKB: `${(Buffer.byteLength(content, 'utf8') / 1024).toFixed(1)}KB`,
    });
    return { content, elapsedMs, model: fbModel };
  } catch (error: unknown) {
    const errStr = safeErrorString(error);
    logger.error('#2719 cloud fallback condensation failed', { fbModel, error: truncateError(errStr) });
    return null;
  }
}

/**
 * Stats-aware wrapper around cloudCondenseOnce for the LLMCallResult condensers
 * (generateLLMSummary / generateStatusUpdate). On fallback success, stamps the fallback
 * fields + 'ok-with-fallback' outcome and returns the result; otherwise returns null so
 * the caller returns its original primary-failure result (and its diagnostic stats) unchanged.
 */
async function tryCloudCondenseFallback(
  systemPrompt: string,
  userPrompt: string,
  opts: { maxTokens: number; temperature: number },
  stats: LLMCallStats,
  callStart: number,
): Promise<LLMCallResult | null> {
  const fb = await cloudCondenseOnce(systemPrompt, userPrompt, opts);
  if (!fb) return null;
  stats.fallbackUsed = true;
  stats.fallbackModel = fb.model;
  stats.fallbackElapsedMs = fb.elapsedMs;
  stats.finalOutcome = 'ok-with-fallback';
  stats.elapsedMs = Date.now() - callStart;
  return { content: fb.content, stats };
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

// #2464: Condensation loop prevention — hash cache.
// Before each condensation, compute SHA-256 of the messages that would be
// condensed (toArchive). If the hash matches the last successful condensation
// for this key, skip the LLM calls — the result would be identical.
// Prevents repeated condensation on unchanged content (3-4x per 30min observed).
const lastCondenseHash = new Map<string, string>();

// === Utilitaires ===

/**
 * Construit la clé dashboard à partir du type et des paramètres
 */
function buildDashboardKey(
  type: DashboardArgs['type'],
  machineId: string,
  workspace: string
): string {
  switch (type) {
    case 'global':
      return 'global';
    case 'machine':
      // Guard against double-prefix (e.g., machine-machine-foo)
      const cleanMachineId = machineId.startsWith('machine-') ? machineId.slice('machine-'.length) : machineId;
      return `machine-${cleanMachineId}`;
    case 'workspace': {
      // Guard against double-prefix (e.g., workspace-workspace-Argumentum → #1409 item 2)
      const cleanWorkspace = workspace.startsWith('workspace-') ? workspace.slice('workspace-'.length) : workspace;
      // 2026-05-23: collapse to the directory basename only. Callers sometimes pass
      // a full path-style workspace (d:\CoursIA, g:\Mon Drive\...\CoursIA) which used
      // to produce scattered orphan dashboards (workspace-d--CoursIA.md,
      // workspace-g--Mon-Drive-CoursIA.md). User mandate: "on a dit qu'on ne retenait
      // que le nom de répertoire collapsé". basename() (case-preserved) folds every
      // path form for the same project onto one key. NOT normalizeWorkspaceId() — that
      // lowercases, which would mismatch the existing case-preserved files (CoursIA,
      // Argumentum, 2025-Epita-Intelligence-Symbolique). If the value is already a bare
      // name (no separators), basename() returns it unchanged.
      const baseName = path.basename(cleanWorkspace.replace(/\\/g, '/'));
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
    return true;
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
      if (Number.isFinite(ageMs) && ageMs < CONDENSE_LOCK_TTL_MS) {
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
      return true;
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
    if (existing.machineId === holder.machineId && existing.pid === holder.pid && existing.acquiredAt === holder.acquiredAt) {
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

/**
 * Lit un dashboard depuis le stockage Markdown. Retourne null si inexistant.
 */
async function readDashboardFile(key: string): Promise<Dashboard | null> {
  const filePath = getDashboardPath(key);
  try {
    const content = (await fs.readFile(filePath, 'utf8')).replace(/\r\n/g, '\n');

    // Parser le frontmatter YAML (entre --- et ---)
    const frontmatterMatch = content.match(/^---\n([\s\S]+?)\n---/);
    if (!frontmatterMatch) {
      throw new Error(`Format dashboard invalide: frontmatter manquant dans ${filePath}`);
    }

    const frontmatter: DashboardFrontmatter = yaml.load(frontmatterMatch[1]) as DashboardFrontmatter;

    // Extraire le contenu markdown après le frontmatter
    const markdownContent = content.slice(frontmatterMatch[0].length);

    // Séparer les sections Status et Intercom
    const statusMatch = markdownContent.match(/## Status\n([\s\S]+?)(?=\n## Intercom|\n*$)/);
    const intercomMatch = markdownContent.match(/## Intercom[\s\S]*?\n\n([\s\S]+)$/);

    const statusMarkdown = statusMatch ? statusMatch[1].trim() : '';
    const intercomMarkdown = intercomMatch ? intercomMatch[1].trim() : '';

    // Parser les messages intercom (format: ### [timestamp] machine|workspace\n\ncontent)
    // Bug fix: split on message headers instead of `---` which can appear in message content
    // Note: legacy format `### [ts] machine|workspace [TAGS]` is still parsed for backward compat,
    // but the captured tags segment is discarded (tags removed in 2026-04).
    const messages: IntercomMessage[] = [];
    if (intercomMarkdown && !intercomMarkdown.includes('*Aucun message.*')) {
      // Split on message headers (### [) while keeping the header in each block
      const messageBlocks = intercomMarkdown.split(/(?=^### \[)/m).filter(b => b.trim());
      for (const rawBlock of messageBlocks) {
        // Strip trailing --- separators (leftover from write format)
        const block = rawBlock.replace(/\n---\s*$/, '').trim();
        // Note: machineId et workspace peuvent contenir des tirets (ex: test-machine, roo-extensions)
        // On utilise [^|\s]+ au lieu de \w+ pour permettre les tirets
        // Le segment optionnel `\s+\[([^\]]+)\]` est l'ancien format tags — toujours toléré, jamais réutilisé.
        // v3 (#1363): ligne `[msg: <id>]` optionnelle immédiatement après le header, avant le contenu.
        // #1956: optional `[reply-to: <id>]` and `[ack: <data>]` metadata lines after [msg:]
        const headerMatch = block.match(/### \[([^\]]+)\]\s+([^|]+)\|([^|\s]+)( \[[^\]]+\])?\n([\s\S]+)/);
        if (headerMatch) {
          const [, timestamp, machineId, workspace, , afterHeader] = headerMatch;
          const mid = machineId.trim();
          const ws = workspace.trim();

          // Parse metadata lines ([msg:], [reply-to:], [ack:]) then content
          let persistedId: string | undefined;
          let replyTo: string | undefined;
          let ackRaw: string | undefined;
          let remaining = afterHeader;

          // [msg: <id>]
          const msgMatch = remaining.match(/^\[msg: ([^\]]+)\]\n([\s\S]*)/);
          if (msgMatch) {
            persistedId = msgMatch[1];
            remaining = msgMatch[2];
          }
          // [reply-to: <id>]
          const replyMatch = remaining.match(/^\[reply-to: ([^\]]+)\]\n([\s\S]*)/);
          if (replyMatch) {
            replyTo = replyMatch[1];
            remaining = replyMatch[2];
          }
          // [ack: machine1:ts1, machine2:ts2]
          const ackMatch = remaining.match(/^\[ack: ([^\]]+)\]\n([\s\S]*)/);
          if (ackMatch) {
            ackRaw = ackMatch[1];
            remaining = ackMatch[2];
          }

          // Content starts after optional blank line
          const content = remaining.replace(/^\n/, '');
          const unescapedContent = content.trim().replace(/^\\#\\#\\# \[/gm, '### [');

          // Parse acknowledged_at from raw string
          let acknowledged_at: Record<string, string> | undefined;
          if (ackRaw) {
            const entries = ackRaw.split(', ').map((entry: string) => {
              const colonIdx = entry.indexOf(':');
              return [entry.slice(0, colonIdx), entry.slice(colonIdx + 1)];
            });
            acknowledged_at = Object.fromEntries(entries);
          }

          const msg: IntercomMessage = {
            id: persistedId || generateMessageId(mid, ws),
            timestamp,
            author: { machineId: mid, workspace: ws },
            content: unescapedContent
          };
          if (replyTo) msg.reply_to = replyTo;
          if (acknowledged_at && Object.keys(acknowledged_at).length > 0) {
            msg.acknowledged_at = acknowledged_at;
          }
          messages.push(msg);
        }
      }
    }

    return {
      type: frontmatter.type,
      key,
      lastModified: frontmatter.lastModified,
      lastModifiedBy: frontmatter.lastModifiedBy,
      status: { markdown: statusMarkdown },
      intercom: {
        messages,
        totalMessages: frontmatter.totalMessages || messages.length,
        lastCondensedAt: frontmatter.lastCondensedAt
      }
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    logger.error('Erreur lecture dashboard', { key, error });
    throw error;
  }
}

/**
 * Écrit un dashboard dans le stockage au format Markdown avec frontmatter YAML
 */
async function writeDashboardFile(key: string, dashboard: Dashboard): Promise<void> {
  const dir = getDashboardsDir();
  await fs.mkdir(dir, { recursive: true });
  const filePath = getDashboardPath(key);
  const tmpPath = `${filePath}.tmp`;

  // Construire le frontmatter YAML
  const frontmatter: DashboardFrontmatter = {
    type: dashboard.type,
    lastModified: dashboard.lastModified,
    lastModifiedBy: dashboard.lastModifiedBy,
    totalMessages: dashboard.intercom.totalMessages,
    lastCondensedAt: dashboard.intercom.lastCondensedAt
  };

  // Construire le contenu markdown
  const yamlFrontmatter = yaml.dump(frontmatter);
  const statusSection = dashboard.status.markdown || '*Aucun contenu.*';

  // Construire la section intercom (messages en markdown)
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

  const content = `---
${yamlFrontmatter.trim()}
---

## Status

${statusSection}

## Intercom (${dashboard.intercom.messages.length} messages)

${intercomSection}
`;

  await fs.writeFile(tmpPath, content, 'utf8');
  await fs.rename(tmpPath, filePath);
  logger.debug('Dashboard écrit', { key, path: filePath });
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
): Promise<void> {
  const current = await readDashboardFile(key);
  if (!current) {
    await writeDashboardFile(key, condensedDashboard);
    return;
  }

  // Guard: if another condensation completed while our LLM was running,
  // don't overwrite with our stale result.
  if (
    current.intercom.lastCondensedAt &&
    current.intercom.lastCondensedAt > (snapshotBefore.intercom.lastCondensedAt ?? '')
  ) {
    logger.warn('[COLLISION] concurrent condensation won — skipping stale overwrite', { key });
    return;
  }

  // Delta = messages on disk that weren't in our pre-condensation snapshot.
  // append-only => these are concurrent appends => always a suffix.
  const seen = new Set(snapshotBefore.intercom.messages.map(m => m.id));
  const delta = current.intercom.messages.filter(m => !seen.has(m.id));

  if (delta.length === 0) {
    await writeDashboardFile(key, condensedDashboard);
    return;
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
  await writeDashboardFile(key, merged);
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
): Promise<void> {
  const dir = getDashboardsDir();
  await fs.mkdir(dir, { recursive: true });
  const filePath = getDashboardPath(key);
  const tmpPath = `${filePath}.tmp`;

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

  await fs.writeFile(tmpPath, result, 'utf8');
  await fs.rename(tmpPath, filePath);
  logger.debug('Dashboard append incrémental', { key, path: filePath, newMessages: newMessageCount });
}

/**
 * Crée un dashboard vide avec les valeurs par défaut
 */
function createEmptyDashboard(
  type: NonNullable<DashboardArgs['type']>,
  key: string,
  author: Author
): Dashboard {
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
 * Génère un ID unique pour un message intercom.
 * Format v3 (#1363): ${machineId}:${workspace}:ic-${ts}-${rand}
 * Aligné avec RooSync inbox pour permettre le référencement cross-message.
 */
function generateMessageId(machineId: string, workspace: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '').substring(0, 16);
  const rand = Math.random().toString(36).substring(2, 6);
  return `${machineId}:${workspace}:ic-${ts}-${rand}`;
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
 *   - `condensed`         : LLM succeeded, archive written, status updated
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
  outcome: 'condensed' | 'no-op' | 'llm-failed-dedup' | 'llm-failed-injected' | 'fallback-truncated' | 'skipped-lock-held';
  elapsedMs: number;
  archivedMessageCount: number;
  llm?: {
    summary: LLMCallStats;
    status: LLMCallStats;
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
  finalOutcome: 'ok' | 'null' | 'error' | 'timeout' | 'client-init-failed' | 'ok-with-fallback';
  // #2719: Cloud fallback fields
  /** Whether the cloud fallback (z.ai / OpenAI) was used for this call. */
  fallbackUsed?: boolean;
  /** Model name used for the fallback attempt (e.g. "glm-4.7-flash"). */
  fallbackModel?: string;
  /** Wall-clock time for the successful fallback attempt (ms). */
  fallbackElapsedMs?: number;
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
async function generateLLMSummary(messages: IntercomMessage[]): Promise<LLMCallResult> {
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
      const isTimeout = error instanceof Error && error.name === 'AbortError';
      if (isTimeout) {
        stats.timeoutCount += 1;
        logger.warn('LLM summary timeout', { attempt, timeout: timeoutMs, elapsed: `${elapsed}ms` });
      } else {
        logger.error('LLM summary error', { attempt, elapsed: `${elapsed}ms`, error: errStr });
      }
      // #2267 follow-up: do NOT retry a timeout. A hung endpoint won't recover in a
      // 2-8s backoff — retrying just burns another full CONDENSE_LLM_TIMEOUT_MS. Fail
      // fast to the truncation fallback. (502/empty errors still retry below.)
      if (!isTimeout && attempt < LLM_MAX_RETRIES) {
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
  dashboardKey: string
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
- Inférer un état à partir d'informations partielles (extrapolation)`;

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
      const isTimeout = error instanceof Error && error.name === 'AbortError';
      if (isTimeout) {
        stats.timeoutCount += 1;
        logger.warn('LLM status update timeout', { attempt, timeout: timeoutMs, elapsed: `${elapsed}ms` });
      } else {
        logger.error('LLM status update error', { attempt, elapsed: `${elapsed}ms`, error: errStr });
      }
      // #2267 follow-up: do NOT retry a timeout (see generateLLMSummary catch).
      if (!isTimeout && attempt < LLM_MAX_RETRIES) {
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

  // #2719: primary LLM never converged (down / empty / still oversized) → one cloud
  // fallback attempt before falling to lossy truncation. The cloud result must still
  // respect the HARD cap (#2598): use it only if under cap, else keep it as the best
  // candidate for the deterministic backstop below.
  const fbCloud = await cloudCondenseOnce(
    `Tu es un expert en synthèse. Condense le texte sous ${capKb} Ko en préservant TOUTE information critique (décisions, métriques chiffrées, dates, blocages). Fusionne les redondances, supprime le verbeux. Pas d'emojis, pas de prose. LAST-KNOWN-STATE WINS (#1502). N'extrapole rien qui ne soit pas dans le texte source.`,
    text,
    { maxTokens: CONDENSE_LLM_MAX_TOKENS, temperature: 0.3 },
  );
  if (fbCloud) {
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
  await fs.mkdir(archiveDir, { recursive: true });
  const dateStr = now.replace(/[:.]/g, '-').substring(0, 19);
  const archivePath = path.join(archiveDir, `${key}-${dateStr}-fallback.md`);

  const archiveFrontmatter = yaml.dump({
    type: 'archive',
    originalKey: key,
    archivedAt: now,
    messageCount: toArchive.length,
    llmGenerated: false,
    fallbackTruncation: true,
    circuitBreakerOpen: condenseCB.isOpen,
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
  }

  // #2463: Deterministic status truncation — never let status exceed its cap,
  // even when LLM is unavailable (the exact scenario where truncation matters most).
  const truncatedStatus = truncateToMaxSize(
    dashboard.status.markdown, MAX_STATUS_SIZE_BYTES, 'Status (fallback)'
  );

  return {
    ...dashboard,
    status: { ...dashboard.status, markdown: truncatedStatus },
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

  const toArchive = messages.slice(0, messages.length - keepCount);
  const toKeep = messages.slice(messages.length - keepCount);

  // #858 : Générer les résumés LLM AVANT d'archiver
  // Pass ALL messages to status update so LLM sees full context
  const previousStatus = dashboard.status.markdown;

  // #1792: If circuit breaker is open, skip LLM calls entirely and do truncation fallback
  if (condenseCBShouldBypass()) {
    logger.info('Condensation circuit breaker OPEN — using truncation fallback', {
      key,
      toArchive: toArchive.length,
      toKeep: toKeep.length,
    });
    return executeTruncationFallback(
      key, dashboard, toArchive, toKeep, diagnostic, condensationStart
    );
  }

  // #1497: Run the 2 LLM calls in parallel (status update + summary) — they are
  // independent (both take messages as input, neither depends on the other's
  // output). Halves wall-clock latency from ~2×T to ~T, critical when condense
  // races the client timeout. A single failing call still cancels condensation
  // via the existing null-check below.
  const tParallel = Date.now();
  const [statusCall, summaryCall] = await Promise.all([
    generateStatusUpdate(previousStatus, messages, toArchive.length, key),
    generateLLMSummary(toArchive)
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
    condenseCBRecordFailure();
    return executeTruncationFallback(
      key, dashboard, toArchive, toKeep, diagnostic, condensationStart,
      { statusCall, summaryCall }
    );
  }

  // LLM succeeded — reset circuit breaker
  condenseCBRecordSuccess();

  // Both operations succeeded — now auto-condense if outputs exceed size limits
  newStatus = await condenseTextIfTooLarge(newStatus, MAX_STATUS_SIZE_BYTES, 'Status');
  llmSummary = await condenseTextIfTooLarge(llmSummary, MAX_SUMMARY_SIZE_BYTES, 'Summary');

  // #1502: Detect contradictions in generated status before committing
  const detectedContradictions = detectStatusContradictions(newStatus!);
  if (detectedContradictions.length > 0) {
    logger.warn('Status contradictions detected after LLM generation (#1502)', {
      contradictionCount: detectedContradictions.length,
      contradictions: detectedContradictions.map(c => `${c.entity}: ${c.conflictingStates.join(' vs ')}`)
    });
    // Append HTML comment markers for visibility to next readers
    const warningLines = detectedContradictions.map(c =>
      `<!-- #1502 CONTRADICTION: ${c.entity} has conflicting states: ${c.conflictingStates.join(' vs ')} -->`
    ).join('\n');
    newStatus = newStatus! + '\n\n' + warningLines;
  }

  const statusUpdated = true;

  // Archiver les anciens messages (format Markdown)
  const archiveDir = getArchiveDir();
  await fs.mkdir(archiveDir, { recursive: true });
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
  const summarySizeBytes = Buffer.byteLength(llmSummary!, 'utf8');
  logger.info('Status updated from archived messages', {
    previousLength: previousStatus.length,
    newLength: newStatus!.length,
    statusSizeKB: `${(statusSizeBytes / 1024).toFixed(1)}KB`,
    summarySizeKB: `${(summarySizeBytes / 1024).toFixed(1)}KB`
  });

  // Ajouter le message de condensation standard avec timing et tailles
  const totalElapsed = Date.now() - condensationStart;
  const condenseNotice: IntercomMessage = {
    id: generateMessageId('system', 'system'),
    timestamp: now,
    author: {
      machineId: 'system',
      workspace: 'system'
    },
    content: `**CONDENSATION** - ${now}\n\n${toArchive.length} messages archivés dans \`archive/${path.basename(archivePath)}\`\n${toKeep.length} messages conservés (plus récents)\nStatut mis à jour (${(statusSizeBytes / 1024).toFixed(1)}KB), résumé LLM généré (${(summarySizeBytes / 1024).toFixed(1)}KB)\nDurée: ${Math.round(totalElapsed / 1000)}s (status + summary parallèle: ${Math.round(tParallelElapsed / 1000)}s)`
  };
  systemMessages.push(condenseNotice);

  logger.info('Condensation completed', { totalElapsed: `${totalElapsed}ms` });

  if (diagnostic) {
    diagnostic.outcome = 'condensed';
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
  condensationThreshold: number;
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
  message?: string;
  dashboards?: DashboardSummary[];
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
  crossPost?: Array<{ key: string; ok: boolean; error?: string }>;
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
    condensationThreshold: MAX_DASHBOARD_SIZE_BYTES,
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

  // #1935 Cluster B: refresh/update actions delegate to legacy tools
  if (args.action === 'refresh') {
    return handleRefresh(args, requestEcho);
  }
  if (args.action === 'update') {
    return handleUpdate(args, requestEcho);
  }

  if (!args.type) {
    throw new Error('type est requis pour action=' + args.action);
  }

  const resolvedMachineId = args.machineId ?? getLocalMachineId();
  const resolvedWorkspace = args.workspace ?? getLocalWorkspaceId();
  const key = buildDashboardKey(args.type, resolvedMachineId, resolvedWorkspace);
  const createIfNotExists = args.createIfNotExists !== false; // défaut: true

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
          handleWrite(key, args, createIfNotExists, resolvedMachineId, resolvedWorkspace, requestEcho)
        );
      case 'append':
        // Serialized: prevents concurrent condensations producing duplicate archives
        return withKeyLock(key, () =>
          handleAppend(key, args, createIfNotExists, resolvedMachineId, resolvedWorkspace, requestEcho)
        );

    case 'delete':
      return withKeyLock(key, () => handleDelete(key, args, requestEcho));
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

async function handleRead(
  key: string,
  args: DashboardArgs,
  resolvedMachineId: string,
  resolvedWorkspace: string,
  requestEcho: DashboardRequestEcho
): Promise<DashboardResult> {
  const dashboard = await readDashboardFile(key);
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

  // #1956: Auto-ACK — when reading intercom, mark replies to our messages as acknowledged
  if (readSection === 'intercom' || readSection === 'all') {
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
    if (ackDirty) {
      await writeDashboardFile(key, dashboard).catch(err =>
        logger.warn('Auto-ACK write failed', { key, error: String(err) })
      );
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
    let messages = intercomLimit
      ? dashboard.intercom.messages.slice(-intercomLimit)
      : dashboard.intercom.messages;

    // Filter by mentionsOnly if requested
    if (args.mentionsOnly) {
      messages = messages.filter(msg => {
        const mentions = parseMentions(msg.content);
        return isMentioned(mentions, resolvedMachineId, resolvedWorkspace);
      });
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

  let dashboard = await readDashboardFile(key);
  if (!dashboard) {
    if (!createIfNotExists) {
      return {
        success: false,
        action: 'write',
        key,
        type: args.type!,
        request: requestEcho,
        message: `Dashboard '${key}' introuvable et createIfNotExists=false`
      };
    }
    dashboard = createEmptyDashboard(args.type!, key, author);
  }

  const now = new Date().toISOString();
  dashboard = {
    ...dashboard,
    lastModified: now,
    lastModifiedBy: author,
    status: {
      markdown: args.content,
      lastDiffCommit: dashboard.status.lastDiffCommit
    }
  };

  await writeDashboardFile(key, dashboard);

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

  let dashboard = await readDashboardFile(key);
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
    dashboard = createEmptyDashboard(args.type!, key, author);
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
  const messageIdValue = pendingMessageIds.get(key) || (args as any).messageId || generateMessageId(author.machineId, author.workspace);

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

  const updatedDashboard: Dashboard = {
    ...dashboard,
    lastModified: now,
    lastModifiedBy: author,
    intercom: {
      messages: [...dashboard.intercom.messages, ...newMessages],
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
  await appendDashboardIncremental(key, updatedDashboard, newMessages.length);
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
            await applyCondensedWithMerge(key, updatedDashboard, finalDashboard);
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
  const crossPostResults: Array<{ key: string; ok: boolean; error?: string }> = [];
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

        let targetDashboard = await readDashboardFile(targetKey);
        if (!targetDashboard) {
          if (!createIfNotExists) {
            crossPostResults.push({
              key: targetKey,
              ok: false,
              error: `Dashboard introuvable et createIfNotExists=false`
            });
            continue;
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

        await writeDashboardFile(targetKey, crossPosted);
        crossPostResults.push({ key: targetKey, ok: true });
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
  const crossPostSuffix = crossPostResults.length > 0
    ? ` (cross-post: ${crossPostOk}/${crossPostResults.length} OK${crossPostFail > 0 ? `, ${crossPostFail} échecs` : ''})`
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

  const totalMs = Date.now() - appendStart;
  const splitSuffix = isMultiPart ? ` [split en ${newMessages.length} parts]` : '';

  // #1791: Auto-register heartbeat on dashboard append (fire-and-forget)
  recordRooSyncActivityAsync('dashboard-append', { key, type: args.type });

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
    crossPost: crossPostResults.length > 0 ? crossPostResults : undefined,
    condenseDiagnostic: condenseDiagnostics.length > 0 ? condenseDiagnostics : undefined,
    splitCount: newMessages.length,
    durationBreakdown: {
      totalMs,
      preemptiveCondenseMs,
      reactiveCondenseMs,
      writeMs
    },
    message: `Message ajouté au dashboard '${key}'${splitSuffix}${condensed ? ` (auto-condensation: ${reportedArchivedCount} messages archivés, taille réduite)` : ''}${diagSuffix}${crossPostSuffix}`
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

async function handleList(requestEcho: DashboardRequestEcho): Promise<DashboardResult> {
  // #1410 item 4: auto-cleanup stale worktree dashboards before listing
  const cleanedUp = await cleanupStaleWorktreeDashboards();

  const dir = getDashboardsDir();
  try {
    await fs.mkdir(dir, { recursive: true });
    const files = await fs.readdir(dir);
    const mdFiles = files.filter(f => f.endsWith('.md') && !f.endsWith('.tmp'));
    const summaries: DashboardSummary[] = [];

    for (const file of mdFiles) {
      const key = file.replace(/\.md$/, '');
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
    return {
      success: true,
      action: 'list',
      key: '',
      type: '',
      request: requestEcho,
      dashboards: summaries,
      message: `${summaries.length} dashboard(s) trouvé(s)${cleanupNote}`
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
          await fs.mkdir(archiveDir, { recursive: true });
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
          const archivePath = path.join(archiveDir, `${key}-wt-cleanup-${timestamp}.md`);
          const originalPath = path.join(dir, file);
          const content = await fs.readFile(originalPath, 'utf8');
          await fs.writeFile(archivePath, content, 'utf8');
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

async function handleDelete(key: string, args: DashboardArgs, requestEcho: DashboardRequestEcho): Promise<DashboardResult> {
  const filePath = getDashboardPath(key);

  // Safety check: read the dashboard to verify it's not recently active (#1128)
  try {
    const dashboard = await readDashboardFile(key);
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
        await fs.mkdir(archiveDir, { recursive: true });
        const now = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const archivePath = path.join(archiveDir, `${key}-pre-delete-${now}.md`);
        const originalContent = await fs.readFile(filePath, 'utf8');
        await fs.writeFile(archivePath, originalContent, 'utf8');
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
  const archiveDir = getArchiveDir();
  await fs.mkdir(archiveDir, { recursive: true });

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

// === #1935 Cluster B: refresh/update handlers ===

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

async function handleUpdate(
  args: DashboardArgs,
  requestEcho: DashboardRequestEcho
): Promise<DashboardResult> {
  if (!args.section || !['machine', 'global', 'intercom', 'decisions', 'metrics'].includes(args.section)) {
    throw new Error('section (machine/global/intercom/decisions/metrics) est requis pour action=update');
  }
  if (!args.content) {
    throw new Error('content est requis pour action=update');
  }
  const { roosyncUpdateDashboard } = await import('./update-dashboard.js');
  const result = await roosyncUpdateDashboard({
    section: args.section as 'machine' | 'global' | 'intercom' | 'decisions' | 'metrics',
    content: args.content,
    machine: args.machineId,
    workspace: args.workspace,
    mode: args.mode
  });
  return {
    success: result.success,
    action: 'update',
    key: 'hierarchical',
    type: 'hierarchical',
    request: requestEcho,
    data: result as unknown as Partial<Dashboard>,
    message: result.success
      ? `Section '${result.section}' mise à jour (${result.mode})`
      : `Erreur mise à jour: ${result.dashboardPath ?? 'unknown'}`
  };
}
