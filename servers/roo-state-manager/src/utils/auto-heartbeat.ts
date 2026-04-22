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

let lastHeartbeatAt: number = 0;
let isInitialized = false;

/**
 * Initialize the auto-heartbeat module.
 * Must be called once at server startup.
 */
export function initAutoHeartbeat(): void {
    lastHeartbeatAt = Date.now();
    isInitialized = true;
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
export function getAutoHeartbeatState(): { lastHeartbeatAt: number; isInitialized: boolean } {
    return { lastHeartbeatAt, isInitialized };
}
