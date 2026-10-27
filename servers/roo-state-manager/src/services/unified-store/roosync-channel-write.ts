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
import { isPgFlagOn } from './pg-flags.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('roosync-channel-write');

/**
 * True when the unified store accepts REAL writes — a `PgUnifiedStoreWriter`,
 * not the Null no-op.
 *
 * Also the precondition of the read-path maintenance sweeps (#4301): those are
 * driven by a CHANNEL_READ_PG reader, but their transitions land in the store.
 * On the Null writer every update silently matches 0 rows, so the sweep would
 * report nothing archived while the served mailbox never shrinks.
 */
export function isChannelPgWritable(): boolean {
  // DUAL_WRITE is required because writer-factory only builds a real
  // PgUnifiedStoreWriter under that flag — without it the writer is the Null
  // writer, whose insert/update/delete are no-ops that resolve without
  // throwing. #4131: the flag now DEFAULTS ON on a host with a PG URL;
  // '0'/'false' remains the kill-switch back to the Null writer.
  return isPgFlagOn('UNIFIED_STORE_DUAL_WRITE')
    && !!process.env.UNIFIED_STORE_PG_URL;
}

/**
 * True when the Phase D write-primary gate is on. Read at call time so tests
 * and config reloads can toggle it without a process restart.
 */
export function isChannelPgPrimary(): boolean {
  // A PG_PRIMARY gate on the Null writer reports success, skips the GDrive
  // fallback, and loses the message with no signal (review #1030) — hence the
  // writability precondition.
  return isPgFlagOn('UNIFIED_STORE_CHANNEL_PG_PRIMARY')
    && isChannelPgWritable();
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
 * @returns true when the update was persisted AND matched at least one row —
 *   the caller skips the GDrive file writes. false on any PG failure OR when
 *   the UPDATE matched 0 rows (#4131 B9: a silent no-op UPDATE leaves the PG
 *   mirror missing while reporting success, which is exactly the drift this
 *   channel exists to prevent) — the caller falls back to the GDrive file
 *   path.
 */
export async function updateRooSyncMessagePrimary(
  id: string,
  fields: RooSyncMessageUpdate
): Promise<boolean> {
  try {
    const rowCount = await getUnifiedStoreWriter().updateRooSyncMessage(id, fields);
    if (rowCount === 0) {
      logger.warn('[channel-pg] PG-primary update matched 0 rows — falling back to GDrive path', {
        id,
        fields: Object.keys(fields),
      });
      return false;
    }
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
 * @returns true when payloads + stamp both persisted AND the stamp matched at
 *   least one row. false on any PG failure OR when the stamp UPDATE matched 0
 *   rows (#4131 B9 destroy, NanoClaw reserve: the row id is absent from PG —
 *   reporting success would leave an un-stamped mirror) — the caller falls
 *   back to the GDrive destroy path (attachment purges are idempotent there).
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
    const rowCount = await writer.updateRooSyncMessage(messageId, {
      body: '[DESTROYED]',
      destroyed_at: new Date().toISOString(),
      destroyed_reason: reason,
    });
    if (rowCount === 0) {
      logger.warn('[channel-pg] PG-primary destroy matched 0 rows — falling back to GDrive path', {
        id: messageId,
      });
      return false;
    }
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
    logger.error('[channel-pg] retention purge failed', error);
    return 0;
  }
}
