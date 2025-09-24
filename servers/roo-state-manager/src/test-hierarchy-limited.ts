/**
 * Test limité du système de reconstruction hiérarchique
 * Version allégée pour éviter les problèmes de mémoire
 */

import { HierarchyReconstructionEngine } from './utils/hierarchy-reconstruction-engine.js';
import { RooStorageDetector } from './utils/roo-storage-detector.js';

async function testHierarchyLimited() {
    console.log('🚀 Test de reconstruction hiérarchique LIMITÉ - DÉMARRAGE');
    console.log('=' .repeat(60));
    
    try {
        // 1. Charger un workspace spécifique uniquement
        const targetWorkspace = 'd:/dev/2025-Epita-Intelligence-Symbolique';
        console.log(`\n📋 ÉTAPE 1: Chargement des skeletons pour workspace: ${targetWorkspace}`);
        
        // Utiliser buildHierarchicalSkeletons avec le nouveau moteur
        console.log('🔧 Utilisation de buildHierarchicalSkeletons avec reconstruction...');
        const reconstructedSkeletons = await RooStorageDetector.buildHierarchicalSkeletons(
            targetWorkspace,
            false,  // Pas full volume (limite à 100 tâches)
            true    // Force rebuild
        );
        
        console.log(`✅ ${reconstructedSkeletons.length} skeletons traités`);
        
        // 2. Analyser les résultats
        const orphansAfter = reconstructedSkeletons.filter(s => !s.parentTaskId);
        const withParents = reconstructedSkeletons.filter(s => s.parentTaskId);
        
        console.log(`\n📊 RÉSULTATS DE LA RECONSTRUCTION:`);
        console.log(`   - Total de tâches: ${reconstructedSkeletons.length}`);
        console.log(`   - Tâches avec parent: ${withParents.length}`);
        console.log(`   - Tâches orphelines: ${orphansAfter.length}`);
        
        // 3. Afficher quelques exemples de tâches avec parents
        console.log('\n📌 EXEMPLES DE TÂCHES AVEC HIÉRARCHIE:');
        let exampleCount = 0;
        for (const skeleton of withParents.slice(0, 10)) {
            console.log(`   📌 ${skeleton.taskId.substring(0, 8)}...`);
            console.log(`      - Titre: "${skeleton.metadata.title?.substring(0, 50)}..."`);
            console.log(`      - Parent: ${skeleton.parentTaskId?.substring(0, 8)}...`);
            console.log(`      - Instruction: "${skeleton.truncatedInstruction?.substring(0, 50)}..."`);
            console.log('');
            exampleCount++;
        }
        
        // 4. Calculer la profondeur de l'arbre
        const treeDepth = calculateTreeDepth(reconstructedSkeletons);
        console.log(`\n🌳 Profondeur de l'arbre hiérarchique: ${treeDepth}`);
        
        // 5. Statistiques par workspace
        const workspaceStats = new Map<string, number>();
        for (const skeleton of reconstructedSkeletons) {
            const ws = skeleton.metadata.workspace || 'unknown';
            workspaceStats.set(ws, (workspaceStats.get(ws) || 0) + 1);
        }
        
        console.log('\n📊 Répartition par workspace:');
        for (const [ws, count] of workspaceStats.entries()) {
            console.log(`   - ${ws}: ${count} tâches`);
        }
        
        // 6. Résumé final
        console.log('\n' + '=' .repeat(60));
        const orphanPercentage = (orphansAfter.length / reconstructedSkeletons.length * 100).toFixed(1);
        const parentPercentage = (withParents.length / reconstructedSkeletons.length * 100).toFixed(1);
        
        console.log('📈 MÉTRIQUES FINALES:');
        console.log(`   - ${parentPercentage}% des tâches ont un parent`);
        console.log(`   - ${orphanPercentage}% des tâches sont orphelines`);
        console.log(`   - Profondeur maximale de l'arbre: ${treeDepth} niveaux`);
        
        if (treeDepth > 0 && withParents.length > 0) {
            console.log('\n🎉 SUCCÈS: Le système de reconstruction hiérarchique fonctionne!');
        } else {
            console.log('\n⚠️ ATTENTION: Aucune hiérarchie détectée');
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
testHierarchyLimited().catch(console.error);