import { describe, it, expect, beforeEach, vi } from 'vitest';
import { HierarchyValidator } from '../validate-full-reconstruction.js';
import { ConversationSkeleton } from '../types/conversation.js';
import { HierarchyReconstructionEngine } from '../utils/hierarchy-reconstruction-engine.js';

// Mock dependencies
vi.mock('../utils/hierarchy-reconstruction-engine');
vi.mock('../utils/roo-storage-detector');
vi.mock('../utils/logger', () => ({
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}));
vi.mock('fs/promises', () => ({ default: { readFile: vi.fn(), writeFile: vi.fn(), mkdir: vi.fn(), stat: vi.fn() } }));
vi.mock('path', () => ({ default: { join: vi.fn((...args: string[]) => args.join('/')), resolve: vi.fn() } }));

const MockedEngine = HierarchyReconstructionEngine as any;

function makeSkeleton(taskId: string, parentTaskId?: string, workspace?: string): ConversationSkeleton {
    return {
        taskId,
        parentTaskId,
        metadata: { workspace: workspace ?? '/test/workspace' },
        sequence: []
    } as ConversationSkeleton;
}

describe('HierarchyValidator', () => {
    let validator: HierarchyValidator;
    const mockWorkspace = '/test/workspace';

    beforeEach(() => {
        validator = new HierarchyValidator(mockWorkspace);
        vi.clearAllMocks();
    });

    describe('constructor', () => {
        it('should initialize with workspace and default stats', () => {
            const stats = (validator as any).stats;
            expect(stats.totalTasks).toBe(0);
            expect(stats.rootTasks).toBe(0);
            expect(stats.maxDepth).toBe(0);
            expect(stats.parentChildRelations).toEqual([]);
            expect((validator as any).workspace).toBe(mockWorkspace);
        });
    });

    describe('calculateDepth', () => {
        it('should return 0 for root task', async () => {
            const skeleton = makeSkeleton('task1');
            const all = [skeleton];
            const depth = await (validator as any).calculateDepth(skeleton, all);
            expect(depth).toBe(0);
        });

        it('should calculate depth for a simple parent-child chain', async () => {
            const task1 = makeSkeleton('task1');
            const task2 = makeSkeleton('task2', 'task1');
            const task3 = makeSkeleton('task3', 'task2');
            const depth = await (validator as any).calculateDepth(task3, [task1, task2, task3]);
            expect(depth).toBe(2);
        });

        it('should handle single level parent', async () => {
            const task1 = makeSkeleton('task1');
            const task2 = makeSkeleton('task2', 'task1');
            const depth = await (validator as any).calculateDepth(task2, [task1, task2]);
            expect(depth).toBe(1);
        });

        it('should stop at ROOT sentinel', async () => {
            const task1 = makeSkeleton('task1', 'ROOT');
            const depth = await (validator as any).calculateDepth(task1, [task1]);
            expect(depth).toBe(0);
        });

        it('should handle missing parent gracefully', async () => {
            const task1 = makeSkeleton('task1', 'nonexistent');
            const depth = await (validator as any).calculateDepth(task1, [task1]);
            expect(depth).toBe(1);
        });
    });

    describe('captureInitialState', () => {
        it('should capture skeletons into beforeSkeletons map', async () => {
            const skeletons = [makeSkeleton('t1'), makeSkeleton('t2', 't1')];
            MockedEngine.reconstructHierarchy.mockResolvedValue(skeletons);

            await (validator as any).captureInitialState();

            const before = (validator as any).beforeSkeletons;
            expect(before.size).toBe(2);
            expect(before.has('t1')).toBe(true);
            expect(before.has('t2')).toBe(true);
        });

        it('should continue on error (warn log)', async () => {
            MockedEngine.reconstructHierarchy.mockRejectedValue(new Error('disk error'));

            await (validator as any).captureInitialState();

            expect((validator as any).beforeSkeletons.size).toBe(0);
        });
    });

    describe('analyzeResults', () => {
        it('should count root tasks and tasks with parents', async () => {
            const skeletons = [
                makeSkeleton('t1'),
                makeSkeleton('t2', 't1'),
                makeSkeleton('t3', 't2')
            ];

            await (validator as any).analyzeResults(skeletons);

            const stats = (validator as any).stats;
            expect(stats.totalTasks).toBe(3);
            expect(stats.rootTasks).toBe(1);
            expect(stats.tasksWithParents).toBe(2);
        });

        it('should track parent-child relations for newly discovered links', async () => {
            const skeletons = [
                makeSkeleton('t1'),
                makeSkeleton('t2', 't1')
            ];

            await (validator as any).analyzeResults(skeletons);

            const stats = (validator as any).stats;
            expect(stats.parentChildRelations).toHaveLength(1);
            expect(stats.parentChildRelations[0].parentId).toBe('t1');
            expect(stats.parentChildRelations[0].childId).toBe('t2');
        });

        it('should handle empty skeleton array', async () => {
            await (validator as any).analyzeResults([]);

            const stats = (validator as any).stats;
            expect(stats.totalTasks).toBe(0);
            expect(stats.rootTasks).toBe(0);
            expect(stats.tasksWithParents).toBe(0);
        });
    });
});
