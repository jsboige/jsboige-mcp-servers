/**
 * Tests for sendMentionNotificationsAsync — fleet-recipient validation (#2591)
 *
 * Ensures mention notifications are only sent to real fleet machines, preventing
 * orphan messages (to: prose tokens / bot names / test leaks) from accumulating
 * in the shared inbox and causing roosync_messages timeouts.
 *
 * The guard is shape-first (`myia-*`), so it holds with NO configuration. The
 * pre-#2591 version was conditional on ROO_FLEET_ROSTER — which also drives
 * index partitioning (background-services.ts `state.fleetRoster`) and is unset
 * on most seats, leaving the orphan stream wide open there.
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

	it('filters with NO roster configured — the pre-#2591 guard was inert there', async () => {
		mockFleetRoster.value = null;
		const { sendMentionNotificationsAsync } = await import('../dashboard-helpers.js');

		await sendMentionNotificationsAsync('msg-3', [
			{ type: 'machine', target: 'myia-ai-01', pattern: '@myia-ai-01' },  // fleet shape → sent
			{ type: 'machine', target: 'NanoClaw', pattern: '@NanoClaw' },      // bot name → skipped
			{ type: 'machine', target: 'head', pattern: '@head' },              // prose → skipped
			{ type: 'machine', target: 'main', pattern: '@main' },              // git ref → skipped
			{ type: 'machine', target: 'v4', pattern: '@v4' },                  // version → skipped
			{ type: 'machine', target: 'gmail', pattern: '@gmail' },            // mail domain → skipped
			{ type: 'machine', target: '11', pattern: '@11' },                  // number → skipped
			{ type: 'machine', target: '3f7a9c1e', pattern: '@3f7a9c1e' }       // SHA fragment → skipped
		], 'workspace-roo-extensions', 'excerpt');

		// The shape gate holds with no configuration at all: this is the exact
		// population measured on the live orphans (#2591).
		expect(mockSendMessage).toHaveBeenCalledTimes(1);
		expect(mockSendMessage.mock.calls[0][1]).toBe('myia-ai-01');
	});

	it('accepts a fleet-shaped machine the roster omits (divergent roster must not drop mentions)', async () => {
		// Measured 07/10: myia-po-2027 absent from the vllm project roster,
		// myia-web2 absent from both known values. Union, not intersection.
		mockFleetRoster.value = ['myia-ai-01', 'myia-po-2023'];
		const { sendMentionNotificationsAsync } = await import('../dashboard-helpers.js');

		await sendMentionNotificationsAsync('msg-6', [
			{ type: 'machine', target: 'myia-po-2027', pattern: '@myia-po-2027' }
		], 'workspace-roo-extensions', 'excerpt');

		expect(mockSendMessage).toHaveBeenCalledTimes(1);
		expect(mockSendMessage.mock.calls[0][1]).toBe('myia-po-2027');
	});

	it('accepts a roster member whose id does not follow the myia-* convention', async () => {
		// Second acceptance path, for a machine id outside the naming convention.
		mockFleetRoster.value = ['special-host-01'];
		const { sendMentionNotificationsAsync } = await import('../dashboard-helpers.js');

		await sendMentionNotificationsAsync('msg-7', [
			{ type: 'agent', target: 'roo-special-host-01', pattern: '@roo-special-host-01' }
		], 'workspace-roo-extensions', 'excerpt');

		expect(mockSendMessage).toHaveBeenCalledTimes(1);
		expect(mockSendMessage.mock.calls[0][1]).toBe('special-host-01');
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

describe('isFleetRecipient — shape gate + roster union (#2591)', () => {
	it('accepts every machine id measured in .shared-state/configs (8/8) with no roster', async () => {
		const { isFleetRecipient } = await import('../dashboard-helpers.js');
		const fleet = [
			'myia-ai-01', 'myia-po-2023', 'myia-po-2024', 'myia-po-2025',
			'myia-po-2026', 'myia-po-2027', 'myia-web1', 'myia-web2'
		];
		for (const machine of fleet) {
			expect(isFleetRecipient(machine, null), `${machine} must be accepted`).toBe(true);
		}
	});

	it('rejects the orphan population measured on #2591 with no roster', async () => {
		const { isFleetRecipient } = await import('../dashboard-helpers.js');
		const orphans = [
			'head', 'main', 'v4', 'gmail', '11', 'test-machine', 'ci-test-machine',
			'NanoClaw', 'Hermes', 'vscode', 'playwright', 'anthropic', 'ai-01',
			'3f7a9c1e2b', 'Myia-Po-2027'
		];
		for (const orphan of orphans) {
			expect(isFleetRecipient(orphan, null), `${orphan} must be rejected`).toBe(false);
		}
	});

	it('keeps the roster as an independent second acceptance path', async () => {
		const { isFleetRecipient } = await import('../dashboard-helpers.js');
		expect(isFleetRecipient('special-host-01', ['special-host-01'])).toBe(true);
		expect(isFleetRecipient('special-host-01', ['myia-ai-01'])).toBe(false);
		expect(isFleetRecipient('special-host-01', null)).toBe(false);
	});

	it('does not admit anything just because a roster is configured', async () => {
		const { isFleetRecipient } = await import('../dashboard-helpers.js');
		// A stale roster must not resurrect the orphan class it was meant to stop.
		expect(isFleetRecipient('NanoClaw', ['myia-ai-01', 'myia-po-2025'])).toBe(false);
	});
});

describe('extra mention recipients — out-of-shape live consumers (review ms#1408)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockSendMessage.mockResolvedValue(undefined);
	});

	afterEach(() => {
		delete process.env.ROO_MENTION_EXTRA_RECIPIENTS;
	});

	it('still notifies @nanoclaw-cluster with no roster — the NanoClaw poller machine id (measured regression)', async () => {
		mockFleetRoster.value = null;
		delete process.env.ROO_MENTION_EXTRA_RECIPIENTS;
		const { sendMentionNotificationsAsync } = await import('../dashboard-helpers.js');

		await sendMentionNotificationsAsync('msg-8', [
			{ type: 'machine', target: 'nanoclaw-cluster', pattern: '@nanoclaw-cluster' }
		], 'workspace-roo-extensions', 'excerpt');

		expect(mockSendMessage).toHaveBeenCalledTimes(1);
		expect(mockSendMessage.mock.calls[0][1]).toBe('nanoclaw-cluster');
	});

	it('still drops the unread orphan look-alikes NanoClaw / Hermes / hermes-pr-review', async () => {
		// Counter-requirement of the review: the default list is the poller's machine
		// id, NOT every bot-shaped token — 87/56/25 unread with no consumer.
		mockFleetRoster.value = null;
		delete process.env.ROO_MENTION_EXTRA_RECIPIENTS;
		const { sendMentionNotificationsAsync } = await import('../dashboard-helpers.js');

		await sendMentionNotificationsAsync('msg-9', [
			{ type: 'machine', target: 'NanoClaw', pattern: '@NanoClaw' },
			{ type: 'machine', target: 'Hermes', pattern: '@Hermes' },
			{ type: 'machine', target: 'hermes-pr-review', pattern: '@hermes-pr-review' }
		], 'workspace-roo-extensions', 'excerpt');

		expect(mockSendMessage).not.toHaveBeenCalled();
	});

	it('ROO_MENTION_EXTRA_RECIPIENTS extends the default list (seat-local, no code change)', async () => {
		mockFleetRoster.value = null;
		process.env.ROO_MENTION_EXTRA_RECIPIENTS = ' Custom-Bot , second-bot ';
		const { sendMentionNotificationsAsync } = await import('../dashboard-helpers.js');

		await sendMentionNotificationsAsync('msg-10', [
			{ type: 'machine', target: 'custom-bot', pattern: '@custom-bot' },
			{ type: 'machine', target: 'second-bot', pattern: '@second-bot' },
			{ type: 'machine', target: 'unlisted-bot', pattern: '@unlisted-bot' }
		], 'workspace-roo-extensions', 'excerpt');

		const recipients = mockSendMessage.mock.calls.map((c: unknown[]) => c[1]);
		expect(recipients).toEqual(['custom-bot', 'second-bot']);
	});

	it('loadExtraMentionRecipients — default ∪ env, deduped, lowercased', async () => {
		const { loadExtraMentionRecipients } = await import('../dashboard-helpers.js');

		delete process.env.ROO_MENTION_EXTRA_RECIPIENTS;
		expect(loadExtraMentionRecipients()).toEqual(['nanoclaw-cluster']);

		process.env.ROO_MENTION_EXTRA_RECIPIENTS = 'NANOCLAW-CLUSTER, extra-one';
		expect(loadExtraMentionRecipients()).toEqual(['nanoclaw-cluster', 'extra-one']);

		process.env.ROO_MENTION_EXTRA_RECIPIENTS = ' , ,';
		expect(loadExtraMentionRecipients()).toEqual(['nanoclaw-cluster']);
	});

	it('isFleetRecipient — extra list is an independent third acceptance path', async () => {
		const { isFleetRecipient } = await import('../dashboard-helpers.js');

		expect(isFleetRecipient('nanoclaw-cluster', null)).toBe(false);          // no extra passed
		expect(isFleetRecipient('nanoclaw-cluster', null, ['nanoclaw-cluster'])).toBe(true);
		expect(isFleetRecipient('NanoClaw', null, ['nanoclaw-cluster'])).toBe(false); // case matters
		expect(isFleetRecipient('nanoclaw-cluster', ['myia-ai-01'], [])).toBe(false); // empty extra, roster w/o it
	});
});
