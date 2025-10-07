/**
 * TEST CRITIQUE : Reproduction exacte du pattern fonctionnel
 * Pattern identifié dans les fixtures contrôlées qui donnaient 7/7 relations
 */

import { TaskInstructionIndex, computeInstructionPrefix } from './build/src/utils/task-instruction-index.js';

// Données EXACTES extraites des fixtures fonctionnelles
const parentTask = {
    taskId: '305b3f90-e0e1-4870-8cf4-4fd33a08cfa4',
    instruction: `TEST-HIERARCHY-A: Tu es une branche de test A dans une hiérarchie de test en cascade. Ta mission PRINCIPALE et UNIQUE est de créer exactement 2 sous-tâches pour valider la reconstruction hiérarchique du MCP roo-state-manager.

### INSTRUCTIONS STRICTES :

1. **Créer TEST-LEAF-A1** en mode 'code' avec ce message exact :
   "TEST-LEAF-A1: Crée le fichier mcp-debugging/test-data/test-a1.py contenant une fonction validate_email() qui vérifie si un email est valide. La fonction doit retourner True/False et inclure des tests basiques. Termine avec attempt_completion en rapportant le chemin du fichier créé."

2. **Créer TEST-LEAF-A2** en mode 'ask' avec ce message exact :
   "TEST-LEAF-A2: Documente le processus de validation des emails en expliquant les étapes principales, les regex utilisés et les cas limites. Fournis une documentation technique complète. Termine avec attempt_completion en résumant ta documentation."`,
    parentTaskId: null
};

const childTask1 = {
    taskId: 'b423bff7-6fec-40fe-a00e-bb2a0ebb52f4',
    instruction: 'TEST-LEAF-A1: Crée le fichier mcp-debugging/test-data/test-a1.py contenant une fonction validate_email() qui vérifie si un email est valide. La fonction doit retourner True/False et inclure des tests basiques. Termine avec attempt_completion en rapportant le chemin du fichier créé.',
    parentTaskId: '305b3f90-e0e1-4870-8cf4-4fd33a08cfa4'
};

const childTask2 = {
    taskId: '8c06d62c-1ee2-4c3a-991e-c9483e90c8aa', 
    instruction: 'TEST-LEAF-B1a: Crée le fichier mcp-debugging/test-data/test-b1a.py contenant une fonction validate_phone() qui vérifie si un numéro de téléphone français est valide (format 06/07 suivi de 8 chiffres). Inclus des tests. Termine avec attempt_completion en rapportant le chemin du fichier.',
    parentTaskId: '38948ef0-4a8b-40a2-ae29-b38d2aa9d5a7' // Parent différent
};

async function testExactPattern() {
    console.log('🔬 TEST CRITIQUE : Pattern exact des fixtures fonctionnelles\n');
    
    try {
        const index = new TaskInstructionIndex();
        
        // 1. Index parent - utiliser addInstruction au lieu de indexTask
        console.log('📥 Indexation du parent...');
        const parentPrefix = computeInstructionPrefix(parentTask.instruction, 192);
        index.addInstruction(parentTask.taskId, parentPrefix, parentTask.instruction);
        console.log(`   Parent indexé: ${parentTask.taskId}`);
        console.log(`   Préfixe parent: "${parentPrefix.substring(0, 50)}..."`);
        
        // 2. Recherche enfants
        console.log('\n🔍 Recherche des enfants potentiels...');
        
        // Test avec l'instruction exacte de l'enfant
        const childPrefix = computeInstructionPrefix(childTask1.instruction, 192);
        console.log(`   Préfixe enfant: "${childPrefix.substring(0, 50)}..."`);
        
        const results = await index.searchExactPrefix(childPrefix);
        console.log(`   Résultats trouvés: ${results.length}`);
        
        if (results.length > 0) {
            console.log('✅ SUCCESS! Pattern reconnu:');
            results.forEach((result, i) => {
                console.log(`   ${i+1}. Parent: ${result.taskId}`);
                console.log(`      Préfixe: "${result.prefix.substring(0, 50)}..."`);
            });
        } else {
            console.log('❌ ÉCHEC: Aucun parent trouvé');
            
            // Debug détaillé
            console.log('\n🔬 ANALYSE DÉTAILLÉE:');
            console.log(`   Préfixe parent dans index: "${parentPrefix.substring(0, 50)}..."`);
            console.log(`   Préfixe enfant recherché: "${childPrefix.substring(0, 50)}..."`);
            
            // Chercher la substring commune
            const commonStart = findCommonPrefix(parentPrefix, childPrefix);
            console.log(`   Préfixe commun trouvé: "${commonStart}" (${commonStart.length} chars)`);
            
            if (commonStart.length < 10) {
                console.log('   ⚠️  PROBLÈME: Préfixes n\'ont pas de correspondance suffisante!');
            }
        }
        
    } catch (error) {
        console.error('💥 ERREUR:', error.message);
        console.error(error.stack);
    }
}

function findCommonPrefix(str1, str2) {
    let i = 0;
    while (i < str1.length && i < str2.length && str1[i] === str2[i]) {
        i++;
    }
    return str1.substring(0, i);
}

// Exécution
testExactPattern();