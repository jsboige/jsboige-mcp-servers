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
import * as yaml from 'js-yaml';
import { getSharedStatePath } from '../../utils/shared-state-path.js';
import { getLocalMachineId, getLocalWorkspaceId } from '../../utils/message-helpers.js';
import { createLogger, Logger } from '../../utils/logger.js';
import { getChatOpenAIClient, getLLMModelId } from '../../services/openai.js';
import {
  sendMentionNotificationsAsync,
  sendStructuredMentionNotificationsAsync,
  resolveMentionTarget
} from '../../utils/dashboard-helpers.js';
import type OpenAI from 'openai';

// #1470: Single source of truth schemas from dedicated module
// No handler logic imported — safe circular-dep-free module
import {
  AuthorSchema,
  IntercomMessageSchema,
  UserIdSchema,
  MentionSchema,
  CrossPostSchema,
  DashboardArgsSchema,
  type Author,
  type IntercomMessage,
  type UserId,
  type Mention,
  type CrossPost,
  type Dashboard,
  type DashboardFrontmatter,
  type DashboardArgs
} from './dashboard-schemas.js';

// Re-export schemas and types for backward compatibility
export {
  AuthorSchema,
  IntercomMessageSchema,
  UserIdSchema,
  MentionSchema,
  CrossPostSchema,
  DashboardArgsSchema,
  type Author,
  type IntercomMessage,
  type UserId,
  type Mention,
  type CrossPost,
  type Dashboard,
  type DashboardFrontmatter,
  type DashboardArgs
};

const logger: Logger = createLogger('DashboardTool');

// Auto-condensation: size-based (50KB) + keep 10 most recent messages
// When dashboard file exceeds MAX_DASHBOARD_SIZE_BYTES, condense old messages
// into the status section via LLM, keeping only CONDENSE_KEEP recent messages.
const MAX_DASHBOARD_SIZE_BYTES = 50 * 1024; // 50 KB
const CONDENSE_KEEP = 10;

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

// #1792: Circuit breaker for condensation — fallback to simple truncation when LLM is down.
// After CB_FAILURE_THRESHOLD consecutive LLM failures, the circuit opens and subsequent
// condensation attempts use FIFO truncation instead of LLM summarization. After
// CB_COOLDOWN_MS, the circuit enters half-open state: one LLM attempt is allowed.
// Success resets the breaker; failure re-opens it immediately.
const CB_FAILURE_THRESHOLD = 3;
const CB_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes
const FALLBACK_TRUNCATE_KEEP = 15; // Keep more messages in fallback (less aggressive than LLM condense)

interface CircuitState {
  consecutiveFailures: number;
  lastFailureTime: number; // epoch ms, 0 = never failed
}
const condensationCircuits = new Map<string, CircuitState>();

function getCircuit(key: string): CircuitState {
  if (!condensationCircuits.has(key)) {
    condensationCircuits.set(key, { consecutiveFailures: 0, lastFailureTime: 0 });
  }
  return condensationCircuits.get(key)!;
}

function isCircuitOpen(key: string): boolean {
  const cb = getCircuit(key);
  if (cb.consecutiveFailures < CB_FAILURE_THRESHOLD) return false;
  // Half-open: allow one attempt after cooldown
  if (Date.now() - cb.lastFailureTime > CB_COOLDOWN_MS) return false;
  return true;
}

function recordCircuitSuccess(key: string): void {
  condensationCircuits.delete(key); // Full reset on success
}

function recordCircuitFailure(key: string): void {
  const cb = getCircuit(key);
  cb.consecutiveFailures++;
  cb.lastFailureTime = Date.now();
  logger.warn(`Condensation circuit breaker: ${key} failure #${cb.consecutiveFailures}`, {
    key,
    consecutiveFailures: cb.consecutiveFailures,
    threshold: CB_FAILURE_THRESHOLD,
    circuitOpen: cb.consecutiveFailures >= CB_FAILURE_THRESHOLD,
    cooldownMinutes: Math.round(CB_COOLDOWN_MS / 60000)
  });
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
    case 'workspace':
      // Guard against double-prefix (e.g., workspace-workspace-Argumentum → #1409 item 2)
      const cleanWorkspace = workspace.startsWith('workspace-') ? workspace.slice('workspace-'.length) : workspace;
      return `workspace-${cleanWorkspace}`;
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
        const headerMatch = block.match(/### \[([^\]]+)\]\s+([^|]+)\|([^|\s]+)(\s+\[[^\]]+\])?\n(?:\[msg: ([^\]]+)\]\n)?\n([\s\S]+)/);
        if (headerMatch) {
          const [, timestamp, machineId, workspace, , persistedId, content] = headerMatch;
          // FIX #1123: Unescape "### [" that was escaped during write to prevent false splits
          const unescapedContent = content.trim().replace(/^\\#\\#\\# \[/gm, '### [');
          const mid = machineId.trim();
          const ws = workspace.trim();
          messages.push({
            // v3: use persisted ID if present, else regen (legacy fallback)
            id: persistedId || generateMessageId(mid, ws),
            timestamp,
            author: { machineId: mid, workspace: ws },
            content: unescapedContent
          });
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
        return `### [${msg.timestamp}] ${msg.author.machineId}|${msg.author.workspace}\n[msg: ${msg.id}]\n\n${escapeContent(msg.content)}`;
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
 */
export interface CondenseAttemptInfo {
  phase: 'preemptive' | 'reactive' | 'manual';
  outcome: 'condensed' | 'no-op' | 'llm-failed-dedup' | 'llm-failed-injected';
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
  finalOutcome: 'ok' | 'null' | 'error' | 'timeout' | 'client-init-failed';
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
 * Génère un résumé LLM des messages intercom (#858)
 *
 * @param messages - Messages à résumer
 * @returns Résumé markdown + stats. content = null si échec (3 retries failed).
 */
async function generateLLMSummary(messages: IntercomMessage[]): Promise<LLMCallResult> {
  // #1497: bumped 600s → 1800s (30 min). Qwen3.6 thinking mode can take 60-90s
  // per call on 40KB prompts; with 3 retries + backoff 2s/4s/8s, total
  // wall-clock per call can exceed 5 min. Since the 2 LLM calls now run in
  // parallel (see condenseIntercom), one slow call would still drag the total.
  const timeoutMs = 1800000;

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
    const errStr = error instanceof Error ? error.message : String(error);
    logger.error('LLM client init failed for summary', { error: errStr });
    return {
      content: null,
      stats: { ...emptyLLMStats('client-init-failed'), lastError: truncateError(errStr), elapsedMs: Date.now() - callStart }
    };
  }
  const modelId = getLLMModelId();

  // Retry with exponential backoff (error/empty only — size handled post-hoc)
  for (let attempt = 1; attempt <= LLM_MAX_RETRIES; attempt++) {
    stats.attempts = attempt;
    const startTime = Date.now();
    try {
      const response = await openai.chat.completions.create({
        model: modelId,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        // 2026-04-20: bumped 10000 → 30000. Qwen3.6 thinking mode can easily
        // spend 10k+ tokens on reasoning for a 40KB prompt, leaving the model
        // no room for the actual markdown output — `content` comes back null
        // with finish_reason=length. Room for ~20k thinking + 10k summary.
        max_tokens: 30000,
        temperature: 0.3
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
        stats.lastError = `LLM returned null content ${stats.nullCount}× (finish_reason likely "length" — thinking consumed max_tokens=30000)`;
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
      const errStr = error instanceof Error ? error.message : String(error);
      stats.errorCount += 1;
      const isTimeout = error instanceof Error && error.name === 'AbortError';
      if (isTimeout) {
        stats.timeoutCount += 1;
        logger.warn('LLM summary timeout', { attempt, timeout: timeoutMs, elapsed: `${elapsed}ms` });
      } else {
        logger.error('LLM summary error', { attempt, elapsed: `${elapsed}ms`, error: errStr });
      }
      if (attempt < LLM_MAX_RETRIES) {
        const backoff = LLM_INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1);
        logger.info(`Retrying summary in ${backoff}ms...`, { attempt, backoff });
        await new Promise(resolve => setTimeout(resolve, backoff));
        continue;
      }
      stats.finalOutcome = isTimeout ? 'timeout' : 'error';
      stats.elapsedMs = Date.now() - callStart;
      stats.lastError = truncateError(errStr);
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
  archivedCount: number
): Promise<LLMCallResult> {
  // #1497: bumped 600s → 1800s (30 min) — see generateLLMSummary for rationale.
  const timeoutMs = 1800000;

  // Format messages with archive/keep annotations
  const messagesContent = allMessages.map((msg, index) => {
    const annotation = index < archivedCount ? '[SERA ARCHIVÉ]' : '[CONSERVÉ]';
    const header = `${annotation} [${msg.timestamp}] ${msg.author.machineId}|${msg.author.workspace}`;
    return `${header}\n${msg.content}`;
  }).join('\n\n---\n\n');

  // Extract lastDate from the last message timestamp
  const lastDate = allMessages.length > 0 ? allMessages[allMessages.length - 1].timestamp : new Date().toISOString();

  const systemPrompt = `Tu es un expert en synthèse de dashboards de coordination multi-agents.

CONTEXTE : Le dashboard contient un STATUT (mémoire de travail du projet) et des MESSAGES INTERCOM.
Les messages les plus anciens vont être archivés. Ta mission : mettre à jour le statut en y intégrant les infos importantes des messages qui vont disparaître.

La taille est gérée par une passe de condensation automatique (déclenchée au-delà du seuil) — ici, reste qualitatif sans raisonner en octets.

RÈGLE ABSOLUE — LAST-KNOWN-STATE WINS (#1502) :
Pour CHAQUE sujet (machine, service, tâche), SEUL le dernier état connu doit apparaître.
- Si un message récent dit "vLLM UP" et l'ancien statut dit "vLLM DOWN" → écrire "vLLM UP" UNIQUEMENT.
- Si un message récent dit "[DONE] tâche X" → la tâche X est TERMINÉE, pas "en cours".
- SUPPRIMER explicitement tout fait contredit par une source plus récente. Ne PAS garder les deux versions.

EXIGENCES :
1. ZÉRO perte d'information stratégique (décisions, blocages, livrables, métriques)
2. DATES à jour : timestamps messages récents > dates ancien statut
3. CONTRADICTIONS : messages récents ont TOUJOURS RAISON — SUPPRIMER les faits obsolètes de l'ancien statut
4. [DONE] dans messages récents → TERMINÉ dans statut (JAMAIS "en cours")
5. Métriques chiffrées EXACTES préservées
6. INTÉGRER infos des messages [SERA ARCHIVÉ] sinon perdues
7. Pas d'emojis. Pas de prose. Factuel et structuré.
8. INTERDICTION D'EXTRAPOLER : ne rien afficher qui ne soit pas EXPLICITEMENT dans les sources

STRUCTURE :
## [Workspace] — État au ${lastDate}

### Résumé
[2-3 phrases INTERPRÉTATIVES : état global, tendance — clairement séparé des faits ci-dessous]

### État des systèmes
[FACTUEL uniquement : par entité (machine/service), dernier état connu avec date source]
Format : "- **entité** : état (source: [date])"

### Livrables récents
[Réalisations avec dates — synthétiser par thème, pas par PR/commit individuel]

### En cours
[Tâches actives avec responsable — uniquement celles sans [DONE] récent]

### Blocages / Attention
[Problèmes non résolus — retirer ceux résolus par des messages récents]

### Décisions et métriques
[Choix actés + chiffres clés]

INTERDIT :
- Copier-coller l'ancien statut (SYNTHÉTISER et METTRE À JOUR)
- Garder un fait contredit par un message plus récent (ex: "X DOWN" si un message dit "X UP")
- Garder des tâches terminées depuis longtemps sans valeur de référence
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
    const errStr = error instanceof Error ? error.message : String(error);
    logger.error('LLM client init failed for status update', { error: errStr });
    return {
      content: null,
      stats: { ...emptyLLMStats('client-init-failed'), lastError: truncateError(errStr), elapsedMs: Date.now() - callStart }
    };
  }
  const modelId = getLLMModelId();

  // Retry with exponential backoff
  for (let attempt = 1; attempt <= LLM_MAX_RETRIES; attempt++) {
    stats.attempts = attempt;
    const startTime = Date.now();
    try {
      const response = await openai.chat.completions.create({
        model: modelId,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        // 2026-04-20: bumped 10000 → 30000 (see generateLLMSummary for rationale).
        max_tokens: 30000,
        temperature: 0.3
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
        stats.lastError = `LLM returned null content ${stats.nullCount}× (finish_reason likely "length" — thinking consumed max_tokens=30000)`;
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
      const errStr = error instanceof Error ? error.message : String(error);
      stats.errorCount += 1;
      const isTimeout = error instanceof Error && error.name === 'AbortError';
      if (isTimeout) {
        stats.timeoutCount += 1;
        logger.warn('LLM status update timeout', { attempt, timeout: timeoutMs, elapsed: `${elapsed}ms` });
      } else {
        logger.error('LLM status update error', { attempt, elapsed: `${elapsed}ms`, error: errStr });
      }
      if (attempt < LLM_MAX_RETRIES) {
        const backoff = LLM_INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1);
        logger.info(`Retrying status update in ${backoff}ms...`, { attempt, backoff });
        await new Promise(resolve => setTimeout(resolve, backoff));
        continue;
      }
      stats.finalOutcome = isTimeout ? 'timeout' : 'error';
      stats.elapsedMs = Date.now() - callStart;
      stats.lastError = truncateError(errStr);
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
async function condenseTextIfTooLarge(
  text: string,
  maxSizeBytes: number,
  label: string
): Promise<string> {
  const sizeBytes = Buffer.byteLength(text, 'utf8');
  if (sizeBytes <= maxSizeBytes) return text;

  logger.info(`${label} exceeds size limit, auto-condensing`, { sizeBytes, limit: maxSizeBytes, sizeKB: `${(sizeBytes / 1024).toFixed(1)}KB` });

  let openai: OpenAI;
  try {
    openai = getChatOpenAIClient();
  } catch {
    logger.warn(`Cannot auto-condense ${label}: no LLM client`);
    return text;
  }
  const modelId = getLLMModelId();

  const systemPrompt = `Tu es un expert en synthèse. Le texte suivant dépasse la limite de ${Math.round(maxSizeBytes / 1024)} Ko.

MISSION : Condenser ce texte en dessous de ${Math.round(maxSizeBytes / 1024)} Ko tout en préservant TOUTE l'information critique.

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
- SUPPRIMER les faits contredits par des informations plus récentes dans le texte (#1502)`;

  const startTime = Date.now();
  try {
    const response = await openai.chat.completions.create({
      model: modelId,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: text }
      ],
      // 2026-04-20: bumped 10000 → 30000 (see generateLLMSummary for rationale).
      max_tokens: 30000,
      temperature: 0.3
    }, {
      timeout: 900000  // #1497: 5 min → 15 min, accommodate thinking-mode latency
    });

    const condensed = response.choices[0]?.message?.content;
    if (!condensed) {
      logger.warn(`Auto-condense ${label}: LLM returned empty, keeping original`);
      return text;
    }

    const newSize = Buffer.byteLength(condensed, 'utf8');
    const elapsed = Date.now() - startTime;
    logger.info(`Auto-condensed ${label}`, {
      elapsed: `${elapsed}ms`,
      beforeKB: `${(sizeBytes / 1024).toFixed(1)}KB`,
      afterKB: `${(newSize / 1024).toFixed(1)}KB`,
      reduction: `${Math.round((1 - newSize / sizeBytes) * 100)}%`
    });
    return condensed;

  } catch (error) {
    const elapsed = Date.now() - startTime;
    logger.warn(`Auto-condense ${label} failed, keeping original`, {
      elapsed: `${elapsed}ms`,
      error: error instanceof Error ? error.message : String(error)
    });
    return text;
  }
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
 * #1792: Simple FIFO truncation fallback when LLM is unavailable.
 * Keeps `keepCount` most recent messages, archives the rest with a template summary.
 * No LLM calls — deterministic and fast.
 */
async function condenseWithFallback(
  key: string,
  dashboard: Dashboard,
  keepCount: number,
  diagnostic?: CondenseAttemptInfo
): Promise<Dashboard> {
  const start = Date.now();
  const messages = dashboard.intercom.messages;
  const effectiveKeep = Math.min(keepCount, FALLBACK_TRUNCATE_KEEP);
  const toArchive = messages.slice(0, messages.length - effectiveKeep);
  const toKeep = messages.slice(messages.length - effectiveKeep);

  if (toArchive.length === 0) {
    if (diagnostic) {
      diagnostic.outcome = 'no-op';
      diagnostic.elapsedMs = Date.now() - start;
      diagnostic.archivedMessageCount = 0;
    }
    return dashboard;
  }

  logger.info('Condensation fallback: simple FIFO truncation', {
    key,
    totalMessages: messages.length,
    toArchive: toArchive.length,
    toKeep: toKeep.length,
    reason: 'circuit-breaker-open'
  });

  // Build a simple template summary (no LLM)
  const archivedAuthors = [...new Set(toArchive.map(m => m.author.machineId))];
  const archivedSpan = toArchive.length > 0
    ? `${toArchive[0].timestamp.slice(0, 16)} → ${toArchive[toArchive.length - 1].timestamp.slice(0, 16)}`
    : 'N/A';
  const fallbackSummary = `**FALLBACK TRUNCATION** - ${new Date().toISOString()}\n\n`
    + `${toArchive.length} messages archivés (FIFO, pas de résumé LLM — endpoint indisponible).\n`
    + `Période: ${archivedSpan}\n`
    + `Auteurs: ${archivedAuthors.join(', ')}\n`
    + `Raison: circuit breaker actif après ${CB_FAILURE_THRESHOLD}+ échecs LLM consécutifs.\n`
    + `Les messages complets sont préservés dans l'archive.`;

  // Archive the old messages (same pattern as condenseIntercom)
  const archiveDir = getArchiveDir();
  await fs.mkdir(archiveDir, { recursive: true });
  const dateStr = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
  const archivePath = path.join(archiveDir, `${key}-${dateStr}.md`);
  const archiveFrontmatter = yaml.dump({
    type: 'archive',
    originalKey: key,
    archivedAt: new Date().toISOString(),
    messageCount: toArchive.length,
    llmGenerated: false,
    fallback: true,
    circuitBreaker: true
  });
  const archiveMessages = toArchive.map(msg =>
    `### [${msg.timestamp}] ${msg.author.machineId}|${msg.author.workspace}\n\n${msg.content}`
  ).join('\n\n---\n\n');
  const archiveContent = `---
${archiveFrontmatter.trim()}
---

# Archive (FALLBACK) : ${key}

Archivé le : ${new Date().toISOString()}
Messages : ${toArchive.length}
Mode : FIFO truncation (circuit breaker, pas de LLM)

---

${archiveMessages}
`;
  await fs.writeFile(archivePath, archiveContent, 'utf8');
  logger.info('Fallback archive written', { key, count: toArchive.length, archivePath });

  // Build fallback notice message
  const fallbackNotice: IntercomMessage = {
    id: generateMessageId('system', 'system'),
    timestamp: new Date().toISOString(),
    author: { machineId: 'system', workspace: 'system' },
    content: `**[FALLBACK] CONDENSATION TRUNCATION** - ${new Date().toISOString()}\n\n`
      + `${toArchive.length} messages archivés par truncation FIFO (LLM indisponible, circuit breaker actif).\n`
      + `Période archivée: ${archivedSpan}\n`
      + `Archive: \`${path.basename(archivePath)}\`\n`
      + `Messages conservés: ${toKeep.length}`
  };

  if (diagnostic) {
    diagnostic.outcome = 'condensed';
    diagnostic.elapsedMs = Date.now() - start;
    diagnostic.archivedMessageCount = toArchive.length;
    diagnostic.llm = undefined;
  }

  return {
    ...dashboard,
    lastModified: new Date().toISOString(),
    status: { ...dashboard.status, markdown: dashboard.status.markdown },
    intercom: {
      ...dashboard.intercom,
      messages: [...toKeep, fallbackNotice],
      totalMessages: dashboard.intercom.totalMessages + 1
    }
  };
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

  // #1792: Circuit breaker — skip LLM and use fallback truncation when breaker is open
  if (isCircuitOpen(key)) {
    logger.info('Condensation circuit breaker OPEN — using fallback truncation', {
      key,
      circuitState: getCircuit(key),
      cooldownRemaining: `${Math.round((CB_COOLDOWN_MS - (Date.now() - getCircuit(key).lastFailureTime)) / 60000)}min`
    });
    return condenseWithFallback(key, dashboard, keepCount, diagnostic);
  }

  // #858 : Générer les résumés LLM AVANT d'archiver
  // Pass ALL messages to status update so LLM sees full context
  const previousStatus = dashboard.status.markdown;

  // #1497: Run the 2 LLM calls in parallel (status update + summary) — they are
  // independent (both take messages as input, neither depends on the other's
  // output). Halves wall-clock latency from ~2×T to ~T, critical when condense
  // races the client timeout. A single failing call still cancels condensation
  // via the existing null-check below.
  const tParallel = Date.now();
  const [statusCall, summaryCall] = await Promise.all([
    generateStatusUpdate(previousStatus, messages, toArchive.length),
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

  // Both LLM calls are MANDATORY — if either fails, cancel condensation
  if (!llmSummary || !newStatus) {
    logger.warn('LLM call failed, condensation cancelled', {
      key,
      messageCount: toArchive.length,
      summaryOk: !!llmSummary,
      statusOk: !!newStatus,
      summaryOutcome: summaryCall.stats.finalOutcome,
      statusOutcome: statusCall.stats.finalOutcome
    });

    // #1792: Record LLM failure for circuit breaker
    recordCircuitFailure(key);

    // Inject a visible [ERROR] system message so next readers see the failure.
    // Deduped over CONDENSATION_ERROR_DEDUP_MS to avoid filling the dashboard
    // when LLM stays down across multiple append() triggers.
    const existing = dashboard.intercom.messages;
    const lastErrorIdx = [...existing].reverse().findIndex(
      m => m.author.machineId === 'system'
        && m.content.includes('[ERROR] CONDENSATION CANCELLED')
    );
    const recentErrorExists = lastErrorIdx !== -1
      && (Date.now() - new Date(
           existing[existing.length - 1 - lastErrorIdx].timestamp
         ).getTime()) < CONDENSATION_ERROR_DEDUP_MS;

    if (recentErrorExists) {
      if (diagnostic) {
        diagnostic.outcome = 'llm-failed-dedup';
        diagnostic.elapsedMs = Date.now() - condensationStart;
        diagnostic.archivedMessageCount = 0;
      }
      return dashboard; // Déjà signalé récemment, pas de spam
    }

    const errorTimestamp = new Date().toISOString();
    const statusOkLabel = newStatus ? 'OK' : `FAILED (${statusCall.stats.finalOutcome})`;
    const summaryOkLabel = llmSummary ? 'OK' : `FAILED (${summaryCall.stats.finalOutcome})`;
    const errorMessage: IntercomMessage = {
      id: generateMessageId('system', 'system'),
      timestamp: errorTimestamp,
      author: { machineId: 'system', workspace: 'system' },
      content: `**[ERROR] CONDENSATION CANCELLED** - ${errorTimestamp}\n\n`
        + `LLM calls failed after ${LLM_MAX_RETRIES} retries (backoff 2s/4s/8s):\n`
        + `- Status update: ${statusOkLabel} (${Math.round(statusCall.stats.elapsedMs / 1000)}s, `
        + `null×${statusCall.stats.nullCount}, err×${statusCall.stats.errorCount})\n`
        + `- Summary generation: ${summaryOkLabel} (${Math.round(summaryCall.stats.elapsedMs / 1000)}s, `
        + `null×${summaryCall.stats.nullCount}, err×${summaryCall.stats.errorCount})\n`
        + (statusCall.stats.lastError ? `- Status last error: ${statusCall.stats.lastError}\n` : '')
        + (summaryCall.stats.lastError ? `- Summary last error: ${summaryCall.stats.lastError}\n` : '')
        + `\nDashboard left unchanged (${dashboard.intercom.messages.length} messages). `
        + `Verify LLM endpoint (OPENAI_CHAT_API_BASE / OPENAI_CHAT_MODEL_ID) and retry. `
        + `Next condensation attempt will occur on the next append exceeding the `
        + `${Math.round(MAX_DASHBOARD_SIZE_BYTES / 1024)}KB threshold.`
    };

    if (diagnostic) {
      diagnostic.outcome = 'llm-failed-injected';
      diagnostic.elapsedMs = Date.now() - condensationStart;
      diagnostic.archivedMessageCount = 0;
    }

    return {
      ...dashboard,
      lastModified: errorTimestamp,
      intercom: {
        ...dashboard.intercom,
        messages: [...dashboard.intercom.messages, errorMessage],
        totalMessages: dashboard.intercom.totalMessages + 1
      }
    };
  }

  // Both operations succeeded — now auto-condense if outputs exceed size limits
  // #1792: Reset circuit breaker on successful LLM call
  recordCircuitSuccess(key);
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

    case 'condense':
      // Serialized: manual condense must not race with auto-condense from append
      return withKeyLock(key, () => handleCondense(key, args, requestEcho));
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
  // intercomLimit is kept as an optional safety net but defaults to returning ALL messages.
  // The dashboard should stay under 50KB thanks to size-based condensation,
  // so agents always see the full picture without needing to paginate.
  const intercomLimit = args.intercomLimit;
  let data: Partial<Dashboard> = {};

  if (section === 'status' || section === 'all') {
    data.status = dashboard.status;
  }
  if (section === 'intercom' || section === 'all') {
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
  if (section === 'all') {
    data = {
      type: dashboard.type,
      key: dashboard.key,
      lastModified: dashboard.lastModified,
      lastModifiedBy: dashboard.lastModifiedBy,
      ...data
    };
  }

  return {
    success: true,
    action: 'read',
    key,
    type: args.type!,
    request: requestEcho,
    sizes: buildSizes(dashboard),
    data,
    messageCount: dashboard.intercom.messages.length
  };
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

  // #1497: Preemptive condensation at 92% utilization
  // Runs BEFORE the new message is appended, so condense operates on the existing
  // messages (current state) rather than waiting for the post-append size check
  // to fire at 100%. Prevents client-side timeout when dashboard is near-saturation.
  //
  // Concurrency contract: this function is NOT serialized per-key. Concurrent
  // appends to the same dashboard that both cross the 92% threshold will each
  // enter condenseIntercom, and the writeDashboardFile at the end uses
  // last-writer-wins semantics (same as the pre-existing reactive path). The
  // #1497 change does not introduce a new race beyond what already exists in
  // the reactive condense at 100%. If strict serialization is needed, wrap this
  // handler in a per-key mutex (see future issue if observed in production).
  // NOTE: `dashboard` is reassigned below — subsequent code must use the
  // post-condense binding.
  let preemptivelyCondensed = false;
  let preemptivelyArchivedCount = 0;
  const condenseDiagnostics: CondenseAttemptInfo[] = [];
  const preAppendSize = estimateDashboardSize(dashboard);
  if (preAppendSize >= PREEMPTIVE_CONDENSE_THRESHOLD_BYTES && dashboard.intercom.messages.length > CONDENSE_KEEP) {
    logger.info('Preemptive condensation triggered (#1497)', {
      key,
      preAppendSize: `${Math.round(preAppendSize / 1024)}KB`,
      preemptiveThreshold: `${Math.round(PREEMPTIVE_CONDENSE_THRESHOLD_BYTES / 1024)}KB (92% of ${Math.round(MAX_DASHBOARD_SIZE_BYTES / 1024)}KB)`,
      messageCount: dashboard.intercom.messages.length
    });
    const beforePreemptive = dashboard.intercom.messages.length;
    const preemptiveDiag = newDiagnostic('preemptive');
    const tPre = Date.now();
    dashboard = await condenseIntercom(key, dashboard, CONDENSE_KEEP, preemptiveDiag);
    preemptiveCondenseMs = Date.now() - tPre;
    condenseDiagnostics.push(preemptiveDiag);
    preemptivelyArchivedCount = beforePreemptive - dashboard.intercom.messages.length;
    preemptivelyCondensed = preemptivelyArchivedCount > 0;
  }

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
    content: partContent
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

  // Auto-condensation based on file size (50KB threshold)
  // Estimate the file size by serializing the dashboard content
  // NOTE (#1497): preemptive condense above should normally keep us below this
  // threshold. This remains as a safety net for edge cases (very large single
  // messages, pre-condense skipped because below message count threshold).
  let condensed = preemptivelyCondensed;
  let archivedCount = preemptivelyArchivedCount;
  let finalDashboard = updatedDashboard;
  const estimatedSize = estimateDashboardSize(updatedDashboard);
  if (estimatedSize > MAX_DASHBOARD_SIZE_BYTES && updatedDashboard.intercom.messages.length > CONDENSE_KEEP) {
    logger.info('Auto-condensation déclenchée (taille)', {
      key,
      estimatedSize: `${Math.round(estimatedSize / 1024)}KB`,
      threshold: `${Math.round(MAX_DASHBOARD_SIZE_BYTES / 1024)}KB`,
      messageCount: updatedDashboard.intercom.messages.length
    });
    const beforeCount = updatedDashboard.intercom.messages.length;
    const reactiveDiag = newDiagnostic('reactive');
    const tReact = Date.now();
    finalDashboard = await condenseIntercom(key, updatedDashboard, CONDENSE_KEEP, reactiveDiag);
    reactiveCondenseMs = Date.now() - tReact;
    condenseDiagnostics.push(reactiveDiag);
    const newlyArchived = beforeCount - finalDashboard.intercom.messages.length;
    archivedCount += newlyArchived;
    condensed = condensed || newlyArchived > 0;
  }

  const tWrite = Date.now();
  await writeDashboardFile(key, finalDashboard);
  writeMs = Date.now() - tWrite;

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
  let diagSuffix = '';
  if (condenseDiagnostics.length > 0 && !condensed) {
    const failed = condenseDiagnostics.filter(d =>
      d.outcome === 'llm-failed-dedup' || d.outcome === 'llm-failed-injected'
    );
    if (failed.length > 0) {
      const first = failed[0];
      const totalS = Math.round(failed.reduce((sum, d) => sum + d.elapsedMs, 0) / 1000);
      const summary = first.llm?.summary;
      const status = first.llm?.status;
      const llmBits: string[] = [];
      if (summary) llmBits.push(`summary=${summary.finalOutcome}×${summary.attempts}`);
      if (status) llmBits.push(`status=${status.finalOutcome}×${status.attempts}`);
      const dedupNote = failed.some(d => d.outcome === 'llm-failed-dedup')
        ? ' [recent error msg within dedup window → not re-injected]'
        : '';
      diagSuffix = ` — LLM échoué (${totalS}s total, ${llmBits.join(', ')})${dedupNote}`;
    }
  }

  const totalMs = Date.now() - appendStart;
  const splitSuffix = isMultiPart ? ` [split en ${newMessages.length} parts]` : '';

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

async function handleCondense(
  key: string,
  args: DashboardArgs,
  requestEcho: DashboardRequestEcho
): Promise<DashboardResult> {
  const dashboard = await readDashboardFile(key);
  if (!dashboard) {
    return {
      success: false,
      action: 'condense',
      key,
      type: args.type!,
      request: requestEcho,
      message: `Dashboard '${key}' introuvable`
    };
  }

  const keepCount = args.keepMessages ?? CONDENSE_KEEP;
  const beforeCount = dashboard.intercom.messages.length;

  if (beforeCount <= keepCount) {
    return {
      success: true,
      action: 'condense',
      key,
      type: args.type!,
      request: requestEcho,
      sizes: buildSizes(dashboard),
      messageCount: beforeCount,
      condensed: false,
      archivedCount: 0,
      message: `Aucune condensation nécessaire (${beforeCount} messages ≤ seuil ${keepCount})`
    };
  }

  const condenseStart = Date.now();
  const manualDiag = newDiagnostic('manual');
  const condensedDashboard = await condenseIntercom(key, dashboard, keepCount, manualDiag);
  const condenseElapsed = Date.now() - condenseStart;
  const actuallyCondensed = condensedDashboard.intercom.messages.length < beforeCount;
  // Persist whenever the dashboard changed — either condensation succeeded
  // (count decreased) or LLM failed and an ERROR system message was injected
  // (count increased). writeDashboardFile is atomic (tmp+rename).
  const dashboardChanged = condensedDashboard.intercom.messages.length !== beforeCount;

  if (dashboardChanged) {
    await writeDashboardFile(key, condensedDashboard);
  }

  const archivedCount = actuallyCondensed ? beforeCount - condensedDashboard.intercom.messages.length : 0;

  // Build a rich diag suffix when the LLM failed, so the tool's `message` field
  // carries the "why" without requiring the caller to parse condenseDiagnostic.
  let failureDetail = '';
  if (!actuallyCondensed && manualDiag.llm) {
    const summary = manualDiag.llm.summary;
    const status = manualDiag.llm.status;
    const llmBits = [
      `summary=${summary.finalOutcome}×${summary.attempts} (${Math.round(summary.elapsedMs / 1000)}s)`,
      `status=${status.finalOutcome}×${status.attempts} (${Math.round(status.elapsedMs / 1000)}s)`
    ];
    failureDetail = ` [${llmBits.join(', ')}]`;
    if (manualDiag.outcome === 'llm-failed-dedup') {
      failureDetail += ' (dedup: recent error msg within window, not re-injected)';
    }
  }

  return {
    success: true,
    action: 'condense',
    key,
    type: args.type!,
    request: requestEcho,
    sizes: buildSizes(condensedDashboard),
    messageCount: condensedDashboard.intercom.messages.length,
    condensed: actuallyCondensed,
    archivedCount,
    condenseDiagnostic: [manualDiag],
    message: actuallyCondensed
      ? `Condensation terminée en ${Math.round(condenseElapsed / 1000)}s : ${archivedCount} messages archivés, ${condensedDashboard.intercom.messages.length} conservés`
      : `Condensation annulée (LLM indisponible) — ${beforeCount} messages inchangés (${Math.round(condenseElapsed / 1000)}s)${failureDetail}`
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

  return {
    success: true,
    action: 'read_overview',
    key: `overview-${resolvedMachineId}-${resolvedWorkspace}`,
    type: 'overview',
    request: requestEcho,
    overview,
    message: `Vue d'ensemble: ${foundCount}/3 dashboards trouvés (machine: ${resolvedMachineId}, workspace: ${resolvedWorkspace})`
  };
}

async function handleList(requestEcho: DashboardRequestEcho): Promise<DashboardResult> {
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
    return {
      success: true,
      action: 'list',
      key: '',
      type: '',
      request: requestEcho,
      dashboards: summaries,
      message: `${summaries.length} dashboard(s) trouvé(s)`
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
          message: `⛔ REFUSÉ: Dashboard '${key}' modifié il y a ${ageDays.toFixed(1)} jours (seuil: ${DASHBOARD_PROTECTION_DAYS}j). ${messageCount} messages seraient perdus. Utilisez 'condense' pour archiver les anciens messages sans supprimer le dashboard.`
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
      // v3 (#1363): persisted `[msg: <id>]` line optionnelle
      const headerMatch = block.match(/### \[([^\]]+)\]\s+([^|]+)\|([^|\s]+)(\s+\[[^\]]+\])?\n(?:\[msg: ([^\]]+)\]\n)?\n([\s\S]+)/);
      if (headerMatch) {
        const [, timestamp, machineId, workspace, , persistedId, msgContent] = headerMatch;
        messages.push({
          id: persistedId || generateMessageId(machineId, workspace),
          timestamp,
          author: { machineId, workspace },
          content: msgContent.trim()
        });
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
