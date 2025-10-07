// Test avec nouveaux seuils recalibrés
process.env.PARSING_COMPARISON_MODE = 'true';
process.env.LOG_PARSING_DIFFERENCES = 'true';
process.env.PARSING_SIMILARITY_THRESHOLD = '45'; // Nouveau seuil
process.env.VALIDATE_IMPROVEMENTS = 'true';
process.env.MIN_CHILD_TASKS_IMPROVEMENT = '10';

const { RooStorageDetector } = require('./dist/utils/roo-storage-detector.js');

const detector = new RooStorageDetector();

async function testWithNewThresholds() {
  console.log('=== TEST NOUVEAUX SEUILS RECALIBRÉS ===\n');
  
  const testPath = 'tests/fixtures/real-tasks/ac8aa7b4-319c-4925-a139-4f4adca81921/ui_messages.json';
  
  try {
    const result = await detector.analyzeConversation(
      'test-seuils-recalibrés',
      'd:/dev/roo-extensions',
      testPath
    );
    
    console.log('\n✅ RÉSULTAT AVEC NOUVEAUX SEUILS :');
    console.log(`Child tasks: ${result.childTaskInstructionPrefixes.length}`);
    console.log(`Workspace: ${result.metadata?.workspace}`);
    console.log(`Truncated: ${result.truncatedInstruction}`);
    
  } catch (error) {
    console.error('❌ Erreur:', error.message);
  }
}

testWithNewThresholds();