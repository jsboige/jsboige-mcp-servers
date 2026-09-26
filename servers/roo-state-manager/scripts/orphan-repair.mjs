// #2427 — Targeted orphan-conversation repair (Zoo tasks, DB-driven).
//
// Repairs conversations that carry msg_count > 0 but have NO messages rows
// (ai-01's anti-join predicate). For each orphan task_id:
//   skeleton = RooStorageDetector.analyzeConversation(taskId, taskPath)  // full re-read
//   await dualWriteConversationToStore(taskId, skeleton)                 // upsert conv + messages
//
// Why re-analyze instead of trusting the skeleton on disk: the #2957 defect-1
// guard skips the message upsert for header-only skeletons, which is exactly
// how these conversations became "successful" backfills with zero messages
// (po-2025 paradox, 995/995 without resorption).
//
// Usage:
//   node scripts/orphan-repair.mjs --machine myia-web1                     # dry run (default)
//   node scripts/orphan-repair.mjs --machine myia-web1 --limit 5           # dry-run canary
//   node scripts/orphan-repair.mjs --machine myia-web1 --live --limit 5    # LIVE pilot lot
//   node scripts/orphan-repair.mjs --machine myia-web1 --live              # LIVE full repair
//   node scripts/orphan-repair.mjs --machine myia-web1 --live --task-ids id1,id2  # replay/rollback
//
// LIVE is opt-in (--live) and additionally gated by UNIFIED_STORE_DUAL_WRITE +
// UNIFIED_STORE_PG_URL in the server .env (same gate as the backfill scripts);
// if --live is asked while the gates are absent, exit 2. Without --live the
// gates are stripped (NullUnifiedStoreWriter, zero rows persisted).
// --task-ids bypasses the anti-join selection: replay the write on known ids
// (idempotence verification) or target a rollback lot.
// Any malformed or repeated argument, or a machine-id mismatch, exits 2 — this
// script is replayed as-is on other hosts against the shared production store,
// so its guards fail closed. Tasks with no local source files are SKIPPED, not
// failures (expected cross-host). Exit 1 in LIVE mode only on real errors.
// The PG connection is resolved ONCE before the dry-run gate strip, so dry and
// live always read the same database.
// Scope: Zoo tasks only (harness='zoo') — Claude orphans come from a different
// source layout and are not covered here.
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const RSM_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadEnv(file) {
  let content;
  try { content = readFileSync(file, 'utf-8'); } catch { return false; }
  for (const line of content.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  }
  return true;
}
loadEnv(path.join(RSM_ROOT, '.env'));

const args = process.argv.slice(2);
const VALUE_FLAGS = new Set(['--machine', '--limit', '--task-ids']);
const BOOL_FLAGS = new Set(['--dry-run', '--live']);
const flag = (name) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
};

const seen = new Set();
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (seen.has(a)) {
    console.error(`Repeated argument: ${a} (first occurrence wins is not acceptable — exit).`);
    process.exit(2);
  }
  seen.add(a);
  if (VALUE_FLAGS.has(a)) {
    const v = args[i + 1];
    if (v === undefined || VALUE_FLAGS.has(v) || BOOL_FLAGS.has(v)) {
      console.error(`${a} requires a value.`);
      process.exit(2);
    }
    i++;
  } else if (!BOOL_FLAGS.has(a)) {
    console.error(`Unknown argument: ${a}`);
    process.exit(2);
  }
}

const DRY_RUN = args.includes('--dry-run');
const LIVE = args.includes('--live');
if (DRY_RUN && LIVE) {
  console.error('--dry-run and --live are mutually exclusive.');
  process.exit(2);
}
const MACHINE = flag('--machine');
if (!MACHINE) {
  console.error('--machine <machine-id> is required (fail-closed: never guess the corpus to mutate).');
  process.exit(2);
}

let LIMIT;
const li = args.indexOf('--limit');
if (li !== -1) {
  const raw = args[li + 1];
  if (!/^\d+$/.test(raw)) {
    console.error(`--limit requires a non-negative integer, got: "${raw}"`);
    process.exit(2);
  }
  LIMIT = parseInt(raw, 10);
}

let TASK_IDS;
const ti = args.indexOf('--task-ids');
if (ti !== -1) {
  const parts = args[ti + 1].split(',').map((s) => s.trim());
  if (parts.some((p) => p.length === 0)) {
    console.error('--task-ids requires a comma-separated list of non-empty task ids.');
    process.exit(2);
  }
  TASK_IDS = parts;
}

// Capture the connection BEFORE stripping the write gates (W1): the read
// clients below must see the same DB a --live run would write to, whether the
// URL came from the shell env or from .env. Resolving after the delete made a
// dry run silently fall back to .env while --live wrote to the env DB.
const PG_URL = process.env.UNIFIED_STORE_PG_URL ?? readEnvKey('UNIFIED_STORE_PG_URL');

// Without an explicit --live, strip the write gates: the default is dry run.
if (!LIVE) {
  delete process.env.UNIFIED_STORE_DUAL_WRITE;
  delete process.env.UNIFIED_STORE_PG_URL;
}

const require = createRequire(path.join(RSM_ROOT, 'package.json'));
const { Client } = require('pg');
const { resolveBuildDir } = await import('./lib/resolve-build-dir.mjs');

const BUILD_DIR = resolveBuildDir(RSM_ROOT);
console.log(`Build dir: ${BUILD_DIR}`);
const buildUrl = (rel) => pathToFileURL(path.join(BUILD_DIR, rel)).href;
const [{ RooStorageDetector }, { dualWriteConversationToStore }, { getUnifiedStoreWriter }] =
  await Promise.all([
    import(buildUrl('utils/roo-storage-detector.js')),
    import(buildUrl('services/unified-store/dual-write.js')),
    import(buildUrl('services/unified-store/writer-factory.js')),
  ]);

const writer = getUnifiedStoreWriter();
const liveMode = LIVE && writer.constructor?.name !== 'NullUnifiedStoreWriter';
if (LIVE && !liveMode) {
  console.error('--live requested but the write gates are absent (UNIFIED_STORE_DUAL_WRITE / UNIFIED_STORE_PG_URL) — writer resolved to NullUnifiedStoreWriter.');
  process.exit(2);
}
console.log(`Mode: ${liveMode ? 'LIVE (PgUnifiedStoreWriter, --live)' : 'DRY RUN (NullUnifiedStoreWriter)'}`);
console.log(`Machine: ${MACHINE}${LIMIT !== undefined ? ` | limit: ${LIMIT}` : ''}${TASK_IDS ? ` | task-ids: ${TASK_IDS.length}` : ''}`);
if (liveMode) console.log('⚠️  LIVE — rows WILL be upserted into the unified store.');

function readEnvKey(k) {
  const c = readFileSync(path.join(RSM_ROOT, '.env'), 'utf-8');
  for (const line of c.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith(k + '=')) return t.slice(k.length + 1).trim().replace(/^["']|["']$/g, '');
  }
  return undefined;
}

const client = new Client({ connectionString: PG_URL });
await client.connect();

let orphans;
if (TASK_IDS) {
  orphans = TASK_IDS;
  console.log(`Explicit task ids: ${orphans.length} (--task-ids — anti-join predicate bypassed)`);
} else {
  const PREDICATE = `
    select c.task_id
    from conversations c
    where c.msg_count > 0
      and c.machine_id = $1
      and c.harness = 'zoo'
      and not exists (select 1 from messages m where m.task_id = c.task_id)
    order by c.last_ts desc
  `;
  const beforeCount = (await client.query(`select count(*)::int n from (${PREDICATE}) o`, [MACHINE])).rows[0].n;
  orphans = (await client.query(PREDICATE, [MACHINE])).rows.map((r) => r.task_id);
  console.log(`Orphans BEFORE (${MACHINE}/zoo, anti-join): ${beforeCount}`);
}
await client.end();

const base = path.join(process.env.APPDATA ?? path.join(process.env.USERPROFILE ?? '', 'AppData', 'Roaming'),
  'Code', 'User', 'globalStorage', 'zoocodeorganization.zoo-code', 'tasks');
const slice = LIMIT !== undefined ? orphans.slice(0, LIMIT) : orphans;
console.log(`Processing: ${slice.length}`);

let processed = 0, emptySeq = 0, errors = 0, msgsTotal = 0;
const failed = [];
const skipped = [];
const written = [];
for (const taskId of slice) {
  try {
    const skeleton = await RooStorageDetector.analyzeConversation(taskId, path.join(base, taskId));
    const seqLen = (skeleton?.sequence ?? []).length;
    if (!skeleton || seqLen === 0) {
      // No local source files is the expected cross-host case, not a failure.
      emptySeq++;
      skipped.push(taskId);
      continue;
    }

    // The write path stamps machine_id from the skeleton/env chain (dual-write.ts),
    // not from --machine. A divergence means the upsert would re-attribute
    // another host's rows to this one — fail closed before the first write.
    const resolvedMachine = (skeleton.metadata?.machineId
      ?? process.env.ROOSYNC_MACHINE_ID
      ?? process.env.COMPUTERNAME
      ?? '').toLowerCase();
    if (resolvedMachine !== MACHINE.toLowerCase()) {
      console.error(`machine-id mismatch for ${taskId}: write would stamp "${resolvedMachine}" but --machine is "${MACHINE}" — aborting before write.`);
      if (written.length > 0) {
        console.error(`--- ids WRITTEN before this abort (${written.length}) — rollback key: ---`);
        for (const w of written) console.error(`  ${w}`);
      }
      process.exit(2);
    }

    msgsTotal += seqLen;
    const res = await dualWriteConversationToStore(taskId, skeleton);
    if (res && res.ok === false) {
      errors++;
      failed.push(taskId + ' (dual-write: ' + (res.error ?? '?') + ')');
      continue;
    }
    processed++;
    written.push(taskId);
    console.log(`  ${liveMode ? 'ok:' : 'would-write:'} ${taskId}  seq=${seqLen}`);
  } catch (e) {
    errors++;
    failed.push(taskId + ' (' + (e?.message ?? e) + ')');
  }
  if ((processed + emptySeq + errors) % 50 === 0) console.log(`  progress: ${processed} ok / ${emptySeq} empty / ${errors} err / seq-entries ${msgsTotal}`);
}

console.log('\n=== Result ===');
console.log(`  processed:      ${processed}`);
console.log(`  skipped:        ${emptySeq}  (no local source files — not a failure)`);
console.log(`  errors:         ${errors}`);
console.log(`  seq entries:    ${msgsTotal}`);
if (skipped.length) console.log('  skipped task_ids (first 15):', skipped.slice(0, 15));
if (failed.length) console.log('  failed task_ids (first 15):', failed.slice(0, 15));

// Post-run message-row counts for every id in this run's slice — the
// verification key for replay idempotence and targeted rollback.
if (slice.length > 0) {
  const vc = new Client({ connectionString: PG_URL });
  await vc.connect();
  const counts = await vc.query(
    'select m.task_id, count(*)::int n from messages m where m.task_id = any($1::text[]) group by m.task_id',
    [slice]
  );
  const byId = new Map(counts.rows.map((r) => [r.task_id, r.n]));
  for (const taskId of slice) console.log(`  post: ${taskId}  messages=${byId.get(taskId) ?? 0}`);
  await vc.end();
}

console.log(liveMode
  ? 'LIVE repair complete — re-run the BEFORE predicate to measure delta.'
  : 'DRY-RUN complete — zero rows persisted.');

if (liveMode && errors > 0) process.exit(1);
