#!/usr/bin/env node
/**
 * #3237 — Standalone RooSync message sender (same path as every MCP producer).
 *
 * WHY: scripts/scheduling/start-claude-worker.ps1 wrote its worker reports with
 * raw WriteAllText calls — bypassing MessageManager, so the PG dual-write
 * (#3151 Phase A) never fired for them (backfill empan frozen at
 * 2026-08-22 23:00:44Z), and the id carried no uniqueness suffix (two machines
 * reporting in the same second overwrite each other in the shared inbox/).
 *
 * Routing the send through MessageManager.sendMessage() gives, by construction:
 *   - the GDrive writes to sent/ + inbox/ (delivery path unchanged),
 *   - the PG dual-write (env-gated: UNIFIED_STORE_DUAL_WRITE=1 +
 *     UNIFIED_STORE_PG_URL, delegated to writer-factory),
 *   - the msg-<timestamp>-<random6> uniqueness suffix,
 *   - the MCP column schema on the PG row (from_machine / from_workspace /
 *     created_at via mapMessageToRow).
 *
 * The dual-write inside sendMessage is fire-and-forget (fine for a long-lived
 * MCP server process). A short-lived CLI must not exit with the INSERT still
 * in flight, so this script awaits its own explicit dual-write call before
 * closing the pool. That call is idempotent at the writer level (INSERT ON
 * CONFLICT (id) DO NOTHING), making the race with the fire-and-forget copy
 * harmless.
 *
 * A PG failure still exits 0 — same contract as the MCP path: the GDrive write
 * is the source of truth and must never be blocked by PG (Phase A). The log
 * line names the mode so a missing dual-write is visible in the worker log.
 *
 * Usage (from servers/roo-state-manager/, after npm run build):
 *   node scripts/send-roosync-message.mjs \
 *     --from myia-po-2024 --to myia-ai-01 \
 *     --subject "Worker Report - task" --body-file "$env:TEMP\report.md" \
 *     [--priority LOW|MEDIUM|HIGH|URGENT] [--tags worker-report,scheduler]
 *
 * --body-file is preferred over --body for anything non-trivial (quoting).
 * The .env at servers/roo-state-manager/.env is auto-loaded.
 * Exit codes: 0 = sent, 1 = error (bad args, GDrive write failure).
 */

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

const FROM = getOpt('from');
const TO = getOpt('to');
const SUBJECT = getOpt('subject');
const BODY_FILE = getOpt('body-file');
const BODY = getOpt('body');
const PRIORITY = getOpt('priority') ?? 'MEDIUM';
const TAGS = getOpt('tags')
  ?.split(',')
  .map((t) => t.trim())
  .filter(Boolean);

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`Usage: node scripts/send-roosync-message.mjs --from <machine[:ws]> --to <machine[:ws]> --subject <s> (--body-file <f> | --body <s>) [--priority LOW|MEDIUM|HIGH|URGENT] [--tags a,b]

  --from            Sender machine id (bare machine id, or machine:workspace).
  --to              Recipient machine id (bare id = all workspaces of that machine).
  --subject         Subject line.
  --body-file       File containing the body (UTF-8). Preferred over --body.
  --body            Inline body. Mutually exclusive with --body-file.
  --priority        LOW | MEDIUM | HIGH | URGENT (default MEDIUM).
  --tags            Comma-separated tags.
  --help            Show this help.

Requires build/ (run "npm run build" first). Loads .env automatically.
Exit 0 = sent (GDrive written; PG dual-write attempted when env-gated on).`);
  process.exit(0);
}

const errors = [];
if (!FROM) errors.push('--from is required');
if (!TO) errors.push('--to is required');
if (!SUBJECT) errors.push('--subject is required');
if (!BODY_FILE && BODY === undefined) errors.push('--body-file or --body is required');
if (BODY_FILE && BODY !== undefined) errors.push('--body-file and --body are mutually exclusive');
if (!['LOW', 'MEDIUM', 'HIGH', 'URGENT'].includes(PRIORITY)) {
  errors.push(`invalid --priority "${PRIORITY}" (LOW|MEDIUM|HIGH|URGENT)`);
}
if (errors.length > 0) {
  console.error(`Error: ${errors.join('; ')} (see --help)`);
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RSM_ROOT = path.resolve(__dirname, '..'); // servers/roo-state-manager/
loadEnv(path.join(RSM_ROOT, '.env'));

let body;
try {
  body = BODY_FILE ? readFileSync(BODY_FILE, 'utf-8') : BODY;
} catch (err) {
  console.error(`Error: cannot read --body-file ${BODY_FILE}: ${err?.message ?? err}`);
  process.exit(1);
}

const buildUrl = (rel) => pathToFileURL(path.join(RSM_ROOT, 'build', rel)).href;
const [
  { getSharedStatePath },
  { getMessageManager },
  { dualWriteRooSyncMessageToStore },
  { getUnifiedStoreWriter },
] = await Promise.all([
  import(buildUrl('utils/shared-state-path.js')),
  import(buildUrl('services/MessageManager.js')),
  import(buildUrl('services/unified-store/roosync-channel-dual-write.js')),
  import(buildUrl('services/unified-store/writer-factory.js')),
]);

// getMessageManager() reads process.env.ROOSYNC_SHARED_PATH directly; this
// also seeds it from the .env fallback when the var is not exported (#1628).
getSharedStatePath();

const messageManager = getMessageManager();
const message = await messageManager.sendMessage(
  FROM,
  TO,
  SUBJECT,
  body,
  PRIORITY,
  TAGS
);

const writer = getUnifiedStoreWriter();
const liveMode = writer.constructor?.name !== 'NullUnifiedStoreWriter';
if (liveMode) {
  // Deterministic flush: the in-send copy is fire-and-forget and a CLI exits
  // right after. Idempotent (ON CONFLICT DO NOTHING) — never blocks on PG.
  await dualWriteRooSyncMessageToStore(message);
  await writer.close();
} else {
  console.warn(
    '[UnifiedStore] Dual-write DISABLED — message persisted to GDrive only. ' +
      'Set UNIFIED_STORE_DUAL_WRITE=1 + UNIFIED_STORE_PG_URL to mirror it to PG (#3237).'
  );
}

console.log(`SENT ${message.id} (${liveMode ? 'gdrive+pg' : 'gdrive-only'})`);
