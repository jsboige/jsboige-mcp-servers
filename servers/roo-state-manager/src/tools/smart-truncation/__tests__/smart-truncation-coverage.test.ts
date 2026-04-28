import { describe, test, expect } from 'vitest';
import { SmartTruncationEngine } from '../engine.js';
import { ConversationSkeleton } from '../../../types/conversation.js';

describe('SmartTruncation Coverage Tests', () => {
    const createMockTask = (taskId: string, messageCount: number = 3): ConversationSkeleton => ({
        taskId,
        parentTaskId: undefined,
        metadata: {
            title: `Task ${taskId}`,
            lastActivity: new Date().toISOString(),
            createdAt: new Date().toISOString(),
            messageCount,
            actionCount: 0,
            totalSize: messageCount * 600,
            workspace: '/test'
        },
        sequence: Array(messageCount).fill(null).map((_, i) => ({
            role: i % 2 === 0 ? 'user' as const : 'assistant' as const,
            content: 'x'.repeat(500),
            timestamp: new Date(Date.now() + i).toISOString(),
            isTruncated: false
        }))
    });

    test('should handle exact size limit (no truncation needed)', () => {
        const engine = new SmartTruncationEngine({
            maxOutputLength: 5000,
            gradientStrength: 2.0,
            minPreservationRate: 0.9,
            maxTruncationRate: 0.7
        });

        const tasks = [
            createMockTask('task1', 2),
            createMockTask('task2', 2)
        ];

        // Calculer la taille totale
        const totalSize = tasks.reduce((sum, task) => {
            let size = 200; // header
            task.sequence.forEach(item => {
                size += item.content.length + 100;
            });
            return sum + size;
        }, 0);

        const adjustedEngine = new SmartTruncationEngine({
            maxOutputLength: totalSize,
            gradientStrength: 2.0,
            minPreservationRate: 0.9,
            maxTruncationRate: 0.7
        });

        const result = adjustedEngine.apply(tasks);

        expect(result.metrics.compressionRatio).toBe(0);
        expect(result.taskPlans.every(plan => plan.truncationBudget === 0)).toBe(true);
    });

    test('should handle maximum truncation rate scenario', () => {
        const engine = new SmartTruncationEngine({
            maxOutputLength: 500,
            gradientStrength: 2.0,
            minPreservationRate: 0.9,
            maxTruncationRate: 0.8 // Allow up to 80% truncation
        });

        const tasks = [createMockTask('task1', 5)]; // Large task

        const result = engine.apply(tasks);

        // Vérifier que la troncature respecte le maximum
        if (result.taskPlans.length > 0 && result.taskPlans[0].truncationBudget > 0) {
            const plan = result.taskPlans[0];
            const truncationRate = plan.truncationBudget / plan.originalSize;
            expect(truncationRate).toBeLessThanOrEqual(0.8);
        }
    });

    test('should handle gradient strength of 0 (no gradient)', () => {
        const engine = new SmartTruncationEngine({
            maxOutputLength: 1000,
            gradientStrength: 0.0, // Aucun gradient
            minPreservationRate: 0.9,
            maxTruncationRate: 0.7
        });

        const tasks = [
            createMockTask('task1', 2),
            createMockTask('task2', 2),
            createMockTask('task3', 2)
        ];

        const result = engine.apply(tasks);

        // Avec gradient 0, toutes les tâches devraient avoir des poids similaires
        const weights = result.taskPlans.map(p => p.preservationWeight);
        const maxDiff = Math.max(...weights) - Math.min(...weights);

        // Les poids devraient être très proches (différence < 0.1)
        expect(maxDiff).toBeLessThan(0.1);
    });

    test('should handle large number of tasks with gradient preservation', () => {
        const engine = new SmartTruncationEngine({
            maxOutputLength: 2000,
            gradientStrength: 2.0,
            minPreservationRate: 0.9,
            maxTruncationRate: 0.7
        });

        // Créer 10 tâches
        const tasks = Array.from({ length: 10 }, (_, i) =>
            createMockTask(`task${i + 1}`, 2)
        );

        const result = engine.apply(tasks);

        // Vérifier que les poids de préservation respectent le gradient
        const weights = result.taskPlans.map(p => p.preservationWeight);

        // Le premier et le dernier devraient avoir les poids les plus élevés
        expect(weights[0]).toBeGreaterThan(weights[Math.floor(weights.length / 2)]);
        expect(weights[weights.length - 1]).toBeGreaterThan(weights[Math.floor(weights.length / 2)]);

        // Tous les poids devraient être entre 0 et 1
        weights.forEach(weight => {
            expect(weight).toBeGreaterThanOrEqual(0);
            expect(weight).toBeLessThanOrEqual(1);
        });
    });

    test('should handle tasks with mixed content types', () => {
        const createComplexTask = (taskId: string): ConversationSkeleton => ({
            taskId,
            parentTaskId: undefined,
            metadata: {
                title: `Complex Task ${taskId}`,
                lastActivity: new Date().toISOString(),
                createdAt: new Date().toISOString(),
                messageCount: 3,
                actionCount: 2,
                totalSize: 2000,
                workspace: '/test'
            },
            sequence: [
                {
                    role: 'user',
                    content: 'User message with 200 characters',
                    timestamp: new Date().toISOString(),
                    isTruncated: false
                },
                {
                    type: 'tool',
                    name: 'file_search',
                    parameters: {
                        query: 'test',
                        limit: 10,
                        filter: '*.ts'
                    },
                    status: 'success',
                    timestamp: new Date().toISOString()
                },
                {
                    role: 'assistant',
                    content: 'Assistant response with details about files found',
                    timestamp: new Date().toISOString(),
                    isTruncated: false
                },
                {
                    type: 'tool',
                    name: 'read_file',
                    parameters: {
                        path: '/path/to/file.ts'
                    },
                    status: 'success',
                    timestamp: new Date().toISOString()
                },
                {
                    role: 'user',
                    content: 'Thank you for the information',
                    timestamp: new Date().toISOString(),
                    isTruncated: false
                }
            ]
        });

        const engine = new SmartTruncationEngine({
            maxOutputLength: 1500, // Force troncature
            gradientStrength: 2.0,
            minPreservationRate: 0.9,
            maxTruncationRate: 0.7
        });

        const tasks = [createComplexTask('complex1')];
        const result = engine.apply(tasks);

        expect(result.taskPlans).toHaveLength(1);
        expect(result.metrics.totalTasks).toBe(1);

        // Vérifier que le budget de troncature est calculé
        const plan = result.taskPlans[0];
        expect(plan.originalSize).toBeGreaterThan(0);
        expect(plan.targetSize).toBeGreaterThan(0);

        // Avec une limite stricte, il devrait y avoir de la troncature (ou pas si la taille est déjà ok)
        if (plan.originalSize > 1500) {
            expect(plan.targetSize).toBeLessThan(plan.originalSize);
        }
    });

    test('should handle edge case with zero messageCount', () => {
        const engine = new SmartTruncationEngine({
            maxOutputLength: 1000,
            gradientStrength: 2.0,
            minPreservationRate: 0.9,
            maxTruncationRate: 0.7
        });

        const taskWithNoMessages: ConversationSkeleton = {
            taskId: 'empty-messages',
            parentTaskId: undefined,
            metadata: {
                title: 'Task with no messages',
                lastActivity: new Date().toISOString(),
                createdAt: new Date().toISOString(),
                messageCount: 0,
                actionCount: 1,
                totalSize: 150,
                workspace: '/test'
            },
            sequence: [
                {
                    type: 'tool',
                    name: 'simple_action',
                    parameters: {},
                    status: 'success',
                    timestamp: new Date().toISOString()
                }
            ]
        };

        const result = engine.apply([taskWithNoMessages]);

        expect(result.taskPlans).toHaveLength(1);
        expect(result.metrics.totalTasks).toBe(1);
        expect(result.metrics.originalTotalSize).toBeGreaterThan(0);
    });
});