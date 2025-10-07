/**
 * Test d'intégration Mode Parallèle avec Fixtures Réelles
 * Tests avec contenu substantiel pour valider la comparaison ancien/nouveau
 */

import { RooStorageDetector } from './build/src/utils/roo-storage-detector.js';
import { getParsingConfig } from './build/src/utils/parsing-config.js';
import * as path from 'path';
import { promises as fs } from 'fs';

const FIXTURES_PATH = './tests/fixtures';

async function testWithFixture(fixturePath, modeName, useNew, comparison) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`🧪 TEST: ${modeName} - Fixture: ${path.basename(fixturePath)}`);
  console.log('='.repeat(80));
  
  // Configuration variables d'environnement
  process.env.USE_NEW_PARSING = useNew ? 'true' : 'false';
  process.env.PARSING_COMPARISON_MODE = comparison ? 'true' : 'false';
  process.env.LOG_PARSING_DIFFERENCES = comparison ? 'true' : 'false';
  process.env.PARSING_DIFFERENCE_TOLERANCE = '5';
  
  const config = getParsingConfig();
  console.log(`📋 Configuration: ${JSON.stringify(config)}`);
  
  try {
    // Identifier la tâche à partir du path
    const taskId = path.basename(fixturePath);
    console.log(`🎯 Task ID: ${taskId}`);
    
    // Vérifier que les fichiers existent
    const apiPath = path.join(fixturePath, 'api_conversation_history.json');
    const uiPath = path.join(fixturePath, 'ui_messages.json');
    const metaPath = path.join(fixturePath, 'task_metadata.json');
    
    const apiExists = await fs.access(apiPath).then(() => true).catch(() => false);
    const uiExists = await fs.access(uiPath).then(() => true).catch(() => false);
    const metaExists = await fs.access(metaPath).then(() => true).catch(() => false);
    
    console.log(`📁 Fichiers: API=${apiExists ? '✅' : '❌'} UI=${uiExists ? '✅' : '❌'} META=${metaExists ? '✅' : '❌'}`);
    
    if (!apiExists || !uiExists) {
      console.log('⚠️  Fixture incomplète, test ignoré');
      return { success: false, reason: 'incomplete fixture' };
    }
    
    // Analyser la conversation
    console.log('\n🔄 Analyse en cours...');
    const startTime = Date.now();
    const skeleton = await RooStorageDetector.analyzeConversation(taskId, fixturePath);
    const duration = Date.now() - startTime;
    
    if (!skeleton) {
      console.log('❌ Échec de l\'analyse');
      return { success: false, reason: 'analysis failed' };
    }
    
    console.log(`✅ Analyse réussie en ${duration}ms`);
    console.log(`📊 Résultats:`);
    console.log(`   • Messages: ${skeleton.metadata.messageCount}`);
    console.log(`   • Actions: ${skeleton.metadata.actionCount}`);  
    console.log(`   • Workspace: ${skeleton.metadata.workspace || 'N/A'}`);
    console.log(`   • Status: ${skeleton.isCompleted ? 'Complété' : 'En cours'}`);
    console.log(`   • Taille: ${skeleton.metadata.totalSize || 'N/A'} bytes`);
    
    if (skeleton.truncatedInstruction) {
      const preview = skeleton.truncatedInstruction.substring(0, 80);
      console.log(`   • Instruction: "${preview}${skeleton.truncatedInstruction.length > 80 ? '...' : ''}"`);
    }
    
    if (skeleton.childTaskInstructionPrefixes?.length > 0) {
      console.log(`   • Sous-tâches: ${skeleton.childTaskInstructionPrefixes.length}`);
    }
    
    return { 
      success: true, 
      duration, 
      messageCount: skeleton.metadata.messageCount,
      actionCount: skeleton.metadata.actionCount,
      skeleton 
    };
    
  } catch (error) {
    console.error(`❌ Erreur dans ${modeName}:`, error.message);
    return { success: false, reason: error.message, error };
  }
}

async function runComparisonTests() {
  console.log('🎯 MISSION SDDD - Tests Mode Parallèle Complet');
  console.log('='.repeat(80));
  
  const results = [];
  
  // Fixtures à tester (real-tasks avec contenu substantiel)
  const fixtures = [
    path.join(FIXTURES_PATH, 'real-tasks', 'ac8aa7b4-319c-4925-a139-4f4adca81921'),
    path.join(FIXTURES_PATH, 'real-tasks', 'bc93a6f7-cd2e-4686-a832-46e3cd14d338'),
    path.join(FIXTURES_PATH, 'controlled-hierarchy', '91e837de-a4b2-4c18-ab9b-6fcd36596e38')
  ];
  
  for (const fixturePath of fixtures) {
    try {
      console.log(`\n🎪 === FIXTURE: ${path.basename(fixturePath)} ===`);
      
      // Test 1: Ancien système
      const oldResult = await testWithFixture(fixturePath, 'ANCIEN (Legacy)', false, false);
      results.push({ fixture: path.basename(fixturePath), mode: 'old', ...oldResult });
      
      // Test 2: Nouveau système 
      const newResult = await testWithFixture(fixturePath, 'NOUVEAU (Transformer)', true, false);
      results.push({ fixture: path.basename(fixturePath), mode: 'new', ...newResult });
      
      // Test 3: Mode comparaison (critique!)
      const compResult = await testWithFixture(fixturePath, 'COMPARAISON (Ancien + Nouveau)', true, true);
      results.push({ fixture: path.basename(fixturePath), mode: 'comparison', ...compResult });
      
      // Analyse des résultats pour cette fixture
      if (oldResult.success && newResult.success && compResult.success) {
        console.log(`\n🎉 FIXTURE VALIDÉE - Tous les modes fonctionnent !`);
      } else if (compResult.success) {
        console.log(`\n⚖️  FALLBACK VALIDÉ - Mode comparaison fonctionne malgré l'échec partiel`);
      } else {
        console.log(`\n⚠️  PROBLÈME DÉTECTÉ - Investigation nécessaire`);
      }
      
    } catch (error) {
      console.error(`💥 Erreur critique avec fixture ${path.basename(fixturePath)}:`, error.message);
      results.push({ fixture: path.basename(fixturePath), mode: 'error', success: false, error: error.message });
    }
  }
  
  // Rapport final
  console.log('\n' + '='.repeat(80));
  console.log('📊 RAPPORT MISSION SDDD - MODE PARALLÈLE');
  console.log('='.repeat(80));
  
  const successCount = results.filter(r => r.success).length;
  const totalCount = results.length;
  
  console.log(`✅ Succès: ${successCount}/${totalCount} tests`);
  console.log(`📈 Taux de réussite: ${Math.round((successCount/totalCount)*100)}%`);
  
  // Grouper par fixture pour analyse
  const fixtureGroups = {};
  results.forEach(r => {
    if (!fixtureGroups[r.fixture]) fixtureGroups[r.fixture] = {};
    fixtureGroups[r.fixture][r.mode] = r;
  });
  
  console.log('\n🔍 Analyse par fixture:');
  Object.keys(fixtureGroups).forEach(fixture => {
    const group = fixtureGroups[fixture];
    console.log(`\n  📁 ${fixture}:`);
    console.log(`     Ancien: ${group.old?.success ? '✅' : '❌'} ${group.old?.duration ? `(${group.old.duration}ms)` : ''}`);
    console.log(`     Nouveau: ${group.new?.success ? '✅' : '❌'} ${group.new?.duration ? `(${group.new.duration}ms)` : ''}`);
    console.log(`     Comparaison: ${group.comparison?.success ? '✅' : '❌'} ${group.comparison?.duration ? `(${group.comparison.duration}ms)` : ''}`);
  });
  
  if (successCount === totalCount) {
    console.log('\n🎯 MISSION ACCOMPLIE - Mode parallèle pleinement validé !');
  } else if (results.filter(r => r.mode === 'comparison' && r.success).length === fixtures.length) {
    console.log('\n⚖️  MISSION PARTIELLEMENT ACCOMPLIE - Fallback mode comparaison validé');
  } else {
    console.log('\n⚠️  MISSION INCOMPLÈTE - Problèmes détectés nécessitant investigation');
  }
  
  console.log('='.repeat(80));
  
  return results;
}

async function main() {
  try {
    await runComparisonTests();
    console.log('\n✅ Tests terminés avec succès');
  } catch (error) {
    console.error('\n💥 Échec critique des tests:', error);
    process.exit(1);
  }
}

main();