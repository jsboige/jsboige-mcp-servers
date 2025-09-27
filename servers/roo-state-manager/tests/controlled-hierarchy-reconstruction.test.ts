/**
 * Tests unitaires de reconstruction hiérarchique avec données contrôlées
 * Utilise les vraies données de test créées avec la hiérarchie TEST-HIERARCHY
 * 
 * Structure hiérarchique attendue :
 * ROOT (91e837de) → BRANCH-A (305b3f90) → LEAF-A1 (b423bff7)
 *                 └ BRANCH-B (03deadab) → NODE-B1 (38948ef0) → LEAF-B1a (8c06d62c)
 *                                                            └ LEAF-B1b (d6a6a99a)
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import { HierarchyReconstructionEngine } from '../src/utils/hierarchy-reconstruction-engine.js';
import { TaskInstructionIndex } from '../src/utils/task-instruction-index.js';
import type { ConversationSkeleton } from '../src/types/conversation.js';
import type { EnhancedConversationSkeleton } from '../src/types/enhanced-hierarchy.js';

// Pas de mock fs pour ce test - nous voulons lire les vraies données

// Constantes des UUIDs réels de notre hiérarchie de test
const TEST_HIERARCHY_IDS = {
    ROOT: '91e837de-a4b2-4c18-ab9b-6fcd36596e38',
    BRANCH_A: '305b3f90-e0e1-4870-8cf4-4fd33a08cfa4',
    BRANCH_B: '03deadab-a06d-4b29-976d-3cc142add1d9',
    NODE_B1: '38948ef0-4a8b-40a2-ae29-b38d2aa9d5a7',
    LEAF_A1: 'b423bff7-6fec-40fe-a00e-bb2a0ebb52f4',
    LEAF_B1A: '8c06d62c-1ee2-4c3a-991e-c9483e90c8aa',
    LEAF_B1B: 'd6a6a99a-b7fd-41fc-86ce-2f17c9520437',
    COLLECTE: 'e73ea764-4971-4adb-9197-52c2f8ede8ef' // À ignorer dans les tests
} as const;

// Chemin vers les données de test contrôlées
const CONTROLLED_DATA_PATH = path.join(__dirname, 'fixtures', 'controlled-hierarchy');

describe('Controlled Hierarchy Reconstruction - TEST-HIERARCHY Dataset', () => {
    let engine: HierarchyReconstructionEngine;
    let realControlledSkeletons: ConversationSkeleton[];

    beforeEach(async () => {
        // Réinitialiser l'engine avec mode strict activé
        engine = new HierarchyReconstructionEngine({
            batchSize: 10,
            strictMode: true,
            debugMode: true,
            forceRebuild: true
        });

        // Charger les données réelles de test
        realControlledSkeletons = await loadControlledTestData();
        
        // Plus de mocks à nettoyer
    });

    afterEach(() => {
        // Plus de mocks à restaurer
    });

    describe('Phase 1 - Extraction des instructions new_task descendantes', () => {
        it('should extract new_task instructions from all 7 parent tasks', async () => {
            const enhancedSkeletons = realControlledSkeletons.map(enhanceSkeleton);
            const result = await engine.executePhase1(enhancedSkeletons);

            console.log('✅ Phase 1 Results:', JSON.stringify({
                processedCount: result.processedCount,
                parsedCount: result.parsedCount,
                totalInstructionsExtracted: result.totalInstructionsExtracted,
                radixTreeSize: result.radixTreeSize,
                errors: result.errors
            }, null, 2));

            expect(result.processedCount).toBeGreaterThan(0);
            expect(result.parsedCount).toBeGreaterThan(0);
            expect(result.totalInstructionsExtracted).toBeGreaterThan(0);
            expect(result.errors).toHaveLength(0);
            
            // Vérifier que les instructions sont bien extraites des parents
            const parentTaskIds = [TEST_HIERARCHY_IDS.ROOT, TEST_HIERARCHY_IDS.BRANCH_A,
                                   TEST_HIERARCHY_IDS.BRANCH_B, TEST_HIERARCHY_IDS.NODE_B1];
            const parentSkeletons = enhancedSkeletons.filter(s =>
                parentTaskIds.includes(s.taskId as any)
            );

            let totalInstructionsFound = 0;
            for (const parent of parentSkeletons) {
                if (parent.parsedSubtaskInstructions) {
                    totalInstructionsFound += parent.parsedSubtaskInstructions.instructions.length;
                    console.log(`📝 Parent ${parent.taskId.substring(0, 8)} → ${parent.parsedSubtaskInstructions.instructions.length} instructions`);
                }
            }

            expect(totalInstructionsFound).toBeGreaterThan(0);
        });

        it('should populate RadixTree with parent → child declarations', async () => {
            const enhancedSkeletons = realControlledSkeletons.map(enhanceSkeleton);
            const result = await engine.executePhase1(enhancedSkeletons);

            expect(result.radixTreeSize).toBeGreaterThan(0);

            // Vérifier que le RadixTree contient bien les déclarations descendantes
            // (Les parents déclarent leurs enfants, pas l'inverse)
            const instructionIndex = new TaskInstructionIndex();
            
            // Simuler l'indexation (normalement faite par le moteur)
            for (const skeleton of enhancedSkeletons) {
                if (skeleton.parsedSubtaskInstructions) {
                    for (const instruction of skeleton.parsedSubtaskInstructions.instructions) {
                        const prefix = instruction.message.substring(0, 200);
                        instructionIndex.addInstruction(prefix, skeleton.taskId, instruction);
                    }
                }
            }

            const stats = instructionIndex.getStats();
            console.log('🌳 RadixTree Stats:', stats);
            expect(stats.totalInstructions).toBeGreaterThan(0);
        });
    });

    describe('Phase 2 - Reconstruction hiérarchique descendante', () => {
        it('should reconstruct 100% of parent-child relationships', async () => {
            const enhancedSkeletons = realControlledSkeletons.map(enhanceSkeleton);
            
            // Exécuter Phase 1 d'abord
            await engine.executePhase1(enhancedSkeletons);
            
            // Supprimer artificiellement les parentIds pour forcer la reconstruction
            enhancedSkeletons.forEach(s => {
                if (s.taskId !== TEST_HIERARCHY_IDS.ROOT && s.taskId !== TEST_HIERARCHY_IDS.COLLECTE) {
                    s.parentTaskId = undefined;
                }
            });

            // Exécuter Phase 2
            const result = await engine.executePhase2(enhancedSkeletons);

            console.log('🔗 Phase 2 Results:', JSON.stringify({
                processedCount: result.processedCount,
                resolvedCount: result.resolvedCount,
                unresolvedCount: result.unresolvedCount,
                resolutionMethods: result.resolutionMethods,
                averageConfidenceScore: result.averageConfidenceScore
            }, null, 2));

            // Vérifier les relations attendues
            const expectedRelations = {
                [TEST_HIERARCHY_IDS.BRANCH_A]: TEST_HIERARCHY_IDS.ROOT,
                [TEST_HIERARCHY_IDS.BRANCH_B]: TEST_HIERARCHY_IDS.ROOT,
                [TEST_HIERARCHY_IDS.LEAF_A1]: TEST_HIERARCHY_IDS.BRANCH_A,
                [TEST_HIERARCHY_IDS.NODE_B1]: TEST_HIERARCHY_IDS.BRANCH_B,
                [TEST_HIERARCHY_IDS.LEAF_B1A]: TEST_HIERARCHY_IDS.NODE_B1,
                [TEST_HIERARCHY_IDS.LEAF_B1B]: TEST_HIERARCHY_IDS.NODE_B1
            };

            let correctRelations = 0;
            let totalExpectedRelations = Object.keys(expectedRelations).length;

            for (const [childId, expectedParentId] of Object.entries(expectedRelations)) {
                const childSkeleton = enhancedSkeletons.find(s => s.taskId === childId);
                if (childSkeleton && 
                    (childSkeleton.reconstructedParentId === expectedParentId || 
                     childSkeleton.parentTaskId === expectedParentId)) {
                    correctRelations++;
                    console.log(`✅ Relation correcte: ${childId.substring(0, 8)} → ${expectedParentId.substring(0, 8)}`);
                } else {
                    console.log(`❌ Relation manquée: ${childId.substring(0, 8)} → attendu: ${expectedParentId.substring(0, 8)}, trouvé: ${childSkeleton?.reconstructedParentId?.substring(0, 8) || childSkeleton?.parentTaskId?.substring(0, 8) || 'NONE'}`);
                }
            }

            const reconstructionRate = (correctRelations / totalExpectedRelations) * 100;
            console.log(`🎯 Taux de reconstruction: ${reconstructionRate}% (${correctRelations}/${totalExpectedRelations})`);

            // OBJECTIF: 100% de reconstruction
            expect(reconstructionRate).toBeGreaterThanOrEqual(100);
            expect(result.resolvedCount).toBeGreaterThanOrEqual(6); // 6 relations à reconstruire
        });

        it('should build correct depth levels', async () => {
            const enhancedSkeletons = realControlledSkeletons.map(enhanceSkeleton);
            await engine.executePhase1(enhancedSkeletons);

            // Simuler un parentId manquant pour forcer la reconstruction
            enhancedSkeletons.forEach(s => {
                if (s.taskId !== TEST_HIERARCHY_IDS.ROOT) {
                    s.parentTaskId = undefined;
                }
            });

            await engine.executePhase2(enhancedSkeletons);

            // Calculer les profondeurs
            const depths = calculateDepths(enhancedSkeletons);

            // Vérifications des niveaux attendus
            expect(depths[TEST_HIERARCHY_IDS.ROOT]).toBe(0);  // Racine
            expect(depths[TEST_HIERARCHY_IDS.BRANCH_A]).toBe(1);  // Niveau 1
            expect(depths[TEST_HIERARCHY_IDS.BRANCH_B]).toBe(1);  // Niveau 1
            expect(depths[TEST_HIERARCHY_IDS.LEAF_A1]).toBe(2);  // Niveau 2
            expect(depths[TEST_HIERARCHY_IDS.NODE_B1]).toBe(2);  // Niveau 2
            expect(depths[TEST_HIERARCHY_IDS.LEAF_B1A]).toBe(3);  // Niveau 3
            expect(depths[TEST_HIERARCHY_IDS.LEAF_B1B]).toBe(3);  // Niveau 3

            console.log('🏗️ Profondeurs calculées:', depths);
        });

        it('should use strict exact matching only (radix_tree_exact)', async () => {
            const enhancedSkeletons = realControlledSkeletons.map(enhanceSkeleton);
            await engine.executePhase1(enhancedSkeletons);

            // Supprimer les parentIds pour forcer la résolution en mode strict
            enhancedSkeletons.forEach(s => {
                if (s.taskId !== TEST_HIERARCHY_IDS.ROOT) {
                    s.parentTaskId = undefined;
                }
            });

            const result = await engine.executePhase2(enhancedSkeletons);

            // Vérifier que seule la méthode "radix_tree_exact" a été utilisée
            expect(result.resolutionMethods['radix_tree_exact']).toBeGreaterThan(0);
            
            // Vérifier qu'AUCUNE méthode de fallback n'a été utilisée en mode strict
            expect(result.resolutionMethods['metadata']).toBeUndefined();
            expect(result.resolutionMethods['temporal_proximity']).toBeUndefined();
            expect(result.resolutionMethods['radix_tree']).toBeUndefined(); // Ancienne méthode de similarité

            // Vérifier que chaque tâche résolue utilise radix_tree_exact
            const resolvedTasks = enhancedSkeletons.filter(s => s.reconstructedParentId && s.parentResolutionMethod);
            for (const task of resolvedTasks) {
                expect(task.parentResolutionMethod).toBe('radix_tree_exact');
            }

            console.log('🔄 Méthodes de résolution utilisées (mode strict):', result.resolutionMethods);
            console.log('📊 Tâches résolues avec radix_tree_exact:', resolvedTasks.length);
        });

        it('should have zero ambiguous exact matches in controlled dataset', async () => {
            const enhancedSkeletons = realControlledSkeletons.map(enhanceSkeleton);
            await engine.executePhase1(enhancedSkeletons);

            // Supprimer les parentIds pour tester la résolution
            enhancedSkeletons.forEach(s => {
                if (s.taskId !== TEST_HIERARCHY_IDS.ROOT) {
                    s.parentTaskId = undefined;
                }
            });

            const result = await engine.executePhase2(enhancedSkeletons);

            // En mode strict, on ne doit avoir aucune ambiguïté sur le dataset contrôlé
            // Toutes les relations parent-enfant doivent être résolues de manière unique
            const expectedRelationsCount = 6; // 7 tâches - 1 racine
            expect(result.resolvedCount).toBe(expectedRelationsCount);
            expect(result.unresolvedCount).toBe(0);

            console.log('✅ Mode strict - ambiguïtés: 0, résolutions: ' + result.resolvedCount);
        });
    });

    describe('Integration and Validation', () => {
        it('should export correct hierarchical tree (not flat)', async () => {
            const enhancedSkeletons = realControlledSkeletons.map(enhanceSkeleton);
            await engine.executePhase1(enhancedSkeletons);
            await engine.executePhase2(enhancedSkeletons);

            // Construire l'arbre hiérarchique
            const hierarchicalTree = buildHierarchicalTree(enhancedSkeletons);
            
            // Vérifier que l'arbre n'est PAS flat
            const flatTasks = hierarchicalTree.filter(task => task.depth === 0);
            expect(flatTasks.length).toBe(1); // Seulement la racine

            // Vérifier la distribution des profondeurs
            const depthDistribution = hierarchicalTree.reduce((acc, task) => {
                acc[task.depth] = (acc[task.depth] || 0) + 1;
                return acc;
            }, {} as Record<number, number>);

            console.log('📊 Distribution des profondeurs:', depthDistribution);
            
            // Attendu: 1 racine, 2 niveau 1, 2 niveau 2, 2 niveau 3
            expect(depthDistribution[0]).toBe(1); // ROOT
            expect(depthDistribution[1]).toBe(2); // BRANCH-A, BRANCH-B
            expect(depthDistribution[2]).toBe(2); // LEAF-A1, NODE-B1
            expect(depthDistribution[3]).toBe(2); // LEAF-B1a, LEAF-B1b
        });

        it('should validate against expected structure 100%', async () => {
            const enhancedSkeletons = realControlledSkeletons.map(enhanceSkeleton);
            await engine.doReconstruction(enhancedSkeletons);

            // Structure attendue complète
            const expectedStructure = {
                [TEST_HIERARCHY_IDS.ROOT]: { depth: 0, parent: null },
                [TEST_HIERARCHY_IDS.BRANCH_A]: { depth: 1, parent: TEST_HIERARCHY_IDS.ROOT },
                [TEST_HIERARCHY_IDS.BRANCH_B]: { depth: 1, parent: TEST_HIERARCHY_IDS.ROOT },
                [TEST_HIERARCHY_IDS.LEAF_A1]: { depth: 2, parent: TEST_HIERARCHY_IDS.BRANCH_A },
                [TEST_HIERARCHY_IDS.NODE_B1]: { depth: 2, parent: TEST_HIERARCHY_IDS.BRANCH_B },
                [TEST_HIERARCHY_IDS.LEAF_B1A]: { depth: 3, parent: TEST_HIERARCHY_IDS.NODE_B1 },
                [TEST_HIERARCHY_IDS.LEAF_B1B]: { depth: 3, parent: TEST_HIERARCHY_IDS.NODE_B1 }
            };

            const actualStructure = buildActualStructure(enhancedSkeletons);
            
            let validationsCount = 0;
            let totalValidations = Object.keys(expectedStructure).length;

            for (const [taskId, expected] of Object.entries(expectedStructure)) {
                const actual = actualStructure[taskId];
                if (actual && actual.depth === expected.depth && actual.parent === expected.parent) {
                    validationsCount++;
                    console.log(`✅ Structure validée pour ${taskId.substring(0, 8)}`);
                } else {
                    console.log(`❌ Structure incorrecte pour ${taskId.substring(0, 8)}: attendu depth=${expected.depth}, parent=${expected.parent?.substring(0, 8)}, trouvé depth=${actual?.depth}, parent=${actual?.parent?.substring(0, 8)}`);
                }
            }

            const validationRate = (validationsCount / totalValidations) * 100;
            console.log(`🏆 Validation finale: ${validationRate}% (${validationsCount}/${totalValidations})`);

            expect(validationRate).toBe(100);
        });
    });
});

// Fonctions utilitaires

async function loadControlledTestData(): Promise<ConversationSkeleton[]> {
    const skeletons: ConversationSkeleton[] = [];
    
    // Exclure la tâche de collecte (e73ea764) car elle n'est pas partie de la hiérarchie de test
    const taskIds = Object.values(TEST_HIERARCHY_IDS).filter(id => id !== TEST_HIERARCHY_IDS.COLLECTE);

    for (const taskId of taskIds) {
        const taskDir = path.join(CONTROLLED_DATA_PATH, taskId);
        const metadataPath = path.join(taskDir, 'task_metadata.json');
        
        if (fs.existsSync(metadataPath)) {
            try {
                const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
                
                skeletons.push({
                    taskId: taskId,
                    truncatedInstruction: metadata.truncatedInstruction || metadata.title || '',
                    metadata: {
                        title: metadata.title,
                        createdAt: metadata.createdAt,
                        lastActivity: metadata.lastActivity || metadata.lastMessageAt || metadata.createdAt,
                        messageCount: metadata.messageCount || 0,
                        actionCount: metadata.actionCount || 0,
                        totalSize: metadata.totalSize || 0,
                        workspace: metadata.workspace || 'test-workspace',
                        dataSource: taskDir
                    },
                    sequence: [], // Séquence vide pour les tests, sera populée si nécessaire
                    parentTaskId: metadata.parentTaskId
                });
            } catch (error) {
                console.warn(`⚠️ Erreur lors du chargement de ${taskId}:`, error);
            }
        }
    }

    console.log(`📂 Données de test contrôlées chargées: ${skeletons.length} tâches`);
    return skeletons;
}

// Pas de mocks nécessaires - les vrais fichiers sont lus directement

function enhanceSkeleton(skeleton: ConversationSkeleton): EnhancedConversationSkeleton {
    return {
        ...skeleton,
        processingState: {
            phase1Completed: false,
            phase2Completed: false,
            processingErrors: []
        },
        sourceFileChecksums: {}
    } as EnhancedConversationSkeleton;
}

function calculateDepths(skeletons: EnhancedConversationSkeleton[]): Record<string, number> {
    const depths: Record<string, number> = {};
    const skeletonMap = new Map(skeletons.map(s => [s.taskId, s]));

    function getDepth(taskId: string): number {
        if (depths[taskId] !== undefined) {
            return depths[taskId];
        }

        const skeleton = skeletonMap.get(taskId);
        if (!skeleton) return 0;

        const parentId = skeleton.reconstructedParentId || skeleton.parentTaskId;
        if (!parentId) {
            depths[taskId] = 0;
            return 0;
        }

        depths[taskId] = getDepth(parentId) + 1;
        return depths[taskId];
    }

    skeletons.forEach(s => getDepth(s.taskId));
    return depths;
}

function buildHierarchicalTree(skeletons: EnhancedConversationSkeleton[]): Array<{taskId: string, depth: number, parentId: string | null}> {
    const depths = calculateDepths(skeletons);
    
    return skeletons.map(s => ({
        taskId: s.taskId,
        depth: depths[s.taskId] || 0,
        parentId: s.reconstructedParentId || s.parentTaskId || null
    })).sort((a, b) => a.depth - b.depth);
}

function buildActualStructure(skeletons: EnhancedConversationSkeleton[]): Record<string, {depth: number, parent: string | null}> {
    const depths = calculateDepths(skeletons);
    const structure: Record<string, {depth: number, parent: string | null}> = {};

    skeletons.forEach(s => {
        structure[s.taskId] = {
            depth: depths[s.taskId] || 0,
            parent: s.reconstructedParentId || s.parentTaskId || null
        };
    });

    return structure;
}