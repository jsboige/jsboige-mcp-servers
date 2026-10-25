#!/usr/bin/env node
/**
 * #4131 B14 — Standalone RooSync inbox reader for the scheduled workers.
 *
 * WHY: scripts/scheduling/start-claude-worker.ps1 consumes `messages\inbox`
 * as JSON files in two places (`Get-RooSyncTask`, `Test-RooSyncResponse`).
 * Under CHANNEL_PG_PRIMARY (#3151 Phase D) messages stop having files, so
 * those functions go blind exactly when the fleet flips to PG. The worker
 * cannot host an MCP client, but it can shell out to this CLI — the read-side
 * counterpart of send-roosync-message.mjs, speaking the same gated PG path
 * the MCP inbox serves (readCliInboxFromPg).
 *
 * Contract (exit codes drive the PowerShell path choice):
 *   exit 0  — stdout JSON { source: 'pg', messages: [...] }
 *             Full messages, newest first, read and unread alike; the caller
 *             filters status/priority/subject itself (same semantics as the
 *             file pool it replaces). `status` is already per-reader adjusted.
 *   exit 3  — stdout JSON { source: 'file', reason: 'gate-off'|'pg-unavailable' }
 *             The caller keeps the legacy file path (same gate the MCP host
 *             reads: UNIFIED_STORE_CHANNEL_READ_PG / CHANNEL_PG_PRIMARY).
 *   exit 1  — usage error (stderr).
 *
 * #4131 B17 — one-shot mark-read for the same workers:
 *   node scripts/read-roosync-inbox.mjs --machine myia-ai-01 --mark-read <id>
 *
 * Marks ONE message read for the caller's own reader identity through the
 * same per-reader PG semantics as the MCP mark_read (applyReadTracking +
 * updateRooSyncMessagePrimary). The scheduled worker reads as a bare machine
 * (no workspace) while the lane's interactive session reads as
 * machine:workspace — two distinct read states; without this the worker
 * re-serves the same PG [TASK] every cycle. Exit codes: 0 written (a re-mark
 * of an already-read message is `written:true, alreadyRead:true`, no write);
 * 3 gate off / PG unreachable (same as the read); 4 PG answered but nothing
 * was written — row unknown (`not-found`), guard denied the reader
 * (`denied`, #2287), or the UPDATE did not persist
 * (`update-not-persisted`) — the caller WARNs and moves on.
 *
 * Usage (from servers/roo-state-manager/, after npm run build):
 *   node scripts/read-roosync-inbox.mjs --machine myia-po-2024 \
 *     [--workspace roo-extensions] [--pretty]
 *   node scripts/read-roosync-inbox.mjs --machine myia-ai-01 \
 *     --mark-read msg-XXXX [--workspace roo-extensions]
 *
 * The .env at servers/roo-state-manager/.env is auto-loaded.
 */

import { resolveBuildDir } from './lib/resolve-build-dir.mjs';
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
function getOpt(name) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

const MACHINE = getOpt('machine');
const WORKSPACE = getOpt('workspace');
const PRETTY = process.argv.includes('--pretty');
const MARK_READ_FLAG = process.argv.includes('--mark-read');
const MARK_READ = getOpt('mark-read');

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`Usage: node scripts/read-roosync-inbox.mjs --machine <id> [--workspace <ws>] [--pretty]
       node scripts/read-roosync-inbox.mjs --machine <id> --mark-read <msg-id> [--workspace <ws>]

  --machine     Recipient machine id (bare id, or machine:workspace — same forms
                the MCP inbox accepts).
  --workspace   Optional workspace qualifier for recipient matching.
  --pretty      Indent the JSON (humans; machines take the compact form).
  --mark-read   Mark ONE message read for this caller's own reader identity
                (same per-reader PG semantics as the MCP mark_read) instead of
                listing the inbox. Worker-side of #4131 B17.
  --help        Show this help.

Exit codes: 0 = {source:'pg',...} on stdout — inbox list, or mark-read persisted
                (already-read counts: written:true, alreadyRead:true, no write)
            3 = {source:'file',reason:...} — caller keeps the file path
            4 = --mark-read: PG answered, nothing written (not-found | denied |
                update-not-persisted) — caller WARNs and moves on
            1 = usage error

Requires build/ (run "npm run build" first). Loads .env automatically.
Reads PG only when the channel read gate is on (same flags as the MCP host).`);
  process.exit(0);
}

if (!MACHINE) {
  console.error('Error: --machine is required (see --help)');
  process.exit(1);
}

if (MARK_READ_FLAG && (!MARK_READ || MARK_READ.startsWith('--'))) {
  // `--mark-read` present but its value slot is empty or is the next flag
  // (e.g. a trailing `--mark-read`, or `--mark-read --pretty`): usage error,
  // BEFORE any build/PG dependency, so the caller never mistakes it for an
  // inbox read.
  console.error('Error: --mark-read requires a message id (see --help)');
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Test seam: an explicit RSM_ROOT overrides the CLI's own location (the
// subprocess tests point it at a fixture build stub); never set in production.
const RSM_ROOT = process.env.RSM_ROOT
  ? path.resolve(process.env.RSM_ROOT)
  : path.resolve(__dirname, '..'); // servers/roo-state-manager/
loadEnv(path.join(RSM_ROOT, '.env'));

const buildUrl = (rel) => pathToFileURL(path.join(resolveBuildDir(RSM_ROOT), rel)).href;
const { readCliInboxFromPg, markCliMessageReadInPg } = await import(
  buildUrl('services/unified-store/roosync-channel-read.js')
);

const result = MARK_READ !== undefined
  ? await markCliMessageReadInPg(MACHINE, WORKSPACE, MARK_READ)
  : await readCliInboxFromPg(MACHINE, WORKSPACE);
// NEVER process.exit() here: it does not drain a piped stdout, and the write
// stops at the 64 KiB pipe buffer (review head cad920f5, F3 — an inbox above
// 64 KiB left a TRUNCATED JSON with exit 0). Await the write callback, then
// set exitCode and let Node exit naturally once stdout is drained. (--help
// and the usage error keep process.exit: their payloads are a few hundred
// bytes, far under the buffer.)
await new Promise((resolve) => {
  process.stdout.write(`${JSON.stringify(result, null, PRETTY ? 2 : 0)}\n`, resolve);
});
if (result.source !== 'pg') process.exitCode = 3;
else if (MARK_READ !== undefined && result.written !== true) process.exitCode = 4;
else process.exitCode = 0;
