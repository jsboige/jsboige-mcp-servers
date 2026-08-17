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
 * Write-side only: send / reply / amend / attachment upload. Status transitions
 * (markRead / archive) stay GDrive-only until Phase B reads from PG.
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
