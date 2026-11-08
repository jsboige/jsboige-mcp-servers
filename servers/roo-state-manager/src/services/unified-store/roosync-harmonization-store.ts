/**
 * PG persistence for the RooSync harmonization campaign store (#3544).
 *
 * @module services/unified-store/roosync-harmonization-store
 * @issue #3544 — implementation of ai-01's decision (issue comment
 *        6710974383): **PG is the authority, G: is the fallback mirror.**
 *
 * WHY — until 07/11 the campaign store lived only as files under
 * `<shared-state>/harmonization/`, and the mount divergence proved why that is
 * not enough: web2 reads the ORIGINAL 2025 tree and saw the campaigns, the
 * other five measured seats read the 28/10 tree and saw none. The "8/8
 * confirmed, 0 drift" proof of `hc-claude-settings-2026.10.25-1` was therefore
 * readable from one seat only. A store nobody else can read proves nothing,
 * and GDrive is the measured SPOF of the fabric (#4131).
 *
 * CONTRACT
 *
 *   - WRITE — the organ (`roosync_harmonization`) writes PG FIRST, then the
 *     GDrive file as a bounded best-effort write-through. A PG failure never
 *     suppresses the file write: the file is what keeps a seat without a PG
 *     channel working, and it is the documented fallback of the decision.
 *   - READ — PG first, file second, behind a gate resolved on DATA
 *     (`pg-read-gates.ts`): the default turns on only after the backfill
 *     wrote `harmonization_backfill_complete_at` (migrations/012 table,
 *     written by `scripts/backfill-harmonization.mjs`). An un-imported store
 *     must present as "not found" so the caller falls back to the file —
 *     never as "no campaign" (the under-show failure the dashboard channel
 *     had to close for the same reason, review ms#1540).
 *   - OWNER — no lane writes these tables directly. Confirmations come only
 *     from a LIVE `confirm` re-read; a claimed hash never reaches PG.
 *
 * The record is round-tripped as JSONB in `payload`, so the bookkeeping the
 * organ owns (dispatches, reminders) can grow without a schema bump, and a PG
 * read reconstructs exactly what a file read would have returned.
 */

import type {
  CampaignConfirmedObservation,
  HarmonizationCampaignRecord,
} from '../HarmonizationCampaignService.js';
import type { IUnifiedStoreReader } from './UnifiedStoreReader.js';
import type { UnifiedStoreWriteOutcome } from './UnifiedStoreWriter.js';
import type { HarmonizationCampaignRow, HarmonizationConfirmationRow } from './types.js';
import { getUnifiedStoreReader } from './reader-factory.js';
import { getUnifiedStoreWriter } from './writer-factory.js';
import { isPgFlagOn } from './pg-flags.js';
import { isHarmonizationPgPrimaryEnabled, isHarmonizationReadPgEnabled } from './pg-read-gates.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('roosync-harmonization-store');

/**
 * Returns the store reader when the harmonization read gate is on, else null.
 *
 * Read at CALL time (never import time), like every other gate in this
 * directory: tests and config reloads toggle it without a process restart.
 */
export function getHarmonizationPgReader(): IUnifiedStoreReader | null {
  if (!isHarmonizationReadPgEnabled()) return null;
  if (!process.env.UNIFIED_STORE_PG_URL) return null;
  const reader = getUnifiedStoreReader();
  if (reader.isNull()) return null;
  return reader;
}

/**
 * True when PG is the write authority for the campaign store.
 *
 * Mirrors `isDashboardPgPrimary()` exactly, including the Null-writer guard:
 * `UNIFIED_STORE_DUAL_WRITE` is required because writer-factory only builds a
 * real PgUnifiedStoreWriter under that flag — without it the writer is the
 * Null writer whose methods are silent no-ops, and a primary gate over it
 * would report success while nothing landed (review #1030).
 */
export function isHarmonizationPgPrimary(): boolean {
  return isHarmonizationPgPrimaryEnabled()
    && isPgFlagOn('UNIFIED_STORE_DUAL_WRITE')
    && !!process.env.UNIFIED_STORE_PG_URL;
}

/** Map the organ's campaign record to a `harmonization_campaigns` row. */
export function mapCampaignToRow(record: HarmonizationCampaignRecord): HarmonizationCampaignRow {
  return {
    campaign_id: record.id,
    target_file: record.targetFile,
    canon_version: record.canon.version,
    canon_hash: record.canon.hash,
    canon_mode: record.canon.mode,
    status: record.status,
    rev: record.rev,
    created_by: record.createdBy,
    created_at: record.createdAt,
    closed_at: record.closedAt ?? null,
    close_reason: record.closeReason ?? null,
    fleet: record.fleet,
    exceptions: record.exceptions ?? {},
    payload: record as unknown as Record<string, unknown>,
  };
}

/**
 * Map a row back to the record the organ persists.
 *
 * `payload` is authoritative when present (it IS the record); the typed
 * columns are the fallback for a row written by a future writer that omitted
 * the payload, so a read never yields a half-record.
 */
export function mapRowToCampaign(row: HarmonizationCampaignRow): HarmonizationCampaignRecord {
  const payload = row.payload as Partial<HarmonizationCampaignRecord> | undefined;
  if (payload && typeof payload === 'object' && payload.id === row.campaign_id && payload.canon) {
    const record = payload as HarmonizationCampaignRecord;
    if (typeof record.rev !== 'number') record.rev = row.rev;
    return record;
  }
  return {
    id: row.campaign_id,
    targetFile: row.target_file as HarmonizationCampaignRecord['targetFile'],
    createdAt: row.created_at,
    createdBy: row.created_by,
    canon: {
      version: row.canon_version,
      mode: row.canon_mode as HarmonizationCampaignRecord['canon']['mode'],
      keys: {},
      hash: row.canon_hash,
    },
    fleet: row.fleet,
    exceptions: row.exceptions,
    dispatches: {},
    reminders: {},
    status: row.status,
    ...(row.closed_at ? { closedAt: row.closed_at } : {}),
    ...(row.close_reason ? { closeReason: row.close_reason } : {}),
    rev: row.rev,
  };
}

/** One campaign from PG, or null on miss / gate off / PG failure. */
export async function readCampaignFromPg(id: string): Promise<HarmonizationCampaignRecord | null> {
  const reader = getHarmonizationPgReader();
  if (!reader) return null;
  try {
    const result = await reader.getHarmonizationCampaign(id);
    if (!result) return null;
    return mapRowToCampaign(result.campaign);
  } catch (error) {
    logger.warn('[harmonization-pg] campaign read failed — caller falls back to the file', {
      id,
      error: String(error),
    });
    return null;
  }
}

/** Every campaign from PG; null when the gate is off or PG failed (fall back to files). */
export async function listCampaignsFromPg(
  includeClosed: boolean
): Promise<HarmonizationCampaignRecord[] | null> {
  const reader = getHarmonizationPgReader();
  if (!reader) return null;
  try {
    const rows = await reader.listHarmonizationCampaigns(includeClosed);
    return rows.map(mapRowToCampaign);
  } catch (error) {
    logger.warn('[harmonization-pg] campaign list failed — caller falls back to the files', {
      error: String(error),
    });
    return null;
  }
}

/**
 * Confirmations of one campaign (optionally one machine) as organ events.
 *
 * They are returned in the SAME shape as the file journal's `kind: 'confirm'`
 * entries so the caller merges the two sources without a second code path.
 * Returns null when the gate is off or PG failed — an empty array would be
 * read as "no confirmation", which is exactly the under-show this store
 * exists to prevent.
 */
export async function readConfirmationsFromPg(
  campaignId: string,
  machineId?: string
): Promise<CampaignConfirmedObservation[] | null> {
  const reader = getHarmonizationPgReader();
  if (!reader) return null;
  try {
    const result = await reader.getHarmonizationCampaign(campaignId);
    if (!result) return null;
    return result.confirmations
      .filter(c => machineId === undefined || c.machine_id === machineId)
      .map(c => ({
        kind: 'confirm' as const,
        machine: c.machine_id,
        at: c.confirmed_at,
        canonHash: c.canon_hash,
        observedHash: c.observed_hash,
        source: 'live-read' as const,
        eventId: c.event_id,
      }));
  } catch (error) {
    logger.warn('[harmonization-pg] confirmation read failed — caller falls back to the file', {
      campaignId,
      error: String(error),
    });
    return null;
  }
}

/**
 * Map one organ confirmation event to a `harmonization_confirmations` row.
 *
 * `workspace` is optional and nullable: the event journal is keyed by MACHINE
 * (`events/<machine>/<eventId>.json`), so the workspace is not part of the
 * proof and is left empty by the organ. The column exists for a future
 * per-workspace campaign without a schema change.
 */
export function mapConfirmationToRow(
  campaignId: string,
  observation: CampaignConfirmedObservation,
  workspace?: string | null
): HarmonizationConfirmationRow {
  return {
    campaign_id: campaignId,
    machine_id: observation.machine,
    workspace: workspace ?? null,
    confirmed_at: observation.at,
    canon_hash: observation.canonHash,
    observed_hash: observation.observedHash,
    source: 'live-read',
    event_id: observation.eventId,
  };
}

/**
 * Write one campaign to PG (the authority half of the #3544 contract).
 *
 * Never throws: the outcome is returned so the caller can record the truth in
 * its own result — the GDrive write-through happens regardless, because a
 * mirror that stays empty is worse than a mirror that lags.
 *
 * `backfill` switches to INSERT ... DO NOTHING so replaying historical files
 * can never roll back a campaign the organ has advanced since.
 */
export async function writeCampaignToPg(
  record: HarmonizationCampaignRecord,
  opts?: { backfill?: boolean }
): Promise<UnifiedStoreWriteOutcome> {
  if (!isHarmonizationPgPrimary() && opts?.backfill !== true) {
    return { ok: false, reason: 'disabled' };
  }
  try {
    const writer = getUnifiedStoreWriter();
    return await writer.syncHarmonizationCampaign(mapCampaignToRow(record), opts);
  } catch (error) {
    return { ok: false, reason: 'exhausted', detail: String(error) };
  }
}

/**
 * Append one LIVE confirmation to PG.
 *
 * Idempotent on `(campaign_id, event_id)`. Never throws — same rationale as
 * the campaign write: the caller has already re-read the seat's file, and a
 * PG hiccup must not turn a real confirmation into a failure of the action.
 */
export async function writeConfirmationToPg(
  campaignId: string,
  observation: CampaignConfirmedObservation,
  opts?: { workspace?: string | null }
): Promise<UnifiedStoreWriteOutcome> {
  if (!isHarmonizationPgPrimary()) return { ok: false, reason: 'disabled' };
  const row = mapConfirmationToRow(campaignId, observation, opts?.workspace);
  try {
    const writer = getUnifiedStoreWriter();
    return await writer.appendHarmonizationConfirmation(row);
  } catch (error) {
    return { ok: false, reason: 'exhausted', detail: String(error) };
  }
}

/**
 * Backfill one campaign from the file tree (#3544, scripts/backfill-harmonization.mjs).
 *
 * Uses `{ backfill: true }` — INSERT ... DO NOTHING — so replaying a historical
 * file can never roll back a campaign the organ has advanced since, and it
 * bypasses the primary gate on purpose: the backfill runs BEFORE the read gate
 * opens (that is what the marker it writes is for). In dry-run the writer is
 * the Null writer, so the same call persists nothing and the script's verdict
 * says so.
 */
export async function backfillCampaignToStore(
  record: HarmonizationCampaignRecord
): Promise<UnifiedStoreWriteOutcome> {
  try {
    const writer = getUnifiedStoreWriter();
    return await writer.syncHarmonizationCampaign(mapCampaignToRow(record), { backfill: true });
  } catch (error) {
    return { ok: false, reason: 'exhausted', detail: String(error) };
  }
}

/**
 * Backfill one confirmation event from the file journal (#3544).
 *
 * Same rationale as the campaign above: INSERT-only, gate bypassed, idempotent
 * on `(campaign_id, event_id)`. Only `kind: 'confirm'` events are imported —
 * a failure is a seat's local history and nothing the fleet reads.
 */
export async function backfillConfirmationToStore(
  campaignId: string,
  observation: CampaignConfirmedObservation
): Promise<UnifiedStoreWriteOutcome> {
  try {
    const writer = getUnifiedStoreWriter();
    return await writer.appendHarmonizationConfirmation(
      mapConfirmationToRow(campaignId, observation)
    );
  } catch (error) {
    return { ok: false, reason: 'exhausted', detail: String(error) };
  }
}
