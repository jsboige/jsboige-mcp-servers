/**
 * Fire-and-forget dual-write of the RooSync messaging channel to the unified
 * Postgres store (#3151 Phase A).
 *
 * @module services/unified-store/roosync-channel-dual-write
 *
 * Same contract as dual-write.ts (conversations): env-gated via writer-factory
 * (UNIFIED_STORE_DUAL_WRITE=1 + UNIFIED_STORE_PG_URL → PgUnifiedStoreWriter,
 * otherwise a Null writer whose methods are no-ops). Never throws — a Postgres
 * failure must NEVER block the GDrive write path (canal must not depend on PG
 * in Phase A). Call sites attach `.catch(() => {})` for floating-promise
 * linting, matching the conversation dual-write convention.
 *
 * **Never blocking is not never mentioning (#3151, mesuré 2026-09-01).** Every
 * catch below deliberately swallows so PG can never break the GDrive path —
 * that contract stays. What was missing is that they swallowed *silently*: a
 * mirror that failed produced no log, no counter, no trace anywhere. A loss
 * with zero observable output cannot be noticed, reported, or counted, so the
 * gap it opens is invisible **by construction** — which is why it went
 * undescribed for weeks while ~7 % of the inbox drifted out of PG.
 *
 * The sibling PG-primary path (roosync-channel-write.ts) already logs each
 * failure with the id and the error; the dashboard store does too. This module
 * was the last silent one. The logs are the precondition for ever trusting the
 * Phase B read switch: you cannot verify "0 loss" on a channel that is
 * structurally unable to report loss.
 *
 * Phase A covered creation: send / reply / amend / attachment upload.
 * Phase A.2 covers what happens to a message afterwards — read, archived,
 * destroyed — for two independent reasons:
 *
 *  - **Correctness.** The 002 schema already had `status` / `read_at` /
 *    `archived_at`, but nothing ever wrote them after the INSERT, so every PG
 *    row stayed `unread` forever while the GDrive inbox was being drained by the
 *    auto-archive (#3150). A Phase B mailbox read would have returned every
 *    message ever sent — the very unbounded read this epic exists to remove.
 *  - **Secret lifetime.** `destroyMessage` bounds how long a secret lives: it
 *    wipes the body and deletes the attachment blob. Phase A copies both into
 *    PG and had no purge path, so a destroyed message survived its own
 *    destruction one storage layer down. Its own source comment warns against
 *    exactly this shape ("the one payload that had to be purged was the only one
 *    that never was").
 */

import type { Message } from '../MessageManager.js';
import type { RooSyncMessageOptions, RooSyncMessageRow } from './types.js';
import { getUnifiedStoreWriter } from './writer-factory.js';
import { parseMachineWorkspace } from '../../utils/message-helpers.js';
import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('roosync-channel-dual-write');

/**
 * Map a MessageManager Message to a roosync_messages row.
 * "machine:workspace" ids split into the two columns; a bare machine id gets
 * an empty workspace (schema NOT NULL — empty = all workspaces, matching the
 * GDrive inbox semantics where recipient matching is machine-first).
 *
 * #3151 Phase B: `reply_to` / `read_by` / `options` (migrations/005) make the
 * row a full-fidelity mirror, so the PG read path can reconstruct the Message
 * without consulting GDrive.
 */
export function mapMessageToRow(message: Message): RooSyncMessageRow {
  const from = parseMachineWorkspace(message.from);
  const to = parseMachineWorkspace(message.to);
  return {
    id: message.id,
    thread_id: message.thread_id ?? null,
    from_machine: from.machineId,
    from_workspace: from.workspaceId ?? '',
    to_machine: to.machineId,
    to_workspace: to.workspaceId ?? '',
    subject: message.subject,
    body: message.body,
    priority: message.priority,
    status: message.status,
    tags: message.tags ?? [],
    attachment_refs: message.attachments ?? [],
    created_at: message.timestamp,
    reply_to: message.reply_to ?? null,
    read_by: message.read_by ?? [],
    options: mapMessageOptions(message),
  };
}

/** Extract the payload fields carried by the `options` JSONB column (005). */
function mapMessageOptions(message: Message): RooSyncMessageOptions {
  const options: RooSyncMessageOptions = {};
  if (message.auto_destruct !== undefined) options.auto_destruct = message.auto_destruct;
  if (message.destruct_after_read_by !== undefined) options.destruct_after_read_by = message.destruct_after_read_by;
  if (message.destruct_after !== undefined) options.destruct_after = message.destruct_after;
  if (message.expires_at !== undefined) options.expires_at = message.expires_at;
  if (message.acknowledged_at !== undefined) options.acknowledged_at = message.acknowledged_at;
  if (message.metadata !== undefined) options.metadata = message.metadata;
  if (message.reminder_sent !== undefined) options.reminder_sent = message.reminder_sent;
  return options;
}

/**
 * Dual-write a sent message (covers send AND reply — both produce a new Message).
 * Idempotent: INSERT ON CONFLICT (id) DO NOTHING at the writer level.
 */
export async function dualWriteRooSyncMessageToStore(message: Message): Promise<void> {
  try {
    await getUnifiedStoreWriter().insertRooSyncMessage(mapMessageToRow(message));
  } catch (error) {
    // Swallowed on purpose (contract above), but NEVER silent: an
    // unlogged loss is undetectable by construction.
    logger.warn('[channel-dual-write] PG mirror failed — GDrive write kept', {
      op: 'insert',
      id: message.id,
      error: String(error),
    });
  }
}

/**
 * Dual-write an amended body (amendMessage keeps the same message id).
 */
export async function dualWriteRooSyncMessageAmendment(
  message: Message
): Promise<void> {
  try {
    await getUnifiedStoreWriter().updateRooSyncMessage(message.id, { body: message.body });
  } catch (error) {
    // Swallowed on purpose (contract above), but NEVER silent: an
    // unlogged loss is undetectable by construction.
    logger.warn('[channel-dual-write] PG mirror failed — GDrive write kept', {
      op: 'amend',
      id: message.id,
      error: String(error),
    });
  }
}

/**
 * Dual-write refreshed attachment refs on an existing message
 * (updateMessageAttachments after uploads complete).
 */
export async function dualWriteRooSyncAttachmentRefs(
  messageId: string,
  attachments: Message['attachments']
): Promise<void> {
  try {
    await getUnifiedStoreWriter().updateRooSyncMessage(messageId, {
      attachment_refs: attachments ?? [],
    });
  } catch (error) {
    // Swallowed on purpose (contract above), but NEVER silent: an
    // unlogged loss is undetectable by construction.
    logger.warn('[channel-dual-write] PG mirror failed — GDrive write kept', {
      op: 'attachment-refs',
      id: messageId,
      error: String(error),
    });
  }
}

/**
 * Dual-write a read transition (markAsRead).
 *
 * Only called for targeted messages. Broadcasts keep their global status
 * untouched and instead mirror `read_by` (below) — mirroring a broadcast as
 * globally `read` would hide it from the five machines that have not read it
 * yet. Over-show is the safe error, under-show is not.
 */
export async function dualWriteRooSyncMessageRead(messageId: string): Promise<void> {
  try {
    await getUnifiedStoreWriter().updateRooSyncMessage(messageId, {
      status: 'read',
      read_at: new Date().toISOString(),
    });
  } catch (error) {
    // Swallowed on purpose (contract above), but NEVER silent: an
    // unlogged loss is undetectable by construction.
    logger.warn('[channel-dual-write] PG mirror failed — GDrive write kept', {
      op: 'read',
      id: messageId,
      error: String(error),
    });
  }
}

/**
 * Dual-write per-machine broadcast read tracking (markAsRead on a broadcast,
 * #3151 Phase B + migrations/005).
 *
 * Whole-array replace: the GDrive path is read-modify-write of the same array,
 * so the file's resulting array is the authority — sending it wholesale is
 * self-healing for readers missed by an older partial write. The global
 * `status` of a broadcast is deliberately left `unread`.
 */
export async function dualWriteRooSyncMessageBroadcastRead(
  messageId: string,
  readBy: string[]
): Promise<void> {
  try {
    await getUnifiedStoreWriter().updateRooSyncMessage(messageId, {
      read_by: readBy,
    });
  } catch (error) {
    // Swallowed on purpose (contract above), but NEVER silent: an
    // unlogged loss is undetectable by construction.
    logger.warn('[channel-dual-write] PG mirror failed — GDrive write kept', {
      op: 'broadcast-read',
      id: messageId,
      error: String(error),
    });
  }
}

/**
 * Dual-write an archive transition (archiveMessage — manual or auto #3150).
 *
 * This is the one that keeps a Phase B mailbox read bounded: on GDrive the file
 * leaves `inbox/`, and this is its PG equivalent.
 */
export async function dualWriteRooSyncMessageArchived(messageId: string): Promise<void> {
  try {
    await getUnifiedStoreWriter().updateRooSyncMessage(messageId, {
      status: 'archived',
      archived_at: new Date().toISOString(),
    });
  } catch (error) {
    // Swallowed on purpose (contract above), but NEVER silent: an
    // unlogged loss is undetectable by construction.
    logger.warn('[channel-dual-write] PG mirror failed — GDrive write kept', {
      op: 'archived',
      id: messageId,
      error: String(error),
    });
  }
}

/**
 * Dual-write an expiry-reminder stamp (sendExpiryReminders).
 *
 * The reminder itself is a new message and already reaches PG through the send
 * path; what was missing is the flag on the *original* message that stops the
 * sweep from reminding twice. Unmirrored, a Phase B sweep would re-send a
 * reminder for the same message on every pass.
 */
export async function dualWriteRooSyncMessageReminderSent(
  messageId: string
): Promise<void> {
  try {
    await getUnifiedStoreWriter().updateRooSyncMessage(messageId, {
      reminder_sent_at: new Date().toISOString(),
    });
  } catch (error) {
    // Swallowed on purpose (contract above), but NEVER silent: an
    // unlogged loss is undetectable by construction.
    logger.warn('[channel-dual-write] PG mirror failed — GDrive write kept', {
      op: 'reminder-sent',
      id: messageId,
      error: String(error),
    });
  }
}

/**
 * Dual-write a destruction (destroyMessage): wipe the body, stamp the reason,
 * and purge every attachment payload from `roosync_attachments`.
 *
 * Ordering mirrors `destroyMessage` itself — payloads first, stamp second — so a
 * partial failure cannot report a destroyed message whose bytes are still in the
 * table. Unlike the GDrive path this one cannot signal failure upstream (the
 * dual-write must never break the caller), so it purges payloads individually
 * and lets `withRetry` in the writer handle transient errors.
 */
export async function dualWriteRooSyncMessageDestroyed(
  messageId: string,
  reason: string,
  attachmentUuids: string[]
): Promise<void> {
  try {
    const writer = getUnifiedStoreWriter();
    for (const uuid of attachmentUuids) {
      await writer.deleteRooSyncAttachment(uuid);
    }
    await writer.updateRooSyncMessage(messageId, {
      body: '[DESTROYED]',
      destroyed_at: new Date().toISOString(),
      destroyed_reason: reason,
    });
  } catch (error) {
    // Swallowed on purpose (contract above), but NEVER silent: an
    // unlogged loss is undetectable by construction.
    logger.warn('[channel-dual-write] PG mirror failed — GDrive write kept', {
      op: 'destroy',
      id: messageId,
      error: String(error),
    });
  }
}

/**
 * Dual-write an attachment payload as bytea (#3151 D2: no hybrid threshold).
 * Reads the file the AttachmentManager just wrote to GDrive and ships its
 * bytes to PG, with sha256 for integrity.
 */
export async function dualWriteRooSyncAttachmentToStore(
  uuid: string,
  filePath: string,
  filename: string,
  mime: string | null
): Promise<void> {
  try {
    const payload = await readFile(filePath);
    await getUnifiedStoreWriter().insertRooSyncAttachment({
      id: uuid,
      filename,
      mime,
      size: payload.length,
      sha256: createHash('sha256').update(payload).digest('hex'),
      payload,
    });
  } catch (error) {
    // Swallowed on purpose (contract above), but NEVER silent: an
    // unlogged loss is undetectable by construction.
    logger.warn('[channel-dual-write] PG mirror failed — GDrive write kept', {
      op: 'attachment-payload',
      id: uuid,
      error: String(error),
    });
  }
}
