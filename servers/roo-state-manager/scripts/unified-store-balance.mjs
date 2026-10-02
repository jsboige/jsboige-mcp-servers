// #2427 — fleet view + coherence probe on the two-count orphan-balance
// predicate (scripts/lib/orphan-balance.mjs — the single source for the
// classes; do not inline the SQL here).
//
// Read-only by construction: no write path is imported, no gate is consulted.
//
// Usage:
//   node scripts/unified-store-balance.mjs                     # fleet balance, all machines/harnesses
//   node scripts/unified-store-balance.mjs --machine myia-web1
//   node scripts/unified-store-balance.mjs --harness zoo
//   node scripts/unified-store-balance.mjs --probe             # coherence probe instead of the balance
//   node scripts/unified-store-balance.mjs --json              # machine-readable rows + totals
//
// The balance table never folds the anti-join into one number
// (arbitration issuecomment-5933447265): actionable, unrecoverable and
// legacy_aggregate are printed side by side; the floor stays visible.
// Any malformed or repeated argument exits 2 — this script is quoted in
// fleet reports, so its guards fail closed.
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { BALANCE_SQL, PROBE_SQL } from './lib/orphan-balance.mjs';

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
const VALUE_FLAGS = new Set(['--machine', '--harness']);
const BOOL_FLAGS = new Set(['--probe', '--json']);
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

const MACHINE = flag('--machine') ?? null;
const HARNESS = flag('--harness') ?? null;
const PROBE = args.includes('--probe');
const JSON_OUT = args.includes('--json');

const PG_URL = process.env.UNIFIED_STORE_PG_URL
  ?? readEnvKey('UNIFIED_STORE_PG_URL');
if (!PG_URL) {
  console.error('UNIFIED_STORE_PG_URL is required (env or server .env) — never guess the store to read.');
  process.exit(2);
}

function readEnvKey(k) {
  let c;
  try { c = readFileSync(path.join(RSM_ROOT, '.env'), 'utf-8'); } catch { return undefined; }
  for (const line of c.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith(k + '=')) return t.slice(k.length + 1).trim().replace(/^["']|["']$/g, '');
  }
  return undefined;
}

const require = createRequire(path.join(RSM_ROOT, 'package.json'));
const { Client } = require('pg');

const client = new Client({ connectionString: PG_URL });
await client.connect();
const generatedAt = new Date().toISOString();

const rows = PROBE
  ? (await client.query(PROBE_SQL, [MACHINE])).rows
  : (await client.query(BALANCE_SQL, [MACHINE, HARNESS])).rows;
await client.end();

if (JSON_OUT) {
  console.log(JSON.stringify({
    mode: PROBE ? 'coherence-probe' : 'fleet-balance',
    machine: MACHINE,
    harness: HARNESS,
    generated_at: generatedAt,
    rows,
  }, null, 2));
} else if (PROBE) {
  console.log(`=== Coherence probe: ingestion freshness (#2427, generated ${generatedAt}) ===`);
  console.log('max_ingested_at age is the staleness signal: compare it to the NEWEST local');
  console.log('source file for the same (machine, harness) on the host that owns the corpus.');
  console.log('');
  console.log('machine_id        harness  conversations  max_ingested_at          age_h  max_last_ts');
  const now = Date.now();
  for (const r of rows) {
    const ing = r.max_ingested_at ? new Date(r.max_ingested_at) : null;
    const ageH = ing ? ((now - ing.getTime()) / 3_600_000).toFixed(1) : 'n/a';
    console.log(
      `${String(r.machine_id).padEnd(17)} ${String(r.harness).padEnd(8)} ${String(r.conversations).padStart(13)}  `
      + `${(ing ? ing.toISOString() : 'n/a').padEnd(24)} ${String(ageH).padStart(5)}  `
      + `${r.max_last_ts ? new Date(r.max_last_ts).toISOString() : 'n/a'}`
    );
  }
} else {
  console.log(`=== Fleet orphan balance, two-count predicate (#2427, generated ${generatedAt}) ===`);
  console.log('Classes are disjoint and sum to anti_join_total; partial_trace overlaps unrecoverable.');
  console.log('');
  console.log('machine_id        harness   actionable  unrecoverable  legacy_aggregate  partial_trace  anti_join_total');
  const totals = { actionable: 0, unrecoverable: 0, legacy_aggregate: 0, partial_trace: 0, anti_join_total: 0 };
  for (const r of rows) {
    for (const k of Object.keys(totals)) totals[k] += r[k];
    console.log(
      `${String(r.machine_id).padEnd(17)} ${String(r.harness).padEnd(8)} ${String(r.actionable).padStart(10)}  `
      + `${String(r.unrecoverable).padStart(13)}  ${String(r.legacy_aggregate).padStart(16)}  `
      + `${String(r.partial_trace).padStart(13)}  ${String(r.anti_join_total).padStart(16)}`
    );
  }
  console.log('-'.repeat(105));
  console.log(
    `${'TOTAL'.padEnd(17)} ${''.padEnd(8)} ${String(totals.actionable).padStart(10)}  `
    + `${String(totals.unrecoverable).padStart(13)}  ${String(totals.legacy_aggregate).padStart(16)}  `
    + `${String(totals.partial_trace).padStart(13)}  ${String(totals.anti_join_total).padStart(16)}`
  );
  if (rows.length === 0) {
    console.log('(no rows — either the store has no orphan conversation for this filter, or the filter is wrong)');
  }
}
