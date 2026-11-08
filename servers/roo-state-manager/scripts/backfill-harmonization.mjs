#!/usr/bin/env node
/**
 * #3544 — One-time backfill of the harmonization campaign store
 * (`<shared>/harmonization/campaigns/*.json` + their `events/<machine>/`
 * journals → `harmonization_campaigns` + `harmonization_confirmations`).
 *
 * WHY: until 07/11 the campaign store existed only as files under GDrive, and
 * the mount divergence proved why that is not enough — web2 reads the ORIGINAL
 * 2025 tree and saw the campaigns, the other five measured seats read the 28/10
 * tree and saw none. The "8/8 confirmed, 0 drift" proof of
 * `hc-claude-settings-2026.10.25-1` was therefore readable from ONE seat. ai-01
 * decided (issue comment 6710974383) that PG becomes the AUTHORITY and G: the
 * fallback mirror; this script is the one-shot import that closes the gap, and
 * it must run from a seat that sees the original tree (web2, or ai-01).
 *
 * WHAT IT IMPORTS
 *   - every `campaigns/<id>.json`                                  → harmonization_campaigns
 *   - every `campaigns/<id>/events/<machine>/<eventId>.json` with
 *     `kind: 'confirm'`                                            → harmonization_confirmations
 *
 * `kind: 'failed'` events stay on disk: a seat's failed attempt is local
 * history, never fleet knowledge.
 *
 * Non-destructive: everything INSERT ... DO NOTHING (writer `{ backfill: true }`
 * for campaigns, `on conflict do nothing` for confirmations) — a file snapshot
 * racing a live organ write can never roll back a campaign the organ advanced,
 * and re-running after an interruption is safe.
 *
 * Env-gate (delegated to writer-factory):
 *   - UNIFIED_STORE_DUAL_WRITE=1 + UNIFIED_STORE_PG_URL set → LIVE
 *   - otherwise → DRY RUN (NullUnifiedStoreWriter, nothing persisted)
 *
 * Usage (from servers/roo-state-manager/):
 *   npm run build
 *   node scripts/backfill-harmonization.mjs --dry-run
 *   node scripts/backfill-harmonization.mjs              # live
 *
 * Prerequisite: migrations/001, 012 and 013 applied.
 * The .env at servers/roo-state-manager/.env is auto-loaded.
 *
 * COMPLETENESS MARKER (`roosync_store_meta`, migrations/012): opens the default
 * harmonization PG read fleet-wide, so it is written ONLY by a FULL-SCOPE live
 * run (no --limit, no --campaign) that finished without error. Any subset run
 * says so and writes nothing.
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
const campaignIdx = args.indexOf('--campaign');
const CAMPAIGN_FILTER = campaignIdx !== -1 ? args[campaignIdx + 1] : undefined;

if (HELP) {
  console.log(`Usage: node scripts/backfill-harmonization.mjs [--dry-run] [--limit N] [--campaign id] [--help]

  --dry-run        Force NullUnifiedStoreWriter (no rows persisted).
  --limit N        Stop after N campaigns (smoke test).
  --campaign id    Only backfill this campaign (e.g. hc-claude-settings-2026.10.25-1).
  --help           Show this help.

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
const [
  { getSharedStatePath },
  { backfillCampaignToStore, backfillConfirmationToStore },
  { getUnifiedStoreWriter },
  { HARMONIZATION_BACKFILL_META_KEY },
  { evaluateHarmonizationScope, decideMarkerWrite },
] = await Promise.all([
  import(buildUrl('utils/shared-state-path.js')),
  import(buildUrl('services/unified-store/roosync-harmonization-store.js')),
  import(buildUrl('services/unified-store/writer-factory.js')),
  import(buildUrl('services/unified-store/pg-backfill-marker.js')),
  import(buildUrl('services/unified-store/backfill-scope.js')),
]);

const scope = evaluateHarmonizationScope({ limit: LIMIT, campaignFilter: CAMPAIGN_FILTER });

const writer = getUnifiedStoreWriter();
const writerKind = writer.constructor?.name ?? 'unknown';
const liveMode = writerKind !== 'NullUnifiedStoreWriter';

console.log('=== Harmonization Campaigns Backfill (#3544) ===');
console.log(`Mode: ${liveMode ? 'LIVE (PgUnifiedStoreWriter)' : 'DRY RUN (NullUnifiedStoreWriter)'}`);
console.log(`.env: ${envLoaded ? 'loaded' : 'not found'} (${path.join(RSM_ROOT, '.env')})`);
if (CAMPAIGN_FILTER) console.log(`Campaign filter: ${CAMPAIGN_FILTER}`);
if (LIMIT) console.log(`Limit: ${LIMIT} campaign(s)`);
console.log(
  `Scope: ${scope.fullScope ? 'FULL (every campaign, no limit)' : 'SUBSET — the completeness marker will NOT be written'}`,
);
for (const reason of scope.reasons) console.log(`  - ${reason}`);
console.log('');

const sharedStatePath = getSharedStatePath();
const campaignsDir = path.join(sharedStatePath, 'harmonization', 'campaigns');
const { readdir, readFile } = await import('fs/promises');

let files;
try {
  files = await readdir(campaignsDir);
} catch {
  console.error(`harmonization campaigns directory not found: ${campaignsDir}`);
  console.error('Fail closed: without the original tree there is nothing to import.');
  process.exit(1);
}

// Campaign records only: `<id>.json` at the top of campaigns/. The per-campaign
// `<id>/events/` directories and `*.tmp-*` rename leftovers are not records.
const campaignFiles = files.filter((f) => f.endsWith('.json') && !f.includes('.tmp-'));
console.log(`${campaignsDir}: ${campaignFiles.length} campaign file(s)`);

let total = 0;
let processed = 0;
let skipped = 0;
let errors = 0;
const failures = [];
let confirmationsImported = 0;
let confirmationsFailed = 0;
let confirmationsSkipped = 0;
let campaignsWritten = 0;
const perCampaign = [];

for (const file of campaignFiles) {
  if (LIMIT && campaignsWritten >= LIMIT) break;

  const id = file.replace(/\.json$/, '');
  if (CAMPAIGN_FILTER && id !== CAMPAIGN_FILTER) {
    skipped++;
    continue;
  }
  total++;

  let record;
  try {
    const raw = await readFile(path.join(campaignsDir, file), 'utf-8');
    record = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    if (!record || typeof record.id !== 'string' || !record.canon) {
      throw new Error('not a campaign record (no id/canon)');
    }
  } catch (err) {
    errors++;
    failures.push(`${file}: unreadable (${err?.message ?? String(err)})`);
    continue;
  }

  // Campaign row.
  try {
    await backfillCampaignToStore(record);
    campaignsWritten++;
  } catch (err) {
    errors++;
    failures.push(`${file}: campaign insert failed (${err?.message ?? String(err)})`);
    continue;
  }

  // Confirmation journal: events/<machine>/<eventId>.json, confirmations only.
  let imported = 0;
  let failed = 0;
  let localSkipped = 0;
  const eventsRoot = path.join(campaignsDir, id, 'events');
  let machines = [];
  try {
    machines = await readdir(eventsRoot);
  } catch {
    machines = []; // no journal for this campaign — legitimately empty
  }

  for (const machine of machines) {
    let eventFiles = [];
    try {
      eventFiles = await readdir(path.join(eventsRoot, machine));
    } catch {
      continue;
    }
    for (const eventFile of eventFiles) {
      if (!eventFile.endsWith('.json')) continue;
      let obs;
      try {
        const raw = await readFile(path.join(eventsRoot, machine, eventFile), 'utf-8');
        obs = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
      } catch {
        localSkipped++;
        continue;
      }
      if (obs?.kind !== 'confirm') {
        // `failed` events are a seat's local history — never fleet knowledge.
        localSkipped++;
        continue;
      }
      // The witness identity is the eventId BOTH sides share; a file whose
      // name and payload disagree cannot be de-duplicated, so it is skipped
      // rather than imported under a made-up key.
      if (!obs.eventId || `${obs.eventId}.json` !== eventFile) {
        localSkipped++;
        continue;
      }
      try {
        const outcome = await backfillConfirmationToStore(id, {
          kind: 'confirm',
          machine: obs.machine ?? machine,
          at: obs.at,
          canonHash: obs.canonHash,
          observedHash: obs.observedHash,
          source: 'live-read',
          eventId: obs.eventId,
        });
        if (outcome.ok) imported++;
        else if (outcome.reason === 'disabled') imported++; // dry run: counted, not persisted
        else {
          failed++;
          failures.push(`${id}/${machine}/${eventFile}: ${outcome.reason}`);
        }
      } catch (err) {
        failed++;
        failures.push(`${id}/${machine}/${eventFile}: ${err?.message ?? String(err)}`);
      }
    }
  }

  confirmationsImported += imported;
  confirmationsFailed += failed;
  confirmationsSkipped += localSkipped;
  errors += failed;
  processed++;
  perCampaign.push({ id, imported, failed, skipped: localSkipped });
  console.log(
    `  ✓ ${id} (${imported} confirmation(s)${localSkipped > 0 ? `, ${localSkipped} non-confirm/unreadable skipped` : ''}${failed > 0 ? `, ${failed} FAILED` : ''})`,
  );
}

console.log('');
console.log('=== Result ===');
console.log(`  campaigns total:     ${total}`);
console.log(`  campaigns processed: ${processed}`);
console.log(`  campaigns skipped:   ${skipped}  (campaign filter)`);
console.log(`  confirmations:       ${confirmationsImported} imported, ${confirmationsSkipped} skipped, ${confirmationsFailed} failed`);
console.log(`  errors:              ${errors}`);
if (failures.length > 0) {
  console.log('');
  console.log('  failed items (re-run these before enabling the read flag):');
  for (const f of failures.slice(0, 50)) console.log(`    - ${f}`);
  if (failures.length > 50) console.log(`    ... and ${failures.length - 50} more`);
}
console.log('');
if (!liveMode) {
  console.log('DRY RUN complete — 0 rows persisted (NullUnifiedStoreWriter).');
  console.log('Re-run without --dry-run and UNIFIED_STORE_DUAL_WRITE=1 + UNIFIED_STORE_PG_URL set to persist.');
} else {
  console.log('LIVE backfill complete (INSERT DO NOTHING — existing PG rows untouched).');
  console.log('Validate: psql -c "SELECT campaign_id, status, rev FROM harmonization_campaigns;"');
  console.log('          psql -c "SELECT campaign_id, machine_id, count(*) FROM harmonization_confirmations GROUP BY 1,2 ORDER BY 1,2;"');
  console.log('The default PG read opens on its own once the marker is in PG — no flag to flip.');
}

// COMPLETENESS MARKER — same contract as the channel and dashboard backfills:
// the default PG read is gated on DATA, and the marker is written only by a
// LIVE run that covered the WHOLE scope and finished without error.
const markerDecision = decideMarkerWrite({ liveMode, errors, scope });
if (!markerDecision.write) {
  console.log('');
  console.log(`  marker:    NOT written — ${markerDecision.reason}.`);
  console.log('             The default PG read stays OFF (GDrive keeps serving) until a clean');
  console.log('             FULL-SCOPE live run writes the marker.');
} else {
  try {
    await writer.setStoreMeta(HARMONIZATION_BACKFILL_META_KEY, new Date().toISOString());
    console.log('');
    console.log(`  marker:    ${HARMONIZATION_BACKFILL_META_KEY} written — the default PG read may now open on this store.`);
  } catch (err) {
    console.log('');
    console.log(`  marker:    FAILED (${err?.message ?? String(err)})`);
    console.log('             migrations/012 not applied on this store? The default PG read stays OFF');
    console.log('             (GDrive keeps serving) until the marker is written — re-run after the migration.');
    errors++;
  }
}

if (errors > 0) {
  console.log('');
  console.log(`INCOMPLETE — ${errors} item(s) failed. Do NOT enable UNIFIED_STORE_HARMONIZATION_READ_PG until they import.`);
  process.exit(1);
}
