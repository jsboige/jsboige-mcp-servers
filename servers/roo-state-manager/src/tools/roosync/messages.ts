/**
 * Outil MCP : roosync_messages
 *
 * Outil consolide pour la messagerie inter-machines RooSync.
 * Regroupe : roosync_send + roosync_read + roosync_manage + roosync_attachments (4→1)
 *
 * Actions: send, reply, amend, inbox, message, mark_read, archive,
 *          bulk_mark_read, bulk_archive, cleanup, stats, attachments_list,
 *          attachments_get, attachments_delete
 *
 * @module tools/roosync/messages
 * @version 1.0.0
 * @see #1841 (Cluster G: messagerie)
 */

import { z } from 'zod';
import { roosyncSend } from './send.js';
import { roosyncRead } from './read.js';
import { roosyncManage } from './manage.js';
import { roosyncAttachments } from './roosync-attachments.tool.js';
import { createLogger } from '../../utils/logger.js';
import { StateManagerError } from '../../types/errors.js';

const logger = createLogger('RooSyncMessagesTool');

// ====================================================================
// SHORTHAND RESOLUTION (#2241)
// ====================================================================

const SHORTHAND_MAP: Record<string, string> = {
  hermes: 'myia-po-2026:hermes-agent',
  nanoclaw: 'myia-ai-01:nanoclaw',
};

function resolveAddressShorthand(to: string | undefined): string | undefined {
  if (!to) return to;
  const resolved = SHORTHAND_MAP[to.toLowerCase()];
  if (resolved) {
    logger.info(`[#2241] Shorthand resolved: "${to}" → "${resolved}"`);
    return resolved;
  }
  return to;
}

// ====================================================================
// SCHEMA
// ====================================================================

export const MessagesArgsSchema = z.object({
  action: z.enum([
    // Send family
    'send', 'reply', 'amend',
    // Read family
    'inbox', 'message',
    // Manage family
    'mark_read', 'archive', 'bulk_mark_read', 'bulk_archive', 'cleanup', 'stats',
    // Attachments family
    'attachments_list', 'attachments_get', 'attachments_delete'
  ]).describe('Action a effectuer'),

  // --- Send/Reply/Amend params ---
  to: z.string().optional().describe('Destinataire (requis pour send): machine, machine:workspace, ou shorthand (hermes=po-2026:hermes-agent, nanoclaw=ai-01:nanoclaw) #2241'),
  subject: z.string().optional().describe('Sujet (requis pour send)'),
  body: z.string().optional().describe('Corps du message (requis pour send/reply)'),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional().describe('Priorite (defaut: MEDIUM)'),
  tags: z.array(z.string()).optional().describe('Tags optionnels'),
  thread_id: z.string().optional().describe('ID du thread pour regroupement'),
  reply_to: z.string().optional().describe('Reference message ID — uniquement pour action="send" (thread un nouveau message sur un message existant). NE PAS utiliser pour action="reply"/"amend"/"mark_read" : voir message_id. #3029'),
  message_id: z.string().optional().describe('ID du message cible — requis pour actions reply/amend/mark_read/archive/message/attachments_list/get/delete. Alias rétro-compatible de reply_to accepté pour reply/amend. #3029'),
  new_content: z.string().optional().describe('Nouveau contenu (requis pour amend)'),
  reason: z.string().optional().describe('Raison de la modification (amend)'),
  auto_destruct: z.boolean().optional().describe('Auto-destruction apres lecture'),
  destruct_after_read_by: z.array(z.string()).optional().describe('Machines devant lire avant destruction'),
  destruct_after: z.string().optional().describe('TTL avant destruction (ex: 30m, 2h, 1d)'),
  attachments: z.array(z.object({
    path: z.string(),
    filename: z.string().optional()
  })).optional().describe('Pieces jointes (pour send)'),

  // --- Read/Inbox params ---
  status: z.enum(['unread', 'read', 'all']).optional().describe('Filtrer inbox par statut (defaut: all)'),
  limit: z.number().optional().describe('Max messages inbox'),
  page: z.number().optional().describe('Numero de page (1-based, requiert per_page)'),
  per_page: z.number().optional().describe('Messages par page (requiert page)'),
  mark_as_read: z.boolean().optional().describe('Marquer comme lu (mode message, defaut: false)'),
  deep: z.boolean().optional().describe('#3292 inbox: scanner TOUT le pool au lieu de la slice recente au cold-start (defaut: false = ~100 recents servis synchronement, hydratation du reste en arriere-plan)'),
  workspace: z.string().optional().describe('Override workspace filter (#1498). Identifiant de workspace SEUL — la machine reste la vôtre (ou to_machine). Passer "machine:workspace" ici produit une identité-valise inconnue de la flotte (#3177)'),
  to_machine: z.string().optional().describe('Override machine filter (#1498, avance). NB: pas "machineId" — ce param n existe pas et est rejeté depuis #3177'),

  // --- Manage bulk params (from/subject_contains also honored on inbox, #3351) ---
  from: z.string().optional().describe('Filtrer par expediteur — substring insensible a la casse (inbox + bulk)'),
  before_date: z.string().optional().describe('Filtrer avant date ISO-8601 (bulk uniquement — rejeté sur inbox, #3351)'),
  subject_contains: z.string().optional().describe('Filtrer par sujet — substring insensible a la casse (inbox + bulk)'),
  tag: z.string().optional().describe('Filtrer par tag (bulk uniquement — rejeté sur inbox, #3351)'),

  // --- Attachments params ---
  uuid: z.string().optional().describe('UUID piece jointe (requis pour attachments_get/delete). Pour attachments_get, alternative #3256 : message_id + filename si l UUID est inconnu'),
  filename: z.string().optional().describe('#3256 — alternative a uuid pour attachments_get : nom du fichier, resolu via les refs du message_id fourni'),
  targetPath: z.string().optional().describe('Chemin local destination (requis pour attachments_get)'),

  // --- Output format ---
  format: z.enum(['json', 'markdown']).optional().describe('Format de sortie pour inbox/stats')
});

export type MessagesArgs = z.infer<typeof MessagesArgsSchema>;

// ====================================================================
// IMPLEMENTATION
// ====================================================================

// #3173/#3177 — Identifiants plausibles mais absents du schéma. Un appel inbox
// avec `machineId` rendait l'inbox de l'identité serveur sans erreur ni mention
// du param ignoré (mesuré po-2026 c.252 escaladé à tort en « filtrage cassé »,
// root-causé po-2025 #3177). Zod .strict() rejette toute clé inconnue, mais le
// message générique ne nomme pas le param réel — cette table le fait.
const KNOWN_ALIAS_HINTS: Record<string, { realParam: string; note: string }> = {
  machineId: { realParam: 'to_machine', note: 'override machine filter (avancé)' },
  machine_id: { realParam: 'to_machine', note: 'override machine filter (avancé)' },
};

export async function roosyncMessages(args: MessagesArgs) {
  // #3029 AC-4: MessagesArgsSchema consumed at runtime as the active validation layer,
  // not just a type source (z.infer). Throws ZodError on genuinely malformed input;
  // valid input passes through unchanged (handler cherry-picks known keys downstream).
  // #3177: .strict() — un param inconnu (ex: machineId) doit échouer l'appel,
  // jamais être strippe silencieusement puis résolu en identité serveur.
  // La détection d'alias précède le parse pour nommer le param réel dans le message.
  const unknownKeys = Object.keys(args).filter(
    (k) => !(k in MessagesArgsSchema.shape)
  );
  const aliasHint = unknownKeys
    .map((k) => KNOWN_ALIAS_HINTS[k])
    .filter(Boolean)[0];
  if (aliasHint) {
    // StateManagerError/VALIDATION_FAILED pour la cohérence avec la garde #3173
    // conversation_browser (rejectedParam/expectedParam), pas un Error brut.
    throw new StateManagerError(
      `Paramètre(s) inconnu(s) pour roosync_messages : ${unknownKeys.join(', ')}. ` +
      `Vouliez-vous "${aliasHint.realParam}" (${aliasHint.note}) ? ` +
      `Un paramètre fourni doit être honoré, jamais ignoré silencieusement (#3173/#3177).`,
      'VALIDATION_FAILED',
      'RooSyncMessagesTool',
      { rejectedParams: unknownKeys, expectedParam: aliasHint.realParam }
    );
  }

  const parsed = MessagesArgsSchema.strict().parse(args);
  args = parsed;
  const { action } = args;

  switch (action) {
    // --- Send family ---
    case 'send':
      return roosyncSend({
        action: 'send',
        to: resolveAddressShorthand(args.to),
        subject: args.subject,
        body: args.body,
        priority: args.priority,
        tags: args.tags,
        thread_id: args.thread_id,
        reply_to: args.reply_to,
        auto_destruct: args.auto_destruct,
        destruct_after_read_by: args.destruct_after_read_by,
        destruct_after: args.destruct_after,
        attachments: args.attachments
      });

    case 'reply':
      // #3029: Alias reply_to → message_id pour rétro-compatibilité (agent passes reply_to expecting "the message to reply to").
      // L'alias est ignoré si message_id est déjà fourni.
      return roosyncSend({
        action: 'reply',
        message_id: args.message_id ?? args.reply_to,
        body: args.body,
        priority: args.priority,
        tags: args.tags
      });

    case 'amend':
      // #3029: Idem — alias reply_to accepté pour amend (consistance avec reply).
      return roosyncSend({
        action: 'amend',
        message_id: args.message_id ?? args.reply_to,
        new_content: args.new_content,
        reason: args.reason
      });

    // --- Read family ---
    case 'inbox': {
      // #3351: from/subject_contains are honored (passed below). The remaining
      // bulk params (priority, before_date, tag) have NO inbox semantics —
      // accepted by the flat schema then silently dropped was the exact #3351
      // trap; fail LOUD and NAMED instead (#3173/#3177).
      // '' ne compte pas : binding qui sérialise les optionnels vides (friction
      // po-2025 01/09) — pas une intention d'appelant, et chaque site aval
      // (manage hasAnyFilter, filtres MessageManager) traite déjà '' comme absent.
      const bulkOnlyParams = (['priority', 'before_date', 'tag'] as const)
        .filter(p => args[p] !== undefined && args[p] !== '');
      if (bulkOnlyParams.length > 0) {
        throw new StateManagerError(
          `Paramètre(s) bulk-only pour roosync_messages inbox : ${bulkOnlyParams.join(', ')}. ` +
          `Ces filtres ne s'appliquent qu'aux actions bulk (bulk_mark_read / bulk_archive). ` +
          `Un paramètre fourni doit être honoré, jamais ignoré silencieusement (#3351/#3177).`,
          'VALIDATION_FAILED',
          'RooSyncMessagesTool',
          { rejectedParams: bulkOnlyParams, expectedParam: 'from | subject_contains' }
        );
      }
      return roosyncRead({
        mode: 'inbox',
        status: args.status,
        limit: args.limit,
        page: args.page,
        per_page: args.per_page,
        workspace: args.workspace,
        to_machine: args.to_machine,
        format: args.format,
        deep: args.deep,
        from: args.from,
        subject_contains: args.subject_contains
      });
    }

    case 'message':
      return roosyncRead({
        mode: 'message',
        message_id: args.message_id,
        mark_as_read: args.mark_as_read
      });

    // --- Manage family ---
    case 'mark_read':
      return roosyncManage({ action: 'mark_read', message_id: args.message_id });

    case 'archive':
      return roosyncManage({ action: 'archive', message_id: args.message_id });

    case 'bulk_mark_read':
      return roosyncManage({
        action: 'bulk_mark_read',
        from: args.from,
        priority: args.priority,
        before_date: args.before_date,
        subject_contains: args.subject_contains,
        tag: args.tag
      });

    case 'bulk_archive':
      return roosyncManage({
        action: 'bulk_archive',
        from: args.from,
        priority: args.priority,
        before_date: args.before_date,
        subject_contains: args.subject_contains,
        tag: args.tag
      });

    case 'cleanup':
      return roosyncManage({ action: 'cleanup' });

    case 'stats':
      return roosyncManage({ action: 'stats', format: args.format });

    // --- Attachments family ---
    case 'attachments_list':
      return roosyncAttachments({
        action: 'list',
        message_id: args.message_id
      });

    case 'attachments_get':
      return roosyncAttachments({
        action: 'get',
        uuid: args.uuid,
        filename: args.filename,
        message_id: args.message_id,
        targetPath: args.targetPath
      });

    case 'attachments_delete':
      return roosyncAttachments({
        action: 'delete',
        uuid: args.uuid
      });

    default: {
      const _exhaustive: never = action;
      throw new Error(`Unknown action: ${_exhaustive}`);
    }
  }
}
