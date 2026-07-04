/**
 * Coverage gap-complement for skeleton-comparator.ts.
 *
 * Baseline (post skeleton-comparator.test.ts, 115 tests across 3 suites at last
 * aggregate run): 100% stmts / 84.37% branches / 100% funcs / 100% lines.
 * Cold branches remain in the nullish-coalescing defaults of `compare` and the
 * optional-chain + `|| 0` of `compareWithImprovements`; covered here.
 *
 * Anchored on source lines (skeleton-comparator.ts):
 *   - L133 `oldPrefixes = new Set(oldSkeleton.childTaskInstructionPrefixes ?? [])`
 *     — base always provides a non-null array, so `?? []` is the always-taken
 *     arm; the COLD `newPrefixes` L134 right side fires only when the NEW
 *     skeleton has undefined/null childTaskInstructionPrefixes.
 *   - L146 `oldCompleted = oldSkeleton.isCompleted ?? false` and L147
 *     `newCompleted = newSkeleton.isCompleted ?? false` — base always sets
 *     isCompleted=true; `?? false` only fires for undefined/null.
 *   - L308-309 `childTaskInstructionPrefixes?.length || 0` — optional-chain +
 *     `|| 0` arm fires when length is 0 or the field is undefined.
 *
 * Discipline: 0 source touched (#1936 anti-churn). Pure-function, no mocks.
 * Uses the same createSkeleton helper shape as the base suite.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SkeletonComparator } from '../skeleton-comparator.js';
import type { ConversationSkeleton } from '../../types/conversation.js';

function createSkeleton(overrides?: Partial<ConversationSkeleton>): ConversationSkeleton {
    return {
        taskId: 'task-001',
        metadata: {
            title: 'Test task',
            lastActivity: '2026-02-10T10:00:00Z',
            createdAt: '2026-02-10T09:00:00Z',
            messageCount: 10,
            actionCount: 5,
            totalSize: 2048,
            workspace: '/workspace',
        },
        sequence: [],
        childTaskInstructionPrefixes: ['prefix-1', 'prefix-2'],
        isCompleted: true,
        truncatedInstruction: 'Do something',
        ...overrides,
    };
}

describe('SkeletonComparator — coverage gap-complement (nullish-default cold arms)', () => {
    let comparator: SkeletonComparator;

    beforeEach(() => {
        comparator = new SkeletonComparator();
    });

    // ─── L134: newSkeleton.childTaskInstructionPrefixes undefined → ?? [] ───

    it('compare: new skeleton with undefined childTaskInstructionPrefixes → L134 `?? []` arm', () => {
        // Base suite always provides a populated array on BOTH skeletons, so
        // only L133's `?? []` left arm is exercised. Providing undefined on the
        // NEW skeleton exercises L134's `?? []` right arm (old stays populated).
        const old = createSkeleton(); // populated prefixes
        const newer = createSkeleton({ childTaskInstructionPrefixes: undefined });

        const result = comparator.compare(old, newer);

        // Prefix sets differ (['prefix-1','prefix-2'] vs []) → major difference recorded.
        const prefixDiff = result.differences.find((d) => d.field === 'childTaskInstructionPrefixes');
        expect(prefixDiff).toBeDefined();
        expect(prefixDiff!.severity).toBe('major');
        expect(result.areIdentical).toBe(false);
    });

    it('compare: both skeletons with null childTaskInstructionPrefixes → both `?? []`, sets equal', () => {
        // null on both sides → both default to [] → sets equal → NO difference
        // for this field. Pin that null normalizes to empty (not flagged).
        const old = createSkeleton({ childTaskInstructionPrefixes: null });
        const newer = createSkeleton({ childTaskInstructionPrefixes: null });

        const result = comparator.compare(old, newer);

        const prefixDiff = result.differences.find((d) => d.field === 'childTaskInstructionPrefixes');
        expect(prefixDiff).toBeUndefined();
    });

    // ─── L146/L147: isCompleted undefined → ?? false ───

    it('compare: old skeleton with undefined isCompleted → L146 `?? false` arm', () => {
        // Base always sets isCompleted=true → `?? false` never fires. undefined
        // on OLD skeleton exercises L146. (old defaults to false, new stays true
        // → difference detected, confirming the default did NOT silently match.)
        const old = createSkeleton({ isCompleted: undefined });
        const newer = createSkeleton(); // isCompleted: true

        const result = comparator.compare(old, newer);

        const completedDiff = result.differences.find((d) => d.field === 'isCompleted');
        expect(completedDiff).toBeDefined();
        expect(completedDiff!.oldValue).toBe(false); // L146 default applied
        expect(completedDiff!.newValue).toBe(true);
    });

    it('compare: new skeleton with undefined isCompleted → L147 `?? false` arm', () => {
        // undefined on NEW skeleton exercises L147.
        const old = createSkeleton(); // isCompleted: true
        const newer = createSkeleton({ isCompleted: undefined });

        const result = comparator.compare(old, newer);

        const completedDiff = result.differences.find((d) => d.field === 'isCompleted');
        expect(completedDiff).toBeDefined();
        expect(completedDiff!.oldValue).toBe(true);
        expect(completedDiff!.newValue).toBe(false); // L147 default applied
    });

    it('compare: both isCompleted undefined → both `?? false`, no difference', () => {
        // Pin that undefined normalizes to false on both sides → no spurious diff.
        const old = createSkeleton({ isCompleted: undefined });
        const newer = createSkeleton({ isCompleted: undefined });

        const result = comparator.compare(old, newer);

        const completedDiff = result.differences.find((d) => d.field === 'isCompleted');
        expect(completedDiff).toBeUndefined();
    });

    // ─── L308-309: childTaskInstructionPrefixes?.length || 0 in compareWithImprovements ───

    it('compareWithImprovements: undefined childTaskInstructionPrefixes → L308/L309 optional-chain + `|| 0`', () => {
        // compareWithImprovements reads `prefixes?.length || 0` for both old (L308)
        // and new (L309). Base always provides a non-empty array → length > 0 →
        // `|| 0` never fires. undefined → optional-chain yields undefined → `|| 0`.
        const old = createSkeleton({ childTaskInstructionPrefixes: undefined });
        const newer = createSkeleton({ childTaskInstructionPrefixes: undefined });

        const result = comparator.compareWithImprovements(old, newer);

        // Should complete without error and return the validation envelope.
        expect(result).toHaveProperty('isValidUpgrade');
        expect(result).toHaveProperty('validationReason');
        expect(result).toHaveProperty('improvements');
        expect(typeof result.isValidUpgrade).toBe('boolean');
    });

    it('compareWithImprovements: empty array childTaskInstructionPrefixes → length=0 → `|| 0` arm', () => {
        // length=0 is falsy → `|| 0` fires (distinct from undefined path: here
        // the optional-chain returns 0, then `|| 0` activates). Pin both arms
        // of the `||` via empty-array vs populated-array inputs.
        const old = createSkeleton({ childTaskInstructionPrefixes: [] });
        const newer = createSkeleton({ childTaskInstructionPrefixes: [] });

        const result = comparator.compareWithImprovements(old, newer);

        expect(result).toHaveProperty('isValidUpgrade');
        expect(typeof result.isValidUpgrade).toBe('boolean');
    });
});
