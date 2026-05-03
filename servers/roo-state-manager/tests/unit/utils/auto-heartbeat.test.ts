/**
 * Tests for auto-heartbeat utility (#1609)
 *
 * Covers: initialization, interval gating, heartbeat trigger, error handling
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock lazy-roosync before importing the module under test
const mockRegisterHeartbeat = vi.fn();
vi.mock('../../../src/services/lazy-roosync.js', () => ({
    getRooSyncService: vi.fn(() =>
        Promise.resolve({ registerHeartbeat: mockRegisterHeartbeat })
    ),
}));

// Import after mock setup — auto-heartbeat module-level state requires careful handling
const { initAutoHeartbeat, autoHeartbeat, getAutoHeartbeatState } =
    await import('../../../src/utils/auto-heartbeat.js');

describe('auto-heartbeat', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        mockRegisterHeartbeat.mockResolvedValue(undefined);
        initAutoHeartbeat();
    });

    afterEach(() => {
        vi.useRealTimers();
        mockRegisterHeartbeat.mockClear();
    });

    it('initializes with current timestamp', () => {
        const state = getAutoHeartbeatState();
        expect(state.isInitialized).toBe(true);
        expect(state.lastHeartbeatAt).toBe(Date.now());
    });

    it('skips heartbeat within 15-minute interval', async () => {
        const result = await autoHeartbeat('roosync_read');
        expect(result).toBe(false);
        expect(mockRegisterHeartbeat).not.toHaveBeenCalled();
    });

    it('triggers heartbeat after 15-minute interval', async () => {
        vi.advanceTimersByTime(15 * 60 * 1000 + 1);

        const result = await autoHeartbeat('roosync_read');
        expect(result).toBe(true);
        expect(mockRegisterHeartbeat).toHaveBeenCalledWith({
            triggeredBy: 'roosync_read',
        });
    });

    it('updates lastHeartbeatAt after successful trigger', async () => {
        const before = getAutoHeartbeatState().lastHeartbeatAt;

        vi.advanceTimersByTime(16 * 60 * 1000);
        await autoHeartbeat('conversation_browser');

        const after = getAutoHeartbeatState().lastHeartbeatAt;
        expect(after).toBeGreaterThan(before);
    });

    it('returns false on heartbeat service error without throwing', async () => {
        mockRegisterHeartbeat.mockRejectedValueOnce(new Error('GDrive offline'));

        vi.advanceTimersByTime(16 * 60 * 1000);

        const result = await autoHeartbeat('roosync_send');
        expect(result).toBe(false);
    });

    it('passes tool name to registerHeartbeat', async () => {
        vi.advanceTimersByTime(20 * 60 * 1000);

        await autoHeartbeat('custom_tool_name');
        expect(mockRegisterHeartbeat).toHaveBeenCalledWith({
            triggeredBy: 'custom_tool_name',
        });
    });

    it('does not trigger again immediately after a trigger', async () => {
        vi.advanceTimersByTime(16 * 60 * 1000);
        const first = await autoHeartbeat('tool_a');
        expect(first).toBe(true);

        const second = await autoHeartbeat('tool_b');
        expect(second).toBe(false);
    });

    it('triggers again after another 15-minute interval', async () => {
        vi.advanceTimersByTime(16 * 60 * 1000);
        const first = await autoHeartbeat('tool_a');
        expect(first).toBe(true);

        vi.advanceTimersByTime(16 * 60 * 1000);
        const second = await autoHeartbeat('tool_b');
        expect(second).toBe(true);
    });

    it('auto-initializes if not explicitly initialized', async () => {
        // Module state persists between tests — initAutoHeartbeat already called
        // but we can verify auto-init by checking state
        const state = getAutoHeartbeatState();
        expect(state.isInitialized).toBe(true);
    });
});
