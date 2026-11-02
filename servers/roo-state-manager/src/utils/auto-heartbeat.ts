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

import { closeSync, openSync, readdirSync, unlinkSync } from 'fs';
import { hostname, tmpdir, uptime } from 'os';
import { join } from 'path';

const HEARTBEAT_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

// #3975: rafraîchissement quotidien de l'inventaire local (bootResilience inclus)
// piggybacké sur le heartbeat — même pattern side-effect d'appel outil qu'ADR 008,
// PAS un interval de fond. Un spawn PowerShell max par jour et par HÔTE (#4131).
const BOOT_RESILIENCE_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h

// #4131 Phase D (ai-01, 02/11 12:10:40Z): a rebuild hot-swaps every RSM process
// of a host within seconds, and each one refreshed the inventory on its first
// heartbeat — ~20 concurrent PG upserts inside the deploy burst. One of them
// hit `timeout expired`, and the PG failure path wrote the GDrive mirror,
// resetting the write freeze. The refresh is now delayed out of the burst and
// claimed ONCE per host, per boot, per UTC day: every process of a host
// collects the same machine inventory, so one refresh is enough. The boot is
// part of the claim because a reboot is the event that changes bootResilience.
// Known limit: a process must live past its 2-5 min delay to refresh (the
// timer is unref'd); a host running only short-lived RSM processes publishes
// nothing — every fleet seat runs long-lived interactive RSM processes.
const INVENTORY_REFRESH_DELAY_MIN_MS = 2 * 60 * 1000;
const INVENTORY_REFRESH_DELAY_SPREAD_MS = 3 * 60 * 1000;
// Boot identity = boot time in 10-min buckets: `uptime()` jitter cannot split
// one boot into two claims except on a bucket edge (then 2 refreshes, not 20).
const BOOT_BUCKET_S = 600;

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

/** #4131: boot identity of this host, in BOOT_BUCKET_S buckets of the boot time. */
export function currentBootId(now: number = Date.now()): number {
    return Math.floor((now / 1000 - uptime()) / BOOT_BUCKET_S);
}

function safeClaimId(machineId: string): string {
    return machineId.toLowerCase().replace(/[^a-z0-9-]/g, '_');
}

function claimFileName(machineId: string, now: number, bootId: number): string {
    const day = new Date(now).toISOString().slice(0, 10).replace(/-/g, '');
    return `rsm-inventory-refresh-${safeClaimId(machineId)}-${day}-b${bootId}.claim`;
}

/**
 * #4131: atomic first-wins claim (`wx`) on
 * `<dir>/rsm-inventory-refresh-<id>-<UTC day>-b<boot>.claim`.
 * Returns true when this process should refresh. EEXIST = another process of
 * the host already took this boot's refresh for today. Any other error
 * (unwritable dir) fails OPEN — the pre-#4131 per-process refresh, never a
 * silent stop. The winner removes every older claim of the same id.
 */
export function claimHostDailyInventoryRefresh(
    dir: string,
    machineId: string,
    now: number = Date.now(),
    bootId: number = currentBootId(now),
): boolean {
    const name = claimFileName(machineId, now, bootId);
    try {
        closeSync(openSync(join(dir, name), 'wx'));
    } catch (error) {
        return (error as NodeJS.ErrnoException).code !== 'EEXIST';
    }
    const sameId = new RegExp(`^rsm-inventory-refresh-${safeClaimId(machineId)}-\\d{8}-b-?\\d+\\.claim$`);
    try {
        for (const entry of readdirSync(dir)) {
            if (entry !== name && sameId.test(entry)) {
                try { unlinkSync(join(dir, entry)); } catch { /* locked: harmless */ }
            }
        }
    } catch {
        // unreadable dir: stale claims stay, harmless
    }
    return true;
}

/** #4131: give the claim back after a failed refresh, so a later process of the host retries. */
export function releaseHostDailyInventoryRefresh(dir: string, machineId: string, now: number, bootId: number): void {
    try {
        unlinkSync(join(dir, claimFileName(machineId, now, bootId)));
    } catch {
        // absent: the fail-open path never wrote it
    }
}

async function refreshBootResilienceInventory(): Promise<void> {
    const dir = tmpdir();
    const machineId = hostname();
    const now = Date.now();
    const bootId = currentBootId(now);
    try {
        if (!claimHostDailyInventoryRefresh(dir, machineId, now, bootId)) {
            return;
        }
        const { InventoryService } = await import('../services/roosync/InventoryService.js');
        await InventoryService.getInstance().getMachineInventory();
    } catch (error) {
        releaseHostDailyInventoryRefresh(dir, machineId, now, bootId);
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
