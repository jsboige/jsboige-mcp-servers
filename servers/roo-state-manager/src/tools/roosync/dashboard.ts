/**
 * Outil MCP : roosync_dashboard
 *
 * Dashboards markdown partagés pour la collaboration cross-machine.
 * Support 4 types : global, machine, workspace, workspace+machine (remplace INTERCOM local).
 *
 * Architecture stockage :
 *   .shared-state/dashboards/
 *     global.json
 *     machine-{machineId}.json
 *     workspace-{workspaceName}.json
 *     workspace-{workspaceName},machine-{machineId}.json
 *     archive/
 *       {key}-{date}.json
 *
 * @module tools/roosync/dashboard
 * @version 1.0.0
 * @issue #675
 */

import { z } from 'zod';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
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

export const DashboardSchema = z.object({
  type: z.enum(['global', 'machine', 'workspace', 'workspace+machine'])
    .describe('Type de dashboard'),
  key: z.string().describe('Clé unique du dashboard'),
  lastModified: z.string().describe('ISO 8601 timestamp de dernière modification'),
  lastModifiedBy: AuthorSchema,
  status: z.object({
    markdown: z.string().describe('Contenu markdown de la section status (édition diff)'),
    lastDiffCommit: z.string().optional().describe('Hash du dernier commit diff')
  }),
  intercom: z.object({
    messages: z.array(IntercomMessageSchema).describe('Messages intercom (FIFO)'),
    totalMessages: z.number().describe('Total messages ajoutés (y compris archivés)'),
    lastCondensedAt: z.string().optional().describe('ISO 8601 timestamp dernière condensation')
  })
});

export type Dashboard = z.infer<typeof DashboardSchema>;

// Schema args pour l'outil MCP
export const DashboardArgsSchema = z.object({
  action: z.enum(['read', 'write', 'append', 'condense'])
    .describe('Action : read (lire), write (écrire status), append (ajouter message intercom), condense (condenser)'),

  type: z.enum(['global', 'machine', 'workspace', 'workspace+machine'])
    .describe('Type de dashboard'),

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
    .describe('Nombre de messages à conserver lors de la condensation (défaut: 100)')
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
 * Convertit la clé en nom de fichier JSON
 */
function keyToFilename(key: string): string {
  return `${key}.json`;
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
 * Lit un dashboard depuis le stockage. Retourne null si inexistant.
 */
async function readDashboardFile(key: string): Promise<Dashboard | null> {
  const filePath = getDashboardPath(key);
  try {
    const content = await fs.readFile(filePath, 'utf8');
    const data = JSON.parse(content);
    return DashboardSchema.parse(data);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    logger.error('Erreur lecture dashboard', { key, error });
    throw error;
  }
}

/**
 * Écrit un dashboard dans le stockage (atomic via tmp file)
 */
async function writeDashboardFile(key: string, dashboard: Dashboard): Promise<void> {
  const dir = getDashboardsDir();
  await fs.mkdir(dir, { recursive: true });
  const filePath = getDashboardPath(key);
  const tmpPath = `${filePath}.tmp`;
  const content = JSON.stringify(dashboard, null, 2);
  await fs.writeFile(tmpPath, content, 'utf8');
  await fs.rename(tmpPath, filePath);
  logger.debug('Dashboard écrit', { key, path: filePath });
}

/**
 * Crée un dashboard vide avec les valeurs par défaut
 */
function createEmptyDashboard(
  type: DashboardArgs['type'],
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

  // Archiver les anciens messages
  const archiveDir = getArchiveDir();
  await fs.mkdir(archiveDir, { recursive: true });
  const dateStr = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
  const archivePath = path.join(archiveDir, `${key}-${dateStr}.json`);
  const archiveData = {
    key,
    archivedAt: new Date().toISOString(),
    messageCount: toArchive.length,
    messages: toArchive
  };
  await fs.writeFile(archivePath, JSON.stringify(archiveData, null, 2), 'utf8');
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
}

/**
 * Handler pour l'outil roosync_dashboard
 */
export async function roosyncDashboard(args: DashboardArgs): Promise<DashboardResult> {
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
      type: args.type,
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
    type: args.type,
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
        type: args.type,
        message: `Dashboard '${key}' introuvable et createIfNotExists=false`
      };
    }
    dashboard = createEmptyDashboard(args.type, key, author);
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
    type: args.type,
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
        type: args.type,
        message: `Dashboard '${key}' introuvable et createIfNotExists=false`
      };
    }
    dashboard = createEmptyDashboard(args.type, key, author);
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
    type: args.type,
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
      type: args.type,
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
      type: args.type,
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
    type: args.type,
    messageCount: condensedDashboard.intercom.messages.length,
    condensed: true,
    archivedCount: beforeCount - keepCount,
    message: `Condensation terminée : ${beforeCount - keepCount} messages archivés, ${keepCount} conservés`
  };
}

// === Métadonnées de l'outil MCP ===

export const dashboardToolMetadata = {
  name: 'roosync_dashboard',
  description: 'Dashboards markdown partagés cross-machine. 4 types : global, machine, workspace, workspace+machine (remplace INTERCOM local). Actions : read, write (status diff), append (message intercom), condense.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['read', 'write', 'append', 'condense'],
        description: 'Action : read (lire), write (écrire status), append (ajouter message intercom), condense (condenser manuellement)'
      },
      type: {
        type: 'string',
        enum: ['global', 'machine', 'workspace', 'workspace+machine'],
        description: 'Type de dashboard. workspace+machine remplace INTERCOM local.'
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
      }
    },
    required: ['action', 'type'],
    additionalProperties: false
  }
};
