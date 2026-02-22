/**
 * Tests pour TaskNavigator
 * Issue #492 - Couverture de la navigation dans l'arbre de tâches
 *
 * @module services/__tests__/task-navigator
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { TaskNavigator, TreeNode } from '../task-navigator.js';
import type { ConversationSkeleton } from '../../types/conversation.js';

function createSkeleton(taskId: string, parentId?: string): ConversationSkeleton {
	return {
		taskId,
		parentId: parentId,
		sequence: [],
		isCompleted: true
	} as any;
}

describe('TaskNavigator', () => {
	let cache: Map<string, ConversationSkeleton>;

	beforeEach(() => {
		cache = new Map();
	});

	// ============================================================
	// getAllTasks
	// ============================================================

	describe('getAllTasks', () => {
		test('returns empty array for empty cache', () => {
			const nav = new TaskNavigator(cache);
			expect(nav.getAllTasks()).toHaveLength(0);
		});

		test('returns all tasks in cache', () => {
			cache.set('task-1', createSkeleton('task-1'));
			cache.set('task-2', createSkeleton('task-2'));
			cache.set('task-3', createSkeleton('task-3'));
			const nav = new TaskNavigator(cache);
			expect(nav.getAllTasks()).toHaveLength(3);
		});
	});

	// ============================================================
	// getTaskParent
	// ============================================================

	describe('getTaskParent', () => {
		test('returns null for root task (no parentId)', () => {
			cache.set('root', createSkeleton('root'));
			const nav = new TaskNavigator(cache);
			expect(nav.getTaskParent('root')).toBeNull();
		});

		test('returns null for ROOT sentinel', () => {
			const skeleton = createSkeleton('child', 'ROOT');
			cache.set('child', skeleton);
			const nav = new TaskNavigator(cache);
			expect(nav.getTaskParent('child')).toBeNull();
		});

		test('returns parent when it exists in cache', () => {
			const parent = createSkeleton('parent');
			const child = createSkeleton('child', 'parent');
			cache.set('parent', parent);
			cache.set('child', child);
			const nav = new TaskNavigator(cache);
			const result = nav.getTaskParent('child');
			expect(result).toBe(parent);
		});

		test('returns null when parent not in cache', () => {
			const child = createSkeleton('child', 'missing-parent');
			cache.set('child', child);
			const nav = new TaskNavigator(cache);
			expect(nav.getTaskParent('child')).toBeNull();
		});

		test('returns null for non-existent task', () => {
			const nav = new TaskNavigator(cache);
			expect(nav.getTaskParent('non-existent')).toBeNull();
		});

		test('uses parentTaskId as fallback', () => {
			const parent = createSkeleton('parent');
			const child = { taskId: 'child', parentTaskId: 'parent', sequence: [], isCompleted: true } as any;
			cache.set('parent', parent);
			cache.set('child', child);
			const nav = new TaskNavigator(cache);
			expect(nav.getTaskParent('child')).toBe(parent);
		});
	});

	// ============================================================
	// getTaskChildren
	// ============================================================

	describe('getTaskChildren', () => {
		test('returns empty for task with no children', () => {
			cache.set('parent', createSkeleton('parent'));
			const nav = new TaskNavigator(cache);
			expect(nav.getTaskChildren('parent')).toHaveLength(0);
		});

		test('returns children of a task', () => {
			cache.set('parent', createSkeleton('parent'));
			cache.set('child-1', createSkeleton('child-1', 'parent'));
			cache.set('child-2', createSkeleton('child-2', 'parent'));
			cache.set('other', createSkeleton('other', 'other-parent'));
			const nav = new TaskNavigator(cache);
			const children = nav.getTaskChildren('parent');
			expect(children).toHaveLength(2);
			expect(children.map(c => c.taskId)).toContain('child-1');
			expect(children.map(c => c.taskId)).toContain('child-2');
		});

		test('returns empty for non-existent parent', () => {
			cache.set('child', createSkeleton('child', 'parent'));
			const nav = new TaskNavigator(cache);
			// parent doesn't exist in cache but children point to it
			expect(nav.getTaskChildren('parent')).toHaveLength(1);
		});
	});

	// ============================================================
	// getTaskTree
	// ============================================================

	describe('getTaskTree', () => {
		test('returns null for non-existent task', () => {
			const nav = new TaskNavigator(cache);
			expect(nav.getTaskTree('non-existent')).toBeNull();
		});

		test('returns leaf node for task with no children', () => {
			cache.set('leaf', createSkeleton('leaf'));
			const nav = new TaskNavigator(cache);
			const tree = nav.getTaskTree('leaf');
			expect(tree).not.toBeNull();
			expect(tree!.taskId).toBe('leaf');
			expect(tree!.children).toHaveLength(0);
		});

		test('builds tree with one level of children', () => {
			cache.set('root', createSkeleton('root'));
			cache.set('child-1', createSkeleton('child-1', 'root'));
			cache.set('child-2', createSkeleton('child-2', 'root'));
			const nav = new TaskNavigator(cache);
			const tree = nav.getTaskTree('root');
			expect(tree).not.toBeNull();
			expect(tree!.children).toHaveLength(2);
			expect(tree!.children[0].children).toHaveLength(0);
		});

		test('builds deep tree (3 levels)', () => {
			cache.set('root', createSkeleton('root'));
			cache.set('child', createSkeleton('child', 'root'));
			cache.set('grandchild', createSkeleton('grandchild', 'child'));
			const nav = new TaskNavigator(cache);
			const tree = nav.getTaskTree('root');
			expect(tree).not.toBeNull();
			expect(tree!.children).toHaveLength(1);
			expect(tree!.children[0].taskId).toBe('child');
			expect(tree!.children[0].children).toHaveLength(1);
			expect(tree!.children[0].children[0].taskId).toBe('grandchild');
		});

		test('only includes descendants, not siblings', () => {
			cache.set('root', createSkeleton('root'));
			cache.set('child-a', createSkeleton('child-a', 'root'));
			cache.set('child-b', createSkeleton('child-b', 'root'));
			cache.set('grandchild-a1', createSkeleton('grandchild-a1', 'child-a'));
			const nav = new TaskNavigator(cache);
			const tree = nav.getTaskTree('child-a');
			expect(tree).not.toBeNull();
			expect(tree!.children).toHaveLength(1);
			expect(tree!.children[0].taskId).toBe('grandchild-a1');
		});
	});
});
