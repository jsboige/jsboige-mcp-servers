#!/usr/bin/env node
/**
 * #2581 volet 1 — One-time backfill of the existing skeleton corpus into the
 * unified Postgres store (Epic #2191).
 *
 * WHY: the live dual-write (#692) only fires for conversations indexed AFTER the
 * wiring landed. The read-path that loads the existing on-disk corpus never calls
 * addOrUpdate(), so the unified store stays empty. This script closes that gap by
 * iterating the skeleton cache and feeding each conversation to dualWriteConversationToStore.
 *
 * Env-gate (delegated to writer-factory):
 *   - UNIFIED_STORE_DUAL_WRITE=1 + UNIFIED_STORE_PG_URL set → PgUnifiedStoreWriter (LIVE)
 *   - otherwise → NullUnifiedStoreWriter (DRY RUN — no rows persisted)
 *
 * Idempotent: upsert (ON CONFLICT DO UPDATE) → safe to re-run after interruption.
 *
 * Usage (from servers/roo-state-manager/):
 *   npm run build                              # build/ must exist (script imports it)
 *   node scripts/backfill-unified-store.mjs            # live (needs env gate ON + PG_URL)
 *   node scripts/backfill-unified-store.mjs --dry-run  # force NullUnifiedStoreWriter
 *   node scripts/backfill-unified-store.mjs --limit 10 # stop after N (smoke test)
 *
 * The .env at servers/roo-state-manager/.env is auto-loaded (UNIFIED_STORE_*).
 * Validated SANS DB: --dry-run iterates the corpus, reports counts, writes nothing.
 * The real row delta is confirmed post-run via `SELECT count(*) FROM conversations;`.
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
const LIMIT = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : undefined;

if (HELP) {
  console.log(`Usage: node scripts/backfill-unified-store.mjs [--dry-run] [--limit N] [--help]

  --dry-run   Force NullUnifiedStoreWriter (no rows persisted). Default when the
              env gate is off (UNIFIED_STORE_DUAL_WRITE != 1 or UNIFIED_STORE_PG_URL unset).
  --limit N   Stop after N skeletons (smoke test / partial run).
  --help      Show this help.

Requires build/ (run "npm run build" first). Loads .env automatically.`);
  process.exit(0);
}

// Force the env-gate off when --dry-run is explicitly requested.
if (DRY_RUN) {
  delete process.env.UNIFIED_STORE_DUAL_WRITE;
  delete process.env.UNIFIED_STORE_PG_URL;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RSM_ROOT = path.resolve(__dirname, '..'); // servers/roo-state-manager/
const envLoaded = loadEnv(path.join(RSM_ROOT, '.env'));

// Dynamic imports against the compiled build (its internal bare-specifier imports
// resolve from servers/roo-state-manager/node_modules).
// On Windows, dynamic import() of an absolute path requires a file:// URL.
const buildUrl = (rel) => pathToFileURL(path.join(RSM_ROOT, 'build', rel)).href;
const [{ RooStorageDetector }, { dualWriteConversationToStore }, { getUnifiedStoreWriter }, { runBackfill }] =
  await Promise.all([
    import(buildUrl('utils/roo-storage-detector.js')),
    import(buildUrl('services/unified-store/dual-write.js')),
    import(buildUrl('services/unified-store/writer-factory.js')),
    import(buildUrl('services/unified-store/backfill.js')),
  ]);

const writer = getUnifiedStoreWriter();
const writerKind = writer.constructor?.name ?? 'unknown';
const liveMode = writerKind !== 'NullUnifiedStoreWriter';

console.log('=== Unified Store Backfill (#2581 volet 1) ===');
console.log(`Mode: ${liveMode ? 'LIVE (PgUnifiedStoreWriter)' : 'DRY RUN (NullUnifiedStoreWriter)'}`);
console.log(`.env: ${envLoaded ? 'loaded' : 'not found'} (${path.join(RSM_ROOT, '.env')})`);
console.log(`Writer: ${writerKind}`);
if (LIMIT) console.log(`Limit: ${LIMIT} skeletons`);
console.log('');

if (liveMode && !DRY_RUN) {
  console.log('⚠️  LIVE mode — rows WILL be upserted into the unified Postgres store.');
}

// Read existing skeletons directly from disk (every detected storage location),
// bypassing the SkeletonCacheService singleton to avoid its buildMissingSkeletons
// side-effect (which analyzes conversations and can be slow/unpredictable). The
// backfill only needs skeletons ALREADY materialized on disk.
const { readdir, readFile, stat } = await import('fs/promises');
console.log('Detecting Roo storage locations...');
const storageLocations = await RooStorageDetector.detectStorageLocations();
if (!storageLocations.length) {
  console.error('No Roo storage detected. Nothing to backfill.');
  process.exit(1);
}
console.log(`Storage locations: ${storageLocations.length}`);

const skeletons = [];
let readErrors = 0;
for (const storagePath of storageLocations) {
  const skeletonDir = path.join(storagePath, 'tasks', '.skeletons');
  let files;
  try {
    files = await readdir(skeletonDir);
  } catch {
    continue; // no .skeletons dir at this location
  }
  const jsonFiles = files.filter((f) => f.endsWith('.json'));
  for (const file of jsonFiles) {
    try {
      let content = await readFile(path.join(skeletonDir, file), 'utf-8');
      if (content.charCodeAt(0) === 0xfeff) content = content.slice(1); // strip UTF-8 BOM
      const skeleton = JSON.parse(content);
      if (skeleton && skeleton.taskId) skeletons.push(skeleton);
    } catch {
      readErrors++;
    }
  }
}
console.log(`Skeletons available: ${skeletons.length}${readErrors ? ` (${readErrors} unreadable)` : ''}`);
console.log('');

const result = await runBackfill(skeletons, dualWriteConversationToStore, {
  limit: LIMIT,
});

console.log('=== Result ===');
console.log(`  total:     ${result.total}`);
console.log(`  processed: ${result.processed}`);
console.log(`  skipped:   ${result.skipped}  (missing taskId)`);
console.log(`  errors:    ${result.errors}`);
console.log('');
if (!liveMode) {
  console.log('DRY RUN complete — 0 rows persisted (NullUnifiedStoreWriter).');
  console.log('Re-run without --dry-run and UNIFIED_STORE_DUAL_WRITE=1 + UNIFIED_STORE_PG_URL set to persist.');
} else {
  console.log('LIVE backfill complete.');
  console.log('Validate the real row delta: psql -U unified_store -d unified_store -c "SELECT count(*) FROM conversations;"');
}
