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
 * Usage (from servers/roo-state-manager/, after npm run build):
 *   node scripts/read-roosync-inbox.mjs --machine myia-po-2024 \
 *     [--workspace roo-extensions] [--pretty]
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

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`Usage: node scripts/read-roosync-inbox.mjs --machine <id> [--workspace <ws>] [--pretty]

  --machine     Recipient machine id (bare id, or machine:workspace — same forms
                the MCP inbox accepts).
  --workspace   Optional workspace qualifier for recipient matching.
  --pretty      Indent the JSON (humans; machines take the compact form).
  --help        Show this help.

Exit codes: 0 = {source:'pg',messages:[...]} on stdout
            3 = {source:'file',reason:...} — caller keeps the file path
            1 = usage error

Requires build/ (run "npm run build" first). Loads .env automatically.
Reads PG only when the channel read gate is on (same flags as the MCP host).`);
  process.exit(0);
}

if (!MACHINE) {
  console.error('Error: --machine is required (see --help)');
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RSM_ROOT = path.resolve(__dirname, '..'); // servers/roo-state-manager/
loadEnv(path.join(RSM_ROOT, '.env'));

const buildUrl = (rel) => pathToFileURL(path.join(resolveBuildDir(RSM_ROOT), rel)).href;
const { readCliInboxFromPg } = await import(
  buildUrl('services/unified-store/roosync-channel-read.js')
);

const result = await readCliInboxFromPg(MACHINE, WORKSPACE);
console.log(JSON.stringify(result, null, PRETTY ? 2 : 0));
process.exit(result.source === 'pg' ? 0 : 3);
