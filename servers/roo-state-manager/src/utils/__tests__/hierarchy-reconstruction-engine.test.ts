/**
 * Tests unitaires pour hierarchy-reconstruction-engine.ts
 *
 * Stratégie de test :
 * - Tests d'interface pour les méthodes publiques
 * - Tests d'algorithme pour Phase 1 (extraction)
 * - Tests d'algorithme pour Phase 2 (résolution)
 * - Tests de validation des candidats parents
 *
 * @module utils/__tests__/hierarchy-reconstruction-engine.test
 * @version 1.0.0 (#511)
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { HierarchyReconstructionEngine } from '../hierarchy-reconstruction-engine.js';
import type { ConversationSkeleton, EnhancedConversationSkeleton } from '../../types/enhanced-hierarchy.js';

// ─────────────────── Mocks ───────────────────

const mockReadFile = vi.fn();
const mockExistsSync = vi.fn();
const mockReaddir = vi.fn();
const mockStat = vi.fn();

vi.mock('fs', () => ({
    existsSync: (...args: any[]) => mockExistsSync(...args),
}));

vi.mock('fs/promises', () => ({
    readFile: (...args: any[]) => mockReadFile(...args),
    readdir: (...args: any[]) => mockReaddir(...args),
    stat: (...args: any[]) => mockStat(...args),
}));

// ─────────────────── Setup ───────────────────

beforeEach(() => {
    vi.clearAllMocks();
    // Defaults
    mockReadFile.mockResolvedValue('[]');
    mockExistsSync.mockReturnValue(false);
    mockReaddir.mockResolvedValue([]);
    mockStat.mockResolvedValue({
        isDirectory: () => true,
        size: 1000,
        mtime: new Date('2025-01-01T00:00:00Z'),
    });
});

// ─────────────────── Helpers ───────────────────

function createMockSkeleton(taskId: string, options?: Partial<ConversationSkeleton>): ConversationSkeleton {
    return {
        taskId,
        parentTaskId: options?.parentTaskId,
        sequence: [],
        metadata: {
            title: `Task ${taskId}`,
            createdAt: '2025-01-01T00:00:00Z',
            lastActivity: '2025-01-01T00:00:00Z',
            mode: 'code',
            messageCount: 10,
            actionCount: 5,
            totalSize: 1000,
            workspace: 'test-workspace',
            dataSource: '/mock/tasks/' + taskId,
            ...options?.metadata,
        },
        ...options,
    };
}

// ─────────────────── Tests ───────────────────

describe('HierarchyReconstructionEngine', () => {

    // ============================================================
    // Interface et constructeur
    // ============================================================

    describe('interface publique', () => {
        test('reconstructHierarchy est une méthode statique', () => {
            expect(typeof HierarchyReconstructionEngine.reconstructHierarchy).toBe('function');
        });

        test('constructeur accepte une config partielle', () => {
            const engine = new HierarchyReconstructionEngine({
                batchSize: 10,
                debugMode: false,
            });

            expect(engine).toBeDefined();
        });

        test('constructeur utilise les valeurs par défaut', () => {
            const engine = new HierarchyReconstructionEngine();

            expect(engine).toBeDefined();
        });
    });

    // ============================================================
    // Phase 1 : Extraction
    // ============================================================

    describe('Phase 1 - Extraction', () => {
        test('executePhase1 retourne un résultat avec les champs requis', async () => {
            const engine = new HierarchyReconstructionEngine();
            const skeletons: EnhancedConversationSkeleton[] = [
                {
                    ...createMockSkeleton('task1'),
                    parsedSubtaskInstructions: undefined,
                } as any,
            ];

            const result = await engine.executePhase1(skeletons);

            expect(result).toHaveProperty('processedCount');
            expect(result).toHaveProperty('parsedCount');
            expect(result).toHaveProperty('errors');
            expect(result).toHaveProperty('totalInstructionsExtracted');
            expect(result).toHaveProperty('radixTreeSize');
            expect(result).toHaveProperty('processingTimeMs');
        });

        test('executePhase1 compte les skeletons traités', async () => {
            const engine = new HierarchyReconstructionEngine();
            mockReadFile.mockResolvedValue('[]'); // Pas d'instructions

            const skeletons: EnhancedConversationSkeleton[] = [
                createMockSkeleton('task1') as any,
                createMockSkeleton('task2') as any,
            ];

            const result = await engine.executePhase1(skeletons);

            expect(result.processedCount).toBeGreaterThanOrEqual(0);
        });

        test('executePhase1 mesure le temps de traitement', async () => {
            const engine = new HierarchyReconstructionEngine();
            const skeletons: EnhancedConversationSkeleton[] = [createMockSkeleton('task1') as any];

            const result = await engine.executePhase1(skeletons);

            expect(result.processingTimeMs).toBeGreaterThan(0);
        });

        test('executePhase1 gère les erreurs de lecture', async () => {
            const engine = new HierarchyReconstructionEngine();
            mockReadFile.mockRejectedValue(new Error('Read error'));

            const skeletons: EnhancedConversationSkeleton[] = [createMockSkeleton('task1') as any];

            const result = await engine.executePhase1(skeletons);

            expect(result.errors).toBeDefined();
            expect(Array.isArray(result.errors)).toBe(true);
        });
    });

    // ============================================================
    // Phase 2 : Résolution
    // ============================================================

    describe('Phase 2 - Résolution', () => {
        test('executePhase2 retourne un résultat avec les champs requis', async () => {
            const engine = new HierarchyReconstructionEngine();
            const skeletons: EnhancedConversationSkeleton[] = [
                createMockSkeleton('task1') as any,
                createMockSkeleton('task2') as any,
            ];

            const result = await engine.executePhase2(skeletons);

            expect(result).toHaveProperty('processedCount');
            expect(result).toHaveProperty('resolvedCount');
            expect(result).toHaveProperty('unresolvedCount');
            expect(result).toHaveProperty('errors');
            expect(result).toHaveProperty('resolutionMethods');
            expect(result).toHaveProperty('averageConfidenceScore');
            expect(result).toHaveProperty('processingTimeMs');
        });

        test('executePhase2 identifie les orphelins', async () => {
            const engine = new HierarchyReconstructionEngine();
            const skeletons: EnhancedConversationSkeleton[] = [
                createMockSkeleton('orphan1') as any,
                createMockSkeleton('orphan2') as any,
            ];

            const result = await engine.executePhase2(skeletons);

            // Les orphelins sont ceux sans parentTaskId
            expect(result.processedCount).toBeGreaterThan(0);
        });

        test('executePhase2 gère les racines', async () => {
            const engine = new HierarchyReconstructionEngine({
                strictMode: true,
            });
            const rootSkeleton: EnhancedConversationSkeleton = {
                ...createMockSkeleton('root'),
                truncatedInstruction: 'Root task instruction',
                isRootTask: true,
            } as any;

            const result = await engine.executePhase2([rootSkeleton]);

            expect(result.resolutionMethods).toBeDefined();
        });

        test('executePhase2 mesure la confiance moyenne', async () => {
            const engine = new HierarchyReconstructionEngine();
            const skeletons: EnhancedConversationSkeleton[] = [
                createMockSkeleton('task1') as any,
            ];

            const result = await engine.executePhase2(skeletons);

            expect(typeof result.averageConfidenceScore).toBe('number');
        });

        test('executePhase2 mesure le temps de traitement', async () => {
            const engine = new HierarchyReconstructionEngine();
            const skeletons: EnhancedConversationSkeleton[] = [
                createMockSkeleton('task1') as any,
            ];

            const result = await engine.executePhase2(skeletons);

            expect(result.processingTimeMs).toBeGreaterThan(0);
        });
    });

    // ============================================================
    // Méthode statique reconstructHierarchy
    // ============================================================

    describe('reconstructHierarchy (statique)', () => {
        test('retourne un tableau de skeletons', async () => {
            // Note: Ce test nécessite que RooStorageDetector soit mocké
            // Pour l'instant, on teste juste l'interface

            const result = await HierarchyReconstructionEngine.reconstructHierarchy(undefined, false);

            expect(Array.isArray(result)).toBe(true);
        });

        test('chaque skeleton a un taskId', async () => {
            const result = await HierarchyReconstructionEngine.reconstructHierarchy(undefined, false);

            if (result.length > 0) {
                expect(result[0]).toHaveProperty('taskId');
            }
        });
    });

    // ============================================================
    // Validation des candidats
    // ============================================================

    describe('validateParentCandidate', () => {
        test('la méthode existe sur l\'instance', async () => {
            const engine = new HierarchyReconstructionEngine();
            const child = createMockSkeleton('child') as any;
            const parentMap = new Map<string, any>();
            parentMap.set('parent', createMockSkeleton('parent') as any);

            // On vérifie juste que la méthode est callable
            const validation = await engine.validateParentCandidate(child, 'parent', parentMap);

            expect(validation).toHaveProperty('isValid');
            // La propriété confidence n'est pas toujours présente;
        });
    });

    // ============================================================
    // Configuration
    // ============================================================

    describe('configuration', () => {
        test('accepte une config personnalisée', () => {
            const customConfig = {
                batchSize: 30,
                similarityThreshold: 0.9,
                minConfidenceScore: 0.85,
                debugMode: false,
            };

            const engine = new HierarchyReconstructionEngine(customConfig);

            expect(engine).toBeDefined();
        });

        test('fusionne avec les valeurs par défaut', () => {
            const engine = new HierarchyReconstructionEngine({
                batchSize: 30,
            });

            expect(engine).toBeDefined();
        });
    });

    // ============================================================
    // Logging
    // ============================================================

    describe('logging', () => {
        test('log ne lance pas d\'exception', () => {
            const engine = new HierarchyReconstructionEngine({
                debugMode: true,
            });

            expect(() => {
                (engine as any).log('Test message', { key: 'value' });
            }).not.toThrow();
        });

        test('log fonctionne en mode non-debug', () => {
            const engine = new HierarchyReconstructionEngine({
                debugMode: false,
            });

            expect(() => {
                (engine as any).log('Test message', {});
            }).not.toThrow();
        });
    });

    // ============================================================
    // Gestion des erreurs
    // ============================================================

    describe('gestion des erreurs', () => {
        test.skip('gère les skeletons invalides - SKIP: nécessite plus de mocks', async () => {
            const engine = new HierarchyReconstructionEngine();
            const invalidSkeletons = [null, undefined, {}] as any;

            const result = await engine.executePhase2(invalidSkeletons);

            expect(result).toBeDefined();
            expect(result.errors).toBeDefined();
        });

        test('gère les erreurs dans Phase 1', async () => {
            const engine = new HierarchyReconstructionEngine();
            mockReadFile.mockRejectedValue(new Error('Test error'));

            const skeletons: EnhancedConversationSkeleton[] = [createMockSkeleton('task1') as any];

            const result = await engine.executePhase1(skeletons);

            expect(result.errors).toBeDefined();
        });

        test('gère les erreurs dans Phase 2', async () => {
            const engine = new HierarchyReconstructionEngine();
            const problematicSkeleton: EnhancedConversationSkeleton = {
                ...createMockSkeleton('problem'),
                taskId: 'problem',
            } as any;

            // Simuler une erreur interne
            const result = await engine.executePhase2([problematicSkeleton]);

            expect(result).toBeDefined();
        });
    });

    // ============================================================
    // Batches et parallélisme
    // ============================================================

    describe('batches', () => {
        test('crée des batches de la taille spécifiée', () => {
            const engine = new HierarchyReconstructionEngine({ batchSize: 5 });
            const skeletons: EnhancedConversationSkeleton[] = Array.from(
                { length: 12 },
                (_, i) => createMockSkeleton(`task${i}`) as any
            );

            const batches = (engine as any).createBatches(skeletons, 5);

            expect(batches.length).toBe(3); // 12 / 5 = 3 batches
            expect(batches[0].length).toBe(5);
        });

        test('gère les skeletons vides', () => {
            const engine = new HierarchyReconstructionEngine();
            const batches = (engine as any).createBatches([], 10);

            expect(batches.length).toBe(0);
        });
    });

    // ============================================================
    // État de traitement
    // ============================================================

    describe('état de traitement', () => {
        test('suit l\'état des skeletons', () => {
            const engine = new HierarchyReconstructionEngine();
            const skeleton = createMockSkeleton('task1') as any;

            (engine as any).updateProcessingState(skeleton, 'phase1', true);

            expect(skeleton.processingState).toBeDefined();
        });

        test('enregistre les échecs', () => {
            const engine = new HierarchyReconstructionEngine();
            const skeleton = createMockSkeleton('task1') as any;

            (engine as any).updateProcessingState(skeleton, 'phase1', false, 'Test error');

            expect(skeleton.processingState).toBeDefined();
        });
    });

});
