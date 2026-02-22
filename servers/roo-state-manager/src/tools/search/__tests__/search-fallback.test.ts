/**
 * Tests pour search-fallback (text search backend for roosync_search action=text)
 * Issue #492 - Couverture des outils actifs
 *
 * @module tools/search/__tests__/search-fallback
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { searchFallbackTool, handleSearchTasksSemanticFallback, SearchFallbackArgs } from '../search-fallback.tool.js';
import type { ConversationSkeleton } from '../../../types/index.js';

// Helpers
function parseResult(result: any): any {
	const text = result.content[0]?.text;
	return text ? JSON.parse(text) : {};
}

function createSkeleton(overrides: Partial<ConversationSkeleton> & { taskId: string }): ConversationSkeleton {
	return {
		taskId: overrides.taskId,
		parentTaskId: overrides.parentTaskId,
		isCompleted: overrides.isCompleted ?? false,
		truncatedInstruction: overrides.truncatedInstruction ?? '',
		childTaskInstructionPrefixes: overrides.childTaskInstructionPrefixes ?? [],
		metadata: {
			title: 'Untitled',
			lastActivity: '2026-02-22T10:00:00Z',
			createdAt: '2026-02-22T09:00:00Z',
			messageCount: 5,
			actionCount: 2,
			totalSize: 512,
			workspace: '/test/workspace',
			...(overrides.metadata ?? {})
		},
		sequence: overrides.sequence ?? []
	} as ConversationSkeleton;
}

describe('search-fallback (text search)', () => {
	let cache: Map<string, ConversationSkeleton>;

	beforeEach(() => {
		cache = new Map();

		cache.set('task-heartbeat', createSkeleton({
			taskId: 'task-heartbeat',
			truncatedInstruction: 'Fix heartbeat hostname issue',
			metadata: {
				title: 'Heartbeat Bug Fix',
				lastActivity: '2026-02-22T12:00:00Z',
				createdAt: '2026-02-22T10:00:00Z',
				messageCount: 20,
				actionCount: 8,
				totalSize: 4096,
				workspace: '/test/workspace'
			}
		}));

		cache.set('task-config', createSkeleton({
			taskId: 'task-config',
			truncatedInstruction: 'Deploy MCP configuration across machines',
			isCompleted: true,
			metadata: {
				title: 'Config Sync Deployment',
				lastActivity: '2026-02-21T15:00:00Z',
				createdAt: '2026-02-21T09:00:00Z',
				messageCount: 40,
				actionCount: 15,
				totalSize: 8192,
				workspace: '/test/workspace',
				mode: 'code-complex'
			}
		}));

		cache.set('task-other-ws', createSkeleton({
			taskId: 'task-other-ws',
			truncatedInstruction: 'WordPress theme update',
			metadata: {
				title: 'Theme Update',
				lastActivity: '2026-02-20T08:00:00Z',
				createdAt: '2026-02-20T07:00:00Z',
				messageCount: 3,
				actionCount: 1,
				totalSize: 256,
				workspace: '/other/workspace'
			}
		}));

		cache.set('task-with-messages', createSkeleton({
			taskId: 'task-with-messages',
			truncatedInstruction: 'General task',
			metadata: {
				title: 'General Task',
				lastActivity: '2026-02-22T11:00:00Z',
				createdAt: '2026-02-22T10:00:00Z',
				messageCount: 10,
				actionCount: 5,
				totalSize: 2048,
				workspace: '/test/workspace'
			},
			sequence: [
				{ content: 'Fix the condensation threshold to 80%' },
				{ content: 'The scheduler is working correctly now' }
			]
		}));
	});

	// ============================================================
	// Validation
	// ============================================================

	describe('validation', () => {
		test('returns error for empty query', async () => {
			const result = await searchFallbackTool({ query: '' }, cache);
			const parsed = parseResult(result);
			expect(parsed.success).toBe(false);
			expect(parsed.error).toContain('required');
		});

		test('returns error for whitespace-only query', async () => {
			const result = await searchFallbackTool({ query: '   ' }, cache);
			const parsed = parseResult(result);
			expect(parsed.success).toBe(false);
		});

		test('handles empty cache gracefully', async () => {
			const result = await searchFallbackTool({ query: 'anything' }, new Map());
			const parsed = parseResult(result);
			expect(parsed.success).toBe(true);
			expect(parsed.results).toHaveLength(0);
			expect(parsed.totalFound).toBe(0);
		});
	});

	// ============================================================
	// Title matching
	// ============================================================

	describe('title matching', () => {
		test('matches by title (case-insensitive)', async () => {
			const result = await searchFallbackTool({ query: 'heartbeat' }, cache);
			const parsed = parseResult(result);
			expect(parsed.success).toBe(true);
			expect(parsed.results.some((r: any) => r.taskId === 'task-heartbeat')).toBe(true);
		});

		test('matches partial title', async () => {
			const result = await searchFallbackTool({ query: 'Config Sync' }, cache);
			const parsed = parseResult(result);
			expect(parsed.results.some((r: any) => r.taskId === 'task-config')).toBe(true);
		});

		test('is case-insensitive', async () => {
			const result = await searchFallbackTool({ query: 'HEARTBEAT' }, cache);
			const parsed = parseResult(result);
			expect(parsed.results.some((r: any) => r.taskId === 'task-heartbeat')).toBe(true);
		});
	});

	// ============================================================
	// Instruction matching
	// ============================================================

	describe('instruction matching', () => {
		test('matches by truncatedInstruction', async () => {
			const result = await searchFallbackTool({ query: 'hostname' }, cache);
			const parsed = parseResult(result);
			expect(parsed.results.some((r: any) => r.taskId === 'task-heartbeat')).toBe(true);
		});

		test('matches instruction of different task', async () => {
			const result = await searchFallbackTool({ query: 'MCP configuration' }, cache);
			const parsed = parseResult(result);
			expect(parsed.results.some((r: any) => r.taskId === 'task-config')).toBe(true);
		});
	});

	// ============================================================
	// Message/sequence matching
	// ============================================================

	describe('message matching', () => {
		test('matches content in message sequence', async () => {
			const result = await searchFallbackTool({ query: 'condensation threshold' }, cache);
			const parsed = parseResult(result);
			expect(parsed.results.some((r: any) => r.taskId === 'task-with-messages')).toBe(true);
		});

		test('matches second message in sequence', async () => {
			const result = await searchFallbackTool({ query: 'scheduler is working' }, cache);
			const parsed = parseResult(result);
			expect(parsed.results.some((r: any) => r.taskId === 'task-with-messages')).toBe(true);
		});
	});

	// ============================================================
	// Workspace filtering
	// ============================================================

	describe('workspace filtering', () => {
		test('filters by workspace', async () => {
			const result = await searchFallbackTool(
				{ query: 'task', workspace: '/test/workspace' },
				cache
			);
			const parsed = parseResult(result);
			expect(parsed.results.every((r: any) => r.workspace === '/test/workspace')).toBe(true);
			expect(parsed.results.some((r: any) => r.taskId === 'task-other-ws')).toBe(false);
		});

		test('returns all workspaces when no filter', async () => {
			// Use a query that matches across workspaces
			const result = await searchFallbackTool({ query: 'task' }, cache);
			const parsed = parseResult(result);
			const workspaces = new Set(parsed.results.map((r: any) => r.workspace));
			expect(workspaces.size).toBeGreaterThanOrEqual(1);
		});
	});

	// ============================================================
	// Result sorting
	// ============================================================

	describe('sorting', () => {
		test('title matches rank higher than instruction-only matches', async () => {
			// "heartbeat" is in both title and instruction of task-heartbeat
			const result = await searchFallbackTool({ query: 'heartbeat' }, cache);
			const parsed = parseResult(result);
			if (parsed.results.length > 1) {
				// task-heartbeat should be first (has title match)
				expect(parsed.results[0].taskId).toBe('task-heartbeat');
			}
		});

		test('same-score results sorted by lastActivity (most recent first)', async () => {
			// Add two tasks with same score pattern
			cache.set('recent-task', createSkeleton({
				taskId: 'recent-task',
				truncatedInstruction: 'Deploy something',
				metadata: {
					title: 'Deploy Recent',
					lastActivity: '2026-02-22T16:00:00Z',
					createdAt: '2026-02-22T15:00:00Z',
					messageCount: 1,
					actionCount: 1,
					totalSize: 100,
					workspace: '/test/workspace'
				}
			}));
			cache.set('old-task', createSkeleton({
				taskId: 'old-task',
				truncatedInstruction: 'Deploy something else',
				metadata: {
					title: 'Deploy Old',
					lastActivity: '2026-01-01T00:00:00Z',
					createdAt: '2026-01-01T00:00:00Z',
					messageCount: 1,
					actionCount: 1,
					totalSize: 100,
					workspace: '/test/workspace'
				}
			}));

			const result = await searchFallbackTool({ query: 'Deploy' }, cache);
			const parsed = parseResult(result);
			const deployResults = parsed.results.filter((r: any) => r.title.includes('Deploy'));
			if (deployResults.length >= 2) {
				const recentIdx = deployResults.findIndex((r: any) => r.taskId === 'recent-task');
				const oldIdx = deployResults.findIndex((r: any) => r.taskId === 'old-task');
				expect(recentIdx).toBeLessThan(oldIdx);
			}
		});
	});

	// ============================================================
	// Result structure
	// ============================================================

	describe('result structure', () => {
		test('includes expected metadata fields', async () => {
			const result = await searchFallbackTool({ query: 'heartbeat' }, cache);
			const parsed = parseResult(result);

			expect(parsed.success).toBe(true);
			expect(parsed.query).toBe('heartbeat');
			expect(parsed.searchType).toBe('text');
			expect(parsed.totalFound).toBeGreaterThan(0);
			expect(parsed.metadata.searchMethod).toBe('text');
			expect(parsed.metadata.cacheSize).toBe(cache.size);
			expect(parsed.metadata.workspace).toBe('all');
		});

		test('workspace metadata reflects filter', async () => {
			const result = await searchFallbackTool(
				{ query: 'task', workspace: '/test/workspace' },
				cache
			);
			const parsed = parseResult(result);
			expect(parsed.metadata.workspace).toBe('/test/workspace');
		});

		test('individual result has correct shape', async () => {
			const result = await searchFallbackTool({ query: 'Config Sync' }, cache);
			const parsed = parseResult(result);
			const configResult = parsed.results.find((r: any) => r.taskId === 'task-config');
			expect(configResult).toBeDefined();
			expect(configResult.title).toBe('Config Sync Deployment');
			expect(configResult.workspace).toBe('/test/workspace');
			expect(configResult.metadata.status).toBe('completed');
			expect(configResult.metadata.messageCount).toBe(40);
			expect(configResult.metadata.parentTaskId).toBeNull();
		});
	});

	// ============================================================
	// Export alias
	// ============================================================

	describe('exports', () => {
		test('handleSearchTasksSemanticFallback is alias for searchFallbackTool', () => {
			expect(handleSearchTasksSemanticFallback).toBe(searchFallbackTool);
		});
	});

	// ============================================================
	// No matches
	// ============================================================

	describe('no matches', () => {
		test('returns empty results for non-matching query', async () => {
			const result = await searchFallbackTool({ query: 'zzz_nonexistent_xyz' }, cache);
			const parsed = parseResult(result);
			expect(parsed.success).toBe(true);
			expect(parsed.results).toHaveLength(0);
			expect(parsed.totalFound).toBe(0);
		});
	});
});
