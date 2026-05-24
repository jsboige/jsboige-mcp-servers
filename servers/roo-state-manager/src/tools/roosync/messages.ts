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
  reply_to: z.string().optional().describe('ID du message auquel repondre (pour send)'),
  message_id: z.string().optional().describe('ID du message (requis pour reply/amend/mark_read/archive/message/attachments_list)'),
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
  workspace: z.string().optional().describe('Override workspace filter (#1498)'),
  to_machine: z.string().optional().describe('Override machine filter (#1498, avance)'),

  // --- Manage bulk params ---
  from: z.string().optional().describe('Filtrer par expediteur (bulk)'),
  before_date: z.string().optional().describe('Filtrer avant date ISO-8601 (bulk)'),
  subject_contains: z.string().optional().describe('Filtrer par sujet (bulk)'),
  tag: z.string().optional().describe('Filtrer par tag (bulk)'),

  // --- Attachments params ---
  uuid: z.string().optional().describe('UUID piece jointe (requis pour attachments_get/delete)'),
  targetPath: z.string().optional().describe('Chemin local destination (requis pour attachments_get)'),

  // --- Output format ---
  format: z.enum(['json', 'markdown']).optional().describe('Format de sortie pour inbox/stats')
});

export type MessagesArgs = z.infer<typeof MessagesArgsSchema>;

// ====================================================================
// IMPLEMENTATION
// ====================================================================

export async function roosyncMessages(args: MessagesArgs) {
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
      return roosyncSend({
        action: 'reply',
        message_id: args.message_id,
        body: args.body,
        priority: args.priority,
        tags: args.tags
      });

    case 'amend':
      return roosyncSend({
        action: 'amend',
        message_id: args.message_id,
        new_content: args.new_content,
        reason: args.reason
      });

    // --- Read family ---
    case 'inbox':
      return roosyncRead({
        mode: 'inbox',
        status: args.status,
        limit: args.limit,
        page: args.page,
        per_page: args.per_page,
        workspace: args.workspace,
        to_machine: args.to_machine,
        format: args.format
      });

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
