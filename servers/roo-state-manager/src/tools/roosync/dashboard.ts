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
import { getChatOpenAIClient } from '../../services/openai.js';
import {
  sendMentionNotificationsAsync,
  sendStructuredMentionNotificationsAsync,
  resolveMentionTarget
} from '../../utils/dashboard-helpers.js';
import type OpenAI from 'openai';

const logger: Logger = createLogger('DashboardTool');

// Auto-condensation: size-based (50KB) + keep 10 most recent messages
// When dashboard file exceeds MAX_DASHBOARD_SIZE_BYTES, condense old messages
// into the status section via LLM, keeping only CONDENSE_KEEP recent messages.
const MAX_DASHBOARD_SIZE_BYTES = 50 * 1024; // 50 KB
const CONDENSE_KEEP = 10;

// #1497: Preemptive condensation threshold (85% of MAX)
// Triggered BEFORE appending a new message when the dashboard is near-full, so
// that the condense (which can take ~30s via LLM) completes on smaller data
// and does not timeout the client call at 96%+ utilization (reported by
// nanoclaw-cluster, 2026-04-17T22:17Z). Rationale: appending to a 96% dashboard
// forces condense of ~50 messages at LLM speed; pre-condensing at 85% keeps
// the working set smaller and shifts the latency into more predictable slots.
const PREEMPTIVE_CONDENSE_THRESHOLD_BYTES = Math.floor(MAX_DASHBOARD_SIZE_BYTES * 0.85); // ~42.5 KB

// Size limits for LLM outputs (bytes). If exceeded, retry with a stricter prompt.
const MAX_STATUS_SIZE_BYTES = 15 * 1024;  // 15 KB
const MAX_SUMMARY_SIZE_BYTES = 5 * 1024;  // 5 KB
const LLM_MAX_RETRIES = 3;
const LLM_INITIAL_BACKOFF_MS = 2000; // 2s, doubles each retry

// Dedup window for [ERROR] CONDENSATION CANCELLED system messages (prevent loop
// when LLM is down and every append re-triggers a failed condensation).
const CONDENSATION_ERROR_DEDUP_MS = 5 * 60 * 1000; // 5 minutes

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

// === Schemas Zod ===

export const AuthorSchema = z.object({
  machineId: z.string().describe('ID de la machine'),
  workspace: z.string().describe('Workspace ID'),
  worktree: z.string().optional().describe('Worktree path (si applicable)')
});

export type Author = z.infer<typeof AuthorSchema>;

export const IntercomMessageSchema = z.object({
  id: z.string().describe('ID unique du message (ic-{timestamp})'),
  timestamp: z.string().describe('ISO 8601 timestamp'),
  author: AuthorSchema,
  content: z.string().describe('Contenu markdown du message')
});

export type IntercomMessage = z.infer<typeof IntercomMessageSchema>;

// === Mentions v3 (#1363) ===
// userId = { machineId, workspace } tuple. Mention notifies exactly one userId
// (either directly via userId or indirectly via messageId whose author = userId).
// Exactly one of userId/messageId must be provided (XOR).

export const UserIdSchema = z.object({
  machineId: z.string().describe('ID de la machine'),
  workspace: z.string().describe('Workspace ID')
});

export type UserId = z.infer<typeof UserIdSchema>;

export const MentionSchema = z.object({
  userId: UserIdSchema.optional()
    .describe('userId explicite à mentionner (exclusif avec messageId)'),
  messageId: z.string().optional()
    .describe('ID de message à référencer (format: machineId:workspace:ic-...). Résout en userId = auteur du message référencé.'),
  note: z.string().optional()
    .describe('Note optionnelle expliquant la raison de la mention')
}).refine(
  (m) => (m.userId !== undefined) !== (m.messageId !== undefined),
  { message: 'mention: exactement un de userId ou messageId doit être fourni' }
);

export type Mention = z.infer<typeof MentionSchema>;

export const CrossPostSchema = z.object({
  type: z.enum(['global', 'machine', 'workspace'])
    .describe('Type de dashboard cible'),
  machineId: z.string().optional()
    .describe('machineId cible (pour type=machine)'),
  workspace: z.string().optional()
    .describe('workspace cible (pour type=workspace)')
});

export type CrossPost = z.infer<typeof CrossPostSchema>;

// Dashboard au format Markdown (avec frontmatter YAML)
export interface Dashboard {
  type: 'global' | 'machine' | 'workspace';
  key: string;
  lastModified: string;
  lastModifiedBy: Author;
  status: {
    markdown: string;
    lastDiffCommit?: string;
  };
  intercom: {
    messages: IntercomMessage[];
    totalMessages: number;
    lastCondensedAt?: string;
  };
}

// Frontmatter YAML (méta-données du fichier Markdown)
export interface DashboardFrontmatter {
  type: Dashboard['type'];
  lastModified: string;
  lastModifiedBy: Author;
  totalMessages?: number;
  lastCondensedAt?: string;
}

// Schema args pour l'outil MCP
export const DashboardArgsSchema = z.object({
  action: z.enum(['read', 'write', 'append', 'condense', 'list', 'delete', 'read_archive', 'read_overview'])
    .describe('Action : read, write, append, condense, list (tous dashboards), delete (supprimer), read_archive (lire archives), read_overview (vue concaténée des 3 niveaux)'),

  type: z.enum(['global', 'machine', 'workspace']).optional()
    .describe('Type de dashboard (requis sauf pour action=list)'),

  machineId: z.string().optional()
    .describe('ID machine (défaut: machine locale). Utilisé pour type machine'),

  workspace: z.string().optional()
    .describe('Workspace (défaut: workspace courant). Utilisé pour type workspace'),

  // Pour read
  section: z.enum(['status', 'intercom', 'all']).optional()
    .describe('Section à lire (défaut: all)'),
  intercomLimit: z.number().optional()
    .describe('Nombre max de messages intercom retournés (défaut: tous). Le dashboard est auto-condensé à 50KB, donc tous les messages sont normalement visibles.'),
  mentionsOnly: z.boolean().optional()
    .describe('(read) Ne retourner que les messages mentionnant la machine/agent courant (défaut: false)'),

  // Pour write (section status)
  content: z.string().optional()
    .describe('Contenu markdown pour write (remplace status.markdown) ou append (nouveau message)'),
  author: AuthorSchema.optional()
    .describe('Auteur de la modification (requis pour write/append)'),
  createIfNotExists: z.boolean().optional()
    .describe('Créer le dashboard s\'il n\'existe pas (défaut: true)'),
  messageId: z.string().optional()
    .describe('(append) ID optionnel pour le message (ex: hash GitHub issue). Si absent, généré automatiquement.'),

  // Mentions v3 (#1363) — structured mentions with RooSync auto-notify
  mentions: z.array(MentionSchema).optional()
    .describe('(append) Mentions structurées. Chaque entrée = userId XOR messageId. Notifie les destinataires via RooSync.'),

  // Cross-post v3 (#1363) — multi-write without notification
  crossPost: z.array(CrossPostSchema).optional()
    .describe('(append) Cross-post le même message vers d\'autres dashboards (sans notification RooSync).'),

  // Pour condense
  keepMessages: z.number().optional()
    .describe('Nombre de messages à conserver lors de la condensation (défaut: 10)'),

  // Pour read_archive
  archiveFile: z.string().optional()
    .describe('(read_archive) Nom du fichier archive à lire. Si absent, liste les archives disponibles.')
}).passthrough();

export type DashboardArgs = z.infer<typeof DashboardArgsSchema> & Record<string, any>;

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
      return `machine-${machineId}`;
    case 'workspace':
      return `workspace-${workspace}`;
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
 * Génère un résumé LLM des messages intercom (#858)
 *
 * @param messages - Messages à résumer
 * @returns Résumé markdown ou null si échec (fallback)
 */
async function generateLLMSummary(messages: IntercomMessage[]): Promise<string | null> {
  const timeoutMs = 600000; // 600 secondes (10 minutes — LLM local peut mettre du temps à démarrer)

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

  let openai: OpenAI;
  try {
    openai = getChatOpenAIClient();
  } catch (error) {
    logger.error('LLM client init failed for summary', { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
  const modelId = process.env.OPENAI_CHAT_MODEL_ID || 'qwen3.6-35b-a3b';

  // Retry with exponential backoff (error/empty only — size handled post-hoc)
  for (let attempt = 1; attempt <= LLM_MAX_RETRIES; attempt++) {
    const startTime = Date.now();
    try {
      const response = await openai.chat.completions.create({
        model: modelId,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        max_tokens: 10000,
        temperature: 0.3
      }, {
        timeout: timeoutMs
      });

      const summary = response.choices[0]?.message?.content;
      if (!summary) {
        logger.warn('LLM returned empty summary', { attempt });
        if (attempt < LLM_MAX_RETRIES) {
          const backoff = LLM_INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1);
          logger.info(`Retrying summary in ${backoff}ms...`, { attempt, backoff });
          await new Promise(resolve => setTimeout(resolve, backoff));
          continue;
        }
        return null;
      }

      const sizeBytes = Buffer.byteLength(summary, 'utf8');
      const elapsed = Date.now() - startTime;
      logger.info('LLM summary generated', { attempt, elapsed: `${elapsed}ms`, summaryLength: summary.length, sizeKB: `${(sizeBytes / 1024).toFixed(1)}KB` });
      return summary;

    } catch (error: unknown) {
      const elapsed = Date.now() - startTime;
      if (error instanceof Error && error.name === 'AbortError') {
        logger.warn('LLM summary timeout', { attempt, timeout: timeoutMs, elapsed: `${elapsed}ms` });
      } else {
        logger.error('LLM summary error', { attempt, elapsed: `${elapsed}ms`, error: error instanceof Error ? error.message : String(error) });
      }
      if (attempt < LLM_MAX_RETRIES) {
        const backoff = LLM_INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1);
        logger.info(`Retrying summary in ${backoff}ms...`, { attempt, backoff });
        await new Promise(resolve => setTimeout(resolve, backoff));
        continue;
      }
      return null;
    }
  }

  return null;
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
): Promise<string | null> {
  const timeoutMs = 600000; // 600 secondes (10 minutes — LLM local peut mettre du temps à démarrer)

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
Les messages les plus anciens vont être archivés. Ta mission : RÉÉCRIRE le statut en y INTÉGRANT les infos importantes des messages qui vont disparaître.

Le statut doit rester COMPACT (max 15 Ko) tout en préservant l'information critique.
Viser 50-100 lignes. Au-delà, synthétiser plus agressivement.

EXIGENCES :
1. ZÉRO perte d'information stratégique (décisions, blocages, livrables, métriques)
2. DATES à jour : timestamps messages récents > dates ancien statut
3. CONTRADICTIONS : messages récents ont RAISON (plus frais)
4. [DONE] dans messages récents → TERMINÉ dans statut (pas "en cours")
5. Métriques chiffrées EXACTES préservées
6. INTÉGRER infos des messages [SERA ARCHIVÉ] sinon perdues
7. Pas d'emojis. Pas de prose. Factuel et structuré.

STRUCTURE :
## [Workspace] — État au ${lastDate}

### Résumé
[2-3 phrases : état global, tendance]

### Livrables récents
[Réalisations avec dates — synthétiser par thème, pas par PR/commit individuel]

### En cours
[Tâches actives avec responsable]

### Blocages / Attention
[Problèmes non résolus]

### Décisions et métriques
[Choix actés + chiffres clés]

NE PAS :
- Copier-coller l'ancien statut (SYNTHÉTISER et METTRE À JOUR)
- Garder des tâches terminées depuis longtemps sans valeur de référence
- Lister chaque commit/PR individuellement
- Inventer des informations absentes des sources`;

  const userPrompt = `**Statut précédent :**
${previousStatus}

**${allMessages.length} messages intercom (dont ${archivedCount} seront archivés, ${allMessages.length - archivedCount} conservés) :**
${messagesContent}

Réécris le statut en intégrant les informations des messages [SERA ARCHIVÉ]. Date de référence : ${lastDate}.`;

  logger.info('Calling LLM for status update', {
    previousStatusLength: previousStatus.length,
    messageCount: allMessages.length,
    archivedCount
  });

  let openai: OpenAI;
  try {
    openai = getChatOpenAIClient();
  } catch (error) {
    logger.error('LLM client init failed for status update', { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
  const modelId = process.env.OPENAI_CHAT_MODEL_ID || 'qwen3.6-35b-a3b';

  // Retry with exponential backoff
  for (let attempt = 1; attempt <= LLM_MAX_RETRIES; attempt++) {
    const startTime = Date.now();
    try {
      const response = await openai.chat.completions.create({
        model: modelId,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        max_tokens: 10000,
        temperature: 0.3
      }, {
        timeout: timeoutMs
      });

      const newStatus = response.choices[0]?.message?.content;
      if (!newStatus) {
        logger.warn('LLM returned empty status update', { attempt });
        if (attempt < LLM_MAX_RETRIES) {
          const backoff = LLM_INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1);
          logger.info(`Retrying status update in ${backoff}ms...`, { attempt, backoff });
          await new Promise(resolve => setTimeout(resolve, backoff));
          continue;
        }
        return null;
      }

      const sizeBytes = Buffer.byteLength(newStatus, 'utf8');
      const elapsed = Date.now() - startTime;
      logger.info('LLM status update generated', { attempt, elapsed: `${elapsed}ms`, newStatusLength: newStatus.length, sizeKB: `${(sizeBytes / 1024).toFixed(1)}KB` });
      return newStatus;

    } catch (error: unknown) {
      const elapsed = Date.now() - startTime;
      if (error instanceof Error && error.name === 'AbortError') {
        logger.warn('LLM status update timeout', { attempt, timeout: timeoutMs, elapsed: `${elapsed}ms` });
      } else {
        logger.error('LLM status update error', { attempt, elapsed: `${elapsed}ms`, error: error instanceof Error ? error.message : String(error) });
      }
      if (attempt < LLM_MAX_RETRIES) {
        const backoff = LLM_INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1);
        logger.info(`Retrying status update in ${backoff}ms...`, { attempt, backoff });
        await new Promise(resolve => setTimeout(resolve, backoff));
        continue;
      }
      return null;
    }
  }

  return null;
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
  const modelId = process.env.OPENAI_CHAT_MODEL_ID || 'qwen3.6-35b-a3b';

  const systemPrompt = `Tu es un expert en synthèse. Le texte suivant dépasse la limite de ${Math.round(maxSizeBytes / 1024)} Ko.

MISSION : Condenser ce texte en dessous de ${Math.round(maxSizeBytes / 1024)} Ko tout en préservant TOUTE l'information critique.

RÈGLES :
- Préserver les métriques chiffrées exactes
- Préserver les dates et décisions
- Fusionner les éléments redondants
- Supprimer les formulations verbeuses, garder le factuel
- Supprimer les sections obsolètes (tâches terminées sans valeur de référence)
- Pas d'emojis, pas de prose
- Le résultat DOIT être plus court que l'original`;

  const startTime = Date.now();
  try {
    const response = await openai.chat.completions.create({
      model: modelId,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: text }
      ],
      max_tokens: 10000,
      temperature: 0.3
    }, {
      timeout: 300000  // 5 minutes
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
 * Condense les messages intercom : archive les anciens, conserve les récents.
 * Met à jour le statut avec les informations des messages archivés (#858 Phase 2).
 * Si le statut ou le résumé dépasse les limites de taille, auto-condense via LLM.
 * Retourne le dashboard condensé.
 */
async function condenseIntercom(
  key: string,
  dashboard: Dashboard,
  keepCount: number
): Promise<Dashboard> {
  const condensationStart = Date.now();
  const messages = dashboard.intercom.messages;
  if (messages.length <= keepCount) {
    return dashboard; // Rien à condenser
  }

  const toArchive = messages.slice(0, messages.length - keepCount);
  const toKeep = messages.slice(messages.length - keepCount);

  // #858 : Générer les résumés LLM AVANT d'archiver
  // Pass ALL messages to status update so LLM sees full context
  const previousStatus = dashboard.status.markdown;

  const t1 = Date.now();
  let newStatus = await generateStatusUpdate(previousStatus, messages, toArchive.length);
  const t1Elapsed = Date.now() - t1;
  logger.info('Status update LLM call completed', { elapsed: `${t1Elapsed}ms`, success: newStatus !== null });

  const t2 = Date.now();
  let llmSummary = await generateLLMSummary(toArchive);
  const t2Elapsed = Date.now() - t2;
  logger.info('Summary LLM call completed', { elapsed: `${t2Elapsed}ms`, success: llmSummary !== null });

  // Both LLM calls are MANDATORY — if either fails, cancel condensation
  if (!llmSummary || !newStatus) {
    logger.warn('LLM call failed, condensation cancelled', {
      key,
      messageCount: toArchive.length,
      summaryOk: !!llmSummary,
      statusOk: !!newStatus
    });

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
      return dashboard; // Déjà signalé récemment, pas de spam
    }

    const errorTimestamp = new Date().toISOString();
    const statusOkLabel = newStatus ? 'OK' : 'FAILED';
    const summaryOkLabel = llmSummary ? 'OK' : 'FAILED';
    const errorMessage: IntercomMessage = {
      id: generateMessageId('system', 'system'),
      timestamp: errorTimestamp,
      author: { machineId: 'system', workspace: 'system' },
      content: `**[ERROR] CONDENSATION CANCELLED** - ${errorTimestamp}\n\n`
        + `LLM calls failed after ${LLM_MAX_RETRIES} retries (backoff 2s/4s/8s):\n`
        + `- Status update: ${statusOkLabel}\n`
        + `- Summary generation: ${summaryOkLabel}\n\n`
        + `Dashboard left unchanged (${dashboard.intercom.messages.length} messages). `
        + `Verify LLM endpoint (OPENAI_CHAT_API_BASE / OPENAI_CHAT_MODEL_ID) and retry. `
        + `Next condensation attempt will occur on the next append exceeding the `
        + `${Math.round(MAX_DASHBOARD_SIZE_BYTES / 1024)}KB threshold.`
    };

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
  newStatus = await condenseTextIfTooLarge(newStatus, MAX_STATUS_SIZE_BYTES, 'Status');
  llmSummary = await condenseTextIfTooLarge(llmSummary, MAX_SUMMARY_SIZE_BYTES, 'Summary');
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
    content: `**CONDENSATION** - ${now}\n\n${toArchive.length} messages archivés dans \`archive/${path.basename(archivePath)}\`\n${toKeep.length} messages conservés (plus récents)\nStatut mis à jour (${(statusSizeBytes / 1024).toFixed(1)}KB), résumé LLM généré (${(summarySizeBytes / 1024).toFixed(1)}KB)\nDurée: ${Math.round(totalElapsed / 1000)}s (status: ${Math.round(t1Elapsed / 1000)}s, summary: ${Math.round(t2Elapsed / 1000)}s)`
  };
  systemMessages.push(condenseNotice);

  logger.info('Condensation completed', { totalElapsed: `${totalElapsed}ms` });

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

  // #1497: Preemptive condensation at 85% utilization
  // Runs BEFORE the new message is appended, so condense operates on the existing
  // messages (current state) rather than waiting for the post-append size check
  // to fire at 100%. Prevents client-side timeout when dashboard is near-saturation.
  //
  // Concurrency contract: this function is NOT serialized per-key. Concurrent
  // appends to the same dashboard that both cross the 85% threshold will each
  // enter condenseIntercom, and the writeDashboardFile at the end uses
  // last-writer-wins semantics (same as the pre-existing reactive path). The
  // #1497 change does not introduce a new race beyond what already exists in
  // the reactive condense at 100%. If strict serialization is needed, wrap this
  // handler in a per-key mutex (see future issue if observed in production).
  // NOTE: `dashboard` is reassigned below — subsequent code must use the
  // post-condense binding.
  let preemptivelyCondensed = false;
  let preemptivelyArchivedCount = 0;
  const preAppendSize = estimateDashboardSize(dashboard);
  if (preAppendSize >= PREEMPTIVE_CONDENSE_THRESHOLD_BYTES && dashboard.intercom.messages.length > CONDENSE_KEEP) {
    logger.info('Preemptive condensation triggered (#1497)', {
      key,
      preAppendSize: `${Math.round(preAppendSize / 1024)}KB`,
      preemptiveThreshold: `${Math.round(PREEMPTIVE_CONDENSE_THRESHOLD_BYTES / 1024)}KB (85% of ${Math.round(MAX_DASHBOARD_SIZE_BYTES / 1024)}KB)`,
      messageCount: dashboard.intercom.messages.length
    });
    const beforePreemptive = dashboard.intercom.messages.length;
    dashboard = await condenseIntercom(key, dashboard, CONDENSE_KEEP);
    preemptivelyArchivedCount = beforePreemptive - dashboard.intercom.messages.length;
    preemptivelyCondensed = preemptivelyArchivedCount > 0;
  }

  // Use provided messageId or generate a new one
  // Check in order:
  // 1. Pending messageId from the Map (custom ID provided to append)
  // 2. args.messageId property (from schema)
  // 3. Generate new ID as fallback
  const messageIdValue = pendingMessageIds.get(key) || (args as any).messageId || generateMessageId(author.machineId, author.workspace);

  const message: IntercomMessage = {
    id: messageIdValue,
    timestamp: new Date().toISOString(),
    author,
    content: args.content
  };

  // Parse mentions in the message content
  const mentions = parseMentions(args.content);
  if (mentions.length > 0) {
    logger.debug('Mentions detected in dashboard message', {
      messageId: message.id,
      mentionCount: mentions.length,
      mentions: mentions.map(m => m.pattern)
    });
  }

  const now = new Date().toISOString();
  const updatedDashboard: Dashboard = {
    ...dashboard,
    lastModified: now,
    lastModifiedBy: author,
    intercom: {
      messages: [...dashboard.intercom.messages, message],
      totalMessages: dashboard.intercom.totalMessages + 1,
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
    finalDashboard = await condenseIntercom(key, updatedDashboard, CONDENSE_KEEP);
    const newlyArchived = beforeCount - finalDashboard.intercom.messages.length;
    archivedCount += newlyArchived;
    condensed = condensed || newlyArchived > 0;
  }

  await writeDashboardFile(key, finalDashboard);

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

  return {
    success: true,
    action: 'append',
    key,
    type: args.type!,
    request: requestEcho,
    sizes: buildSizes(finalDashboard),
    messageCount: finalDashboard.intercom.messages.length,
    condensed,
    archivedCount,
    crossPost: crossPostResults.length > 0 ? crossPostResults : undefined,
    message: `Message ajouté au dashboard '${key}'${condensed ? ` (auto-condensation: ${archivedCount} messages archivés, taille réduite)` : ''}${crossPostSuffix}`
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
  const condensedDashboard = await condenseIntercom(key, dashboard, keepCount);
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
    message: actuallyCondensed
      ? `Condensation terminée en ${Math.round(condenseElapsed / 1000)}s : ${archivedCount} messages archivés, ${condensedDashboard.intercom.messages.length} conservés`
      : `Condensation annulée (LLM indisponible) — ${beforeCount} messages inchangés (${Math.round(condenseElapsed / 1000)}s)`
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

// === Métadonnées de l'outil MCP ===

export const dashboardToolMetadata = {
  name: 'roosync_dashboard',
  description: 'Dashboards markdown partagés cross-machine. 3 types : global, machine, workspace. Actions : read, write (status diff), append (message intercom), condense, list (tous dashboards), delete, read_archive, read_overview (vue concaténée des 3 niveaux en 1 appel).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['read', 'write', 'append', 'condense', 'list', 'delete', 'read_archive', 'read_overview'],
        description: 'Action : read, write, append, condense, list (tous dashboards), delete (supprimer), read_archive (lire archives intercom), read_overview (vue concaténée des 3 niveaux en 1 appel)'
      },
      type: {
        type: 'string',
        enum: ['global', 'machine', 'workspace'],
        description: 'Type de dashboard. Requis sauf pour action=list et action=read_overview.'
      },
      machineId: {
        type: 'string',
        description: 'ID machine (défaut: machine locale). Pour type machine.'
      },
      workspace: {
        type: 'string',
        description: 'Workspace ID (défaut: workspace courant). Pour type workspace.'
      },
      section: {
        type: 'string',
        enum: ['status', 'intercom', 'all'],
        description: '(read) Section à lire (défaut: all)'
      },
      intercomLimit: {
        type: 'number',
        description: '(read) Nombre max de messages intercom retournés (défaut: tous). Auto-condensation à 50KB garantit un dashboard lisible.'
      },
      content: {
        type: 'string',
        description: '(write/append) Contenu markdown : pour write = nouveau status (remplace), pour append = nouveau message'
      },
      author: {
        type: 'object',
        properties: {
          machineId: { type: 'string' },
          workspace: { type: 'string' },
          worktree: { type: 'string' }
        },
        required: ['machineId', 'workspace'],
        description: '(write/append) Auteur de la modification. Défaut: machine+workspace locaux.'
      },
      createIfNotExists: {
        type: 'boolean',
        description: '(write/append) Créer le dashboard s\'il n\'existe pas (défaut: true)'
      },
      keepMessages: {
        type: 'number',
        description: '(condense) Nombre de messages à conserver (défaut: 10)'
      },
      archiveFile: {
        type: 'string',
        description: '(read_archive) Nom du fichier archive à lire. Si absent, liste les archives disponibles.'
      },
      mentionsOnly: {
        type: 'boolean',
        description: '(read) Ne retourner que les messages mentionnant la machine/agent courant (défaut: false). Détecte patterns @machine-id, @roo-*, @claude-*, @msg:id, @user.'
      },
      messageId: {
        type: 'string',
        description: '(append) ID optionnel pour le message (ex: hash GitHub issue). Si absent, généré automatiquement au format ic-{timestamp}.'
      },
      mentions: {
        type: 'array',
        description: '(append) Mentions structurées v3 (#1363). Chaque entrée = userId XOR messageId (exactement un des deux). Notifie les destinataires via RooSync (fire-and-forget, dedup par machineId).',
        items: {
          type: 'object',
          properties: {
            userId: {
              type: 'object',
              description: 'userId explicite à mentionner (exclusif avec messageId).',
              properties: {
                machineId: { type: 'string', description: 'ID de la machine' },
                workspace: { type: 'string', description: 'Workspace ID' }
              },
              required: ['machineId', 'workspace'],
              additionalProperties: false
            },
            messageId: {
              type: 'string',
              description: 'ID de message à référencer (format: machineId:workspace:ic-...). Résout en userId = auteur du message référencé.'
            },
            note: {
              type: 'string',
              description: 'Note optionnelle expliquant la raison de la mention.'
            }
          },
          additionalProperties: false
        }
      },
      crossPost: {
        type: 'array',
        description: '(append) Cross-post le même message vers d\'autres dashboards v3 (#1363), SANS notification RooSync. Self-skip : une cible pointant vers le dashboard source ne duplique pas. Target manquant + createIfNotExists=false = entrée { key, ok: false, error } dans result.crossPost.',
        items: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['global', 'machine', 'workspace'],
              description: 'Type de dashboard cible.'
            },
            machineId: {
              type: 'string',
              description: 'machineId cible (pour type=machine).'
            },
            workspace: {
              type: 'string',
              description: 'workspace cible (pour type=workspace).'
            }
          },
          required: ['type'],
          additionalProperties: false
        }
      }
    },
    required: ['action'],
    additionalProperties: false
  }
};
