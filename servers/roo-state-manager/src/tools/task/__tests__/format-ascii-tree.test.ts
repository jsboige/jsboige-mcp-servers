/**
 * Tests pour format-ascii-tree.ts
 * Issue #492 - Couverture des utilitaires de formatage
 *
 * @module tools/task/__tests__/format-ascii-tree
 */

import { describe, test, expect } from 'vitest';
import {
	formatTaskTreeAscii,
	generateTreeHeader,
	generateTreeFooter,
	countTreeNodes,
	getMaxTreeDepth,
	TaskTreeNode,
	FormatAsciiTreeOptions
} from '../format-ascii-tree.js';

// Helper to create a simple task node
function createNode(id: string, opts?: Partial<TaskTreeNode>): TaskTreeNode {
	return {
		taskId: id,
		taskIdShort: id.substring(0, 8),
		title: opts?.title ?? `Task ${id}`,
		metadata: {
			isCompleted: false,
			truncatedInstruction: opts?.metadata?.truncatedInstruction ?? `Do something for ${id}`,
			messageCount: 10,
			...opts?.metadata
		},
		children: opts?.children ?? []
	};
}

describe('format-ascii-tree', () => {
	// ============================================================
	// formatTaskTreeAscii
	// ============================================================

	describe('formatTaskTreeAscii', () => {
		test('formats a single root node', () => {
			const node = createNode('task-001');
			const result = formatTaskTreeAscii(node);

			expect(result).toContain('task-001');
			expect(result).toContain('Do something for task-001');
		});

		test('formats root with children using tree connectors', () => {
			const root = createNode('root', {
				children: [
					createNode('child-1'),
					createNode('child-2')
				]
			});
			const result = formatTaskTreeAscii(root);

			expect(result).toContain('root');
			expect(result).toContain('child-1');
			expect(result).toContain('child-2');
			// Last child should use └─
			expect(result).toContain('└─');
			// Non-last children should use ├─
			expect(result).toContain('├─');
		});

		test('shows completion status emoji', () => {
			const completed = createNode('done', {
				metadata: { isCompleted: true, truncatedInstruction: 'Completed task' }
			});
			const pending = createNode('pending', {
				metadata: { isCompleted: false, truncatedInstruction: 'Pending task' }
			});

			const resultDone = formatTaskTreeAscii(completed);
			const resultPending = formatTaskTreeAscii(pending);

			// Completed tasks have different emoji
			expect(resultDone).not.toEqual(resultPending);
		});

		test('truncates long instructions', () => {
			const longInstruction = 'A'.repeat(200);
			const node = createNode('task-long', {
				metadata: { truncatedInstruction: longInstruction }
			});
			const result = formatTaskTreeAscii(node, { truncateInstruction: 50 });

			expect(result).toContain('...');
			expect(result).not.toContain(longInstruction);
		});

		test('highlights current task when enabled', () => {
			const node = createNode('current', {
				metadata: { isCurrentTask: true, truncatedInstruction: 'Current work' }
			});
			const result = formatTaskTreeAscii(node, { highlightCurrent: true });

			expect(result).toContain('ACTUELLE');
		});

		test('does not highlight current task when disabled', () => {
			const node = createNode('current', {
				metadata: { isCurrentTask: true, truncatedInstruction: 'Current work' }
			});
			const result = formatTaskTreeAscii(node, { highlightCurrent: false });

			expect(result).not.toContain('ACTUELLE');
		});

		test('shows metadata when enabled', () => {
			const node = createNode('meta', {
				metadata: {
					truncatedInstruction: 'Test',
					messageCount: 42,
					totalSizeBytes: 2048,
					totalSizeKB: 2,
					mode: 'code',
					workspace: '/test/workspace',
					lastActivity: '2026-02-22T10:00:00Z'
				}
			});
			const result = formatTaskTreeAscii(node, { showMetadata: true });

			expect(result).toContain('42 messages');
			expect(result).toContain('Mode: code');
			expect(result).toContain('Workspace: /test/workspace');
			expect(result).toContain('Last activity');
		});

		test('hides metadata by default', () => {
			const node = createNode('meta', {
				metadata: {
					truncatedInstruction: 'Test',
					messageCount: 42,
					mode: 'code'
				}
			});
			const result = formatTaskTreeAscii(node);

			expect(result).not.toContain('42 messages');
			expect(result).not.toContain('Mode: code');
		});

		test('hides status when showStatus is false', () => {
			const node = createNode('no-status', {
				metadata: { isCompleted: true, truncatedInstruction: 'Test' }
			});
			const result = formatTaskTreeAscii(node, { showStatus: false });

			// Should not contain the status emojis
			expect(result).not.toContain('✅');
			expect(result).not.toContain('⏳');
		});

		test('formats deeply nested tree', () => {
			const root = createNode('level-0', {
				children: [
					createNode('level-1', {
						children: [
							createNode('level-2', {
								children: [
									createNode('level-3')
								]
							})
						]
					})
				]
			});
			const result = formatTaskTreeAscii(root);

			expect(result).toContain('level-0');
			expect(result).toContain('level-1');
			expect(result).toContain('level-2');
			expect(result).toContain('level-3');
		});

		test('falls back to title when truncatedInstruction is empty', () => {
			const node: TaskTreeNode = {
				taskId: 'task-fallback',
				taskIdShort: 'task-fal',
				title: 'My Task Title',
				metadata: { truncatedInstruction: '' }
			};
			const result = formatTaskTreeAscii(node);

			expect(result).toContain('My Task Title');
		});

		test('shows "No instruction" when both are empty', () => {
			const node: TaskTreeNode = {
				taskId: 'task-empty',
				taskIdShort: 'task-emp',
				title: '',
				metadata: { truncatedInstruction: '' }
			};
			const result = formatTaskTreeAscii(node);

			expect(result).toContain('No instruction');
		});
	});

	// ============================================================
	// generateTreeHeader
	// ============================================================

	describe('generateTreeHeader', () => {
		test('includes conversation ID', () => {
			const header = generateTreeHeader('conv-12345678-abcdef', 10, true);
			expect(header).toContain('conv-123');
		});

		test('includes max depth', () => {
			const header = generateTreeHeader('conv-1', 5, true);
			expect(header).toContain('5');
		});

		test('shows infinity symbol for unlimited depth', () => {
			const header = generateTreeHeader('conv-1', Infinity, true);
			expect(header).toContain('∞');
		});

		test('shows siblings option', () => {
			const headerYes = generateTreeHeader('conv-1', 10, true);
			const headerNo = generateTreeHeader('conv-1', 10, false);
			expect(headerYes).toContain('Oui');
			expect(headerNo).toContain('Non');
		});

		test('includes root title when provided', () => {
			const header = generateTreeHeader('conv-1', 10, true, 'My Root Task');
			expect(header).toContain('My Root Task');
		});
	});

	// ============================================================
	// generateTreeFooter
	// ============================================================

	describe('generateTreeFooter', () => {
		test('includes total nodes count', () => {
			const footer = generateTreeFooter(42, 5);
			expect(footer).toContain('42');
		});

		test('includes max depth', () => {
			const footer = generateTreeFooter(10, 3);
			expect(footer).toContain('3');
		});
	});

	// ============================================================
	// countTreeNodes
	// ============================================================

	describe('countTreeNodes', () => {
		test('counts single node', () => {
			const node = createNode('single');
			expect(countTreeNodes(node)).toBe(1);
		});

		test('counts node with children', () => {
			const root = createNode('root', {
				children: [
					createNode('child-1'),
					createNode('child-2')
				]
			});
			expect(countTreeNodes(root)).toBe(3);
		});

		test('counts nested tree', () => {
			const root = createNode('root', {
				children: [
					createNode('child-1', {
						children: [
							createNode('grandchild-1'),
							createNode('grandchild-2')
						]
					}),
					createNode('child-2')
				]
			});
			expect(countTreeNodes(root)).toBe(5);
		});
	});

	// ============================================================
	// getMaxTreeDepth
	// ============================================================

	describe('getMaxTreeDepth', () => {
		test('returns 0 for leaf node', () => {
			const node = createNode('leaf');
			expect(getMaxTreeDepth(node)).toBe(0);
		});

		test('returns 1 for root with direct children', () => {
			const root = createNode('root', {
				children: [createNode('child')]
			});
			expect(getMaxTreeDepth(root)).toBe(1);
		});

		test('returns max depth for asymmetric tree', () => {
			const root = createNode('root', {
				children: [
					createNode('shallow'),
					createNode('deep', {
						children: [
							createNode('deeper', {
								children: [createNode('deepest')]
							})
						]
					})
				]
			});
			expect(getMaxTreeDepth(root)).toBe(3);
		});
	});
});
