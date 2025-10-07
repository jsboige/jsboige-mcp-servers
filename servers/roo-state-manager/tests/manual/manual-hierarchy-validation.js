#!/usr/bin/env node

/**
 * Script de validation manuelle pour la reconstruction hiérarchique
 * Teste les vraies données contrôlées sans Jest
 */

import * as fs from 'fs';
import * as path from 'path';
import { HierarchyReconstructionEngine } from './build/src/utils/hierarchy-reconstruction-engine.js';
import { TaskInstructionIndex } from './build/src/utils/task-instruction-index.js';

// IDs de la hiérarchie de test
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
const CONTROLLED_DATA_PATH = path.join(process.cwd(), 'tests', 'fixtures', 'controlled-hierarchy');

console.log('🚀 VALIDATION MANUELLE DE LA RECONSTRUCTION HIÉRARCHIQUE');
console.log('=========================================================');

async function loadControlledTestData() {
    console.log(`📂 Chargement depuis: ${CONTROLLED_DATA_PATH}`);
    const skeletons = [];
    
    // Exclure la tâche de collecte
    const taskIds = Object.values(TEST_HIERARCHY_IDS).filter(id => id !== TEST_HIERARCHY_IDS.COLLECTE);

    for (const taskId of taskIds) {
        const taskDir = path.join(CONTROLLED_DATA_PATH, taskId);
        const metadataPath = path.join(taskDir, 'task_metadata.json');
        const uiMessagesPath = path.join(taskDir, 'ui_messages.json');
        
        if (fs.existsSync(metadataPath)) {
            try {
                const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
                
                // Extraire le truncatedInstruction depuis ui_messages.json
                let truncatedInstruction = '';
                let title = '';
                
                if (fs.existsSync(uiMessagesPath)) {
                    const uiMessages = JSON.parse(fs.readFileSync(uiMessagesPath, 'utf-8'));
                    
                    // Chercher le premier message "say" avec du texte (instruction initiale)
                    const firstSayMessage = uiMessages.find(msg => msg.type === 'say' && msg.text && msg.text.length > 20);
                    if (firstSayMessage) {
                        truncatedInstruction = firstSayMessage.text.substring(0, 200);
                        title = firstSayMessage.text.substring(0, 100);
                    }
                }
                
                skeletons.push({
                    taskId: taskId,
                    truncatedInstruction: truncatedInstruction || metadata.truncatedInstruction || metadata.title || '',
                    metadata: {
                        title: title || metadata.title,
                        createdAt: metadata.createdAt,
                        lastActivity: metadata.lastActivity || metadata.lastMessageAt || metadata.createdAt,
                        messageCount: metadata.messageCount || 0,
                        actionCount: metadata.actionCount || 0,
                        totalSize: metadata.totalSize || 0,
                        workspace: metadata.workspace || 'test-workspace',
                        dataSource: taskDir
                    },
                    sequence: [],
                    parentTaskId: metadata.parentTaskId
                });
                
                console.log(`✅ Chargé: ${taskId.substring(0, 8)} | ${title || truncatedInstruction.substring(0, 50)}`);
            } catch (error) {
                console.warn(`⚠️ Erreur chargement ${taskId}:`, error);
            }
        } else {
            console.warn(`❌ Fichier manquant: ${metadataPath}`);
        }
    }

    console.log(`📊 Total chargé: ${skeletons.length} tâches`);
    return skeletons;
}

function enhanceSkeleton(skeleton) {
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

function calculateDepths(skeletons) {
    const depths = {};
    const skeletonMap = new Map(skeletons.map(s => [s.taskId, s]));

    function getDepth(taskId) {
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

async function testHierarchyReconstruction() {
    try {
        // 1. Charger les données de test
        console.log('\n1️⃣ CHARGEMENT DES DONNÉES DE TEST');
        console.log('=================================');
        const realControlledSkeletons = await loadControlledTestData();
        
        if (realControlledSkeletons.length === 0) {
            throw new Error('Aucune donnée de test chargée');
        }

        // 2. Initialiser l'engine en mode strict
        console.log('\n2️⃣ INITIALISATION DE L\'ENGINE EN MODE STRICT');
        console.log('=============================================');
        const engine = new HierarchyReconstructionEngine({
            batchSize: 10,
            strictMode: true,
            debugMode: true,
            forceRebuild: true
        });

        const enhancedSkeletons = realControlledSkeletons.map(enhanceSkeleton);
        
        // 3. Test Phase 1 - Extraction des instructions
        console.log('\n3️⃣ PHASE 1 - EXTRACTION DES INSTRUCTIONS');
        console.log('========================================');
        const result1 = await engine.executePhase1(enhancedSkeletons);
        
        console.log(`📊 Phase 1 Results:`);
        console.log(`   - Processed: ${result1.processedCount}`);
        console.log(`   - Parsed: ${result1.parsedCount}`);
        console.log(`   - Instructions extracted: ${result1.totalInstructionsExtracted}`);
        console.log(`   - RadixTree size: ${result1.radixTreeSize}`);
        console.log(`   - Errors: ${result1.errors.length}`);
        
        if (result1.errors.length > 0) {
            console.log('⚠️ Erreurs Phase 1:');
            result1.errors.forEach(error => console.log(`   - ${error}`));
        }

        // 4. Supprimer les parentIds pour forcer la reconstruction
        console.log('\n4️⃣ SUPPRESSION DES PARENT IDS POUR TEST');
        console.log('======================================');
        enhancedSkeletons.forEach(s => {
            if (s.taskId !== TEST_HIERARCHY_IDS.ROOT && s.taskId !== TEST_HIERARCHY_IDS.COLLECTE) {
                console.log(`🔄 Suppression parentId pour: ${s.taskId.substring(0, 8)}`);
                s.parentTaskId = undefined;
            }
        });

        // 5. Test Phase 2 - Reconstruction hiérarchique
        console.log('\n5️⃣ PHASE 2 - RECONSTRUCTION HIÉRARCHIQUE');
        console.log('========================================');
        const result2 = await engine.executePhase2(enhancedSkeletons);
        
        console.log(`📊 Phase 2 Results:`);
        console.log(`   - Processed: ${result2.processedCount}`);
        console.log(`   - Resolved: ${result2.resolvedCount}`);
        console.log(`   - Unresolved: ${result2.unresolvedCount}`);
        console.log(`   - Avg confidence: ${result2.averageConfidenceScore}`);
        console.log(`   - Methods: ${JSON.stringify(result2.resolutionMethods, null, 2)}`);

        // 6. Validation des relations attendues
        console.log('\n6️⃣ VALIDATION DES RELATIONS ATTENDUES');
        console.log('====================================');
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
            const actualParentId = childSkeleton?.reconstructedParentId || childSkeleton?.parentTaskId;
            
            if (actualParentId === expectedParentId) {
                correctRelations++;
                console.log(`✅ ${childId.substring(0, 8)} → ${expectedParentId.substring(0, 8)}`);
            } else {
                console.log(`❌ ${childId.substring(0, 8)} → attendu: ${expectedParentId.substring(0, 8)}, trouvé: ${actualParentId?.substring(0, 8) || 'NONE'}`);
            }
        }

        const reconstructionRate = (correctRelations / totalExpectedRelations) * 100;
        console.log(`🎯 Taux de reconstruction: ${reconstructionRate}% (${correctRelations}/${totalExpectedRelations})`);

        // 7. Validation des profondeurs
        console.log('\n7️⃣ VALIDATION DES PROFONDEURS');
        console.log('============================');
        const depths = calculateDepths(enhancedSkeletons);
        
        const expectedDepths = {
            [TEST_HIERARCHY_IDS.ROOT]: 0,
            [TEST_HIERARCHY_IDS.BRANCH_A]: 1,
            [TEST_HIERARCHY_IDS.BRANCH_B]: 1,
            [TEST_HIERARCHY_IDS.LEAF_A1]: 2,
            [TEST_HIERARCHY_IDS.NODE_B1]: 2,
            [TEST_HIERARCHY_IDS.LEAF_B1A]: 3,
            [TEST_HIERARCHY_IDS.LEAF_B1B]: 3
        };

        let correctDepths = 0;
        for (const [taskId, expectedDepth] of Object.entries(expectedDepths)) {
            const actualDepth = depths[taskId] || 0;
            if (actualDepth === expectedDepth) {
                correctDepths++;
                console.log(`✅ ${taskId.substring(0, 8)} depth: ${actualDepth}`);
            } else {
                console.log(`❌ ${taskId.substring(0, 8)} depth: attendu ${expectedDepth}, trouvé ${actualDepth}`);
            }
        }

        // 8. Validation du mode strict (radix_tree_exact uniquement)
        console.log('\n8️⃣ VALIDATION DU MODE STRICT');
        console.log('==========================');
        const methodsUsed = Object.keys(result2.resolutionMethods);
        const strictMethodUsed = result2.resolutionMethods['radix_tree_exact'] || 0;
        const rootDetectedUsed = result2.resolutionMethods['root_detected'] || 0;
        const realFallbackMethodsUsed = methodsUsed.filter(m =>
            !['radix_tree_exact', 'root_detected'].includes(m) && result2.resolutionMethods[m] > 0
        );

        console.log(`📊 Méthodes utilisées:`);
        console.log(`   - radix_tree_exact: ${strictMethodUsed}`);
        console.log(`   - root_detected: ${result2.resolutionMethods['root_detected'] || 0}`);
        
        if (realFallbackMethodsUsed.length > 0) {
            console.log(`   - FALLBACKS (non désirés): ${realFallbackMethodsUsed.join(', ')}`);
        } else {
            console.log(`   - Aucun fallback utilisé ✅`);
        }

        // 9. Rapport final
        console.log('\n9️⃣ RAPPORT FINAL');
        console.log('===============');
        console.log(`🏆 Reconstruction: ${reconstructionRate}%`);
        console.log(`🏗️ Profondeurs correctes: ${correctDepths}/${Object.keys(expectedDepths).length}`);
        console.log(`🔒 Mode strict respecté: ${realFallbackMethodsUsed.length === 0 ? 'OUI' : 'NON'}`);
        
        const success = reconstructionRate >= 100 &&
                       correctDepths === Object.keys(expectedDepths).length &&
                       realFallbackMethodsUsed.length === 0;
        
        if (success) {
            console.log('\n🎉 VALIDATION RÉUSSIE - RECONSTRUCTION HIÉRARCHIQUE À 100%');
            console.log('========================================================');
            return true;
        } else {
            console.log('\n❌ VALIDATION ÉCHOUÉE');
            console.log('====================');
            return false;
        }

    } catch (error) {
        console.error('\n💥 ERREUR FATALE:', error);
        console.error(error.stack);
        return false;
    }
}

// Exécuter la validation
testHierarchyReconstruction()
    .then(success => {
        console.log(`\n🏁 Script terminé avec: ${success ? 'SUCCÈS' : 'ÉCHEC'}`);
        process.exit(success ? 0 : 1);
    })
    .catch(error => {
        console.error('💥 Erreur non gérée:', error);
        process.exit(1);
    });