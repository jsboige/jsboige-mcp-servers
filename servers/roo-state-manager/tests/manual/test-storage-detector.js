#!/usr/bin/env node
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';

// Correction pour __dirname dans les modules ES
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const buildPath = path.resolve(__dirname, '..', 'build');
const detectorPath = path.join(buildPath, 'utils', 'roo-storage-detector.js');

async function runTest() {
  console.log('🔬 Test 5: Analyse de la conversation de test manuelle...');
  
  try {
    // Importation dynamique car c'est un module JS compilé
    const { RooStorageDetector } = await import(pathToFileURL(detectorPath).href);
    
    const testTaskPath = path.resolve(__dirname, 'e2e', 'manual-test-storage', 'tasks', 'manual-test-task-456');
    const taskId = 'manual-test-task-456';

    const skeleton = await RooStorageDetector.analyzeConversation(taskId, testTaskPath);

    if (skeleton && skeleton.sequence.length > 0) {
      console.log('✅ Squelette de test généré avec succès !');
      console.log(`   - Nombre de messages: ${skeleton.metadata.messageCount}`);
      console.log(`   - Nombre d'actions: ${skeleton.metadata.actionCount}`);
      console.log('   - Extrait de la séquence:');
      console.log(JSON.stringify(skeleton.sequence.slice(0, 5), null, 2));
    } else {
      console.error('❌ Le squelette de test est vide ou invalide.');
      console.log(skeleton);
    }

  } catch (error) {
    console.error('\n❌ Une erreur est survenue pendant le test :', error);
  }
}

if (!fs.existsSync(buildPath)) {
  console.log('⚠️  Le répertoire build n\'existe pas. Veuillez compiler avec `npm run build`');
  process.exit(1);
} else {
  runTest();
}