import { describe, test, expect } from 'vitest';
import { SmartTruncationEngine } from '../engine.js';
import { 
    SmartTruncationConfig,
    SmartTruncationResult 
} from '../types.js';
import { ConversationSkeleton } from '../../../types/conversation.js';

describe('SmartTruncation Engine', () => {
    const mockConfig: Partial<SmartTruncationConfig> = {
        maxOutputLength: 5000,
        gradientStrength: 2.0,
        minPreservationRate: 0.9,
        maxTruncationRate: 0.6,
        contentPriority: {
            userMessages: 1.0,
            assistantMessages: 0.8,
            actions: 0.6,
            metadata: 0.4
        }
    };

    const createMockTask = (taskId: string, messageCount: number = 3): ConversationSkeleton => ({
        taskId,
        parentTaskId: undefined,
        metadata: {
            title: `Task ${taskId}`,
            lastActivity: new Date().toISOString(),
            createdAt: new Date().toISOString(),
            messageCount,
            actionCount: 0,
            totalSize: messageCount * 600, // Approximation
            workspace: '/test'
        },
        sequence: Array(messageCount).fill(null).map((_, i) => ({
            role: i % 2 === 0 ? 'user' as const : 'assistant' as const,
            content: 'x'.repeat(500), // 500 chars par message
            timestamp: new Date(Date.now() + i).toISOString(),
            isTruncated: false
        }))
    });

    describe('SmartTruncationEngine', () => {
        test('should initialize with default config', () => {
            const engine = new SmartTruncationEngine();
            expect(engine).toBeDefined();
        });

        test('should initialize with custom config', () => {
            const engine = new SmartTruncationEngine(mockConfig);
            expect(engine).toBeDefined();
        });

        test('should handle empty task list', () => {
            const engine = new SmartTruncationEngine(mockConfig);
            const result = engine.apply([]);
            
            expect(result.taskPlans).toHaveLength(0);
            expect(result.metrics.totalTasks).toBe(0);
            expect(result.metrics.originalTotalSize).toBe(0);
            expect(result.metrics.finalTotalSize).toBe(0);
            expect(result.metrics.compressionRatio).toBe(0);
        });

        test('should handle single task within limits', () => {
            const engine = new SmartTruncationEngine({
                ...mockConfig,
                maxOutputLength: 2000 // Assez grand pour une tâche
            });
            const tasks = [createMockTask('task1', 2)];
            const result = engine.apply(tasks);
            
            expect(result.taskPlans).toHaveLength(1);
            expect(result.taskPlans[0].truncationBudget).toBe(0); // Pas de troncature nécessaire
            expect(result.metrics.compressionRatio).toBe(0);
        });

        test('should apply truncation when exceeding limits', () => {
            const engine = new SmartTruncationEngine({
                ...mockConfig,
                maxOutputLength: 1000 // Petit pour forcer la troncature
            });
            const tasks = [
                createMockTask('task1', 3),
                createMockTask('task2', 3),
                createMockTask('task3', 3)
            ];
            const result = engine.apply(tasks);
            
            expect(result.taskPlans).toHaveLength(3);
            expect(result.metrics.originalTotalSize).toBeGreaterThan(result.metrics.finalTotalSize);
            expect(result.metrics.compressionRatio).toBeGreaterThan(0);
        });

        test('should preserve first and last tasks more than middle ones', () => {
            const engine = new SmartTruncationEngine({
                ...mockConfig,
                maxOutputLength: 2000 // Force troncature
            });
            const tasks = [
                createMockTask('task1', 3), // Premier - doit être préservé
                createMockTask('task2', 3), // Milieu - peut être tronqué
                createMockTask('task3', 3), // Milieu - peut être tronqué
                createMockTask('task4', 3), // Milieu - peut être tronqué
                createMockTask('task5', 3)  // Dernier - doit être préservé
            ];
            const result = engine.apply(tasks);
            
            expect(result.taskPlans).toHaveLength(5);
            
            // Premier et dernier doivent avoir plus de préservation
            const firstPlan = result.taskPlans[0];
            const lastPlan = result.taskPlans[4];
            const middlePlan = result.taskPlans[2]; // Tâche du milieu
            
            expect(firstPlan.preservationWeight).toBeGreaterThan(middlePlan.preservationWeight);
            expect(lastPlan.preservationWeight).toBeGreaterThan(middlePlan.preservationWeight);
        });

        test('should respect maxTruncationRate', () => {
            const engine = new SmartTruncationEngine({
                ...mockConfig,
                maxOutputLength: 1000,
                maxTruncationRate: 0.5
            });
            const tasks = [createMockTask('task1', 5)];
            const result = engine.apply(tasks);

            if (result.taskPlans.length > 0 && result.taskPlans[0].truncationBudget > 0) {
                const plan = result.taskPlans[0];
                const truncationRate = plan.truncationBudget / plan.originalSize;

                // FIX P0-1b follow-up: minPreservationRate contrainte retirée (contradictoire)
                // Seule maxTruncationRate s'applique maintenant, gradient gère la préservation
                expect(truncationRate).toBeLessThanOrEqual(0.5);
            }
        });

        test('should include diagnostics', () => {
            const engine = new SmartTruncationEngine(mockConfig);
            const tasks = [createMockTask('task1', 2)];
            const result = engine.apply(tasks);
            
            expect(result.diagnostics).toBeDefined();
            expect(result.diagnostics.length).toBeGreaterThan(0);
            expect(result.diagnostics[0]).toContain('Taille totale');
        });

        test('should handle complex task scenarios', () => {
            const engine = new SmartTruncationEngine({
                ...mockConfig,
                maxOutputLength: 3000
            });
            
            // Créer une séquence de tâches avec tailles variées
            const tasks = [
                createMockTask('small1', 1),    // Petite
                createMockTask('large2', 10),   // Grande
                createMockTask('medium3', 5),   // Moyenne
                createMockTask('large4', 10),   // Grande
                createMockTask('small5', 1)     // Petite
            ];
            
            const result = engine.apply(tasks);
            
            expect(result.taskPlans).toHaveLength(5);
            expect(result.metrics.totalTasks).toBe(5);
            
            // Vérifier que la compression a eu lieu
            if (result.metrics.originalTotalSize > mockConfig.maxOutputLength!) {
                expect(result.metrics.compressionRatio).toBeGreaterThan(0);
            }
        });
    });

    describe('Result Structure', () => {
        test('should return well-formed SmartTruncationResult', () => {
            const engine = new SmartTruncationEngine(mockConfig);
            const tasks = [createMockTask('task1', 2)];
            const result: SmartTruncationResult = engine.apply(tasks);
            
            // Vérifier la structure du résultat
            expect(result.config).toBeDefined();
            expect(result.taskPlans).toBeDefined();
            expect(result.metrics).toBeDefined();
            expect(result.diagnostics).toBeDefined();
            
            // Vérifier les métriques
            expect(result.metrics.totalTasks).toBe(1);
            expect(result.metrics.originalTotalSize).toBeGreaterThan(0);
            expect(result.metrics.finalTotalSize).toBeGreaterThan(0);
            expect(result.metrics.compressionRatio).toBeGreaterThanOrEqual(0);
            expect(result.metrics.truncationByPosition).toBeDefined();
        });

        test('should have consistent task plans', () => {
            const engine = new SmartTruncationEngine(mockConfig);
            const tasks = [
                createMockTask('task1', 2),
                createMockTask('task2', 3)
            ];
            const result = engine.apply(tasks);
            
            expect(result.taskPlans).toHaveLength(2);
            
            result.taskPlans.forEach((plan, index) => {
                expect(plan.taskId).toBe(`task${index + 1}`);
                expect(plan.position).toBe(index);
                expect(plan.distanceFromCenter).toBeGreaterThanOrEqual(0);
                expect(plan.preservationWeight).toBeGreaterThanOrEqual(0);
                expect(plan.preservationWeight).toBeLessThanOrEqual(1);
                expect(plan.originalSize).toBeGreaterThan(0);
                expect(plan.truncationBudget).toBeGreaterThanOrEqual(0);
                expect(plan.targetSize).toBeGreaterThan(0);
                expect(plan.elementPlans).toBeDefined();
            });
        });
    });
});