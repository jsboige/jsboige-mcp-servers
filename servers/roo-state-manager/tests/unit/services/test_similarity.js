/**
 * 🧪 TEST SCRIPT SDDD - Validation Algorithme de Similarité
 * Test direct de l'algorithme sans dépendances MCP
 */

console.log('\n🧪 === TEST ALGORITHME SIMILARITÉ SDDD ===');

// Réimplémentation simplifiée pour test standalone
function extractSignificantWords(text) {
    const stopWords = new Set(['les', 'des', 'une', 'est', 'sont', 'avec', 'dans', 'pour', 'que', 'qui', 'sur', 'par', 'and', 'the', 'for', 'are', 'that', 'this', 'with']);
    
    return text
        .replace(/[^\w\s]/g, ' ') // Remplacer ponctuation par espaces
        .split(/\s+/)
        .filter(word => word.length > 3 && !stopWords.has(word))
        .filter((word, index, arr) => arr.indexOf(word) === index); // Supprimer doublons
}

function calculateSimilarity(text1, text2) {
    if (!text1 || !text2) return 0;
    if (text1 === text2) return 1;

    // Normalisation identique pour les deux textes
    const words1 = extractSignificantWords(text1.toLowerCase());
    const words2 = extractSignificantWords(text2.toLowerCase());

    if (words1.length === 0 || words2.length === 0) return 0;

    // Algorithme de mots communs avec pondération par longueur
    const commonWords = words1.filter(w => words2.includes(w));
    const totalUniqueWords = new Set([...words1, ...words2]).size;

    // Score basé sur mots communs pondérés par importance
    const commonWordsScore = commonWords.length / Math.max(words1.length, words2.length);
    
    // Bonus pour mots significatifs longs (>4 caractères)
    const significantCommonWords = commonWords.filter(w => w.length > 4);
    const significantBonus = significantCommonWords.length * 0.1;

    // Score final avec bonus
    const finalScore = Math.min(1.0, commonWordsScore + significantBonus);
    
    return finalScore;
}

// Test case 1: Cas réel de la mission
const text1 = "**mission debug critique : réparation du système hiérarchique à deux passes dans roo-state-manager**";
const text2 = "**mission corrective finale : validation et documentation des réparations mcp roo-state-manager**";
const similarity1 = calculateSimilarity(text1, text2);

console.log(`🎯 TEST 1 (Cas réel mission):`);
console.log(`   Text1: "${text1}"`);
console.log(`   Text2: "${text2}"`);
console.log(`   Mots text1:`, extractSignificantWords(text1.toLowerCase()));
console.log(`   Mots text2:`, extractSignificantWords(text2.toLowerCase()));
console.log(`   Mots communs:`, extractSignificantWords(text1.toLowerCase()).filter(w => extractSignificantWords(text2.toLowerCase()).includes(w)));
console.log(`   Similarité: ${similarity1.toFixed(3)} (seuil: 0.2)`);
console.log(`   Résultat: ${similarity1 > 0.2 ? '✅ MATCH' : '❌ NO MATCH'}`);

// Test case 2: Match évident
const text3 = "**mission debug critique système réparation";
const text4 = "**mission debug critique réparation système";
const similarity2 = calculateSimilarity(text3, text4);

console.log(`\n🎯 TEST 2 (Match évident):`);
console.log(`   Text3: "${text3}"`);
console.log(`   Text4: "${text4}"`);
console.log(`   Mots text3:`, extractSignificantWords(text3.toLowerCase()));
console.log(`   Mots text4:`, extractSignificantWords(text4.toLowerCase()));
console.log(`   Similarité: ${similarity2.toFixed(3)} (seuil: 0.2)`);
console.log(`   Résultat: ${similarity2 > 0.2 ? '✅ MATCH' : '❌ NO MATCH'}`);

// Test case 3: Pas de match
const text5 = "bonjour analyse git projet configuration";
const text6 = "mission powerpoint génération slides présentation";
const similarity3 = calculateSimilarity(text5, text6);

console.log(`\n🎯 TEST 3 (Pas de match):`);
console.log(`   Text5: "${text5}"`);
console.log(`   Text6: "${text6}"`);
console.log(`   Mots text5:`, extractSignificantWords(text5.toLowerCase()));
console.log(`   Mots text6:`, extractSignificantWords(text6.toLowerCase()));
console.log(`   Similarité: ${similarity3.toFixed(3)} (seuil: 0.2)`);
console.log(`   Résultat: ${similarity3 > 0.2 ? '✅ MATCH' : '❌ NO MATCH'}`);

console.log('\n🧪 === FIN TESTS SIMILARITÉ ===\n');

// Validation SDDD
if (similarity1 > 0.2 && similarity2 > 0.2 && similarity3 <= 0.2) {
    console.log('✅ 🎯 VALIDATION SDDD RÉUSSIE : Algorithme de similarité fonctionnel !');
    console.log(`📊 Résultats: Test1=${similarity1.toFixed(3)}, Test2=${similarity2.toFixed(3)}, Test3=${similarity3.toFixed(3)}`);
} else {
    console.log('❌ 🚨 ÉCHEC VALIDATION SDDD : Algorithme nécessite ajustement !');
    console.log(`📊 Résultats: Test1=${similarity1.toFixed(3)}, Test2=${similarity2.toFixed(3)}, Test3=${similarity3.toFixed(3)}`);
}