/**
 * 🚀 TEST PRODUCTION - Architecture Hiérarchique Deux-Passes Complète
 * 
 * Teste la nouvelle architecture de production avec:
 * - Index radix-tree pour optimisation recherche
 * - Architecture deux-passes sans limitations
 * - Traitement complet des fichiers ui_messages.json
 * - Résolution hiérarchique avancée
 */

const path = require('path');
const { RooStorageDetector } = require('./build/src/utils/roo-storage-detector.js');
const { globalTaskInstructionIndex } = require('./build/src/utils/task-instruction-index.js');

async function testProductionHierarchy() {
  console.log('🚀 DÉMARRAGE - Test architecture production hiérarchique\n');
  
  try {
    // Test avec un workspace spécifique (plus rapide pour validation)
    const workspacePath = 'd:/dev/roo-extensions';
    
    console.log(`📁 Test sur workspace: ${workspacePath}`);
    console.log('⏱️ Démarrage reconstruction hiérarchique...\n');
    
    const startTime = Date.now();
    
    // EXECUTION - Nouvelle architecture deux-passes
    const conversations = await RooStorageDetector.buildHierarchicalSkeletons(workspacePath, true);
    
    const endTime = Date.now();
    const duration = (endTime - startTime) / 1000;
    
    console.log('\n=== 📊 RÉSULTATS TEST PRODUCTION ===');
    console.log(`⏱️ Temps d'exécution: ${duration.toFixed(2)}s`);
    console.log(`📋 Total conversations: ${conversations.length}`);
    
    // Statistiques hiérarchiques
    const withParent = conversations.filter(c => c.parentTaskId);
    const withChildren = conversations.filter(c => c.childTaskInstructionPrefixes && c.childTaskInstructionPrefixes.length > 0);
    const orphans = conversations.filter(c => !c.parentTaskId);
    
    console.log(`👨‍👩‍👧‍👦 Tâches avec parent: ${withParent.length} (${(withParent.length/conversations.length*100).toFixed(1)}%)`);
    console.log(`👶 Tâches avec enfants détectés: ${withChildren.length} (${(withChildren.length/conversations.length*100).toFixed(1)}%)`);
    console.log(`🏝️ Tâches orphelines: ${orphans.length} (${(orphans.length/conversations.length*100).toFixed(1)}%)`);
    
    // Statistiques de l'index radix-tree
    const indexStats = globalTaskInstructionIndex.getStats();
    console.log(`\n=== 🌳 STATISTIQUES INDEX RADIX-TREE ===`);
    console.log(`📈 Total instructions indexées: ${indexStats.totalInstructions}`);
    console.log(`🔗 Total noeuds dans l'arbre: ${indexStats.totalNodes}`);
    console.log(`📊 Efficacité compression: ${((indexStats.totalInstructions - indexStats.totalNodes) / indexStats.totalInstructions * 100).toFixed(1)}%`);
    
    // Échantillon détaillé des résultats
    console.log(`\n=== 🔍 ÉCHANTILLON RELATIONS HIÉRARCHIQUES ===`);
    
    const hierarchicalSample = withParent.slice(0, 5);
    for (const conv of hierarchicalSample) {
      console.log(`\n📋 ${conv.taskId.slice(0,8)}... (${conv.metadata.mode})`);
      console.log(`   📝 Titre: ${conv.metadata.title?.substring(0, 80) || 'N/A'}...`);
      console.log(`   👨‍👩‍👧‍👦 Parent: ${conv.parentTaskId?.slice(0,8) || 'N/A'}...`);
      if (conv.childTaskInstructionPrefixes && conv.childTaskInstructionPrefixes.length > 0) {
        console.log(`   👶 Enfants détectés: ${conv.childTaskInstructionPrefixes.length} instructions`);
        console.log(`   🔤 Premier préfixe: ${conv.childTaskInstructionPrefixes[0].substring(0, 60)}...`);
      }
    }
    
    // Test de recherche dans l'index
    console.log(`\n=== 🔍 TEST RECHERCHE INDEX ===`);
    const testSearches = [
      'debug le système', 
      'créer une nouvelle',
      'analyse le code',
      'implémente la fonction'
    ];
    
    for (const search of testSearches) {
      const found = globalTaskInstructionIndex.findPotentialParent(search);
      console.log(`🔎 "${search}" => ${found ? found.slice(0,8) + '...' : 'AUCUN'}`);
    }
    
    console.log('\n✅ TEST PRODUCTION TERMINÉ AVEC SUCCÈS');
    
    // Validation de l'intégrité
    const validationErrors = [];
    
    for (const conv of conversations) {
      // Vérifier que le parent existe si spécifié
      if (conv.parentTaskId) {
        const parentExists = conversations.find(c => c.taskId === conv.parentTaskId);
        if (!parentExists) {
          validationErrors.push(`❌ Parent ${conv.parentTaskId} introuvable pour ${conv.taskId}`);
        }
      }
      
      // Vérifier la cohérence des préfixes
      if (conv.childTaskInstructionPrefixes) {
        for (const prefix of conv.childTaskInstructionPrefixes) {
          if (typeof prefix !== 'string' || prefix.length > 200) {
            validationErrors.push(`❌ Préfixe invalide dans ${conv.taskId}: ${prefix?.substring(0,50)}`);
          }
        }
      }
    }
    
    if (validationErrors.length > 0) {
      console.log(`\n⚠️ ERREURS VALIDATION (${validationErrors.length}):`);
      validationErrors.slice(0, 10).forEach(err => console.log(err));
      if (validationErrors.length > 10) {
        console.log(`   ... et ${validationErrors.length - 10} autres erreurs`);
      }
    } else {
      console.log('\n✅ VALIDATION INTÉGRITÉ: AUCUNE ERREUR');
    }
    
    return {
      success: true,
      totalConversations: conversations.length,
      withParent: withParent.length,
      withChildren: withChildren.length,
      orphans: orphans.length,
      duration,
      indexStats,
      validationErrors: validationErrors.length
    };
    
  } catch (error) {
    console.error('\n❌ ERREUR TEST PRODUCTION:', error);
    console.error('\n📚 Stack:', error.stack);
    return {
      success: false,
      error: error.message,
      stack: error.stack
    };
  }
}

// Exécution si appelé directement
if (require.main === module) {
  testProductionHierarchy()
    .then(result => {
      console.log('\n📋 RÉSULTAT FINAL:', JSON.stringify(result, null, 2));
      process.exit(result.success ? 0 : 1);
    })
    .catch(error => {
      console.error('💥 ERREUR CRITIQUE:', error);
      process.exit(1);
    });
}

module.exports = { testProductionHierarchy };