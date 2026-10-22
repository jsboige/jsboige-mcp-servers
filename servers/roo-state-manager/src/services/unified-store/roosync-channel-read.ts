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
import { withColdPoolResume } from './pg-cold-pool-resume.js';
import { parseMachineWorkspace, matchesRecipient, perReaderStatus } from '../../utils/message-helpers.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('roosync-channel-read');

/**
 * Returns the channel reader when the Phase B read gate is on, else null.
 *
 * Phase D: the write-primary gate (`UNIFIED_STORE_CHANNEL_PG_PRIMARY=1`)
 * implies the read gate — a machine that stops writing GDrive must not keep
 * reading it as primary, or sends from PG-primary machines would be invisible
 * to it.
 *
 * Read at call time (not import time) so tests and config reloads can toggle
 * it without a process restart.
 */
export function getChannelPgReader(): IUnifiedStoreReader | null {
  if (
    process.env.UNIFIED_STORE_CHANNEL_READ_PG !== '1' &&
    process.env.UNIFIED_STORE_CHANNEL_PG_PRIMARY !== '1'
  ) return null;
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
  if (row.read_by_workspace.length > 0) message.read_by_workspace = row.read_by_workspace;
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
  const filtered: MessageListItem[] = [];

  for (const row of rows) {
    const to = row.to_workspace ? `${row.to_machine}:${row.to_workspace}` : row.to_machine;
    if (!matchesRecipient(to, machineId, workspaceId)) continue;

    // Same verdict source as the GDrive path: perReaderStatus (#629 broadcasts
    // via read_by, #3960 machine-wide via read_by_workspace with the legacy
    // global-status fallback; null = raw status). Judging these rows by the
    // raw global status alone re-surfaced every machine-wide message as unread
    // on CHANNEL_READ_PG seats (read-state divergence, 02/10, #3151).
    const perReader = perReaderStatus(mapRowToMessage(row), machineId, workspaceId);

    if (status && status !== 'all') {
      const effective = perReader ?? row.status;
      if (effective !== status) continue;
    }

    const item = mapRowToListItem(row);
    filtered.push(perReader ? { ...item, status: perReader } : item);
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
    const rows = await withColdPoolResume(
      () => reader.getRooSyncMailbox(parseMachineWorkspace(machineId).machineId),
      'channel:mailbox'
    );
    return filterMailboxRows(rows, machineId, status, workspaceId);
  } catch (error) {
    logger.warn('[channel-pg] mailbox read failed — caller should fall back to GDrive', { error: String(error) });
    return null;
  }
}

/**
 * #4285 — full-message mailbox enumeration for the bulk operations and stats.
 *
 * `readChannelInboxFromPg` returns condensed list items (no `tags`, no
 * per-message read state), which cannot serve `bulkOperation`'s tag filter
 * nor its #3702 per-reader status lens. This returns the recipient's FULL
 * Messages, so the bulk predicates run over the same rows the inbox serves.
 * Recipient matching is applied here (same `matchesRecipient` call the
 * inbox path uses); rows arrive newest-first from the reader.
 *
 * @returns The recipient's messages, or **null** when PG is unavailable —
 *   the caller must then fall back to the GDrive enumeration.
 */
export async function readChannelMailboxFromPg(
  reader: IUnifiedStoreReader,
  machineId: string,
  workspaceId?: string
): Promise<Message[] | null> {
  try {
    // Same bounded cold-pool resume as the count sibling above (#4303): the
    // callers that hit this at process boot (the B14 CLI) land on the pool at
    // its coldest — one retry on the connection-timeout signature, then the
    // null → GDrive fallback contract stands for durable failures.
    const rows = await withColdPoolResume(
      () => reader.getRooSyncMailbox(parseMachineWorkspace(machineId).machineId),
      'channel:mailbox'
    );
    const messages: Message[] = [];
    for (const row of rows) {
      const to = row.to_workspace ? `${row.to_machine}:${row.to_workspace}` : row.to_machine;
      if (!matchesRecipient(to, machineId, workspaceId)) continue;
      messages.push(mapRowToMessage(row));
    }
    return messages;
  } catch (error) {
    logger.warn('[channel-pg] mailbox enumeration failed — caller should fall back to GDrive', { error: String(error) });
    return null;
  }
}

/**
 * #4302 — the WHOLE channel pool from PG (cleanupExpiredMessages,
 * sendExpiryReminders), parity with the GDrive pool those scans iterate
 * today: every non-archived, non-destroyed message regardless of recipient.
 *
 * @returns Full messages (newest first), or **null** when PG is unavailable
 *   — the caller must then fall back to the GDrive path.
 */
export async function readWholeChannelFromPg(reader: IUnifiedStoreReader): Promise<Message[] | null> {
  try {
    const rows = await reader.getRooSyncChannelMessages();
    return rows.map(mapRowToMessage);
  } catch (error) {
    logger.warn('[channel-pg] channel pool read failed — caller should fall back to GDrive', { error: String(error) });
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
    const rows = await withColdPoolResume(
      () => reader.getRooSyncMailbox(parseMachineWorkspace(machineId).machineId),
      'channel:count'
    );
    let total = 0;
    let unread = 0;
    let read = 0;

    for (const row of rows) {
      const to = row.to_workspace ? `${row.to_machine}:${row.to_workspace}` : row.to_machine;
      if (!matchesRecipient(to, machineId, workspaceId)) continue;

      total++;
      // Same verdict source as filterMailboxRows (perReaderStatus — #629
      // broadcasts, #3960 machine-wide via read_by_workspace, migrations/010):
      // counting machine-wide rows by the raw global status inflated `unread`
      // on CHANNEL_READ_PG seats (#3151).
      const effectiveStatus =
        perReaderStatus(mapRowToMessage(row), machineId, workspaceId) ?? row.status;
      const isUnreadForMachine = effectiveStatus === 'unread';

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
 * Rows for the pre-listing maintenance sweeps (#4301): auto-archive, expired
 * auto-destruct cleanup, expiry reminders.
 *
 * On a CHANNEL_READ_PG host the mailbox is served from PG, so rebuilding the
 * GDrive inbox cache just to decide what to sweep is pure waste — measured on
 * ai-01 (20/10, build `ca2da038`): 39 passes, 38 cache rebuilds (~4 400 files
 * each) and 511 read errors over 11 h 45, while PG served all 799 inbox reads.
 *
 * Scope: the local machine's mailbox (rows addressed to the machine or
 * broadcast). The historical GDrive scan was fleet-wide only because `inbox/`
 * is a shared directory with no recipient index — PG rows carry their
 * recipient, so each host sweeps what it owns.
 *
 * @returns Rows (newest first), or **null** when PG is unavailable — the
 *   caller must then fall back to the GDrive cache scan.
 */
export async function readChannelSweepRowsFromPg(
  reader: IUnifiedStoreReader,
  machineId: string
): Promise<RooSyncMessageRow[] | null> {
  try {
    return await reader.getRooSyncMailbox(parseMachineWorkspace(machineId).machineId);
  } catch (error) {
    logger.warn('[channel-pg] sweep read failed — caller should fall back to GDrive', { error: String(error) });
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
    const row = await withColdPoolResume(
      () => reader.getRooSyncMessageById(messageId),
      `channel:message:${messageId}`
    );
    if (!row) return null;
    return mapRowToMessage(row);
  } catch (error) {
    logger.warn('[channel-pg] message fetch failed — caller should fall back to GDrive', { error: String(error) });
    return null;
  }
}

/**
 * #4131 B14 — one-shot inbox read for the scheduled workers (CLI contract).
 *
 * `scripts/scheduling/start-claude-worker.ps1` reads `messages\inbox` as files
 * in two places (`Get-RooSyncTask`, `Test-RooSyncResponse`). Under
 * `CHANNEL_PG_PRIMARY` messages no longer have files, so those functions go
 * blind. The worker cannot host an MCP client, but it CAN shell out to
 * `scripts/read-roosync-inbox.mjs` — which calls this helper.
 *
 * Unlike the helpers above, this one is self-contained: it resolves the gated
 * reader itself and CLOSES it before returning (a CLI must not leave a live PG
 * pool holding the event loop open at exit). The `status` of each message is
 * adjusted through `perReaderStatus` — same verdict source as the inbox path —
 * so a broadcast already read by another seat of the machine does not re-fire
 * the worker under PG.
 *
 * @returns `{source: 'pg', messages}` — the recipient's full messages (newest
 *   first, read and unread alike; the PowerShell callers filter `status`
 *   themselves, mirroring the file pool). `{source: 'file'}` tells the caller
 *   to keep the legacy file path: gate off, or PG unreachable.
 */
export async function readCliInboxFromPg(
  machineId: string,
  workspaceId?: string
): Promise<
  | { source: 'pg'; messages: Message[] }
  | { source: 'file'; reason: 'gate-off' | 'pg-unavailable' }
> {
  // The CLI documents the combined "machine:workspace" form (--help parity
  // with the MCP inbox): parse it here like read.ts does for its workspace
  // argument (#3177) — the machine half is SUBSTITUTED, never concatenated.
  // canonicalMachineId alone would leave the colon in and matchesRecipient
  // would reject everything but 'all' (review head cad920f5, F1). An
  // explicit workspace qualifier still wins over the combined suffix.
  const parsedCaller = parseMachineWorkspace(machineId);
  const machine = parsedCaller.machineId;
  const workspace = workspaceId ?? parsedCaller.workspaceId;

  const reader = getChannelPgReader();
  if (!reader) return { source: 'file', reason: 'gate-off' };

  try {
    const messages = await readChannelMailboxFromPg(reader, machine, workspace);
    if (messages === null) return { source: 'file', reason: 'pg-unavailable' };

    return {
      source: 'pg',
      messages: messages.map((message) => {
        const perReader = perReaderStatus(message, machine, workspace);
        return perReader ? { ...message, status: perReader } : message;
      }),
    };
  } finally {
    await reader.close();
  }
}
