/**
 * Script de test pour valider le système de reconstruction hiérarchique
 */

import { HierarchyReconstructionEngine } from './utils/hierarchy-reconstruction-engine.js';
import { RooStorageDetector } from './utils/roo-storage-detector.js';

async function testHierarchyReconstruction() {
    console.log('🚀 Test de reconstruction hiérarchique - DÉMARRAGE');
    console.log('=' .repeat(60));
    
    try {
        // 1. Charger tous les skeletons disponibles
        console.log('\n📋 ÉTAPE 1: Chargement des skeletons...');
        const allSkeletons = await RooStorageDetector.buildHierarchicalSkeletons();
        console.log(`✅ ${allSkeletons.length} skeletons chargés`);
        
        // 2. Identifier les tâches orphelines (avant reconstruction)
        const orphansBefore = allSkeletons.filter(s => !s.parentTaskId);
        console.log(`\n⚠️ AVANT RECONSTRUCTION:`);
        console.log(`   - ${orphansBefore.length} tâches orphelines`);
        console.log(`   - ${allSkeletons.length - orphansBefore.length} tâches avec parent`);
        
        // 3. Lancer la reconstruction avec le nouveau moteur
        console.log('\n🔧 ÉTAPE 2: Reconstruction en cours...');
        const reconstructedSkeletons = await HierarchyReconstructionEngine.reconstructHierarchy(
            undefined, // Pas de filtre workspace
            true       // Force rebuild
        );
        
        // 4. Analyser les résultats
        const orphansAfter = reconstructedSkeletons.filter(s => !s.parentTaskId);
        const reconstructedCount = reconstructedSkeletons.filter(s => {
            // Chercher les tâches qui avaient un parentTaskId null avant mais pas après
            const original = allSkeletons.find(orig => orig.taskId === s.taskId);
            return !original?.parentTaskId && s.parentTaskId;
        }).length;
        
        console.log(`\n✅ APRÈS RECONSTRUCTION:`);
        console.log(`   - ${orphansAfter.length} tâches orphelines (${orphansBefore.length - orphansAfter.length} corrigées)`);
        console.log(`   - ${reconstructedCount} parentIds reconstruits`);
        console.log(`   - ${allSkeletons.length - orphansAfter.length} tâches avec parent`);
        
        // 5. Calculer la profondeur de l'arbre
        const treeDepth = calculateTreeDepth(reconstructedSkeletons);
        console.log(`   - Profondeur de l'arbre: ${treeDepth}`);
        
        // 6. Afficher quelques exemples de reconstruction
        console.log('\n📊 EXEMPLES DE RECONSTRUCTION:');
        let exampleCount = 0;
        for (const skeleton of reconstructedSkeletons) {
            const original = allSkeletons.find(orig => orig.taskId === skeleton.taskId);
            if (!original?.parentTaskId && skeleton.parentTaskId && exampleCount < 5) {
                console.log(`   📌 ${skeleton.taskId.substring(0, 8)}...`);
                console.log(`      - Instruction: "${skeleton.truncatedInstruction?.substring(0, 50)}..."`);
                console.log(`      - Parent trouvé: ${skeleton.parentTaskId.substring(0, 8)}...`);
                exampleCount++;
            }
        }
        
        // 7. Résumé final
        console.log('\n' + '=' .repeat(60));
        if (reconstructedCount > 0) {
            console.log('🎉 SUCCÈS: Le système a reconstruit des hiérarchies manquantes!');
            console.log(`📈 Performance: ${reconstructedCount}/${orphansBefore.length} tâches orphelines corrigées`);
        } else {
            console.log('⚠️ ATTENTION: Aucune reconstruction effectuée');
            console.log('Vérifiez que les tâches ont bien des instructions tronquées dans leurs premiers messages');
        }
        
    } catch (error) {
        console.error('❌ ERREUR lors du test:', error);
        console.error('Stack trace:', (error as Error).stack);
    }
}

/**
 * Calcule la profondeur maximale de l'arbre
 */
function calculateTreeDepth(skeletons: any[]): number {
    const taskMap = new Map<string, any>();
    for (const skeleton of skeletons) {
        taskMap.set(skeleton.taskId, skeleton);
    }

    let maxDepth = 0;
    
    const calculateDepth = (taskId: string, currentDepth: number = 0, visited: Set<string> = new Set()): number => {
        if (visited.has(taskId)) {
            return currentDepth; // Éviter les cycles
        }
        visited.add(taskId);
        
        const task = taskMap.get(taskId);
        if (!task || !task.parentTaskId) {
            return currentDepth;
        }
        return calculateDepth(task.parentTaskId, currentDepth + 1, visited);
    };

    for (const skeleton of skeletons) {
        const depth = calculateDepth(skeleton.taskId);
        if (depth > maxDepth) {
            maxDepth = depth;
        }
    }

    return maxDepth;
}

// Lancer le test
testHierarchyReconstruction().catch(console.error);