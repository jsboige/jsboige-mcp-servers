#!/usr/bin/env node
/**
 * #3151 Phase B — One-time backfill of the RooSync channel history (GDrive
 * files → `roosync_messages`) so the PG-primary read path can be enabled.
 *
 * WHY: the live dual-write (#1001/#1003) only mirrors messages sent AFTER a
 * machine restarted with the flag on. Everything already sitting in the GDrive
 * tree (inbox 3.1 K + archive 18.6 K + sent) never reached PG. A machine that
 * turns on UNIFIED_STORE_CHANNEL_READ_PG before this gap is closed would read
 * an empty mailbox — under-show, the one failure this channel cannot tolerate.
 *
 * Idempotent: INSERT ... ON CONFLICT (id) DO NOTHING — PG rows written by the
 * live dual-write (fresher) are never overwritten by older file state. Safe to
 * re-run after an interruption.
 *
 * Env-gate (delegated to writer-factory):
 *   - UNIFIED_STORE_DUAL_WRITE=1 + UNIFIED_STORE_PG_URL set → LIVE
 *   - otherwise → DRY RUN (NullUnifiedStoreWriter, nothing persisted)
 *
 * Usage (from servers/roo-state-manager/):
 *   npm run build
 *   node scripts/backfill-roosync-channel.mjs --dry-run
 *   node scripts/backfill-roosync-channel.mjs                 # live
 *   node scripts/backfill-roosync-channel.mjs --dirs inbox    # subset
 *
 * The .env at servers/roo-state-manager/.env is auto-loaded.
 */

import { readFileSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

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
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const HELP = args.includes('--help') || args.includes('-h');
const limitIdx = args.indexOf('--limit');
const PARSED_LIMIT = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : undefined;
const LIMIT = Number.isFinite(PARSED_LIMIT) ? PARSED_LIMIT : undefined;
const dirsIdx = args.indexOf('--dirs');
const DIRS = dirsIdx !== -1
  ? (args[dirsIdx + 1] ?? '').split(',').map((d) => d.trim()).filter(Boolean)
  : ['inbox', 'sent', 'archive'];

if (HELP) {
  console.log(`Usage: node scripts/backfill-roosync-channel.mjs [--dry-run] [--limit N] [--dirs inbox,sent,archive] [--help]

  --dry-run          Force NullUnifiedStoreWriter (no rows persisted).
  --limit N          Stop after N messages (smoke test).
  --dirs a,b,c       Which mailbox dirs to read (default: inbox,sent,archive).
  --help             Show this help.

Requires build/ (run "npm run build" first). Loads .env automatically.`);
  process.exit(0);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RSM_ROOT = path.resolve(__dirname, '..'); // servers/roo-state-manager/
const envLoaded = loadEnv(path.join(RSM_ROOT, '.env'));

// Force the env-gate off when --dry-run is explicitly requested.
// MUST run after loadEnv() — loadEnv only sets keys that are ABSENT (#2815).
if (DRY_RUN) {
  delete process.env.UNIFIED_STORE_DUAL_WRITE;
  delete process.env.UNIFIED_STORE_PG_URL;
}

const buildUrl = (rel) => pathToFileURL(path.join(RSM_ROOT, 'build', rel)).href;
const [{ getSharedStatePath }, { mapMessageToRow }, { getUnifiedStoreWriter }] =
  await Promise.all([
    import(buildUrl('utils/shared-state-path.js')),
    import(buildUrl('services/unified-store/roosync-channel-dual-write.js')),
    import(buildUrl('services/unified-store/writer-factory.js')),
  ]);

const writer = getUnifiedStoreWriter();
const writerKind = writer.constructor?.name ?? 'unknown';
const liveMode = writerKind !== 'NullUnifiedStoreWriter';

console.log('=== RooSync Channel Backfill (#3151 Phase B) ===');
console.log(`Mode: ${liveMode ? 'LIVE (PgUnifiedStoreWriter)' : 'DRY RUN (NullUnifiedStoreWriter)'}`);
console.log(`.env: ${envLoaded ? 'loaded' : 'not found'} (${path.join(RSM_ROOT, '.env')})`);
console.log(`Dirs: ${DIRS.join(', ')}`);
if (LIMIT) console.log(`Limit: ${LIMIT} messages`);
console.log('');

const sharedStatePath = getSharedStatePath();
const messagesRoot = path.join(sharedStatePath, 'messages');
const { readdir, readFile } = await import('fs/promises');

let total = 0;
let processed = 0;
let skipped = 0;
let errors = 0;
let applied = 0;
// Which files failed, not just how many. A count alone cannot tell the operator
// whether the store is complete, and "complete" is the precondition for turning
// the read flag on — DriveFS read failures are expected here (4.8 s/file cold,
// inbox/ times out at 120 s on ai-01), so this list is the difference between
// re-running a known subset and re-running 21.8 K files blind.
const failures = [];

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
    total++;
    if (LIMIT && applied >= LIMIT) break outer;
    try {
      let content = await readFile(path.join(dirPath, file), 'utf-8');
      if (content.charCodeAt(0) === 0xfeff) content = content.slice(1); // strip UTF-8 BOM
      const message = JSON.parse(content);
      if (!message || !message.id) {
        skipped++;
        continue;
      }
      // Phantom guard, same rationale as ensureInboxCache: a file whose name
      // does not match its id would import an unreachable row.
      if (file !== `${message.id}.json`) {
        skipped++;
        continue;
      }
      await writer.insertRooSyncMessage(mapMessageToRow(message));
      processed++;
      applied++;
    } catch (err) {
      errors++;
      failures.push(`${dir}/${file}: ${err?.message ?? String(err)}`);
    }
  }
}

console.log('');
console.log('=== Result ===');
console.log(`  total:     ${total}`);
console.log(`  processed: ${processed}`);
console.log(`  skipped:   ${skipped}  (no id / name-id mismatch)`);
console.log(`  errors:    ${errors}`);
if (failures.length > 0) {
  console.log('');
  console.log('  failed files (re-run these before enabling the read flag):');
  for (const f of failures.slice(0, 50)) console.log(`    - ${f}`);
  if (failures.length > 50) console.log(`    ... and ${failures.length - 50} more`);
}
console.log('');
if (!liveMode) {
  console.log('DRY RUN complete — 0 rows persisted (NullUnifiedStoreWriter).');
  console.log('Re-run without --dry-run and UNIFIED_STORE_DUAL_WRITE=1 + UNIFIED_STORE_PG_URL set to persist.');
} else {
  console.log('LIVE backfill complete (ON CONFLICT DO NOTHING — existing PG rows untouched).');
  console.log('Validate: psql -c "SELECT status, count(*) FROM roosync_messages GROUP BY status;"');
  console.log('Only after the store is complete, enable UNIFIED_STORE_CHANNEL_READ_PG=1.');
}

// Exit non-zero on any failure so an incomplete backfill cannot be mistaken for
// a complete one by a caller that only checks the exit code. The store being
// complete is the precondition of the read flag; under-show is the one failure
// this channel cannot tolerate.
if (errors > 0) {
  console.log('');
  console.log(`INCOMPLETE — ${errors} file(s) failed. Do NOT enable UNIFIED_STORE_CHANNEL_READ_PG until they import.`);
  process.exit(1);
}
