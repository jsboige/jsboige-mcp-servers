const fs = require('fs');
const path = require('path');

const rootPath = 'mcps/internal/servers/roo-state-manager/tests/integration/fixtures/controlled-hierarchy/91e837de-a4b2-4c18-ab9b-6fcd36596e38/ui_messages.json';
const branchAPath = 'mcps/internal/servers/roo-state-manager/tests/integration/fixtures/controlled-hierarchy/305b3f90-e0e1-4870-8cf4-4fd33a08cfa4/ui_messages.json';

const rootContent = JSON.parse(fs.readFileSync(rootPath, 'utf8'));
const branchAContent = JSON.parse(fs.readFileSync(branchAPath, 'utf8'));

// Extract instruction from ROOT (Message 3)
const rootMsg = rootContent.messages.find(m => m.id === 'msg-3');
const rootToolData = JSON.parse(rootMsg.text);
const rootInstruction = rootToolData.content;

// Extract instruction from BRANCH_A (Message 1)
const branchAMsg = branchAContent.messages[0];
const branchAInstruction = branchAMsg.text;

console.log('ROOT Instruction:', rootInstruction);
console.log('BRANCH_A Instruction:', branchAInstruction);

if (rootInstruction === branchAInstruction) {
    console.log('Strings are IDENTICAL');
} else {
    console.log('Strings are DIFFERENT');
    console.log('Length ROOT:', rootInstruction.length);
    console.log('Length BRANCH_A:', branchAInstruction.length);

    for (let i = 0; i < Math.max(rootInstruction.length, branchAInstruction.length); i++) {
        if (rootInstruction[i] !== branchAInstruction[i]) {
            console.log(`Difference at index ${i}: ROOT=${rootInstruction.charCodeAt(i)} (${rootInstruction[i]}), BRANCH_A=${branchAInstruction.charCodeAt(i)} (${branchAInstruction[i]})`);
            break;
        }
    }
}