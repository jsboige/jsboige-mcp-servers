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
 *   - there is NO --type option on the escalation mode (passing --type is a
 *     usage error); the key is `machine-<id>`;
 *   - content must be [TAG]-prefixed and the tag must not be ERROR
 *     (machine dashboards escalate WARN-class events only);
 *   - author is `<machine>|listener`, msg id `<machine>:listener:ic-…`
 *     (parity with the previous format).
 *
 * #4090 additive fleet surface (user RX107, 19/10): `--dashboard
 * global|workspace:<name>` posts through the SAME dual-write path with a
 * REQUIRED stable `--message-id` (a re-post with the same id is a no-op) and
 * `--author-workspace` for the emitter's lane. [ERROR] is allowed there —
 * watchdog DOWN alerts legitimately carry it. The escalation contract above
 * is untouched and remains the default mode.
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
 *      Re-review on #4915 (po-2028 04:48Z pt 2, po-2024 05:00Z addendum):
 *      the PG-first attempt runs BETWEEN the base read and the file rewrite
 *      and can outlive the lock TTL (30 s, never renewed). After a failed
 *      attempt the fallback RE-TAKES the lock and re-reads its base before
 *      rewriting — a concurrent append that landed meanwhile is not erased.
 *   2. #3782: the base state comes from `readDashboardFile` — the choke
 *      point that makes a retired (merged-away) key invisible in BOTH
 *      halves. The first head called `readDashboardFromPg` directly, which
 *      would resurrect a retired machine key.
 *   3. `pgSynced` is decided by `dualWriteDashboardSyncChecked` — the void
 *      `dualWriteDashboardSync` swallows its errors, so a boolean derived
 *      from "it didn't throw" was structurally always true.
 *
 * PG-primary gate (#4915 — Phase D #4131): the CLI follows the SAME gate as
 * the MCP tool (`writeDashboardFile`, dashboard.ts). When
 * `isDashboardPgPrimary()` is true, PG is written FIRST (checked variant) and
 * the GDrive file is only a bounded mirror stamped `mirrorExportAt` — the
 * Phase D instrument counts a stamped file as an export, an unstamped one as
 * a residual write. When the gate is closed the file-first path is
 * byte-for-byte unchanged (no stamp). When PG fails, the file-first path
 * re-takes the lock and re-reads its base first (that attempt may have
 * outlived the lock TTL), then writes as before (no stamp): a #3761
 * escalation is never lost.
 *
 * Review ms#1919 (ai-01, 25/11 — two ways to lose an append that exists ONLY
 * in the file, i.e. one whose own PG attempt failed). The cause of both:
 * `readDashboardFile` answers from PG as soon as the key has a readable row
 * there, so a file-only append is invisible to it, and the CLI rewrites the
 * WHOLE file. The file half is therefore also read directly (`readFileHalf`),
 * under the re-taken lock, right before any file write:
 *   1. fallback after a PG failure — the messages present only in the file
 *      are folded into the re-read base (`withFileOnlyMessages`), so the
 *      rewrite keeps them and the post-write PG sync carries them to PG. The
 *      retirement guard is untouched: a key `readDashboardFile` does not
 *      answer for (retired, #3782) is never rebuilt from its file.
 *   2. PG success — the attempt can be LATE (past the lock TTL). A mirror
 *      written from the pre-attempt base would erase a file-only append and
 *      stamp the result as an export of PG. The lock is re-taken on success
 *      too; the mirror is written only when it is known not to drop
 *      anything: not written (and not stamped) when the lock could not be
 *      re-taken, when the file half could not be read, or when the file
 *      carries a message absent from the written state. `gdriveSkipped: true`
 *      says so in the JSON (nominal: PG holds the message), stderr says why.
 * The gate-closed path reads nothing more and is unchanged.
 *
 * Exit codes: 0 posted — at least one surface holds the message (a PG-sync
 * miss on the file-first path is a WARN, not an error: the GDrive write
 * stands and the journal reconcile converges it; a failed MIRROR under the
 * gate is a WARN too: PG holds the message) · 1 no surface held it (file
 * write failed) · 2 usage / contract violation.
 *
 * Usage (from servers/roo-state-manager/):
 *   node scripts/rsm-dashboard-append.mjs --machine myia-po-2023 --content-file msg.txt
 *
 * The .env at servers/roo-state-manager/.env is auto-loaded. The PG URL is
 * never printed.
 */

import { readFileSync, mkdirSync } from 'fs';
import { readFile, writeFile } from 'fs/promises';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';
import { randomInt } from 'node:crypto';
import { resolveBuildDir } from './lib/resolve-build-dir.mjs';
import { validateEscalationContent, validateTaggedContent, buildListenerEscalationMessage, buildAppendMessage, shouldDeduplicate, parseAppendArgs, nextDashboardState, fileOnlyMessages, withFileOnlyMessages } from './lib/dashboard-journal.mjs';

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

  --machine <id>              Author machine (dashboard key machine-<id> in
                              escalation mode).
  --content-file <f> | --content <text>
                              Content, [TAG]-prefixed.
  --dashboard <global|workspace:<name>>
                              #4090 fleet append — REQUIRES --message-id.
                              [ERROR] is allowed here; the machine
                              escalation below still refuses it.
  --message-id <stable id>    Idempotence key: a re-post with the same id is
                              a no-op (charset [A-Za-z0-9._:-], <=128).
  --author-workspace <ws>     Author workspace for --dashboard (default
                              listener; e.g. qdrant-watchdog).

Default mode (no --dashboard): machine-<id> escalation, WARN-class only,
author <machine>|listener, generated id — the #3761 contract, unchanged.
The read→fold→write runs under the cross-process append lock (fail-open:
unserialized=true when not acquired); the file write is bounded by
UNIFIED_STORE_DASHBOARD_GDRIVE_WRITE_TIMEOUT_MS. Exit 0/1/2.
Loads .env automatically.`);
  process.exit(0);
}

// #3761 condition 1, by construction: the escalation surface has no type
// argument. Refuse it loudly so a future caller cannot widen the surface
// without touching this guard.
if (args.includes('--type')) {
  usageError('--type n’existe pas sur cette surface : le dashboard est TOUJOURS machine-<id> (#3761 condition 1)');
}

const parsed = parseAppendArgs(args);
if (parsed.error) usageError(parsed.error);

const {
  mode,
  machineId: machineArg,
  contentFile,
  contentInline,
  dashboard: dashboardTarget,
  messageId,
  authorWorkspace,
} = parsed;
if (contentFile !== undefined && !/^[A-Za-z0-9._-]+$/.test(path.basename(contentFile))) {
  usageError(`--content-file attend un nom de fichier simple, reçu « ${contentFile} »`);
}

let content;
try {
  content = contentFile !== undefined ? readFileSync(contentFile, 'utf-8') : contentInline;
} catch (err) {
  usageError(`lecture de --content-file impossible : ${err instanceof Error ? err.message : String(err)}`);
}

// #4090: fleet surfaces legitimately carry [ERROR] (watchdog DOWN alerts);
// the machine-escalation guard stays as-is.
const verdict = mode === 'dashboard' ? validateTaggedContent(content) : validateEscalationContent(content);
if (!verdict.ok) usageError(`contenu refusé : ${verdict.error}`);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RSM_ROOT = path.resolve(__dirname, '..'); // servers/roo-state-manager/
loadEnv(path.join(RSM_ROOT, '.env'));

// Import from the SERVED build — this script must run the same serialization
// and store writes the MCP host serves, not a private copy (G-R pattern).
const buildDir = resolveBuildDir(RSM_ROOT);
const buildUrl = (rel) => pathToFileURL(path.join(buildDir, rel)).href;
const { dualWriteDashboardSyncChecked, isDashboardPgPrimary } = await import(
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

// The served markdown PARSER, loaded on first use: it ships since #3151
// Phase C (dashboard.ts delegates the format to it), but only the gated paths
// below read the file half — a vintage that predated it must not be able to
// break the gate-closed path at import time.
let fileHalfParser = null;
async function parseFileHalf(content, key) {
  fileHalfParser ??= (await import(buildUrl('tools/roosync/dashboard-markdown.js'))).parseDashboardMarkdown;
  return fileHalfParser(content, key);
}

// The FILE half, as it is on disk NOW (review ms#1919): `readDashboardFile`
// answers from PG as soon as the key has a readable row there (dashboard.ts),
// so a message that exists only in the file is invisible to it. Same bound and
// same CRLF normalisation as the tool's own file read. `error` is null for a
// missing file (nothing to preserve) and carries the reason otherwise — a
// caller must never rewrite a half it could not check.
async function readFileHalf(filePath, key) {
  let content;
  try {
    content = await readFile(filePath, {
      encoding: 'utf8',
      signal: AbortSignal.timeout(gdriveWriteTimeoutMs())
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { state: null, error: err?.code === 'ENOENT' ? null : reason };
  }
  try {
    return { state: await parseFileHalf(content.replace(/\r\n/g, '\n'), key), error: null };
  } catch (err) {
    return { state: null, error: err instanceof Error ? err.message : String(err) };
  }
}

const machineId = machineArg.trim().toLowerCase();
// #4090: --dashboard selects the fleet surface; absent it stays the machine
// escalation key by construction (#3761). Message ids stay machine-prefixed
// in both modes so authorship and filtering keep working downstream.
const key = dashboardTarget
  ? buildDashboardKey(dashboardTarget.type, machineId, dashboardTarget.workspace ?? '')
  : buildDashboardKey('machine', machineId, '');
const author = { machineId, workspace: authorWorkspace };

// Review item 1 (verrou append, fail-open): #3761 escalations must never be
// dropped, so an unacquired lock proceeds unserialized and says so. Holder
// shape = CondenseLockInfo (same as the cross-post path). The holder is
// re-issued at every take: `acquiredAt` is part of the ownership check and
// starts the TTL (dashboard.ts — 30 s, never renewed).
const newHolder = () => ({ machineId, workspace: 'listener', pid: process.pid, acquiredAt: new Date().toISOString() });
const holder = newHolder();
let ownedHolder = (await acquireAppendLock(key, holder)) ? holder : null;
let unserialized = ownedHolder === null;

// Re-review #4915 (po-2028 04:48Z point 2, po-2024 05:00Z addendum): the
// PG-first attempt below sits BETWEEN the base read and the full file rewrite,
// and can outlive the lock TTL (the re-review measures the attempt at ~46,5 s
// of connection timeouts against 30 s). Past the TTL another writer may have
// taken the lock and appended: the lock held here is then stale, and a rewrite
// from the pre-attempt base would erase that append — its only copy, since PG
// is the half that failed. Release-then-acquire: a stolen lock is not released
// (holder mismatch, dashboard.ts) and a fresh `acquiredAt` restarts the TTL.
// Both PG halves are bounded (3 s) and never throw, so this adds no unbounded
// wait to the fallback. Review ms#1919: called after the attempt on BOTH
// outcomes — a success can be late too, and the mirror then faces the same
// stale lock (and a file-only append it must not erase).
async function retakeAppendLock() {
  if (ownedHolder) {
    await releaseAppendLock(key, ownedHolder);
    ownedHolder = null;
  }
  const candidate = newHolder();
  if (await acquireAppendLock(key, candidate)) {
    ownedHolder = candidate;
  }
  return ownedHolder !== null;
}

// Review item 1 (re-review 11:04Z): the base read runs UNDER the lock — a
// pre-lock snapshot would fold on stale state and overwrite the previous
// holder's message in the file half, the exact race the lock closes. The MCP
// writer reads inside the lock too (cross-post path, dashboard.ts ~l.2224).
// Review item 2 (#3782): readDashboardFile is the CHOKE POINT — a retired key
// is invisible in both halves, and under the host read gate it is PG-first.
// (The first head's direct readDashboardFromPg bypassed the retirement guard.)
// G-C step 2 (APPROVE ms#1425 non-blocking note): the read also lives INSIDE
// the try/finally below — a throwing read (retirement lookup, PG or GDrive
// read error) used to kill the process still holding the lock, leaking it to
// its 30 s TTL; under the try it fails with the lock released.
let dashboard;
let base = 'created';

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
  dashboard = await readDashboardFile(key);
  // Review ms#1919: null here means the key is absent OR retired (#3782). The
  // file half (read below, gated paths only) is consulted for a key this choke
  // point declared live — a retired key's file is never rebuilt into a write.
  let liveKey = dashboard !== null;
  if (dashboard) {
    base = 'file';
  } else {
    dashboard = createEmptyDashboard(dashboardTarget ? dashboardTarget.type : 'machine', key, author);
  }

  // #4090 idempotence: a stable id already present means this exact alert was
  // already posted. Fold/write are skipped — no second message, no counter
  // bump — and the JSON says so. This runs INSIDE the lock so two concurrent
  // posters of the same id cannot both miss it; the re-check after a failed PG
  // attempt (below) keeps that promise when the lock had expired meanwhile.
  let deduplicated = shouldDeduplicate(dashboard, messageId ?? null);
  let message = null;
  let next = null;
  // `null` = gate closed (no attempt); otherwise the attempt's own verdict.
  let pgFirst = null;
  // Review ms#1919 item 2: set when the GDrive mirror must NOT be written.
  let mirrorSkip = null;
  // Resolved once per gated append: the freshness check and the write share it.
  let resolvedPath = null;
  if (!deduplicated) {
    const nowIso = new Date().toISOString();
    message = mode === 'dashboard'
      ? buildAppendMessage({ machineId, workspace: authorWorkspace, content, messageId, nowIso, rand })
      : buildListenerEscalationMessage({ machineId, content, nowIso, rand });
    next = nextDashboardState(dashboard, message);

    // #4915 PG-primary gate — the same gate as `writeDashboardFile`
    // (dashboard.ts), applied by hand rather than by delegation: the tool
    // returns no PG verdict on its file-first path (void dual-write) while
    // `pgSynced` below feeds the PS callers' logs; and it redacts (#3584),
    // stages and re-reads the store — behaviour the gate-closed path must not
    // gain (byte-for-byte unchanged here). Decided BEFORE the markdown is
    // built: the stamp is part of the bytes.
    if (isDashboardPgPrimary()) {
      try {
        const outcome = await dualWriteDashboardSyncChecked(next);
        pgFirst = { ok: outcome?.ok === true, reason: outcome?.reason };
      } catch (err) {
        pgFirst = { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
      // Review ms#1919: the attempt above sits between the lock take and the
      // file write and can outlive the append lock TTL (30 s, never renewed) —
      // a SUCCESS can be late too. The lock is re-taken on BOTH outcomes, and
      // nothing reads or writes the file before that.
      const relocked = await retakeAppendLock();
      resolvedPath = getDashboardPath(key);
      if (pgFirst.ok) {
        // The file is only the mirror here: it is rewritten only when that is
        // known not to drop anything. A skip costs nothing — PG (the primary
        // half) holds the message — whereas a mirror written from the
        // pre-attempt state erases a file-only append and stamps the result as
        // an export of PG.
        if (!relocked) {
          mirrorSkip = 'verrou append non repris (un autre détenteur écrit la clé)';
        } else {
          const fileHalf = liveKey ? await readFileHalf(resolvedPath, key) : { state: null, error: null };
          if (fileHalf.error !== null) {
            mirrorSkip = `moitié fichier illisible (${fileHalf.error})`;
          } else if (fileOnlyMessages(next, fileHalf.state).length > 0) {
            mirrorSkip = 'le fichier porte un ajout absent de l’état écrit dans PG';
          }
        }
      } else {
        console.error(`WARN: porte PG-primaire ouverte, écriture PG en échec (${pgFirst.reason}) — repli sur le chemin fichier d’abord, sans tampon`);
        // Re-review #4915: the lock taken at the top may be stale and the
        // fallback below rewrites the WHOLE file. Re-read under the fresh
        // lock, then fold on what is on disk NOW. Fail-open as at the top: a
        // lock that cannot be re-taken (a stolen one is live) proceeds
        // unserialized and says so — the re-read still runs.
        unserialized = !relocked;
        dashboard = await readDashboardFile(key);
        if (dashboard) {
          base = 'file';
          // Review ms#1919 item 1: this read answers from PG as soon as the
          // key has a readable row — it does not show an append that exists
          // only in the file. Fold those in: the rewrite keeps them, and the
          // post-write PG sync below carries them to PG.
          const fileHalf = await readFileHalf(resolvedPath, key);
          if (fileHalf.error !== null) {
            console.error(`WARN: moitié fichier illisible (${fileHalf.error}) — repli sans vérification des ajouts uniquement fichier`);
          }
          dashboard = withFileOnlyMessages(dashboard, fileHalf.state);
        } else {
          // Absent or retired (#3782): the file half is NOT consulted — the
          // retirement guard keeps the last word on what a retired key holds.
          dashboard = createEmptyDashboard(dashboardTarget ? dashboardTarget.type : 'machine', key, author);
          base = 'created';
        }
        deduplicated = shouldDeduplicate(dashboard, messageId ?? null);
        if (!deduplicated) {
          next = nextDashboardState(dashboard, message);
        }
      }
    }
  }

  if (deduplicated) {
    posted = true;
    output = {
      ok: true,
      key,
      base,
      deduplicated: true,
      messageId,
      totalMessages: dashboard.intercom.totalMessages ?? dashboard.intercom.messages.length,
    };
  } else if (mirrorSkip !== null) {
    // Review ms#1919 item 2: PG (the primary half) holds the message; the
    // mirror is neither rewritten nor stamped. Nominal state, said in stderr.
    posted = true;
    console.error(`WARN: miroir GDrive non écrit — ${mirrorSkip} ; le store PG (primaire) tient le message`);
    output = {
      ok: true,
      key,
      base,
      unserialized,
      messageId: message.id,
      totalMessages: next.intercom.totalMessages,
      pgSynced: true,
      gdriveSkipped: true, // the GDrive mirror was NOT written at this append; PG holds the message
    };
  } else {
    const pgMirrorMode = pgFirst?.ok === true;
    // Stamp at write time, as the tool does: the instrument compares it to
    // the file mtime.
    const exportStamp = pgMirrorMode ? { mirrorExportAt: new Date().toISOString() } : undefined;
    const markdown = buildDashboardMarkdown(next, exportStamp);
    // Gate-closed: resolved here, exactly where it always was.
    const targetPath = resolvedPath ?? getDashboardPath(key);

    // process.exit inside the locked section would skip the finally (and leak
    // the lock to its TTL); a top-level `return` is a SyntaxError in ESM.
    // The section computes into flags, the exit happens AFTER the release.
    let writeFailed = false;
    let mirrorFailure;
    try {
      mkdirSync(path.dirname(targetPath), { recursive: true });
      // Review item 1 (détention bornée): the writeFile carries the abort
      // signal, so a hung DriveFS kills the in-flight request at the bound —
      // the lock is released at the bound, not held indefinitely (07/10 class).
      await writeFile(targetPath, markdown, {
        encoding: 'utf8',
        signal: AbortSignal.timeout(gdriveWriteTimeoutMs())
      });
    } catch (err) {
      writeFailed = true;
      const reason = err instanceof Error ? err.message : String(err);
      if (pgMirrorMode) {
        // #4915: under the gate the file is only the mirror — PG holds the
        // message, so a failed mirror degrades, it never loses the escalation.
        mirrorFailure = reason;
        console.error(`WARN: écriture du miroir GDrive impossible (${targetPath}) : ${reason} — le store PG (primaire) tient le message`);
      } else {
        console.error(`ERREUR: écriture GDrive impossible (${targetPath}) : ${reason}`);
        process.exitCode = 1;
      }
    }

    // #4915: a failed MIRROR still leaves the message posted (PG is primary);
    // a failed file-first write posts nothing.
    if (!writeFailed || pgMirrorMode) {
      posted = true;

      // Review item 3: Checked variant decides pgSynced — the void variant
      // swallows its errors, so "it didn't throw" proved nothing. The file half
      // stands either way; the journal reconcile converges a miss.
      // #4915: in mirror mode PG was written first — that one attempt is the
      // verdict (no second write). Otherwise the pre-existing post-write sync.
      let pgSynced = true;
      let pgSyncReason;
      if (!pgMirrorMode) {
        try {
          const outcome = await dualWriteDashboardSyncChecked(next);
          pgSynced = outcome?.ok === true;
          if (!pgSynced) pgSyncReason = outcome?.reason ?? String(outcome);
        } catch (err) {
          pgSynced = false;
          pgSyncReason = err instanceof Error ? err.message : String(err);
        }
      }
      if (!pgSynced) {
        console.error(`WARN: sync PG non confirmée (${pgSyncReason}) — l’écriture GDrive tient, le journal convergera`);
      }

      output = {
        ok: true,
        key,
        base,          // file = a live dashboard supplied the base (PG-first under the read gate) | created
        unserialized,  // true = the append lock could not be acquired (fail-open)
        messageId: message.id,
        totalMessages: next.intercom.totalMessages,
        pgSynced,
      };
      if (mirrorFailure !== undefined) {
        output.gdriveDegraded = mirrorFailure; // the GDrive mirror failed; PG holds the message
      }
    }
  }
} finally {
  if (ownedHolder) {
    await releaseAppendLock(key, ownedHolder);
  }
}

if (posted) {
  console.log(JSON.stringify(output));
}
process.exit(process.exitCode ?? 0);
