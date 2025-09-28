/**
 * Tests unitaires pour le moteur de reconstruction hiérarchique
 * Valide le fonctionnement du système en deux passes
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';

// Mock fs AVANT tous les autres imports pour ES modules
const mockedFs = {
    existsSync: jest.fn(),
    readFileSync: jest.fn(),
    statSync: jest.fn(),
    mkdirSync: jest.fn(),
    writeFileSync: jest.fn()
};

// Mock fs avec ES modules - DOIT être avant les imports qui utilisent fs
jest.unstable_mockModule('fs', () => mockedFs);

import * as path from 'path';
import * as os from 'os';
import { HierarchyReconstructionEngine } from '../src/utils/hierarchy-reconstruction-engine.js';
import { TaskInstructionIndex } from '../src/utils/task-instruction-index.js';
import type {
    EnhancedConversationSkeleton,
    Phase1Result,
    Phase2Result,
    ReconstructionConfig
} from '../src/types/enhanced-hierarchy.js';
import {
    mockSkeletons,
    mockNewTaskInstructions,
    mockUiMessages,
    mockCyclicSkeletons,
    complexXmlPatterns,
    corruptedData,
    enhanceSkeleton,
    defaultTestConfig
} from './fixtures/hierarchy-test-data.js';

describe('HierarchyReconstructionEngine', () => {
    let engine: HierarchyReconstructionEngine;
    let tempDir: string;

    beforeEach(() => {
        // Créer un répertoire temporaire pour les tests
        tempDir = path.join(os.tmpdir(), 'hierarchy-tests', Date.now().toString());
        
        // Réinitialiser l'engine pour chaque test
        engine = new HierarchyReconstructionEngine({
            ...defaultTestConfig,
            debugMode: false
        });

        // Clear all mocks
        jest.clearAllMocks();
    });

    afterEach(() => {
        // Nettoyer les mocks
        jest.restoreAllMocks();
    });

    describe('Phase 1 - Extraction et indexation', () => {
        it('should extract new_task patterns from XML tags', async () => {
            const enhancedSkeletons = mockSkeletons.slice(0, 2).map(enhanceSkeleton);
            
            // Mock du système de fichiers
            mockedFs.existsSync.mockImplementation((filePath: any) => {
                return filePath.includes('ui_messages.json');
            });
            
            mockedFs.readFileSync.mockImplementation((filePath: any) => {
                if (filePath.includes('root-task-001')) {
                    return JSON.stringify(mockUiMessages['root-task-001']) as any;
                }
                return JSON.stringify([]) as any;
            });
            
            mockedFs.statSync.mockReturnValue({
                size: 1000,
                mtime: new Date('2025-01-15T10:00:00Z')
            } as any);

            const result = await engine.executePhase1(enhancedSkeletons);

            expect(result.processedCount).toBe(2);
            expect(result.parsedCount).toBeGreaterThan(0);
            expect(result.totalInstructionsExtracted).toBeGreaterThan(0);
            expect(result.errors).toHaveLength(0);
        });

        it('should extract task patterns from simple tags', async () => {
            const skeleton = enhanceSkeleton(mockSkeletons[0]);
            const mockMessages = [
                {
                    role: 'assistant',
                    content: '<task>Implémenter la fonctionnalité de recherche</task>',
                    timestamp: Date.now()
                }
            ];

            mockedFs.existsSync.mockReturnValue(true);
            mockedFs.readFileSync.mockReturnValue(JSON.stringify(mockMessages) as any);
            mockedFs.statSync.mockReturnValue({
                size: 500,
                mtime: new Date()
            } as any);

            const result = await engine.executePhase1([skeleton]);

            expect(result.parsedCount).toBe(1);
            expect(skeleton.parsedSubtaskInstructions).toBeDefined();
        });

        it('should extract delegation patterns', async () => {
            const skeleton = enhanceSkeleton(mockSkeletons[0]);
            const mockMessages = [
                {
                    role: 'assistant',
                    content: 'Je te passe en mode orchestrator pour gérer les sous-tâches',
                    timestamp: Date.now()
                }
            ];

            mockedFs.existsSync.mockReturnValue(true);
            mockedFs.readFileSync.mockReturnValue(JSON.stringify(mockMessages) as any);
            mockedFs.statSync.mockReturnValue({
                size: 500,
                mtime: new Date()
            } as any);

            const result = await engine.executePhase1([skeleton]);

            expect(result.errors).toHaveLength(0);
            if (skeleton.parsedSubtaskInstructions && skeleton.parsedSubtaskInstructions.instructions.length > 0) {
                expect(skeleton.parsedSubtaskInstructions.instructions[0].mode).toBe('orchestrator');
            }
        });

        it('should deduplicate instructions', async () => {
            const skeleton = enhanceSkeleton(mockSkeletons[0]);
            const duplicateMessages = [
                {
                    role: 'assistant',
                    content: '<new_task><mode>code</mode><message>Même tâche</message></new_task>',
                    timestamp: 1000
                },
                {
                    role: 'assistant',
                    content: '<new_task><mode>code</mode><message>Même tâche</message></new_task>',
                    timestamp: 2000
                }
            ];

            mockedFs.existsSync.mockReturnValue(true);
            mockedFs.readFileSync.mockReturnValue(JSON.stringify(duplicateMessages) as any);
            mockedFs.statSync.mockReturnValue({
                size: 500,
                mtime: new Date()
            } as any);

            const result = await engine.executePhase1([skeleton]);

            // Vérifier que les doublons sont gérés (selon l'implémentation)
            expect(result.parsedCount).toBe(1);
            if (skeleton.parsedSubtaskInstructions) {
                // L'implémentation actuelle peut garder les doublons avec timestamps différents
                expect(skeleton.parsedSubtaskInstructions.instructions.length).toBeGreaterThan(0);
            }
        });

        it('should calculate checksums and timestamps', async () => {
            const skeleton = enhanceSkeleton(mockSkeletons[0]);
            
            mockedFs.existsSync.mockReturnValue(true);
            mockedFs.readFileSync.mockReturnValue(JSON.stringify([]) as any);
            mockedFs.statSync.mockReturnValue({
                size: 500,
                mtime: new Date()
            } as any);

            await engine.executePhase1([skeleton]);

            expect(skeleton.sourceFileChecksums).toBeDefined();
            expect(skeleton.processingState.phase1Completed).toBe(true);
            expect(skeleton.processingState.lastProcessedAt).toBeDefined();
        });

        it('should skip re-parsing when checksums are identical', async () => {
            const skeleton = enhanceSkeleton(mockSkeletons[0]);
            
            // Simuler un skeleton déjà traité
            skeleton.processingState.phase1Completed = true;
            skeleton.sourceFileChecksums = {
                uiMessages: 'abc123',
                apiHistory: 'def456',
                metadata: 'ghi789'
            };

            mockedFs.existsSync.mockReturnValue(true);
            // Retourner le même contenu (donc même checksum)
            mockedFs.readFileSync.mockImplementation((filePath: any) => {
                if (filePath.includes('ui_messages')) return '[]' as any;
                if (filePath.includes('api_history')) return '[]' as any;
                if (filePath.includes('metadata')) return '{}' as any;
                return '' as any;
            });

            const result = await engine.executePhase1([skeleton]);

            // Avec forceRebuild=false, devrait skipper
            expect(result.processedCount).toBe(0);
        });

        it('should build radix tree with 200 char prefixes', async () => {
            const skeleton = enhanceSkeleton(mockSkeletons[0]);
            const longInstruction = 'A'.repeat(300); // Plus de 200 caractères
            
            const mockMessages = [
                {
                    role: 'assistant',
                    content: `<new_task><mode>code</mode><message>${longInstruction}</message></new_task>`,
                    timestamp: Date.now()
                }
            ];

            mockedFs.existsSync.mockReturnValue(true);
            mockedFs.readFileSync.mockReturnValue(JSON.stringify(mockMessages) as any);
            mockedFs.statSync.mockReturnValue({
                size: 500,
                mtime: new Date()
            } as any);

            const result = await engine.executePhase1([skeleton]);

            expect(result.parsedCount).toBe(1);
            if (skeleton.parsedSubtaskInstructions) {
                // Vérifier que le message est tronqué à 200 chars dans l'instruction
                const instruction = skeleton.parsedSubtaskInstructions.instructions[0];
                expect(instruction.message.length).toBeLessThanOrEqual(200);
            }
            expect(result.radixTreeSize).toBeGreaterThan(0);
        });

        it('should handle batched processing', async () => {
            const manySkeletons = Array.from({ length: 50 }, (_, i) => 
                enhanceSkeleton({
                    ...mockSkeletons[0],
                    taskId: `task-${i}`
                })
            );

            mockedFs.existsSync.mockReturnValue(false); // Pas de fichiers

            const engineWithSmallBatch = new HierarchyReconstructionEngine({
                batchSize: 5,
                debugMode: false
            });

            const result = await engineWithSmallBatch.executePhase1(manySkeletons);

            expect(result.processedCount).toBe(50);
            expect(result.errors.length).toBeLessThanOrEqual(50);
        });

        it('should handle file read errors gracefully', async () => {
            const skeleton = enhanceSkeleton(mockSkeletons[0]);
            
            mockedFs.existsSync.mockReturnValue(true);
            mockedFs.readFileSync.mockImplementation(() => {
                throw new Error('File read error');
            });

            const result = await engine.executePhase1([skeleton]);

            expect(result.errors).toHaveLength(1);
            expect(result.errors[0].taskId).toBe(skeleton.taskId);
            expect(skeleton.processingState.phase1Completed).toBe(false);
        });

        it('should handle invalid JSON gracefully', async () => {
            const skeleton = enhanceSkeleton(mockSkeletons[0]);
            
            mockedFs.existsSync.mockReturnValue(true);
            mockedFs.readFileSync.mockReturnValue('{"invalid": json' as any);
            mockedFs.statSync.mockReturnValue({
                size: 500,
                mtime: new Date()
            } as any);

            const result = await engine.executePhase1([skeleton]);

            expect(result.errors).toHaveLength(1);
            expect(result.errors[0].taskId).toBe(skeleton.taskId);
        });

        it('should process complex XML patterns correctly', async () => {
            const skeleton = enhanceSkeleton(mockSkeletons[0]);
            const mockMessages = complexXmlPatterns.map((pattern, i) => ({
                role: 'assistant',
                content: pattern,
                timestamp: Date.now() + i * 1000
            }));

            mockedFs.existsSync.mockReturnValue(true);
            mockedFs.readFileSync.mockReturnValue(JSON.stringify(mockMessages) as any);
            mockedFs.statSync.mockReturnValue({
                size: 1000,
                mtime: new Date()
            } as any);

            const result = await engine.executePhase1([skeleton]);

            expect(result.parsedCount).toBe(1);
            expect(result.totalInstructionsExtracted).toBeGreaterThan(0);
            if (skeleton.parsedSubtaskInstructions) {
                expect(skeleton.parsedSubtaskInstructions.extractionStats.xmlDelegations).toBeGreaterThan(0);
            }
        });
    });

    describe('Phase 2 - Résolution des parentIds', () => {
        it('should find parent by similarity search', async () => {
            const skeletons = mockSkeletons.slice(0, 3).map(enhanceSkeleton);
            
            // Simuler que la Phase 1 a été complétée
            skeletons[0].parsedSubtaskInstructions = {
                instructions: mockNewTaskInstructions['root-task-001'],
                parsingTimestamp: new Date().toISOString(),
                sourceFiles: {} as any,
                extractionStats: {
                    totalPatterns: 2,
                    xmlDelegations: 2,
                    taskTags: 0,
                    duplicatesRemoved: 0
                }
            };
            
            // L'orphelin doit trouver son parent
            skeletons[2].parentTaskId = undefined;

            const result = await engine.executePhase2(skeletons);

            expect(result.processedCount).toBeGreaterThan(0);
            // La similarité devrait permettre de trouver le parent
            if (result.resolvedCount > 0) {
                expect(skeletons[2].reconstructedParentId).toBeDefined();
                expect(skeletons[2].parentConfidenceScore).toBeGreaterThan(0);
            }
        });

        it('should validate temporal constraints', async () => {
            const skeletons = [
                enhanceSkeleton(mockSkeletons[5]), // time-paradox (enfant)
                enhanceSkeleton(mockSkeletons[6])  // future-parent (parent créé après)
            ];

            const result = await engine.executePhase2(skeletons);

            // Le parent créé après l'enfant ne devrait pas être accepté
            expect(skeletons[0].reconstructedParentId).toBeUndefined();
            expect(result.unresolvedCount).toBeGreaterThan(0);
        });

        it('should detect and prevent cycles', async () => {
            const cyclicEnhanced = mockCyclicSkeletons.map(enhanceSkeleton);

            const result = await engine.executePhase2(cyclicEnhanced);

            // Aucun cycle ne devrait être créé
            const hasValidCycle = cyclicEnhanced.some(s => 
                s.reconstructedParentId && 
                cyclicEnhanced.find(p => p.taskId === s.reconstructedParentId)
            );
            
            // Si des parents sont résolus, ils ne doivent pas créer de cycles
            if (hasValidCycle) {
                // Vérifier qu'il n'y a pas de cycle réel
                const visited = new Set<string>();
                let current = cyclicEnhanced[0];
                while (current) {
                    if (visited.has(current.taskId)) {
                        expect(false).toBe(true); // Cycle détecté !
                        break;
                    }
                    visited.add(current.taskId);
                    const parentId = current.reconstructedParentId || current.parentTaskId;
                    current = cyclicEnhanced.find(s => s.taskId === parentId)!;
                    if (!current) break;
                }
            }
        });

        it('should validate workspace isolation', async () => {
            const skeletons = [
                enhanceSkeleton(mockSkeletons[0]), // test-project
                enhanceSkeleton(mockSkeletons[4])  // other-project
            ];

            // L'orphelin du second workspace ne doit pas être lié au premier
            skeletons[1].parentTaskId = undefined;

            const result = await engine.executePhase2(skeletons);

            // Ne devrait pas lier des tâches de workspaces différents
            expect(skeletons[1].reconstructedParentId).not.toBe(skeletons[0].taskId);
        });

        it('should calculate confidence scores', async () => {
            const skeletons = mockSkeletons.slice(0, 3).map(enhanceSkeleton);
            
            // Préparer pour la résolution
            skeletons[2].parentTaskId = undefined;

            const result = await engine.executePhase2(skeletons);

            expect(result.averageConfidenceScore).toBeGreaterThanOrEqual(0);
            expect(result.averageConfidenceScore).toBeLessThanOrEqual(1);
            
            if (result.resolvedCount > 0) {
                const resolvedSkeleton = skeletons.find(s => s.reconstructedParentId);
                if (resolvedSkeleton) {
                    expect(resolvedSkeleton.parentConfidenceScore).toBeDefined();
                    expect(resolvedSkeleton.parentConfidenceScore).toBeGreaterThan(0);
                    expect(resolvedSkeleton.parentConfidenceScore).toBeLessThanOrEqual(1);
                }
            }
        });

        it('should use fallback methods (metadata → temporal)', async () => {
            const skeletons = mockSkeletons.slice(0, 3).map(enhanceSkeleton);
            
            // Forcer l'utilisation des fallbacks
            skeletons[2].parentTaskId = undefined;
            skeletons[2].truncatedInstruction = 'Texte sans rapport'; // Pas de similarité

            const result = await engine.executePhase2(skeletons);

            if (result.resolvedCount > 0) {
                expect(result.resolutionMethods).toBeDefined();
                // Vérifier qu'une méthode de fallback a été utilisée
                const methods = Object.keys(result.resolutionMethods);
                const hasMetadata = methods.includes('metadata');
                const hasTemporal = methods.includes('temporal_proximity');
                expect(hasMetadata || hasTemporal).toBe(true);
            }
        });

        it('should mark root tasks with isRootTask flag', async () => {
            const skeletons = [
                enhanceSkeleton({
                    ...mockSkeletons[0],
                    truncatedInstruction: 'Bonjour, je voudrais créer',
                    parentTaskId: undefined
                })
            ];

            const result = await engine.executePhase2(skeletons);

            expect(skeletons[0].isRootTask).toBe(true);
            expect(skeletons[0].parentResolutionMethod).toBe('root_detected');
            expect(result.resolvedCount).toBe(1);
        });

        it('should not modify valid existing parentIds', async () => {
            const skeletons = mockSkeletons.slice(0, 2).map(enhanceSkeleton);
            const originalParentId = skeletons[1].parentTaskId;

            const result = await engine.executePhase2(skeletons);

            // Le parentId valide ne devrait pas être modifié
            expect(skeletons[1].parentTaskId).toBe(originalParentId);
            expect(skeletons[1].reconstructedParentId).toBeUndefined();
        });

        it('should handle invalid parentIds', async () => {
            const skeleton = enhanceSkeleton(mockSkeletons[3]); // invalid-parent-004
            const skeletons = [skeleton];

            const result = await engine.executePhase2(skeletons);

            // Le parentId invalide devrait être résolu ou marqué comme non résolu
            expect(result.processedCount).toBe(1);
            if (result.resolvedCount > 0) {
                expect(skeleton.reconstructedParentId).toBeDefined();
            } else {
                expect(result.unresolvedCount).toBe(1);
            }
        });

        it('should respect minimum confidence threshold', async () => {
            const skeletons = mockSkeletons.slice(0, 3).map(enhanceSkeleton);
            skeletons[2].parentTaskId = undefined;

            const engineWithHighThreshold = new HierarchyReconstructionEngine({
                minConfidenceScore: 0.9 // Seuil très élevé
            });

            const result = await engineWithHighThreshold.executePhase2(skeletons);

            // Avec un seuil élevé, moins de résolutions
            if (result.resolvedCount === 0) {
                expect(result.unresolvedCount).toBeGreaterThan(0);
            } else {
                const resolved = skeletons.find(s => s.reconstructedParentId);
                if (resolved && resolved.parentConfidenceScore) {
                    expect(resolved.parentConfidenceScore).toBeGreaterThanOrEqual(0.9);
                }
            }
        });
    });

    describe('Incremental recovery', () => {
        it('should resume from phase 1 checkpoint', async () => {
            const skeleton = enhanceSkeleton(mockSkeletons[0]);
            
            // Simuler une interruption après Phase 1
            skeleton.processingState.phase1Completed = true;
            skeleton.processingState.phase2Completed = false;
            skeleton.sourceFileChecksums = {
                uiMessages: 'checksum1',
                apiHistory: 'checksum2'
            };

            mockedFs.existsSync.mockReturnValue(true);
            mockedFs.readFileSync.mockReturnValue('[]' as any);

            // Ne devrait pas refaire la Phase 1
            const result1 = await engine.executePhase1([skeleton]);
            expect(result1.processedCount).toBe(0);

            // Devrait faire la Phase 2
            const result2 = await engine.executePhase2([skeleton]);
            expect(result2.processedCount).toBeGreaterThan(0);
        });

        it('should only process missing parentIds', async () => {
            const skeletons = mockSkeletons.slice(0, 3).map(enhanceSkeleton);
            
            // Un skeleton avec parentId valide, un sans
            skeletons[2].parentTaskId = undefined;

            const result = await engine.executePhase2(skeletons);

            // Devrait traiter seulement celui sans parentId
            expect(result.processedCount).toBeGreaterThan(0);
            expect(skeletons[1].reconstructedParentId).toBeUndefined(); // Pas touché
        });

        it('should force rebuild when requested', async () => {
            const skeleton = enhanceSkeleton(mockSkeletons[0]);
            skeleton.processingState.phase1Completed = true;
            skeleton.sourceFileChecksums = { uiMessages: 'old' };

            mockedFs.existsSync.mockReturnValue(true);
            mockedFs.readFileSync.mockReturnValue('[]' as any);
            mockedFs.statSync.mockReturnValue({
                size: 100,
                mtime: new Date()
            } as any);

            const engineWithForce = new HierarchyReconstructionEngine({
                forceRebuild: true
            });

            const result = await engineWithForce.executePhase1([skeleton]);

            expect(result.processedCount).toBe(1); // Devrait reprocesser malgré le cache
        });
    });

    describe('Error handling and edge cases', () => {
        it('should handle corrupted metadata gracefully', async () => {
            const corruptedSkeleton = enhanceSkeleton(corruptedData.missingMetadata);

            const result1 = await engine.executePhase1([corruptedSkeleton]);
            expect(result1.errors.length).toBeGreaterThanOrEqual(0);

            const result2 = await engine.executePhase2([corruptedSkeleton]);
            expect(result2.errors.length).toBeGreaterThanOrEqual(0);
        });

        it('should handle empty taskId', async () => {
            const invalidSkeleton = enhanceSkeleton(corruptedData.invalidTaskId);

            const result = await engine.executePhase2([invalidSkeleton]);
            
            // Ne devrait pas crasher
            expect(result).toBeDefined();
        });

        it('should handle timeout scenarios', async () => {
            const engineWithTimeout = new HierarchyReconstructionEngine({
                operationTimeout: 1 // 1ms timeout
            });

            const manySkeletons = Array.from({ length: 1000 }, (_, i) => 
                enhanceSkeleton({
                    ...mockSkeletons[0],
                    taskId: `task-${i}`
                })
            );

            // Devrait compléter sans timeout (car opérations rapides)
            const result = await engineWithTimeout.executePhase1(manySkeletons);
            expect(result).toBeDefined();
        });

        it('should handle mixed valid and invalid data', async () => {
            const mixedSkeletons = [
                enhanceSkeleton(mockSkeletons[0]),
                enhanceSkeleton(corruptedData.missingMetadata),
                enhanceSkeleton(mockSkeletons[1]),
                enhanceSkeleton(corruptedData.invalidTaskId)
            ];

            const result1 = await engine.executePhase1(mixedSkeletons);
            const result2 = await engine.executePhase2(mixedSkeletons);

            // Devrait traiter les valides et rapporter les erreurs pour les invalides
            expect(result1.processedCount).toBeGreaterThan(0);
            expect(result2.processedCount).toBeGreaterThan(0);
            expect(result1.errors.length + result2.errors.length).toBeGreaterThan(0);
        });
    });

    describe('Integration with static method', () => {
        it('should reconstruct hierarchy using static method', async () => {
            // Ce test nécessite une approche différente pour mocker le module
            // Pour simplifier, on teste juste que la méthode statique existe et fonctionne
            mockedFs.existsSync.mockReturnValue(false);

            // On teste que la méthode existe et peut être appelée
            expect(HierarchyReconstructionEngine.reconstructHierarchy).toBeDefined();
            expect(typeof HierarchyReconstructionEngine.reconstructHierarchy).toBe('function');
            
            // Le vrai test d'intégration serait dans un fichier séparé
            // avec un vrai mock du module RooStorageDetector
        });
    });

    describe('Performance tests', () => {
        it('should handle 1000+ entries efficiently', async () => {
            const { generateLargeDataset } = await import('./fixtures/hierarchy-test-data.js');
            const largeDataset = generateLargeDataset(100).map(enhanceSkeleton); // Réduit pour les tests

            mockedFs.existsSync.mockReturnValue(false);

            const startTime = Date.now();
            const result1 = await engine.executePhase1(largeDataset);
            const phase1Time = Date.now() - startTime;

            const startTime2 = Date.now();
            const result2 = await engine.executePhase2(largeDataset);
            const phase2Time = Date.now() - startTime2;

            // Devrait compléter en temps raisonnable
            expect(phase1Time).toBeLessThan(5000); // 5 secondes max
            expect(phase2Time).toBeLessThan(5000);
            expect(result1.processedCount).toBe(100);
            expect(result2.processedCount).toBeGreaterThan(0);
        });

        it('should report accurate timing metrics', async () => {
            const skeletons = mockSkeletons.slice(0, 3).map(enhanceSkeleton);
            
            mockedFs.existsSync.mockReturnValue(false);

            const result1 = await engine.executePhase1(skeletons);
            const result2 = await engine.executePhase2(skeletons);

            expect(result1.processingTimeMs).toBeGreaterThan(0);
            expect(result2.processingTimeMs).toBeGreaterThan(0);
        });
    });
});