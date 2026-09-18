/**
 * PG-primary write + PG-first read paths for RooSync attachments
 * (#3151 §7.5.2 — the last channel surface still writing GDrive blobs).
 *
 * @module services/unified-store/roosync-attachment-pg
 *
 * Phases A→D-1 moved messages to PG (write-primary + read-primary); the
 * attachment blobs stayed GDrive-with-bytea-mirror because their reads
 * (metadata.json per uuid, `readdir` scans) are per-entry rather than
 * mailbox-wide, so they were less acute. §7.5.2 closes the gap so the whole
 * channel — messages AND attachments — can run PG-primary.
 *
 * Gates (same cascade as the message channel):
 *   - write: `UNIFIED_STORE_CHANNEL_PG_PRIMARY=1` (+ DUAL_WRITE + PG_URL, the
 *     factory's conditions for a real writer — see isChannelPgPrimary).
 *   - read: `UNIFIED_STORE_CHANNEL_READ_PG=1` OR the write-primary gate (same
 *     rule as getChannelPgReader: a machine that stops writing GDrive must not
 *     keep reading it as primary, or PG-only uploads from other machines
 *     would be invisible to it).
 *
 * Parity rule — a PG row with NULL `uploader_machine` (legacy Phase A
 * dual-write payloads, pre-migration-007) cannot reconstruct a full
 * `AttachmentMetadata`: every read helper treats it as a MISS and the caller
 * falls back to the GDrive metadata.json. The attachments backfill phase
 * upgrades those rows in place (metadata only, payload untouched), after
 * which PG serves them directly.
 *
 * Failure contract — the inverse of the dual-write one, per Phase D:
 *   - reads: PG failure → null (never throws), caller falls back to GDrive;
 *   - write-primary: PG failure → false (reported), caller falls back to the
 *     GDrive upload path, whose dual-write hook re-attempts the PG mirror;
 *   - delete-primary: PG failure → false (reported); the caller MUST surface
 *     it — deleting the GDrive copy first would strand the bytea payload.
 */

import { createHash } from 'crypto';
import type { AttachmentMetadata } from '../roosync/AttachmentManager.js';
import type { RooSyncAttachmentMetadataRow } from './types.js';
import type { IUnifiedStoreReader } from './UnifiedStoreReader.js';
import { isChannelPgPrimary } from './roosync-channel-write.js';
import { getUnifiedStoreWriter } from './writer-factory.js';
import { getUnifiedStoreReader } from './reader-factory.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('roosync-attachment-pg');

/** True when attachment uploads persist PG-first and skip the GDrive files. */
export function isAttachmentPgPrimary(): boolean {
  return isChannelPgPrimary();
}

/**
 * Returns the reader when the attachment read gate is on, else null — the
 * same cascade as `getChannelPgReader` (Phase B), applied to attachments.
 */
export function getAttachmentPgReader(): IUnifiedStoreReader | null {
  if (
    process.env.UNIFIED_STORE_CHANNEL_READ_PG !== '1'
    && process.env.UNIFIED_STORE_CHANNEL_PG_PRIMARY !== '1'
  ) return null;
  if (!process.env.UNIFIED_STORE_PG_URL) return null;
  const reader = getUnifiedStoreReader();
  if (reader.isNull()) return null;
  return reader;
}

/** Map a metadata row to `AttachmentMetadata`, or null under the parity rule. */
function mapRowToMetadata(row: RooSyncAttachmentMetadataRow): AttachmentMetadata | null {
  if (row.uploaderMachine === null) return null;
  const meta: AttachmentMetadata = {
    uuid: row.id,
    originalName: row.filename,
    mimeType: row.mime ?? 'application/octet-stream',
    sizeBytes: row.size,
    uploadedAt: row.uploadedAt,
    uploaderMachineId: row.uploaderMachine,
  };
  if (row.uploaderWorkspace !== null) meta.uploaderWorkspace = row.uploaderWorkspace;
  if (row.messageId !== null) meta.messageId = row.messageId;
  return meta;
}

/** Parameters of a PG-primary attachment insert (§7.5.2). */
export interface AttachmentPrimaryInsert {
  uuid: string;
  content: Buffer;
  filename: string;
  mime: string;
  uploaderMachineId: string;
  uploaderWorkspace?: string;
  messageId?: string;
  uploadedAt: string;
}

/**
 * PG-primary insert of an attachment payload + metadata.
 *
 * @returns true when the row was persisted — the caller MUST then skip the
 *   GDrive file writes. false on any PG failure — the caller falls back to
 *   the GDrive upload path (which re-attempts the PG mirror via dual-write).
 */
export async function insertRooSyncAttachmentPrimary(params: AttachmentPrimaryInsert): Promise<boolean> {
  try {
    await getUnifiedStoreWriter().insertRooSyncAttachment({
      id: params.uuid,
      filename: params.filename,
      mime: params.mime,
      size: params.content.length,
      sha256: createHash('sha256').update(params.content).digest('hex'),
      payload: params.content,
      uploaderMachine: params.uploaderMachineId,
      uploaderWorkspace: params.uploaderWorkspace,
      messageId: params.messageId,
      uploadedAt: params.uploadedAt,
    });
    return true;
  } catch (error) {
    logger.warn('[attachment-pg] PG-primary insert failed — falling back to GDrive upload', {
      uuid: params.uuid,
      error: String(error),
    });
    return false;
  }
}

/**
 * PG-first metadata lookup by uuid. Null when the gate is off, the row is
 * absent, the row predates migration 007 (parity rule), or PG errored —
 * the caller falls back to the GDrive metadata.json.
 */
export async function readAttachmentMetadataFromPg(uuid: string): Promise<AttachmentMetadata | null> {
  const reader = getAttachmentPgReader();
  if (!reader) return null;
  try {
    const row = await reader.getRooSyncAttachmentById(uuid);
    if (!row) return null;
    return mapRowToMetadata(row);
  } catch (error) {
    logger.warn('[attachment-pg] PG metadata read failed — falling back to GDrive', {
      uuid,
      error: String(error),
    });
    return null;
  }
}

/**
 * PG-first fetch of metadata + payload by uuid (getAttachment / readAttachment
 * backing). Same null contract as `readAttachmentMetadataFromPg`.
 */
export async function readAttachmentFromPg(
  uuid: string
): Promise<{ content: Buffer; meta: AttachmentMetadata } | null> {
  const reader = getAttachmentPgReader();
  if (!reader) return null;
  try {
    const row = await reader.getRooSyncAttachmentById(uuid);
    if (!row) return null;
    const meta = mapRowToMetadata(row);
    if (!meta) return null;
    return { content: row.payload, meta };
  } catch (error) {
    logger.warn('[attachment-pg] PG attachment read failed — falling back to GDrive', {
      uuid,
      error: String(error),
    });
    return null;
  }
}

/**
 * PG-first batch metadata for `listAttachmentsByRefs` (#3256). Returns null
 * when the gate is off or PG errored (the caller serves everything from
 * GDrive); otherwise a Map holding ONLY the uuids PG can serve completely —
 * legacy rows under the parity rule are absent from it and the caller
 * resolves them per-uuid from the GDrive metadata.json.
 */
export async function listAttachmentMetadataFromPg(
  uuids: string[]
): Promise<Map<string, AttachmentMetadata> | null> {
  const reader = getAttachmentPgReader();
  if (!reader) return null;
  try {
    const rows = await reader.listRooSyncAttachmentMetadata(uuids);
    const map = new Map<string, AttachmentMetadata>();
    for (const row of rows) {
      const meta = mapRowToMetadata(row);
      if (meta) map.set(row.id, meta);
    }
    return map;
  } catch (error) {
    logger.warn('[attachment-pg] PG metadata batch failed — falling back to GDrive', {
      count: uuids.length,
      error: String(error),
    });
    return null;
  }
}

/**
 * PG scan for `listAttachments` — gated on the WRITE-primary flag alone: a
 * READ_PG-only machine still writes GDrive, so its full-scan view stays
 * GDrive (consistent with what it writes); a PG-primary machine's own uploads
 * never land on GDrive, so only PG can enumerate them.
 *
 * Precondition (documented, same as Phase B): the attachments backfill has
 * populated legacy rows. Rows still under the parity rule are dropped from
 * the result with a warn — serving them degraded would under-report the
 * uploader on surfaces that print it.
 *
 * Returns null when the gate is off or PG errored — the caller falls back to
 * the GDrive scan (graceful degradation).
 */
export async function scanAttachmentMetadataFromPg(
  messageId?: string
): Promise<AttachmentMetadata[] | null> {
  if (!isAttachmentPgPrimary()) return null;
  const reader = getAttachmentPgReader();
  if (!reader) return null;
  try {
    const rows = await reader.scanRooSyncAttachments(messageId);
    const out: AttachmentMetadata[] = [];
    let dropped = 0;
    for (const row of rows) {
      const meta = mapRowToMetadata(row);
      if (meta) out.push(meta);
      else dropped++;
    }
    if (dropped > 0) {
      logger.warn('[attachment-pg] scan dropped legacy rows without uploader metadata (run the attachments backfill)', {
        dropped,
        messageId: messageId ?? null,
      });
    }
    return out;
  } catch (error) {
    logger.warn('[attachment-pg] PG scan failed — falling back to GDrive scan', {
      messageId: messageId ?? null,
      error: String(error),
    });
    return null;
  }
}

/**
 * PG-primary delete: purge the bytea row, idempotently.
 *
 * @returns true when PG confirmed the deletion (or the row was already
 *   absent) — the caller may then remove the legacy GDrive copy. false on PG
 *   failure — the caller MUST surface it and NOT touch the GDrive copy:
 *   deleting GDrive first would strand the payload one layer down.
 */
export async function deleteRooSyncAttachmentPrimary(uuid: string): Promise<boolean> {
  try {
    await getUnifiedStoreWriter().deleteRooSyncAttachment(uuid);
    return true;
  } catch (error) {
    logger.warn('[attachment-pg] PG-primary delete failed — GDrive copy left in place', {
      uuid,
      error: String(error),
    });
    return false;
  }
}

/**
 * Best-effort PG purge for GDrive-primary machines: returns the number of PG
 * rows deleted (0 = nothing in PG), or null when PG errored — the caller
 * decides whether "absent" or "unknown" is the honest answer for its path.
 */
export async function deleteRooSyncAttachmentIfPresent(uuid: string): Promise<number | null> {
  try {
    return await getUnifiedStoreWriter().deleteRooSyncAttachment(uuid);
  } catch (error) {
    logger.warn('[attachment-pg] PG purge failed (best-effort)', { uuid, error: String(error) });
    return null;
  }
}
