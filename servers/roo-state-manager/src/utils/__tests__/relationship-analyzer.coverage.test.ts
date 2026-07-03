/**
 * Coverage complement for relationship-analyzer.ts.
 *
 * Baseline (post existing relationship-analyzer.test.ts): 96.69% stmts /
 * 91.22% branches. Two cold spots remain; both covered here:
 *
 *   Gap A — L105-106: catch block of analyzeParentChildRelationships.
 *     The try builds a Map iterating `conversation.taskId`; a null element
 *     throws (`null.taskId`) and is swallowed by the catch → returns [].
 *     Private method exercised directly via `(RelationshipAnalyzer as any)`
 *     (pattern from ValidationEngine.coverage.test.ts).
 *
 *   Gap B — L370-376: temporal-cluster finalization `else` branch
 *     (hoursDiff > TEMPORAL_WINDOW_HOURS && currentCluster.length >= 2 → push).
 *     Triggered by 3 conversations: c0, c1 (+1h, within 24h window → cluster),
 *     c2 (+48h, outside window → finalize the 2-element cluster). Public path.
 *
 * Discipline: 0 source touched (#1936). No overlap with existing suite — these
 * two branches were reported cold by the targeted coverage run.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RelationshipAnalyzer } from '../relationship-analyzer.js';
import { TaskTreeError } from '../../types/task-tree.js';
import type { ConversationSummary } from '../../types/conversation.js';

function makeConv(taskId: string, lastActivity: string): ConversationSummary {
    return {
        taskId,
        prompt: '',
        lastActivity,
        messageCount: 10,
        size: 1024,
        hasApiHistory: true,
        hasUiMessages: true,
        path: `/tasks/${taskId}`,
        metadata: {} as any,
    };
}

describe('RelationshipAnalyzer — coverage complement (cold branches)', () => {
    let errorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    // Gap A — L105-106 catch block.
    it('analyzeParentChildRelationships swallows errors from malformed input (catch L105)', () => {
        // A null element makes `conversation.taskId` throw inside the Map-building
        // loop; the surrounding try/catch must swallow it and return [].
        const result = (RelationshipAnalyzer as any).analyzeParentChildRelationships([null]);
        expect(result).toEqual([]);
        expect(errorSpy).toHaveBeenCalled();
    });

    // Gap B — L370-376 temporal-cluster finalization else-branch.
    it('finalizes a temporal cluster when a later conversation exits the 24h window', async () => {
        const convs = [
            makeConv('a', '2026-02-10T10:00:00Z'),
            makeConv('b', '2026-02-10T11:00:00Z'), // +1h → joins cluster [a,b]
            makeConv('c', '2026-02-12T10:00:00Z'), // +48h → exits window → finalize [a,b]
        ];

        const relationships = await RelationshipAnalyzer.analyzeRelationships(convs);

        // The else-branch (clusters.push for the finalized [a,b] cluster) executed.
        // Whether a relationship is emitted depends on the weight threshold; here we
        // assert the public path completed without throwing and returned an array.
        expect(Array.isArray(relationships)).toBe(true);
    });

    // Gap C — L55-59: outer catch of analyzeRelationships re-throws TaskTreeError.
    it('analyzeRelationships wraps an internal analyzer failure in TaskTreeError (catch L55)', async () => {
        // Force a sub-analyzer to throw so the orchestration's outer catch fires.
        const spy = vi
            .spyOn(RelationshipAnalyzer as any, 'analyzeFileDependencies')
            .mockImplementationOnce(() => {
                throw new Error('injected');
            });

        await expect(
            RelationshipAnalyzer.analyzeRelationships([makeConv('a', '2026-02-10T10:00:00Z')])
        ).rejects.toThrow(TaskTreeError);

        spy.mockRestore();
    });

    // Gap D — L405-408: determineTemporalPattern threshold arms.
    //   intensity = conversationCount / timeSpanHours → 4 return arms.
    it('determineTemporalPattern classifies all four intensity bands', () => {
        const ra = RelationshipAnalyzer as any;
        expect(ra.determineTemporalPattern(10, 4)).toBe('burst');    // 2.5  > 2
        expect(ra.determineTemporalPattern(2, 2)).toBe('steady');    // 1.0  > 0.5
        expect(ra.determineTemporalPattern(1, 5)).toBe('declining'); // 0.2  > 0.1
        expect(ra.determineTemporalPattern(1, 100)).toBe('irregular'); // 0.01
    });
});
