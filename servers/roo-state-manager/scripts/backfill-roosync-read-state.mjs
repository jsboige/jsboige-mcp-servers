#!/usr/bin/env node
/**
 * #4131 grain G-R — Backfill of the channel READ STATE (GDrive files →
 * `roosync_messages`), closing blocage B9.
 *
 * WHY: the channel dual-write INSERTs a message once, at creation
 * (PgUnifiedStoreWriter.insertRooSyncMessage — ON CONFLICT DO NOTHING), and
 * the reconcile is insert-only. mark_read / bulk_mark_read DO mirror reads to
 * PG (MessageManager.ts:1852-1860 → dualWriteRooSyncMessage{,Broadcast,Workspace}
 * Read → PgUnifiedStoreWriter.updateRooSyncMessage) — but fire-and-forget, and
 * those mirror writes are exactly what B9 measured as lost: a seat reading its
 * mailbox from PG (UNIFIED_STORE_CHANNEL_READ_PG=1) re-surfaces every message
 * it already read — 782 rows for ai-01, ~55-100 per executor seat — which is
 * why the 13/10 flag flip waits on this backfill.
 *
 * Because that dual-write is ALIVE, apply never writes a value computed at
 * measure time T0: the UPDATE unions IN SQL against the CURRENT row
 * (read_by / read_by_workspace via `row || $file`, jsonb_agg DISTINCT — review
 * ms#1410 point 1), and `status` only ever PROMOTES unread → read (CASE): a
 * mark_read racing the apply between T0 and the UPDATE survives it. A PG row
 * already 'read' while its file says 'unread' (PG ahead of the file) is
 * reported as an anomaly and left alone — apply never demotes.
 *
 * WHAT: for every message file under messages/inbox (default), diff the three
 * read-state fields against the PG row and, in --apply, merge as above.
 * Arrays merge by UNION (file entries PG lacks are added; PG entries the file
 * lacks are KEPT and reported). Pure merge logic lives in
 * scripts/lib/backfill-read-state-logic.mjs, unit-tested (fusion, idempotence,
 * restore round-trip) in src/services/unified-store/__tests__/
 * backfill-read-state.test.ts — review ms#1410 point 2.
 *
 * Modes:
 *   default                  DRY RUN — PG is read (SELECT only), nothing is
 *                            written anywhere except the optional --diff-out
 *                            JSON. This is the artifact reviewed on #4131
 *                            before any application.
 *   --apply                  UPDATE the divergent rows. Hard-gated: requires
 *                            --accord-rx92 AND --preimage-out <file> AND
 *                            --expect-files <floor> (a cold DriveFS mirror
 *                            understates the inbox and would silently shrink
 *                            the diff — the apply decision must not rest on a
 *                            partial listing). Writes the pre-image BEFORE the
 *                            first UPDATE, all updates in ONE transaction.
 *   --restore <preimage>     Reverse an --apply: verifies the file's sha256,
 *                            snapshots the CURRENT values into
 *                            <preimage>.post.json (the inverse is itself
 *                            reversible), then restores the saved values.
 *
 * The PG URL is never echoed. Exit codes: 0 ok · 1 incomplete (file read
 * errors, or warm-mirror floor tripped) · 2 usage / guard violation.
 *
 * Usage (from servers/roo-state-manager/):
 *   node scripts/backfill-roosync-read-state.mjs --diff-out /tmp/gr-diff.json
 *   node scripts/backfill-roosync-read-state.mjs --apply --accord-rx92 \
 *        --preimage-out /tmp/gr-preimage.json --expect-files 5000
 *   node scripts/backfill-roosync-read-state.mjs --restore /tmp/gr-preimage.json
 *
 * The .env at servers/roo-state-manager/.env is auto-loaded
 * (UNIFIED_STORE_PG_URL, ROOSYNC_SHARED_PATH).
 */

import { resolveBuildDir } from './lib/resolve-build-dir.mjs';
import { rowDecision, applyToPgRow, preimageRow, restoreToPgRow } from './lib/backfill-read-state-logic.mjs';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'fs/promises';

// --- .env loader (zero-dep: only standard KEY=VALUE, comments, quotes) ---
function loadEnv(file) {
  let content;
  try {
    content = readFileSync(file, 'utf-8');
  } catch {
    return false;
  }
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
  return true;
}

// --- arg parsing ---
function usageError(msg) {
  console.error(`ERREUR: ${msg}`);
  console.error('Usage: node scripts/backfill-roosync-read-state.mjs [--diff-out f.json] [--limit N] [--dirs inbox]');
  console.error('                [--expect-files N] [--apply --accord-rx92 --preimage-out f.json] | [--restore f.json]');
  process.exit(2);
}
const args = process.argv.slice(2);
const HELP = args.includes('--help') || args.includes('-h');
const flagValue = (name) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
};
const APPLY = args.includes('--apply');
const RESTORE = APPLY ? undefined : flagValue('--restore');
const ACCORD = args.includes('--accord-rx92');
const DIFF_OUT = flagValue('--diff-out');
const PREIMAGE_OUT = flagValue('--preimage-out');
const LIMIT_RAW = flagValue('--limit');
const LIMIT = LIMIT_RAW !== undefined ? parseInt(LIMIT_RAW, 10) : undefined;
const EXPECT_RAW = flagValue('--expect-files');
const DIRS_RAW = flagValue('--dirs');
const DIRS = DIRS_RAW ? DIRS_RAW.split(',').map((d) => d.trim()).filter(Boolean) : ['inbox'];

if (HELP) {
  console.log(`Usage: node scripts/backfill-roosync-read-state.mjs [options]

  (default)          Dry run: SELECT-only diff of read state (status, read_by,
                     read_by_workspace) between messages/inbox files and PG.
  --diff-out f.json  Write the full per-id diff + summary as JSON.
  --limit N          Stop after N files (smoke test).
  --dirs a,b         Mailbox dirs to read (default: inbox — sent/archive read
                     state is not consulted by the mailbox view).
  --expect-files N   Floor on the inbox file count. Below it, a warm/partial
                     DriveFS mirror is suspected: every metric understates and
                     the run exits 1 (fail closed). MANDATORY with --apply.
  --apply            UPDATE the divergent rows (one transaction, pre-image
                     first, advisory lock). The UPDATE unions IN SQL against
                     the CURRENT row and promotes status unread->read ONLY
                     (the CASE tests the current status: a row already 'read'
                     or terminal-'archived' is left alone) — a racing
                     mark_read dual-write is merged in, never lost.
                     Ends with a control re-read of the touched rows.
                     Requires --accord-rx92 + --preimage-out +
                     --expect-files — the central-PG write is user-gated
                     (decision #4131 c.6050799241, registre RX92 ai-01).
  --restore f.json   Reverse an --apply from its pre-image (hash-verified;
                     writes <f>.post.json first so restore is reversible too).

  --help             Show this help.

Loads .env automatically. The PG URL is never printed.`);
  process.exit(0);
}

if (LIMIT !== undefined && !Number.isFinite(LIMIT)) usageError(`--limit attend un entier, reçu « ${LIMIT_RAW} »`);
if (APPLY && !ACCORD) usageError('--apply exige --accord-rx92 (écriture PG centrale, gate user — décision #4131, registre RX92)');
if (APPLY && !PREIMAGE_OUT) usageError('--apply exige --preimage-out <fichier> (pré-image AVANT la première UPDATE)');
if (APPLY && EXPECT_RAW === undefined) usageError('--apply exige --expect-files <plancher> (un miroir DriveFS froid rétrécit le diff en silence)');
if (RESTORE && args.includes('--restore') && !RESTORE) usageError('--restore exige un chemin de pré-image');
if (!APPLY && !RESTORE && ACCORD) console.error('note: --accord-rx92 sans --apply est sans effet (dry run)');

let expectFiles = null;
if (EXPECT_RAW !== undefined) {
  if (!/^\d+$/.test(EXPECT_RAW)) usageError(`--expect-files attend un entier >= 0, reçu « ${EXPECT_RAW} »`);
  expectFiles = parseInt(EXPECT_RAW, 10);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RSM_ROOT = path.resolve(__dirname, '..'); // servers/roo-state-manager/
const envLoaded = loadEnv(path.join(RSM_ROOT, '.env'));
if (!process.env.UNIFIED_STORE_PG_URL) usageError('UNIFIED_STORE_PG_URL absent (ni env ni .env) — rien à mesurer, fail-closed');
if (!process.env.ROOSYNC_SHARED_PATH) usageError('ROOSYNC_SHARED_PATH absent (ni env ni .env)');

const require2 = createRequire(path.join(RSM_ROOT, 'package.json'));
const pg = require2('pg');

// perReaderStatus from the SERVED build — the KPI must be computed by the very
// function the CHANNEL_READ_PG seat uses (message-helpers.ts is its single
// source, "The SINGLE place that decides it"); a local re-implementation could
// silently diverge from the reader it is meant to fix.
const buildDir = resolveBuildDir(RSM_ROOT);
const { perReaderStatus, isMachineWideTarget } = await import(
  pathToFileURL(path.join(buildDir, 'utils/message-helpers.js')).href
);

console.log('=== RooSync Channel Read-State Backfill (#4131 G-R, blocage B9) ===');
console.log(`Mode: ${RESTORE ? `RESTORE (${path.basename(RESTORE)})` : APPLY ? 'APPLY (LIVE)' : 'DRY RUN (SELECT only)'}`);
console.log(`.env: ${envLoaded ? 'loaded' : 'not found'} (${path.join(RSM_ROOT, '.env')})`);
console.log(`Dirs: ${DIRS.join(', ')}${LIMIT ? ` (limit ${LIMIT})` : ''}`);
console.log(`Code mesuré: ${path.basename(buildDir)}`);
console.log('');

// ── shared-state path (same resolution as the server) ──
const { getSharedStatePath } = await import(
  pathToFileURL(path.join(buildDir, 'utils/shared-state-path.js')).href
);
const messagesRoot = path.join(getSharedStatePath(), 'messages');

const client = new pg.Client({
  connectionString: process.env.UNIFIED_STORE_PG_URL,
  // No ssl option ON PURPOSE: SSL comes from the connection string
  // (sslmode=…), the single source the server itself uses
  // (PgUnifiedStoreWriter.ts passes none either) — script and RSM cannot
  // diverge (review ms#1410 point 3).
  statement_timeout: 60000,
});
await client.connect();

// ── canonical rows hash for pre-image integrity ──
const rowsHash = (rows) => createHash('sha256').update(JSON.stringify(rows)).digest('hex');

// ═══════════════════════════════════════════════════════════════════════════
// RESTORE mode — reverse an --apply, itself reversible.
// ═══════════════════════════════════════════════════════════════════════════
if (RESTORE) {
  let pre;
  try {
    let raw = readFileSync(RESTORE, 'utf-8');
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    pre = JSON.parse(raw);
  } catch (e) {
    console.error(`ERREUR: pré-image illisible: ${e.message}`);
    await client.end();
    process.exit(2);
  }
  if (!Array.isArray(pre.rows) || typeof pre.sha256 !== 'string') {
    console.error('ERREUR: format de pré-image inattendu (rows[] + sha256 requis)');
    await client.end();
    process.exit(2);
  }
  const got = rowsHash(pre.rows);
  if (got !== pre.sha256) {
    console.error(`ERREUR: sha256 de la pré-image incohérent (attendu ${pre.sha256.slice(0, 12)}…, calculé ${got.slice(0, 12)}…) — fichier altéré, refus`);
    await client.end();
    process.exit(2);
  }
  // Inverse pre-image FIRST: what is in PG right now, for the ids we are about
  // to touch. <preimage>.post.json makes the restore itself reversible.
  const ids = pre.rows.map((r) => r.id);
  const { rows: current } = await client.query(
    'SELECT id, status, read_by, read_by_workspace FROM roosync_messages WHERE id = ANY($1) ORDER BY id',
    [ids]
  );
  const postPath = `${RESTORE}.post.json`;
  const postRows = current.map((r) => ({ id: r.id, status: r.status, read_by: r.read_by ?? [], read_by_workspace: r.read_by_workspace ?? [] }));
  writeFileSync(postPath, JSON.stringify({ generatedAt: new Date().toISOString(), kind: 'restore-post-image', rowCount: postRows.length, sha256: rowsHash(postRows), rows: postRows }, null, 2));
  console.log(`pré-image inverse écrite: ${postPath} (${postRows.length}/${ids.length} ids présents en PG)`);

  let restored = 0;
  const missing = ids.length - postRows.length;
  await client.query('BEGIN');
  try {
    for (const r of pre.rows) {
      const back = restoreToPgRow(r);
      await client.query(
        'UPDATE roosync_messages SET status=$2, read_by=$3::jsonb, read_by_workspace=$4::jsonb WHERE id=$1',
        [r.id, back.status, JSON.stringify(back.read_by), JSON.stringify(back.read_by_workspace)]
      );
      restored++;
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`ERREUR: transaction RESTORE annulée: ${e.message}`);
    await client.end();
    process.exit(1);
  }
  await client.end();
  console.log(`RESTORE terminé: ${restored} row(s) restaurées, ${missing} id(s) absents de PG (déjà supprimés — rien à restaurer pour eux).`);
  process.exit(0);
}

// ═══════════════════════════════════════════════════════════════════════════
// MEASURE (dry run / apply share this pass)
// ═══════════════════════════════════════════════════════════════════════════
console.log('Lecture PG (SELECT id, status, read_by, read_by_workspace)…');
const { rows: pgRowsAll } = await client.query(
  'SELECT id, status, read_by, read_by_workspace, to_machine FROM roosync_messages'
);
const pgById = new Map(pgRowsAll.map((r) => [r.id, r]));
console.log(`PG: ${pgRowsAll.length} rows dans roosync_messages`);

const totals = {
  filesSeen: 0, filesRead: 0, skippedNoId: 0, skippedNameMismatch: 0, errors: 0,
  missingInPg: 0,        // file id with no PG row — the insert reconcile's target, NOT ours
  inSync: 0,
  divergent: 0,          // would be UPDATEd by --apply (array additions OR status promotion)
  statusPromotion: 0,    // unread -> read: the ONLY status change apply writes
                         // (never demotes; 'archived' is terminal, untouched)
  pgAheadOfFile: 0,      // PG 'read', file 'unread' — anomaly, reported, never demoted
  readByAdded: 0,        // file read_by entries PG lacks (union adds them)
  readByPgOnly: 0,       // PG entries the file lacks (kept, reported — never dropped)
  readByWsAdded: 0, readByWsPgOnly: 0,
};
// Per-target KPI: what a CHANNEL_READ_PG seat of that machine would see change.
// Keyed by to_machine for machine-wide rows ('(broadcast)' for to=all). This is
// the number the B9 measure reported — it must reconcile with it.
const perTarget = new Map();
const bumpTarget = (key, field) => {
  const t = perTarget.get(key) ?? { rows: 0, divergent: 0, effectiveUnreadFixed: 0 };
  t[field]++;
  perTarget.set(key, t);
};

const failures = [];
const divergentRows = []; // full diff, the --diff-out / review artifact

outer: for (const dir of DIRS) {
  const dirPath = path.join(messagesRoot, dir);
  let files;
  try {
    files = await readdir(dirPath);
  } catch {
    console.log(`(${dir}: no such directory — skipped)`);
    continue;
  }
  const jsonFiles = files.filter((f) => f.endsWith('.json'));
  console.log(`${dir}: ${jsonFiles.length} files`);

  for (const file of jsonFiles) {
    totals.filesSeen++;
    if (LIMIT && totals.filesRead >= LIMIT) break outer;
    let message;
    try {
      let content = await readFile(path.join(dirPath, file), 'utf-8');
      if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
      message = JSON.parse(content);
    } catch (err) {
      totals.errors++;
      failures.push(`${dir}/${file}: ${err?.message ?? String(err)}`);
      continue;
    }
    if (!message || !message.id) { totals.skippedNoId++; continue; }
    if (file !== `${message.id}.json`) { totals.skippedNameMismatch++; continue; } // phantom guard, same as the history backfill
    totals.filesRead++;

    const targetKey = message.to === 'all' || message.to === 'All'
      ? '(broadcast)'
      : (String(message.to ?? '').split(':')[0] || '(inconnu)');
    bumpTarget(targetKey, 'rows');

    const pgRow = pgById.get(message.id);
    if (!pgRow) {
      totals.missingInPg++;
      bumpTarget(targetKey, 'divergent'); // still divergent state overall, but not ours to fix
      continue;
    }

    const fileReadBy = Array.isArray(message.read_by) ? message.read_by : [];
    const fileRbw = Array.isArray(message.read_by_workspace) ? message.read_by_workspace : [];
    const pgReadBy = Array.isArray(pgRow.read_by) ? pgRow.read_by : [];
    const pgRbw = Array.isArray(pgRow.read_by_workspace) ? pgRow.read_by_workspace : [];

    const fileRow = { status: message.status, read_by: fileReadBy, read_by_workspace: fileRbw };
    const decision = rowDecision(fileRow, pgRow);

    // PG-only entries are KEPT on every row, divergent or not — counted first.
    totals.readByPgOnly += decision.delta.read_by_pg_only_kept.length;
    totals.readByWsPgOnly += decision.delta.read_by_workspace_pg_only_kept.length;
    if (decision.pgAheadOfFile) totals.pgAheadOfFile++;
    if (!decision.divergent) { totals.inSync++; continue; }

    // T0 PREVIEW of the merge — the actual UPDATE unions IN SQL against the
    // CURRENT row, so what lands is >= this on arrays (never less) and
    // promotion-only on status. Kept for the diff-out artifact.
    const merged = applyToPgRow(pgRow, fileRow);
    const promote = decision.delta.status_promotion === true;
    const readByAdded = decision.delta.read_by_added.length;
    const readByWsAdded = decision.delta.read_by_workspace_added.length;

    totals.divergent++;
    bumpTarget(targetKey, 'divergent');
    if (promote) totals.statusPromotion++;
    totals.readByAdded += readByAdded;
    totals.readByWsAdded += readByWsAdded;

    // Effective-status KPI via the reader's own predicate (message-helpers is
    // the SINGLE place that decides it — same import as the reader). The row
    // counts when the FILE reads 'read' for a reader the PG row reads
    // 'unread' for. Readers probed: for a broadcast, each machine in
    // fileReadBy; for machine-wide, each workspace in fileRbw; for direct,
    // the global status. The probe reader comes from the FILE's own records —
    // a reader PG could only know via the very arrays it is missing.
    const fileMsg = { to: message.to, status: message.status, read_by: fileReadBy, read_by_workspace: fileRbw };
    const pgMsg = { to: pgRow.to_machine, status: pgRow.status, read_by: pgReadBy, read_by_workspace: pgRbw };
    const isBroadcast = message.to === 'all' || message.to === 'All';
    const isMachineWide = !isBroadcast && isMachineWideTarget(String(message.to ?? ''));
    let effectiveFixed = false;
    if (isBroadcast) {
      for (const m of fileReadBy) {
        if (perReaderStatus(fileMsg, m, undefined) === 'read' && perReaderStatus(pgMsg, m, undefined) === 'unread') { effectiveFixed = true; break; }
      }
    } else if (isMachineWide) {
      // machine-wide: probe each workspace the file records as having read
      for (const full of fileRbw) {
        const ws = String(full).includes(':') ? String(full).split(':').slice(1).join(':') : full;
        if (perReaderStatus(fileMsg, pgRow.to_machine, ws) === 'read' && perReaderStatus(pgMsg, pgRow.to_machine, ws) === 'unread') { effectiveFixed = true; break; }
      }
    } else {
      // direct target (machine:workspace): the global status is the verdict.
      // Strict 'unread': an 'archived' row is terminal, apply never flips it
      // (ms#1410 2nd review) — counting it would over-report the KPI.
      effectiveFixed = message.status === 'read' && pgRow.status === 'unread';
    }
    if (effectiveFixed) bumpTarget(targetKey, 'effectiveUnreadFixed');

    divergentRows.push({
      id: message.id,
      to: message.to ?? null,
      file: { status: message.status ?? null, read_by: fileReadBy, read_by_workspace: fileRbw },
      pg: { status: pgRow.status, read_by: pgReadBy, read_by_workspace: pgRbw },
      // T0 preview: the UPDATE unions against the CURRENT row (>= merged on
      // arrays) and promotes status only — see the WHY header (ms#1410).
      merged,
      delta: {
        status: promote ? `${pgRow.status} -> read (promotion only)` : null,
        read_by_added: readByAdded || null,
        read_by_pg_only_kept: decision.delta.read_by_pg_only_kept.length || null,
        read_by_workspace_added: readByWsAdded || null,
        read_by_workspace_pg_only_kept: decision.delta.read_by_workspace_pg_only_kept.length || null,
      },
    });
  }
}

// Warm-mirror floor: a partial DriveFS listing understates EVERYTHING above —
// missingInPg shrinks (files unseen), divergent shrinks (rows unseen). An apply
// decided on a cold mirror would leave rows behind believing them converged.
if (expectFiles !== null && totals.filesSeen < expectFiles) {
  console.error(`\n⚠️ MIROIR CHAUD/INCOMPLET : ${totals.filesSeen} fichiers vus < plancher --expect-files ${expectFiles}.`);
  console.error('   Le miroir DriveFS local est probablement froid ou partiel — le diff ci-dessus SOUS-ESTIME');
  console.error('   chaque métrique. Ré-hydrater puis re-mesurer avant toute décision.');
  await client.end();
  process.exit(1);
}

console.log('');
console.log('=== Résultat du diff (lecture seule) ===');
console.log(`  fichiers vus:        ${totals.filesSeen} (lus: ${totals.filesRead}, sans id: ${totals.skippedNoId}, nom≠id: ${totals.skippedNameMismatch})`);
const pgMatched = totals.filesRead - totals.missingInPg;
console.log(`  rows PG:             ${pgRowsAll.length} | appariées à un fichier inbox: ${pgMatched} | sans fichier inbox: ${pgRowsAll.length - pgMatched} (archive/sent — hors périmètre read-state)`);
console.log(`  manquantes en PG:    ${totals.missingInPg}  (cible du reconcile INSERT, pas de ce script)`);
console.log(`  convergentes:        ${totals.inSync}`);
console.log(`  DIVERGENTES:         ${totals.divergent}  (${APPLY ? 'seront UPDATE' : 'seraient UPDATE'} par --apply — union IN SQL contre la row COURANTE, promotion unread->read seule)`);
console.log(`    status:            ${totals.statusPromotion} promotion(s) unread->read | ${totals.pgAheadOfFile} row(s) PG-ahead-of-file (anomalie fichier périmé, rapportées, JAMAIS rétrogradées)`);
console.log(`    read_by:           +${totals.readByAdded} entrée(s) ajoutée(s) | ${totals.readByPgOnly} entrée(s) PG-seules conservées`);
console.log(`    read_by_workspace: +${totals.readByWsAdded} entrée(s) ajoutée(s) | ${totals.readByWsPgOnly} entrée(s) PG-seules conservées`);
console.log(`  erreurs de lecture:  ${totals.errors}`);
if (failures.length > 0) {
  console.log('');
  console.log('  fichiers en échec (le diff est INCOMPLET tant qu ils restent):');
  for (const f of failures.slice(0, 50)) console.log(`    - ${f}`);
  if (failures.length > 50) console.log(`    ... et ${failures.length - 50} de plus`);
}

console.log('');
console.log('KPI par destinataire — rows dont le statut EFFECTIF change pour un lecteur du siège (prédicat du reader, message-helpers).');
console.log('  (clé: les broadcasts sont rangés sous "(broadcast)", les machine-wide et direct sous leur machine — même clé que perTarget du --diff-out):');
const targetKeys = [...perTarget.keys()].sort((a, b) => (perTarget.get(b).effectiveUnreadFixed - perTarget.get(a).effectiveUnreadFixed) || a.localeCompare(b));
for (const k of targetKeys) {
  const t = perTarget.get(k);
  if (t.rows === 0 && t.divergent === 0) continue;
  console.log(`  ${k}: rows=${t.rows} divergentes=${t.divergent} dont effective-unread corrigées=${t.effectiveUnreadFixed}`);
}

if (DIFF_OUT) {
  const out = {
    generatedAt: new Date().toISOString(),
    mode: APPLY ? 'apply-planned' : 'dry-run',
    totals,
    perTarget: Object.fromEntries([...perTarget.entries()].map(([k, v]) => [k, v])),
    divergentRows,
  };
  writeFileSync(DIFF_OUT, JSON.stringify(out, null, 2));
  console.log(`\nDiff complet: ${DIFF_OUT} (${divergentRows.length} rows)`);
}

// ═══════════════════════════════════════════════════════════════════════════
// APPLY — pre-image first, single transaction.
// ═══════════════════════════════════════════════════════════════════════════
if (APPLY) {
  if (totals.errors > 0) {
    console.error('\nREFUS d apply: des fichiers sont en échec de lecture — le diff est incomplet. Réparer puis relancer.');
    await client.end();
    process.exit(1);
  }
  if (totals.divergent === 0) {
    console.log('\nRien à appliquer: 0 row divergente.');
    await client.end();
    process.exit(0);
  }
  // Pre-image: the CURRENT PG values of exactly the rows we will touch.
  // Still the T0 snapshot — the right return point (ms#1410): a row raced
  // between T0 and the UPDATE keeps its race-won reads on restore only if the
  // operator chooses to; the pre-image is what we MEASURED and own.
  const preRows = divergentRows.map((d) => preimageRow(d.id, pgById.get(d.id)));
  writeFileSync(PREIMAGE_OUT, JSON.stringify({ generatedAt: new Date().toISOString(), kind: 'apply-pre-image', rowCount: preRows.length, sha256: rowsHash(preRows), rows: preRows }, null, 2));
  console.log(`\npré-image écrite: ${PREIMAGE_OUT} (${preRows.length} rows, sha256 ${rowsHash(preRows).slice(0, 12)}…)`);

  let applied = 0;
  await client.query('BEGIN');
  try {
    // Concurrent-apply guard (ms#1410, welcomed): xact-scoped, released at
    // COMMIT/ROLLBACK — nothing to unlock by hand, nothing left held on crash.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('backfill-roosync-read-state'))");
    for (const d of divergentRows) {
      await client.query(
        // UNION IN SQL against the CURRENT row (ms#1410 point 1): a dual-write
        // landing between the T0 measure and this UPDATE is merged in, never
        // overwritten. Status promotes unread -> read ONLY — the CASE tests the
        // CURRENT status — so it never demotes and never resurrects a terminal
        // 'archived' row, whether the archiving happened before T0 or between
        // the measure and this UPDATE (ms#1410 2nd review). Mirror of
        // scripts/lib/backfill-read-state-logic.mjs applyToPgRow — the unit
        // tests pin both to the same semantics.
        `UPDATE roosync_messages SET
           status = CASE WHEN $2::text = 'read' AND status = 'unread' THEN 'read' ELSE status END,
           read_by = (SELECT coalesce(jsonb_agg(DISTINCT e), '[]'::jsonb) FROM jsonb_array_elements(coalesce(read_by, '[]'::jsonb) || $3::jsonb) AS e),
           read_by_workspace = (SELECT coalesce(jsonb_agg(DISTINCT e), '[]'::jsonb) FROM jsonb_array_elements(coalesce(read_by_workspace, '[]'::jsonb) || $4::jsonb) AS e)
         WHERE id = $1`,
        [d.id, d.file.status ?? 'unread', JSON.stringify(d.file.read_by), JSON.stringify(d.file.read_by_workspace)]
      );
      applied++;
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`ERREUR: transaction APPLY annulée (0 row écrite): ${e.message}`);
    console.error(`La pré-image reste valable: ${PREIMAGE_OUT}`);
    await client.end();
    process.exit(1);
  }
  console.log(`APPLY terminé: ${applied} row(s) mises à jour en une transaction (union contre la row courante + verrou consultatif).`);
  console.log(`Retour arrière: node scripts/backfill-roosync-read-state.mjs --restore ${PREIMAGE_OUT}`);

  // CONTROL RE-RUN (ms#1410 point 1, sortie de procédure): re-read the touched
  // rows NOW and re-decide against the same T0 file data. Expected 0 —
  // anything else is a dual-write that landed after T0 on a file we read
  // before it; the FULL dry run below is the honest artifact either way.
  const { rows: postRows } = await client.query(
    'SELECT id, status, read_by, read_by_workspace FROM roosync_messages WHERE id = ANY($1)',
    [divergentRows.map((d) => d.id)]
  );
  const postById = new Map(postRows.map((r) => [r.id, r]));
  let residual = 0;
  for (const d of divergentRows) {
    const after = postById.get(d.id);
    if (after && rowDecision(d.file, after).divergent) residual++;
  }
  console.log(`Contrôle post-apply: ${residual} row(s) encore divergente(s) parmi les ${applied} touchées (attendu 0).`);
  if (residual > 0) console.log('  -> re-exécuter le dry-run complet: un mark_read a écrit le fichier APRÈS sa lecture T0.');
}

await client.end();
if (APPLY) {
  console.log('\nValidation: re-exécuter en dry-run — divergent doit tomber à ~0 (il peut rester des manquantes-en-PG, c est le reconcile).');
} else {
  console.log('\nDRY RUN complet — 0 row écrite. Le diff ci-dessus est l artefact à reviewer sur #4131 avant tout --apply.');
}
if (totals.errors > 0) {
  console.log(`\nINCOMPLETE — ${totals.errors} fichier(s) illisible(s).`);
  process.exit(1);
}
