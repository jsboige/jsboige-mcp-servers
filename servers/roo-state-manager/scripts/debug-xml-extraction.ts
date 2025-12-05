import { messageExtractionCoordinator } from '../src/utils/message-extraction-coordinator.js';

const simpleTaskMessage = {
  type: 'say',
  text: `Voici une tâche importante :
  <task>
  **MISSION CRITIQUE:**
  Réparer le système de fichiers.
  </task>`
};

console.log('--- Test Simple Task Extraction ---');
const result = messageExtractionCoordinator.extractFromMessage(simpleTaskMessage);
console.log('Instructions found:', result.instructions.length);
if (result.instructions.length > 0) {
  console.log('First instruction:', result.instructions[0]);
} else {
  console.log('No instructions found.');
  console.log('Errors:', result.errors);
}

const newTaskMessage = {
  type: 'say',
  text: `Nouvelle tâche :
  <new_task>
  <mode>code</mode>
  <message>Créer le fichier de config</message>
  </new_task>`
};

console.log('\n--- Test New Task Extraction ---');
const result2 = messageExtractionCoordinator.extractFromMessage(newTaskMessage);
console.log('Instructions found:', result2.instructions.length);
if (result2.instructions.length > 0) {
  console.log('First instruction:', result2.instructions[0]);
} else {
  console.log('No instructions found.');
}