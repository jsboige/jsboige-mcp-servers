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
import type OpenAI from 'openai';

const logger: Logger = createLogger('DashboardTool');

// Auto-condensation: size-based (50KB) + keep 10 most recent messages
// When dashboard file exceeds MAX_DASHBOARD_SIZE_BYTES, condense old messages
// into the status section via LLM, keeping only CONDENSE_KEEP recent messages.
const MAX_DASHBOARD_SIZE_BYTES = 50 * 1024; // 50 KB
const CONDENSE_KEEP = 10;

// Size limits for LLM outputs (bytes). If exceeded, retry with a stricter prompt.
const MAX_STATUS_SIZE_BYTES = 15 * 1024;  // 15 KB
const MAX_SUMMARY_SIZE_BYTES = 5 * 1024;  // 5 KB
const LLM_MAX_RETRIES = 3;
const LLM_INITIAL_BACKOFF_MS = 2000; // 2s, doubles each retry

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
  content: z.string().describe('Contenu markdown du message'),
  tags: z.array(z.string()).optional().describe('Tags optionnels : INFO, WARN, ERROR...')
});

export type IntercomMessage = z.infer<typeof IntercomMessageSchema>;

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

  // Pour write (section status)
  content: z.string().optional()
    .describe('Contenu markdown pour write (remplace status.markdown) ou append (nouveau message)'),
  author: AuthorSchema.optional()
    .describe('Auteur de la modification (requis pour write/append)'),
  createIfNotExists: z.boolean().optional()
    .describe('Créer le dashboard s\'il n\'existe pas (défaut: true)'),

  // Pour append (section intercom)
  tags: z.array(z.string()).optional()
    .describe('Tags pour le message intercom (ex: ["INFO", "WARN"])'),

  // Pour condense
  keepMessages: z.number().optional()
    .describe('Nombre de messages à conserver lors de la condensation (défaut: 10)'),

  // Pour read_archive
  archiveFile: z.string().optional()
    .describe('(read_archive) Nom du fichier archive à lire. Si absent, liste les archives disponibles.')
});

export type DashboardArgs = z.infer<typeof DashboardArgsSchema>;

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

    // Parser les messages intercom (format: ### [timestamp] machine|workspace [tags]\n\ncontent)
    // Bug fix: split on message headers instead of `---` which can appear in message content
    const messages: IntercomMessage[] = [];
    if (intercomMarkdown && !intercomMarkdown.includes('*Aucun message.*')) {
      // Split on message headers (### [) while keeping the header in each block
      const messageBlocks = intercomMarkdown.split(/(?=^### \[)/m).filter(b => b.trim());
      for (const rawBlock of messageBlocks) {
        // Strip trailing --- separators (leftover from write format)
        const block = rawBlock.replace(/\n---\s*$/, '').trim();
        // Note: machineId et workspace peuvent contenir des tirets (ex: test-machine, roo-extensions)
        // On utilise [^|\s]+ au lieu de \w+ pour permettre les tirets
        const headerMatch = block.match(/### \[([^\]]+)\]\s+([^|]+)\|([^|\s]+)(\s+\[([^\]]+)\])?\n\n([\s\S]+)/);
        if (headerMatch) {
          const [, timestamp, machineId, workspace, , tagsStr, content] = headerMatch;
          // tagsStr (groupe 5) contient déjà les tags sans les crochets: "WARN, SYSTEM"
          const tags = tagsStr ? tagsStr.split(', ').map(t => t.trim()) : [];
          messages.push({
            id: generateMessageId(), // ID regénéré (pas stocké dans le format markdown)
            timestamp,
            author: { machineId: machineId.trim(), workspace: workspace.trim() },
            content: content.trim(),
            tags: tags.length > 0 ? tags : undefined
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
  const intercomSection = dashboard.intercom.messages.length > 0
    ? dashboard.intercom.messages.map(msg => {
        const tags = msg.tags?.length ? ` [${msg.tags.join(', ')}]` : '';
        return `### [${msg.timestamp}] ${msg.author.machineId}|${msg.author.workspace}${tags}\n\n${msg.content}`;
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
 * Génère un ID unique pour un message intercom
 */
function generateMessageId(): string {
  return `ic-${new Date().toISOString().replace(/[:.]/g, '').substring(0, 16)}`;
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
    const tags = msg.tags?.length ? ` [${msg.tags.join(', ')}]` : '';
    const header = `[${msg.timestamp}] ${msg.author.machineId}|${msg.author.workspace}${tags}`;
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
  const modelId = process.env.OPENAI_CHAT_MODEL_ID || 'qwen3.5-35b-a3b';

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
    const tags = msg.tags?.length ? ` [${msg.tags.join(', ')}]` : '';
    const annotation = index < archivedCount ? '[SERA ARCHIVÉ]' : '[CONSERVÉ]';
    const header = `${annotation} [${msg.timestamp}] ${msg.author.machineId}|${msg.author.workspace}${tags}`;
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
  const modelId = process.env.OPENAI_CHAT_MODEL_ID || 'qwen3.5-35b-a3b';

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
  const modelId = process.env.OPENAI_CHAT_MODEL_ID || 'qwen3.5-35b-a3b';

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
    return dashboard; // Retourner le dashboard inchangé
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
    const tags = msg.tags?.length ? ` [${msg.tags.join(', ')}]` : '';
    return `### [${msg.timestamp}] ${msg.author.machineId}|${msg.author.workspace}${tags}\n\n${msg.content}`;
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
      id: generateMessageId(),
      timestamp: now,
      author: {
        machineId: 'system',
        workspace: 'system'
      },
      content: `**CONDENSATION-SUMMARY** - ${now}\n\n${llmSummary}`,
      tags: ['SYSTEM', 'CONDENSATION-SUMMARY']
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
    id: generateMessageId(),
    timestamp: now,
    author: {
      machineId: 'system',
      workspace: 'system'
    },
    content: `**CONDENSATION** - ${now}\n\n${toArchive.length} messages archivés dans \`archive/${path.basename(archivePath)}\`\n${toKeep.length} messages conservés (plus récents)\nStatut mis à jour (${(statusSizeBytes / 1024).toFixed(1)}KB), résumé LLM généré (${(summarySizeBytes / 1024).toFixed(1)}KB)\nDurée: ${Math.round(totalElapsed / 1000)}s (status: ${Math.round(t1Elapsed / 1000)}s, summary: ${Math.round(t2Elapsed / 1000)}s)`,
    tags: ['SYSTEM', 'CONDENSATION']
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
}

/**
 * Résultat de l'outil roosync_dashboard
 */
export interface DashboardResult {
  success: boolean;
  action: string;
  key: string;
  type: string;
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
}

/**
 * Handler pour l'outil roosync_dashboard
 */
export async function roosyncDashboard(args: DashboardArgs): Promise<DashboardResult> {
  // action=list et read_overview ne nécessitent pas de type
  if (args.action === 'list') {
    return handleList();
  }
  if (args.action === 'read_overview') {
    const resolvedMachineId = args.machineId ?? getLocalMachineId();
    const resolvedWorkspace = args.workspace ?? getLocalWorkspaceId();
    return handleReadOverview(resolvedMachineId, resolvedWorkspace, args);
  }

  if (!args.type) {
    throw new Error('type est requis pour action=' + args.action);
  }

  const resolvedMachineId = args.machineId ?? getLocalMachineId();
  const resolvedWorkspace = args.workspace ?? getLocalWorkspaceId();
  const key = buildDashboardKey(args.type, resolvedMachineId, resolvedWorkspace);
  const createIfNotExists = args.createIfNotExists !== false; // défaut: true

  logger.info('roosync_dashboard appelé', { action: args.action, key });

  switch (args.action) {
    case 'read':
      return handleRead(key, args, resolvedMachineId, resolvedWorkspace);
    case 'write':
      return handleWrite(key, args, createIfNotExists, resolvedMachineId, resolvedWorkspace);
    case 'append':
      return handleAppend(key, args, createIfNotExists, resolvedMachineId, resolvedWorkspace);
    case 'condense':
      return handleCondense(key, args);
    case 'delete':
      return handleDelete(key, args);
    case 'read_archive':
      return handleReadArchive(key, args);
    default:
      throw new Error(`Action inconnue: ${(args as any).action}`);
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
    if (msg.tags) {
      size += msg.tags.join(', ').length + 10;
    }
  }
  return size;
}

async function handleRead(
  key: string,
  args: DashboardArgs,
  resolvedMachineId: string,
  resolvedWorkspace: string
): Promise<DashboardResult> {
  const dashboard = await readDashboardFile(key);
  if (!dashboard) {
    return {
      success: false,
      action: 'read',
      key,
      type: args.type!,
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
    const messages = intercomLimit
      ? dashboard.intercom.messages.slice(-intercomLimit)
      : dashboard.intercom.messages;
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
    data,
    messageCount: dashboard.intercom.messages.length
  };
}

async function handleWrite(
  key: string,
  args: DashboardArgs,
  createIfNotExists: boolean,
  resolvedMachineId: string,
  resolvedWorkspace: string
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
    message: `Status mis à jour pour dashboard '${key}'`
  };
}

async function handleAppend(
  key: string,
  args: DashboardArgs,
  createIfNotExists: boolean,
  resolvedMachineId: string,
  resolvedWorkspace: string
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
        message: `Dashboard '${key}' introuvable et createIfNotExists=false`
      };
    }
    dashboard = createEmptyDashboard(args.type!, key, author);
  }

  const message: IntercomMessage = {
    id: generateMessageId(),
    timestamp: new Date().toISOString(),
    author,
    content: args.content,
    tags: args.tags
  };

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
  let condensed = false;
  let archivedCount = 0;
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
    archivedCount = beforeCount - finalDashboard.intercom.messages.length;
    condensed = archivedCount > 0;
  }

  await writeDashboardFile(key, finalDashboard);
  return {
    success: true,
    action: 'append',
    key,
    type: args.type!,
    messageCount: finalDashboard.intercom.messages.length,
    condensed,
    archivedCount,
    message: `Message ajouté au dashboard '${key}'${condensed ? ` (auto-condensation: ${archivedCount} messages archivés, taille réduite)` : ''}`
  };
}

async function handleCondense(
  key: string,
  args: DashboardArgs
): Promise<DashboardResult> {
  const dashboard = await readDashboardFile(key);
  if (!dashboard) {
    return {
      success: false,
      action: 'condense',
      key,
      type: args.type!,
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

  if (actuallyCondensed) {
    await writeDashboardFile(key, condensedDashboard);
  }

  const archivedCount = actuallyCondensed ? beforeCount - condensedDashboard.intercom.messages.length : 0;
  return {
    success: true,
    action: 'condense',
    key,
    type: args.type!,
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
  args: DashboardArgs
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
    overview,
    message: `Vue d'ensemble: ${foundCount}/3 dashboards trouvés (machine: ${resolvedMachineId}, workspace: ${resolvedWorkspace})`
  };
}

async function handleList(): Promise<DashboardResult> {
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
          summaries.push({
            key: dashboard.key,
            type: dashboard.type,
            lastModified: dashboard.lastModified,
            lastModifiedBy: dashboard.lastModifiedBy,
            messageCount: dashboard.intercom.messages.length,
            statusLength: dashboard.status.markdown.length
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
      dashboards: summaries,
      message: `${summaries.length} dashboard(s) trouvé(s)`
    };
  } catch (error) {
    return {
      success: true,
      action: 'list',
      key: '',
      type: '',
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

async function handleDelete(key: string, args: DashboardArgs): Promise<DashboardResult> {
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
      message: `Dashboard '${key}' supprimé (archivé en sécurité avant suppression)`
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        success: false,
        action: 'delete',
        key,
        type: args.type ?? '',
        message: `Dashboard '${key}' introuvable`
      };
    }
    throw error;
  }
}

async function handleReadArchive(key: string, args: DashboardArgs): Promise<DashboardResult> {
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
        archives,
        message: `${archives.length} archive(s) trouvée(s) pour '${key}'`
      };
    } catch {
      return {
        success: true,
        action: 'read_archive',
        key,
        type: args.type ?? '',
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
    const messageBlocks = markdownContent.split(/(?=^### \[)/m).filter(b => b.trim());
    for (const rawBlock of messageBlocks) {
      const block = rawBlock.replace(/\n---\s*$/, '').trim();
      const headerMatch = block.match(/### \[([^\]]+)\]\s+([^|]+)\|([^|\s]+)(\s+\[([^\]]+)\])?\n\n([\s\S]+)/);
      if (headerMatch) {
        const [, timestamp, machineId, workspace, , tagsStr, msgContent] = headerMatch;
        // tagsStr (groupe 5) contient déjà les tags sans les crochets: "WARN, SYSTEM"
        const tags = tagsStr ? tagsStr.split(', ').map(t => t.trim()) : [];
        messages.push({
          id: generateMessageId(),
          timestamp,
          author: { machineId, workspace },
          content: msgContent.trim(),
          tags: tags.length > 0 ? tags : undefined
        });
      }
    }

    return {
      success: true,
      action: 'read_archive',
      key,
      type: args.type ?? '',
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
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: '(append) Tags pour le message intercom (ex: ["INFO", "WARN", "ERROR"])'
      },
      keepMessages: {
        type: 'number',
        description: '(condense) Nombre de messages à conserver (défaut: 100)'
      },
      archiveFile: {
        type: 'string',
        description: '(read_archive) Nom du fichier archive à lire. Si absent, liste les archives disponibles.'
      }
    },
    required: ['action'],
    additionalProperties: false
  }
};
