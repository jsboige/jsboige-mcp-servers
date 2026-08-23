/**
 * PG-primary write path for the RooSync messaging channel (#3151 Phase D).
 *
 * @module services/unified-store/roosync-channel-write
 *
 * Phase A made the GDrive write primary and PG a fire-and-forget mirror;
 * Phase B turned reads PG-primary; this module flips the WRITE side. When
 * `UNIFIED_STORE_CHANNEL_PG_PRIMARY=1` (+ `UNIFIED_STORE_PG_URL` +
 * `UNIFIED_STORE_DUAL_WRITE=1`, the factory's condition for a real
 * PgUnifiedStoreWriter), MessageManager persists to `roosync_messages` FIRST
 * and skips the GDrive files entirely — GDrive becomes a read-only legacy
 * archive (the epic's Phase D target: "GDrive jamais sollicité sur le chemin
 * critique").
 *
 * Failure contract — the inverse of the dual-write one:
 *   - dual-write (Phase A): PG failure swallowed, GDrive stands.
 *   - PG-primary (Phase D):  PG failure REPORTED (returns false), the caller
 *     falls back to the GDrive write path. A PG outage therefore degrades to
 *     the pre-Phase-A behavior instead of losing the message — and the
 *     backfill CLI re-syncs the divergence once PG is back.
 *
 * The DUAL_WRITE requirement is not a Phase A leftover: it is the Null-writer
 * guard. Without it the factory hands back the Null writer, whose writes are
 * silent no-ops — PG_PRIMARY would then report success and skip GDrive. The
 * gate refuses that config instead of losing messages (review #1030).
 */

import type { Message } from '../MessageManager.js';
import type { RooSyncMessageUpdate } from './types.js';
import { getUnifiedStoreWriter } from './writer-factory.js';
import { mapMessageToRow } from './roosync-channel-dual-write.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('roosync-channel-write');

/**
 * True when the Phase D write-primary gate is on. Read at call time so tests
 * and config reloads can toggle it without a process restart.
 */
export function isChannelPgPrimary(): boolean {
  // DUAL_WRITE=1 is required because writer-factory only builds a real
  // PgUnifiedStoreWriter under that flag — without it the writer is the Null
  // writer, whose insert/update/delete are no-ops that resolve without
  // throwing. A PG_PRIMARY gate on the Null writer reports success, skips the
  // GDrive fallback, and loses the message with no signal (review #1030).
  return process.env.UNIFIED_STORE_CHANNEL_PG_PRIMARY === '1'
    && process.env.UNIFIED_STORE_DUAL_WRITE === '1'
    && !!process.env.UNIFIED_STORE_PG_URL;
}

/**
 * PG-primary insert of a sent message (send and reply).
 *
 * @returns true when the row was persisted — the caller MUST then skip the
 *   GDrive file writes. false on any PG failure — the caller falls back to
 *   the GDrive write path (which re-attempts the PG mirror via dual-write).
 */
export async function insertRooSyncMessagePrimary(message: Message): Promise<boolean> {
  try {
    await getUnifiedStoreWriter().insertRooSyncMessage(mapMessageToRow(message));
    return true;
  } catch (error) {
    logger.warn('[channel-pg] PG-primary insert failed — falling back to GDrive write', {
      id: message.id,
      error: String(error),
    });
    return false;
  }
}

/**
 * PG-primary update of an existing row (read / archived / amend / destroy
 * transitions executed against a row loaded from PG).
 *
 * @returns true when the update was persisted — the caller skips the GDrive
 *   file writes. false on any PG failure — the caller falls back to the
 *   GDrive file path.
 */
export async function updateRooSyncMessagePrimary(
  id: string,
  fields: RooSyncMessageUpdate
): Promise<boolean> {
  try {
    await getUnifiedStoreWriter().updateRooSyncMessage(id, fields);
    return true;
  } catch (error) {
    logger.warn('[channel-pg] PG-primary update failed — falling back to GDrive path', {
      id,
      error: String(error),
    });
    return false;
  }
}

/**
 * PG-primary destruction (destroyMessage against a PG-loaded row): purge the
 * bytea payloads first, stamp `destroyed_*` second — the same ordering as the
 * GDrive path and dualWriteRooSyncMessageDestroyed, so a partial failure
 * never reports a destroyed message whose bytes survive one layer down.
 *
 * @returns true when payloads + stamp both persisted.
 */
export async function destroyRooSyncMessageInStore(
  messageId: string,
  reason: string,
  attachmentUuids: string[]
): Promise<boolean> {
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
    return true;
  } catch (error) {
    logger.warn('[channel-pg] PG-primary destroy failed — falling back to GDrive path', {
      id: messageId,
      error: String(error),
    });
    return false;
  }
}

/**
 * Retention sweep (#3151 Phase D) — never throws; the cleanup action reports
 * the count. No-op when the retention window is not positive.
 */
export async function purgeArchivedChannelMessages(retentionDays: number): Promise<number> {
  if (retentionDays <= 0) return 0;
  try {
    return await getUnifiedStoreWriter().purgeArchivedRooSyncMessages(retentionDays);
  } catch (error) {
    logger.error('[channel-pg] retention purge failed', { error: String(error) });
    return 0;
  }
}
