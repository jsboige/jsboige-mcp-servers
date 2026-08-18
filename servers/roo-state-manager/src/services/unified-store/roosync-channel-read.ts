/**
 * PG-primary read path for the RooSync messaging channel (#3151 Phase B).
 *
 * @module services/unified-store/roosync-channel-read
 *
 * Reads the mailbox and single messages from `roosync_messages` instead of
 * scanning the GDrive tree (21.8 K files → one indexed query, D5). GDrive
 * remains the fallback: every helper here returns `null` on PG failure and
 * the caller (MessageManager) falls back to the file path — dégradation
 * gracieuse per the epic.
 *
 * Env-gate — deliberately SEPARATE from the dual-write flag:
 *   UNIFIED_STORE_CHANNEL_READ_PG=1 + UNIFIED_STORE_PG_URL + reader non-Null
 *
 * A machine must not read its mailbox from PG before the channel history has
 * been backfilled (`scripts/backfill-roosync-channel.mjs`) — an empty store
 * would present as an empty inbox, which is the one failure mode this channel
 * cannot tolerate (under-show). The write side (UNIFIED_STORE_DUAL_WRITE)
 * fills PG going forward; this flag turns the read side on once the store is
 * complete.
 */

import type { Message, MessageListItem } from '../MessageManager.js';
import type { RooSyncMessageRow } from './types.js';
import type { IUnifiedStoreReader } from './UnifiedStoreReader.js';
import { getUnifiedStoreReader } from './reader-factory.js';
import { parseMachineWorkspace, matchesRecipient } from '../../utils/message-helpers.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('roosync-channel-read');

/**
 * Returns the channel reader when the Phase B read gate is on, else null.
 *
 * Read at call time (not import time) so tests and config reloads can toggle
 * it without a process restart.
 */
export function getChannelPgReader(): IUnifiedStoreReader | null {
  if (process.env.UNIFIED_STORE_CHANNEL_READ_PG !== '1') return null;
  if (!process.env.UNIFIED_STORE_PG_URL) return null;
  const reader = getUnifiedStoreReader();
  if (reader.isNull()) return null;
  return reader;
}

/**
 * Inverse of `mapMessageToRow`: reconstruct a full-fidelity Message from a
 * `roosync_messages` row (columns + `options` payload, migrations/002–005).
 */
export function mapRowToMessage(row: RooSyncMessageRow): Message {
  const message: Message = {
    id: row.id,
    from: row.from_workspace ? `${row.from_machine}:${row.from_workspace}` : row.from_machine,
    to: row.to_workspace ? `${row.to_machine}:${row.to_workspace}` : row.to_machine,
    subject: row.subject,
    body: row.body,
    priority: row.priority as Message['priority'],
    status: row.status,
    timestamp: row.created_at,
  };
  if (row.thread_id) message.thread_id = row.thread_id;
  if (row.reply_to) message.reply_to = row.reply_to;
  if (row.read_by.length > 0) message.read_by = row.read_by;
  if (row.tags.length > 0) message.tags = row.tags;
  if (row.attachment_refs.length > 0) message.attachments = row.attachment_refs;

  const options = row.options ?? {};
  if (options.auto_destruct !== undefined) message.auto_destruct = options.auto_destruct;
  if (options.destruct_after_read_by !== undefined) message.destruct_after_read_by = options.destruct_after_read_by;
  if (options.destruct_after !== undefined) message.destruct_after = options.destruct_after;
  if (options.expires_at !== undefined) message.expires_at = options.expires_at;
  if (options.acknowledged_at !== undefined) message.acknowledged_at = options.acknowledged_at;
  if (options.metadata !== undefined) message.metadata = options.metadata;
  if (row.reminder_sent_at) {
    message.reminder_sent = true;
  } else if (options.reminder_sent !== undefined) {
    message.reminder_sent = options.reminder_sent;
  }
  if (row.destroyed_at) message.destroyed_at = row.destroyed_at;
  if (row.destroyed_reason) {
    message.destroyed_reason = row.destroyed_reason as Message['destroyed_reason'];
  }

  return message;
}

/** Condensed list-item view of a row (parity with the GDrive cache build). */
export function mapRowToListItem(row: RooSyncMessageRow): MessageListItem {
  return {
    id: row.id,
    from: row.from_workspace ? `${row.from_machine}:${row.from_workspace}` : row.from_machine,
    to: row.to_workspace ? `${row.to_machine}:${row.to_workspace}` : row.to_machine,
    subject: row.subject,
    priority: row.priority,
    timestamp: row.created_at,
    status: row.status,
    preview: row.body.substring(0, 100) + (row.body.length > 100 ? '...' : ''),
  };
}

/**
 * Apply the GDrive inbox semantics to PG rows: recipient matching
 * (`matchesRecipient`), status filter with per-machine broadcast state from
 * `read_by` (#629), and per-machine status adjustment on broadcast list
 * items (#2307 Phase 4). Rows arrive newest-first from the reader.
 */
function filterMailboxRows(
  rows: RooSyncMessageRow[],
  machineId: string,
  status: 'unread' | 'read' | 'all' | undefined,
  workspaceId: string | undefined
): MessageListItem[] {
  const readerMachineId = parseMachineWorkspace(machineId).machineId;
  const filtered: MessageListItem[] = [];

  for (const row of rows) {
    const to = row.to_workspace ? `${row.to_machine}:${row.to_workspace}` : row.to_machine;
    if (!matchesRecipient(to, machineId, workspaceId)) continue;

    const isBroadcast = row.to_machine === 'all' || row.to_machine === 'All';

    if (status && status !== 'all') {
      if (isBroadcast && row.read_by.length > 0) {
        const hasRead = row.read_by.includes(readerMachineId);
        if (status === 'unread' && hasRead) continue;
        if (status === 'read' && !hasRead) continue;
      } else {
        if (row.status !== status) continue;
      }
    }

    const item = mapRowToListItem(row);
    if (isBroadcast && row.read_by.length > 0) {
      filtered.push({
        ...item,
        status: row.read_by.includes(readerMachineId) ? 'read' : 'unread',
      });
    } else {
      filtered.push(item);
    }
  }

  return filtered;
}

/**
 * Read the mailbox from PG.
 *
 * @returns The filtered list items (newest first), or **null** when PG is
 *   unavailable — the caller must then fall back to the GDrive path. An empty
 *   array is a valid, authoritative answer (empty inbox).
 */
export async function readChannelInboxFromPg(
  reader: IUnifiedStoreReader,
  machineId: string,
  status?: 'unread' | 'read' | 'all',
  workspaceId?: string
): Promise<MessageListItem[] | null> {
  try {
    const rows = await reader.getRooSyncMailbox(parseMachineWorkspace(machineId).machineId);
    return filterMailboxRows(rows, machineId, status, workspaceId);
  } catch (error) {
    logger.warn('[channel-pg] mailbox read failed — caller should fall back to GDrive', { error: String(error) });
    return null;
  }
}

/**
 * Count mailbox items from PG (parity with `getFilteredCount`).
 *
 * @returns Counts, or null when PG is unavailable (fallback expected).
 */
export async function countChannelInboxFromPg(
  reader: IUnifiedStoreReader,
  machineId: string,
  workspaceId?: string
): Promise<{ total: number; unread: number; read: number } | null> {
  try {
    const rows = await reader.getRooSyncMailbox(parseMachineWorkspace(machineId).machineId);
    const readerMachineId = parseMachineWorkspace(machineId).machineId;
    let total = 0;
    let unread = 0;
    let read = 0;

    for (const row of rows) {
      const to = row.to_workspace ? `${row.to_machine}:${row.to_workspace}` : row.to_machine;
      if (!matchesRecipient(to, machineId, workspaceId)) continue;

      total++;
      const isBroadcast = row.to_machine === 'all' || row.to_machine === 'All';
      const isUnreadForMachine =
        isBroadcast && row.read_by.length > 0
          ? !row.read_by.includes(readerMachineId)
          : row.status === 'unread';

      if (isUnreadForMachine) unread++;
      else read++;
    }

    return { total, unread, read };
  } catch (error) {
    logger.warn('[channel-pg] mailbox count failed — caller should fall back to GDrive', { error: String(error) });
    return null;
  }
}

/**
 * Fetch one full message from PG.
 *
 * @returns The message, or null when PG is unavailable OR the id is unknown —
 *   the caller falls back to the GDrive paths in both cases (a PG miss and a
 *   GDrive miss produce the same "not found" outcome).
 */
export async function getChannelMessageFromPg(
  reader: IUnifiedStoreReader,
  messageId: string
): Promise<Message | null> {
  try {
    const row = await reader.getRooSyncMessageById(messageId);
    if (!row) return null;
    return mapRowToMessage(row);
  } catch (error) {
    logger.warn('[channel-pg] message fetch failed — caller should fall back to GDrive', { error: String(error) });
    return null;
  }
}
