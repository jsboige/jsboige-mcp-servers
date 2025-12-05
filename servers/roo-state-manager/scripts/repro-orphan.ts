import { TaskInstructionIndex, computeInstructionPrefix } from '../src/utils/task-instruction-index.js';

const variations = [
    `Sous-tâche 0: Implémenter module 0`,
    `Mission secondaire 1: Développer composant 1`,
    `Tâche dérivée 2: Créer fonctionnalité 2`,
    `Sous-mission 3: Construire élément 3`
];

console.log('--- Testing computeInstructionPrefix ---');
variations.forEach((v, i) => {
    const normalized = computeInstructionPrefix(v);
    console.log(`Variation ${i}: "${v}" -> "${normalized}"`);
});

console.log('\n--- Testing TaskInstructionIndex ---');
const index = new TaskInstructionIndex();

variations.forEach((v, i) => {
    index.addInstruction(`parent-${i}`, v, v);
});

variations.forEach((v, i) => {
    const results = index.searchExactPrefix(v);
    console.log(`Searching for Variation ${i}: Found ${results.length} matches`);
    if (results.length === 0) {
        console.log(`FAILED to find: "${v}"`);
    }
});