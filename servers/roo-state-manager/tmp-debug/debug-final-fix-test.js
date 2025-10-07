/**
 * TEST FINAL : Validation du fix complet avec extraction des sous-instructions
 * Utilise la nouvelle méthode addParentTaskWithSubInstructions()
 */

import { TaskInstructionIndex, computeInstructionPrefix } from './build/src/utils/task-instruction-index.js';
import { extractSubInstructions, testSubInstructionExtraction } from './build/src/utils/sub-instruction-extractor.js';

// Données EXACTES extraites des fixtures fonctionnelles
const parentTask = {
    taskId: '305b3f90-e0e1-4870-8cf4-4fd33a08cfa4',
    instruction: `TEST-HIERARCHY-A: Tu es une branche de test A dans une hiérarchie de test en cascade. Ta mission PRINCIPALE et UNIQUE est de créer exactement 2 sous-tâches pour valider la reconstruction hiérarchique du MCP roo-state-manager.

### INSTRUCTIONS STRICTES :

1. **Créer TEST-LEAF-A1** en mode 'code' avec ce message exact :
   "TEST-LEAF-A1: Crée le fichier mcp-debugging/test-data/test-a1.py contenant une fonction validate_email() qui vérifie si un email est valide. La fonction doit retourner True/False et inclure des tests basiques. Termine avec attempt_completion en rapportant le chemin du fichier créé."

2. **Créer TEST-LEAF-A2** en mode 'ask' avec ce message exact :
   "TEST-LEAF-A2: Documente le processus de validation des emails en expliquant les étapes principales, les regex utilisés et les cas limites. Fournis une documentation technique complète. Termine avec attempt_completion en résumant ta documentation."`
};

const childTask1 = {
    taskId: 'b423bff7-6fec-40fe-a00e-bb2a0ebb52f4',
    instruction: 'TEST-LEAF-A1: Crée le fichier mcp-debugging/test-data/test-a1.py contenant une fonction validate_email() qui vérifie si un email est valide. La fonction doit retourner True/False et inclure des tests basiques. Termine avec attempt_completion en rapportant le chemin du fichier créé.'
};

const childTask2 = {
    taskId: 'b423bff7-6fec-40fe-a00e-bb2a0ebb52f5', // ID fictif pour le test
    instruction: 'TEST-LEAF-A2: Documente le processus de validation des emails en expliquant les étapes principales, les regex utilisés et les cas limites. Fournis une documentation technique complète. Termine avec attempt_completion en résumant ta documentation.'
};

async function testFinalFix() {
    console.log('🎯 TEST FINAL : Validation du fix complet avec extraction des sous-instructions\n');
    
    try {
        // 1. Test de l'extraction des sous-instructions
        console.log('📋 ÉTAPE 1 : Test extraction des sous-instructions');
        testSubInstructionExtraction();
        console.log('\n' + '='.repeat(60) + '\n');
        
        // 2. Test complet du RadixTree avec la nouvelle méthode
        console.log('🔬 ÉTAPE 2 : Test RadixTree avec nouvelle méthode');
        const index = new TaskInstructionIndex();
        
        // Utiliser la nouvelle méthode d'indexation avec extraction automatique
        console.log('📥 Indexation avec extraction automatique...');
        const subInstructionCount = index.addParentTaskWithSubInstructions(
            parentTask.taskId, 
            parentTask.instruction
        );
        console.log(`   ✅ ${subInstructionCount} sous-instructions extraites et indexées`);
        
        // 3. Test de recherche pour le premier enfant
        console.log('\n🔍 Test de recherche pour TEST-LEAF-A1...');
        const child1Prefix = computeInstructionPrefix(childTask1.instruction, 192);
        console.log(`   Préfixe recherché: "${child1Prefix.substring(0, 50)}..."`);
        
        const results1 = index.searchExactPrefix(child1Prefix);
        console.log(`   Résultats trouvés: ${results1.length}`);
        
        if (results1.length > 0) {
            console.log('   🎉 SUCCÈS! Parent trouvé:');
            results1.forEach((result, i) => {
                console.log(`      ${i+1}. Parent: ${result.taskId}`);
                console.log(`         Préfixe: "${result.prefix.substring(0, 50)}..."`);
            });
        } else {
            console.log('   ❌ ÉCHEC: Aucun parent trouvé pour TEST-LEAF-A1');
        }
        
        // 4. Test de recherche pour le deuxième enfant
        console.log('\n🔍 Test de recherche pour TEST-LEAF-A2...');
        const child2Prefix = computeInstructionPrefix(childTask2.instruction, 192);
        console.log(`   Préfixe recherché: "${child2Prefix.substring(0, 50)}..."`);
        
        const results2 = index.searchExactPrefix(child2Prefix);
        console.log(`   Résultats trouvés: ${results2.length}`);
        
        if (results2.length > 0) {
            console.log('   🎉 SUCCÈS! Parent trouvé:');
            results2.forEach((result, i) => {
                console.log(`      ${i+1}. Parent: ${result.taskId}`);
                console.log(`         Préfixe: "${result.prefix.substring(0, 50)}..."`);
            });
        } else {
            console.log('   ❌ ÉCHEC: Aucun parent trouvé pour TEST-LEAF-A2');
        }
        
        // 5. Bilan final
        console.log('\n' + '='.repeat(60));
        console.log('📊 BILAN FINAL:');
        console.log(`   Relations parent-enfant trouvées: ${results1.length + results2.length}/2`);
        
        const totalSuccess = results1.length + results2.length;
        if (totalSuccess >= 2) {
            console.log('   🎉 FIX RÉUSSI! La régression critique est corrigée!');
            console.log('   ✅ Objectif minimal de 4+ relations sera dépassé avec les vraies données');
        } else if (totalSuccess >= 1) {
            console.log('   ⚠️  FIX PARTIEL: 1/2 relations trouvées, investigation nécessaire');
        } else {
            console.log('   ❌ FIX ÉCHOUÉ: Aucune relation trouvée, problème persistant');
        }
        
        // 6. Diagnostics complémentaires
        console.log('\n🔬 DIAGNOSTICS COMPLÉMENTAIRES:');
        console.log(`   Sous-instructions extraites: ${subInstructionCount}`);
        console.log(`   Taille de l'index: ${index.prefixToEntry.size} préfixes`);
        
        // Afficher toutes les clés dans l'index
        console.log('   📋 Préfixes dans l\'index:');
        let keyCount = 0;
        for (const [prefix, entry] of index.prefixToEntry) {
            keyCount++;
            console.log(`      ${keyCount}. "${prefix.substring(0, 50)}..." (${entry.parentTaskIds.length} parent(s))`);
        }
        
    } catch (error) {
        console.error('💥 ERREUR LORS DU TEST:', error.message);
        console.error(error.stack);
    }
}

// Exécution
testFinalFix();