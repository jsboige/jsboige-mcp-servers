#!/usr/bin/env node

/**
 * Script de test pour diagnostiquer et corriger le RadixTree matching
 * 
 * HYPOTHÈSE: searchPrefix.startsWith(key) ne fonctionne pas car:
 * - Parents déclarent des prefixes longs/complexes
 * - Enfants ont des instructions courtes/simples  
 * - Pas de correspondance lexicale directe
 */

import { RooStorageDetector } from '../build/src/utils/roo-storage-detector.js';
import { globalTaskInstructionIndex, computeInstructionPrefix } from '../build/src/utils/task-instruction-index.js';

const testWorkspace = 'd:/dev/roo-extensions';

console.log(`🔧 TEST RADIXTREE MATCHING - Diagnostic et Correction`);
console.log(`   Timestamp: ${new Date().toISOString()}`);
console.log(`\n`);

try {
    // ÉTAPE 1: Reconstruire l'état actuel
    console.log(`📊 ÉTAPE 1: Reconstruction état actuel...`);
    globalTaskInstructionIndex.clear();
    
    const skeletons = await RooStorageDetector.buildHierarchicalSkeletons(testWorkspace, false);
    const parentsWithPrefixes = skeletons.filter(s => 
        s.childTaskInstructionPrefixes && s.childTaskInstructionPrefixes.length > 0
    );
    const childrenWithInstructions = skeletons.filter(s => 
        s.truncatedInstruction && s.truncatedInstruction.length > 10
    );
    
    console.log(`   Parents avec prefixes: ${parentsWithPrefixes.length}`);
    console.log(`   Enfants avec instructions: ${childrenWithInstructions.length}`);
    console.log(`   Relations actuelles: ${skeletons.filter(s => s.parentTaskId).length}`);
    
    if (parentsWithPrefixes.length === 0 || childrenWithInstructions.length === 0) {
        console.log(`❌ Données insuffisantes pour test matching`);
        process.exit(1);
    }
    
    // ÉTAPE 2: Test matching actuel (défaillant)
    console.log(`\n🔍 ÉTAPE 2: Test matching actuel (méthode défaillante)...`);
    
    let currentMatches = 0;
    for (const child of childrenWithInstructions.slice(0, 3)) {
        const matches = globalTaskInstructionIndex.searchExactPrefix(child.truncatedInstruction);
        console.log(`\n   Child: ${child.taskId}`);
        console.log(`     Instruction: "${child.truncatedInstruction.substring(0, 60)}..."`);
        console.log(`     Matches actuels: ${matches.length}`);
        currentMatches += matches.length;
    }
    
    console.log(`\n   Total matches actuels: ${currentMatches}`);
    
    // ÉTAPE 3: Test avec logique inversée (expérimental)
    console.log(`\n🧪 ÉTAPE 3: Test logique inversée (contient vs startsWith)...`);
    
    let inverseMatches = 0;
    
    // Récolter tous les prefixes des parents  
    const allPrefixes = [];
    for (const parent of parentsWithPrefixes) {
        for (const prefix of parent.childTaskInstructionPrefixes || []) {
            allPrefixes.push({
                parentId: parent.taskId,
                prefix: prefix
            });
        }
    }
    
    console.log(`   Total prefixes parents: ${allPrefixes.length}`);
    
    // Tester matching inversé pour chaque enfant
    for (const child of childrenWithInstructions.slice(0, 3)) {
        const childInstruction = child.truncatedInstruction.toLowerCase();
        const childWords = childInstruction.split(/\s+/).filter(w => w.length > 3); // Mots > 3 chars
        
        console.log(`\n   Child: ${child.taskId}`);
        console.log(`     Instruction: "${child.truncatedInstruction.substring(0, 60)}..."`);
        console.log(`     Mots clés: ${childWords.slice(0, 3).join(', ')}`);
        
        let bestMatches = [];
        
        // Pour chaque préfixe parent, calculer score de similarité
        for (const { parentId, prefix } of allPrefixes.slice(0, 10)) { // Limit pour performance
            const prefixLower = prefix.toLowerCase();
            
            // Score basé sur mots communs
            let commonWords = 0;
            for (const word of childWords.slice(0, 5)) { // Top 5 mots enfant
                if (prefixLower.includes(word)) {
                    commonWords++;
                }
            }
            
            // Score basé sur inclusion directe (plus strict)
            const directInclude = prefixLower.includes(childInstruction.substring(0, 30));
            
            if (commonWords >= 1 || directInclude) {
                bestMatches.push({
                    parentId,
                    score: directInclude ? 100 : commonWords * 10,
                    method: directInclude ? 'inclusion' : `${commonWords} mots`
                });
            }
        }
        
        // Trier par score décroissant
        bestMatches.sort((a, b) => b.score - a.score);
        const topMatch = bestMatches.slice(0, 2);
        
        console.log(`     Matches inversés: ${topMatch.length}`);
        topMatch.forEach((match, i) => {
            console.log(`       ${i+1}. Parent ${match.parentId} (score: ${match.score}, ${match.method})`);
        });
        
        inverseMatches += topMatch.length;
    }
    
    console.log(`\n   Total matches inversés: ${inverseMatches}`);
    
    // ÉTAPE 4: Comparaison et recommandations
    console.log(`\n📊 ÉTAPE 4: Comparaison méthodes...`);
    console.log(`   Méthode actuelle (startsWith): ${currentMatches} matches`);
    console.log(`   Méthode inversée (contient): ${inverseMatches} matches`);
    
    const improvement = inverseMatches > currentMatches;
    console.log(`   Amélioration: ${improvement ? '✅ OUI' : '❌ NON'} (+${inverseMatches - currentMatches})`);
    
    if (improvement) {
        console.log(`\n💡 RECOMMANDATIONS CORRECTION:`);
        console.log(`   1. Implémenter matching "contient" au lieu de "startsWith"`);
        console.log(`   2. Utiliser score de similarité (mots communs)`);
        console.log(`   3. Fallback sur inclusion directe pour cas simples`);
        console.log(`   4. Seuil minimum de 1-2 mots communs pour éviter faux positifs`);
        
        // ÉTAPE 5: Test de correction expérimentale
        console.log(`\n🔧 ÉTAPE 5: Implémentation correction expérimentale...`);
        console.log(`   Cette correction nécessite modification de searchExactPrefix()`);
        console.log(`   Fichier: src/utils/task-instruction-index.ts lignes 104-108`);
        console.log(`   Change: searchPrefix.startsWith(key) → key.includes(searchPrefix)`);
    } else {
        console.log(`\n❓ Le problème n'est PAS dans la logique de matching`);
        console.log(`   Autres causes possibles:`);
        console.log(`   - Normalisation des prefixes défaillante`);
        console.log(`   - Index trie corrompu ou vide`);
        console.log(`   - Extraction instructions incomplète`);
    }
    
    console.log(`\n✅ Test RadixTree matching terminé`);
    
} catch (error) {
    console.error(`\n❌ ERREUR TEST:`, error.message);
    console.error(`   Stack:`, error.stack?.split('\n').slice(0, 3).join('\n'));
    process.exit(1);
}