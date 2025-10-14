/**
 * Test d'intégration pour les 3 modes de parsing (Phase 2b)
 * - Mode ancien (legacy)
 * - Mode nouveau (MessageToSkeletonTransformer)
 * - Mode comparaison (ancien + nouveau avec rapport)
 */

import { RooStorageDetector } from './build/src/utils/roo-storage-detector.js';
import { getParsingConfig } from './build/src/utils/parsing-config.js';
import * as path from 'path';
import { promises as fs } from 'fs';

async function testMode(modeName, useNew, comparison) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`TEST MODE: ${modeName}`);
  console.log('='.repeat(60));
  
  // Configurer le mode via variables d'environnement
  process.env.USE_NEW_PARSING = useNew ? 'true' : 'false';
  process.env.PARSING_COMPARISON_MODE = comparison ? 'true' : 'false';
  process.env.LOG_PARSING_DIFFERENCES = comparison ? 'true' : 'false';
  process.env.PARSING_DIFFERENCE_TOLERANCE = '5';
  
  const config = getParsingConfig();
  console.log(`Configuration:`, JSON.stringify(config, null, 2));
  
  try {
    // Détecter les emplacements de stockage
    console.log('\n1. Détection des emplacements de stockage...');
    const locations = await RooStorageDetector.detectStorageLocations();
    console.log(`   ✅ ${locations.length} emplacements trouvés`);
    
    if (locations.length === 0) {
      console.log('   ⚠️  Aucun emplacement de stockage trouvé, test ignoré');
      return;
    }
    
    // Trouver une tâche pour tester
    console.log('\n2. Recherche d\'une tâche de test...');
    const firstLocation = locations[0];
    const tasksPath = path.join(firstLocation, 'tasks');
    const taskDirs = await fs.readdir(tasksPath);
    
    if (taskDirs.length === 0) {
      console.log('   ⚠️  Aucune tâche trouvée, test ignoré');
      return;
    }
    
    const taskId = taskDirs[0];
    const taskPath = path.join(tasksPath, taskId);
    console.log(`   ✅ Tâche trouvée: ${taskId.substring(0, 8)}...`);
    
    // Analyser la conversation
    console.log('\n3. Analyse de la conversation...');
    const startTime = Date.now();
    const skeleton = await RooStorageDetector.analyzeConversation(taskId, taskPath);
    const duration = Date.now() - startTime;
    
    if (!skeleton) {
      console.log('   ❌ Échec de l\'analyse');
      return;
    }
    
    console.log(`   ✅ Analyse réussie en ${duration}ms`);
    console.log(`   - Messages: ${skeleton.metadata.messageCount}`);
    console.log(`   - Actions: ${skeleton.metadata.actionCount}`);
    console.log(`   - Workspace: ${skeleton.metadata.workspace || 'N/A'}`);
    console.log(`   - Completed: ${skeleton.isCompleted ? 'Oui' : 'Non'}`);
    
    if (skeleton.truncatedInstruction) {
      console.log(`   - Instruction: ${skeleton.truncatedInstruction.substring(0, 50)}...`);
    }
    
    if (skeleton.childTaskInstructionPrefixes && skeleton.childTaskInstructionPrefixes.length > 0) {
      console.log(`   - Sous-tâches: ${skeleton.childTaskInstructionPrefixes.length}`);
    }
    
    console.log(`\n✅ Test ${modeName} réussi !`);
    
  } catch (error) {
    console.error(`\n❌ Erreur dans test ${modeName}:`, error);
    throw error;
  }
}

async function main() {
  console.log('🧪 Tests d\'intégration - Mode parallèle Phase 2b');
  console.log('='.repeat(60));
  
  try {
    // Test 1: Mode ancien (legacy)
    await testMode('ANCIEN (Legacy)', false, false);
    
    // Test 2: Mode nouveau (MessageToSkeletonTransformer)
    await testMode('NOUVEAU (Transformer)', true, false);
    
    // Test 3: Mode comparaison
    await testMode('COMPARAISON (Ancien + Nouveau)', true, true);
    
    console.log('\n' + '='.repeat(60));
    console.log('✅ TOUS LES TESTS ONT RÉUSSI !');
    console.log('='.repeat(60));
    
  } catch (error) {
    console.error('\n' + '='.repeat(60));
    console.error('❌ ÉCHEC DES TESTS');
    console.error(error);
    console.error('='.repeat(60));
    process.exit(1);
  }
}

main();