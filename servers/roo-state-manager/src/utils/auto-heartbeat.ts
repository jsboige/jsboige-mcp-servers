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

const HEARTBEAT_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

// #3975: rafraîchissement quotidien de l'inventaire local (bootResilience inclus)
// piggybacké sur le heartbeat — même pattern side-effect d'appel outil qu'ADR 008,
// PAS un interval de fond. Un spawn PowerShell max par jour et par process.
const BOOT_RESILIENCE_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h

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
 * the tool call). Keeps .shared-state/inventories/{machineId}.json fresh so
 * cross-machine reads (audit tick, compare_config boot-resilience) see the
 * current boot resilience state — the po-2025 outage stayed invisible because
 * the fleet inventory was 8 days stale.
 */
async function refreshBootResilienceInventory(): Promise<void> {
    if (Date.now() - lastBootResilienceRefreshAt < BOOT_RESILIENCE_REFRESH_INTERVAL_MS) {
        return;
    }
    lastBootResilienceRefreshAt = Date.now(); // set first: one spawn/day even on failure
    // Garde tests (pattern mcp-management.ts) — pas d'I/O réelle sous vitest
    if (process.env.NODE_ENV === 'test' || process.env.VITEST) {
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
        void refreshBootResilienceInventory();
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
