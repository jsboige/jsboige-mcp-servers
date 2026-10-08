// #2591 / #4131 grain G-M — store-level sweep of orphan [MENTION] notifications.
//
// `bulkOperation` (the only bulk archive the MCP exposes) filters via
// matchesRecipient(message.to, machineId, …) — it only ever sees the LOCAL
// inbox, so a notification addressed to a recipient that does not exist is
// reachable by NONE of its filters. This script is the store-level sweep the
// mandate asks for: it walks the whole shared inbox, classifies every
// recipient, and archives the orphan [MENTION] notifications.
//
// Classification mirrors the shipped guard (src/utils/dashboard-helpers.ts):
// a recipient is KEPT when it is (a) a bare fleet machine id `myia-*`,
// (b) a lane address `myia-*:<workspace>` — the trap my first dry-run fell
// into: 3814 legitimate lane addresses miscounted as orphans, a sweep built
// on that classifier would have destroyed 3.7× the target population — or
// (c) an explicit out-of-shape live consumer (review ms#1408 + ms#1413):
// `nanoclaw-cluster` (the poller's machine id), its own lane address, and the
// two v3 targets the poller reads. The production guard only sees v1 prose
// mentions (bare tokens, no ':' possible), so this classifier is a SUPERSET
// by design — it adds the 'lane' class for store traffic the guard never
// receives. A drift-guard test
// (tests/unit/archive-orphan-mention-notifications.test.ts) pins the subset
// invariant: the sweep never archives anything the production guard keeps, and
// agrees totally on the bare-token population.
//
// REVIEW ms#1413 — four corrections, all fail-closed:
//
//   1. NanoClaw lanes are out-of-shape extras, not orphans. The first version
//      matched the extras list by FULL ADDRESS ONLY (`extras.includes(r)`), so
//      a lane-shaped live target (`nanoclaw-cluster:nanoclaw`) fell through to
//      `orphan` and would have been archived — the exact consumer the list
//      exists to protect. Extras now match the same way the `myia-*` pattern
//      does: exact address, plus (for a bare entry) its own lane addresses.
//      `cluster-manager:nanoclaw-cluster` is excluded conservatively: it is
//      not a measured consumer, it is not worth the risk of archiving it.
//   2. Source and destination are confined and frozen. The manifest records
//      inbox AND archive; the apply pass requires both to be provided by the
//      live invocation and to agree with the manifest, validates every row's
//      file name as a JSON basename, resolves it inside its root, and refuses
//      links/junctions at every traversed boundary. It also fixes the doubled
//      archive path: `--inbox <store>/messages/inbox` used to derive
//      `<store>/messages/messages/archive`; the archive is now the SIBLING of
//      the inbox dir.
//   3. The authorized scope is revalidated live. The `[MENTION]` subject is
//      enforced at apply time from the message on disk, not from the manifest,
//      and a manifest that widened the scope (`includeNonMention`) is refused
//      unless the live invocation opted in too.
//   4. The CLI result is propagated (`process.exitCode = main()`), so a
//      fail-closed refusal is observable by the caller instead of being a
//      silent success.
//
// Scope guard: ONLY `[MENTION]`-subjected messages are selected by default —
// that is the population the RX92 accord (08/10, ai-01 registry) authorizes.
// The ~18 deliberately mis-addressed direct sends are NOT in that
// authorization; --include-non-mention exists for a future explicit one, and
// must be passed to BOTH passes.
//
// Usage:
//   node scripts/archive-orphan-mention-notifications.mjs --manifest <path>            # dry-run (default)
//   node scripts/archive-orphan-mention-notifications.mjs --manifest <path> --live     # apply
//   node scripts/archive-orphan-mention-notifications.mjs --manifest <path> --limit 20 # canary dry-run
//   --inbox <path> overrides the store (default: $ROOSYNC_SHARED_PATH/messages/inbox,
//   ROOSYNC_SHARED_PATH resolved from env or the server .env, fail-closed). The archive
//   is the sibling `archive/` of the inbox dir.
//
// The dry-run manifest IS the pre-image: one row per candidate file with its
// sha256 BEFORE any move. --live re-reads, re-hashes, re-classifies AND
// re-checks the subject of every row against the live store before moving (a
// file that changed, moved, or no longer qualifies is skipped, never assumed)
// and moves inbox/<file> -> archive/<file> (the MessageManager archive
// convention). Malformed, repeated or unknown arguments exit 2 — same
// fail-closed rules as scripts/orphan-repair.mjs.
import { createHash } from 'crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const RSM_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── Classification (mirrors src/utils/dashboard-helpers.ts — drift-guarded) ──

const FLEET_MACHINE_PATTERN = /^myia-[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Out-of-shape live consumers — MUST stay identical to
 * DEFAULT_EXTRA_MENTION_RECIPIENTS in src/utils/dashboard-helpers.ts
 * (drift-guard test asserts the two lists are equal).
 *
 * `nanoclaw-cluster` is the poller's machine id (review ms#1408). The two
 * v3 targets (`nanoclaw:agent`, `nanoclaw:nanoclaw`) and the poller's own lane
 * address are the ms#1413 additions: the poller reads messages addressed to
 * each of them, so archiving one is archiving a live consumer's mail.
 * `cluster-manager:nanoclaw-cluster` is added conservatively — not a measured
 * consumer, and the cost of keeping a dead notification is a directory entry,
 * while the cost of archiving a live one is a silently dropped message.
 *
 * Do NOT add a bare `nanoclaw` / `NanoClaw`: those are measured orphans
 * (87/56/25 unread, no consumer) and a bare entry would also keep `nanoclaw:*`.
 */
const DEFAULT_EXTRA_MENTION_RECIPIENTS = [
  'nanoclaw-cluster',
  'nanoclaw:agent',
  'nanoclaw:nanoclaw',
  'cluster-manager:nanoclaw-cluster'
];

export function loadExtraRecipients(env = process.env) {
  const raw = env.ROO_MENTION_EXTRA_RECIPIENTS;
  const parsed = raw ? raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean) : [];
  return [...new Set([...DEFAULT_EXTRA_MENTION_RECIPIENTS, ...parsed])];
}

/**
 * Explicit-list match, symmetric with FLEET_MACHINE_PATTERN: an exact address,
 * plus — for a BARE entry (no ':') — its own lane addresses `entry:<workspace>`.
 *
 * Case-insensitive: the extras list is lowercased at load, and a message
 * addressed to `NanoClaw-Cluster:NanoClaw` is the same consumer as
 * `nanoclaw-cluster:nanoclaw`. Compared to the previous `extras.includes(r)`
 * this is both wider (lane addresses now match) and safer (case no longer
 * decides whether a live consumer's mail survives).
 */
function extraRecipientMatches(recipient, extras) {
  const r = recipient.toLowerCase();
  return extras.some(e => r === e || (!e.includes(':') && r.startsWith(`${e}:`)));
}

export function classifyRecipient(to, extras = loadExtraRecipients()) {
  const r = typeof to === 'string' ? to : '';
  if (!r) return 'orphan';
  if (FLEET_MACHINE_PATTERN.test(r)) return 'fleet';
  const head = r.split(':', 1)[0];
  if (r.includes(':') && FLEET_MACHINE_PATTERN.test(head)) return 'lane';
  if (extraRecipientMatches(r, extras)) return 'extra';
  return 'orphan';
}

export function isOrphanRecipient(to) {
  return classifyRecipient(to) === 'orphan';
}

// ── Confinement helpers (review ms#1413 point 2) ─────────────────────────────

/**
 * A row's file name must be a plain JSON basename. Everything else is refused
 * — traversal (`../x.json`), a path (`a/b.json`), a Windows drive or ADS
 * reference (`C:x.json`, `x.json:stream`, the NTFS ADS trap), a directory
 * entry (`.`, `..`), a NUL byte. This is the first barrier; `assertInsideRoot`
 * is the second, independent one.
 */
function assertJsonBasename(name, what) {
  const ok = typeof name === 'string'
    && name.length > 0
    && name.endsWith('.json')
    && name !== '.json'
    && !name.includes('/')
    && !name.includes('\\')
    && !name.includes(':')
    && !name.includes('\0')
    && path.basename(name) === name;
  if (!ok) throw new Error(`Refusing ${what}: not a JSON basename (${JSON.stringify(name)})`);
  return name;
}

/** A traversed boundary must be a real directory, never a link or junction. */
function assertRealDir(dir, what) {
  const resolved = path.resolve(dir);
  let st;
  try {
    st = lstatSync(resolved);
  } catch {
    throw new Error(`Refusing ${what}: does not exist (${resolved})`);
  }
  if (st.isSymbolicLink()) throw new Error(`Refusing ${what}: is a link/junction (${resolved})`);
  if (!st.isDirectory()) throw new Error(`Refusing ${what}: is not a directory (${resolved})`);
  return resolved;
}

/** The resolved candidate must sit inside the resolved root. */
function assertInsideRoot(root, candidate) {
  const r = path.resolve(root);
  const c = path.resolve(candidate);
  if (c !== r && !c.startsWith(r + path.sep)) {
    throw new Error(`Refusing path escaping ${r}: ${c}`);
  }
  return c;
}

function pathExists(p) {
  try { lstatSync(p); return true; } catch { return false; }
}

// ── Store helpers ────────────────────────────────────────────────────────────

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function recipientOf(msg) {
  const to = msg.to;
  if (typeof to === 'string') return to;
  if (to && typeof to === 'object') return String(to.machineId ?? to.machine ?? '');
  return '';
}

function isMentionSubject(subject) {
  return String(subject ?? '').toUpperCase().startsWith('[MENTION]');
}

export function scanInbox(inboxPath, { includeNonMention = false, limit } = {}) {
  const entries = readdirSync(inboxPath, { withFileTypes: true })
    .filter(e => e.name.endsWith('.json'))
    .sort((a, b) => a.name.localeCompare(b.name));
  const kept = { fleet: 0, lane: 0, extra: 0 };
  const unreadable = [];
  const unsafe = [];
  const orphans = [];
  for (const entry of entries) {
    const file = entry.name;
    // A symlink or a directory named *.json is not a message: never selected,
    // and reported so an operator can see the store is not what it looks like.
    if (!entry.isFile()) {
      unsafe.push(file);
      continue;
    }
    let msg;
    try {
      msg = JSON.parse(readFileSync(path.join(inboxPath, file), 'utf-8'));
    } catch {
      unreadable.push(file);
      continue;
    }
    const cls = classifyRecipient(recipientOf(msg));
    if (cls !== 'orphan') {
      kept[cls]++;
      continue;
    }
    const subject = String(msg.subject ?? '');
    if (!includeNonMention && !isMentionSubject(subject)) continue;
    if (limit && orphans.length >= limit) continue;
    orphans.push({
      file,
      id: msg.id ?? file.replace(/\.json$/, ''),
      to: recipientOf(msg) || null,
      from: msg.from ?? null,
      timestamp: msg.timestamp ?? null,
      subject: subject.slice(0, 120),
      sha256: sha256(readFileSync(path.join(inboxPath, file), 'utf-8'))
    });
  }
  return { files: entries.length, kept, unreadable, unsafe, orphans };
}

export function runDryRun({ inboxPath, archivePath, manifestPath, includeNonMention = false, limit }) {
  if (!archivePath) throw new Error('runDryRun requires archivePath (it is frozen in the manifest)');
  const inboxRoot = assertRealDir(inboxPath, 'inbox');
  const archiveRoot = path.resolve(archivePath);
  if (archiveRoot === inboxRoot) throw new Error('Refusing: inbox and archive resolve to the same directory');
  if (archiveRoot.startsWith(inboxRoot + path.sep)) throw new Error('Refusing: archive is inside the inbox');

  const result = scanInbox(inboxRoot, { includeNonMention, limit });
  const manifest = {
    mode: 'dry-run',
    generatedAt: new Date().toISOString(),
    inbox: inboxRoot,
    archive: archiveRoot,
    includeNonMention,
    limit: limit ?? null,
    scanned: result.files,
    kept: result.kept,
    unreadable: result.unreadable.length,
    unsafe: result.unsafe.length,
    selected: result.orphans.length,
    rows: result.orphans
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 1), 'utf-8');
  return manifest;
}

/**
 * Apply a dry-run pre-image. Every row is re-verified against the LIVE store
 * (existence, sha256, recipient classification AND subject scope) — the
 * manifest is never trusted for eligibility, only for intent.
 *
 * `inboxPath` and `archivePath` are required and must agree with the frozen
 * manifest: a live invocation that walks a different store than the one the
 * pre-image was taken from is refused before any move.
 */
export function applyManifest({ manifestPath, inboxPath, archivePath, includeNonMention = false }) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  if (manifest.mode !== 'dry-run') {
    throw new Error(`Refusing to apply a manifest with mode '${manifest.mode}' (expected 'dry-run')`);
  }
  if (!Array.isArray(manifest.rows)) {
    throw new Error('Manifest has no rows array — refusing');
  }
  if (typeof manifest.inbox !== 'string' || !manifest.inbox) {
    throw new Error('Manifest has no inbox — refusing (the pre-image must name the store it was taken from)');
  }
  if (typeof manifest.archive !== 'string' || !manifest.archive) {
    throw new Error('Manifest has no archive — refusing (the pre-image must name the destination)');
  }
  if (!inboxPath) throw new Error('applyManifest requires the live inboxPath — refusing');
  if (!archivePath) throw new Error('applyManifest requires the live archivePath — refusing');
  if (path.resolve(manifest.inbox) !== path.resolve(inboxPath)) {
    throw new Error(`Refusing: live inbox ${path.resolve(inboxPath)} does not match the manifest's ${path.resolve(manifest.inbox)}`);
  }
  if (path.resolve(manifest.archive) !== path.resolve(archivePath)) {
    throw new Error(`Refusing: live archive ${path.resolve(archivePath)} does not match the manifest's ${path.resolve(manifest.archive)}`);
  }
  // Scope widening is opt-in on BOTH passes: a manifest that widened the
  // selection cannot be applied by a run that did not ask for it (and vice
  // versa — applying a [MENTION]-only pre-image with the wider flag would move
  // rows the operator never saw listed).
  if (Boolean(manifest.includeNonMention) !== Boolean(includeNonMention)) {
    throw new Error(`Refusing: scope mismatch — manifest includeNonMention=${Boolean(manifest.includeNonMention)}, invocation=${Boolean(includeNonMention)}`);
  }

  const inboxRoot = assertRealDir(manifest.inbox, 'inbox');
  mkdirSync(path.resolve(archivePath), { recursive: true });
  const archiveRoot = assertRealDir(archivePath, 'archive');

  const outcomes = { moved: [], missing: [], changed: [], reclassified: [], collision: [] };
  for (const row of manifest.rows) {
    // Confinement is per row: a tampered manifest cannot make the pass write
    // outside the two roots, whatever it claims.
    assertJsonBasename(row && row.file, 'manifest row file');
    const src = assertInsideRoot(inboxRoot, path.join(inboxRoot, row.file));
    const dst = assertInsideRoot(archiveRoot, path.join(archiveRoot, row.file));

    if (!pathExists(src)) { outcomes.missing.push(row.file); continue; }
    const srcStat = lstatSync(src);
    if (srcStat.isSymbolicLink() || !srcStat.isFile()) { outcomes.changed.push(row.file); continue; }

    let msg;
    try {
      msg = JSON.parse(readFileSync(src, 'utf-8'));
    } catch {
      outcomes.changed.push(row.file);
      continue;
    }
    if (sha256(readFileSync(src, 'utf-8')) !== row.sha256) { outcomes.changed.push(row.file); continue; }
    if (!isOrphanRecipient(recipientOf(msg))) { outcomes.reclassified.push(row.file); continue; }
    // Scope revalidated live (point 3): the subject on disk decides, not the
    // manifest. A message whose recipient is still an orphan but whose subject
    // is no longer `[MENTION]` is outside the authorized population — skipped,
    // and reported in `reclassified` alongside the recipient-level skips.
    if (!includeNonMention && !isMentionSubject(msg.subject)) { outcomes.reclassified.push(row.file); continue; }
    if (pathExists(dst)) { outcomes.collision.push(row.file); continue; }
    renameSync(src, dst);
    outcomes.moved.push(row.file);
  }

  const applied = {
    mode: 'applied',
    appliedAt: new Date().toISOString(),
    sourceManifest: manifestPath,
    inbox: inboxRoot,
    archive: archiveRoot,
    ...Object.fromEntries(Object.entries(outcomes).map(([k, v]) => [k, v.length])),
    outcomes
  };
  writeFileSync(manifestPath + '.applied.json', JSON.stringify(applied, null, 1), 'utf-8');
  return applied;
}

// ── CLI (fail-closed: unknown/repeated/missing args exit 2) ─────────────────

function loadServerEnv() {
  const envFile = path.join(RSM_ROOT, '.env');
  if (!existsSync(envFile)) return {};
  const out = {};
  for (const line of readFileSync(envFile, 'utf-8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return out;
}

function fail(msg) {
  console.error(`[archive-orphan-mention-notifications] ${msg}`);
  process.exit(2);
}

/**
 * The archive directory is the SIBLING of the inbox directory
 * (`<store>/messages/inbox` -> `<store>/messages/archive`). The previous
 * version derived it as `dirname(--inbox)/messages/archive`, which produced
 * `<store>/messages/messages/archive` for the documented `--inbox` form: the
 * apply pass would have created a phantom tree and moved nothing into the real
 * archive. This form is correct for the default (`<shared>/messages/inbox`) and
 * for any explicit inbox path, and it is frozen in the manifest so the apply
 * pass cannot drift from it.
 */
export function archiveSiblingOf(inboxPath) {
  return path.join(path.dirname(path.resolve(inboxPath)), 'archive');
}

export function main(argv = process.argv.slice(2)) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--live') args.live = true;
    else if (a === '--include-non-mention') args.includeNonMention = true;
    else if (a === '--help' || a === '-h') { console.log(usage()); process.exit(0); }
    else if (a === '--inbox' || a === '--manifest' || a === '--limit') {
      const v = argv[++i];
      if (v === undefined) fail(`${a} requires a value`);
      const key = a.slice(2);
      if (args[key] !== undefined) fail(`${a} given twice`);
      args[key] = v;
    } else fail(`unknown argument '${a}'`);
  }
  if (!args.manifest) fail('--manifest <path> is required (it is also the pre-image of the apply pass)');
  const limit = args.limit !== undefined ? parseInt(args.limit, 10) : undefined;
  if (args.limit !== undefined && (!Number.isInteger(limit) || limit < 1)) fail('--limit must be a positive integer');

  const serverEnv = loadServerEnv();
  const shared = process.env.ROOSYNC_SHARED_PATH || serverEnv.ROOSYNC_SHARED_PATH;
  const inboxPath = args.inbox || (shared ? path.join(shared, 'messages', 'inbox') : undefined);
  if (!inboxPath) fail('no inbox: --inbox <path>, or ROOSYNC_SHARED_PATH (env or server .env)');
  if (!existsSync(inboxPath)) fail(`inbox not found: ${inboxPath}`);
  const archivePath = archiveSiblingOf(inboxPath);

  if (!args.live) {
    const m = runDryRun({
      inboxPath,
      archivePath,
      manifestPath: args.manifest,
      includeNonMention: args.includeNonMention,
      limit
    });
    console.log(`[dry-run] scanned=${m.scanned} kept=${JSON.stringify(m.kept)} unreadable=${m.unreadable} unsafe=${m.unsafe}`);
    console.log(`[dry-run] inbox=${m.inbox} archive=${m.archive}`);
    console.log(`[dry-run] selected ${m.selected} orphan ${m.includeNonMention ? 'messages' : '[MENTION] notifications'} -> ${args.manifest}`);
    console.log('[dry-run] nothing was moved. Apply with --live (same manifest).');
    return 0;
  }

  if (!existsSync(args.manifest)) {
    fail('--live requires an existing dry-run manifest (run without --live first)');
  }
  const applied = applyManifest({
    manifestPath: args.manifest,
    inboxPath,
    archivePath,
    includeNonMention: args.includeNonMention
  });
  const skipped = applied.missing + applied.changed + applied.reclassified + applied.collision;
  console.log(`[live] moved=${applied.moved} missing=${applied.missing} changed=${applied.changed} reclassified=${applied.reclassified} collision=${applied.collision}`);
  console.log(`[live] pre-image manifest kept at ${args.manifest}; outcomes at ${args.manifest}.applied.json`);
  // 0 = the pass ran over the pre-image (rows moved and/or rows skipped for a
  // named reason, all accounted for in the report). 1 = the pre-image was
  // empty, so nothing was applied at all. 2 = a refusal (fail-closed).
  return applied.moved + skipped > 0 ? 0 : 1;
}

function usage() {
  return [
    '#2591/#4131 G-M — store-level sweep of orphan [MENTION] notifications',
    '',
    '  node scripts/archive-orphan-mention-notifications.mjs --manifest <path> [--inbox <path>] [--limit N] [--include-non-mention]',
    '  node scripts/archive-orphan-mention-notifications.mjs --manifest <path> --live [--include-non-mention]',
    '',
    'Dry-run by default (writes the manifest/pre-image, moves nothing).',
    '--live re-verifies every row (existence, sha256, classification, subject)',
    'then moves inbox/<file> -> <sibling>/archive/<file>.',
    'The manifest freezes the inbox AND the archive; a live run whose paths',
    'differ from the pre-image is refused. Fail-closed: bad args exit 2, an',
    'empty pre-image exits 1, a completed pass exits 0.'
  ].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Propagate the result (review ms#1413 point 4): without this, a fail-closed
  // refusal that returns a non-zero code from main() still exits 0 to the
  // shell, and a caller cannot tell a sweep that ran from one that refused.
  process.exitCode = main();
}
