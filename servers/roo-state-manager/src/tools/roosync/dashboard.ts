/**
 * Outil MCP : roosync_dashboard
 *
 * Dashboards markdown partagés pour la collaboration cross-machine.
 * Support 4 types : global, machine, workspace, workspace+machine (remplace INTERCOM local).
 *
 * Architecture stockage :
 *   .shared-state/dashboards/
 *     global.md
 *     machine-{machineId}.md
 *     workspace-{workspaceName}.md
 *     workspace-{workspaceName},machine-{machineId}.md
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
import { getSharedStatePath } from '../../utils/server-helpers.js';
import { getLocalMachineId, getLocalWorkspaceId } from '../../utils/message-helpers.js';
import { createLogger, Logger } from '../../utils/logger.js';

const logger: Logger = createLogger('DashboardTool');

// Auto-condensation threshold
const CONDENSE_THRESHOLD = 500;
const CONDENSE_KEEP = 100;
const CONDENSE_ARCHIVE = CONDENSE_THRESHOLD - CONDENSE_KEEP; // 400

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
  type: 'global' | 'machine' | 'workspace' | 'workspace+machine';
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
    .describe('Action : read, write, append, condense, list (tous dashboards), delete (supprimer), read_archive (lire archives), read_overview (vue concaténée des 4 niveaux)'),

  type: z.enum(['global', 'machine', 'workspace', 'workspace+machine']).optional()
    .describe('Type de dashboard (requis sauf pour action=list)'),

  machineId: z.string().optional()
    .describe('ID machine (défaut: machine locale). Utilisé pour types machine et workspace+machine'),

  workspace: z.string().optional()
    .describe('Workspace (défaut: workspace courant). Utilisé pour types workspace et workspace+machine'),

  // Pour read
  section: z.enum(['status', 'intercom', 'all']).optional()
    .describe('Section à lire (défaut: all)'),
  intercomLimit: z.number().optional()
    .describe('Nombre max de messages intercom retournés (défaut: 50)'),

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
    .describe('Nombre de messages à conserver lors de la condensation (défaut: 100)'),

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
    case 'workspace+machine':
      return `workspace-${workspace},machine-${machineId}`;
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
    const content = await fs.readFile(filePath, 'utf8');

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
    const messages: IntercomMessage[] = [];
    if (intercomMarkdown && !intercomMarkdown.includes('*Aucun message.*')) {
      const messageBlocks = intercomMarkdown.split(/\n\n---\n\n/);
      for (const block of messageBlocks) {
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
 * Condense les messages intercom : archive les anciens, conserve les récents.
 * Retourne le dashboard condensé.
 */
async function condenseIntercom(
  key: string,
  dashboard: Dashboard,
  keepCount: number
): Promise<Dashboard> {
  const messages = dashboard.intercom.messages;
  if (messages.length <= keepCount) {
    return dashboard; // Rien à condenser
  }

  const toArchive = messages.slice(0, messages.length - keepCount);
  const toKeep = messages.slice(messages.length - keepCount);

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
    messageCount: toArchive.length
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

  // Ajouter message système de condensation
  const condenseNotice: IntercomMessage = {
    id: generateMessageId(),
    timestamp: new Date().toISOString(),
    author: {
      machineId: 'system',
      workspace: 'system'
    },
    content: `---\n**CONDENSATION** - ${new Date().toISOString()}\n\n${toArchive.length} messages archivés dans \`archive/${path.basename(archivePath)}\`\n${toKeep.length} messages conservés (plus récents)\n---`,
    tags: ['SYSTEM', 'CONDENSATION']
  };

  const now = new Date().toISOString();
  return {
    ...dashboard,
    lastModified: now,
    intercom: {
      messages: [condenseNotice, ...toKeep],
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
  const intercomLimit = args.intercomLimit ?? 50;
  let data: Partial<Dashboard> = {};

  if (section === 'status' || section === 'all') {
    data.status = dashboard.status;
  }
  if (section === 'intercom' || section === 'all') {
    const messages = dashboard.intercom.messages.slice(-intercomLimit);
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

  // Auto-condensation si > CONDENSE_THRESHOLD messages
  let condensed = false;
  let archivedCount = 0;
  let finalDashboard = updatedDashboard;
  if (updatedDashboard.intercom.messages.length > CONDENSE_THRESHOLD) {
    logger.info('Auto-condensation déclenchée', { key, count: updatedDashboard.intercom.messages.length });
    finalDashboard = await condenseIntercom(key, updatedDashboard, CONDENSE_KEEP);
    condensed = true;
    archivedCount = CONDENSE_ARCHIVE;
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
    message: `Message ajouté au dashboard '${key}'${condensed ? ` (auto-condensation: ${archivedCount} messages archivés)` : ''}`
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

  const condensedDashboard = await condenseIntercom(key, dashboard, keepCount);
  await writeDashboardFile(key, condensedDashboard);

  const archivedCount = beforeCount - condensedDashboard.intercom.messages.length + 1; // +1 pour le message système
  return {
    success: true,
    action: 'condense',
    key,
    type: args.type!,
    messageCount: condensedDashboard.intercom.messages.length,
    condensed: true,
    archivedCount: beforeCount - keepCount,
    message: `Condensation terminée : ${beforeCount - keepCount} messages archivés, ${keepCount} conservés`
  };
}

/**
 * read_overview: Vue concaténée des 4 niveaux de dashboard en un seul appel.
 * Retourne global + machine + workspace + workspace+machine avec troncature.
 * (#808 Proposition 1)
 */
async function handleReadOverview(
  resolvedMachineId: string,
  resolvedWorkspace: string,
  args: DashboardArgs
): Promise<DashboardResult> {
  const intercomLimit = args.intercomLimit ?? 5;
  const STATUS_MAX_LENGTH = 2000;

  const dashboardTypes: Array<{ type: Dashboard['type']; label: string }> = [
    { type: 'global', label: 'Global' },
    { type: 'machine', label: 'Machine' },
    { type: 'workspace', label: 'Workspace' },
    { type: 'workspace+machine', label: 'INTERCOM local' },
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
    message: `Vue d'ensemble: ${foundCount}/4 dashboards trouvés (machine: ${resolvedMachineId}, workspace: ${resolvedWorkspace})`
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

async function handleDelete(key: string, args: DashboardArgs): Promise<DashboardResult> {
  const filePath = getDashboardPath(key);
  try {
    await fs.unlink(filePath);
    logger.info('Dashboard supprimé', { key });
    return {
      success: true,
      action: 'delete',
      key,
      type: args.type ?? '',
      message: `Dashboard '${key}' supprimé`
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
    const content = await fs.readFile(archivePath, 'utf8');

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

    // Trouver la section des messages (après les séparateurs ---)
    const messageBlocks = markdownContent.split(/\n\n---\n\n/);
    for (const block of messageBlocks) {
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
  description: 'Dashboards markdown partagés cross-machine. 4 types : global, machine, workspace, workspace+machine (remplace INTERCOM local). Actions : read, write (status diff), append (message intercom), condense, list (tous dashboards), delete, read_archive, read_overview (vue concaténée des 4 niveaux en 1 appel).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['read', 'write', 'append', 'condense', 'list', 'delete', 'read_archive', 'read_overview'],
        description: 'Action : read, write, append, condense, list (tous dashboards), delete (supprimer), read_archive (lire archives intercom), read_overview (vue concaténée des 4 niveaux en 1 appel)'
      },
      type: {
        type: 'string',
        enum: ['global', 'machine', 'workspace', 'workspace+machine'],
        description: 'Type de dashboard. workspace+machine remplace INTERCOM local. Requis sauf pour action=list et action=read_overview.'
      },
      machineId: {
        type: 'string',
        description: 'ID machine (défaut: machine locale). Pour types machine et workspace+machine.'
      },
      workspace: {
        type: 'string',
        description: 'Workspace ID (défaut: workspace courant). Pour types workspace et workspace+machine.'
      },
      section: {
        type: 'string',
        enum: ['status', 'intercom', 'all'],
        description: '(read) Section à lire (défaut: all)'
      },
      intercomLimit: {
        type: 'number',
        description: '(read) Nombre max de messages intercom retournés (défaut: 50)'
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
