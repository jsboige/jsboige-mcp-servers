// Node 18+ has native fetch - no polyfill needed
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Charger .env.test en priorité (ne surcharge pas si déjà défini)
// quiet: true supprime les 888 lignes de messages promotionnels dotenv (#832)
dotenv.config({ path: path.join(__dirname, '..', '.env.test'), quiet: true });
// Charger .env pour les clés manquantes (ex: API keys) - SANS écraser les valeurs existantes
dotenv.config({ path: path.join(__dirname, '..', '.env'), override: false, quiet: true });

// GLOBAL SAFETY GUARD: Redirect APPDATA to a temp directory for ALL tests.
// This prevents any test from accidentally reading/writing the real
// mcp_settings.json (incident 2026-03-08 on ai-01, 2026-03-10 on po-2026).
// See: commit ce7d4abd, issue #629 comments.
const testAppData = path.join(os.tmpdir(), '__roo-state-manager-test-appdata__');
const testMcpDir = path.join(testAppData, 'Code', 'User', 'globalStorage',
  'rooveterinaryinc.roo-cline', 'settings');
if (!fs.existsSync(testMcpDir)) {
  fs.mkdirSync(testMcpDir, { recursive: true });
}
// Write a sentinel mcp_settings.json so tests that read it don't crash
const sentinelPath = path.join(testMcpDir, 'mcp_settings.json');
if (!fs.existsSync(sentinelPath)) {
  fs.writeFileSync(sentinelPath, JSON.stringify({ mcpServers: {} }, null, 2), 'utf-8');
}
// Only override if not already set by a specific test's vi.hoisted()
if (!process.env.APPDATA?.includes('__test-data__')) {
  process.env.APPDATA = testAppData;
}

// Maintenance#358 — per-worker mkdtemp dirs must not outlive the worker.
// Registration + teardown live in tests/setup-env-teardown.ts: in-process
// handlers cover normal exits and POSIX signal kills; the vitest globalSetup
// teardown sweeps Windows-hard-killed fork workers (child.kill() there is
// TerminateProcess — no handler can run). 3 dirs per worker, leaked at every
// run since #3782 (221 680 rsm-test-* dirs measured on ai-01).
// Explicit .ts extension: this file is ALSO imported by a bare `node
// --experimental-strip-types` child in tests/unit/setup-env-teardown.test.ts,
// where native ESM resolution does not add extensions (vitest's bundler
// resolution is not in play there).
import { registerRsmTestTempDir } from './setup-env-teardown.ts';

// #3782 locks-off-Drive — per-WORKER lock dir. The dashboard locks default to
// os.tmpdir()/roosync-locks, which parallel vitest workers would SHARE: workers
// running the same dashboard keys would see each other's fresh locks (condense
// skips, append fail-opens) and leak locks between test files. One mkdtemp per
// worker process; specific suites may still override with their own dir.
if (!process.env.ROOSYNC_LOCK_DIR) {
  process.env.ROOSYNC_LOCK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rsm-test-locks-'));
  registerRsmTestTempDir(process.env.ROOSYNC_LOCK_DIR);
}

// #4131 B16 — per-WORKER G: scan lock dir, same reasoning as #3782 above. The
// host scan lock defaults to os.tmpdir()/roo-state-manager so that every RSM
// process on a host serializes its DriveFS scans; parallel vitest workers would
// inherit that and defer each other's inbox rebuilds, which is intended ACROSS
// PROCESSES but makes rebuild-mechanics suites measure an artifact of the
// runner instead of their subject. One dir per worker process; the lock suite
// and any test needing real cross-acquirer contention override it explicitly.
if (!process.env.ROOSYNC_SCAN_LOCK_DIR) {
  process.env.ROOSYNC_SCAN_LOCK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rsm-test-scan-locks-'));
  registerRsmTestTempDir(process.env.ROOSYNC_SCAN_LOCK_DIR);
}

// Tool-usage cache isolation — same reasoning as #3782/#4131 above. The
// tool-usage cache defaults to os.tmpdir()/roo-state-manager-cache keyed by
// hostname (roosync-indexing.tool.ts getToolUsageCachePath): any test invoking
// tool_usage_stats (or save_snapshot, which recurses into it) would overwrite
// the HOST's real production cache at the end of its scan — measured 16/11 on
// ai-01: a local run of tool-usage-stats-raw-variants.test.ts left a 412-byte
// cache, and the weekly save_snapshot then exceeded the 300 s MCP timeout on
// every cold scan. One mkdtemp per worker process; the suites that test the
// cache itself (tool-usage-cache.test.ts, tool-usage-stats-window-consistency
// .test.ts) already override with their own dir.
// #4884 — set UNCONDITIONALLY, like the ledger dir below. A value inherited
// from the shell or .env used to be kept, so a seat exporting this variable —
// the production default included — ran every suite against the real cache
// while the isolation guard stayed green. The suites that test the cache set
// their own dir in beforeEach, i.e. after this file: they still override.
process.env.ROOSYNC_TOOL_USAGE_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rsm-test-tus-cache-'));
registerRsmTestTempDir(process.env.ROOSYNC_TOOL_USAGE_CACHE_DIR);

// #4861 v1.2 — per-WORKER contentHash ledger dir, and unlike the three above it
// is set UNCONDITIONALLY. The ledger defaults to
// ~/.roo-state-manager/index-hash-ledgers (IndexedHashLedger.ts
// ledgerRootDir) and `clearIndexedHashLedgers()` deletes that whole directory;
// resetCollection and cleanupOldVectors both call it, and three suites reach
// it without setting a dir (indexing-controls, task-indexer,
// reset-collection.tool). Measured on po-2028, 22/11: 40+
// `[#4861] index-hash ledgers cleared` lines in the test log of one full local
// run. No production ledger existed on that seat yet (first one written
// 22/11 22:09Z); the next full run would have deleted the seat's real ledgers,
// i.e. the scroll work of every indexed session. A value inherited from the
// shell or .env is overridden on purpose: a test run must never point at it.
// The suites that test the ledger itself override it with their own dir.
process.env.INDEX_HASH_LEDGER_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rsm-test-hash-ledger-'));
registerRsmTestTempDir(process.env.INDEX_HASH_LEDGER_DIR);