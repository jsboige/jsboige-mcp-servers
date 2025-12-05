"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var message_extraction_coordinator_js_1 = require("../src/utils/message-extraction-coordinator.js");
var simpleTaskMessage = {
    type: 'say',
    text: "Voici une t\u00E2che importante :\n  <task>\n  **MISSION CRITIQUE:**\n  R\u00E9parer le syst\u00E8me de fichiers.\n  </task>"
};
console.log('--- Test Simple Task Extraction ---');
var result = message_extraction_coordinator_js_1.messageExtractionCoordinator.extractFromMessage(simpleTaskMessage);
console.log('Instructions found:', result.instructions.length);
if (result.instructions.length > 0) {
    console.log('First instruction:', result.instructions[0]);
}
else {
    console.log('No instructions found.');
    console.log('Errors:', result.errors);
}
var newTaskMessage = {
    type: 'say',
    text: "Nouvelle t\u00E2che :\n  <new_task>\n  <mode>code</mode>\n  <message>Cr\u00E9er le fichier de config</message>\n  </new_task>"
};
console.log('\n--- Test New Task Extraction ---');
var result2 = message_extraction_coordinator_js_1.messageExtractionCoordinator.extractFromMessage(newTaskMessage);
console.log('Instructions found:', result2.instructions.length);
if (result2.instructions.length > 0) {
    console.log('First instruction:', result2.instructions[0]);
}
else {
    console.log('No instructions found.');
}
