/**
 * Coverage complement for export-data.ts (#833 C3)
 *
 * The nominal suite (export-data.test.ts, CONS-10) covers the target×format
 * matrix for task/xml, conversation/{xml,json,csv}, project/xml — but leaves
 * TWO valid format combinations completely cold (validateTargetFormat L659-666
 * declares them valid, yet no test drives them):
 *
 *   - target='task' + format='debug'  → handleTaskDebug (L755-757, L703-708)
 *   - target='conversation' + format='markdown' → handleConversationMarkdown
 *     (L770-772, L671-697)
 *
 * These are the 85.71% function-coverage gap: two module-private handlers
 * reachable only via the exported handleExportData dispatcher. The contract
 * they encode is the ARG-MAPPING from ExportDataArgs to the delegated sibling
 * handler's args (not the sibling handler's internals, which have their own
 * suites). This file locks the mapping.
 *
 * Source-grounded: every assertion cites the source line whose contract it
 * locks. Tests-only, 0 source change. The 3 sibling handlers are mocked so the
 * arg-mapping is observed in isolation (the nominal suite lets them run real,
 * which obscures whether the dispatcher even routes to them).
 *
 * @module tools/export/__tests__/export-data.coverage
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// Hoisted mock spies — declared inside the factory so vi.mock hoisting works.
const { mockHandleTaskDebug, mockHandleConvMarkdown, mockHandleGetTaskTree } = vi.hoisted(() => ({
	mockHandleTaskDebug: vi.fn(),
	mockHandleConvMarkdown: vi.fn(),
	mockHandleGetTaskTree: vi.fn()
}));

vi.mock('../../task/debug-parsing.tool.js', () => ({
	handleDebugTaskParsing: mockHandleTaskDebug,
	DebugTaskParsingArgs: {}
}));

vi.mock('../../task/export-tree-md.tool.js', () => ({
	handleExportTaskTreeMarkdown: mockHandleConvMarkdown,
	ExportTaskTreeMarkdownArgs: {}
}));

vi.mock('../../task/get-tree.tool.js', () => ({
	handleGetTaskTree: mockHandleGetTaskTree
}));

// Minimal XmlExporterService stub — not exercised by these two combos but
// required by the handleExportData signature.
const mockXmlService = { generateProjectXml: vi.fn(), saveXmlToFile: vi.fn() } as any;
const mockEnsureFresh = vi.fn().mockResolvedValue(undefined);
const mockGetSkeleton = vi.fn().mockResolvedValue(null);

// NOW import the dispatcher under test.
import { handleExportData } from '../export-data.js';
import type { ExportDataArgs } from '../export-data.js';

describe('handleExportData — coverage complement: task/debug + conversation/markdown (#833 C3)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockHandleTaskDebug.mockResolvedValue({
			content: [{ type: 'text', text: 'debug-output' }]
		});
		mockHandleConvMarkdown.mockResolvedValue({
			content: [{ type: 'text', text: 'markdown-output' }]
		});
		mockEnsureFresh.mockResolvedValue(undefined);
		mockGetSkeleton.mockResolvedValue(null);
	});

	// ============================================================
	// target='task' + format='debug' → handleTaskDebug (L755-757)
	// handleTaskDebug (L703-708) maps args.taskId → { task_id } and delegates
	// to handleDebugTaskParsing. The `!` non-null assertion trusts validation.
	// ============================================================
	describe('task/debug combo (L755-757, L703-708)', () => {
		test('routes to handleDebugTaskParsing with taskId mapped to task_id', async () => {
			const args: ExportDataArgs = {
				target: 'task',
				format: 'debug',
				taskId: 'task-42'
			};

			const result = await handleExportData(
				args, new Map(), mockXmlService, mockEnsureFresh, mockGetSkeleton
			);

			expect(mockHandleTaskDebug).toHaveBeenCalledTimes(1);
			// L704-705: maps args.taskId! → debugArgs.task_id
			expect(mockHandleTaskDebug).toHaveBeenCalledWith({ task_id: 'task-42' });
			// Result is passed through unchanged from the delegated handler.
			expect(result.content[0].text).toBe('debug-output');
		});

		test('does not invoke the markdown or tree handlers', async () => {
			await handleExportData(
				{ target: 'task', format: 'debug', taskId: 't1' },
				new Map(), mockXmlService, mockEnsureFresh, mockGetSkeleton
			);
			expect(mockHandleConvMarkdown).not.toHaveBeenCalled();
			expect(mockHandleGetTaskTree).not.toHaveBeenCalled();
		});
	});

	// ============================================================
	// target='conversation' + format='markdown' → handleConversationMarkdown
	// (L770-772, L671-697)
	// Arg-mapping contract (L676-685):
	//   conversation_id ← args.conversationId
	//   filePath        ← args.filePath
	//   max_depth       ← args.maxDepth
	//   include_siblings← args.includeSiblings
	//   current_task_id ← args.currentTaskId
	//   output_format   ← args.outputFormat || 'ascii-tree'  (L682 default)
	//   truncate_instruction ← args.truncateInstruction
	//   show_metadata   ← args.showMetadata
	// ============================================================
	describe('conversation/markdown combo (L770-772, L671-697)', () => {
		test('routes to handleExportTaskTreeMarkdown with full arg mapping', async () => {
			const args: ExportDataArgs = {
				target: 'conversation',
				format: 'markdown',
				conversationId: 'conv-1',
				filePath: '/out/tree.md',
				maxDepth: 5,
				includeSiblings: true,
				currentTaskId: 'cur-1',
				outputFormat: 'hierarchical',
				truncateInstruction: 120,
				showMetadata: true
			};

			await handleExportData(
				args, new Map(), mockXmlService, mockEnsureFresh, mockGetSkeleton
			);

			expect(mockHandleConvMarkdown).toHaveBeenCalledTimes(1);
			const [passedArgs] = mockHandleConvMarkdown.mock.calls[0];
			// L676-685: every field mapped from ExportDataArgs → ExportTaskTreeMarkdownArgs
			expect(passedArgs).toMatchObject({
				conversation_id: 'conv-1',
				filePath: '/out/tree.md',
				max_depth: 5,
				include_siblings: true,
				current_task_id: 'cur-1',
				output_format: 'hierarchical',
				truncate_instruction: 120,
				show_metadata: true
			});
		});

		test('output_format defaults to ascii-tree when args.outputFormat absent (L682)', async () => {
			// L682: `output_format: args.outputFormat || 'ascii-tree'` — the `||`
			// fallback arm is cold when outputFormat is undefined.
			const args: ExportDataArgs = {
				target: 'conversation',
				format: 'markdown',
				conversationId: 'conv-2'
				// outputFormat deliberately omitted → default arm
			};

			await handleExportData(
				args, new Map(), mockXmlService, mockEnsureFresh, mockGetSkeleton
			);

			const [passedArgs] = mockHandleConvMarkdown.mock.calls[0];
			expect(passedArgs.output_format).toBe('ascii-tree');
		});

		test('passes a wrapped handleGetTaskTree that forwards to the real import (L687-689)', async () => {
			// L687-689: wrappedHandleGetTaskTree(treeArgs) → handleGetTaskTree(treeArgs, cache, ensureFresh)
			mockHandleConvMarkdown.mockImplementation(async (_a, wrapped) => {
				// Invoke the wrapped getter passed as 2nd arg to exercise L688.
				await wrapped({ conversation_id: 'x' });
				return { content: [{ type: 'text', text: 'ok' }] };
			});

			await handleExportData(
				{ target: 'conversation', format: 'markdown', conversationId: 'c3' },
				new Map(), mockXmlService, mockEnsureFresh, mockGetSkeleton
			);

			// The wrapper forwarded to the mocked handleGetTaskTree.
			expect(mockHandleGetTaskTree).toHaveBeenCalledTimes(1);
			expect(mockHandleGetTaskTree).toHaveBeenCalledWith(
				{ conversation_id: 'x' },
				expect.any(Map),
				mockEnsureFresh
			);
		});

		test('does not invoke the debug handler', async () => {
			await handleExportData(
				{ target: 'conversation', format: 'markdown', conversationId: 'c4' },
				new Map(), mockXmlService, mockEnsureFresh, mockGetSkeleton
			);
			expect(mockHandleTaskDebug).not.toHaveBeenCalled();
		});
	});
});
