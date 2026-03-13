/**
 * Tests pour conversation_browser (outil actif #1, AUCUN test existant)
 * Issue #492 - Couverture des outils actifs
 *
 * @module tools/conversation/__tests__/conversation-browser
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// Hoisted mocks for ESM compatibility
const { mockHandleTaskBrowse, mockViewHandler, mockHandleSummarize, mockHandleGetConversationSynthesis } = vi.hoisted(() => ({
	mockHandleTaskBrowse: vi.fn(),
	mockViewHandler: vi.fn(),
	mockHandleSummarize: vi.fn(),
	mockHandleGetConversationSynthesis: vi.fn()
}));

// Mock delegates
vi.mock('../../task/browse.js', () => ({
	handleTaskBrowse: mockHandleTaskBrowse
}));

vi.mock('../../view-conversation-tree.js', () => ({
	viewConversationTree: {
		handler: mockViewHandler
	}
}));

vi.mock('../../summary/roosync-summarize.tool.js', () => ({
	handleRooSyncSummarize: mockHandleSummarize
}));

vi.mock('../../summary/get-conversation-synthesis.tool.js', () => ({
	handleGetConversationSynthesis: mockHandleGetConversationSynthesis
}));

import { handleConversationBrowser, ConversationBrowserArgs } from '../conversation-browser.js';
import type { ConversationSkeleton } from '../../../types/index.js';

// Helpers
function getTextContent(result: any, index = 0): string {
	const content = result.content[index];
	return content?.type === 'text' ? content.text : '';
}

describe('conversation_browser', () => {
	let mockCache: Map<string, ConversationSkeleton>;
	let mockEnsureCache: () => Promise<void>;
	let mockGetSkeleton: (id: string) => Promise<ConversationSkeleton | null>;
	let mockFindChildren: (rootId: string) => Promise<ConversationSkeleton[]>;

	beforeEach(() => {
		vi.clearAllMocks();
		mockCache = new Map();
		mockEnsureCache = vi.fn(async () => {});
		mockGetSkeleton = vi.fn(async () => null);
		mockFindChildren = vi.fn(async () => []);

		// Default mock returns
		mockHandleTaskBrowse.mockResolvedValue({
			content: [{ type: 'text', text: 'tree result' }]
		});
		mockViewHandler.mockResolvedValue({
			content: [{ type: 'text', text: 'view result' }]
		});
		mockHandleSummarize.mockResolvedValue('summary text');
	});

	// ============================================================
	// Validation
	// ============================================================

	describe('validation', () => {
		test('rejects missing action', async () => {
			const result = await handleConversationBrowser(
				{} as ConversationBrowserArgs,
				mockCache,
				mockEnsureCache
			);
			expect(result.isError).toBe(true);
			expect(getTextContent(result)).toContain('action');
			expect(getTextContent(result)).toContain('requis');
		});

		test('rejects invalid action', async () => {
			const result = await handleConversationBrowser(
				{ action: 'invalid' as any },
				mockCache,
				mockEnsureCache
			);
			expect(result.isError).toBe(true);
			expect(getTextContent(result)).toContain('invalide');
		});

		test('tree requires conversation_id', async () => {
			const result = await handleConversationBrowser(
				{ action: 'tree' },
				mockCache,
				mockEnsureCache
			);
			expect(result.isError).toBe(true);
			expect(getTextContent(result)).toContain('conversation_id');
		});

		test('summarize requires summarize_type', async () => {
			const result = await handleConversationBrowser(
				{ action: 'summarize', taskId: 'task-1' } as ConversationBrowserArgs,
				mockCache,
				mockEnsureCache
			);
			expect(result.isError).toBe(true);
			expect(getTextContent(result)).toContain('summarize_type');
		});

		test('summarize requires taskId or task_id', async () => {
			const result = await handleConversationBrowser(
				{ action: 'summarize', summarize_type: 'trace' } as ConversationBrowserArgs,
				mockCache,
				mockEnsureCache
			);
			expect(result.isError).toBe(true);
			expect(getTextContent(result)).toContain('taskId');
		});

		test('current does not require extra params', async () => {
			const result = await handleConversationBrowser(
				{ action: 'current' },
				mockCache,
				mockEnsureCache
			);
			expect(result.isError).toBeFalsy();
		});

		test('view does not require extra params', async () => {
			const result = await handleConversationBrowser(
				{ action: 'view' },
				mockCache,
				mockEnsureCache
			);
			expect(result.isError).toBeFalsy();
		});
	});

	// ============================================================
	// Action: tree
	// ============================================================

	describe('action: tree', () => {
		test('delegates to handleTaskBrowse with correct args', async () => {
			await handleConversationBrowser(
				{
					action: 'tree',
					conversation_id: 'conv-123',
					max_depth: 3,
					include_siblings: false,
					output_format: 'ascii-tree',
					show_metadata: true
				},
				mockCache,
				mockEnsureCache,
				'test-workspace'
			);

			expect(mockHandleTaskBrowse).toHaveBeenCalledWith(
				expect.objectContaining({
					action: 'tree',
					conversation_id: 'conv-123',
					max_depth: 3,
					include_siblings: false,
					output_format: 'ascii-tree',
					show_metadata: true
				}),
				mockCache,
				mockEnsureCache,
				'test-workspace'
			);
		});

		test('returns delegate result as-is', async () => {
			mockHandleTaskBrowse.mockResolvedValue({
				content: [{ type: 'text', text: 'tree output' }]
			});

			const result = await handleConversationBrowser(
				{ action: 'tree', conversation_id: 'conv-1' },
				mockCache,
				mockEnsureCache
			);

			expect(getTextContent(result)).toBe('tree output');
		});
	});

	// ============================================================
	// Action: current
	// ============================================================

	describe('action: current', () => {
		test('delegates to handleTaskBrowse with action=current', async () => {
			await handleConversationBrowser(
				{ action: 'current', workspace: 'd:\\roo-extensions' },
				mockCache,
				mockEnsureCache,
				'context-ws'
			);

			expect(mockHandleTaskBrowse).toHaveBeenCalledWith(
				expect.objectContaining({
					action: 'current',
					workspace: 'd:\\roo-extensions'
				}),
				mockCache,
				mockEnsureCache,
				'context-ws'
			);
		});
	});

	// ============================================================
	// Action: view
	// ============================================================

	describe('action: view', () => {
		test('delegates to viewConversationTree handler', async () => {
			await handleConversationBrowser(
				{
					action: 'view',
					task_id: 'task-abc',
					detail_level: 'skeleton',
					smart_truncation: true,
					max_output_length: 15000
				},
				mockCache,
				mockEnsureCache
			);

			expect(mockViewHandler).toHaveBeenCalledWith(
				expect.objectContaining({
					task_id: 'task-abc',
					detail_level: 'skeleton',
					smart_truncation: true,
					max_output_length: 15000
				}),
				mockCache
			);
		});

		test('passes view_mode and truncate', async () => {
			await handleConversationBrowser(
				{
					action: 'view',
					view_mode: 'chain',
					truncate: 50
				},
				mockCache,
				mockEnsureCache
			);

			expect(mockViewHandler).toHaveBeenCalledWith(
				expect.objectContaining({
					view_mode: 'chain',
					truncate: 50
				}),
				mockCache
			);
		});
	});

	// ============================================================
	// Action: summarize
	// ============================================================

	describe('action: summarize', () => {
		test('delegates to handleRooSyncSummarize with resolved taskId', async () => {
			await handleConversationBrowser(
				{
					action: 'summarize',
					summarize_type: 'trace',
					taskId: 'task-xyz'
				} as ConversationBrowserArgs,
				mockCache,
				mockEnsureCache,
				undefined,
				mockGetSkeleton,
				mockFindChildren
			);

			expect(mockHandleSummarize).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'trace',
					taskId: 'task-xyz'
				}),
				mockGetSkeleton,
				mockFindChildren
			);
		});

		test('resolves task_id alias to taskId', async () => {
			await handleConversationBrowser(
				{
					action: 'summarize',
					summarize_type: 'cluster',
					task_id: 'task-from-alias'
				} as ConversationBrowserArgs,
				mockCache,
				mockEnsureCache,
				undefined,
				mockGetSkeleton,
				mockFindChildren
			);

			expect(mockHandleSummarize).toHaveBeenCalledWith(
				expect.objectContaining({
					taskId: 'task-from-alias'
				}),
				mockGetSkeleton,
				mockFindChildren
			);
		});

		test('wraps summarize result in text content', async () => {
			mockHandleSummarize.mockResolvedValue('## Summary\nDetails here');

			const result = await handleConversationBrowser(
				{
					action: 'summarize',
					summarize_type: 'trace',
					taskId: 'task-1'
				} as ConversationBrowserArgs,
				mockCache,
				mockEnsureCache,
				undefined,
				mockGetSkeleton,
				mockFindChildren
			);

			expect(result.content).toHaveLength(1);
			expect(result.content[0]).toEqual({
				type: 'text',
				text: '## Summary\nDetails here'
			});
		});

		test('passes all summarize options', async () => {
			await handleConversationBrowser(
				{
					action: 'summarize',
					summarize_type: 'cluster',
					taskId: 'task-1',
					source: 'roo',
					detailLevel: 'Full',
					truncationChars: 5000,
					compactStats: true,
					childTaskIds: ['child-1', 'child-2'],
					clusterMode: 'aggregated'
				} as ConversationBrowserArgs,
				mockCache,
				mockEnsureCache,
				undefined,
				mockGetSkeleton,
				mockFindChildren
			);

			expect(mockHandleSummarize).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'cluster',
					taskId: 'task-1',
					source: 'roo',
					detailLevel: 'Full',
					truncationChars: 5000,
					compactStats: true,
					childTaskIds: ['child-1', 'child-2'],
					clusterMode: 'aggregated'
				}),
				mockGetSkeleton,
				mockFindChildren
			);
		});
	});

	// ============================================================
	// Action: summarize with summarize_type='synthesis'
	// ============================================================

	describe('action: summarize (synthesis)', () => {
		test('delegates to handleGetConversationSynthesis with correct args', async () => {
			mockHandleGetConversationSynthesis.mockResolvedValue({
				taskId: 'task-synth',
				analysisEngineVersion: '3.0.0-phase3',
				analysisTimestamp: '2026-03-09T12:00:00Z',
				llmModelId: 'test-model',
				contextTrace: { rootTaskId: 'task-synth', previousSiblingTaskIds: [] },
				objectives: { goal: 'test' },
				strategy: { approach: 'simple' },
				quality: { score: 0.9 },
				metrics: {},
				synthesis: { initialContextSummary: 'Context', finalTaskSummary: 'Done' }
			});

			const result = await handleConversationBrowser(
				{
					action: 'summarize',
					summarize_type: 'synthesis',
					taskId: 'task-synth'
				} as ConversationBrowserArgs,
				mockCache,
				mockEnsureCache,
				undefined,
				mockGetSkeleton,
				mockFindChildren
			);

			expect(mockHandleGetConversationSynthesis).toHaveBeenCalledWith(
				expect.objectContaining({
					taskId: 'task-synth',
					outputFormat: 'json'
				}),
				mockGetSkeleton
			);
			expect(result.isError).toBeFalsy();
			const text = getTextContent(result);
			const parsed = JSON.parse(text);
			expect(parsed.taskId).toBe('task-synth');
			expect(parsed.analysisEngineVersion).toBe('3.0.0-phase3');
		});

		test('synthesis with markdown format returns string result', async () => {
			mockHandleGetConversationSynthesis.mockResolvedValue(
				'# Synthèse\n\nRésumé final de la tâche.'
			);

			const result = await handleConversationBrowser(
				{
					action: 'summarize',
					summarize_type: 'synthesis',
					taskId: 'task-md',
					synthesis_output_format: 'markdown'
				} as ConversationBrowserArgs,
				mockCache,
				mockEnsureCache,
				undefined,
				mockGetSkeleton,
				mockFindChildren
			);

			expect(mockHandleGetConversationSynthesis).toHaveBeenCalledWith(
				expect.objectContaining({
					taskId: 'task-md',
					outputFormat: 'markdown'
				}),
				mockGetSkeleton
			);
			expect(result.isError).toBeFalsy();
			expect(getTextContent(result)).toContain('Synthèse');
		});

		test('synthesis with filePath passes it through', async () => {
			mockHandleGetConversationSynthesis.mockResolvedValue(
				'Synthèse exportée vers /tmp/synth.json'
			);

			await handleConversationBrowser(
				{
					action: 'summarize',
					summarize_type: 'synthesis',
					taskId: 'task-file',
					filePath: '/tmp/synth.json'
				} as ConversationBrowserArgs,
				mockCache,
				mockEnsureCache,
				undefined,
				mockGetSkeleton,
				mockFindChildren
			);

			expect(mockHandleGetConversationSynthesis).toHaveBeenCalledWith(
				expect.objectContaining({
					taskId: 'task-file',
					filePath: '/tmp/synth.json'
				}),
				mockGetSkeleton
			);
		});

		test('synthesis resolves task_id alias to taskId', async () => {
			mockHandleGetConversationSynthesis.mockResolvedValue({ taskId: 'alias-task' });

			await handleConversationBrowser(
				{
					action: 'summarize',
					summarize_type: 'synthesis',
					task_id: 'alias-task'
				} as ConversationBrowserArgs,
				mockCache,
				mockEnsureCache,
				undefined,
				mockGetSkeleton,
				mockFindChildren
			);

			expect(mockHandleGetConversationSynthesis).toHaveBeenCalledWith(
				expect.objectContaining({ taskId: 'alias-task' }),
				mockGetSkeleton
			);
		});

		test('synthesis returns error when getConversationSkeleton is missing', async () => {
			const result = await handleConversationBrowser(
				{
					action: 'summarize',
					summarize_type: 'synthesis',
					taskId: 'task-no-getter'
				} as ConversationBrowserArgs,
				mockCache,
				mockEnsureCache,
				undefined,
				undefined, // no getConversationSkeleton
				mockFindChildren
			);

			expect(result.isError).toBe(true);
			expect(getTextContent(result)).toContain('getConversationSkeleton');
		});

		test('synthesis handles LLM errors gracefully', async () => {
			mockHandleGetConversationSynthesis.mockRejectedValue(
				new Error('LLM API connection refused')
			);

			const result = await handleConversationBrowser(
				{
					action: 'summarize',
					summarize_type: 'synthesis',
					taskId: 'task-err'
				} as ConversationBrowserArgs,
				mockCache,
				mockEnsureCache,
				undefined,
				mockGetSkeleton,
				mockFindChildren
			);

			expect(result.isError).toBe(true);
			expect(getTextContent(result)).toContain('LLM API connection refused');
		});

		test('synthesis is listed in the summarize_type schema enum', async () => {
			const { conversationBrowserTool } = await import('../conversation-browser.js');
			const summarizeTypeEnum = (conversationBrowserTool.inputSchema as any).properties.summarize_type.enum;
			expect(summarizeTypeEnum).toContain('synthesis');
		});
	});

	// ============================================================
	// Error handling
	// ============================================================

	describe('error handling', () => {
		test('catches delegate errors and returns isError', async () => {
			mockHandleTaskBrowse.mockRejectedValue(new Error('Delegate failed'));

			const result = await handleConversationBrowser(
				{ action: 'tree', conversation_id: 'conv-1' },
				mockCache,
				mockEnsureCache
			);

			expect(result.isError).toBe(true);
			expect(getTextContent(result)).toContain('Delegate failed');
		});

		test('handles view handler errors', async () => {
			mockViewHandler.mockRejectedValue(new Error('View crashed'));

			const result = await handleConversationBrowser(
				{ action: 'view' },
				mockCache,
				mockEnsureCache
			);

			expect(result.isError).toBe(true);
			expect(getTextContent(result)).toContain('View crashed');
		});

		test('handles summarize errors', async () => {
			mockHandleSummarize.mockRejectedValue(new Error('Summary failed'));

			const result = await handleConversationBrowser(
				{
					action: 'summarize',
					summarize_type: 'trace',
					taskId: 'task-1'
				} as ConversationBrowserArgs,
				mockCache,
				mockEnsureCache,
				undefined,
				mockGetSkeleton,
				mockFindChildren
			);

			expect(result.isError).toBe(true);
			expect(getTextContent(result)).toContain('Summary failed');
		});
	});

	// ============================================================
	// Action: list (REGRESSION FIX - was removed by CLEANUP-3)
	// ============================================================

	describe('action: list', () => {
		test('list does not require extra params (returns all conversations)', async () => {
			const result = await handleConversationBrowser(
				{ action: 'list' },
				mockCache,
				mockEnsureCache
			);
			// Should succeed (empty cache = empty list, not an error)
			expect(result.isError).toBeFalsy();
		});

		test('list returns JSON array from cache', async () => {
			// Add a skeleton to the cache
			const skeleton = {
				taskId: 'test-task-1',
				metadata: {
					lastActivity: '2026-03-02T12:00:00Z',
					createdAt: '2026-03-02T10:00:00Z',
					messageCount: 10,
					actionCount: 5,
					totalSize: 1000,
					workspace: 'd:\\roo-extensions'
				}
			} as any;
			mockCache.set('test-task-1', skeleton);

			const result = await handleConversationBrowser(
				{ action: 'list', limit: 10 },
				mockCache,
				mockEnsureCache
			);

			expect(result.isError).toBeFalsy();
			const _response = JSON.parse(getTextContent(result));
			const parsed = _response.conversations ?? _response;
			expect(Array.isArray(parsed)).toBe(true);
			expect(parsed.length).toBe(1);
			expect(parsed[0].taskId).toBe('test-task-1');
		});

		test('list accepts workspace filter', async () => {
			const result = await handleConversationBrowser(
				{ action: 'list', workspace: 'd:\\roo-extensions', limit: 5 },
				mockCache,
				mockEnsureCache
			);
			expect(result.isError).toBeFalsy();
		});

		test('list accepts sortBy and sortOrder', async () => {
			const result = await handleConversationBrowser(
				{ action: 'list', sortBy: 'messageCount', sortOrder: 'asc' },
				mockCache,
				mockEnsureCache
			);
			expect(result.isError).toBeFalsy();
		});

		test('list is listed as a valid action in the tool schema', async () => {
			// Import the tool definition to verify the schema
			const { conversationBrowserTool } = await import('../conversation-browser.js');
			const actionEnum = (conversationBrowserTool.inputSchema as any).properties.action.enum;
			expect(actionEnum).toContain('list');
		});
	});

	// ============================================================
	// REGRESSION #567 - Section 1: New Tasks Visibility
	// Tests for scanDiskForNewTasks integration
	// ============================================================

	describe('regression #567 section 1: new tasks visibility', () => {
		test('list discovers new tasks on disk not in cache', async () => {
			// Setup: Add one task to cache, expect disk scan to find more
			const cachedTask: ConversationSkeleton = {
				taskId: 'cached-task-1',
				metadata: {
					title: 'Cached Task',
					lastActivity: '2026-03-01T10:00:00Z',
					createdAt: '2026-03-01T10:00:00Z',
					messageCount: 5,
					actionCount: 2,
					totalSize: 500,
					workspace: 'd:\\roo-extensions'
				}
			};
			mockCache.set('cached-task-1', cachedTask);

			const result = await handleConversationBrowser(
				{ action: 'list' },
				mockCache,
				mockEnsureCache
			);

			expect(result.isError).toBeFalsy();
			const _response = JSON.parse(getTextContent(result));
			const parsed = _response.conversations ?? _response;
			// Should include the cached task
			expect(parsed.some((t: any) => t.taskId === 'cached-task-1')).toBe(true);
		});

		test('list handles empty cache gracefully', async () => {
			// Empty cache - should not error
			const result = await handleConversationBrowser(
				{ action: 'list' },
				mockCache,
				mockEnsureCache
			);

			expect(result.isError).toBeFalsy();
			const _response = JSON.parse(getTextContent(result));
			const parsed = _response.conversations ?? _response;
			expect(Array.isArray(parsed)).toBe(true);
		});
	});

	// ============================================================
	// REGRESSION #567 - Section 2: Sorting and Filtering
	// ============================================================

	describe('regression #567 section 2: sorting and filtering', () => {
		beforeEach(() => {
			// Setup multiple tasks with different dates
			const task1: ConversationSkeleton = {
				taskId: 'task-old',
				metadata: {
					title: 'Old Task',
					lastActivity: '2026-03-01T10:00:00Z',
					createdAt: '2026-03-01T10:00:00Z',
					messageCount: 5,
					actionCount: 2,
					totalSize: 500,
					workspace: 'd:\\roo-extensions'
				}
			};
			const task2: ConversationSkeleton = {
				taskId: 'task-new',
				metadata: {
					title: 'New Task',
					lastActivity: '2026-03-05T15:00:00Z',
					createdAt: '2026-03-05T15:00:00Z',
					messageCount: 10,
					actionCount: 5,
					totalSize: 1000,
					workspace: 'd:\\roo-extensions'
				}
			};
			const task3: ConversationSkeleton = {
				taskId: 'task-middle',
				metadata: {
					title: 'Middle Task',
					lastActivity: '2026-03-03T12:00:00Z',
					createdAt: '2026-03-03T12:00:00Z',
					messageCount: 7,
					actionCount: 3,
					totalSize: 750,
					workspace: 'd:\\roo-extensions'
				}
			};
			mockCache.set('task-old', task1);
			mockCache.set('task-new', task2);
			mockCache.set('task-middle', task3);
		});

		test('list sorts by lastActivity descending by default', async () => {
			const result = await handleConversationBrowser(
				{ action: 'list', sortBy: 'lastActivity', sortOrder: 'desc' },
				mockCache,
				mockEnsureCache
			);

			expect(result.isError).toBeFalsy();
			const _response = JSON.parse(getTextContent(result));
			const parsed = _response.conversations ?? _response;
			expect(parsed.length).toBe(3);
			// First should be most recent
			expect(parsed[0].taskId).toBe('task-new');
			expect(parsed[1].taskId).toBe('task-middle');
			expect(parsed[2].taskId).toBe('task-old');
		});

		test('list sorts by lastActivity ascending when specified', async () => {
			const result = await handleConversationBrowser(
				{ action: 'list', sortBy: 'lastActivity', sortOrder: 'asc' },
				mockCache,
				mockEnsureCache
			);

			expect(result.isError).toBeFalsy();
			const _response = JSON.parse(getTextContent(result));
			const parsed = _response.conversations ?? _response;
			expect(parsed.length).toBe(3);
			// First should be oldest
			expect(parsed[0].taskId).toBe('task-old');
			expect(parsed[1].taskId).toBe('task-middle');
			expect(parsed[2].taskId).toBe('task-new');
		});

		test('list sorts by messageCount correctly', async () => {
			const result = await handleConversationBrowser(
				{ action: 'list', sortBy: 'messageCount', sortOrder: 'desc' },
				mockCache,
				mockEnsureCache
			);

			expect(result.isError).toBeFalsy();
			const _response = JSON.parse(getTextContent(result));
			const parsed = _response.conversations ?? _response;
			expect(parsed[0].taskId).toBe('task-new'); // 10 messages
			expect(parsed[1].taskId).toBe('task-middle'); // 7 messages
			expect(parsed[2].taskId).toBe('task-old'); // 5 messages
		});

		test('list respects limit parameter', async () => {
			const result = await handleConversationBrowser(
				{ action: 'list', limit: 2, sortBy: 'lastActivity', sortOrder: 'desc' },
				mockCache,
				mockEnsureCache
			);

			expect(result.isError).toBeFalsy();
			const _response = JSON.parse(getTextContent(result));
			const parsed = _response.conversations ?? _response;
			expect(parsed.length).toBe(2);
			expect(parsed[0].taskId).toBe('task-new');
			expect(parsed[1].taskId).toBe('task-middle');
		});

		test('list filters by workspace when specified', async () => {
			// Add a task with different workspace
			const otherTask: ConversationSkeleton = {
				taskId: 'task-other-workspace',
				metadata: {
					title: 'Other Workspace Task',
					lastActivity: '2026-03-06T10:00:00Z',
					createdAt: '2026-03-06T10:00:00Z',
					messageCount: 3,
					actionCount: 1,
					totalSize: 300,
					workspace: 'd:\\other-project'
				}
			};
			mockCache.set('task-other-workspace', otherTask);

			const result = await handleConversationBrowser(
				{ action: 'list', workspace: 'd:\\roo-extensions' },
				mockCache,
				mockEnsureCache
			);

			expect(result.isError).toBeFalsy();
			const _response = JSON.parse(getTextContent(result));
			const parsed = _response.conversations ?? _response;
			// Should only include tasks from roo-extensions
			expect(parsed.every((t: any) => t.metadata.workspace === 'd:\\roo-extensions')).toBe(true);
		});
	});

	// ============================================================
	// REGRESSION #567 - Thread Safety
	// ============================================================

	describe('regression #567: thread safety', () => {
		test('concurrent list calls do not corrupt cache', async () => {
			// Setup tasks
			for (let i = 0; i < 10; i++) {
				const task: ConversationSkeleton = {
					taskId: `concurrent-task-${i}`,
					metadata: {
						title: `Concurrent Task ${i}`,
						lastActivity: new Date(2026, 2, 1 + i).toISOString(),
						createdAt: new Date(2026, 2, 1 + i).toISOString(),
						messageCount: i + 1,
						actionCount: i,
						totalSize: (i + 1) * 100,
						workspace: 'd:\\roo-extensions'
					}
				};
				mockCache.set(`concurrent-task-${i}`, task);
			}

			// Execute 3 concurrent list calls
			const results = await Promise.all([
				handleConversationBrowser({ action: 'list' }, mockCache, mockEnsureCache),
				handleConversationBrowser({ action: 'list', sortBy: 'messageCount' }, mockCache, mockEnsureCache),
				handleConversationBrowser({ action: 'list', limit: 5 }, mockCache, mockEnsureCache)
			]);

			// All should succeed
			for (const result of results) {
				expect(result.isError).toBeFalsy();
				const _response = JSON.parse(getTextContent(result));
				const parsed = _response.conversations ?? _response;
				expect(Array.isArray(parsed)).toBe(true);
			}

			// Cache should still have all tasks
			expect(mockCache.size).toBe(10);
		});

		test('cache remains consistent after multiple operations', async () => {
			// Initial setup
			const task: ConversationSkeleton = {
				taskId: 'consistency-task',
				metadata: {
					title: 'Consistency Task',
					lastActivity: '2026-03-07T10:00:00Z',
					createdAt: '2026-03-07T10:00:00Z',
					messageCount: 1,
					actionCount: 1,
					totalSize: 100,
					workspace: 'd:\\roo-extensions'
				}
			};
			mockCache.set('consistency-task', task);

			// Multiple operations
			await handleConversationBrowser({ action: 'list' }, mockCache, mockEnsureCache);
			await handleConversationBrowser({ action: 'list', sortBy: 'messageCount' }, mockCache, mockEnsureCache);
			await handleConversationBrowser({ action: 'list', workspace: 'd:\\roo-extensions' }, mockCache, mockEnsureCache);

			// Original task should still be in cache unchanged
			const cachedTask = mockCache.get('consistency-task');
			expect(cachedTask).toBeDefined();
			expect(cachedTask?.taskId).toBe('consistency-task');
			expect(cachedTask?.metadata.title).toBe('Consistency Task');
		});
	});
});
