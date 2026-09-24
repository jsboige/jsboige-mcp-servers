#!/usr/bin/env node
/**
 * #2427 defect B — Backfill of Claude Code sessions into the unified Postgres store
 * (Epic #2191).
 *
 * WHY: the Roo/Zoo backfill (scripts/backfill-unified-store.mjs) only reads
 * `tasks/.skeletons/*.json`. Claude Code sessions are NEVER materialized as skeleton
 * files — they live in `~/.claude/projects/<project>/*.jsonl` and only reach Postgres
 * through the Worker A scan, which is gated on a persisted mtime cursor. Before the
 * defect-B fix, that cursor advanced even when the dual-write failed (fire-and-forget
 * `.catch(() => {})`), so every session whose mtime predated a PG outage / misconfig
 * was permanently absent from the store with no catch-up path. This script closes that
 * gap: it scans the real Claude storage locations, re-analyzes each session with the
 * EXACT live path (per-session taskId + analyzeConversation + dualWriteConversationToStore),
 * and reports real successes vs real failures (dual-write resolves {ok:false} on a
 * swallowed DB failure since the defect-B fix).
 *
 * Mirror of the live path (background-services.ts Claude scan / loadClaudeCodeSessions):
 *   taskId = `claude-${basename(projectPath)}--${sessionUuid}`
 *   skeleton.metadata.source = 'claude-code'; skeleton.metadata.dataSource = 'claude';
 *   dualWriteConversationToStore(taskId, skeleton)
 *
 * Env-gate (delegated to writer-factory):
 *   - UNIFIED_STORE_DUAL_WRITE=1 + UNIFIED_STORE_PG_URL set → PgUnifiedStoreWriter (LIVE)
 *   - otherwise → NullUnifiedStoreWriter (DRY RUN — no rows persisted)
 *
 * Idempotent: dual-write upserts (ON CONFLICT DO UPDATE) → safe to re-run after interruption.
 *
 * Usage (from servers/roo-state-manager/):
 *   npm run build                                          # build must exist (script imports it)
 *   node scripts/backfill-unified-store-claude.mjs                 # live (env gate ON + PG_URL)
 *   node scripts/backfill-unified-store-claude.mjs --dry-run       # force NullUnifiedStoreWriter
 *   node scripts/backfill-unified-store-claude.mjs --limit 10      # stop after N (smoke test)
 *   node scripts/backfill-unified-store-claude.mjs --project roo   # only matching project dirs
 *   node scripts/backfill-unified-store-claude.mjs --since 2026-09-01  # only newer sessions
 *
 * The .env at servers/roo-state-manager/.env is auto-loaded (UNIFIED_STORE_*).
 * Validated SANS DB: --dry-run scans + analyzes, reports counts, writes nothing.
 */

import { resolveBuildDir } from './lib/resolve-build-dir.mjs';
import { readFileSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

// --- .env loader (identical to backfill-unified-store.mjs; only KEY=VALUE) ---
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
const readOpt = (flag) => {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : undefined;
};
const PARSED_LIMIT = parseInt(readOpt('--limit'), 10);
const LIMIT = Number.isFinite(PARSED_LIMIT) && PARSED_LIMIT >= 0 ? PARSED_LIMIT : undefined;
const PROJECT_FILTER = readOpt('--project'); // substring match on the project dir name
const SINCE_RAW = readOpt('--since');
const SINCE_MS = SINCE_RAW ? Date.parse(SINCE_RAW) : undefined;

if (HELP) {
  console.log(`Usage: node scripts/backfill-unified-store-claude.mjs [--dry-run] [--limit N] [--project X] [--since DATE] [--help]

  --dry-run     Force NullUnifiedStoreWriter (no rows persisted). Default when the
                env gate is off (UNIFIED_STORE_DUAL_WRITE != 1 or UNIFIED_STORE_PG_URL unset).
  --limit N     Stop after N sessions (smoke test / partial run).
  --project X   Only backfill project dirs whose name contains X (case-insensitive).
  --since DATE  Only backfill sessions whose .jsonl mtime is newer than DATE (ISO / yyyy-mm-dd).
  --help        Show this help.

Requires a fresh build (run "npm run build" first). Loads .env automatically.
Idempotent: dual-write upserts; safe to re-run after interruption.`);
  process.exit(0);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RSM_ROOT = path.resolve(__dirname, '..'); // servers/roo-state-manager/
const envLoaded = loadEnv(path.join(RSM_ROOT, '.env'));

// Force the env-gate off when --dry-run is explicitly requested.
// MUST run after loadEnv() (#2815: deleting before loadEnv lets .env re-arm the gate).
if (DRY_RUN) {
  delete process.env.UNIFIED_STORE_DUAL_WRITE;
  delete process.env.UNIFIED_STORE_PG_URL;
}

// Dynamic imports against the compiled build (vintage-aware via resolveBuildDir).
const buildUrl = (rel) => pathToFileURL(path.join(resolveBuildDir(RSM_ROOT), rel)).href;
const [{ ClaudeStorageDetector }, { dualWriteConversationToStore }, { getUnifiedStoreWriter }] =
  await Promise.all([
    import(buildUrl('utils/claude-storage-detector.js')),
    import(buildUrl('services/unified-store/dual-write.js')),
    import(buildUrl('services/unified-store/writer-factory.js')),
  ]);

const writer = getUnifiedStoreWriter();
const writerKind = writer.constructor?.name ?? 'unknown';
const liveMode = writerKind !== 'NullUnifiedStoreWriter';

console.log('=== Unified Store Claude Backfill (#2427 defect B) ===');
console.log(`Mode: ${liveMode ? 'LIVE (PgUnifiedStoreWriter)' : 'DRY RUN (NullUnifiedStoreWriter)'}`);
console.log(`.env: ${envLoaded ? 'loaded' : 'not found'} (${path.join(RSM_ROOT, '.env')})`);
console.log(`Writer: ${writerKind}`);
if (LIMIT) console.log(`Limit: ${LIMIT} sessions`);
if (PROJECT_FILTER) console.log(`Project filter: /${PROJECT_FILTER}/i`);
if (SINCE_MS) console.log(`Since: ${new Date(SINCE_MS).toISOString()}`);
console.log('');

if (liveMode && !DRY_RUN) {
  console.log('⚠️  LIVE mode — rows WILL be upserted into the unified Postgres store.');
}

const { readdir, stat } = await import('fs/promises');

console.log('Detecting Claude storage locations...');
const locations = await ClaudeStorageDetector.detectStorageLocations();
if (!locations.length) {
  console.error('No Claude storage detected. Nothing to backfill.');
  process.exit(1);
}
console.log(`Storage locations: ${locations.length}`);

// Collect (taskId, projectPath) pairs, mirroring the live scan's per-session taskId.
const seenProjects = new Set();
const candidates = [];
let skippedProject = 0;
let skippedSince = 0;
for (const location of locations) {
  if (seenProjects.has(location.projectPath)) continue;
  seenProjects.add(location.projectPath);
  if (PROJECT_FILTER && !location.projectPath.toLowerCase().includes(PROJECT_FILTER.toLowerCase())) {
    skippedProject++;
    continue;
  }
  let files;
  try {
    files = (await readdir(location.projectPath)).filter((f) => f.endsWith('.jsonl'));
  } catch {
    continue; // unreadable project dir
  }
  const projectBasename = path.basename(location.projectPath);
  for (const file of files) {
    try {
      if (SINCE_MS) {
        const st = await stat(path.join(location.projectPath, file));
        if (st.mtime.getTime() <= SINCE_MS) {
          skippedSince++;
          continue;
        }
      }
      const sessionUuid = file.replace('.jsonl', '');
      candidates.push({ taskId: `claude-${projectBasename}--${sessionUuid}`, projectPath: location.projectPath });
    } catch {
      // stat error — skip this file
    }
  }
}

const total = candidates.length;
const slice = LIMIT ? candidates.slice(0, LIMIT) : candidates;
console.log(`Sessions available: ${total}${skippedProject ? ` (${skippedProject} project dirs filtered out)` : ''}${skippedSince ? ` (${skippedSince} older than --since)` : ''}`);
console.log(`Processing: ${slice.length}`);
console.log('');

let processed = 0;
let skipped = 0;
let errors = 0;
const failed = [];

for (const { taskId, projectPath } of slice) {
  try {
    const skeleton = await ClaudeStorageDetector.analyzeConversation(taskId, projectPath);
    if (!skeleton || (skeleton.sequence ?? []).length === 0) {
      skipped++;
      continue;
    }
    if (!skeleton.metadata) skeleton.metadata = {};
    skeleton.metadata.source = 'claude-code';
    skeleton.metadata.dataSource = 'claude';
    const result = await dualWriteConversationToStore(taskId, skeleton);
    // dualWrite never rejects; it reports a swallowed DB failure via ok:false (#2427).
    if (result && typeof result === 'object' && result.ok === false) {
      errors++;
      failed.push(taskId);
    } else {
      processed++;
    }
  } catch (err) {
    errors++;
    failed.push(`${taskId} (${err?.message || err})`);
  }
}

console.log('=== Result ===');
console.log(`  total:     ${total}`);
console.log(`  processed: ${processed}`);
console.log(`  skipped:   ${skipped}  (empty/unparseable)`);
console.log(`  errors:    ${errors}`);
if (failed.length) {
  console.log('  failed task_ids (first 20):');
  for (const id of failed.slice(0, 20)) console.log(`    - ${id}`);
}
console.log('');
if (!liveMode) {
  console.log('DRY RUN complete — 0 rows persisted (NullUnifiedStoreWriter).');
  console.log('Re-run without --dry-run and UNIFIED_STORE_DUAL_WRITE=1 + UNIFIED_STORE_PG_URL set to persist.');
} else {
  console.log('LIVE Claude backfill complete.');
  console.log('Validate the real row delta: psql -U unified_store -d unified_store -c "SELECT harness, count(*) FROM conversations GROUP BY harness;"');
}

// Exit non-zero when any write failed in LIVE mode so a caller (cron / operator) notices.
process.exit(liveMode && errors > 0 ? 1 : 0);
