/**
 * Tests for search/search-fallback.tool.ts
 * Issue #564 - MCP tool coverage audit
 *
 * Covers:
 * - Empty/missing query validation
 * - Text search in title, instruction, and messages
 * - Workspace filtering
 * - Relevance sorting (title > instruction > message)
 * - Result structure and metadata
 * - Error handling
 * - handleSearchTasksSemanticFallback alias
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { searchFallbackTool, handleSearchTasksSemanticFallback } from '../search-fallback.tool.js';
import type { ConversationSkeleton } from '../../../types/conversation.js';

// ---- helpers ----

function makeSkeleton(
	taskId: string,
	overrides: Partial<ConversationSkeleton> = {}
): ConversationSkeleton {
	return {
		taskId,
		metadata: {
			title: 'Default Title',
			lastActivity: '2026-03-01T00:00:00Z',
			createdAt: '2026-01-01T00:00:00Z',
			mode: 'code-simple',
			messageCount: 5,
			actionCount: 2,
			totalSize: 1024,
			workspace: '/workspace/default',
		},
		sequence: [],
		...overrides,
	} as ConversationSkeleton;
}

function makeCache(...skeletons: ConversationSkeleton[]): Map<string, ConversationSkeleton> {
	return new Map(skeletons.map(s => [s.taskId, s]));
}

function parseResult(result: any): any {
	return JSON.parse(result.content[0].text);
}

// ---- tests ----

describe('searchFallbackTool', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	// ============================================================
	// Validation
	// ============================================================

	describe('validation', () => {
		test('returns error for empty query', async () => {
			const result = await searchFallbackTool({ query: '' }, new Map());
			const parsed = parseResult(result);
			expect(parsed.success).toBe(false);
			expect(parsed.error).toContain('required');
		});

		test('returns error for whitespace-only query', async () => {
			const result = await searchFallbackTool({ query: '   ' }, new Map());
			const parsed = parseResult(result);
			expect(parsed.success).toBe(false);
		});

		test('returns empty results for no matches', async () => {
			const cache = makeCache(makeSkeleton('task-1'));
			const result = await searchFallbackTool({ query: 'nonexistent' }, cache);
			const parsed = parseResult(result);
			expect(parsed.success).toBe(true);
			expect(parsed.totalFound).toBe(0);
			expect(parsed.results).toEqual([]);
		});
	});

	// ============================================================
	// Title matching
	// ============================================================

	describe('title matching', () => {
		test('finds task by title match', async () => {
			const cache = makeCache(
				makeSkeleton('task-deploy', {
					metadata: {
						title: 'Deploy application to production',
						lastActivity: '2026-03-01T00:00:00Z',
						createdAt: '2026-01-01T00:00:00Z',
						mode: 'code-simple',
						messageCount: 5,
						actionCount: 2,
						totalSize: 1024,
						workspace: '/workspace/default',
					},
				} as any)
			);

			const result = await searchFallbackTool({ query: 'deploy' }, cache);
			const parsed = parseResult(result);

			expect(parsed.totalFound).toBe(1);
			expect(parsed.results[0].taskId).toBe('task-deploy');
			expect(parsed.results[0].title).toContain('Deploy');
		});

		test('title match is case-insensitive', async () => {
			const cache = makeCache(
				makeSkeleton('task-ci', {
					metadata: {
						title: 'CI Pipeline Configuration',
						lastActivity: '2026-03-01T00:00:00Z',
						createdAt: '2026-01-01T00:00:00Z',
						mode: 'code-simple',
						messageCount: 5,
						actionCount: 2,
						totalSize: 1024,
						workspace: '/workspace/default',
					},
				} as any)
			);

			const result = await searchFallbackTool({ query: 'pipeline' }, cache);
			const parsed = parseResult(result);
			expect(parsed.totalFound).toBe(1);
		});
	});

	// ============================================================
	// Instruction matching
	// ============================================================

	describe('instruction matching', () => {
		test('finds task by truncatedInstruction', async () => {
			const skeleton = makeSkeleton('task-instr');
			(skeleton as any).truncatedInstruction = 'Fix the authentication middleware';
			const cache = makeCache(skeleton);

			const result = await searchFallbackTool({ query: 'authentication' }, cache);
			const parsed = parseResult(result);

			expect(parsed.totalFound).toBe(1);
			expect(parsed.results[0].taskId).toBe('task-instr');
		});
	});

	// ============================================================
	// Message/sequence matching
	// ============================================================

	describe('message matching', () => {
		test('finds task by message content', async () => {
			const skeleton = makeSkeleton('task-msg');
			(skeleton as any).sequence = [
				{ role: 'user', content: 'Please refactor the database module' },
				{ role: 'assistant', content: 'I will refactor it now' },
			];
			const cache = makeCache(skeleton);

			const result = await searchFallbackTool({ query: 'refactor' }, cache);
			const parsed = parseResult(result);

			expect(parsed.totalFound).toBe(1);
			expect(parsed.results[0].taskId).toBe('task-msg');
		});

		test('matches text field in messages', async () => {
			const skeleton = makeSkeleton('task-text');
			(skeleton as any).sequence = [
				{ role: 'user', text: 'Run the scheduler tests' },
			];
			const cache = makeCache(skeleton);

			const result = await searchFallbackTool({ query: 'scheduler' }, cache);
			const parsed = parseResult(result);

			expect(parsed.totalFound).toBe(1);
		});
	});

	// ============================================================
	// Workspace filtering
	// ============================================================

	describe('workspace filtering', () => {
		test('filters results by workspace', async () => {
			const task1 = makeSkeleton('task-ws1', {
				metadata: {
					title: 'Deploy task',
					workspace: '/workspace/alpha',
					lastActivity: '2026-03-01T00:00:00Z',
					createdAt: '2026-01-01T00:00:00Z',
					mode: 'code-simple',
					messageCount: 5,
					actionCount: 2,
					totalSize: 1024,
				},
			} as any);
			const task2 = makeSkeleton('task-ws2', {
				metadata: {
					title: 'Deploy task 2',
					workspace: '/workspace/beta',
					lastActivity: '2026-03-01T00:00:00Z',
					createdAt: '2026-01-01T00:00:00Z',
					mode: 'code-simple',
					messageCount: 5,
					actionCount: 2,
					totalSize: 1024,
				},
			} as any);
			const cache = makeCache(task1, task2);

			const result = await searchFallbackTool(
				{ query: 'deploy', workspace: '/workspace/alpha' },
				cache
			);
			const parsed = parseResult(result);

			expect(parsed.totalFound).toBe(1);
			expect(parsed.results[0].taskId).toBe('task-ws1');
		});

		test('returns all workspaces when no workspace filter', async () => {
			const task1 = makeSkeleton('task-a', {
				metadata: {
					title: 'Build task',
					workspace: '/ws/a',
					lastActivity: '2026-03-01T00:00:00Z',
					createdAt: '2026-01-01T00:00:00Z',
					mode: 'code-simple',
					messageCount: 5,
					actionCount: 2,
					totalSize: 1024,
				},
			} as any);
			const task2 = makeSkeleton('task-b', {
				metadata: {
					title: 'Build task 2',
					workspace: '/ws/b',
					lastActivity: '2026-03-01T00:00:00Z',
					createdAt: '2026-01-01T00:00:00Z',
					mode: 'code-simple',
					messageCount: 5,
					actionCount: 2,
					totalSize: 1024,
				},
			} as any);
			const cache = makeCache(task1, task2);

			const result = await searchFallbackTool({ query: 'build' }, cache);
			const parsed = parseResult(result);

			expect(parsed.totalFound).toBe(2);
		});
	});

	// ============================================================
	// Relevance sorting
	// ============================================================

	describe('relevance sorting', () => {
		test('title matches rank higher than instruction matches', async () => {
			const titleMatch = makeSkeleton('title-hit', {
				metadata: {
					title: 'Fix authentication bug',
					lastActivity: '2026-01-01T00:00:00Z',
					createdAt: '2026-01-01T00:00:00Z',
					mode: 'code-simple',
					messageCount: 5,
					actionCount: 2,
					totalSize: 1024,
					workspace: '/ws',
				},
			} as any);

			const instrMatch = makeSkeleton('instr-hit', {
				metadata: {
					title: 'Other task',
					lastActivity: '2026-03-01T00:00:00Z',
					createdAt: '2026-01-01T00:00:00Z',
					mode: 'code-simple',
					messageCount: 5,
					actionCount: 2,
					totalSize: 1024,
					workspace: '/ws',
				},
			} as any);
			(instrMatch as any).truncatedInstruction = 'Fix authentication in middleware';

			const cache = makeCache(instrMatch, titleMatch);

			const result = await searchFallbackTool({ query: 'authentication' }, cache);
			const parsed = parseResult(result);

			expect(parsed.totalFound).toBe(2);
			// Title match should be first despite older date
			expect(parsed.results[0].taskId).toBe('title-hit');
			expect(parsed.results[1].taskId).toBe('instr-hit');
		});

		test('same relevance score sorted by lastActivity desc', async () => {
			const older = makeSkeleton('older', {
				metadata: {
					title: 'Test runner setup',
					lastActivity: '2026-01-01T00:00:00Z',
					createdAt: '2026-01-01T00:00:00Z',
					mode: 'code-simple',
					messageCount: 5,
					actionCount: 2,
					totalSize: 1024,
					workspace: '/ws',
				},
			} as any);
			const newer = makeSkeleton('newer', {
				metadata: {
					title: 'Test runner config',
					lastActivity: '2026-03-01T00:00:00Z',
					createdAt: '2026-01-01T00:00:00Z',
					mode: 'code-simple',
					messageCount: 5,
					actionCount: 2,
					totalSize: 1024,
					workspace: '/ws',
				},
			} as any);

			const cache = makeCache(older, newer);

			const result = await searchFallbackTool({ query: 'test runner' }, cache);
			const parsed = parseResult(result);

			expect(parsed.totalFound).toBe(2);
			expect(parsed.results[0].taskId).toBe('newer');
			expect(parsed.results[1].taskId).toBe('older');
		});
	});

	// ============================================================
	// Result structure
	// ============================================================

	describe('result structure', () => {
		test('result contains expected fields', async () => {
			const skeleton = makeSkeleton('task-struct', {
				metadata: {
					title: 'Build pipeline',
					lastActivity: '2026-03-01T12:00:00Z',
					createdAt: '2026-01-01T00:00:00Z',
					mode: 'debug-complex',
					messageCount: 42,
					actionCount: 10,
					totalSize: 5000,
					workspace: '/workspace/test',
				},
			} as any);
			(skeleton as any).isCompleted = true;
			const cache = makeCache(skeleton);

			const result = await searchFallbackTool({ query: 'pipeline' }, cache);
			const parsed = parseResult(result);

			expect(parsed.success).toBe(true);
			expect(parsed.searchType).toBe('text');
			expect(parsed.query).toBe('pipeline');
			expect(parsed.metadata.searchMethod).toBe('text');
			expect(parsed.metadata.cacheSize).toBe(1);
			expect(parsed.metadata.workspace).toBe('all');

			const item = parsed.results[0];
			expect(item.taskId).toBe('task-struct');
			expect(item.title).toBe('Build pipeline');
			expect(item.workspace).toBe('/workspace/test');
			expect(item.metadata.taskType).toBe('debug-complex');
			expect(item.metadata.status).toBe('completed');
			expect(item.metadata.messageCount).toBe(42);
		});

		test('metadata.workspace reflects filter when provided', async () => {
			const cache = makeCache(makeSkeleton('task-1'));
			const result = await searchFallbackTool(
				{ query: 'default', workspace: '/workspace/specific' },
				cache
			);
			const parsed = parseResult(result);
			expect(parsed.metadata.workspace).toBe('/workspace/specific');
		});
	});

	// ============================================================
	// Source filtering (#604)
	// ============================================================

	describe('source filtering', () => {
		test('filters by source=roo using task ID prefix', async () => {
			const rooTask = makeSkeleton('roo-task-123', {
				metadata: { ...makeSkeleton('x').metadata, title: 'roo task content' }
			});
			const claudeTask = makeSkeleton('claude-task-456', {
				metadata: { ...makeSkeleton('x').metadata, title: 'claude task content' }
			});
			const cache = makeCache(rooTask, claudeTask);

			const result = await searchFallbackTool({ query: 'content', source: 'roo' }, cache);
			const parsed = parseResult(result);
			expect(parsed.totalFound).toBe(1);
			expect(parsed.results[0].taskId).toBe('roo-task-123');
		});

		test('filters by source=claude-code using task ID prefix', async () => {
			const rooTask = makeSkeleton('roo-task-123', {
				metadata: { ...makeSkeleton('x').metadata, title: 'task content' }
			});
			const claudeTask = makeSkeleton('claude-task-456', {
				metadata: { ...makeSkeleton('x').metadata, title: 'task content' }
			});
			const cache = makeCache(rooTask, claudeTask);

			const result = await searchFallbackTool({ query: 'content', source: 'claude-code' }, cache);
			const parsed = parseResult(result);
			expect(parsed.totalFound).toBe(1);
			expect(parsed.results[0].taskId).toBe('claude-task-456');
		});

		test('filters by source using metadata.source (not dataSource)', async () => {
			// #1324: source filter must use metadata.source (normalized 'roo'/'claude-code'),
			// not metadata.dataSource (which is the raw filesystem path)
			const task1 = makeSkeleton('task-abc', {
				metadata: { ...makeSkeleton('x').metadata, title: 'shared title', source: 'claude-code' } as any
			});
			const task2 = makeSkeleton('task-xyz', {
				metadata: { ...makeSkeleton('x').metadata, title: 'shared title', source: 'roo' } as any
			});
			const cache = makeCache(task1, task2);

			const result = await searchFallbackTool({ query: 'title', source: 'claude-code' }, cache);
			const parsed = parseResult(result);
			expect(parsed.totalFound).toBe(1);
			expect(parsed.results[0].taskId).toBe('task-abc');
		});
	});

	// ============================================================
	// Error handling
	// ============================================================

	describe('error handling', () => {
		test('catches errors and returns success=false', async () => {
			// Use a cache that throws during iteration
			const brokenCache = {
				entries: () => { throw new Error('Cache corruption'); },
				size: 0,
			} as any;

			const result = await searchFallbackTool({ query: 'test' }, brokenCache);
			const parsed = parseResult(result);

			expect(parsed.success).toBe(false);
			expect(parsed.error).toContain('Cache corruption');
			expect(parsed.query).toBe('test');
		});
	});

	// ============================================================
	// Export alias
	// ============================================================

	describe('export alias', () => {
		test('handleSearchTasksSemanticFallback is the same function', () => {
			expect(handleSearchTasksSemanticFallback).toBe(searchFallbackTool);
		});
	});
});
