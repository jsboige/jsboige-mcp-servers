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
// (c) in the explicit out-of-shape list (default `nanoclaw-cluster`, the
// NanoClaw poller's machine id — a live consumer measured on ai-01, review
// ms#1408). The production guard only sees v1 prose mentions (bare tokens,
// no ':' possible), so this classifier is a SUPERSET by design — it adds the
// 'lane' class for store traffic the guard never receives. A drift-guard
// test (tests/unit/archive-orphan-mention-notifications.test.ts) pins the
// subset invariant: the sweep never archives anything the production guard
// keeps, and agrees totally on the bare-token population.
//
// Scope guard: ONLY `[MENTION]`-subjected messages are selected by default —
// that is the population the RX92 accord (08/10, ai-01 registry) authorizes.
// The ~18 deliberately mis-addressed direct sends are NOT in that
// authorization; --include-non-mention exists for a future explicit one.
//
// Usage:
//   node scripts/archive-orphan-mention-notifications.mjs --manifest <path>            # dry-run (default)
//   node scripts/archive-orphan-mention-notifications.mjs --manifest <path> --live     # apply
//   node scripts/archive-orphan-mention-notifications.mjs --manifest <path> --limit 20 # canary dry-run
//   --inbox <path> overrides the store (default: $ROOSYNC_SHARED_PATH/messages/inbox,
//   ROOSYNC_SHARED_PATH resolved from env or the server .env, fail-closed).
//
// The dry-run manifest IS the pre-image: one row per candidate file with its
// sha256 BEFORE any move. --live re-reads, re-hashes and re-classifies every
// row against the live store before moving (a file that changed, moved, or
// no longer classifies as orphan is skipped, never assumed) and moves
// inbox/<file> -> archive/<file> (the MessageManager archive convention).
// Malformed, repeated or unknown arguments exit 2 — same fail-closed rules
// as scripts/orphan-repair.mjs.
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const RSM_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── Classification (mirrors src/utils/dashboard-helpers.ts — drift-guarded) ──

const FLEET_MACHINE_PATTERN = /^myia-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DEFAULT_EXTRA_MENTION_RECIPIENTS = ['nanoclaw-cluster'];

export function loadExtraRecipients(env = process.env) {
  const raw = env.ROO_MENTION_EXTRA_RECIPIENTS;
  const parsed = raw ? raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean) : [];
  return [...new Set([...DEFAULT_EXTRA_MENTION_RECIPIENTS, ...parsed])];
}

export function classifyRecipient(to) {
  const r = typeof to === 'string' ? to : '';
  if (!r) return 'orphan';
  if (FLEET_MACHINE_PATTERN.test(r)) return 'fleet';
  const head = r.split(':', 1)[0];
  if (r.includes(':') && FLEET_MACHINE_PATTERN.test(head)) return 'lane';
  if (loadExtraRecipients().includes(r)) return 'extra';
  return 'orphan';
}

export function isOrphanRecipient(to) {
  return classifyRecipient(to) === 'orphan';
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

export function scanInbox(inboxPath, { includeNonMention = false, limit } = {}) {
  const files = readdirSync(inboxPath).filter(f => f.endsWith('.json')).sort();
  const kept = { fleet: 0, lane: 0, extra: 0 };
  const unreadable = [];
  const orphans = [];
  for (const file of files) {
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
    if (!includeNonMention && !subject.toUpperCase().startsWith('[MENTION]')) continue;
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
  return { files: files.length, kept, unreadable, orphans };
}

export function runDryRun({ inboxPath, manifestPath, includeNonMention = false, limit }) {
  const result = scanInbox(inboxPath, { includeNonMention, limit });
  const manifest = {
    mode: 'dry-run',
    generatedAt: new Date().toISOString(),
    inbox: inboxPath,
    includeNonMention,
    limit: limit ?? null,
    scanned: result.files,
    kept: result.kept,
    unreadable: result.unreadable.length,
    selected: result.orphans.length,
    rows: result.orphans
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 1), 'utf-8');
  return manifest;
}

export function applyManifest({ manifestPath, archivePath }) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  if (manifest.mode !== 'dry-run') {
    throw new Error(`Refusing to apply a manifest with mode '${manifest.mode}' (expected 'dry-run')`);
  }
  if (!Array.isArray(manifest.rows)) {
    throw new Error('Manifest has no rows array — refusing');
  }
  mkdirSync(archivePath, { recursive: true });
  const outcomes = { moved: [], missing: [], changed: [], reclassified: [], collision: [] };
  for (const row of manifest.rows) {
    const src = path.join(manifest.inbox, row.file);
    const dst = path.join(archivePath, row.file);
    if (!existsSync(src)) { outcomes.missing.push(row.file); continue; }
    let msg;
    try {
      msg = JSON.parse(readFileSync(src, 'utf-8'));
    } catch {
      outcomes.changed.push(row.file);
      continue;
    }
    if (sha256(readFileSync(src, 'utf-8')) !== row.sha256) { outcomes.changed.push(row.file); continue; }
    if (!isOrphanRecipient(recipientOf(msg))) { outcomes.reclassified.push(row.file); continue; }
    if (existsSync(dst)) { outcomes.collision.push(row.file); continue; }
    renameSync(src, dst);
    outcomes.moved.push(row.file);
  }
  const applied = {
    mode: 'applied',
    appliedAt: new Date().toISOString(),
    sourceManifest: manifestPath,
    inbox: manifest.inbox,
    archive: archivePath,
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

  if (args.live && !existsSync(args.manifest)) {
    fail('--live requires an existing dry-run manifest (run without --live first)');
  }

  if (!args.live) {
    const m = runDryRun({ inboxPath, manifestPath: args.manifest, includeNonMention: args.includeNonMention, limit });
    console.log(`[dry-run] scanned=${m.scanned} kept=${JSON.stringify(m.kept)} unreadable=${m.unreadable}`);
    console.log(`[dry-run] selected ${m.selected} orphan ${m.includeNonMention ? 'messages' : '[MENTION] notifications'} -> ${args.manifest}`);
    console.log('[dry-run] nothing was moved. Apply with --live (same manifest).');
    return 0;
  }

  const sharedForArchive = process.env.ROOSYNC_SHARED_PATH || serverEnv.ROOSYNC_SHARED_PATH;
  const archiveBase = args.inbox ? path.dirname(args.inbox) : sharedForArchive;
  if (!archiveBase) fail('cannot resolve the archive dir (no --inbox, no ROOSYNC_SHARED_PATH)');
  const archivePath = path.join(archiveBase, 'messages', 'archive');
  const applied = applyManifest({ manifestPath: args.manifest, archivePath });
  console.log(`[live] moved=${applied.moved} missing=${applied.missing} changed=${applied.changed} reclassified=${applied.reclassified} collision=${applied.collision}`);
  console.log(`[live] pre-image manifest kept at ${args.manifest}; outcomes at ${args.manifest}.applied.json`);
  return applied.moved + (applied.changed + applied.reclassified + applied.collision) > 0 ? 0 : 1;
}

function usage() {
  return [
    '#2591/#4131 G-M — store-level sweep of orphan [MENTION] notifications',
    '',
    '  node scripts/archive-orphan-mention-notifications.mjs --manifest <path> [--inbox <path>] [--limit N] [--include-non-mention]',
    '  node scripts/archive-orphan-mention-notifications.mjs --manifest <path> --live',
    '',
    'Dry-run by default (writes the manifest/pre-image, moves nothing).',
    '--live re-verifies every row (existence, sha256, classification) then moves',
    'inbox/<file> -> messages/archive/<file>. Fail-closed: bad args exit 2.'
  ].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
