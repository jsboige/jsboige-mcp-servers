#!/usr/bin/env node

/**
 * Test rapide de diagnostic du bug de régression RadixTree
 */

import { TaskInstructionIndex, computeInstructionPrefix } from './build/src/utils/task-instruction-index.js';

console.log('🧪 === TEST RAPIDE DIAGNOSTIC BUG RÉGRESSION ===\n');

// 1. Créer une instance propre
const index = new TaskInstructionIndex();

// 2. Test simple avec données contrôlées
const parentText = "mission test hierarchie creation sous-taches validation";
const childText = "test-hierarchy-a: tu es une branche de test";

// 3. Ajouter instruction parent
const parentPrefix = computeInstructionPrefix(parentText, 192);
console.log(`📝 Parent prefix (${parentPrefix.length} chars): "${parentPrefix.substring(0, 50)}..."`);

index.addInstruction('parent-001', parentPrefix);

// 4. Stats après ajout
const stats = index.getStats();
console.log(`📊 Stats après ajout: ${stats.totalNodes} noeuds, ${stats.totalInstructions} instructions`);

// 5. Test recherche exact
const childPrefix = computeInstructionPrefix(childText, 192);
console.log(`🔍 Child prefix (${childPrefix.length} chars): "${childPrefix.substring(0, 50)}..."`);

const results = index.searchExactPrefix(childText, 192);
console.log(`🎯 Résultats recherche: ${results.length} matches trouvés`);

if (results.length > 0) {
    results.forEach((r, i) => {
        console.log(`   Match ${i+1}: taskId=${r.taskId}, prefix="${r.prefix.substring(0, 30)}..."`);
    });
} else {
    console.log('❌ AUCUN MATCH - Diagnostic du problème:');
    
    // Debug: vérifier si les préfixes sont identiques
    const exactMatch = parentPrefix === childPrefix;
    console.log(`   Préfixes identiques: ${exactMatch}`);
    console.log(`   Parent: "${parentPrefix}"`);  
    console.log(`   Child:  "${childPrefix}"`);
    
    // Debug: tester avec inclusion manuelle
    const includes = parentPrefix.includes(childPrefix.substring(0, 50));
    console.log(`   Parent contient Child (50 chars): ${includes}`);
}

console.log('\n🏁 Test rapide terminé');