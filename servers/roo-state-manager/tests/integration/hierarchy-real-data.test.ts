/**
 * Tests unitaires de reconstruction hiérarchique - VRAIES DONNÉES
 * Utilise les vraies données de test contrôlées sans mocks
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { HierarchyReconstructionEngine } from '../../../src/utils/hierarchy-reconstruction-engine.js';
import type { ConversationSkeleton } from '../../../src/types/conversation.js';
import type { EnhancedConversationSkeleton } from '../../../src/types/enhanced-hierarchy.js';

// Support ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Constantes des UUIDs réels de notre hiérarchie de test
const TEST_HIERARCHY_IDS = {
    ROOT: '91e837de-a4b2-4c18-ab9b-6fcd36596e38',
    BRANCH_A: '305b3f90-e0e1-4870-8cf4-4fd33a08cfa4',
    BRANCH_B: '03deadab-a06d-4b29-976d-3cc142add1d9',
    NODE_B1: '38948ef0-4a8b-40a2-ae29-b38d2aa9d5a7',
    LEAF_A1: 'b423bff7-6fec-40fe-a00e-bb2a0ebb52f4',
    LEAF_B1A: '8c06d62c-1ee2-4c3a-991e-c9483e90c8aa',
    LEAF_B1B: 'd6a6a99a-b7fd-41fc-86ce-2f17c9520437',
    COLLECTE: 'e73ea764-4971-4adb-9197-52c2f8ede8ef' // À ignorer
};

// Chemin vers les données de test contrôlées
const CONTROLLED_DATA_PATH = path.join(__dirname, 'fixtures', 'controlled-hierarchy');

describe('Hierarchy Reconstruction - Real Data Tests', () => {
    let engine: HierarchyReconstructionEngine;
    let realControlledSkeletons: ConversationSkeleton[];

    beforeEach(async () => {
        // Réinitialiser l'engine avec mode strict
        engine = new HierarchyReconstructionEngine({
            batchSize: 10,
            strictMode: true,
            debugMode: false, // Réduire les logs pour Jest
            forceRebuild: true
        });

        // Charger les données réelles
        realControlledSkeletons = await loadRealControlledData();
    });

    it('should reconstruct 100% of parent-child relationships', async () => {
        const enhancedSkeletons = realControlledSkeletons.map(enhanceSkeleton);
        
        // Phase 1
        const result1 = await engine.executePhase1(enhancedSkeletons);
        expect(result1.processedCount).toBeGreaterThan(0);
        expect(result1.totalInstructionsExtracted).toBeGreaterThan(0);
        
        // Supprimer parentIds pour forcer reconstruction
        enhancedSkeletons.forEach(s => {
            if (s.taskId !== TEST_HIERARCHY_IDS.ROOT) {
                s.parentTaskId = undefined;
            }
        });

        // Phase 2
        const result2 = await engine.executePhase2(enhancedSkeletons);
        
        // Vérifier relations attendues
        const expectedRelations = {
            [TEST_HIERARCHY_IDS.BRANCH_A]: TEST_HIERARCHY_IDS.ROOT,
            [TEST_HIERARCHY_IDS.BRANCH_B]: TEST_HIERARCHY_IDS.ROOT,
            [TEST_HIERARCHY_IDS.LEAF_A1]: TEST_HIERARCHY_IDS.BRANCH_A,
            [TEST_HIERARCHY_IDS.NODE_B1]: TEST_HIERARCHY_IDS.BRANCH_B,
            [TEST_HIERARCHY_IDS.LEAF_B1A]: TEST_HIERARCHY_IDS.NODE_B1,
            [TEST_HIERARCHY_IDS.LEAF_B1B]: TEST_HIERARCHY_IDS.NODE_B1
        };

        let correctRelations = 0;
        for (const [childId, expectedParentId] of Object.entries(expectedRelations)) {
            const childSkeleton = enhancedSkeletons.find(s => s.taskId === childId);
            if (childSkeleton && 
                (childSkeleton.reconstructedParentId === expectedParentId || 
                 childSkeleton.parentTaskId === expectedParentId)) {
                correctRelations++;
            }
        }

        const reconstructionRate = (correctRelations / Object.keys(expectedRelations).length) * 100;
        expect(reconstructionRate).toBe(100);
        expect(result2.resolvedCount).toBeGreaterThanOrEqual(6);
    });

    it('should use only radix_tree_exact method in strict mode', async () => {
        const enhancedSkeletons = realControlledSkeletons.map(enhanceSkeleton);
        
        // Phase 1
        await engine.executePhase1(enhancedSkeletons);
        
        // Supprimer parentIds
        enhancedSkeletons.forEach(s => {
            if (s.taskId !== TEST_HIERARCHY_IDS.ROOT) {
                s.parentTaskId = undefined;
            }
        });

        // Phase 2
        const result2 = await engine.executePhase2(enhancedSkeletons);
        
        // Vérifier que seule radix_tree_exact est utilisée
        expect(result2.resolutionMethods['radix_tree_exact']).toBeGreaterThan(0);
        
        // Vérifier qu'aucun fallback n'est utilisé
        expect(result2.resolutionMethods['metadata']).toBeUndefined();
        expect(result2.resolutionMethods['temporal_proximity']).toBeUndefined();
        expect(result2.resolutionMethods['radix_tree']).toBeUndefined(); // Ancienne similarité
    });

    it('should build correct depth hierarchy', async () => {
        const enhancedSkeletons = realControlledSkeletons.map(enhanceSkeleton);
        
        // Phase 1
        await engine.executePhase1(enhancedSkeletons);
        
        // Supprimer parentIds pour forcer reconstruction
        enhancedSkeletons.forEach(s => {
            if (s.taskId !== TEST_HIERARCHY_IDS.ROOT) {
                s.parentTaskId = undefined;
            }
        });
        
        // Phase 2
        await engine.executePhase2(enhancedSkeletons);
        
        // Calculer profondeurs
        const depths = calculateDepths(enhancedSkeletons);
        
        // Vérifications spécifiques
        expect(depths[TEST_HIERARCHY_IDS.ROOT]).toBe(0);
        expect(depths[TEST_HIERARCHY_IDS.BRANCH_A]).toBe(1);
        expect(depths[TEST_HIERARCHY_IDS.BRANCH_B]).toBe(1);
        expect(depths[TEST_HIERARCHY_IDS.LEAF_A1]).toBe(2);
        expect(depths[TEST_HIERARCHY_IDS.NODE_B1]).toBe(2);
        expect(depths[TEST_HIERARCHY_IDS.LEAF_B1A]).toBe(3);
        expect(depths[TEST_HIERARCHY_IDS.LEAF_B1B]).toBe(3);
    });
});

// Fonctions utilitaires

async function loadRealControlledData(): Promise<ConversationSkeleton[]> {
    const skeletons: ConversationSkeleton[] = [];
    
    // Exclure la tâche de collecte
    const taskIds = Object.values(TEST_HIERARCHY_IDS).filter(id => id !== TEST_HIERARCHY_IDS.COLLECTE);

    for (const taskId of taskIds) {
        const taskDir = path.join(CONTROLLED_DATA_PATH, taskId);
        const metadataPath = path.join(taskDir, 'task_metadata.json');
        const uiMessagesPath = path.join(taskDir, 'ui_messages.json');
        
        if (fs.existsSync(metadataPath)) {
            try {
                const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
                
                // Extraire l'instruction initiale depuis ui_messages.json
                let truncatedInstruction = '';
                let title = '';
                
                if (fs.existsSync(uiMessagesPath)) {
                    const uiMessages = JSON.parse(fs.readFileSync(uiMessagesPath, 'utf-8'));
                    
                    // Chercher le premier message "say" avec texte significatif
                    const firstSayMessage = uiMessages.find((msg: any) => 
                        msg.type === 'say' && msg.text && msg.text.length > 20
                    );
                    
                    if (firstSayMessage) {
                        truncatedInstruction = firstSayMessage.text.substring(0, 200);
                        title = firstSayMessage.text.substring(0, 100);
                    }
                }
                
                skeletons.push({
                    taskId: taskId,
                    truncatedInstruction: truncatedInstruction || '',
                    metadata: {
                        title: title || 'Test Task',
                        createdAt: metadata.createdAt,
                        lastActivity: metadata.lastActivity || metadata.createdAt,
                        messageCount: metadata.messageCount || 0,
                        actionCount: metadata.actionCount || 0,
                        totalSize: metadata.totalSize || 0,
                        workspace: metadata.workspace || 'test-workspace',
                        dataSource: taskDir
                    },
                    sequence: [],
                    parentTaskId: metadata.parentTaskId
                });
            } catch (error) {
                console.warn(`Erreur chargement ${taskId}:`, error);
            }
        }
    }

    return skeletons;
}

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