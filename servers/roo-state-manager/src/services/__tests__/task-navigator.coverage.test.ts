/**
 * #833 Sprint C3 — TaskNavigator branch coverage (po-2026 lane `src/services/**`)
 *
 * The base `task-navigator.test.ts` (24 tests) covers the happy paths well:
 * getAllTasks, getTaskParent (root / ROOT sentinel / parent-exists / parent-missing /
 * non-existent task / parentTaskId-fallback), getTaskChildren (no-children / children /
 * orphan-children), getTaskTree (non-existent / leaf / one-level / deep / descendants-only).
 *
 * It leaves a coherent cluster of branches cold, however — every helper resolves the
 * parent id via `parentId ?? parentTaskId` (L19 in getTaskParent, L30 in getTaskChildren),
 * but the base ONLY ever populates `parentId` (its `createSkeleton(taskId, parentId?)`
 * helper sets parentId positionally). The sole exception is one getTaskParent test (L89)
 * that sets `parentTaskId` directly. Consequences:
 *
 * - **`getTaskChildren` `parentTaskId` fallback (L30)**: NEVER exercised — every child
 *   in the base is declared via `parentId`, so the `?? parentTaskId` arm on the *child*
 *   side is dead in the base. A child carrying only `parentTaskId` would be invisible
 *   to getTaskChildren if that arm regressed.
 * - **`getTaskTree` recursion via `parentTaskId` (L50 → L30)**: buildTree calls
 *   getTaskChildren, so the same cold fallback propagates into tree construction.
 * - **`ROOT` sentinel via `parentTaskId` (L19 + L21)**: the base tests `parentId === 'ROOT'`
 *   but never `parentTaskId === 'ROOT'` (fallback-then-sentinel). The sentinel guard
 *   fires AFTER the `??` resolution, so the path parentId-absent → parentTaskId='ROOT'
 *   → pId='ROOT' → null is cold.
 * - **Precedence `parentId ?? parentTaskId` (L19)**: when BOTH are set and differ,
 *   `parentId` wins (nullish coalescing). Never asserted.
 * - **Nullish-vs-falsy semantics (L19)**: `parentId = ''` (empty string) does NOT
 *   trigger the `??` fallback (empty is not nullish), but IS caught by the `!pId`
 *   guard at L21 → returns null. Distinct from a missing parentId, never pinned.
 *
 * This add-only file pins each, anchored on source lines of `task-navigator.ts`.
 * No mocks, no production code touched (#1936 anti-churn).
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { TaskNavigator } from '../task-navigator.js';
import type { ConversationSkeleton } from '../../types/conversation.js';

/** Skeleton that carries ONLY parentTaskId (no parentId) — the cold arm of L19/L30. */
function skeletonWithParentTaskId(taskId: string, parentTaskId?: string): ConversationSkeleton {
    return {
        taskId,
        parentTaskId,
        sequence: [],
        isCompleted: true,
    } as any;
}

/** Skeleton that carries ONLY parentId (matches the base helper's shape). */
function skeletonWithParentId(taskId: string, parentId?: string): ConversationSkeleton {
    return {
        taskId,
        parentId,
        sequence: [],
        isCompleted: true,
    } as any;
}

/** Skeleton carrying BOTH parentId and parentTaskId — to assert ?? precedence. */
function skeletonWithBoth(
    taskId: string,
    parentId: string,
    parentTaskId: string,
): ConversationSkeleton {
    return {
        taskId,
        parentId,
        parentTaskId,
        sequence: [],
        isCompleted: true,
    } as any;
}

describe('TaskNavigator — branch coverage (#833 C3, source-grounded)', () => {
    let cache: Map<string, ConversationSkeleton>;

    beforeEach(() => {
        cache = new Map();
    });

    // ============================================================
    // getTaskParent — parentTaskId fallback + ROOT sentinel + ?? semantics (L19-21)
    // ============================================================
    describe('getTaskParent — parentTaskId arms (L19, L21)', () => {
        test('ROOT sentinel reached via parentTaskId fallback → null (L19 ?? then L21 === "ROOT")', () => {
            // parentId absent → ?? falls back to parentTaskId='ROOT' → pId='ROOT' → L21 returns null.
            cache.set('child', skeletonWithParentTaskId('child', 'ROOT'));
            const nav = new TaskNavigator(cache);
            expect(nav.getTaskParent('child')).toBeNull();
        });

        test('parentTaskId-only resolves to the parent when it exists in cache (L19 ?? fallback to parentTaskId)', () => {
            const parent = skeletonWithParentId('parent');
            cache.set('parent', parent);
            cache.set('child', skeletonWithParentTaskId('child', 'parent'));
            const nav = new TaskNavigator(cache);
            expect(nav.getTaskParent('child')).toBe(parent);
        });

        test('precedence: parentId wins over parentTaskId when both set (L19 ?? — left operand wins)', () => {
            // parentId='via-parentId', parentTaskId='via-parentTaskId' → ?? keeps parentId.
            const winner = skeletonWithParentId('via-parentId');
            const loser = skeletonWithParentId('via-parentTaskId');
            cache.set('via-parentId', winner);
            cache.set('via-parentTaskId', loser);
            cache.set('child', skeletonWithBoth('child', 'via-parentId', 'via-parentTaskId'));
            const nav = new TaskNavigator(cache);
            expect(nav.getTaskParent('child')).toBe(winner);
            expect(nav.getTaskParent('child')).not.toBe(loser);
        });

        test('nullish (not falsy) semantics: parentId="" does NOT fall back to parentTaskId, but !pId guard → null (L19 ?? vs L21)', () => {
            // parentId='' (empty string) is NOT nullish → ?? keeps ''. Then L21 `!pId` catches '' → null.
            // parentTaskId='real-parent' is NOT consulted (fallback did not fire).
            const realParent = skeletonWithParentId('real-parent');
            cache.set('real-parent', realParent);
            cache.set('child', skeletonWithBoth('child', '', 'real-parent'));
            const nav = new TaskNavigator(cache);
            // Empty-string parentId → treated as no parent (null), even though parentTaskId points elsewhere.
            expect(nav.getTaskParent('child')).toBeNull();
            expect(nav.getTaskParent('child')).not.toBe(realParent);
        });
    });

    // ============================================================
    // getTaskChildren — parentTaskId fallback (L30) — the cold arm
    // ============================================================
    describe('getTaskChildren — parentTaskId arm (L30)', () => {
        test('matches children declared via parentTaskId (L30 ?? fallback on the child side)', () => {
            // Child carries ONLY parentTaskId (no parentId) → L30 ?? must fall back to find it.
            cache.set('parent', skeletonWithParentId('parent'));
            cache.set('child-a', skeletonWithParentTaskId('child-a', 'parent'));
            const nav = new TaskNavigator(cache);
            const children = nav.getTaskChildren('parent');
            expect(children).toHaveLength(1);
            expect(children[0].taskId).toBe('child-a');
        });

        test('matches a MIX of parentId and parentTaskId children pointing at the same parent (L30)', () => {
            cache.set('parent', skeletonWithParentId('parent'));
            cache.set('via-parentId', skeletonWithParentId('via-parentId', 'parent'));
            cache.set('via-parentTaskId', skeletonWithParentTaskId('via-parentTaskId', 'parent'));
            const nav = new TaskNavigator(cache);
            const children = nav.getTaskChildren('parent');
            expect(children).toHaveLength(2);
            const ids = children.map((c) => c.taskId).sort();
            expect(ids).toEqual(['via-parentId', 'via-parentTaskId']);
        });

        test('does NOT match a child whose parentTaskId differs (L30 strict equality)', () => {
            cache.set('parent', skeletonWithParentId('parent'));
            cache.set('stranger', skeletonWithParentTaskId('stranger', 'other-parent'));
            const nav = new TaskNavigator(cache);
            expect(nav.getTaskChildren('parent')).toHaveLength(0);
        });
    });

    // ============================================================
    // getTaskTree — recursion reaches children declared via parentTaskId (L50 → L30)
    // ============================================================
    describe('getTaskTree — parentTaskId children in recursion (L50 → L30)', () => {
        test('builds a tree where level-1 children are declared via parentTaskId (L50 → L30 fallback)', () => {
            cache.set('root', skeletonWithParentId('root'));
            // Child declared via parentTaskId only — invisible to getTaskTree if L30 fallback regresses.
            cache.set('child', skeletonWithParentTaskId('child', 'root'));
            const nav = new TaskNavigator(cache);
            const tree = nav.getTaskTree('root');
            expect(tree).not.toBeNull();
            expect(tree!.children).toHaveLength(1);
            expect(tree!.children[0].taskId).toBe('child');
        });

        test('builds a deep tree mixing parentId (level 1) and parentTaskId (level 2) declarations', () => {
            cache.set('root', skeletonWithParentId('root'));
            // Level 1 via parentId (base-style).
            cache.set('mid', skeletonWithParentId('mid', 'root'));
            // Level 2 via parentTaskId only — exercises L30 fallback inside recursion.
            cache.set('leaf', skeletonWithParentTaskId('leaf', 'mid'));
            const nav = new TaskNavigator(cache);
            const tree = nav.getTaskTree('root');
            expect(tree).not.toBeNull();
            expect(tree!.children).toHaveLength(1);
            expect(tree!.children[0].taskId).toBe('mid');
            expect(tree!.children[0].children).toHaveLength(1);
            expect(tree!.children[0].children[0].taskId).toBe('leaf');
        });

        test('tree from a root whose only descendants are parentTaskId-declared is non-empty', () => {
            // Root itself can be declared via parentTaskId-style fields; what matters is its children's resolution.
            cache.set('root', skeletonWithParentTaskId('root'));
            cache.set('only-child', skeletonWithParentTaskId('only-child', 'root'));
            const nav = new TaskNavigator(cache);
            const tree = nav.getTaskTree('root');
            expect(tree).not.toBeNull();
            expect(tree!.taskId).toBe('root');
            expect(tree!.children).toHaveLength(1);
            expect(tree!.children[0].taskId).toBe('only-child');
        });
    });

    // ============================================================
    // Cross-helper coherence — parentTaskId consistent across getTaskParent + getTaskChildren
    // ============================================================
    describe('coherence — parentTaskId seen identically by getTaskParent and getTaskChildren', () => {
        test('a parentTaskId-only child is both resolvable as a parent link and discoverable as a child', () => {
            const parent = skeletonWithParentId('parent');
            cache.set('parent', parent);
            cache.set('child', skeletonWithParentTaskId('child', 'parent'));
            const nav = new TaskNavigator(cache);
            // L19 fallback (getTaskParent) and L30 fallback (getTaskChildren) must agree.
            expect(nav.getTaskParent('child')).toBe(parent);
            expect(nav.getTaskChildren('parent')).toHaveLength(1);
            expect(nav.getTaskChildren('parent')[0]).toBe(
                cache.get('child'),
            );
        });
    });
});
