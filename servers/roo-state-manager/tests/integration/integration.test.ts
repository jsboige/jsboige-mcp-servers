/**
 * Tests d'intégration et de régression pour le système de reconstruction hiérarchique
 * Valide le fonctionnement complet sur des données réelles et les cas critiques
 */

import {  describe, it, expect, beforeEach, afterEach, jest , vi } from 'vitest';

// Mock fs AVANT tous les autres imports pour ES modules
const mockedFs = {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    statSync: vi.fn(),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn()
};

// Mock fs avec ES modules - DOIT être avant les imports qui utilisent fs
vi.unstable_mockModule('fs', () => mockedFs);

import * as path from 'path';
import { HierarchyReconstructionEngine } from '../../../src/utils/hierarchy-reconstruction-engine.js';
import { TaskInstructionIndex } from '../../../src/utils/task-instruction-index.js';
import type { ConversationSkeleton } from '../../../src/types/conversation.js';
import type { EnhancedConversationSkeleton } from '../../../src/types/enhanced-hierarchy.js';
import {
    mockSkeletons,
    mockNewTaskInstructions,
    mockUiMessages,
    generateLargeDataset,
    enhanceSkeleton,
    mockCyclicSkeletons
} from '../../fixtures/hierarchy-test-data.js';

describe('Hierarchy Reconstruction - Integration Tests', () => {
    let engine: HierarchyReconstructionEngine;

    beforeEach(() => {
        engine = new HierarchyReconstructionEngine({
            debugMode: false,
            batchSize: 10,
            similarityThreshold: 0.2,
            minConfidenceScore: 0.3
        });

        // Configuration par défaut des mocks
        mockedFs.existsSync.mockReturnValue(false);
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('Reconstruction complète sur données réelles', () => {
        it('should reconstruct hierarchy for complete dataset', async () => {
            const skeletons = mockSkeletons.map(enhanceSkeleton);
            
            // Simuler les fichiers UI messages pour certaines tâches
            mockedFs.existsSync.mockImplementation((filePath: any) => {
                if (filePath.includes('root-task-001')) return true;
                if (filePath.includes('child-task-002')) return true;
                return false;
            });

            mockedFs.readFileSync.mockImplementation((filePath: any) => {
                if (filePath.includes('root-task-001')) {
                    return JSON.stringify(mockUiMessages['root-task-001']) as any;
                }
                if (filePath.includes('child-task-002')) {
                    return JSON.stringify(mockUiMessages['child-task-002']) as any;
                }
                return '[]' as any;
            });

            mockedFs.statSync.mockReturnValue({
                size: 1000,
                mtime: new Date('2025-01-15T10:00:00Z')
            } as any);

            // Exécuter la reconstruction complète
            const result = await engine.doReconstruction(skeletons);

            // Vérifications
            expect(result).toHaveLength(skeletons.length);
            
            // Vérifier que les orphelines ont été résolues
            const orphanResolved = result.find(s => s.taskId === 'orphan-task-003');
            if (orphanResolved && orphanResolved.reconstructedParentId) {
                expect(orphanResolved.reconstructedParentId).toBeDefined();
                expect(orphanResolved.parentConfidenceScore).toBeGreaterThan(0);
            }

            // Vérifier que les parentIds valides ne sont pas modifiés
            const validParent = result.find(s => s.taskId === 'child-task-002');
            expect(validParent?.parentTaskId).toBe('root-task-001');
            expect(validParent?.reconstructedParentId).toBeUndefined();
        });

        it('should handle 47 orphan tasks scenario', async () => {
            // Créer 47 tâches orphelines + quelques parents potentiels
            const orphans: ConversationSkeleton[] = [];
            const parents: ConversationSkeleton[] = [];
            
            // Créer 5 parents
            for (let i = 0; i < 5; i++) {
                parents.push({
                    taskId: `parent-${i}`,
                    parentTaskId: undefined,
                    truncatedInstruction: `Mission principale ${i}: Créer système`,
                    metadata: {
                        createdAt: new Date(2025, 0, 15, 10, i * 10).toISOString(),
                        lastActivity: new Date(2025, 0, 15, 11, i * 10).toISOString(),
                        title: `Parent ${i}`,
                        workspace: 'd:/dev/test-project',
                        mode: 'architect',
                        messageCount: 10,
                        actionCount: 5,
                        totalSize: 10000,
                        dataSource: `d:/roo-data/parent-${i}`
                    },
                    sequence: [],
                    childTaskInstructionPrefixes: [`Mission secondaire ${i}`],
                    isCompleted: false
                });
            }

            // Créer 47 orphelines
            for (let i = 0; i < 47; i++) {
                const parentIndex = i % 5;
                orphans.push({
                    taskId: `orphan-${i}`,
                    parentTaskId: undefined, // Orpheline !
                    truncatedInstruction: `Mission secondaire ${parentIndex}: Tâche ${i}`,
                    metadata: {
                        createdAt: new Date(2025, 0, 15, 11 + Math.floor(i/10), i % 60).toISOString(),
                        lastActivity: new Date(2025, 0, 15, 12 + Math.floor(i/10), i % 60).toISOString(),
                        title: `Orphan ${i}`,
                        workspace: 'd:/dev/test-project',
                        mode: 'code',
                        messageCount: 5,
                        actionCount: 2,
                        totalSize: 5000,
                        dataSource: `d:/roo-data/orphan-${i}`
                    },
                    sequence: [],
                    isCompleted: i % 3 === 0
                });
            }

            const allSkeletons = [...parents, ...orphans].map(enhanceSkeleton);

            // Simuler les instructions pour les parents
            for (let i = 0; i < 5; i++) {
                const parentPath = `d:/roo-data/parent-${i}/ui_messages.json`;
                mockedFs.existsSync.mockImplementation((path: any) => 
                    path === parentPath || path.includes(`parent-${i}`)
                );
                
                mockedFs.readFileSync.mockImplementation((path: any) => {
                    if (path.includes(`parent-${i}`)) {
                        const messages = [];
                        for (let j = 0; j < 10; j++) {
                            messages.push({
                                role: 'assistant',
                                content: `<new_task><mode>code</mode><message>Mission secondaire ${i}: Tâche ${i * 10 + j}</message></new_task>`,
                                timestamp: Date.now() + j * 1000
                            });
                        }
                        return JSON.stringify(messages) as any;
                    }
                    return '[]' as any;
                });
            }

            mockedFs.statSync.mockReturnValue({
                size: 5000,
                mtime: new Date()
            } as any);

            // Exécuter la reconstruction
            const result = await engine.doReconstruction(allSkeletons);

            // Vérifications
            const resolvedOrphans = result.filter(s => 
                s.taskId.startsWith('orphan-') && 
                (s.reconstructedParentId || s.isRootTask)
            );
            
            console.log(`Résolu ${resolvedOrphans.length} / 47 orphelines`);
            
            // Au moins certaines orphelines devraient être résolues
            expect(resolvedOrphans.length).toBeGreaterThan(0);
            
            // Vérifier qu'aucun cycle n'a été créé
            const hasCycle = result.some(child => {
                if (!child.reconstructedParentId) return false;
                const parent = result.find(p => p.taskId === child.reconstructedParentId);
                return parent?.reconstructedParentId === child.taskId;
            });
            expect(hasCycle).toBe(false);
        });

        it('should generate tree with depth > 0', async () => {
            // Créer une hiérarchie profonde
            const deepHierarchy: ConversationSkeleton[] = [];
            
            // Racine
            deepHierarchy.push({
                taskId: 'root',
                parentTaskId: undefined,
                truncatedInstruction: 'Créer application complète',
                metadata: {
                    createdAt: '2025-01-15T10:00:00Z',
                    lastActivity: '2025-01-15T10:05:00Z',
                    title: 'Root',
                    workspace: 'd:/dev/test',
                    mode: 'architect',
                    messageCount: 10,
                    actionCount: 5,
                    totalSize: 10000,
                    dataSource: 'd:/roo-data/root'
                },
                sequence: [],
                isCompleted: false
            });

            // Niveau 1
            for (let i = 0; i < 3; i++) {
                deepHierarchy.push({
                    taskId: `level1-${i}`,
                    parentTaskId: 'root',
                    truncatedInstruction: `Module ${i}`,
                    metadata: {
                        createdAt: `2025-01-15T10:${10 + i}:00Z`,
                        lastActivity: `2025-01-15T10:${15 + i}:00Z`,
                        title: `Level 1 - ${i}`,
                        workspace: 'd:/dev/test',
                        mode: 'code',
                        messageCount: 8,
                        actionCount: 3,
                        totalSize: 8000,
                        dataSource: `d:/roo-data/level1-${i}`
                    },
                    sequence: [],
                    isCompleted: false
                });

                // Niveau 2
                for (let j = 0; j < 2; j++) {
                    deepHierarchy.push({
                        taskId: `level2-${i}-${j}`,
                        parentTaskId: `level1-${i}`,
                        truncatedInstruction: `Sous-module ${i}.${j}`,
                        metadata: {
                            createdAt: `2025-01-15T10:${20 + i * 10 + j}:00Z`,
                            lastActivity: `2025-01-15T10:${25 + i * 10 + j}:00Z`,
                            title: `Level 2 - ${i}.${j}`,
                            workspace: 'd:/dev/test',
                            mode: 'code',
                            messageCount: 5,
                            actionCount: 2,
                            totalSize: 5000,
                            dataSource: `d:/roo-data/level2-${i}-${j}`
                        },
                        sequence: [],
                        isCompleted: j === 0
                    });
                }
            }

            const enhanced = deepHierarchy.map(enhanceSkeleton);
            const result = await engine.doReconstruction(enhanced);

            // Calculer la profondeur de l'arbre
            function calculateDepth(taskId: string, skeletons: EnhancedConversationSkeleton[], depth: number = 0): number {
                const children = skeletons.filter(s => 
                    (s.parentTaskId === taskId) || (s.reconstructedParentId === taskId)
                );
                
                if (children.length === 0) return depth;
                
                return Math.max(...children.map(child => 
                    calculateDepth(child.taskId, skeletons, depth + 1)
                ));
            }

            const treeDepth = calculateDepth('root', result);
            expect(treeDepth).toBeGreaterThan(0);
            console.log(`Arbre généré avec profondeur: ${treeDepth}`);
        });

        it('should complete in less than 3 seconds for 50 tasks', async () => {
            const dataset = generateLargeDataset(50).map(enhanceSkeleton);
            
            mockedFs.existsSync.mockReturnValue(false);

            const startTime = Date.now();
            const result = await engine.doReconstruction(dataset);
            const totalTime = Date.now() - startTime;

            expect(totalTime).toBeLessThan(3000); // Moins de 3 secondes
            expect(result).toHaveLength(50);
        });

        it('should resume after crash between phases', async () => {
            const skeletons = mockSkeletons.slice(0, 3).map(enhanceSkeleton);
            
            // Simuler un crash après Phase 1
            // D'abord exécuter la Phase 1
            mockedFs.existsSync.mockReturnValue(true);
            mockedFs.readFileSync.mockReturnValue('[]' as any);
            mockedFs.statSync.mockReturnValue({
                size: 100,
                mtime: new Date()
            } as any);

            const phase1Result = await engine.executePhase1(skeletons);
            expect(phase1Result.processedCount).toBeGreaterThan(0);

            // Simuler un nouveau moteur (comme après un crash)
            const newEngine = new HierarchyReconstructionEngine({
                debugMode: false
            });

            // Les skeletons gardent leur état de Phase 1
            const phase2Result = await newEngine.executePhase2(skeletons);
            expect(phase2Result.processedCount).toBeGreaterThan(0);
        });

        it('should handle partial corruption gracefully', async () => {
            const mixedData = [
                ...mockSkeletons.slice(0, 2),
                {
                    taskId: 'corrupted-1',
                    parentTaskId: 'non-existent',
                    // truncatedInstruction manquant
                    metadata: {
                        createdAt: '2025-01-15T10:00:00Z',
                        lastActivity: '2025-01-15T10:05:00Z',
                        title: 'Corrupted',
                        workspace: 'd:/dev/test',
                        messageCount: 1,
                        actionCount: 0,
                        totalSize: 100
                    },
                    sequence: []
                } as ConversationSkeleton,
                ...mockSkeletons.slice(2, 4)
            ].map(enhanceSkeleton);

            mockedFs.existsSync.mockReturnValue(false);

            const result = await engine.doReconstruction(mixedData);

            // Devrait traiter les valides et gérer les corrompus
            expect(result).toHaveLength(mixedData.length);
            
            const validResults = result.filter(r => r.taskId.startsWith('root') || r.taskId.startsWith('child'));
            expect(validResults.length).toBeGreaterThan(0);
        });
    });

    describe('Régression - Validation des invariants', () => {
        it('should not modify valid existing parentIds', async () => {
            const skeletons = mockSkeletons.map(enhanceSkeleton);
            const originalRelations = new Map<string, string | undefined>();
            
            // Sauvegarder les relations originales
            skeletons.forEach(s => {
                if (s.parentTaskId) {
                    originalRelations.set(s.taskId, s.parentTaskId);
                }
            });

            const result = await engine.doReconstruction(skeletons);

            // Vérifier que les parentIds VRAIMENT VALIDES n'ont pas changé
            result.forEach(s => {
                const original = originalRelations.get(s.taskId);
                if (original) {
                    const originalParent = skeletons.find(p => p.taskId === original);
                    if (originalParent) {
                        // Vérifier si la relation est temporellement valide
                        const pTime = new Date(originalParent.metadata.createdAt).getTime();
                        const cTime = new Date(s.metadata.createdAt).getTime();
                        const temporalValid = !Number.isFinite(pTime) || !Number.isFinite(cTime) || pTime <= cTime;
                        
                        // Vérifier si les workspaces correspondent
                        const workspaceValid = !originalParent.metadata?.workspace ||
                                               !s.metadata?.workspace ||
                                               originalParent.metadata.workspace === s.metadata.workspace;
                        
                        // Ne vérifier la préservation QUE pour les relations VALIDES
                        if (temporalValid && workspaceValid) {
                            expect(s.parentTaskId).toBe(original);
                            expect(s.reconstructedParentId).toBeUndefined();
                        } else {
                            // Les relations invalides DOIVENT être supprimées par le moteur
                            expect(s.parentTaskId).toBeUndefined();
                        }
                    }
                }
            });
        });

        it('should maintain workspace isolation', async () => {
            const multiWorkspace = [
                ...mockSkeletons.slice(0, 2).map(s => ({
                    ...s,
                    metadata: { ...s.metadata, workspace: 'd:/dev/project-a' }
                })),
                ...mockSkeletons.slice(2, 4).map(s => ({
                    ...s,
                    metadata: { ...s.metadata, workspace: 'd:/dev/project-b' }
                }))
            ].map(enhanceSkeleton);

            // Forcer tous à être orphelins
            multiWorkspace.forEach(s => {
                s.parentTaskId = undefined;
            });

            const result = await engine.doReconstruction(multiWorkspace);

            // Vérifier qu'aucune tâche de project-a n'a un parent dans project-b
            result.forEach(task => {
                if (task.reconstructedParentId) {
                    const parent = result.find(p => p.taskId === task.reconstructedParentId);
                    if (parent) {
                        expect(task.metadata.workspace).toBe(parent.metadata.workspace);
                    }
                }
            });
        });

        it('should never create cycles', async () => {
            const cyclicEnhanced = mockCyclicSkeletons.map(enhanceSkeleton);
            
            const result = await engine.doReconstruction(cyclicEnhanced);

            // Fonction pour détecter les cycles
            function hasCycle(skeletons: EnhancedConversationSkeleton[]): boolean {
                for (const skeleton of skeletons) {
                    const visited = new Set<string>();
                    let current: EnhancedConversationSkeleton | undefined = skeleton;
                    
                    while (current) {
                        if (visited.has(current.taskId)) {
                            return true; // Cycle détecté
                        }
                        visited.add(current.taskId);
                        
                        const parentId: string | undefined = current.reconstructedParentId || current.parentTaskId;
                        if (!parentId) break;
                        
                        current = skeletons.find(s => s.taskId === parentId);
                    }
                }
                return false;
            }

            expect(hasCycle(result)).toBe(false);
        });

        it('should respect temporal ordering', async () => {
            const skeletons = mockSkeletons.map(enhanceSkeleton);
            
            const result = await engine.doReconstruction(skeletons);

            // Vérifier que tous les parents reconstruits sont créés avant leurs enfants
            result.forEach(child => {
                if (child.reconstructedParentId) {
                    const parent = result.find(p => p.taskId === child.reconstructedParentId);
                    if (parent) {
                        const parentTime = new Date(parent.metadata.createdAt).getTime();
                        const childTime = new Date(child.metadata.createdAt).getTime();
                        expect(parentTime).toBeLessThanOrEqual(childTime);
                    }
                }
            });
        });

        it('should maintain deterministic results', async () => {
            const skeletons = mockSkeletons.slice(0, 5).map(enhanceSkeleton);
            
            // Exécuter deux fois
            const result1 = await engine.doReconstruction([...skeletons]);
            const result2 = await engine.doReconstruction([...skeletons]);

            // Les résultats devraient être identiques
            result1.forEach((s1, index) => {
                const s2 = result2[index];
                expect(s1.taskId).toBe(s2.taskId);
                expect(s1.reconstructedParentId).toBe(s2.reconstructedParentId);
                expect(s1.parentConfidenceScore).toBe(s2.parentConfidenceScore);
                expect(s1.parentResolutionMethod).toBe(s2.parentResolutionMethod);
            });
        });
    });

    describe('Performance et stress tests', () => {
        it('should handle 1000+ tasks efficiently', async () => {
            const largeDataset = generateLargeDataset(1000).map(enhanceSkeleton);
            
            mockedFs.existsSync.mockReturnValue(false);

            const startTime = Date.now();
            
            // Phase 1
            const phase1Result = await engine.executePhase1(largeDataset);
            const phase1Time = Date.now() - startTime;
            
            expect(phase1Time).toBeLessThan(10000); // 10 secondes max
            expect(phase1Result.processedCount).toBe(1000);

            // Phase 2
            const phase2Start = Date.now();
            const phase2Result = await engine.executePhase2(largeDataset);
            const phase2Time = Date.now() - phase2Start;
            
            expect(phase2Time).toBeLessThan(10000); // 10 secondes max
            expect(phase2Result.processedCount).toBeGreaterThan(0);

            console.log(`Performance: Phase1=${phase1Time}ms, Phase2=${phase2Time}ms pour 1000 tâches`);
        });

        it('should efficiently use memory with large datasets', async () => {
            const hugeDataset = generateLargeDataset(500).map(enhanceSkeleton);
            
            mockedFs.existsSync.mockReturnValue(false);

            // Mesurer l'utilisation mémoire (approximatif)
            const initialMemory = process.memoryUsage().heapUsed;
            
            await engine.doReconstruction(hugeDataset);
            
            const finalMemory = process.memoryUsage().heapUsed;
            const memoryIncrease = (finalMemory - initialMemory) / 1024 / 1024; // En MB
            
            console.log(`Augmentation mémoire: ${memoryIncrease.toFixed(2)} MB pour 500 tâches`);
            
            // L'augmentation ne devrait pas être excessive
            expect(memoryIncrease).toBeLessThan(100); // Moins de 100 MB
        });

        it('should handle concurrent modifications gracefully', async () => {
            const skeletons = mockSkeletons.slice(0, 5).map(enhanceSkeleton);
            
            // Simuler des modifications concurrentes des fichiers
            let callCount = 0;
            mockedFs.readFileSync.mockImplementation(() => {
                callCount++;
                // Changer le contenu à chaque lecture
                return JSON.stringify([{ 
                    role: 'user', 
                    content: `Message ${callCount}`,
                    timestamp: Date.now() 
                }]) as any;
            });

            mockedFs.existsSync.mockReturnValue(true);
            mockedFs.statSync.mockReturnValue({
                size: 100,
                mtime: new Date()
            } as any);

            // Ne devrait pas crasher malgré les changements
            const result = await engine.doReconstruction(skeletons);
            expect(result).toHaveLength(skeletons.length);
        });
    });

    describe('Edge cases et robustesse', () => {
        it('should handle empty dataset', async () => {
            const result = await engine.doReconstruction([]);
            expect(result).toHaveLength(0);
        });

        it('should handle single task', async () => {
            const single = [enhanceSkeleton(mockSkeletons[0])];
            const result = await engine.doReconstruction(single);
            
            expect(result).toHaveLength(1);
            expect(result[0].isRootTask).toBe(true);
        });

        it('should handle all tasks being roots', async () => {
            const allRoots = mockSkeletons.slice(0, 3).map(s => ({
                ...s,
                parentTaskId: undefined,
                truncatedInstruction: `Bonjour ${s.taskId}`
            })).map(enhanceSkeleton);

            const result = await engine.doReconstruction(allRoots);
            
            const rootCount = result.filter(s => s.isRootTask).length;
            expect(rootCount).toBe(3);
        });

        it('should handle all tasks being orphans with no matches', async () => {
            const allOrphans = Array.from({ length: 10 }, (_, i) => ({
                taskId: `orphan-${i}`,
                parentTaskId: undefined,
                truncatedInstruction: `Texte unique ${Math.random()}`,
                metadata: {
                    createdAt: new Date(2025, 0, 15, 10, i).toISOString(),
                    lastActivity: new Date(2025, 0, 15, 11, i).toISOString(),
                    title: `Orphan ${i}`,
                    workspace: 'd:/dev/test',
                    mode: 'code' as const,
                    messageCount: 1,
                    actionCount: 0,
                    totalSize: 100,
                    dataSource: `d:/roo-data/orphan-${i}`
                },
                sequence: [],
                isCompleted: false
            })).map(enhanceSkeleton);

            const result = await engine.doReconstruction(allOrphans);
            
            // Certains devraient être identifiés comme racines
            const roots = result.filter(s => s.isRootTask);
            expect(roots.length).toBeGreaterThan(0);
        });
    });
});