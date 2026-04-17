/**
 * Tests for dashboard-helpers.ts
 *
 * Covers updateDashboardActivityAsync and updateDashboardMetricsAsync:
 * - Early-exit when dashboard file is missing
 * - Machine section not found
 * - Workspace subsection replacement
 * - Workspace subsection creation
 * - "Dernière mise à jour" timestamp update
 * - GitHub metrics fetch failure
 * - Métriques section not found
 * - Normal metrics update path
 *
 * @module utils/__tests__/dashboard-helpers
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Hoisted mocks ───────────────────────────────────────────────────────────
// NOTE: util.promisify(exec) uses the Symbol.for('nodejs.util.promisify.custom')
// property to determine what the promisified version does.
// To mock this correctly, we attach a vi.fn() to that symbol so the module
// captures our mock when it calls promisify(exec) at load time.

const { mockAccess, mockReadFile, mockWriteFile, mockExecPromisified } = vi.hoisted(() => ({
	mockAccess: vi.fn(),
	mockReadFile: vi.fn(),
	mockWriteFile: vi.fn(),
	// This is what execAsync() resolves to — set mockResolvedValue in each test
	mockExecPromisified: vi.fn()
}));

vi.mock('fs/promises', () => ({
	access: mockAccess,
	readFile: mockReadFile,
	writeFile: mockWriteFile
}));

vi.mock('child_process', () => {
	// Attach the custom promisify symbol so util.promisify(exec) uses mockExecPromisified
	const exec = vi.fn() as any;
	exec[Symbol.for('nodejs.util.promisify.custom')] = mockExecPromisified;
	return { exec };
});

vi.mock('../server-helpers.js', () => ({
	getSharedStatePath: () => '/shared-state'
}));

vi.mock('../message-helpers.js', () => ({
	getLocalMachineId: () => 'myia-po-2025'
}));

vi.mock('../logger.js', () => ({
	createLogger: () => ({
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn()
	})
}));

// ─── Dynamic import (needed because promisify wraps exec at module load) ──────

async function getModule() {
	vi.resetModules();
	vi.doMock('fs/promises', () => ({
		access: mockAccess,
		readFile: mockReadFile,
		writeFile: mockWriteFile
	}));
	vi.doMock('child_process', () => {
		const exec = vi.fn() as any;
		exec[Symbol.for('nodejs.util.promisify.custom')] = mockExecPromisified;
		return { exec };
	});
	vi.doMock('../server-helpers.js', () => ({ getSharedStatePath: () => '/shared-state' }));
	vi.doMock('../message-helpers.js', () => ({ getLocalMachineId: () => 'myia-po-2025' }));
	vi.doMock('../logger.js', () => ({
		createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
	}));
	return import('../dashboard-helpers.js');
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeDashboard(opts: {
	hasMachineSection?: boolean;
	hasWorkspaceSection?: boolean;
	hasLastUpdated?: boolean;
	hasMetricsSection?: boolean;
	hasNextSection?: boolean;
} = {}): string {
	const lines: string[] = [];

	if (opts.hasLastUpdated !== false) {
		lines.push('**Dernière mise à jour:** 2026-01-01 00:00:00 par old-machine:old-workspace');
		lines.push('');
	}

	if (opts.hasMachineSection !== false) {
		lines.push('### myia-po-2025');
		if (opts.hasWorkspaceSection) {
			lines.push('');
			lines.push('#### roo-extensions old content');
			lines.push('- old item');
		}
		lines.push('');
	}

	if (opts.hasMetricsSection !== false) {
		lines.push('## Métriques');
		lines.push('| old | data |');
		if (opts.hasNextSection) {
			lines.push('## Next Section');
			lines.push('content');
		}
	}

	return lines.join('\n');
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('updateDashboardActivityAsync', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns early when dashboard file does not exist', async () => {
		mockAccess.mockRejectedValue(new Error('ENOENT'));
		const { updateDashboardActivityAsync } = await getModule();

		await updateDashboardActivityAsync('Test action');

		expect(mockReadFile).not.toHaveBeenCalled();
		expect(mockWriteFile).not.toHaveBeenCalled();
	});

	it('returns early when machine section not found in dashboard', async () => {
		mockAccess.mockResolvedValue(undefined);
		mockReadFile.mockResolvedValue(
			'### other-machine\n- some content\n'
		);
		const { updateDashboardActivityAsync } = await getModule();

		await updateDashboardActivityAsync('Test action');

		expect(mockWriteFile).not.toHaveBeenCalled();
	});

	it('inserts workspace subsection when it does not exist', async () => {
		mockAccess.mockResolvedValue(undefined);
		mockReadFile.mockResolvedValue(makeDashboard({ hasMachineSection: true, hasWorkspaceSection: false }));
		mockWriteFile.mockResolvedValue(undefined);
		const { updateDashboardActivityAsync } = await getModule();

		await updateDashboardActivityAsync('New activity');

		expect(mockWriteFile).toHaveBeenCalledOnce();
		const written: string = mockWriteFile.mock.calls[0][1];
		expect(written).toContain('New activity');
		expect(written).toContain('#### Dernière activité');
	});

	it('replaces existing workspace subsection', async () => {
		mockAccess.mockResolvedValue(undefined);
		mockReadFile.mockResolvedValue(makeDashboard({ hasMachineSection: true, hasWorkspaceSection: true }));
		mockWriteFile.mockResolvedValue(undefined);
		const { updateDashboardActivityAsync } = await getModule();

		await updateDashboardActivityAsync('Updated activity');

		expect(mockWriteFile).toHaveBeenCalledOnce();
		const written: string = mockWriteFile.mock.calls[0][1];
		expect(written).toContain('Updated activity');
		// Old content should be replaced
		expect(written).not.toContain('old item');
	});

	it('includes messageId and subject in content when provided', async () => {
		mockAccess.mockResolvedValue(undefined);
		mockReadFile.mockResolvedValue(makeDashboard({ hasMachineSection: true }));
		mockWriteFile.mockResolvedValue(undefined);
		const { updateDashboardActivityAsync } = await getModule();

		await updateDashboardActivityAsync('Sent message', {
			messageId: 'msg-123',
			subject: 'Test subject'
		});

		const written: string = mockWriteFile.mock.calls[0][1];
		expect(written).toContain('msg-123');
		expect(written).toContain('Test subject');
	});

	it('does not include messageId/subject placeholders when details omitted', async () => {
		mockAccess.mockResolvedValue(undefined);
		mockReadFile.mockResolvedValue(makeDashboard({ hasMachineSection: true }));
		mockWriteFile.mockResolvedValue(undefined);
		const { updateDashboardActivityAsync } = await getModule();

		await updateDashboardActivityAsync('Simple action');

		const written: string = mockWriteFile.mock.calls[0][1];
		// Should not contain empty metadata lines
		expect(written).not.toMatch(/\*\*Message ID :\*\*\s*`undefined`/);
		expect(written).not.toMatch(/\*\*Sujet :\*\* undefined/);
	});

	it('updates the global "Dernière mise à jour" timestamp', async () => {
		mockAccess.mockResolvedValue(undefined);
		mockReadFile.mockResolvedValue(makeDashboard({ hasMachineSection: true, hasLastUpdated: true }));
		mockWriteFile.mockResolvedValue(undefined);
		const { updateDashboardActivityAsync } = await getModule();

		await updateDashboardActivityAsync('Action with timestamp');

		const written: string = mockWriteFile.mock.calls[0][1];
		expect(written).toContain('myia-po-2025:roo-extensions');
		// Old machine name should be replaced
		expect(written).not.toContain('old-machine:old-workspace');
	});

	it('does not throw when an unexpected error occurs (fire-and-forget)', async () => {
		mockAccess.mockResolvedValue(undefined);
		mockReadFile.mockRejectedValue(new Error('Disk failure'));
		const { updateDashboardActivityAsync } = await getModule();

		// Should not throw
		await expect(updateDashboardActivityAsync('Action')).resolves.toBeUndefined();
	});
});

describe('updateDashboardMetricsAsync', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns early when dashboard does not exist', async () => {
		mockAccess.mockRejectedValue(new Error('ENOENT'));
		const { updateDashboardMetricsAsync } = await getModule();

		await updateDashboardMetricsAsync();

		expect(mockExecPromisified).not.toHaveBeenCalled();
		expect(mockWriteFile).not.toHaveBeenCalled();
	});

	it('returns early when GitHub metrics fetch fails', async () => {
		mockAccess.mockResolvedValue(undefined);
		// execAsync rejects (gh CLI not available)
		mockExecPromisified.mockRejectedValue(new Error('gh: command not found'));
		const { updateDashboardMetricsAsync } = await getModule();

		await updateDashboardMetricsAsync();

		expect(mockWriteFile).not.toHaveBeenCalled();
	});

	it('returns early when Métriques section not found', async () => {
		mockAccess.mockResolvedValue(undefined);
		// GitHub CLI succeeds for both calls
		mockExecPromisified
			.mockResolvedValueOnce({ stdout: JSON.stringify({ data: { user: { projectV2: { items: { totalCount: 10 } } } } }), stderr: '' })
			.mockResolvedValueOnce({ stdout: '5', stderr: '' });
		// Dashboard without Métriques section
		mockReadFile.mockResolvedValue('### myia-po-2025\n- some content\n');
		const { updateDashboardMetricsAsync } = await getModule();

		await updateDashboardMetricsAsync();

		expect(mockWriteFile).not.toHaveBeenCalled();
	});

	it('updates dashboard when metrics are available and section exists', async () => {
		mockAccess.mockResolvedValue(undefined);
		// Two execAsync calls: gh api graphql, then gh issue list
		mockExecPromisified
			.mockResolvedValueOnce({ stdout: JSON.stringify({ data: { user: { projectV2: { items: { totalCount: 283 } } } } }), stderr: '' })
			.mockResolvedValueOnce({ stdout: '25', stderr: '' });
		mockReadFile.mockResolvedValue(makeDashboard({ hasMetricsSection: true, hasMachineSection: false }));
		mockWriteFile.mockResolvedValue(undefined);
		const { updateDashboardMetricsAsync } = await getModule();

		await updateDashboardMetricsAsync();

		expect(mockWriteFile).toHaveBeenCalledOnce();
		const written: string = mockWriteFile.mock.calls[0][1];
		expect(written).toContain('283');
		expect(written).toContain('25');
		expect(written).toContain('## Métriques');
	});

	it('handles next section boundary when updating metrics', async () => {
		mockAccess.mockResolvedValue(undefined);
		// Two execAsync calls
		mockExecPromisified
			.mockResolvedValueOnce({ stdout: JSON.stringify({ data: { user: { projectV2: { items: { totalCount: 100 } } } } }), stderr: '' })
			.mockResolvedValueOnce({ stdout: '10', stderr: '' });
		// Dashboard with metrics AND a subsequent section
		mockReadFile.mockResolvedValue(
			makeDashboard({ hasMetricsSection: true, hasNextSection: true, hasMachineSection: false })
		);
		mockWriteFile.mockResolvedValue(undefined);
		const { updateDashboardMetricsAsync } = await getModule();

		await updateDashboardMetricsAsync();

		expect(mockWriteFile).toHaveBeenCalledOnce();
		const written: string = mockWriteFile.mock.calls[0][1];
		// Next section should be preserved
		expect(written).toContain('## Next Section');
	});

	it('does not throw when an unexpected error occurs (fire-and-forget)', async () => {
		mockAccess.mockResolvedValue(undefined);
		mockExecPromisified.mockResolvedValueOnce({
			stdout: JSON.stringify({ data: { user: { projectV2: { items: { totalCount: 50 } } } } }),
			stderr: ''
		});
		mockReadFile.mockRejectedValue(new Error('Read error'));
		const { updateDashboardMetricsAsync } = await getModule();

		await expect(updateDashboardMetricsAsync()).resolves.toBeUndefined();
	});
});

describe('sendMentionNotificationsAsync', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('does not throw with empty mention list (fire-and-forget)', async () => {
		const { sendMentionNotificationsAsync } = await getModule();
		await expect(sendMentionNotificationsAsync('msg-123', [], 'workspace-test', 'Test content')).resolves.toBeUndefined();
	});

	it('does not throw when called with various mention types (fire-and-forget)', async () => {
		const { sendMentionNotificationsAsync } = await getModule();
		const mentions = [
			{ type: 'machine' as const, target: 'myia-ai-01', pattern: '@myia-ai-01' },
			{ type: 'agent' as const, target: 'roo-myia-po-2025', pattern: '@roo-myia-po-2025' },
			{ type: 'user' as const, target: 'jsboige', pattern: '@jsboige' },
			{ type: 'message' as const, target: 'ic-2026-04-13', pattern: '@msg:ic-2026-04-13' }
		];

		await expect(sendMentionNotificationsAsync('msg-123', mentions, 'workspace-test', 'Test content')).resolves.toBeUndefined();
	});

	it('does not throw when RooSync service is unavailable (fire-and-forget)', async () => {
		const { sendMentionNotificationsAsync } = await getModule();
		const mentions = [
			{ type: 'machine' as const, target: 'myia-ai-01', pattern: '@myia-ai-01' }
		];

		// Should not throw even if MessageManager is not available
		await expect(sendMentionNotificationsAsync('msg-123', mentions, 'workspace-test', 'Test content')).resolves.toBeUndefined();
	});
});

// ─── sendStructuredMentionNotificationsAsync — #1472 workspace-loss fix ──────

describe('sendStructuredMentionNotificationsAsync', () => {
	const mockSendMessage = vi.fn();

	async function getStructuredModule() {
		vi.resetModules();
		mockSendMessage.mockReset();
		mockSendMessage.mockResolvedValue({ id: 'msg-fake' });

		vi.doMock('fs/promises', () => ({
			access: mockAccess,
			readFile: mockReadFile,
			writeFile: mockWriteFile
		}));
		vi.doMock('child_process', () => {
			const exec = vi.fn() as any;
			exec[Symbol.for('nodejs.util.promisify.custom')] = mockExecPromisified;
			return { exec };
		});
		vi.doMock('../server-helpers.js', () => ({ getSharedStatePath: () => '/shared-state' }));
		vi.doMock('../message-helpers.js', () => ({ getLocalMachineId: () => 'myia-po-2025' }));
		vi.doMock('../logger.js', () => ({
			createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
		}));

		// Mock MessageManager: sendMessage reflects the real anti-auto-message check
		// (parseMachineWorkspace + self-message guard from MessageManager.ts:336-345).
		vi.doMock('../../services/MessageManager.js', () => ({
			getMessageManager: () => ({
				sendMessage: (from: string, to: string, ...rest: any[]) => {
					// Replicate parseMachineWorkspace from message-helpers.ts:157-166
					const parse = (id: string) => {
						const i = id.indexOf(':');
						return i === -1
							? { machineId: id, workspaceId: undefined }
							: { machineId: id.substring(0, i), workspaceId: id.substring(i + 1) };
					};
					const f = parse(from);
					const t = parse(to);
					if (f.machineId === t.machineId && f.workspaceId === t.workspaceId) {
						throw new Error(`Auto-message interdit : ${from} ne peut pas envoyer de message à ${to}`);
					}
					return mockSendMessage(from, to, ...rest);
				}
			})
		}));

		return import('../dashboard-helpers.js');
	}

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('passes qualified from (machineId:workspace) to sendMessage', async () => {
		const { sendStructuredMentionNotificationsAsync } = await getStructuredModule();
		await sendStructuredMentionNotificationsAsync(
			{ machineId: 'myia-ai-01', workspace: 'roo-extensions' },
			'msg-1',
			[{ machineId: 'myia-po-2023', workspace: 'roo-extensions' }],
			'workspace-roo-extensions',
			'content'
		);
		expect(mockSendMessage).toHaveBeenCalledOnce();
		const [from, to] = mockSendMessage.mock.calls[0];
		expect(from).toBe('myia-ai-01:roo-extensions');
		expect(to).toBe('myia-po-2023:roo-extensions');
	});

	it('does NOT block cross-workspace same-machine mentions (#1472 fix)', async () => {
		const { sendStructuredMentionNotificationsAsync } = await getStructuredModule();
		await sendStructuredMentionNotificationsAsync(
			{ machineId: 'myia-ai-01', workspace: 'roo-extensions' },
			'msg-1',
			[{ machineId: 'myia-ai-01', workspace: 'nanoclaw' }],
			'workspace-roo-extensions',
			'content'
		);
		// BEFORE #1472: bare machineId both sides → undefined===undefined → BLOCK
		// AFTER #1472: qualified both sides → workspaces differ → NOT BLOCK
		expect(mockSendMessage).toHaveBeenCalledOnce();
		const [from, to] = mockSendMessage.mock.calls[0];
		expect(from).toBe('myia-ai-01:roo-extensions');
		expect(to).toBe('myia-ai-01:nanoclaw');
	});

	it('still blocks self-mention same-machine-same-workspace (fire-and-forget)', async () => {
		const { sendStructuredMentionNotificationsAsync } = await getStructuredModule();
		await sendStructuredMentionNotificationsAsync(
			{ machineId: 'myia-ai-01', workspace: 'roo-extensions' },
			'msg-1',
			[{ machineId: 'myia-ai-01', workspace: 'roo-extensions' }],
			'workspace-roo-extensions',
			'content'
		);
		// Anti-auto-message throws inside sendMessage; mockSendMessage never reached.
		expect(mockSendMessage).not.toHaveBeenCalled();
	});

	it('dispatches one notification per (machineId, workspace) target pair', async () => {
		const { sendStructuredMentionNotificationsAsync } = await getStructuredModule();
		await sendStructuredMentionNotificationsAsync(
			{ machineId: 'myia-ai-01', workspace: 'roo-extensions' },
			'msg-1',
			[
				{ machineId: 'myia-ai-01', workspace: 'nanoclaw' },
				{ machineId: 'myia-ai-01', workspace: 'another' },
				{ machineId: 'myia-po-2023', workspace: 'roo-extensions' }
			],
			'workspace-roo-extensions',
			'content'
		);
		expect(mockSendMessage).toHaveBeenCalledTimes(3);
		const tos = mockSendMessage.mock.calls.map(c => c[1]).sort();
		expect(tos).toEqual([
			'myia-ai-01:another',
			'myia-ai-01:nanoclaw',
			'myia-po-2023:roo-extensions'
		]);
	});

	it('dedups identical (machineId, workspace) targets (same userId mentioned twice)', async () => {
		const { sendStructuredMentionNotificationsAsync } = await getStructuredModule();
		await sendStructuredMentionNotificationsAsync(
			{ machineId: 'myia-ai-01', workspace: 'roo-extensions' },
			'msg-1',
			[
				{ machineId: 'myia-po-2023', workspace: 'roo-extensions' },
				{ machineId: 'myia-po-2023', workspace: 'roo-extensions' }
			],
			'workspace-roo-extensions',
			'content'
		);
		expect(mockSendMessage).toHaveBeenCalledOnce();
	});

	it('does not throw when sendMessage fails (fire-and-forget)', async () => {
		vi.resetModules();
		vi.doMock('../../services/MessageManager.js', () => ({
			getMessageManager: () => ({
				sendMessage: () => { throw new Error('Network fail'); }
			})
		}));
		vi.doMock('../logger.js', () => ({
			createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
		}));
		const mod = await import('../dashboard-helpers.js');
		await expect(
			mod.sendStructuredMentionNotificationsAsync(
				{ machineId: 'myia-ai-01', workspace: 'roo-extensions' },
				'msg-1',
				[{ machineId: 'myia-po-2023', workspace: 'roo-extensions' }],
				'workspace-roo-extensions',
				'content'
			)
		).resolves.toBeUndefined();
	});

	it('does not throw when getMessageManager fails (outer catch, fire-and-forget)', async () => {
		vi.resetModules();
		vi.doMock('../../services/MessageManager.js', () => ({
			getMessageManager: () => { throw new Error('MM init fail'); }
		}));
		vi.doMock('../logger.js', () => ({
			createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
		}));
		const mod = await import('../dashboard-helpers.js');
		await expect(
			mod.sendStructuredMentionNotificationsAsync(
				{ machineId: 'myia-ai-01', workspace: 'roo-extensions' },
				'msg-1',
				[{ machineId: 'myia-po-2023', workspace: 'roo-extensions' }],
				'workspace-roo-extensions',
				'content'
			)
		).resolves.toBeUndefined();
	});
});
