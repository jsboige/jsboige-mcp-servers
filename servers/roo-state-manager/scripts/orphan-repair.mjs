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
//   node scripts/orphan-repair.mjs --machine myia-web1 --dry-run            # analyze, write nothing
//   node scripts/orphan-repair.mjs --machine myia-web1 --dry-run --limit 5  # canary
//   node scripts/orphan-repair.mjs --machine myia-web1 --limit 5            # LIVE pilot lot
//   node scripts/orphan-repair.mjs --machine myia-web1                       # LIVE full repair
//
// LIVE requires UNIFIED_STORE_DUAL_WRITE=1 + UNIFIED_STORE_PG_URL in the
// server .env (same gate as the backfill scripts). Exit 1 in LIVE mode if any
// task failed. Scope: Zoo tasks only (harness='zoo') — Claude orphans come
// from a different source layout and are not covered here.
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
const flag = (name) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
};
const DRY_RUN = args.includes('--dry-run');
const MACHINE = flag('--machine');
const li = args.indexOf('--limit');
const PL = parseInt(li !== -1 ? args[li + 1] : '', 10);
const LIMIT = Number.isFinite(PL) && PL >= 0 ? PL : undefined;

if (!MACHINE) {
  console.error('--machine <machine-id> is required (fail-closed: never guess the corpus to mutate).');
  process.exit(2);
}

if (DRY_RUN) {
  delete process.env.UNIFIED_STORE_DUAL_WRITE;
  delete process.env.UNIFIED_STORE_PG_URL;
}

const require = createRequire(path.join(RSM_ROOT, 'package.json'));
const { Client } = require('pg');
const { resolveBuildDir } = await import('./lib/resolve-build-dir.mjs');

const buildUrl = (rel) => pathToFileURL(path.join(resolveBuildDir(RSM_ROOT), rel)).href;
const [{ RooStorageDetector }, { dualWriteConversationToStore }, { getUnifiedStoreWriter }] =
  await Promise.all([
    import(buildUrl('utils/roo-storage-detector.js')),
    import(buildUrl('services/unified-store/dual-write.js')),
    import(buildUrl('services/unified-store/writer-factory.js')),
  ]);

const writer = getUnifiedStoreWriter();
const liveMode = writer.constructor?.name !== 'NullUnifiedStoreWriter';
console.log(`Mode: ${liveMode ? 'LIVE (PgUnifiedStoreWriter)' : 'DRY RUN (NullUnifiedStoreWriter)'}`);
console.log(`Machine: ${MACHINE}${LIMIT !== undefined ? ` | limit: ${LIMIT}` : ''}`);
if (liveMode && !DRY_RUN) console.log('⚠️  LIVE — rows WILL be upserted into the unified store.');

function readEnvKey(k) {
  const c = readFileSync(path.join(RSM_ROOT, '.env'), 'utf-8');
  for (const line of c.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith(k + '=')) return t.slice(k.length + 1).trim().replace(/^["']|["']$/g, '');
  }
  return undefined;
}

const client = new Client({ connectionString: process.env.UNIFIED_STORE_PG_URL ?? readEnvKey('UNIFIED_STORE_PG_URL') });
await client.connect();
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
const orphans = (await client.query(PREDICATE, [MACHINE])).rows.map((r) => r.task_id);
console.log(`Orphans BEFORE (${MACHINE}/zoo, anti-join): ${beforeCount}`);
await client.end();

const base = path.join(process.env.APPDATA ?? path.join(process.env.USERPROFILE ?? '', 'AppData', 'Roaming'),
  'Code', 'User', 'globalStorage', 'zoocodeorganization.zoo-code', 'tasks');
const slice = LIMIT !== undefined ? orphans.slice(0, LIMIT) : orphans;
console.log(`Processing: ${slice.length}`);

let processed = 0, emptySeq = 0, errors = 0, msgsTotal = 0;
const failed = [];
for (const taskId of slice) {
  try {
    const skeleton = await RooStorageDetector.analyzeConversation(taskId, path.join(base, taskId));
    const seqLen = (skeleton?.sequence ?? []).length;
    if (!skeleton || seqLen === 0) {
      emptySeq++;
      failed.push(taskId + ' (empty sequence)');
      continue;
    }
    msgsTotal += seqLen;
    const res = await dualWriteConversationToStore(taskId, skeleton);
    if (res && res.ok === false) {
      errors++;
      failed.push(taskId + ' (dual-write: ' + (res.error ?? '?') + ')');
      continue;
    }
    processed++;
    console.log(`  ok: ${taskId}  seq=${seqLen}`);
  } catch (e) {
    errors++;
    failed.push(taskId + ' (' + (e?.message ?? e) + ')');
  }
  if ((processed + emptySeq + errors) % 50 === 0) console.log(`  progress: ${processed} ok / ${emptySeq} empty / ${errors} err / seq-entries ${msgsTotal}`);
}

console.log('\n=== Result ===');
console.log(`  processed:      ${processed}`);
console.log(`  empty seq:      ${emptySeq}  (analyze OK but no messages)`);
console.log(`  errors:         ${errors}`);
console.log(`  seq entries:    ${msgsTotal}`);
if (failed.length) console.log('  failed task_ids (first 15):', failed.slice(0, 15));
console.log(liveMode && !DRY_RUN
  ? 'LIVE repair complete — re-run the BEFORE predicate to measure delta.'
  : 'DRY-RUN complete — zero rows persisted.');

if (liveMode && !DRY_RUN && (errors > 0 || emptySeq > 0)) process.exit(1);
