/**
 * Pure read-state merge logic for the G-R backfill (#4131) — extracted from
 * backfill-roosync-read-state.mjs so it is unit-testable (review ms#1410:
 * "500 lignes qui écriront dans la base de toute la flotte n'ont aucun test").
 * Tests: src/services/unified-store/__tests__/backfill-read-state.test.ts.
 *
 * SEMANTICS (fixed by the ms#1410 review — the read dual-write is ALIVE):
 * MessageManager.ts calls dualWriteRooSyncMessageRead* on every mark_read,
 * fire-and-forget, into PgUnifiedStoreWriter.updateRooSyncMessage. B9 rows
 * are lost mirror writes, not an absent path. Therefore apply must never
 * write a value computed at T0 over a row a dual-write touched since:
 *   - arrays merge by UNION against the CURRENT row (the script expresses
 *     this in SQL — these functions mirror that SQL exactly);
 *   - `status` promotes unread -> read only, and never demotes: a PG row
 *     already 'read' while the file says 'unread' is a stale-file ANOMALY,
 *     reported, never "fixed" by apply (PG-ahead is not ours to undo);
 *   - 'archived' is TERMINAL (types.ts:92 — the only other status): a row
 *     archived before T0, or by a concurrent writer at T1, keeps 'archived'.
 *     It is never normalized to 'unread' — that normalization is exactly how
 *     an archived row got promoted back to 'read' (ms#1410 2nd review);
 *   - divergent = apply would change the row = array additions OR a status
 *     promotion. pgAheadOfFile rows are NOT divergent (apply leaves them).
 */

export const READ = 'read';

const asArray = (v) => (Array.isArray(v) ? v : []);
/** Verbatim status: 'unread' | 'read' | 'archived' (types.ts:92). Only a
 * missing/invalid value falls back to 'unread' — 'archived' is PRESERVED,
 * never normalized away (ms#1410 2nd review). */
const asStatus = (v) => (typeof v === 'string' && v.length > 0 ? v : 'unread');

/**
 * Decision for ONE message row (dry-run diff basis).
 * @param {{status?: string, read_by?: string[], read_by_workspace?: string[]}} fileRow GDrive file values
 * @param {{status?: string, read_by?: string[], read_by_workspace?: string[]}} pgRow PG values (as measured)
 */
export function rowDecision(fileRow, pgRow) {
  const fileReadBy = asArray(fileRow?.read_by);
  const fileRbw = asArray(fileRow?.read_by_workspace);
  const pgReadBy = asArray(pgRow?.read_by);
  const pgRbw = asArray(pgRow?.read_by_workspace);

  const readByAdded = fileReadBy.filter((x) => !pgReadBy.includes(x));
  const rbwAdded = fileRbw.filter((x) => !pgRbw.includes(x));
  const readByPgOnly = pgReadBy.filter((x) => !fileReadBy.includes(x));
  const rbwPgOnly = pgRbw.filter((x) => !fileRbw.includes(x));

  const fileStatus = asStatus(fileRow?.status);
  const pgStatus = asStatus(pgRow?.status);
  // Promotion requires the CURRENT PG status to be 'unread' (ms#1410 2nd
  // review): 'archived' is terminal — the archive outranks a T0 file read,
  // whether it landed before T0 or between the measure and the UPDATE.
  const promote = fileStatus === READ && pgStatus === 'unread';
  const pgAheadOfFile = fileStatus !== READ && pgStatus === READ;

  const divergent = readByAdded.length > 0 || rbwAdded.length > 0 || promote;

  return {
    divergent,
    pgAheadOfFile,
    delta: {
      read_by_added: readByAdded,
      read_by_pg_only_kept: readByPgOnly,
      read_by_workspace_added: rbwAdded,
      read_by_workspace_pg_only_kept: rbwPgOnly,
      status_promotion: promote || null,
    },
  };
}

/**
 * What the APPLY UPDATE writes for a row. The script's SQL unions IN the
 * statement (`read_by || $file`, CASE promotion) against the CURRENT row, so
 * a dual-write racing between the T0 measure and the UPDATE is never lost.
 * This function is that SQL, expressed in JS — the idempotence and restore
 * tests simulate passes through it and must stay in lockstep with the UPDATE
 * in backfill-roosync-read-state.mjs.
 */
export function applyToPgRow(pgRow, fileRow) {
  const mergedReadBy = [...new Set([...asArray(pgRow?.read_by), ...asArray(fileRow?.read_by)])];
  const mergedRbw = [...new Set([...asArray(pgRow?.read_by_workspace), ...asArray(fileRow?.read_by_workspace)])];
  const pgStatus = asStatus(pgRow?.status);
  // Mirror of the SQL CASE: promote ONLY unread -> read; every other current
  // status (including the terminal 'archived') is kept verbatim.
  const status = pgStatus === 'unread' && asStatus(fileRow?.status) === READ ? READ : pgStatus;
  return { status, read_by: mergedReadBy, read_by_workspace: mergedRbw };
}

/** Pre-image row: the exact PG values saved before apply (the restore target). */
export function preimageRow(id, pgRow) {
  return {
    id,
    status: asStatus(pgRow?.status),
    read_by: [...asArray(pgRow?.read_by)],
    read_by_workspace: [...asArray(pgRow?.read_by_workspace)],
  };
}

/** What --restore writes for a row: the saved pre-image values, verbatim. */
export function restoreToPgRow(savedRow) {
  return {
    status: asStatus(savedRow?.status),
    read_by: [...asArray(savedRow?.read_by)],
    read_by_workspace: [...asArray(savedRow?.read_by_workspace)],
  };
}
