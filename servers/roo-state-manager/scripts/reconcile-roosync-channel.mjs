#!/usr/bin/env node
/**
 * #3151 Phase B arming prerequisite — reconcile `roosync_messages` lifecycle
 * status against the GDrive inbox pool membership (see
 * src/services/unified-store/channel-reconcile.ts for the WHY).
 *
 * One-time (re-runnable) pass run BEFORE arming UNIFIED_STORE_CHANNEL_READ_PG
 * on a machine — and once fleet-wide before the flag spreads. Marks PG rows
 * `status='archived'` when their file is absent from the shared inbox pool
 * and they are older than the grace window.
 *
 * Safety:
 *   - DRY-RUN by default: reports + writes a manifest, updates NOTHING.
 *   - --apply additionally requires UNIFIED_STORE_DUAL_WRITE=1 and
 *     UNIFIED_STORE_PG_URL set (same gate as the backfill scripts).
 *   - A manifest of every affected id (with status_before) is ALWAYS written —
 *     the pass is reversible by replaying the manifest.
 *   - Grace window (default 48 h) protects in-flight archive moves and
 *     DriveFS propagation: recent rows are never touched.
 *
 * Usage (from servers/roo-state-manager/):
 *   npm run build
 *   node scripts/reconcile-roosync-channel.mjs                     # dry-run
 *   node scripts/reconcile-roosync-channel.mjs --apply             # live
 *   node scripts/reconcile-roosync-channel.mjs --grace-hours 72
 *
 * The .env at servers/roo-state-manager/.env is auto-loaded.
 */

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

// --- args ---
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(`Usage: node scripts/reconcile-roosync-channel.mjs [--apply] [--dry-run] [--grace-hours N] [--manifest-dir DIR] [--env-file PATH] [--limit N]

  (default)          Dry run: report + manifest, no UPDATE.
  --apply            Live pass (requires UNIFIED_STORE_DUAL_WRITE=1 + UNIFIED_STORE_PG_URL).
  --grace-hours N    Rows newer than N hours are never touched (default 48).
  --manifest-dir DIR Where the manifest is written (default: script dir).
  --env-file PATH    .env to load (default: servers/roo-state-manager/.env — pass another checkout's .env when running from a worktree).
  --limit N          Cap candidate rows for a trial pass.`);
  process.exit(0);
}
const APPLY = args.includes('--apply');
const graceIdx = args.indexOf('--grace-hours');
const graceHours = graceIdx !== -1 ? Number(args[graceIdx + 1]) : 48;
if (!Number.isFinite(graceHours) || graceHours < 0) {
  console.error(`ABORT: --grace-hours must be a non-negative number (got: ${args[graceIdx + 1]}).`);
  process.exit(1);
}
const limitIdx = args.indexOf('--limit');
const LIMIT = limitIdx !== -1 ? Number(args[limitIdx + 1]) : undefined;
const manifestDirIdx = args.indexOf('--manifest-dir');
const manifestDir = manifestDirIdx !== -1 ? args[manifestDirIdx + 1] : __dirname;
const envFileIdx = args.indexOf('--env-file');
const envFile = envFileIdx !== -1 ? args[envFileIdx + 1] : path.join(__dirname, '..', '.env');

loadEnv(envFile);

const PG_URL = process.env.UNIFIED_STORE_PG_URL;
if (!PG_URL) {
  console.error('ABORT: UNIFIED_STORE_PG_URL is not set — reconcile needs read access to the mirror (add it to .env).');
  process.exit(1);
}
if (APPLY && process.env.UNIFIED_STORE_DUAL_WRITE !== '1') {
  console.error('ABORT: --apply requires UNIFIED_STORE_DUAL_WRITE=1 (same gate as the backfill scripts). Re-run without --apply for a dry run.');
  process.exit(1);
}
const SHARED = process.env.ROOSYNC_SHARED_PATH;
if (!SHARED) {
  console.error('ABORT: ROOSYNC_SHARED_PATH is not set (shared-state root).');
  process.exit(1);
}

// --- import repo logic from the build dir ---
const { resolveBuildDir } = await import(pathToFileURL(path.join(__dirname, 'lib', 'resolve-build-dir.mjs')).href);
const buildDir = resolveBuildDir(path.join(__dirname, '..'));
const { buildLiveIdSet, computeReconcileResult, batchIds } = await import(
  pathToFileURL(path.join(buildDir, 'services', 'unified-store', 'channel-reconcile.js')).href
);
const { Client } = await import('pg');

const inboxDir = path.join(SHARED, 'messages', 'inbox');
const poolFiles = readdirSync(inboxDir).filter(f => f.endsWith('.json'));
const liveIds = buildLiveIdSet(poolFiles);
console.log(`pool: ${liveIds.size} live ids from ${poolFiles.length} files in ${inboxDir}`);

const client = new Client({ connectionString: PG_URL });
await client.connect();
const limitClause = LIMIT ? `LIMIT ${Number(LIMIT)}` : '';
const { rows } = await client.query(
  `SELECT id, status, created_at::text AS created_at FROM roosync_messages
   WHERE status IN ('unread','read') AND destroyed_at IS NULL
   ORDER BY created_at ASC ${limitClause}`
);
console.log(`candidates: ${rows.length} rows (status unread|read, not destroyed)`);

const kind = APPLY ? 'apply' : 'dry-run';
const result = computeReconcileResult(rows, liveIds, Date.now() - graceHours * 3600 * 1000, kind, graceHours);
console.log(`ghosts: ${result.ghosts.length} | kept: ${result.kept.live} live + ${result.kept.withinGrace} within grace (${graceHours}h)`);

const manifestPath = path.join(manifestDir, `reconcile-channel-manifest-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(manifestPath, JSON.stringify(result.manifest, null, 2));
console.log(`manifest: ${manifestPath} (${result.ghosts.length} entries, statuses before update)`);

if (!APPLY) {
  console.log('DRY RUN — nothing updated. Re-run with --apply (and UNIFIED_STORE_DUAL_WRITE=1) to persist.');
  await client.end();
  process.exit(0);
}

let updated = 0;
for (const batch of batchIds(result.ghosts.map(g => g.id))) {
  const res = await client.query(
    `UPDATE roosync_messages
     SET status = 'archived', archived_at = COALESCE(archived_at, now())
     WHERE id = ANY($1::text[]) AND status IN ('unread','read') AND destroyed_at IS NULL`,
    [batch]
  );
  updated += res.rowCount ?? 0;
}
console.log(`apply: ${updated} rows marked archived (re-guarded WHERE — in-flight state changes were skipped).`);
await client.end();
