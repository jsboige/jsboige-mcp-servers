/**
 * Dashboard Zod schemas — single source of truth for JSON Schema derivation.
 *
 * NO handler imports — safe for tool-definitions.ts to import (#1145 perf fix).
 * Eliminates dual-definition bugs (#1470): the same Zod schema feeds both
 * runtime validation (dashboard.ts handler) and MCP tool advertisement
 * (tool-definitions.ts via zodToJsonSchema).
 *
 * @module tools/roosync/dashboard-schemas
 * @issue #1470
 */

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

// === Author Schema ===

export const AuthorSchema = z.object({
  machineId: z.string().describe('ID de la machine'),
  workspace: z.string().describe('Workspace ID'),
  worktree: z.string().optional().describe('Worktree path (si applicable)')
});

export type Author = z.infer<typeof AuthorSchema>;

// === Intercom Message Schema ===

export const IntercomMessageSchema = z.object({
  id: z.string().describe('ID unique du message (ic-{timestamp})'),
  timestamp: z.string().describe('ISO 8601 timestamp'),
  author: AuthorSchema,
  content: z.string().describe('Contenu markdown du message')
});

export type IntercomMessage = z.infer<typeof IntercomMessageSchema>;

// === Mentions v3 (#1363) ===
// userId = { machineId, workspace } tuple. Exactly one of userId/messageId (XOR).

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

// === Dashboard data model ===

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

export interface DashboardFrontmatter {
  type: Dashboard['type'];
  lastModified: string;
  lastModifiedBy: Author;
  totalMessages?: number;
  lastCondensedAt?: string;
}

// === Dashboard Args Schema (unified for all actions) ===

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
    .describe('Nombre max de messages intercom retournés (défaut: tous). Le dashboard est auto-condensé, donc tous les messages sont normalement visibles.'),
  mentionsOnly: z.boolean().optional()
    .describe('(read) Ne retourner que les messages mentionnant la machine/agent courant (défaut: false)'),

  // Pour write/append
  content: z.string().optional()
    .describe('Contenu markdown pour write (remplace status.markdown) ou append (nouveau message)'),
  author: AuthorSchema.optional()
    .describe('Auteur de la modification (requis pour write/append)'),
  createIfNotExists: z.boolean().optional()
    .describe('Créer le dashboard s\'il n\'existe pas (défaut: true)'),
  messageId: z.string().optional()
    .describe('(append) ID optionnel pour le message. Si absent, généré automatiquement.'),

  // Pour append — tags
  tags: z.array(z.string()).optional()
    .describe('(append) Tags pour le message intercom (ex: ["INFO", "WARN", "ERROR"])'),

  // Mentions v3 (#1363)
  mentions: z.array(MentionSchema).optional()
    .describe('(append) Mentions structurées. Chaque entrée = userId XOR messageId. Notifie les destinataires via RooSync.'),

  // Cross-post v3 (#1363)
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

// === Derived JSON Schema for MCP tool advertisement ===
// Used by tool-definitions.ts to advertise the tool via ListTools.
// Eliminates hand-written JSON Schema that silently diverged from the Zod source.

export const dashboardToolMetadata = {
  name: 'roosync_dashboard',
  description: 'Dashboards markdown partagés cross-machine. 3 types : global, machine, workspace. Actions : read, write (status diff), append (message intercom), condense, list (tous dashboards), delete, read_archive, read_overview (vue concaténée des 3 niveaux en 1 appel).',
  inputSchema: zodToJsonSchema(DashboardArgsSchema as any, { target: 'openApi3' })
};
