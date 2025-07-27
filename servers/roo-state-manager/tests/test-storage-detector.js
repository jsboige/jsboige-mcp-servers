#!/usr/bin/env node
import * as path from 'path';
import { fileURLToPath } from 'url';
import RooStorageDetector from '../src/utils/roo-storage-detector.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runTest() {
  console.log('🚀 Démarrage du test pour RooStorageDetector.analyzeConversation...');

  try {
    const testStoragePath = path.resolve(__dirname, 'e2e', 'manual-test-storage');
    console.log(`Utilisation du répertoire de stockage de test : ${testStoragePath}`);
    
    // Initialisation du détecteur avec le chemin de test
    const detector = new RooStorageDetector(testStoragePath);

    const testTaskId = 'manual-test-task-456';
    console.log(`Analyse de la tâche : ${testTaskId}`);

    // Appel de la méthode à tester
    const conversationData = await detector.analyzeConversation(testTaskId);

    console.log('\n--- RÉSULTAT DE L\'ANALYSE ---');
    console.log(JSON.stringify(conversationData, null, 2));
    console.log('--- FIN DU RÉSULTAT ---');

    if (conversationData && conversationData.sequence && conversationData.sequence.length > 0) {
      console.log('\n✅ SUCCÈS : La séquence de la conversation a été générée et n\'est pas vide.');
    } else {
      console.error('\n❌ ÉCHEC : La séquence de la conversation est vide ou non définie.');
    }

  } catch (error) {
    console.error('\n❌ Une erreur est survenue pendant le test :', error);
  }
}

runTest();