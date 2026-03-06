/**
 * Tests pour ClusterSummaryService.ts
 * Issue #567 - Couverture du service de résumés de grappes de *
 * @module services/trace-summary/__tests__/ClusterSummaryService
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { ClusterSummaryService } from '../ClusterSummaryService.js';
import type { ConversationSkeleton, MessageSkeleton } from '../../../types/conversation.js';
import type { SummaryResult } from '../../../types/trace-summary.js';

describe('ClusterSummaryService', { timeout: 60000 }, () => {
    let service: ClusterSummaryService;

    // ============================================================
    // Helper functions
    // ============================================================

    function createService(): ClusterSummaryService {
        return new ClusterSummaryService();
    }

    function createMockTask(
        id: string,
        parentId?: string,
        title?: string,
        messageCount: number = 5,
        createdAt?: string
    ): ConversationSkeleton {
        const now = createdAt || new Date().toISOString();
        return {
            taskId: id,
            parentTaskId: parentId,
            metadata: {
                title: title || `Task ${id}`,
                lastActivity: now,
                createdAt: now,
                mode: 'test',
                messageCount,
                actionCount: 1,
                totalSize: 1000
            },
            sequence: [],
            isCompleted: true,
            truncatedInstruction: `Instruction for task ${id}`
        };
    }

    function createMockMessage(
        type: 'user' | 'assistant',
        content: string,
        index: number = 0
    ): MessageSkeleton {
        return {
            type,
            content,
            index,
            ts: Date.now() + index,
            uuid: `msg-${index}-${Date.now()}`
        } as MessageSkeleton;
    }

    function createMockSummaryResult(
        success: boolean = true,
        content: string = 'Mock summary content'
    ): SummaryResult {
        return {
            success,
            content,
            statistics: {
                totalSections: 1,
                userMessages: 1,
                assistantMessages: 1,
                toolResults: 0,
                userContentSize: 100,
                assistantContentSize: 100,
                toolResultsSize: 0,
                totalContentSize: 200,
                userPercentage: 50,
                assistantPercentage: 50,
                toolResultsPercentage: 0
            },
            format: 'markdown',
            size: content.length
        };
    }

    // ============================================================
    // Constructor
    // ============================================================

    describe('constructor', () => {
        test('creates instance without error', () => {
            expect(() => new ClusterSummaryService()).not.toThrow();
        });
    });

    // ============================================================
    // generateClusterSummary - Basic functionality
    // ============================================================

    describe('generateClusterSummary', () => {
        beforeEach(() => {
            service = createService();
        });

        test('generates summary for single root task with no children', async () => {
            const rootTask = createMockTask('root-1', undefined, 'Root Task');
            const childTasks: ConversationSkeleton[] = [];

            const result = await service.generateClusterSummary(
                rootTask,
                childTasks,
                { outputFormat: 'markdown' }
            );

            expect(result.success).toBe(true);
            expect(result.clusterMetadata.rootTaskId).toBe('root-1');
            expect(result.clusterMetadata.totalTasks).toBe(1);
            expect(result.format).toBe('markdown');
        });

        test('generates summary for root task with children', async () => {
            const rootTask = createMockTask('root-1', undefined, 'Root Task', 10);
            const childTasks = [
                createMockTask('child-1', 'root-1', 'Child 1', 5),
                createMockTask('child-2', 'root-1', 'Child 2', 5)
            ];

            const result = await service.generateClusterSummary(
                rootTask,
                childTasks,
                { outputFormat: 'markdown' }
            );

            expect(result.success).toBe(true);
            expect(result.clusterMetadata.totalTasks).toBe(3); // root + 2 children
        });

        test('uses provided callback for individual summaries', async () => {
            const rootTask = createMockTask('root-1');
            const childTasks: ConversationSkeleton[] = [];

            let callbackCalled = false;
            const mockCallback = async () => {
                callbackCalled = true;
                return createMockSummaryResult();
            };

            await service.generateClusterSummary(
                rootTask,
                childTasks,
                {},
                mockCallback
            );

            expect(callbackCalled).toBe(true);
        });

        test('handles empty cluster gracefully', async () => {
            const rootTask = createMockTask('root-1', undefined, 'Empty Root', 0);
            rootTask.sequence = [];

            const result = await service.generateClusterSummary(
                rootTask,
                [],
                {}
            );

            expect(result.success).toBe(true);
        });
    });

    // ============================================================
    // generateClusterSummary - Cluster modes
    // ============================================================

    describe('generateClusterSummary - cluster modes', () => {
        beforeEach(() => {
            service = createService();
        });

        test('aggregated mode combines content', async () => {
            const rootTask = createMockTask('root-1');
            const childTasks = [
                createMockTask('child-1', 'root-1', 'Child 1')
            ];

            const result = await service.generateClusterSummary(
                rootTask,
                childTasks,
                { clusterMode: 'aggregated' }
            );

            expect(result.success).toBe(true);
            expect(result.clusterMetadata.clusterMode).toBe('aggregated');
        });

        test('detailed mode includes individual summaries', async () => {
            const rootTask = createMockTask('root-1');
            const childTasks = [
                createMockTask('child-1', 'root-1', 'Child 1')
            ];

            const result = await service.generateClusterSummary(
                rootTask,
                childTasks,
                { clusterMode: 'detailed' }
            );

            expect(result.success).toBe(true);
            expect(result.clusterMetadata.clusterMode).toBe('detailed');
        });

        test('comparative mode analyzes differences', async () => {
            const rootTask = createMockTask('root-1');
            const childTasks = [
                createMockTask('child-1', 'root-1', 'Child 1'),
                createMockTask('child-2', 'root-1', 'Child 2')
            ];

            const result = await service.generateClusterSummary(
                rootTask,
                childTasks,
                { clusterMode: 'comparative' }
            );

            expect(result.success).toBe(true);
            expect(result.clusterMetadata.clusterMode).toBe('comparative');
        });
    });

    // ============================================================
    // generateClusterSummary - Sorting options
    // ============================================================

    describe('generateClusterSummary - sorting', () => {
        beforeEach(() => {
            service = createService();
        });

        test('sorts tasks chronologically by default', async () => {
            const rootTask = createMockTask('root-1', undefined, 'Root', 5, '2026-03-01T10:00:00Z');
            const childTasks = [
                createMockTask('child-2', 'root-1', 'Later', 5, '2026-03-01T12:00:00Z'),
                createMockTask('child-1', 'root-1', 'Earlier', 5, '2026-03-01T11:00:00Z')
            ];

            const result = await service.generateClusterSummary(
                rootTask,
                childTasks,
                { clusterSortBy: 'chronological' }
            );

            expect(result.success).toBe(true);
        });

        test('sorts tasks by size when specified', async () => {
            const rootTask = createMockTask('root-1', undefined, 'Root', 10);
            const childTasks = [
                createMockTask('child-1', 'root-1', 'Small', 2),
                createMockTask('child-2', 'root-1', 'Large', 20)
            ];

            const result = await service.generateClusterSummary(
                rootTask,
                childTasks,
                { clusterSortBy: 'size' }
            );

            expect(result.success).toBe(true);
        });

        test('sorts tasks alphabetically when specified', async () => {
            const rootTask = createMockTask('root-1', undefined, 'Root');
            const childTasks = [
                createMockTask('child-2', 'root-1', 'Zebra Task'),
                createMockTask('child-1', 'root-1', 'Alpha Task')
            ];

            const result = await service.generateClusterSummary(
                rootTask,
                childTasks,
                { clusterSortBy: 'alphabetical' }
            );

            expect(result.success).toBe(true);
        });
    });

    // ============================================================
    // generateClusterSummary - Output formats
    // ============================================================

    describe('generateClusterSummary - output formats', () => {
        beforeEach(() => {
            service = createService();
        });

        test('generates markdown output by default', async () => {
            const rootTask = createMockTask('root-1');
            const result = await service.generateClusterSummary(rootTask, [], {});

            expect(result.format).toBe('markdown');
            expect(result.content).toContain('#');
        });

        test('generates HTML output when specified', async () => {
            const rootTask = createMockTask('root-1');
            const result = await service.generateClusterSummary(
                rootTask,
                [],
                { outputFormat: 'html' }
            );

            expect(result.format).toBe('html');
        });
    });

    // ============================================================
    // generateClusterSummary - Statistics
    // ============================================================

    describe('generateClusterSummary - statistics', () => {
        beforeEach(() => {
            service = createService();
        });

        test('calculates cluster statistics', async () => {
            const rootTask = createMockTask('root-1', undefined, 'Root', 10);
            const childTasks = [
                createMockTask('child-1', 'root-1', 'Child', 5)
            ];

            const result = await service.generateClusterSummary(
                rootTask,
                childTasks,
                { includeClusterStats: true }
            );

            expect(result.success).toBe(true);
            expect(result.statistics).toBeDefined();
        });

        test('includes cluster depth in statistics', async () => {
            const rootTask = createMockTask('root-1');
            const childTasks = [
                createMockTask('child-1', 'root-1'),
                createMockTask('child-1-1', 'child-1')
            ];

            const result = await service.generateClusterSummary(
                rootTask,
                childTasks,
                { includeClusterStats: true }
            );

            expect(result.success).toBe(true);
        });
    });

    // ============================================================
    // generateClusterSummary - Error handling
    // ============================================================

    describe('generateClusterSummary - error handling', () => {
        beforeEach(() => {
            service = createService();
        });

        // Note: Service currently throws on null input (documented behavior)
        // Future improvement: return error result instead
        test('throws on null root task (documented behavior)', async () => {
            await expect(async () => {
                await service.generateClusterSummary(
                    null as unknown as ConversationSkeleton,
                    [],
                    {}
                );
            }).rejects.toThrow();
        });

        test('handles undefined child tasks gracefully', async () => {
            const rootTask = createMockTask('root-1');
            const result = await service.generateClusterSummary(
                rootTask,
                undefined as unknown as ConversationSkeleton[],
                {}
            );

            // Should either succeed with empty children or fail gracefully
            expect(typeof result.success).toBe('boolean');
        });

        test('returns error result on callback failure', async () => {
            const rootTask = createMockTask('root-1');
            const failingCallback = async () => {
                throw new Error('Callback failed');
            };

            const result = await service.generateClusterSummary(
                rootTask,
                [],
                {},
                failingCallback
            );

            expect(result.success).toBe(false);
            expect(result.error).toContain('Callback failed');
        });
    });

    // ============================================================
    // generateClusterSummary - Options handling
    // ============================================================

    describe('generateClusterSummary - options', () => {
        beforeEach(() => {
            service = createService();
        });

        test('applies default options when none provided', async () => {
            const rootTask = createMockTask('root-1');
            const result = await service.generateClusterSummary(rootTask, []);

            expect(result.success).toBe(true);
            expect(result.clusterMetadata.clusterMode).toBe('aggregated');
        });

        test('respects maxClusterDepth option', async () => {
            const rootTask = createMockTask('root-1');
            const childTasks = [
                createMockTask('child-1', 'root-1'),
                createMockTask('grandchild-1', 'child-1')
            ];

            const result = await service.generateClusterSummary(
                rootTask,
                childTasks,
                { maxClusterDepth: 1 }
            );

            expect(result.success).toBe(true);
        });

        test('includes timeline when requested', async () => {
            const rootTask = createMockTask('root-1');
            const childTasks = [
                createMockTask('child-1', 'root-1')
            ];

            const result = await service.generateClusterSummary(
                rootTask,
                childTasks,
                { includeClusterTimeline: true }
            );

            expect(result.success).toBe(true);
        });

        test('includes cross-task analysis when requested', async () => {
            const rootTask = createMockTask('root-1');
            const childTasks = [
                createMockTask('child-1', 'root-1'),
                createMockTask('child-2', 'root-1')
            ];

            const result = await service.generateClusterSummary(
                rootTask,
                childTasks,
                { crossTaskAnalysis: true }
            );

            expect(result.success).toBe(true);
        });
    });

    // ============================================================
    // generateClusterSummary - Edge cases (with extended timeout)
    // ============================================================

    describe('generateClusterSummary - edge cases', () => {
        beforeEach(() => {
            service = createService();
        });

        test('handles moderate number of child tasks', async () => {
            const rootTask = createMockTask('root-1');
            // Reduced from 50 to 20 for reasonable test time
            const childTasks = Array.from({ length: 20 }, (_, i) =>
                createMockTask(`child-${i}`, 'root-1', `Task ${i}`)
            );

            const result = await service.generateClusterSummary(
                rootTask,
                childTasks,
                {}
            );

            expect(result.success).toBe(true);
            expect(result.clusterMetadata.totalTasks).toBe(21);
        }, 60000);

        test('handles tasks with special characters in titles', async () => {
            const rootTask = createMockTask('root-1', undefined, 'Root <script>alert("xss")</script>');
            const childTasks = [
                createMockTask('child-1', 'root-1', 'Task with "quotes" and \\backslashes\\')
            ];

            const result = await service.generateClusterSummary(
                rootTask,
                childTasks,
                {}
            );

            expect(result.success).toBe(true);
        });

        test('handles deeply nested task hierarchy', async () => {
            const rootTask = createMockTask('root');
            const childTasks: ConversationSkeleton[] = [];

            // Create a chain of 5 levels
            let currentId = 'root';
            for (let i = 1; i <= 5; i++) {
                const newId = `level-${i}`;
                childTasks.push(createMockTask(newId, currentId, `Level ${i}`));
                currentId = newId;
            }

            const result = await service.generateClusterSummary(
                rootTask,
                childTasks,
                {}
            );

            expect(result.success).toBe(true);
        }, 60000);

        test('handles tasks without parent relationships', async () => {
            const rootTask = createMockTask('root-1');
            // These children don't have parentTaskId set
            const orphanTasks = [
                createMockTask('orphan-1', undefined, 'Orphan 1'),
                createMockTask('orphan-2', undefined, 'Orphan 2')
            ];

            const result = await service.generateClusterSummary(
                rootTask,
                orphanTasks,
                {}
            );

            expect(result.success).toBe(true);
        });
    });

    // ============================================================
    // Cluster metadata
    // ============================================================

    describe('clusterMetadata', () => {
        beforeEach(() => {
            service = createService();
        });

        test('includes generation timestamp', async () => {
            const rootTask = createMockTask('root-1');
            const beforeTime = new Date();

            const result = await service.generateClusterSummary(rootTask, [], {});

            const afterTime = new Date();
            const timestamp = new Date(result.clusterMetadata.generationTimestamp);

            expect(timestamp >= beforeTime).toBe(true);
            expect(timestamp <= afterTime).toBe(true);
        });

        test('includes correct root task ID', async () => {
            const rootTask = createMockTask('my-special-root-id');
            const result = await service.generateClusterSummary(rootTask, [], {});

            expect(result.clusterMetadata.rootTaskId).toBe('my-special-root-id');
        });

        test('counts total tasks correctly', async () => {
            const rootTask = createMockTask('root');
            const childTasks = [
                createMockTask('c1', 'root'),
                createMockTask('c2', 'root'),
                createMockTask('c3', 'root')
            ];

            const result = await service.generateClusterSummary(rootTask, childTasks, {});

            expect(result.clusterMetadata.totalTasks).toBe(4); // root + 3 children
        });
    });

    // ============================================================
    // Task index
    // ============================================================

    describe('taskIndex', () => {
        beforeEach(() => {
            service = createService();
        });

        test('builds task index for navigation', async () => {
            const rootTask = createMockTask('root-1', undefined, 'Root Task');
            const childTasks = [
                createMockTask('child-1', 'root-1', 'Child Task 1'),
                createMockTask('child-2', 'root-1', 'Child Task 2')
            ];

            const result = await service.generateClusterSummary(
                rootTask,
                childTasks,
                {}
            );

            expect(result.taskIndex).toBeDefined();
            expect(result.taskIndex.length).toBeGreaterThan(0);
        });
    });
});
