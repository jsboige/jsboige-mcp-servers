#!/usr/bin/env node
/**
 * #3151 Phase B — One-time backfill of the RooSync channel history (GDrive
 * files → `roosync_messages`) so the PG-primary read path can be enabled.
 *
 * WHY: the live dual-write (#1001/#1003) only mirrors messages sent AFTER a
 * machine restarted with the flag on. Everything already sitting in the GDrive
 * tree (inbox 3.1 K + archive 18.6 K + sent) never reached PG. A machine that
 * turns on UNIFIED_STORE_CHANNEL_READ_PG before this gap is closed would read
 * an empty mailbox — under-show, the one failure this channel cannot tolerate.
 *
 * Idempotent: INSERT ... ON CONFLICT (id) DO NOTHING — PG rows written by the
 * live dual-write (fresher) are never overwritten by older file state. Safe to
 * re-run after an interruption.
 *
 * Env-gate (delegated to writer-factory):
 *   - UNIFIED_STORE_DUAL_WRITE=1 + UNIFIED_STORE_PG_URL set → LIVE
 *   - otherwise → DRY RUN (NullUnifiedStoreWriter, nothing persisted)
 *
 * Usage (from servers/roo-state-manager/):
 *   npm run build
 *   node scripts/backfill-roosync-channel.mjs --dry-run
 *   node scripts/backfill-roosync-channel.mjs                 # live
 *   node scripts/backfill-roosync-channel.mjs --dirs inbox    # subset
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
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const HELP = args.includes('--help') || args.includes('-h');
const limitIdx = args.indexOf('--limit');
const PARSED_LIMIT = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : undefined;
const LIMIT = Number.isFinite(PARSED_LIMIT) ? PARSED_LIMIT : undefined;
const dirsIdx = args.indexOf('--dirs');
const DIRS = dirsIdx !== -1
  ? (args[dirsIdx + 1] ?? '').split(',').map((d) => d.trim()).filter(Boolean)
  : ['inbox', 'sent', 'archive'];
// #3151 §7.5.2 — attachments phase: import GDrive blobs + metadata, and
// upgrade legacy Phase A rows (payload-only) with their metadata. Default runs
// both phases; --only selects one.
const onlyIdx = args.indexOf('--only');
const PHASES = onlyIdx !== -1
  ? (args[onlyIdx + 1] ?? '').split(',').map((p) => p.trim()).filter(Boolean)
  : ['messages', 'attachments'];

if (HELP) {
  console.log(`Usage: node scripts/backfill-roosync-channel.mjs [--dry-run] [--limit N] [--dirs inbox,sent,archive] [--only messages,attachments] [--help]

  --dry-run          Force NullUnifiedStoreWriter (no rows persisted).
  --limit N          Stop after N items per phase (smoke test).
  --dirs a,b,c       Which mailbox dirs to read (default: inbox,sent,archive).
  --only a,b         Which phases to run (default: messages,attachments).
  --help             Show this help.

Requires build/ (run "npm run build" first). Loads .env automatically.`);
  process.exit(0);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RSM_ROOT = path.resolve(__dirname, '..'); // servers/roo-state-manager/
const envLoaded = loadEnv(path.join(RSM_ROOT, '.env'));

// Force the env-gate off when --dry-run is explicitly requested.
// MUST run after loadEnv() — loadEnv only sets keys that are ABSENT (#2815).
if (DRY_RUN) {
  delete process.env.UNIFIED_STORE_DUAL_WRITE;
  delete process.env.UNIFIED_STORE_PG_URL;
}

const buildUrl = (rel) => pathToFileURL(path.join(resolveBuildDir(RSM_ROOT), rel)).href;
const [{ getSharedStatePath }, { mapMessageToRow }, { getUnifiedStoreWriter }] =
  await Promise.all([
    import(buildUrl('utils/shared-state-path.js')),
    import(buildUrl('services/unified-store/roosync-channel-dual-write.js')),
    import(buildUrl('services/unified-store/writer-factory.js')),
  ]);

const writer = getUnifiedStoreWriter();
const writerKind = writer.constructor?.name ?? 'unknown';
const liveMode = writerKind !== 'NullUnifiedStoreWriter';

console.log('=== RooSync Channel Backfill (#3151 Phase B + §7.5.2 attachments) ===');
console.log(`Mode: ${liveMode ? 'LIVE (PgUnifiedStoreWriter)' : 'DRY RUN (NullUnifiedStoreWriter)'}`);
console.log(`.env: ${envLoaded ? 'loaded' : 'not found'} (${path.join(RSM_ROOT, '.env')})`);
console.log(`Phases: ${PHASES.join(', ')}`);
console.log(`Dirs: ${DIRS.join(', ')}`);
if (LIMIT) console.log(`Limit: ${LIMIT} items per phase`);
console.log('');

const sharedStatePath = getSharedStatePath();
const messagesRoot = path.join(sharedStatePath, 'messages');
const { readdir, readFile } = await import('fs/promises');

// Shared across phases — the exit contract (INCOMPLETE on any error) is
// channel-wide.
const failures = [];
let errors = 0;

let total = 0;
let processed = 0;
let skipped = 0;
let applied = 0;
if (PHASES.includes('messages')) {
// Which files failed, not just how many. A count alone cannot tell the operator
// whether the store is complete, and "complete" is the precondition for turning
// the read flag on — DriveFS read failures are expected here (4.8 s/file cold,
// inbox/ times out at 120 s on ai-01), so this list is the difference between
// re-running a known subset and re-running 21.8 K files blind.

outer: for (const dir of DIRS) {
  const dirPath = path.join(messagesRoot, dir);
  let files;
  try {
    files = await readdir(dirPath);
  } catch {
    console.log(`(${dir}: no such directory — skipped)`);
    continue;
  }
  const jsonFiles = files.filter((f) => f.endsWith('.json'));
  console.log(`${dir}: ${jsonFiles.length} files`);

  for (const file of jsonFiles) {
    total++;
    if (LIMIT && applied >= LIMIT) break outer;
    try {
      let content = await readFile(path.join(dirPath, file), 'utf-8');
      if (content.charCodeAt(0) === 0xfeff) content = content.slice(1); // strip UTF-8 BOM
      const message = JSON.parse(content);
      if (!message || !message.id) {
        skipped++;
        continue;
      }
      // Phantom guard, same rationale as ensureInboxCache: a file whose name
      // does not match its id would import an unreachable row.
      if (file !== `${message.id}.json`) {
        skipped++;
        continue;
      }
      await writer.insertRooSyncMessage(mapMessageToRow(message));
      processed++;
      applied++;
    } catch (err) {
      errors++;
      failures.push(`${dir}/${file}: ${err?.message ?? String(err)}`);
    }
  }
}

console.log('');
console.log('=== Messages result ===');
console.log(`  total:     ${total}`);
console.log(`  processed: ${processed}`);
console.log(`  skipped:   ${skipped}  (no id / name-id mismatch)`);
} // end messages phase

// ─── Attachments phase (#3151 §7.5.2) ───────────────────────────────────────
//
// Walks attachments/{uuid}/ on the share, ships payload + metadata to
// roosync_attachments, and UPGRADES legacy Phase A rows in place: the upsert
// fills ONLY NULL metadata columns and never touches an existing payload —
// the live dual-write wrote that payload at upload time; re-reading an old
// file to overwrite it could regress a fresher row. This is what lets the
// PG-first read path serve the whole history (parity rule: rows without
// uploader metadata are misses).
let attTotal = 0;
let attInserted = 0;
let attUpgraded = 0;
let attSkipped = 0;
if (PHASES.includes('attachments')) {
  console.log('');
  console.log('=== Attachments phase (#3151 §7.5.2) ===');
  const attachmentsRoot = path.join(sharedStatePath, 'attachments');
  let uuidDirs;
  try {
    uuidDirs = (await readdir(attachmentsRoot, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    console.log('(attachments: no such directory — skipped)');
    uuidDirs = [];
  }
  console.log(`attachments: ${uuidDirs.length} uuid dirs`);

  // Raw client (not the writer): the metadata-upgrading upsert is
  // backfill-specific and has no place in the runtime writer surface.
  // Null-writer (dry run) → no client, nothing persisted, counts only.
  let pgClient = null;
  if (liveMode) {
    const { Client } = await import('pg');
    pgClient = new Client({
      connectionString: process.env.UNIFIED_STORE_PG_URL,
      ssl: { rejectUnauthorized: false },
    });
    await pgClient.connect();
  }

  const UPSERT_SQL = `
    INSERT INTO roosync_attachments
      (id, filename, mime, size, sha256, payload,
       uploader_machine, uploader_workspace, message_id, uploaded_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    ON CONFLICT (id) DO UPDATE SET
      uploader_machine   = COALESCE(roosync_attachments.uploader_machine, EXCLUDED.uploader_machine),
      uploader_workspace = COALESCE(roosync_attachments.uploader_workspace, EXCLUDED.uploader_workspace),
      message_id         = COALESCE(roosync_attachments.message_id, EXCLUDED.message_id),
      uploaded_at        = CASE WHEN roosync_attachments.uploader_machine IS NULL
                                THEN EXCLUDED.uploaded_at
                                ELSE roosync_attachments.uploaded_at END
    RETURNING (xmax = 0) AS inserted
  `;

  const { createHash } = await import('crypto');
  for (const uuid of uuidDirs) {
    attTotal++;
    if (LIMIT && attInserted + attUpgraded >= LIMIT) break;
    try {
      let metaRaw = await readFile(path.join(attachmentsRoot, uuid, 'metadata.json'), 'utf-8');
      if (metaRaw.charCodeAt(0) === 0xfeff) metaRaw = metaRaw.slice(1);
      const meta = JSON.parse(metaRaw);
      if (!meta || meta.uuid !== uuid || !meta.originalName) {
        attSkipped++;
        continue;
      }
      const payload = await readFile(path.join(attachmentsRoot, uuid, meta.originalName));
      const result = pgClient
        ? await pgClient.query(UPSERT_SQL, [
            uuid,
            meta.originalName,
            meta.mimeType ?? null,
            meta.sizeBytes ?? payload.length,
            createHash('sha256').update(payload).digest('hex'),
            payload,
            meta.uploaderMachineId ?? null,
            meta.uploaderWorkspace ?? null,
            meta.messageId ?? null,
            meta.uploadedAt ?? new Date().toISOString(),
          ])
        : null;
      if (result) {
        if (result.rows[0]?.inserted) attInserted++;
        else attUpgraded++;
      } else {
        attInserted++; // dry-run accounting: everything would be written
      }
    } catch (err) {
      errors++;
      failures.push(`attachments/${uuid}: ${err?.message ?? String(err)}`);
    }
  }

  if (pgClient) await pgClient.end();

  console.log('');
  console.log('=== Attachments result ===');
  console.log(`  total:     ${attTotal}`);
  if (liveMode) {
    console.log(`  inserted:  ${attInserted}`);
    console.log(`  upgraded:  ${attUpgraded}  (metadata filled, payload untouched)`);
  } else {
    console.log(`  to write:  ${attInserted}  (dry run)`);
  }
  console.log(`  skipped:   ${attSkipped}  (no/mismatched metadata)`);
}

console.log(`  errors:    ${errors}`);
if (failures.length > 0) {
  console.log('');
  console.log('  failed files (re-run these before enabling the read flag):');
  for (const f of failures.slice(0, 50)) console.log(`    - ${f}`);
  if (failures.length > 50) console.log(`    ... and ${failures.length - 50} more`);
}
console.log('');
if (!liveMode) {
  console.log('DRY RUN complete — 0 rows persisted (NullUnifiedStoreWriter).');
  console.log('Re-run without --dry-run and UNIFIED_STORE_DUAL_WRITE=1 + UNIFIED_STORE_PG_URL set to persist.');
} else {
  console.log('LIVE backfill complete (messages: ON CONFLICT DO NOTHING — existing PG rows untouched).');
  console.log('Validate: psql -c "SELECT status, count(*) FROM roosync_messages GROUP BY status;"');
  console.log('         psql -c "SELECT count(*) FILTER (WHERE uploader_machine IS NULL) AS legacy, count(*) AS total FROM roosync_attachments;"');
  console.log('Only after the store is complete, enable UNIFIED_STORE_CHANNEL_READ_PG=1.');
}

// Exit non-zero on any failure so an incomplete backfill cannot be mistaken for
// a complete one by a caller that only checks the exit code. The store being
// complete is the precondition of the read flag; under-show is the one failure
// this channel cannot tolerate.
if (errors > 0) {
  console.log('');
  console.log(`INCOMPLETE — ${errors} file(s) failed. Do NOT enable UNIFIED_STORE_CHANNEL_READ_PG until they import.`);
  process.exit(1);
}
