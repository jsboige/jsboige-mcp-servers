#!/usr/bin/env node
/**
 * #4131 grain G-INV — publish a LOCALLY-produced inventory JSON through the
 * InventoryService save path: PG first (row `inventory:{machineId}`), GDrive
 * mirror written ONLY when PG did not take the write (down or unconfigured).
 *
 * WHY: the daily scheduled task `Claude-InventoryCollector` →
 * `Bootstrap-AllInventories.ps1` → `Get-MachineInventory.ps1` writes
 * `inventories/{machineId}.json` DIRECTLY on G: — the exact writer the
 * 05/11 18:00Z freeze measure found active (c.6665408973 §2). RSM itself has
 * been PG-first since #4131 Phase D; this CLI gives the external task the
 * same path instead of a private file write.
 *
 * Surface = the G-INV contract, imposed BY CONSTRUCTION:
 *   - input is a JSON FILE (Get-MachineInventory.ps1 output), the data is
 *     never re-collected here — the file is the truth;
 *   - machineId is normalized to lowercase BEFORE publication (an external
 *     producer with mixed case publishes the canonical row, it is not
 *     refused);
 *   - there is no flag to force the G: write: the kill-switch
 *     `UNIFIED_STORE_INVENTORY_PG_PRIMARY=0` (read at call time by the
 *     service) is the only way the mirror is written after a PG success.
 *
 * Exit codes: 0 published (PG or mirror — the JSON output says which) ·
 * 1 nothing saved (PG and mirror both failed) · 2 usage / contract violation
 * (unreadable file, invalid JSON, missing machineId).
 *
 * Usage (from servers/roo-state-manager/):
 *   node scripts/rsm-inventory-save.mjs --file /tmp/my-machine.json
 *
 * The .env at servers/roo-state-manager/.env is auto-loaded (PG URL, shared
 * path). The PG URL is never printed.
 */

import { readFileSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';
import { resolveBuildDir } from './lib/resolve-build-dir.mjs';

// --- .env loader (zero-dep, same contract as rsm-dashboard-append.mjs) ---
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
  console.error('Usage: node scripts/rsm-inventory-save.mjs --file <inventory.json>');
  process.exit(2);
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(`Usage: node scripts/rsm-inventory-save.mjs [options]

  --file <f>    Inventory JSON produced locally (Get-MachineInventory.ps1).
                The data is published as-is; machineId is normalized to
                lowercase before the PG row key. PG is written first; the
                GDrive mirror only when PG did not take the write.
                UNIFIED_STORE_INVENTORY_PG_PRIMARY=0 restores the mirror
                after a PG success (kill-switch, read at call time).

Exit 0 published (JSON output says pgSaved/mirrorSaved) · 1 nothing saved ·
2 usage / contract violation. Loads .env automatically.`);
  process.exit(0);
}

const fileIdx = args.indexOf('--file');
if (fileIdx === -1 || fileIdx + 1 >= args.length) {
  usageError('--file <inventory.json> est requis');
}
const filePath = args[fileIdx + 1];

let raw;
try {
  raw = readFileSync(filePath, 'utf-8');
} catch (err) {
  usageError(`lecture de --file impossible : ${err instanceof Error ? err.message : String(err)}`);
}

let inventory;
try {
  inventory = JSON.parse(raw);
} catch (err) {
  usageError(`JSON invalide dans ${filePath} : ${err instanceof Error ? err.message : String(err)}`);
}
if (typeof inventory !== 'object' || inventory === null || Array.isArray(inventory)) {
  usageError('le fichier doit contenir un objet JSON (inventaire), pas un tableau');
}
if (typeof inventory.machineId !== 'string' || !inventory.machineId.trim()) {
  usageError('machineId absent ou non-chaîne dans le fichier — Get-MachineInventory.ps1 le produit');
}
if (typeof inventory.inventory !== 'object' || inventory.inventory === null) {
  usageError('champ « inventory » absent — la forme FullInventory est attendue (machineId, timestamp, inventory, paths)');
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RSM_ROOT = path.resolve(__dirname, '..'); // servers/roo-state-manager/
loadEnv(path.join(RSM_ROOT, '.env'));

// Import from the SERVED build — same path as the MCP host, not a private
// copy (G-R pattern, rsm-dashboard-append.mjs).
const buildDir = resolveBuildDir(RSM_ROOT);
const buildUrl = (rel) => pathToFileURL(path.join(buildDir, rel)).href;
const { InventoryService } = await import(buildUrl('services/roosync/InventoryService.js'));

const service = InventoryService.getInstance();
let outcome;
try {
  outcome = await service.publishExternalInventory(inventory);
} catch (err) {
  console.error(`ERREUR: publication impossible : ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

if (!outcome.pgSaved && !outcome.mirrorSaved) {
  console.error(`ERREUR: AUCUNE sauvegarde réussie pour '${inventory.machineId}' (PG et GDrive en échec) — voir le journal RSM`);
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  machineId: String(inventory.machineId).toLowerCase(),
  pgSaved: outcome.pgSaved,
  mirrorSaved: outcome.mirrorSaved,
  refused: outcome.refused ?? undefined,
  source: path.basename(filePath),
}));
process.exit(0);
