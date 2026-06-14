/**
 * Tests for sendMentionNotificationsAsync — fleet-roster validation (#2591)
 *
 * Ensures mention notifications are only sent to real fleet machines, preventing
 * orphan messages (to: prose tokens / bot names / test leaks) from accumulating
 * in the shared inbox and causing roosync_messages timeouts.
 *
 * @module utils/__tests__/send-mention-notifications
 * @issue #2591
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Hoisted mocks ───────────────────────────────────────────────────────────

const { mockSendMessage, mockFleetRoster } = vi.hoisted(() => ({
	mockSendMessage: vi.fn(),
	// Configurable roster per test (null = ROO_FLEET_ROSTER unset)
	mockFleetRoster: { value: null as string[] | null }
}));

vi.mock('../message-helpers.js', () => ({
	getLocalMachineId: () => 'myia-po-2025'
}));

vi.mock('../logger.js', () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}));

vi.mock('../server-helpers.js', () => ({
	getSharedStatePath: () => '/shared-state'
}));

vi.mock('../../services/MessageManager.js', () => ({
	getMessageManager: () => ({ sendMessage: mockSendMessage })
}));

vi.mock('../../config/roosync-config.js', () => ({
	tryLoadRooSyncConfig: () =>
		mockFleetRoster.value === null ? null : { fleetRoster: mockFleetRoster.value }
}));

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('sendMentionNotificationsAsync — fleet roster validation (#2591)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockSendMessage.mockResolvedValue(undefined);
	});

	it('sends notifications only to fleet-roster machines (skips orphans)', async () => {
		mockFleetRoster.value = ['myia-ai-01', 'myia-po-2025', 'myia-po-2023'];
		const { sendMentionNotificationsAsync } = await import('../dashboard-helpers.js');

		await sendMentionNotificationsAsync('msg-1', [
			{ type: 'machine', target: 'myia-ai-01', pattern: '@myia-ai-01' },     // in roster → sent
			{ type: 'machine', target: 'NanoClaw', pattern: '@NanoClaw' },          // orphan → skipped
			{ type: 'machine', target: 'test-machine', pattern: '@test-machine' },  // test leak → skipped
			{ type: 'machine', target: 'vscode', pattern: 'vscode' },               // prose token → skipped
			{ type: 'machine', target: 'myia-po-2023', pattern: '@myia-po-2023' }   // in roster → sent
		], 'workspace-roo-extensions', 'excerpt');

		// Only the 2 fleet machines notified.
		expect(mockSendMessage).toHaveBeenCalledTimes(2);
		const recipients = mockSendMessage.mock.calls.map((c: unknown[]) => c[1]);
		expect(recipients).toEqual(['myia-ai-01', 'myia-po-2023']);
	});

	it('skips bare alias not present in roster (e.g. "ai-01" vs "myia-ai-01")', async () => {
		mockFleetRoster.value = ['myia-ai-01'];
		const { sendMentionNotificationsAsync } = await import('../dashboard-helpers.js');

		await sendMentionNotificationsAsync('msg-2', [
			{ type: 'machine', target: 'ai-01', pattern: '@ai-01' }  // bare alias → orphan
		], 'workspace-roo-extensions', 'excerpt');

		expect(mockSendMessage).not.toHaveBeenCalled();
	});

	it('keeps legacy behavior (sends to all) when roster is null (ROO_FLEET_ROSTER unset)', async () => {
		mockFleetRoster.value = null;
		const { sendMentionNotificationsAsync } = await import('../dashboard-helpers.js');

		await sendMentionNotificationsAsync('msg-3', [
			{ type: 'machine', target: 'myia-ai-01', pattern: '@myia-ai-01' },
			{ type: 'machine', target: 'NanoClaw', pattern: '@NanoClaw' }
		], 'workspace-roo-extensions', 'excerpt');

		// Backward compat: no roster → no filtering.
		expect(mockSendMessage).toHaveBeenCalledTimes(2);
	});

	it('derives machine id for agent-type mentions and validates against roster', async () => {
		mockFleetRoster.value = ['myia-ai-01'];
		const { sendMentionNotificationsAsync } = await import('../dashboard-helpers.js');

		await sendMentionNotificationsAsync('msg-4', [
			// agent "roo-myia-ai-01" → derived machine "myia-ai-01" → in roster → sent
			{ type: 'agent', target: 'roo-myia-ai-01', pattern: '@roo-myia-ai-01' },
			// agent "roo-Hermes" → derived "Hermes" → not in roster → skipped
			{ type: 'agent', target: 'roo-Hermes', pattern: '@roo-Hermes' }
		], 'workspace-roo-extensions', 'excerpt');

		expect(mockSendMessage).toHaveBeenCalledTimes(1);
		expect(mockSendMessage.mock.calls[0][1]).toBe('myia-ai-01');
	});

	it('does nothing when no machine/agent mentions are present', async () => {
		mockFleetRoster.value = ['myia-ai-01'];
		const { sendMentionNotificationsAsync } = await import('../dashboard-helpers.js');

		await sendMentionNotificationsAsync('msg-5', [
			{ type: 'user', target: 'jsboige', pattern: '@jsboige' },
			{ type: 'message', target: 'ic-123', pattern: 'ic-123' }
		], 'workspace-roo-extensions', 'excerpt');

		expect(mockSendMessage).not.toHaveBeenCalled();
	});
});
