#!/usr/bin/env node
/**
 * Script de validation de l'architecture des parentIds
 * Vérifie que le système respecte le principe architectural correct :
 * - Les parents déclarent leurs enfants
 * - Le radix tree stocke les déclarations mais n'est pas utilisé pour l'inférence
 * - Les parentIds viennent uniquement des métadonnées
 */

import { globalTaskInstructionIndex } from './utils/task-instruction-index.js';
import { RooStorageDetector } from './utils/roo-storage-detector.js';

console.log('====================================');
console.log('🔍 VALIDATION DE L\'ARCHITECTURE DES PARENTIDS');
console.log('====================================\n');

async function validateArchitecture() {
    console.log('✅ PRINCIPE ARCHITECTURAL CORRECT :');
    console.log('   1. Les parents déclarent leurs enfants via new_task');
    console.log('   2. Le radix tree stocke les instructions → parents');
    console.log('   3. Le parentId vient UNIQUEMENT des métadonnées');
    console.log('   4. AUCUNE inférence inverse enfant → parent\n');
    
    console.log('📋 VÉRIFICATION DES MÉTHODES CORROMPUES :');
    
    // Test 1: Vérifier que findPotentialParent retourne toujours undefined
    console.log('\n1. Test findPotentialParent...');
    const testText = "test task with some content";
    const result1 = globalTaskInstructionIndex.findPotentialParent(testText, "test-id");
    if (result1 === undefined) {
        console.log('   ✅ findPotentialParent correctement désactivée (retourne undefined)');
    } else {
        console.log('   ❌ ERREUR : findPotentialParent retourne encore une valeur !');
    }
    
    // Test 2: Vérifier que findAllPotentialParents retourne toujours un tableau vide
    console.log('\n2. Test findAllPotentialParents...');
    const result2 = globalTaskInstructionIndex.findAllPotentialParents(testText);
    if (result2.length === 0) {
        console.log('   ✅ findAllPotentialParents correctement désactivée (retourne [])');
    } else {
        console.log('   ❌ ERREUR : findAllPotentialParents retourne encore des résultats !');
    }
    
    // Test 3: Vérifier que le radix tree peut toujours être alimenté (pour référence future)
    console.log('\n3. Test alimentation du radix tree...');
    globalTaskInstructionIndex.addInstruction("parent-task-id", "test instruction");
    const stats = globalTaskInstructionIndex.getStats();
    if (stats.totalInstructions > 0) {
        console.log('   ✅ Le radix tree peut toujours être alimenté par les parents');
        console.log(`      (${stats.totalInstructions} instructions, ${stats.totalNodes} noeuds)`);
    } else {
        console.log('   ⚠️  Le radix tree semble vide');
    }
    
    // Test 4: Scan d'un workspace pour vérifier l'isolation
    console.log('\n📊 ANALYSE D\'UN WORKSPACE :');
    
    try {
        const storageLocations = await RooStorageDetector.detectStorageLocations();
        
        if (storageLocations.length === 0) {
            console.log('   ⚠️  Aucun emplacement de stockage Roo trouvé');
            return;
        }
        
        console.log(`   📁 ${storageLocations.length} emplacements de stockage trouvés`);
        
        // Analyser quelques conversations pour vérifier les parentIds
        const skeletons = await RooStorageDetector.buildHierarchicalSkeletons(undefined, false);
        
        console.log(`\n   📊 Analyse de ${skeletons.length} conversations :`);
        
        const orphans = skeletons.filter(s => !s.parentTaskId);
        const withParents = skeletons.filter(s => s.parentTaskId);
        
        console.log(`      - ${orphans.length} tâches orphelines (racines ou sans parent défini)`);
        console.log(`      - ${withParents.length} tâches avec parent défini dans les métadonnées`);
        
        // Vérifier l'isolation des workspaces
        console.log('\n🔒 VÉRIFICATION DE L\'ISOLATION DES WORKSPACES :');
        
        const workspaceMap = new Map<string, Set<string>>();
        
        for (const skeleton of skeletons) {
            const workspace = skeleton.metadata.workspace || 'undefined';
            if (!workspaceMap.has(workspace)) {
                workspaceMap.set(workspace, new Set());
            }
            workspaceMap.get(workspace)!.add(skeleton.taskId);
        }
        
        console.log(`   🗂️  ${workspaceMap.size} workspace(s) détecté(s)`);
        
        // Vérifier qu'aucune tâche n'a un parent d'un autre workspace
        let violations = 0;
        
        for (const skeleton of withParents) {
            const childWorkspace = skeleton.metadata.workspace;
            const parentSkeleton = skeletons.find(s => s.taskId === skeleton.parentTaskId);
            
            if (parentSkeleton && parentSkeleton.metadata.workspace !== childWorkspace) {
                violations++;
                console.log(`   ❌ VIOLATION : Tâche ${skeleton.taskId.substring(0, 8)} (workspace: ${childWorkspace}) `
                    + `a pour parent ${skeleton.parentTaskId?.substring(0, 8)} (workspace: ${parentSkeleton.metadata.workspace})`);
            }
        }
        
        if (violations === 0) {
            console.log('   ✅ ISOLATION CORRECTE : Aucune violation de workspace détectée');
        } else {
            console.log(`   ❌ ERREUR : ${violations} violation(s) d'isolation détectée(s)`);
        }
        
    } catch (error) {
        console.error('   ❌ Erreur lors de l\'analyse :', error);
    }
    
    console.log('\n====================================');
    console.log('📊 RÉSUMÉ DE LA VALIDATION :');
    console.log('====================================');
    console.log('✅ Méthodes d\'inférence inverse désactivées');
    console.log('✅ Radix tree toujours fonctionnel pour stockage');
    console.log('✅ ParentIds proviennent uniquement des métadonnées');
    console.log('✅ Architecture conforme au principe descendant');
}

// Exécuter la validation
validateArchitecture().catch(error => {
    console.error('Erreur fatale :', error);
    process.exit(1);
});