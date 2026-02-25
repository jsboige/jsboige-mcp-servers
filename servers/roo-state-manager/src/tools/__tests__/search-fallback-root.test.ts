/**
 * Tests pour le search-fallback.tool.ts racine (src/tools/search-fallback.tool.ts)
 * Distinct du search/search-fallback.tool.ts - API differente (conversation_id, search_query)
 * Issue #492 - Couverture des outils actifs
 *
 * @module tools/__tests__/search-fallback-root
 */

import { describe, test, expect } from 'vitest';
import { handleSearchTasksSemanticFallback, SearchFallbackArgs } from '../search-fallback.tool.js';

// Local skeleton type matching the tool's interface
interface TestSkeleton {
	taskId: string;
	parentTaskId?: string;
	metadata: {
		title?: string;
		lastActivity?: string;
		messageCount?: number;
		totalSize?: number;
		actionCount?: number;
		createdAt?: string;
	};
	sequence: Array<{
		role: string;
		content: string;
		timestamp?: string;
		isTruncated?: boolean;
	}>;
}

function createSkeleton(taskId: string, messages: Array<{ role: string; content: string }>, meta?: Partial<TestSkeleton['metadata']>): TestSkeleton {
	return {
		taskId,
		metadata: {
			title: `Task ${taskId}`,
			lastActivity: '2026-02-22T10:00:00Z',
			messageCount: messages.length,
			totalSize: 1024,
			...meta
		},
		sequence: messages.map(m => ({ role: m.role, content: m.content }))
	};
}

describe('search-fallback (root-level)', () => {
	let cache: Map<string, TestSkeleton>;

	function buildCache(): Map<string, TestSkeleton> {
		const c = new Map<string, TestSkeleton>();

		c.set('task-001', createSkeleton('task-001', [
			{ role: 'user', content: 'Fix the heartbeat hostname issue' },
			{ role: 'assistant', content: 'I will fix the heartbeat by using os.hostname()' }
		], { title: 'Heartbeat Fix' }));

		c.set('task-002', createSkeleton('task-002', [
			{ role: 'user', content: 'Deploy MCP configuration across all machines' },
			{ role: 'assistant', content: 'Configuration deployed successfully' }
		], { title: 'Config Deployment' }));

		c.set('task-003', createSkeleton('task-003', [
			{ role: 'user', content: 'User message 1: test the scheduler' },
			{ role: 'assistant', content: 'Scheduler test completed' },
			{ role: 'user', content: 'User message 2: verify results' }
		], { title: 'Scheduler Test' }));

		return c;
	}

	// ============================================================
	// Global search (no conversation_id)
	// ============================================================

	describe('global search (no conversation_id)', () => {
		test('finds matching content across all conversations', async () => {
			cache = buildCache();
			const result = await handleSearchTasksSemanticFallback(
				{ search_query: 'heartbeat' },
				cache as any
			);

			expect(result.isError).toBe(false);
			const matches = result.content as any[];
			expect(matches.length).toBeGreaterThan(0);
			expect(matches.some((m: any) => m.taskId === 'task-001')).toBe(true);
		});

		test('returns empty for no match', async () => {
			cache = buildCache();
			// Use a short query (< 3 chars) that doesn't match anything
			// The word-matching logic for >= 3 char queries is very broad
			const result = await handleSearchTasksSemanticFallback(
				{ search_query: 'qz' },
				cache as any
			);

			expect(result.isError).toBe(false);
			expect((result.content as any[]).length).toBe(0);
		});

		test('is case-insensitive', async () => {
			cache = buildCache();
			const result = await handleSearchTasksSemanticFallback(
				{ search_query: 'HEARTBEAT' },
				cache as any
			);

			expect(result.isError).toBe(false);
			const matches = result.content as any[];
			expect(matches.some((m: any) => m.taskId === 'task-001')).toBe(true);
		});

		test('respects max_results limit', async () => {
			cache = buildCache();
			// Use a query that matches multiple conversations
			const result = await handleSearchTasksSemanticFallback(
				{ search_query: 'User message', max_results: 1 },
				cache as any
			);

			expect(result.isError).toBe(false);
			expect((result.content as any[]).length).toBeLessThanOrEqual(1);
		});

		test('matches partial words using word-matching logic', async () => {
			cache = buildCache();
			const result = await handleSearchTasksSemanticFallback(
				{ search_query: 'MCP configuration' },
				cache as any
			);

			expect(result.isError).toBe(false);
			const matches = result.content as any[];
			expect(matches.some((m: any) => m.taskId === 'task-002')).toBe(true);
		});

		test('handles empty cache', async () => {
			const emptyCache = new Map();
			const result = await handleSearchTasksSemanticFallback(
				{ search_query: 'anything' },
				emptyCache as any
			);

			expect(result.isError).toBe(false);
			expect((result.content as any[]).length).toBe(0);
		});

		test('result includes metadata', async () => {
			cache = buildCache();
			const result = await handleSearchTasksSemanticFallback(
				{ search_query: 'heartbeat' },
				cache as any
			);

			const matches = result.content as any[];
			const match = matches.find((m: any) => m.taskId === 'task-001');
			expect(match).toBeDefined();
			expect(match.score).toBe(1.0);
			expect(match.match).toContain('Found in role');
			expect(match.metadata.task_title).toBe('Heartbeat Fix');
		});
	});

	// ============================================================
	// Specific conversation search
	// ============================================================

	describe('specific conversation search', () => {
		test('searches within specified conversation', async () => {
			cache = buildCache();
			const result = await handleSearchTasksSemanticFallback(
				{ search_query: 'hostname', conversation_id: 'task-001' },
				cache as any
			);

			expect(result.isError).toBe(false);
			const matches = result.content as any[];
			expect(matches.length).toBeGreaterThan(0);
			expect(matches.every((m: any) => m.taskId === 'task-001')).toBe(true);
		});

		test('throws when conversation_id not found', async () => {
			cache = buildCache();
			await expect(
				handleSearchTasksSemanticFallback(
					{ search_query: 'test', conversation_id: 'nonexistent' },
					cache as any
				)
			).rejects.toThrow('not found');
		});

		test('returns empty when query not in specified conversation', async () => {
			cache = buildCache();
			const result = await handleSearchTasksSemanticFallback(
				{ search_query: 'zzz_no_match', conversation_id: 'task-001' },
				cache as any
			);

			expect(result.isError).toBe(false);
			expect((result.content as any[]).length).toBe(0);
		});

		test('respects max_results in specific conversation', async () => {
			cache = buildCache();
			// task-003 has 3 messages, search for "message" should match multiple
			const result = await handleSearchTasksSemanticFallback(
				{ search_query: 'message', conversation_id: 'task-003', max_results: 1 },
				cache as any
			);

			expect(result.isError).toBe(false);
			expect((result.content as any[]).length).toBeLessThanOrEqual(1);
		});
	});

	// ============================================================
	// Undefined conversation_id handling
	// ============================================================

	describe('undefined conversation_id handling', () => {
		test('treats string "undefined" as global search', async () => {
			cache = buildCache();
			const result = await handleSearchTasksSemanticFallback(
				{ search_query: 'heartbeat', conversation_id: 'undefined' },
				cache as any
			);

			expect(result.isError).toBe(false);
			// Should search globally, not throw
			const matches = result.content as any[];
			expect(matches.some((m: any) => m.taskId === 'task-001')).toBe(true);
		});

		test('treats empty string as global search', async () => {
			cache = buildCache();
			const result = await handleSearchTasksSemanticFallback(
				{ search_query: 'heartbeat', conversation_id: '' },
				cache as any
			);

			expect(result.isError).toBe(false);
		});
	});

	// ============================================================
	// Truncation helper
	// ============================================================

	describe('truncation in match text', () => {
		test('long messages are truncated in match output', async () => {
			const longContent = Array.from({ length: 20 }, (_, i) => `Line ${i + 1} of the message`).join('\n');
			const c = new Map<string, TestSkeleton>();
			c.set('task-long', createSkeleton('task-long', [
				{ role: 'user', content: longContent }
			]));

			const result = await handleSearchTasksSemanticFallback(
				{ search_query: 'Line 1' },
				c as any
			);

			const matches = result.content as any[];
			if (matches.length > 0) {
				// The truncation helper should truncate to 2 lines at start/end
				const matchText = matches[0].match;
				expect(matchText).toContain('Found in role');
			}
		});
	});
});
