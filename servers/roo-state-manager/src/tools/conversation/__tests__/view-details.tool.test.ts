/**
 * Tests for view-details.tool.ts
 * Issue #492 - Coverage for view task details tool
 *
 * @module tools/conversation/__tests__/view-details.tool
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { viewTaskDetailsTool } from '../view-details.tool.js';

describe('viewTaskDetailsTool', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	test('has correct tool definition', () => {
		expect(viewTaskDetailsTool.definition.name).toBe('view_task_details');
		expect(viewTaskDetailsTool.definition.inputSchema.required).toEqual(['task_id']);
	});

	test('returns error when task not in cache', async () => {
		const cache = new Map();

		const result = await viewTaskDetailsTool.handler(
			{ task_id: 'nonexistent' },
			cache
		);

		expect(result.content[0].text).toContain('nonexistent');
		expect(result.content[0].text).toContain('Aucune tâche');
	});

	test('displays task metadata', async () => {
		const cache = new Map();
		cache.set('task-1', {
			taskId: 'task-1',
			metadata: {
				title: 'Test Task',
				messageCount: 10,
				totalSize: 5000,
				lastActivity: '2026-02-23T10:00:00Z'
			},
			sequence: []
		});

		const result = await viewTaskDetailsTool.handler(
			{ task_id: 'task-1' },
			cache
		);

		expect(result.content[0].text).toContain('Test Task');
		expect(result.content[0].text).toContain('10');
		expect(result.content[0].text).toContain('5000');
	});

	test('shows "no actions" when sequence has only messages', async () => {
		const cache = new Map();
		cache.set('task-1', {
			taskId: 'task-1',
			metadata: { title: 'Empty', messageCount: 2, totalSize: 100, lastActivity: '' },
			sequence: [
				{ role: 'user', content: 'hello' },
				{ role: 'assistant', content: 'hi' }
			]
		});

		const result = await viewTaskDetailsTool.handler(
			{ task_id: 'task-1' },
			cache
		);

		expect(result.content[0].text).toContain('Aucune action');
	});

	test('displays action details', async () => {
		const cache = new Map();
		cache.set('task-1', {
			taskId: 'task-1',
			metadata: { title: 'Actions', messageCount: 3, totalSize: 200, lastActivity: '' },
			sequence: [
				{
					name: 'read_file',
					type: 'command',
					status: 'success',
					timestamp: '2026-02-23T10:00:00Z',
					parameters: { path: '/test.ts' },
					result: 'file content here'
				}
			]
		});

		const result = await viewTaskDetailsTool.handler(
			{ task_id: 'task-1' },
			cache
		);

		expect(result.content[0].text).toContain('read_file');
		expect(result.content[0].text).toContain('success');
		expect(result.content[0].text).toContain('/test.ts');
		expect(result.content[0].text).toContain('file content here');
	});

	test('displays specific action by index', async () => {
		const cache = new Map();
		cache.set('task-1', {
			taskId: 'task-1',
			metadata: { title: 'Multi', messageCount: 5, totalSize: 500, lastActivity: '' },
			sequence: [
				{ name: 'action-0', type: 'command', status: 'success' },
				{ name: 'action-1', type: 'tool', status: 'error', error: 'Failed' },
				{ role: 'user', content: 'msg' } // message, filtered out
			]
		});

		const result = await viewTaskDetailsTool.handler(
			{ task_id: 'task-1', action_index: 1 },
			cache
		);

		expect(result.content[0].text).toContain('action-1');
		expect(result.content[0].text).toContain('Failed');
		expect(result.content[0].text).not.toContain('action-0');
	});

	test('shows error for invalid action index', async () => {
		const cache = new Map();
		cache.set('task-1', {
			taskId: 'task-1',
			metadata: { title: 'Test', messageCount: 1, totalSize: 100, lastActivity: '' },
			sequence: [
				{ name: 'only-action', type: 'command', status: 'success' }
			]
		});

		const result = await viewTaskDetailsTool.handler(
			{ task_id: 'task-1', action_index: 5 },
			cache
		);

		expect(result.content[0].text).toContain('invalide');
		expect(result.content[0].text).toContain('0-0');
	});

	test('truncates long content when truncate > 0', async () => {
		// Need many JSON keys so JSON.stringify produces many lines
		const bigParams: Record<string, string> = {};
		for (let i = 0; i < 20; i++) bigParams[`key${i}`] = `value${i}`;
		const cache = new Map();
		cache.set('task-1', {
			taskId: 'task-1',
			metadata: { title: 'Long', messageCount: 1, totalSize: 100, lastActivity: '' },
			sequence: [
				{ name: 'action', type: 'command', status: 'success', parameters: bigParams }
			]
		});

		const result = await viewTaskDetailsTool.handler(
			{ task_id: 'task-1', truncate: 3 },
			cache
		);

		expect(result.content[0].text).toContain('lignes omises');
	});

	test('handles handler errors gracefully', async () => {
		// Pass a cache that throws on get
		const badCache = {
			get: () => { throw new Error('cache corrupted'); }
		} as any;

		const result = await viewTaskDetailsTool.handler(
			{ task_id: 'task-1' },
			badCache
		);

		expect(result.content[0].text).toContain('Erreur');
		expect(result.content[0].text).toContain('cache corrupted');
	});
});
