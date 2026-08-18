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
import type { RooSyncMessageRow } from './types.js';
import { getUnifiedStoreWriter } from './writer-factory.js';
import { parseMachineWorkspace } from '../../utils/message-helpers.js';
import { createHash } from 'crypto';
import { readFile } from 'fs/promises';

/**
 * Map a MessageManager Message to a roosync_messages row.
 * "machine:workspace" ids split into the two columns; a bare machine id gets
 * an empty workspace (schema NOT NULL — empty = all workspaces, matching the
 * GDrive inbox semantics where recipient matching is machine-first).
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
  };
}

/**
 * Dual-write a sent message (covers send AND reply — both produce a new Message).
 * Idempotent: INSERT ON CONFLICT (id) DO NOTHING at the writer level.
 */
export async function dualWriteRooSyncMessageToStore(message: Message): Promise<void> {
  try {
    await getUnifiedStoreWriter().insertRooSyncMessage(mapMessageToRow(message));
  } catch {
    // Swallow — never block the GDrive send path.
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
  } catch {
    // Swallow — never block the GDrive amend path.
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
  } catch {
    // Swallow — never block the GDrive path.
  }
}

/**
 * Dual-write a read transition (markAsRead).
 *
 * Only called for targeted messages. Broadcasts deliberately keep their global
 * status on GDrive — per-machine filtering there uses `read_by`, which has no
 * column in the 002 schema — so mirroring a broadcast as globally `read` would
 * hide it from the five machines that have not read it yet. Until Phase B
 * models `read_by`, a broadcast stays `unread` in PG, which is the safe error:
 * it over-shows rather than under-shows.
 */
export async function dualWriteRooSyncMessageRead(messageId: string): Promise<void> {
  try {
    await getUnifiedStoreWriter().updateRooSyncMessage(messageId, {
      status: 'read',
      read_at: new Date().toISOString(),
    });
  } catch {
    // Swallow — never block the GDrive markAsRead path.
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
  } catch {
    // Swallow — never block the GDrive archive path.
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
  } catch {
    // Swallow — never block the GDrive destruction path.
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
  } catch {
    // Swallow — never block the GDrive upload path.
  }
}
