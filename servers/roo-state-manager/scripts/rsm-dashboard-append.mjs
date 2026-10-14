#!/usr/bin/env node
/**
 * #4131 grain G-C, site 4 helper — listener escalation append on the MACHINE
 * dashboard, through the same dual-write (GDrive + PG journal) the MCP tool
 * uses. Replaces the listener's direct `Write-MachineDashboardMessage` GDrive
 * file write.
 *
 * WHY: the escalation (#3761 remedy 2, definitive-skip WARN) is currently a
 * raw append into `machine-<id>.md` — a second, drifting implementation of
 * the dashboard file format (counter bump, pluralisation, seed header). This
 * CLI routes the write through the served build's own serialization and the
 * store's dual-write, so an escalation is a first-class intercom message in
 * PG from the moment it is posted.
 *
 * Surface = the #3761 escalation contract, imposed BY CONSTRUCTION:
 *   - there is NO --type option: the key is always `machine-<id>` (passing
 *     --type is a usage error, exit 2 — a global append cannot even be
 *     expressed);
 *   - content must be [TAG]-prefixed and the tag must not be ERROR
 *     (machine dashboards escalate WARN-class events only);
 *   - author is `<machine>|listener`, msg id `<machine>:listener:ic-…`
 *     (parity with the previous format).
 *
 * Review contract (ms#1425 CHANGES_REQUESTED, 3 items — 14/10):
 *   1. APPEND LOCK, fail-open: the read→fold→write runs under
 *      `acquireAppendLock` (cross-process: PG row + tmpdir), mirroring the
 *      cross-post path. #3761 escalations must never be dropped, so a lock
 *      we could not acquire does NOT abort: the write proceeds unserialized
 *      and the JSON output carries `unserialized: true`. The write half is
 *      BOUNDED (`UNIFIED_STORE_DASHBOARD_GDRIVE_WRITE_TIMEOUT_MS`, default
 *      30 s, read at call time — same convention as the G-B lot 1 bounds)
 *      so lock detention cannot be indefinite (07/10 class).
 *   2. #3782: the base state comes from `readDashboardFile` — the choke
 *      point that makes a retired (merged-away) key invisible in BOTH
 *      halves. The first head called `readDashboardFromPg` directly, which
 *      would resurrect a retired machine key.
 *   3. `pgSynced` is decided by `dualWriteDashboardSyncChecked` — the void
 *      `dualWriteDashboardSync` swallows its errors, so a boolean derived
 *      from "it didn't throw" was structurally always true.
 *
 * Exit codes: 0 posted (a PG-sync miss is a WARN, not an error — the GDrive
 * write stands and the journal reconcile converges it) · 1 file write failed
 * (nothing posted) · 2 usage / contract violation.
 *
 * Usage (from servers/roo-state-manager/):
 *   node scripts/rsm-dashboard-append.mjs --machine myia-po-2023 --content-file msg.txt
 *
 * The .env at servers/roo-state-manager/.env is auto-loaded. The PG URL is
 * never printed.
 */

import { readFileSync, mkdirSync } from 'fs';
import { writeFile } from 'fs/promises';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';
import { randomInt } from 'node:crypto';
import { resolveBuildDir } from './lib/resolve-build-dir.mjs';
import { validateEscalationContent, buildListenerEscalationMessage, nextDashboardState } from './lib/dashboard-journal.mjs';

// --- .env loader (zero-dep, same contract as backfill-roosync-read-state.mjs) ---
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

function usageError(msg) {
  console.error(`ERREUR: ${msg}`);
  console.error('Usage: node scripts/rsm-dashboard-append.mjs --machine <id> (--content-file <f> | --content <text>)');
  process.exit(2);
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(`Usage: node scripts/rsm-dashboard-append.mjs [options]

  --machine <id>              Target machine (dashboard key machine-<id>).
  --content-file <f> | --content <text>
                              Escalation content, [TAG]-prefixed ([ERROR] refused).

The dashboard type is FIXED to machine by construction (#3761 condition 1):
there is no --type option, and passing one is a usage error. Author is
<machine>|listener. The read→fold→write runs under the cross-process append
lock (fail-open: unserialized=true when not acquired); the file write is
bounded by UNIFIED_STORE_DASHBOARD_GDRIVE_WRITE_TIMEOUT_MS. Exit 0/1/2.
Loads .env automatically.`);
  process.exit(0);
}

// #3761 condition 1, by construction: the escalation surface has no type
// argument. Refuse it loudly so a future caller cannot widen the surface
// without touching this guard.
if (args.includes('--type')) {
  usageError('--type n’existe pas sur cette surface : le dashboard est TOUJOURS machine-<id> (#3761 condition 1)');
}

const flagValue = (name) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
};
const known = new Set(['--machine', '--content-file', '--content', '--help', '-h']);
for (const a of args) {
  if (a.startsWith('--') && !known.has(a)) usageError(`option inconnue « ${a} »`);
}

const machine = flagValue('--machine');
const contentFile = flagValue('--content-file');
const contentInline = flagValue('--content');
if (!machine || machine.trim() === '') usageError('--machine <id> requis');
if ((contentFile === undefined) === (contentInline === undefined)) {
  usageError('exactement une source de contenu : --content-file <f> OU --content <texte>');
}
if (contentFile !== undefined && !/^[A-Za-z0-9._-]+$/.test(path.basename(contentFile))) {
  usageError(`--content-file attend un nom de fichier simple, reçu « ${contentFile} »`);
}

let content;
try {
  content = contentFile !== undefined ? readFileSync(contentFile, 'utf-8') : contentInline;
} catch (err) {
  usageError(`lecture de --content-file impossible : ${err instanceof Error ? err.message : String(err)}`);
}

const verdict = validateEscalationContent(content);
if (!verdict.ok) usageError(`contenu d’escalade refusé : ${verdict.error}`);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RSM_ROOT = path.resolve(__dirname, '..'); // servers/roo-state-manager/
loadEnv(path.join(RSM_ROOT, '.env'));

// Import from the SERVED build — this script must run the same serialization
// and store writes the MCP host serves, not a private copy (G-R pattern).
const buildDir = resolveBuildDir(RSM_ROOT);
const buildUrl = (rel) => pathToFileURL(path.join(buildDir, rel)).href;
const { dualWriteDashboardSyncChecked } = await import(
  buildUrl('services/unified-store/roosync-dashboard-store.js')
);
const {
  buildDashboardKey,
  createEmptyDashboard,
  readDashboardFile,
  getDashboardPath,
  buildDashboardMarkdown,
  acquireAppendLock,
  releaseAppendLock,
} = await import(buildUrl('tools/roosync/dashboard.js'));

// Same bound as the G-B lot 1 write halves, same call-time convention.
const gdriveWriteTimeoutMs = () =>
  Number(process.env.UNIFIED_STORE_DASHBOARD_GDRIVE_WRITE_TIMEOUT_MS) || 30000;

const machineId = machine.trim().toLowerCase();
const key = buildDashboardKey('machine', machineId, '');
const author = { machineId, workspace: 'listener' };

// Review item 2 (#3782): readDashboardFile is the CHOKE POINT — a retired key
// is invisible in both halves, and under the host read gate it is PG-first.
// (The first head's direct readDashboardFromPg bypassed the retirement guard.)
let dashboard = await readDashboardFile(key);
const base = dashboard ? 'file' : 'created';
if (!dashboard) dashboard = createEmptyDashboard('machine', key, author);

// Review item 1 (verrou append, fail-open): #3761 escalations must never be
// dropped, so an unacquired lock proceeds unserialized and says so. Holder
// shape = CondenseLockInfo (same as the cross-post path).
const holder = { machineId, workspace: 'listener', pid: process.pid, acquiredAt: new Date().toISOString() };
const lockOwned = await acquireAppendLock(key, holder);
const unserialized = !lockOwned;

// 4 chars in [0-9a-z] — parity with the PS `Get-Random` over 48..57 + 97..122.
let rand = '';
for (let i = 0; i < 4; i++) {
  const n = randomInt(36);
  rand += n < 10 ? String.fromCharCode(48 + n) : String.fromCharCode(87 + n); // 97-10
}

// process.exit inside the locked section would skip the finally (and leak the
// lock to its TTL): the section computes, exits happen AFTER the release.
let posted = false;
let output = null;
try {
  const message = buildListenerEscalationMessage({ machineId, content, nowIso: new Date().toISOString(), rand });
  const next = nextDashboardState(dashboard, message);
  const markdown = buildDashboardMarkdown(next);
  const target = getDashboardPath(key);

  // process.exit inside the locked section would skip the finally (and leak
  // the lock to its TTL); a top-level `return` is a SyntaxError in ESM.
  // The section computes into flags, the exit happens AFTER the release.
  let writeFailed = false;
  try {
    mkdirSync(path.dirname(target), { recursive: true });
    // Review item 1 (détention bornée): the writeFile carries the abort
    // signal, so a hung DriveFS kills the in-flight request at the bound —
    // the lock is released at the bound, not held indefinitely (07/10 class).
    await writeFile(target, markdown, {
      encoding: 'utf8',
      signal: AbortSignal.timeout(gdriveWriteTimeoutMs())
    });
  } catch (err) {
    writeFailed = true;
    console.error(`ERREUR: écriture GDrive impossible (${target}) : ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }

  if (!writeFailed) {
    posted = true;

  // Review item 3: Checked variant decides pgSynced — the void variant
  // swallows its errors, so "it didn't throw" proved nothing. The file half
  // stands either way; the journal reconcile converges a miss.
  let pgSynced = true;
  let pgSyncReason;
  try {
    const outcome = await dualWriteDashboardSyncChecked(next);
    pgSynced = outcome?.ok === true;
    if (!pgSynced) pgSyncReason = outcome?.reason ?? String(outcome);
  } catch (err) {
    pgSynced = false;
    pgSyncReason = err instanceof Error ? err.message : String(err);
  }
  if (!pgSynced) {
    console.error(`WARN: sync PG non confirmée (${pgSyncReason}) — l’écriture GDrive tient, le journal convergera`);
  }

    output = {
      ok: true,
      key,
      base,          // file | created — which half supplied the base state
      unserialized,  // true = the append lock could not be acquired (fail-open)
      messageId: message.id,
      totalMessages: next.intercom.totalMessages,
      pgSynced,
    };
  }
} finally {
  if (lockOwned) {
    await releaseAppendLock(key, holder);
  }
}

if (posted) {
  console.log(JSON.stringify(output));
}
process.exit(process.exitCode ?? 0);
