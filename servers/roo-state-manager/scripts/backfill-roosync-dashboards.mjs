#!/usr/bin/env node
/**
 * #3151 Phase C — One-time backfill of the RooSync dashboards (GDrive
 * `dashboards/*.md` → `roosync_dashboards` + `roosync_dashboard_messages`)
 * so the PG-primary dashboard read path can be enabled.
 *
 * WHY: the live dual-write only mirrors dashboards written AFTER a machine
 * restarted with the flag on. The ~80 existing files never reach PG. A
 * machine that turns on UNIFIED_STORE_DASHBOARD_READ_PG before this gap is
 * closed falls back to GDrive on every key-miss — correct, but the whole
 * point of Phase C (removing GDrive from the hot path) is lost.
 *
 * Non-destructive: everything INSERT ... DO NOTHING, no `archived_at`
 * stamping (writer `{ backfill: true }`) — a file snapshot racing a live
 * sync can never overwrite fresher PG state or archive live messages.
 * Safe to re-run after an interruption.
 *
 * Env-gate (delegated to writer-factory):
 *   - UNIFIED_STORE_DUAL_WRITE=1 + UNIFIED_STORE_PG_URL set → LIVE
 *   - otherwise → DRY RUN (NullUnifiedStoreWriter, nothing persisted)
 *
 * Usage (from servers/roo-state-manager/):
 *   npm run build
 *   node scripts/backfill-roosync-dashboards.mjs --dry-run
 *   node scripts/backfill-roosync-dashboards.mjs              # live
 *
 * Prerequisite: migrations/002 + migrations/006 applied.
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
const keyIdx = args.indexOf('--key');
const KEY_FILTER = keyIdx !== -1 ? args[keyIdx + 1] : undefined;

if (HELP) {
  console.log(`Usage: node scripts/backfill-roosync-dashboards.mjs [--dry-run] [--limit N] [--key prefix] [--help]

  --dry-run       Force NullUnifiedStoreWriter (no rows persisted).
  --limit N       Stop after N dashboards (smoke test).
  --key prefix    Only backfill keys starting with this prefix (e.g. workspace-).
  --help          Show this help.

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
const [{ getSharedStatePath }, { parseDashboardMarkdown }, { backfillDashboardToStore }, { getUnifiedStoreWriter }] =
  await Promise.all([
    import(buildUrl('utils/shared-state-path.js')),
    // Dependency-light parser — importing the full dashboard tool module would
    // pull the LLM client wiring into this CLI (#3151 Phase C extraction).
    import(buildUrl('tools/roosync/dashboard-markdown.js')),
    import(buildUrl('services/unified-store/roosync-dashboard-store.js')),
    import(buildUrl('services/unified-store/writer-factory.js')),
  ]);

const writer = getUnifiedStoreWriter();
const writerKind = writer.constructor?.name ?? 'unknown';
const liveMode = writerKind !== 'NullUnifiedStoreWriter';

console.log('=== RooSync Dashboards Backfill (#3151 Phase C) ===');
console.log(`Mode: ${liveMode ? 'LIVE (PgUnifiedStoreWriter)' : 'DRY RUN (NullUnifiedStoreWriter)'}`);
console.log(`.env: ${envLoaded ? 'loaded' : 'not found'} (${path.join(RSM_ROOT, '.env')})`);
if (KEY_FILTER) console.log(`Key filter: ${KEY_FILTER}`);
if (LIMIT) console.log(`Limit: ${LIMIT} dashboards`);
console.log('');

const sharedStatePath = getSharedStatePath();
const dashboardsDir = path.join(sharedStatePath, 'dashboards');
const { readdir, readFile } = await import('fs/promises');

let files;
try {
  files = await readdir(dashboardsDir);
} catch {
  console.error(`dashboards directory not found: ${dashboardsDir}`);
  process.exit(1);
}

// Keyed dashboards only: global.md, machine-*.md, workspace-*.md.
// The archive/ subdir and *.condense.lock files are legacy/lock artifacts.
const mdFiles = files.filter(
  (f) =>
    f.endsWith('.md') &&
    (f === 'global.md' || f.startsWith('machine-') || f.startsWith('workspace-'))
);
console.log(`${dashboardsDir}: ${mdFiles.length} dashboard file(s)`);

let total = 0;
let processed = 0;
let skipped = 0;
let errors = 0;
let applied = 0;
// Which files failed — same rationale as the message-channel backfill: the
// operator needs the exact subset to re-run before enabling the read flag.
const failures = [];

for (const file of mdFiles) {
  if (LIMIT && applied >= LIMIT) break;

  const key = file.replace(/\.md$/, '');
  if (KEY_FILTER && !key.startsWith(KEY_FILTER)) {
    skipped++;
    continue;
  }
  total++;

  try {
    let content = await readFile(path.join(dashboardsDir, file), 'utf-8');
    content = content.replace(/\r\n/g, '\n'); // same normalization as the tool read path
    if (content.charCodeAt(0) === 0xfeff) content = content.slice(1); // strip UTF-8 BOM
    const dashboard = parseDashboardMarkdown(content, key);
    await backfillDashboardToStore(dashboard);
    processed++;
    applied++;
    console.log(`  ✓ ${key} (${dashboard.intercom.messages.length} messages)`);
  } catch (err) {
    errors++;
    failures.push(`${file}: ${err?.message ?? String(err)}`);
  }
}

console.log('');
console.log('=== Result ===');
console.log(`  total:     ${total}`);
console.log(`  processed: ${processed}`);
console.log(`  skipped:   ${skipped}  (key filter)`);
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
  console.log('LIVE backfill complete (INSERT DO NOTHING — existing PG rows untouched).');
  console.log('Validate: psql -c "SELECT type, count(*) FROM roosync_dashboards GROUP BY type;"');
  console.log('          psql -c "SELECT count(*) FROM roosync_dashboard_messages WHERE archived_at IS NULL;"');
  console.log('Only after the store is complete, enable UNIFIED_STORE_DASHBOARD_READ_PG=1.');
}

// Exit non-zero on any failure so an incomplete backfill cannot be mistaken
// for a complete one by a caller that only checks the exit code.
if (errors > 0) {
  console.log('');
  console.log(`INCOMPLETE — ${errors} file(s) failed. Do NOT enable UNIFIED_STORE_DASHBOARD_READ_PG until they import.`);
  process.exit(1);
}
