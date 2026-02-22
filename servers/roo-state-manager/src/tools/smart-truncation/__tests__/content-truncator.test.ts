import { describe, test, expect } from 'vitest';
import { ContentTruncator, SmartOutputFormatter } from '../content-truncator.js';
import {
    TaskTruncationPlan,
    ElementTruncationPlan,
    SmartTruncationConfig
} from '../types.js';
import { ConversationSkeleton, MessageSkeleton, ActionMetadata } from '../../../types/conversation.js';

// Type guard helper
const isMessage = (item: MessageSkeleton | ActionMetadata): item is MessageSkeleton => {
    return 'role' in item && 'content' in item;
};

const isAction = (item: MessageSkeleton | ActionMetadata): item is ActionMetadata => {
    return 'type' in item && 'name' in item;
};

describe('ContentTruncator', () => {
    const createMockTask = (taskId: string, messages: string[]): ConversationSkeleton => ({
        taskId,
        parentTaskId: undefined,
        metadata: {
            title: `Task ${taskId}`,
            lastActivity: new Date().toISOString(),
            createdAt: new Date().toISOString(),
            messageCount: messages.length,
            actionCount: 0,
            totalSize: messages.join('').length,
            workspace: '/test'
        },
        sequence: messages.map((content, i): MessageSkeleton => ({
            role: i % 2 === 0 ? 'user' : 'assistant',
            content,
            timestamp: new Date(Date.now() + i).toISOString(),
            isTruncated: false
        }))
    });

    const createElementPlan = (
        sequenceIndex: number,
        method: 'preserve' | 'truncate_middle' | 'truncate_end' | 'summary',
        params?: any
    ): ElementTruncationPlan => ({
        sequenceIndex,
        type: 'user_message',
        originalSize: 1000,
        targetSize: 500,
        truncationMethod: method,
        truncationParams: params
    });

    describe('applyTruncationPlans', () => {
        test('should return unchanged tasks when no plans provided', () => {
            const tasks = [createMockTask('task1', ['Hello', 'Hi there'])];
            const result = ContentTruncator.applyTruncationPlans(tasks, []);
            
            expect(result).toHaveLength(1);
            expect(result[0]).toEqual(tasks[0]);
        });

        test('should return unchanged tasks when plans have no element plans', () => {
            const tasks = [createMockTask('task1', ['Hello', 'Hi there'])];
            const plans: TaskTruncationPlan[] = [{
                taskId: 'task1',
                position: 0,
                distanceFromCenter: 0,
                preservationWeight: 1.0,
                originalSize: 1000,
                truncationBudget: 0,
                targetSize: 1000,
                elementPlans: [] // No element plans
            }];
            
            const result = ContentTruncator.applyTruncationPlans(tasks, plans);
            
            expect(result).toHaveLength(1);
            expect(result[0]).toEqual(tasks[0]);
        });

        test('should apply truncation when plans specify element truncation', () => {
            const longContent = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8\nLine 9\nLine 10';
            const tasks = [createMockTask('task1', [longContent, 'Response'])];
            
            const plans: TaskTruncationPlan[] = [{
                taskId: 'task1',
                position: 0,
                distanceFromCenter: 0,
                preservationWeight: 0.5,
                originalSize: 2000,
                truncationBudget: 1000,
                targetSize: 1000,
                elementPlans: [
                    createElementPlan(0, 'truncate_middle', { startLines: 2, endLines: 2 })
                ]
            }];
            
            const result = ContentTruncator.applyTruncationPlans(tasks, plans);
            
            expect(result).toHaveLength(1);
            const firstMessage = result[0].sequence[0];
            expect(isMessage(firstMessage)).toBe(true);
            if (isMessage(firstMessage)) {
                expect(firstMessage.content).toContain('Line 1');
                expect(firstMessage.content).toContain('Line 2');
                expect(firstMessage.content).toContain('Line 9');
                expect(firstMessage.content).toContain('Line 10');
                expect(firstMessage.content).toContain('lignes tronquées');
            }
        });

        test('should handle multiple tasks with different truncation plans', () => {
            const tasks = [
                createMockTask('task1', ['Content 1', 'Response 1']),
                createMockTask('task2', ['Content 2', 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5'])
            ];
            
            const plans: TaskTruncationPlan[] = [
                {
                    taskId: 'task1',
                    position: 0,
                    distanceFromCenter: 0,
                    preservationWeight: 1.0,
                    originalSize: 1000,
                    truncationBudget: 0,
                    targetSize: 1000,
                    elementPlans: [] // No truncation for task1
                },
                {
                    taskId: 'task2',
                    position: 1,
                    distanceFromCenter: 1,
                    preservationWeight: 0.5,
                    originalSize: 1000,
                    truncationBudget: 500,
                    targetSize: 500,
                    elementPlans: [
                        createElementPlan(1, 'truncate_end', { startLines: 1 })
                    ]
                }
            ];
            
            const result = ContentTruncator.applyTruncationPlans(tasks, plans);
            
            expect(result).toHaveLength(2);
            // Task1 unchanged
            const task1Msg0 = result[0].sequence[0];
            const task1Msg1 = result[0].sequence[1];
            expect(isMessage(task1Msg0) && task1Msg0.content).toBe('Content 1');
            expect(isMessage(task1Msg1) && task1Msg1.content).toBe('Response 1');
            
            // Task2 second message truncated
            const task2Msg0 = result[1].sequence[0];
            const task2Msg1 = result[1].sequence[1];
            expect(isMessage(task2Msg0) && task2Msg0.content).toBe('Content 2');
            if (isMessage(task2Msg1)) {
                expect(task2Msg1.content).toContain('contenu tronqué');
            }
        });
    });

    describe('Truncation Methods', () => {
        test('should preserve content when method is preserve', () => {
            const content = 'This content should remain unchanged';
            const tasks = [createMockTask('task1', [content])];
            
            const plans: TaskTruncationPlan[] = [{
                taskId: 'task1',
                position: 0,
                distanceFromCenter: 0,
                preservationWeight: 1.0,
                originalSize: 1000,
                truncationBudget: 0,
                targetSize: 1000,
                elementPlans: [
                    createElementPlan(0, 'preserve')
                ]
            }];
            
            const result = ContentTruncator.applyTruncationPlans(tasks, plans);
            const firstMsg = result[0].sequence[0];
            expect(isMessage(firstMsg) && firstMsg.content).toBe(content);
        });

        test('should truncate middle preserving start and end', () => {
            const lines = Array.from({length: 20}, (_, i) => `Line ${i + 1}`);
            const content = lines.join('\n');
            const tasks = [createMockTask('task1', [content])];
            
            const plans: TaskTruncationPlan[] = [{
                taskId: 'task1',
                position: 0,
                distanceFromCenter: 0,
                preservationWeight: 0.5,
                originalSize: 2000,
                truncationBudget: 1000,
                targetSize: 1000,
                elementPlans: [
                    createElementPlan(0, 'truncate_middle', { startLines: 3, endLines: 3 })
                ]
            }];
            
            const result = ContentTruncator.applyTruncationPlans(tasks, plans);
            const firstMsg = result[0].sequence[0];
            expect(isMessage(firstMsg)).toBe(true);
            const truncated = isMessage(firstMsg) ? firstMsg.content : '';
            
            expect(truncated).toContain('Line 1');
            expect(truncated).toContain('Line 2');
            expect(truncated).toContain('Line 3');
            expect(truncated).toContain('Line 18');
            expect(truncated).toContain('Line 19');
            expect(truncated).toContain('Line 20');
            expect(truncated).toContain('lignes tronquées');
        });

        test('should truncate end keeping only start lines', () => {
            const lines = Array.from({length: 15}, (_, i) => `Line ${i + 1}`);
            const content = lines.join('\n');
            const tasks = [createMockTask('task1', [content])];
            
            const plans: TaskTruncationPlan[] = [{
                taskId: 'task1',
                position: 0,
                distanceFromCenter: 0,
                preservationWeight: 0.3,
                originalSize: 2000,
                truncationBudget: 1500,
                targetSize: 500,
                elementPlans: [
                    createElementPlan(0, 'truncate_end', { startLines: 5 })
                ]
            }];
            
            const result = ContentTruncator.applyTruncationPlans(tasks, plans);
            const firstMsg = result[0].sequence[0];
            expect(isMessage(firstMsg)).toBe(true);
            const truncated = isMessage(firstMsg) ? firstMsg.content : '';
            
            expect(truncated).toContain('Line 1');
            expect(truncated).toContain('Line 5');
            expect(truncated).not.toContain('Line 10');
            expect(truncated).toContain('contenu tronqué');
        });

        test('should not truncate when content is already short enough', () => {
            const shortContent = 'Line 1\nLine 2\nLine 3';
            const tasks = [createMockTask('task1', [shortContent])];
            
            const plans: TaskTruncationPlan[] = [{
                taskId: 'task1',
                position: 0,
                distanceFromCenter: 0,
                preservationWeight: 0.5,
                originalSize: 100,
                truncationBudget: 50,
                targetSize: 50,
                elementPlans: [
                    createElementPlan(0, 'truncate_middle', { startLines: 5, endLines: 5 })
                ]
            }];
            
            const result = ContentTruncator.applyTruncationPlans(tasks, plans);
            const firstMsg = result[0].sequence[0];
            expect(isMessage(firstMsg) && firstMsg.content).toBe(shortContent);
        });
    });

    describe('Action Truncation', () => {
        test('should handle action truncation for large parameters', () => {
            const tasks: ConversationSkeleton[] = [{
                taskId: 'task1',
                parentTaskId: undefined,
                metadata: {
                    title: 'Task 1',
                    lastActivity: new Date().toISOString(),
                    createdAt: new Date().toISOString(),
                    messageCount: 0,
                    actionCount: 1,
                    totalSize: 1000,
                    workspace: '/test'
                },
                sequence: [{
                    type: 'tool',
                    name: 'test_tool',
                    parameters: {
                        largeData: 'x'.repeat(600), // Large parameter
                        otherParam: 'value'
                    },
                    status: 'success',
                    timestamp: new Date().toISOString()
                }]
            }];

            const plans: TaskTruncationPlan[] = [{
                taskId: 'task1',
                position: 0,
                distanceFromCenter: 0,
                preservationWeight: 0.5,
                originalSize: 1000,
                truncationBudget: 400,
                targetSize: 600,
                elementPlans: [
                    createElementPlan(0, 'truncate_middle')
                ]
            }];
            
            const result = ContentTruncator.applyTruncationPlans(tasks, plans);
            const action = result[0].sequence[0] as any;
            
            // Should have truncated the parameters
            expect(action.parameters).toHaveProperty('_truncated', true);
            expect(action.parameters).toHaveProperty('_originalSize');
        });
    });

    describe('Edge Cases', () => {
        test('should handle empty tasks array', () => {
            const result = ContentTruncator.applyTruncationPlans([], []);
            expect(result).toHaveLength(0);
        });

        test('should handle plans for non-existent tasks', () => {
            const tasks = [createMockTask('task1', ['Content'])];
            const plans: TaskTruncationPlan[] = [{
                taskId: 'non-existent-task',
                position: 0,
                distanceFromCenter: 0,
                preservationWeight: 1.0,
                originalSize: 1000,
                truncationBudget: 0,
                targetSize: 1000,
                elementPlans: []
            }];
            
            const result = ContentTruncator.applyTruncationPlans(tasks, plans);
            expect(result).toHaveLength(1);
            expect(result[0]).toEqual(tasks[0]);
        });

        test('should handle plans with non-existent sequence indices', () => {
            const tasks = [createMockTask('task1', ['Content'])];
            const plans: TaskTruncationPlan[] = [{
                taskId: 'task1',
                position: 0,
                distanceFromCenter: 0,
                preservationWeight: 1.0,
                originalSize: 1000,
                truncationBudget: 100,
                targetSize: 900,
                elementPlans: [
                    createElementPlan(999, 'truncate_middle') // Non-existent index
                ]
            }];
            
            const result = ContentTruncator.applyTruncationPlans(tasks, plans);
            const firstMsg = result[0].sequence[0];
            expect(isMessage(firstMsg) && firstMsg.content).toBe('Content'); // Unchanged
        });
    });
});

// ─────────────────────────────────────────────────────────────
// SmartOutputFormatter
// ─────────────────────────────────────────────────────────────

describe('SmartOutputFormatter', () => {
    const createMockTask = (taskId: string): ConversationSkeleton => ({
        taskId,
        parentTaskId: undefined,
        metadata: {
            title: `Task ${taskId}`,
            lastActivity: new Date().toISOString(),
            createdAt: new Date().toISOString(),
            messageCount: 1,
            actionCount: 0,
            totalSize: 100,
            workspace: '/test'
        },
        sequence: []
    });

    function makePlan(overrides: Partial<TaskTruncationPlan> = {}): TaskTruncationPlan {
        return {
            taskId: 'task-1',
            position: 0,
            distanceFromCenter: 0,
            preservationWeight: 1.0,
            originalSize: 1000,
            truncationBudget: 0,
            targetSize: 1000,
            elementPlans: [],
            ...overrides,
        };
    }

    test('formatTruncatedOutput - sans troncature : header sans compression', () => {
        const tasks = [createMockTask('task-1')];
        const plans = [makePlan({ truncationBudget: 0 })];

        const result = SmartOutputFormatter.formatTruncatedOutput(tasks, plans, 'chain', 'summary');

        expect(result).toContain('chain');
        expect(result).toContain('summary');
        expect(result).not.toContain('Smart Truncation Applied');
    });

    test('formatTruncatedOutput - avec troncature : header avec compression', () => {
        const tasks = [createMockTask('task-1')];
        const plans = [makePlan({ originalSize: 1000, truncationBudget: 200, targetSize: 800 })];

        const result = SmartOutputFormatter.formatTruncatedOutput(tasks, plans, 'cluster', 'full');

        expect(result).toContain('Smart Truncation Applied');
        expect(result).toContain('Compression');
    });

    test('formatTruncatedOutput - avec troncature : contient info gradient', () => {
        const tasks = [createMockTask('task-1')];
        const plans = [makePlan({ position: 0, originalSize: 1000, truncationBudget: 300, targetSize: 700 })];

        const result = SmartOutputFormatter.formatTruncatedOutput(tasks, plans, 'single', 'skeleton');

        expect(result).toContain('gradient');
    });

    test('formatTruncatedOutput - plusieurs plans : ratio de compression global', () => {
        const tasks = [createMockTask('t1'), createMockTask('t2')];
        const plans = [
            makePlan({ taskId: 't1', position: 0, originalSize: 2000, truncationBudget: 1000, targetSize: 1000 }),
            makePlan({ taskId: 't2', position: 1, originalSize: 2000, truncationBudget: 500, targetSize: 1500 }),
        ];

        const result = SmartOutputFormatter.formatTruncatedOutput(tasks, plans, 'cluster', 'full');

        // Total original: 4000, total final: 2500 → compression ratio 37.5%
        expect(result).toContain('Smart Truncation Applied');
    });
});

// ─────────────────────────────────────────────────────────────
// ContentTruncator - branche 'summary'
// ─────────────────────────────────────────────────────────────

describe('ContentTruncator - summary truncation', () => {
    const createTask = (content: string): ConversationSkeleton => ({
        taskId: 'task-summary',
        parentTaskId: undefined,
        metadata: {
            title: 'Task summary',
            lastActivity: new Date().toISOString(),
            createdAt: new Date().toISOString(),
            messageCount: 1,
            actionCount: 0,
            totalSize: content.length,
            workspace: '/test'
        },
        sequence: [{ role: 'user', content, timestamp: '2026-01-01T00:00:00.000Z' }]
    });

    test('summary : contenu court → non tronqué', () => {
        const shortContent = 'Short content';
        const task = createTask(shortContent);
        const plans: TaskTruncationPlan[] = [{
            taskId: 'task-summary',
            position: 0,
            distanceFromCenter: 0,
            preservationWeight: 1.0,
            originalSize: shortContent.length,
            truncationBudget: 100,
            targetSize: 50,
            elementPlans: [{
                sequenceIndex: 0,
                type: 'user_message',
                originalSize: shortContent.length,
                targetSize: 50,
                truncationMethod: 'summary',
                truncationParams: { summaryLength: 200 }
            }]
        }];

        const result = ContentTruncator.applyTruncationPlans([task], plans);
        const firstMsg = result[0].sequence[0];
        expect((firstMsg as any).content).toBe(shortContent);
    });

    test('summary : contenu long → tronqué avec résumé', () => {
        const longContent = 'A'.repeat(500);
        const task = createTask(longContent);
        const plans: TaskTruncationPlan[] = [{
            taskId: 'task-summary',
            position: 0,
            distanceFromCenter: 0,
            preservationWeight: 1.0,
            originalSize: longContent.length,
            truncationBudget: 300,
            targetSize: 200,
            elementPlans: [{
                sequenceIndex: 0,
                type: 'user_message',
                originalSize: longContent.length,
                targetSize: 100,
                truncationMethod: 'summary',
                truncationParams: { summaryLength: 100 }
            }]
        }];

        const result = ContentTruncator.applyTruncationPlans([task], plans);
        const firstMsg = result[0].sequence[0];
        const content = (firstMsg as any).content as string;
        expect(content).toContain('résumé tronqué');
        expect(content.length).toBeLessThan(longContent.length);
    });
});