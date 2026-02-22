/**
 * Tests pour format-hierarchical-tree.ts
 * Issue #492 - Couverture des utilitaires de formatage
 *
 * @module tools/task/__tests__/format-hierarchical-tree
 */

import { describe, test, expect } from 'vitest';
import { formatTaskTreeHierarchical, FormatHierarchicalTreeOptions } from '../format-hierarchical-tree.js';
import type { TaskTreeNode } from '../format-ascii-tree.js';

// Helper to create a task node
function createNode(id: string, opts?: Partial<TaskTreeNode>): TaskTreeNode {
	return {
		taskId: id,
		taskIdShort: id.substring(0, 8),
		title: opts?.title ?? `Task ${id}`,
		metadata: {
			isCompleted: false,
			truncatedInstruction: opts?.metadata?.truncatedInstruction ?? `Do something for ${id}`,
			messageCount: 10,
			actionCount: 5,
			totalSizeKB: 2,
			totalSizeBytes: 2048,
			createdAt: '2026-02-22T09:00:00Z',
			lastActivity: '2026-02-22T10:00:00Z',
			mode: 'code',
			workspace: '/test/workspace',
			childrenCount: opts?.children?.length ?? 0,
			depth: opts?.metadata?.depth ?? 0,
			...opts?.metadata
		},
		children: opts?.children ?? []
	};
}

describe('format-hierarchical-tree', () => {
	// ============================================================
	// Basic formatting
	// ============================================================

	describe('basic formatting', () => {
		test('formats a single root node', () => {
			const node = createNode('task-001');
			const result = formatTaskTreeHierarchical(node);

			expect(result).toContain('task-001');
			expect(result).toContain('Do something for task-001');
		});

		test('includes task mode', () => {
			const node = createNode('task-code', {
				metadata: { mode: 'code', truncatedInstruction: 'Write code' }
			});
			const result = formatTaskTreeHierarchical(node);

			expect(result).toContain('code');
		});

		test('includes status', () => {
			const completed = createNode('done', {
				metadata: { isCompleted: true, truncatedInstruction: 'Done' }
			});
			const result = formatTaskTreeHierarchical(completed);

			expect(result).toContain('completed');
		});

		test('shows in_progress for incomplete tasks', () => {
			const pending = createNode('pending', {
				metadata: { isCompleted: false, truncatedInstruction: 'Pending' }
			});
			const result = formatTaskTreeHierarchical(pending);

			expect(result).toContain('in_progress');
		});
	});

	// ============================================================
	// Header options
	// ============================================================

	describe('header options', () => {
		test('includes statistics by default', () => {
			const node = createNode('root');
			const result = formatTaskTreeHierarchical(node);

			expect(result).toContain('Statistiques Globales');
			expect(result).toContain('Total');
		});

		test('excludes statistics when disabled', () => {
			const node = createNode('root');
			const result = formatTaskTreeHierarchical(node, { includeStats: false });

			expect(result).not.toContain('Statistiques Globales');
		});

		test('includes table of contents by default', () => {
			const node = createNode('root');
			const result = formatTaskTreeHierarchical(node);

			expect(result).toContain('Table des');
		});

		test('excludes ToC when disabled', () => {
			const node = createNode('root');
			const result = formatTaskTreeHierarchical(node, { includeToC: false });

			expect(result).not.toContain('Table des');
		});

		test('includes legend by default', () => {
			const node = createNode('root');
			const result = formatTaskTreeHierarchical(node);

			expect(result).toContain('gende');
		});

		test('excludes legend when disabled', () => {
			const node = createNode('root');
			const result = formatTaskTreeHierarchical(node, { includeLegend: false });

			expect(result).not.toContain('Statuts');
			expect(result).not.toContain('Modes');
		});
	});

	// ============================================================
	// Children formatting
	// ============================================================

	describe('children formatting', () => {
		test('formats root with children', () => {
			const root = createNode('root', {
				metadata: { childrenCount: 2 },
				children: [
					createNode('child-1', { metadata: { depth: 1 } }),
					createNode('child-2', { metadata: { depth: 1 } })
				]
			});
			const result = formatTaskTreeHierarchical(root);

			expect(result).toContain('child-1');
			expect(result).toContain('child-2');
		});

		test('formats nested children with indentation', () => {
			const root = createNode('root', {
				metadata: { childrenCount: 1 },
				children: [
					createNode('child', {
						metadata: { depth: 1, childrenCount: 1 },
						children: [
							createNode('grandchild', { metadata: { depth: 2 } })
						]
					})
				]
			});
			const result = formatTaskTreeHierarchical(root);

			expect(result).toContain('grandchild');
			// Nested content uses blockquote-style indentation
			expect(result).toContain('> ');
		});

		test('shows children count in output', () => {
			const root = createNode('root', {
				metadata: { childrenCount: 3 },
				children: [
					createNode('c1', { metadata: { depth: 1 } }),
					createNode('c2', { metadata: { depth: 1 } }),
					createNode('c3', { metadata: { depth: 1 } })
				]
			});
			const result = formatTaskTreeHierarchical(root);

			expect(result).toContain('Children: 3');
		});
	});

	// ============================================================
	// Statistics
	// ============================================================

	describe('statistics', () => {
		test('counts total tasks correctly', () => {
			const root = createNode('root', {
				children: [
					createNode('c1', { metadata: { depth: 1 } }),
					createNode('c2', { metadata: { depth: 1 } })
				]
			});
			const result = formatTaskTreeHierarchical(root);

			expect(result).toContain('3');  // root + 2 children
		});

		test('counts relations correctly', () => {
			const root = createNode('root', {
				children: [
					createNode('c1', {
						metadata: { depth: 1 },
						children: [createNode('gc1', { metadata: { depth: 2 } })]
					})
				]
			});
			const result = formatTaskTreeHierarchical(root);

			expect(result).toContain('Relations');
		});
	});

	// ============================================================
	// Mode emojis
	// ============================================================

	describe('mode emojis', () => {
		test('maps known modes to emojis', () => {
			const codeNode = createNode('code-task', {
				metadata: { mode: 'code', truncatedInstruction: 'Test' }
			});
			const result = formatTaskTreeHierarchical(codeNode);
			// Just verify it renders without error and contains mode info
			expect(result).toContain('code');
		});

		test('handles unknown mode gracefully', () => {
			const unknownNode = createNode('unknown-mode', {
				metadata: { mode: 'exotic-mode', truncatedInstruction: 'Test' }
			});
			const result = formatTaskTreeHierarchical(unknownNode);

			expect(result).toContain('exotic-mode');
		});
	});

	// ============================================================
	// Instruction truncation
	// ============================================================

	describe('instruction truncation', () => {
		test('truncates instructions longer than 100 chars', () => {
			const longInstruction = 'A'.repeat(200);
			const node = createNode('long', {
				metadata: { truncatedInstruction: longInstruction }
			});
			const result = formatTaskTreeHierarchical(node);

			expect(result).toContain('...');
			expect(result).not.toContain(longInstruction);
		});

		test('shows "No instruction" when empty', () => {
			const node = createNode('empty', {
				metadata: { truncatedInstruction: undefined as any }
			});
			const result = formatTaskTreeHierarchical(node);

			expect(result).toContain('No instruction');
		});
	});

	// ============================================================
	// Date formatting
	// ============================================================

	describe('metadata', () => {
		test('includes workspace', () => {
			const node = createNode('ws', {
				metadata: { workspace: '/my/workspace', truncatedInstruction: 'Test' }
			});
			const result = formatTaskTreeHierarchical(node);

			expect(result).toContain('/my/workspace');
		});

		test('includes message count', () => {
			const node = createNode('msgs', {
				metadata: { messageCount: 42, truncatedInstruction: 'Test' }
			});
			const result = formatTaskTreeHierarchical(node);

			expect(result).toContain('42');
		});
	});
});
