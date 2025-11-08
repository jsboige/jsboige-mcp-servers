/**
 * Script de validation massive : Compare l'ancien et le nouveau système de parsing
 * sur toutes les fixtures disponibles
 * 
 * Usage:
 *   node scripts/compare-parsing-systems.mjs
 */

import { RooStorageDetector } from '../build/src/utils/roo-storage-detector.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Compare les deux systèmes de parsing sur toutes les fixtures
 */
async function main() {
  console.log('=== COMPARISON MASSIVE : Ancien vs Nouveau Système ===\n');
  
  // Activer le mode comparaison
  process.env.PARSING_COMPARISON_MODE = 'true';
  process.env.LOG_PARSING_DIFFERENCES = 'true';
  process.env.PARSING_DIFFERENCE_TOLERANCE = '5';
  
  
  // Trouver toutes les fixtures
  const fixturesDir = path.join(__dirname, '../tests/fixtures/real-tasks');
  
  if (!existsSync(fixturesDir)) {
    console.error(`❌ Le répertoire des fixtures n'existe pas : ${fixturesDir}`);
    process.exit(1);
  }
  
  const taskDirs = await fs.readdir(fixturesDir);
  
  let totalTasks = 0;
  let successCount = 0;
  let failureCount = 0;
  const problematicTasks = [];
  const comparisonStats = {
    identical: 0,
    minorDifferences: 0,
    majorDifferences: 0,
    criticalDifferences: 0,
  };
  
  console.log(`📁 Trouvé ${taskDirs.length} répertoires de tâches\n`);
  
  for (const taskDir of taskDirs) {
    const taskPath = path.join(fixturesDir, taskDir);
    const uiMessagesPath = path.join(taskPath, 'ui_messages.json');
    
    try {
      const exists = await fs.access(uiMessagesPath).then(() => true).catch(() => false);
      if (!exists) {
        console.log(`⏭️  Skipping ${taskDir} (no ui_messages.json)`);
        continue;
      }
      
      totalTasks++;
      console.log(`\n[${ totalTasks}/${taskDirs.length}] Analysing ${taskDir}...`);
      
      // Analyser avec les deux systèmes (mode comparaison activé)
      const skeleton = await RooStorageDetector.analyzeConversation(
        taskDir,
        taskPath,
        false // useProductionHierarchy=false pour les tests
      );
      
      if (skeleton) {
        successCount++;
        
        // Les différences sont loggées automatiquement en mode comparaison
        // On pourrait analyser le skeleton retourné pour des stats supplémentaires
        
        console.log(`✅ Analyse réussie pour ${taskDir}`);
        console.log(`   - ${skeleton.metadata.messageCount} messages`);
        console.log(`   - ${skeleton.childTaskInstructionPrefixes?.length || 0} child task prefixes`);
        console.log(`   - Completed: ${skeleton.isCompleted ? 'Yes' : 'No'}`);
      } else {
        failureCount++;
        problematicTasks.push({ taskDir, error: 'Skeleton generation returned null' });
        console.log(`⚠️  Skeleton null pour ${taskDir}`);
      }
      
    } catch (error) {
      failureCount++;
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`❌ Erreur pour ${taskDir}:`, errorMessage);
      problematicTasks.push({ taskDir, error: errorMessage });
    }
  }
  
  // Afficher le résumé
  console.log('\n\n=== RÉSULTATS DE LA VALIDATION MASSIVE ===');
  console.log(`\n📊 Statistiques Globales:`);
  console.log(`   - Total tâches analysées : ${totalTasks}`);
  console.log(`   - Succès : ${successCount} (${((successCount/totalTasks)*100).toFixed(1)}%)`);
  console.log(`   - Échecs : ${failureCount} (${((failureCount/totalTasks)*100).toFixed(1)}%)`);
  
  if (problematicTasks.length > 0) {
    console.log(`\n⚠️  Tâches problématiques (${problematicTasks.length}):`);
    problematicTasks.forEach(t => {
      console.log(`   - ${t.taskDir}: ${t.error}`);
    });
  }
  
  console.log('\n📝 Note: Les différences détaillées entre ancien et nouveau système');
  console.log('   ont été loggées ci-dessus pour chaque tâche analysée.');
  
  console.log('\n✅ Validation massive terminée.\n');
  
  // Code de sortie
  process.exit(failureCount > 0 ? 1 : 0);
}

main().catch(error => {
  console.error('❌ Erreur fatale:', error);
  process.exit(1);
});