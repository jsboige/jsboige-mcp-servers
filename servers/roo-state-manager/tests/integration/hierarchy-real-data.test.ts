/**
 * Tests unitaires de reconstruction hiérarchique - VRAIES DONNÉES
 * Utilise les vraies données de test contrôlées sans mocks
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { HierarchyReconstructionEngine } from '../../src/utils/hierarchy-reconstruction-engine.js';
import { computeInstructionPrefix } from '../../src/utils/task-instruction-index.js';
import type { ConversationSkeleton } from '../../src/types/conversation.js';
import type { EnhancedConversationSkeleton } from '../../src/types/enhanced-hierarchy.js';

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

// Fonctions utilitaires au niveau supérieur
async function loadRealControlledData(): Promise<ConversationSkeleton[]> {
    const skeletons: ConversationSkeleton[] = [];
    
    // Exclure la tâche de collecte
    const taskIds = Object.values(TEST_HIERARCHY_IDS).filter(id => id !== TEST_HIERARCHY_IDS.COLLECTE);

    // Restaurer le vrai fs pour ce test uniquement
    vi.unmock('fs');
    const realFs = await import('fs');

    for (const taskId of taskIds) {
        const taskDir = path.join(CONTROLLED_DATA_PATH, taskId);
        const metadataPath = path.join(taskDir, 'task_metadata.json');
        const uiMessagesPath = path.join(taskDir, 'ui_messages.json');
        
        console.log(`[LOAD DEBUG] Processing ${taskId}`);
        console.log(`[LOAD DEBUG] Metadata path: ${metadataPath}`);
        console.log(`[LOAD DEBUG] Metadata exists: ${realFs.existsSync(metadataPath)}`);
        
        if (realFs.existsSync(metadataPath)) {
            try {
                const metadata = JSON.parse(realFs.readFileSync(metadataPath, 'utf-8'));
                console.log(`[LOAD DEBUG] Raw metadata loaded for ${taskId}:`, JSON.stringify(metadata, null, 2));
                
                // Utiliser truncatedInstruction depuis les métadonnées (comme dans le script debug qui fonctionne)
                let truncatedInstruction = metadata.truncatedInstruction || '';
                let title = metadata.title || 'Test Task';
                
                console.log(`[LOAD DEBUG] ${taskId}: truncatedInstruction="${truncatedInstruction}"`);
                console.log(`[LOAD DEBUG] ${taskId}: title="${title}"`);
                console.log(`[LOAD DEBUG] ${taskId}: parentTaskId="${metadata.parentTaskId}"`);
                console.log(`[LOAD DEBUG] ${taskId}: createdAt="${metadata.createdAt}"`);
                
                // Debug: écrire les métadonnées brutes dans un fichier
                try {
                    realFs.writeFileSync(`debug-metadata-${taskId}.json`, JSON.stringify(metadata, null, 2));
                } catch (error) {
                    console.error(`[LOAD DEBUG] Error writing metadata debug file:`, error);
                }
                
                skeletons.push({
                    taskId: taskId,
                    truncatedInstruction: truncatedInstruction,
                    metadata: {
                        title: title,
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
                console.error(`[LOAD DEBUG] Erreur chargement ${taskId}:`, error);
            }
        } else {
            console.error(`[LOAD DEBUG] Metadata file not found: ${metadataPath}`);
        }
    }
    
    // Debug: écrire tous les skeletons dans un fichier
    try {
        realFs.writeFileSync('debug-load-all-skeletons.json', JSON.stringify(skeletons, null, 2));
        console.log(`[LOAD DEBUG] Wrote ${skeletons.length} skeletons to debug-load-all-skeletons.json`);
    } catch (error) {
        console.error(`[LOAD DEBUG] Error writing debug file:`, error);
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
    };
}

function calculateDepths(skeletons: EnhancedConversationSkeleton[]): Record<string, number> {
    const depths: Record<string, number> = {};
    
    function calculateDepth(taskId: string, visited: Set<string> = new Set()): number {
        if (visited.has(taskId)) return 0; // Cycle detection
        visited.add(taskId);
        
        const skeleton = skeletons.find(s => s.taskId === taskId);
        // Utiliser reconstructedParentId en priorité, sinon parentTaskId
        const parentId = skeleton?.reconstructedParentId || skeleton?.parentTaskId;
        
        if (!skeleton || !parentId) {
            depths[taskId] = 0;
            return 0;
        }
        
        const parentDepth = calculateDepth(parentId, visited);
        depths[taskId] = parentDepth + 1;
        return depths[taskId];
    }
    
    skeletons.forEach(s => calculateDepth(s.taskId));
    return depths;
}

describe('Hierarchy Reconstruction - Real Data Tests', () => {
    let engine: HierarchyReconstructionEngine;
    let realControlledSkeletons: ConversationSkeleton[];

    beforeEach(async () => {
        // Réinitialiser l'engine avec mode strict
        engine = new HierarchyReconstructionEngine({
            batchSize: 10,
            strictMode: true,
            debugMode: true, // Activer les logs pour debug
            forceRebuild: true
        });

        // Charger les données réelles
        console.log('[TEST DEBUG] Avant loadRealControlledData');
        realControlledSkeletons = await loadRealControlledData();
        console.log(`[TEST DEBUG] Après loadRealControlledData: ${realControlledSkeletons.length} skeletons chargés`);
        
        // Debug: écrire les skeletons chargés dans un fichier
        const fs = require('fs') as any;
        fs.writeFileSync('debug-loaded-skeletons.json', JSON.stringify(realControlledSkeletons, null, 2));
    });

    it('should reconstruct 100% of parent-child relationships', async () => {
        const enhancedSkeletons = realControlledSkeletons.map(enhanceSkeleton);
        
        // Phase 1
        const result1 = await engine.executePhase1(enhancedSkeletons);
        
        // Écrire les logs dans un fichier pour débogage
        const fs = require('fs') as any;
        fs.writeFileSync('debug-test-result.json', JSON.stringify(result1, null, 2));
        
        expect(result1.processedCount).toBeGreaterThan(0);
        expect(result1.totalInstructionsExtracted).toBeGreaterThan(0);
        
        // Supprimer TOUS les parentIds pour forcer reconstruction complète
        enhancedSkeletons.forEach(s => {
            s.parentTaskId = undefined;
        });

        // Phase 2
        const result2 = await engine.executePhase2(enhancedSkeletons);
        
        // Debug: écrire les résultats de la Phase 2
        const fs2 = require('fs') as any;
        fs2.writeFileSync('debug-test-phase2.json', JSON.stringify({
            result2,
            enhancedSkeletons: enhancedSkeletons.map(s => ({
                taskId: s.taskId,
                parentTaskId: s.parentTaskId,
                reconstructedParentId: s.reconstructedParentId
            }))
        }, null, 2));
        
        // Vérifier les relations reconstruites
        const expectedRelations = {
            [TEST_HIERARCHY_IDS.BRANCH_A]: TEST_HIERARCHY_IDS.ROOT,
            [TEST_HIERARCHY_IDS.BRANCH_B]: TEST_HIERARCHY_IDS.ROOT,
            [TEST_HIERARCHY_IDS.NODE_B1]: TEST_HIERARCHY_IDS.BRANCH_B,
            [TEST_HIERARCHY_IDS.LEAF_A1]: TEST_HIERARCHY_IDS.BRANCH_A,
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
    });
});