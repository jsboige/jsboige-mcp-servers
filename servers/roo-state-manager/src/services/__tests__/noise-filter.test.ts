import { describe, it, expect, beforeEach } from 'vitest';
import { NoiseFilter } from '../noise-filter.js';
import { SkeletonHeader } from '../../types/conversation.js';

function makeSkeleton(overrides: Partial<SkeletonHeader['metadata']> & { taskId?: string; parentTaskId?: string }): SkeletonHeader {
    const taskId = overrides.taskId || 'test-task-001';
    return {
        taskId,
        parentTaskId: overrides.parentTaskId,
        metadata: {
            lastActivity: overrides.lastActivity || new Date().toISOString(),
            createdAt: overrides.createdAt || new Date().toISOString(),
            messageCount: overrides.messageCount ?? 50,
            actionCount: overrides.actionCount ?? 20,
            totalSize: overrides.totalSize ?? 10000,
            mode: overrides.mode,
            workspace: overrides.workspace,
            machineId: overrides.machineId,
            source: overrides.source,
        },
    };
}

function makeOldDate(daysAgo: number): string {
    return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
}

describe('NoiseFilter', () => {
    let filter: NoiseFilter;

    beforeEach(() => {
        filter = new NoiseFilter();
    });

    describe('blacklist', () => {
        it('matches blacklisted task IDs', () => {
            filter.loadBlacklist(['bad-task-1', 'bad-task-2']);
            const skeleton = makeSkeleton({ taskId: 'bad-task-1' });
            const result = filter.isNoiseTask(skeleton);
            expect(result.isNoise).toBe(true);
            expect(result.pattern).toBe('blacklist');
        });

        it('does not match non-blacklisted tasks', () => {
            filter.loadBlacklist(['bad-task-1']);
            const skeleton = makeSkeleton({ taskId: 'good-task-1' });
            const result = filter.isNoiseTask(skeleton);
            expect(result.isNoise).toBe(false);
        });

        it('reports blacklist size', () => {
            filter.loadBlacklist(['a', 'b', 'c']);
            expect(filter.blacklistSize).toBe(3);
        });
    });

    describe('scheduled-repetitive pattern', () => {
        it('matches scheduled mode with age + volume', () => {
            const skeleton = makeSkeleton({
                taskId: 'test-task',
                mode: 'scheduled',
                lastActivity: makeOldDate(60),
                messageCount: 500,
            });
            const result = filter.isNoiseTask(skeleton);
            expect(result.isNoise).toBe(true);
            expect(result.pattern).toBe('scheduled-repetitive');
        });

        it('matches automated taskId pattern with age + volume', () => {
            const skeleton = makeSkeleton({
                taskId: 'worker-build-check-001',
                lastActivity: makeOldDate(45),
                messageCount: 300,
            });
            const result = filter.isNoiseTask(skeleton);
            expect(result.isNoise).toBe(true);
            expect(result.pattern).toBe('scheduled-repetitive');
        });

        it('does not match recent scheduled tasks', () => {
            const skeleton = makeSkeleton({
                taskId: 'test-task',
                mode: 'scheduled',
                lastActivity: makeOldDate(5),
                messageCount: 500,
            });
            const result = filter.isNoiseTask(skeleton);
            expect(result.isNoise).toBe(false);
        });

        it('does not match small scheduled tasks', () => {
            const skeleton = makeSkeleton({
                taskId: 'test-task',
                mode: 'scheduled',
                lastActivity: makeOldDate(60),
                messageCount: 10,
            });
            const result = filter.isNoiseTask(skeleton);
            expect(result.isNoise).toBe(false);
        });
    });

    describe('runaway-spiral pattern', () => {
        it('matches huge task with tool-dominated content', () => {
            const skeleton = makeSkeleton({
                taskId: 'test-task',
                messageCount: 15000,
                actionCount: 14500,
                totalSize: 200 * 1024 * 1024,
            });
            const result = filter.isNoiseTask(skeleton);
            expect(result.isNoise).toBe(true);
            expect(result.pattern).toBe('runaway-spiral');
        });

        it('matches massive size with tool dominance', () => {
            const skeleton = makeSkeleton({
                taskId: 'test-task',
                messageCount: 5000,
                actionCount: 4800,
                totalSize: 500 * 1024 * 1024,
            });
            const result = filter.isNoiseTask(skeleton);
            expect(result.isNoise).toBe(true);
            expect(result.pattern).toBe('runaway-spiral');
        });

        it('does not match huge task with balanced conversation', () => {
            const skeleton = makeSkeleton({
                taskId: 'test-task',
                messageCount: 15000,
                actionCount: 5000, // ratio = 0.33, well below 0.85
                totalSize: 200 * 1024 * 1024,
            });
            const result = filter.isNoiseTask(skeleton);
            expect(result.isNoise).toBe(false);
        });

        it('does not match small tool-dominated tasks', () => {
            const skeleton = makeSkeleton({
                taskId: 'test-task',
                messageCount: 100,
                actionCount: 95,
                totalSize: 50000,
            });
            const result = filter.isNoiseTask(skeleton);
            expect(result.isNoise).toBe(false);
        });
    });

    describe('cold-orphan pattern', () => {
        it('matches old tiny orphan tasks', () => {
            const skeleton = makeSkeleton({
                taskId: 'test-task',
                lastActivity: makeOldDate(200),
                messageCount: 2,
            });
            const result = filter.isNoiseTask(skeleton);
            expect(result.isNoise).toBe(true);
            expect(result.pattern).toBe('cold-orphan');
        });

        it('does not match old tasks with parent', () => {
            const skeleton = makeSkeleton({
                taskId: 'test-task',
                parentTaskId: 'parent-task-001',
                lastActivity: makeOldDate(200),
                messageCount: 2,
            });
            const result = filter.isNoiseTask(skeleton);
            expect(result.isNoise).toBe(false);
        });

        it('does not match recent orphan tasks', () => {
            const skeleton = makeSkeleton({
                taskId: 'test-task',
                lastActivity: makeOldDate(30),
                messageCount: 2,
            });
            const result = filter.isNoiseTask(skeleton);
            expect(result.isNoise).toBe(false);
        });

        it('does not match old tasks with substantial content', () => {
            const skeleton = makeSkeleton({
                taskId: 'test-task',
                lastActivity: makeOldDate(200),
                messageCount: 50,
            });
            const result = filter.isNoiseTask(skeleton);
            expect(result.isNoise).toBe(false);
        });
    });

    describe('normal tasks (not noise)', () => {
        it('passes typical interactive task', () => {
            const skeleton = makeSkeleton({
                taskId: 'test-task',
                mode: 'code',
                messageCount: 100,
                actionCount: 40,
                totalSize: 50000,
            });
            const result = filter.isNoiseTask(skeleton);
            expect(result.isNoise).toBe(false);
        });

        it('passes recent scheduled task with few messages', () => {
            const skeleton = makeSkeleton({
                taskId: 'test-task',
                mode: 'scheduled',
                messageCount: 20,
                lastActivity: makeOldDate(5),
            });
            const result = filter.isNoiseTask(skeleton);
            expect(result.isNoise).toBe(false);
        });

        it('passes large interactive conversation', () => {
            const skeleton = makeSkeleton({
                taskId: 'test-task',
                mode: 'code',
                messageCount: 8000,
                actionCount: 3000, // ratio = 0.375
                totalSize: 80 * 1024 * 1024,
            });
            const result = filter.isNoiseTask(skeleton);
            expect(result.isNoise).toBe(false);
        });
    });

    describe('edge cases', () => {
        it('handles skeleton with no metadata gracefully', () => {
            const skeleton: SkeletonHeader = {
                taskId: 'test-task',
                metadata: undefined as any,
            };
            const result = filter.isNoiseTask(skeleton);
            expect(result.isNoise).toBe(false);
        });

        it('handles zero messageCount', () => {
            const skeleton = makeSkeleton({
                taskId: 'test-task',
                messageCount: 0,
                actionCount: 0,
            });
            const result = filter.isNoiseTask(skeleton);
            expect(result.isNoise).toBe(false);
        });

        it('FORCE_REINDEX bypasses noise filter via IndexingDecisionService', async () => {
            // Import dynamically to avoid env pollution
            const orig = process.env.ROO_INDEX_FORCE;
            process.env.ROO_INDEX_FORCE = '1';
            const { IndexingDecisionService } = await import('../indexing-decision.js');
            const service = new IndexingDecisionService();
            service.noiseFilter.loadBlacklist(['test-task']);

            const skeleton = makeSkeleton({ taskId: 'test-task', mode: 'scheduled', lastActivity: makeOldDate(60), messageCount: 500 });
            const decision = service.shouldIndex(skeleton);
            expect(decision.shouldIndex).toBe(true);
            expect(decision.reason).toContain('FORCE_REINDEX');

            process.env.ROO_INDEX_FORCE = orig;
        });
    });
});
