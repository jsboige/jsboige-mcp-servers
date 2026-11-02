/**
 * Auto-heartbeat utility — #1609
 *
 * Replaces voluntary roosync_heartbeat tool calls with automatic heartbeat
 * emission as a side-effect of any MCP tool call.
 *
 * Logic:
 * - Tracks last heartbeat timestamp in memory
 * - On each tool call, checks if >15min has elapsed
 * - If so, triggers registerHeartbeat via RooSyncService
 * - No agent action required — infrastructure handles it
 *
 * @module utils/auto-heartbeat
 * @version 1.0.0
 */

import { closeSync, openSync, unlinkSync } from 'fs';
import { hostname, tmpdir } from 'os';
import { join } from 'path';

const HEARTBEAT_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

// #3975: rafraîchissement quotidien de l'inventaire local (bootResilience inclus)
// piggybacké sur le heartbeat — même pattern side-effect d'appel outil qu'ADR 008,
// PAS un interval de fond. Un spawn PowerShell max par jour et par process.
const BOOT_RESILIENCE_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h

// #4131 Phase D (ai-01, 02/11 12:10:40Z): a rebuild hot-swaps every RSM process
// of a host within seconds, and each one refreshed the inventory on its first
// heartbeat — ~20 concurrent PG upserts inside the deploy burst. One of them
// hit `timeout expired`, and the PG failure path wrote the GDrive mirror,
// resetting the write freeze. The refresh is now delayed out of the burst and
// claimed ONCE per host per UTC day: every process of a host collects the same
// machine inventory, so one refresh is enough.
const INVENTORY_REFRESH_DELAY_MIN_MS = 2 * 60 * 1000;
const INVENTORY_REFRESH_DELAY_SPREAD_MS = 3 * 60 * 1000;

let lastHeartbeatAt: number = 0;
let lastBootResilienceRefreshAt: number = 0;
let isInitialized = false;

/**
 * Initialize the auto-heartbeat module.
 * Must be called once at server startup.
 */
export function initAutoHeartbeat(): void {
    // Start at 0 so the first tool call always triggers a heartbeat
    // (Date.now() - 0 > HEARTBEAT_INTERVAL_MS is always true).
    // Previously Date.now() caused the first call to silently skip.
    lastHeartbeatAt = 0;
    lastBootResilienceRefreshAt = 0;
    isInitialized = true;
}

/**
 * #3975: Daily-gated local inventory refresh (fire-and-forget, never blocks
 * the tool call). Keeps the shared inventory fresh — the PG row
 * `inventory:{machineId}` (#4131; the .shared-state/inventories/{machineId}.json
 * mirror only when PG is unavailable or UNIFIED_STORE_INVENTORY_PG_PRIMARY=0) — so
 * cross-machine reads (audit tick, compare_config boot-resilience) see the
 * current boot resilience state — the po-2025 outage stayed invisible because
 * the fleet inventory was 8 days stale.
 */
function scheduleBootResilienceInventoryRefresh(): void {
    if (Date.now() - lastBootResilienceRefreshAt < BOOT_RESILIENCE_REFRESH_INTERVAL_MS) {
        return;
    }
    lastBootResilienceRefreshAt = Date.now(); // set first: one spawn/day even on failure
    // Garde tests (pattern mcp-management.ts) — pas d'I/O réelle sous vitest
    if (process.env.NODE_ENV === 'test' || process.env.VITEST) {
        return;
    }
    const delayMs = INVENTORY_REFRESH_DELAY_MIN_MS + Math.floor(Math.random() * INVENTORY_REFRESH_DELAY_SPREAD_MS);
    // unref: a short-lived process exits instead of waiting; another process of
    // the host takes the day's claim.
    setTimeout(() => { void refreshBootResilienceInventory(); }, delayMs).unref();
}

/**
 * #4131: atomic first-wins claim (`wx`) on `<dir>/rsm-inventory-refresh-<id>-<UTC day>.claim`.
 * Returns true when this process should refresh. EEXIST = another process of
 * the host already took today's refresh. Any other error (unwritable dir)
 * fails OPEN — the pre-#4131 per-process refresh, never a silent stop.
 */
export function claimHostDailyInventoryRefresh(dir: string, machineId: string, now: number = Date.now()): boolean {
    const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10).replace(/-/g, '');
    const safeId = machineId.toLowerCase().replace(/[^a-z0-9-]/g, '_');
    const claimPath = (t: number) => join(dir, `rsm-inventory-refresh-${safeId}-${dayOf(t)}.claim`);
    try {
        closeSync(openSync(claimPath(now), 'wx'));
    } catch (error) {
        return (error as NodeJS.ErrnoException).code !== 'EEXIST';
    }
    try {
        unlinkSync(claimPath(now - 24 * 60 * 60 * 1000)); // yesterday's claim, if any
    } catch {
        // absent or locked: harmless
    }
    return true;
}

async function refreshBootResilienceInventory(): Promise<void> {
    if (!claimHostDailyInventoryRefresh(tmpdir(), hostname())) {
        return;
    }
    try {
        const { InventoryService } = await import('../services/roosync/InventoryService.js');
        await InventoryService.getInstance().getMachineInventory();
    } catch (error) {
        // Non-blocking: freshness is best-effort
        console.warn(`[AutoHeartbeat] bootResilience inventory refresh failed: ${(error as Error).message}`);
    }
}

/**
 * Check if auto-heartbeat should be triggered and trigger it if needed.
 *
 * @param toolName - Name of the tool that was just called (for metadata)
 * @returns true if heartbeat was triggered, false if skipped (within interval)
 */
export async function autoHeartbeat(toolName: string): Promise<boolean> {
    if (!isInitialized) {
        initAutoHeartbeat();
    }

    const now = Date.now();
    if (now - lastHeartbeatAt < HEARTBEAT_INTERVAL_MS) {
        return false; // Within interval, skip
    }

    try {
        const { getRooSyncService } = await import('../services/lazy-roosync.js');
        const service = await getRooSyncService();
        await service.registerHeartbeat({ triggeredBy: toolName });
        lastHeartbeatAt = Date.now();
        // #3975: daily-gated, fire-and-forget — jamais dans la latence de l'appel
        scheduleBootResilienceInventoryRefresh();
        return true;
    } catch (error) {
        // Non-blocking: heartbeat failure should not break tool execution
        console.warn(`[AutoHeartbeat] Failed to register heartbeat for ${toolName}: ${(error as Error).message}`);
        return false;
    }
}

/**
 * Get the current state of the auto-heartbeat module (for testing/debugging).
 */
export function getAutoHeartbeatState(): { lastHeartbeatAt: number; lastBootResilienceRefreshAt: number; isInitialized: boolean } {
    return { lastHeartbeatAt, lastBootResilienceRefreshAt, isInitialized };
}
