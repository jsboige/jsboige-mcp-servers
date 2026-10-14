#!/usr/bin/env node
/**
 * #4131 grain G-C, site 1-3 helper — read the dashboard intercom journal
 * from PostgreSQL for the WAKE listener (`dashboard-listener.ps1`).
 *
 * WHY: the listener's primary read path is the GDrive markdown file, whose
 * availability collapses with DriveFS (the 07-08/10 outage this grain comes
 * from). The PG mirror already holds every live message
 * (`roosync_dashboard_messages`, dual-write since #3151); this CLI exposes
 * it in the listener's own message shape so `Invoke-ProcessWorkspace` and
 * the WAKE routing stay unchanged.
 *
 * Modes (exactly one — see scripts/lib/dashboard-journal.mjs for the grammar):
 *   --workspace <ws> [--since <iso>]   messages of `workspace-<ws>` newer
 *                                      than the cursor (omit --since = all
 *                                      live messages; the listener seeds
 *                                      lastAck on first run)
 *   --discover                         workspace names known to PG (replaces
 *                                      the `workspace-*.md` GDrive listing)
 *   --max-created <ws,ws,…>            {ws → ISO} latest live message per key
 *                                      (replaces the GDrive mtime fallback
 *                                      poll — one grouped query)
 *
 * Contract with the listener (fail-open): stdout is a single JSON document;
 * PG unreachable → stderr line `PG-UNREACHABLE: …` + exit 1, and the caller
 * keeps the file path. Exit codes: 0 ok · 1 PG unreachable · 2 usage.
 *
 * Usage (from servers/roo-state-manager/):
 *   node scripts/rsm-dashboard-intercom.mjs --workspace roo-extensions --since 2026-10-13T00:00:00.000Z
 *   node scripts/rsm-dashboard-intercom.mjs --discover
 *   node scripts/rsm-dashboard-intercom.mjs --max-created roo-extensions,Maintenance
 *
 * The .env at servers/roo-state-manager/.env is auto-loaded
 * (UNIFIED_STORE_PG_URL). The PG URL is never printed.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { createRequire } from 'node:module';
import {
  SQL_INTERCOM_SINCE,
  SQL_DISCOVER_WORKSPACES,
  SQL_MAX_CREATED,
  rowToListenerMessage,
  parseIntercomArgs,
} from './lib/dashboard-journal.mjs';

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
  console.error('Usage: node scripts/rsm-dashboard-intercom.mjs --workspace <ws> [--since <iso>] | --discover | --max-created <ws,ws…>');
  process.exit(2);
}

const HELP_TEXT = `Usage: node scripts/rsm-dashboard-intercom.mjs [options]

  --workspace <ws> [--since <iso>]  Intercom messages of workspace-<ws> newer
                                    than the ISO cursor (omit = all live).
  --discover                        Workspace names known to PG (site 2).
  --max-created <ws,ws,…>           Latest live message per key (site 3 poll).

stdout: one JSON document. PG down → stderr "PG-UNREACHABLE: …" + exit 1
(fail-open: the listener keeps its file path). Exit codes 0/1/2.
Loads .env automatically. The PG URL is never printed.`;

const args = process.argv.slice(2);
const parsed = parseIntercomArgs(args);
if (parsed.error) usageError(parsed.error);
if (parsed.mode === 'help') {
  console.log(HELP_TEXT);
  process.exit(0);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RSM_ROOT = path.resolve(__dirname, '..'); // servers/roo-state-manager/
const envLoaded = loadEnv(path.join(RSM_ROOT, '.env'));
if (!process.env.UNIFIED_STORE_PG_URL) usageError('UNIFIED_STORE_PG_URL absent (ni env ni .env) — fail-closed');

const require2 = createRequire(path.join(RSM_ROOT, 'package.json'));
const pg = require2('pg');

const client = new pg.Client({
  connectionString: process.env.UNIFIED_STORE_PG_URL,
  // No ssl option ON PURPOSE: SSL comes from the connection string
  // (sslmode=…), the single source the server itself uses.
  // Bounded connect (dogfood review #4085, 14/10): a hung PG TCP connect
  // would hang the CLI and stall the listener's poll — fail-open must be
  // bounded in TIME too, not just in outcome. Same budget as the store's
  // own pool (connectionTimeoutMillis default, PgUnifiedStoreReader).
  connectionTimeoutMillis: 5000,
});

try {
  await client.connect();
  if (parsed.mode === 'messages') {
    const key = `workspace-${parsed.workspace}`;
    const res = await client.query(SQL_INTERCOM_SINCE, [key, parsed.since ?? new Date(0).toISOString()]);
    const messages = res.rows.map(rowToListenerMessage);
    process.stdout.write(`${JSON.stringify({ mode: 'messages', workspace: parsed.workspace, count: messages.length, messages })}\n`);
  } else if (parsed.mode === 'discover') {
    const res = await client.query(SQL_DISCOVER_WORKSPACES);
    const workspaces = res.rows.map((r) => String(r.dashboard_key).replace(/^workspace-/, ''));
    process.stdout.write(`${JSON.stringify({ mode: 'discover', count: workspaces.length, workspaces })}\n`);
  } else {
    // max-created: the listener passes bare workspace names; keys are rebuilt
    // here so the query matches the stored dashboard_key format exactly.
    const keys = parsed.keys.map((ws) => `workspace-${ws}`);
    const res = await client.query(SQL_MAX_CREATED, [keys]);
    const map = {};
    for (const ws of parsed.keys) map[ws] = null; // absent key = no live message
    for (const row of res.rows) {
      const ws = String(row.dashboard_key).replace(/^workspace-/, '');
      map[ws] = row.max_created instanceof Date ? row.max_created.toISOString() : String(row.max_created);
    }
    process.stdout.write(`${JSON.stringify({ mode: 'max-created', maxCreatedAt: map })}\n`);
  }
  await client.end();
  process.exit(0);
} catch (err) {
  // Fail-open contract: the listener reads this marker on stderr and keeps
  // its GDrive file path. Never print the connection string.
  try { await client.end(); } catch { /* already gone */ }
  console.error(`PG-UNREACHABLE: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
