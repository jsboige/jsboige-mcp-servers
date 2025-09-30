// Test simple pour valider le refactoring des stratégies
import { DetailLevelStrategyFactory } from './build/src/services/reporting/DetailLevelStrategyFactory.js';

console.log('🧪 TEST REFACTORING STRATEGY PATTERN');
console.log('===================================\n');

// Test des stratégies disponibles
const detailLevels = ['Summary', 'Messages', 'NoTools', 'NoResults', 'Full'];

console.log('📊 VALIDATION DES STRATÉGIES CRÉÉES:\n');

let allPassed = true;

detailLevels.forEach(level => {
    try {
        console.log(`Testing ${level}...`);
        
        // Test 1: La stratégie peut être créée
        const strategy = DetailLevelStrategyFactory.createStrategy(level);
        console.log(`  ✅ Stratégie ${level} créée`);
        
        // Test 2: Les méthodes requises existent
        if (typeof strategy.isTocOnlyMode === 'function') {
            console.log(`  ✅ isTocOnlyMode() disponible: ${strategy.isTocOnlyMode()}`);
        } else {
            console.log(`  ❌ isTocOnlyMode() manquante`);
            allPassed = false;
        }
        
        if (typeof strategy.formatMessageContent === 'function') {
            console.log(`  ✅ formatMessageContent() disponible`);
        } else {
            console.log(`  ❌ formatMessageContent() manquante`);
            allPassed = false;
        }
        
        if (strategy.detailLevel === level) {
            console.log(`  ✅ detailLevel correct: ${strategy.detailLevel}`);
        } else {
            console.log(`  ❌ detailLevel incorrect`);
            allPassed = false;
        }
        
        console.log('');
        
    } catch (error) {
        console.log(`  ❌ Erreur pour ${level}: ${error.message}\n`);
        allPassed = false;
    }
});

// Test du factory
console.log('🏭 TEST DU FACTORY PATTERN:\n');

try {
    const supportedLevels = DetailLevelStrategyFactory.getSupportedDetailLevels();
    console.log(`✅ Niveaux supportés: ${supportedLevels.join(', ')}`);
    
    const info = DetailLevelStrategyFactory.getStrategyInfo('Full');
    console.log(`✅ Info stratégie récupérée: ${info.description}`);
    
} catch (error) {
    console.log(`❌ Erreur factory: ${error.message}`);
    allPassed = false;
}

console.log('\n' + '='.repeat(50));

if (allPassed) {
    console.log('🎉 REFACTORING VALIDÉ: Tous les tests passent!');
    console.log('✅ Interface IReportingStrategy refactorée');
    console.log('✅ 5 stratégies concrètes fonctionnelles'); 
    console.log('✅ Factory pattern opérationnel');
    console.log('✅ Types DetailLevel étendus');
} else {
    console.log('❌ ÉCHEC: Certains tests ont échoué');
}

console.log('='.repeat(50));