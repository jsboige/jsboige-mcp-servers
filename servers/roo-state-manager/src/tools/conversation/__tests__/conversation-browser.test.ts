/**
 * Tests pour conversation_browser (outil actif #1, AUCUN test existant)
 * Issue #492 - Couverture des outils actifs
 *
 * @module tools/conversation/__tests__/conversation-browser
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// Hoisted mocks for ESM compatibility
const { mockHandleTaskBrowse, mockViewHandler, mockHandleSummarize } = vi.hoisted(() => ({
	mockHandleTaskBrowse: vi.fn(),
	mockViewHandler: vi.fn(),
	mockHandleSummarize: vi.fn()
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
});
