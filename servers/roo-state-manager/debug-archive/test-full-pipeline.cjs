const fs = require('fs');
const path = require('path');

// === SIMULATION DU PIPELINE COMPLET ===

// 1. Fonction de normalisation (identique au code)
function computeInstructionPrefix(text, maxLength = 192) {
    return text
        .toLowerCase()
        .replace(/&[a-z]+;/gi, '')
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, maxLength);
}

// 2. Extraction des instructions newTask (identique au code)
function extractSubtaskInstructions(uiMessagesPath) {
    const instructions = [];
    
    if (!fs.existsSync(uiMessagesPath)) {
        return instructions;
    }

    try {
        const content = fs.readFileSync(uiMessagesPath, 'utf-8');
        const data = JSON.parse(content);
        
        if (Array.isArray(data)) {
            for (const message of data) {
                if (message.type === 'ask' && message.ask === 'tool') {
                    try {
                        let toolData = null;
                        
                        if (typeof message.text === 'object' && message.text) {
                            toolData = message.text;
                        } else if (typeof message.text === 'string') {
                            try { toolData = JSON.parse(message.text); } catch {}
                        }
                
                        if (toolData && toolData.tool === 'newTask' && toolData.content) {
                            instructions.push({
                                timestamp: message.ts || Date.now(),
                                mode: String(toolData.mode || 'task'),
                                message: String(toolData.content).substring(0, 200),
                                taskId: toolData.taskId
                            });
                        }
                    } catch (error) {
                        // Ignore
                    }
                }
            }
        }
    } catch (error) {
        console.error(`❌ Error:`, error);
    }
    
    return instructions;
}

// 3. Extraction instruction initiale enfant
function extractInitialInstruction(uiMessagesPath) {
    try {
        const content = fs.readFileSync(uiMessagesPath, 'utf-8');
        const messages = JSON.parse(content);
        
        const firstSay = messages.find(msg => 
            msg.type === 'say' && msg.say === 'text' && msg.text && msg.text.length > 20
        );
        
        return firstSay ? firstSay.text : null;
    } catch (error) {
        return null;
    }
}

console.log('🔬 TEST COMPLET DU PIPELINE HIERARCHIQUE\n');
console.log('=' .repeat(60) + '\n');

// Données réelles
const parentTaskId = 'ac8aa7b4-319c-4925-a139-4f4adca81921';
const childTaskId = 'bc93a6f7-cd2e-4686-a832-46e3cd14d338';
const basePath = 'C:\\Users\\jsboi\\AppData\\Roaming\\Code\\User\\globalStorage\\rooveterinaryinc.roo-cline\\tasks';

const parentUiPath = path.join(basePath, parentTaskId, 'ui_messages.json');
const childUiPath = path.join(basePath, childTaskId, 'ui_messages.json');

// PHASE 1: Indexation (comme dans executePhase1)
console.log('📍 PHASE 1: Indexation des instructions parent\n');

const parentInstructions = extractSubtaskInstructions(parentUiPath);
console.log(`✅ Extracted ${parentInstructions.length} newTask instructions from parent`);

// Simuler l'index avec Map simple (exact-trie fait la même chose)
const index = new Map();

parentInstructions.forEach((inst, i) => {
    const normalizedPrefix = computeInstructionPrefix(inst.message, 192);
    index.set(normalizedPrefix, parentTaskId);
    console.log(`   [${i + 1}] Indexed: "${normalizedPrefix.substring(0, 60)}..."`);
});

console.log(`\n✅ Index populated with ${index.size} entries\n`);

// PHASE 2: Recherche (comme dans executePhase2)
console.log('📍 PHASE 2: Recherche parent pour enfant\n');

const childInstruction = extractInitialInstruction(childUiPath);
if (!childInstruction) {
    console.log('❌ ERREUR: Instruction enfant introuvable');
    process.exit(1);
}

console.log(`✅ Child instruction: "${childInstruction.substring(0, 80)}..."`);

const childNormalized = computeInstructionPrefix(childInstruction, 192);
console.log(`✅ Child normalized: "${childNormalized.substring(0, 80)}..."\n`);

// Recherche exact prefix (simulation de exact-trie.getWithCheckpoints)
console.log('🔍 Searching for exact prefix match...\n');

let matchFound = false;
let matchedParentId = null;

for (const [prefix, taskId] of index.entries()) {
    // exact-trie avec getWithCheckpoints retourne le plus long préfixe
    // On simule en vérifiant si l'enfant commence par le préfixe parent
    if (childNormalized.startsWith(prefix)) {
        console.log(`✅ MATCH FOUND!`);
        console.log(`   Parent prefix: "${prefix.substring(0, 60)}..."`);
        console.log(`   Parent taskId: ${taskId}`);
        matchFound = true;
        matchedParentId = taskId;
        break; // Prend le premier match (dans exact-trie ce serait le plus long)
    }
}

if (!matchFound) {
    console.log('❌ NO MATCH FOUND - This explains why Hierarchy relations found: 0\n');
    
    // Debug: afficher tous les préfixes pour comprendre
    console.log('\n🔍 All indexed prefixes (first 80 chars):');
    let i = 1;
    for (const prefix of index.keys()) {
        console.log(`   [${i}] "${prefix.substring(0, 80)}..."`);
        i++;
    }
} else {
    console.log(`\n✅ SUCCESS: Child ${childTaskId} linked to parent ${matchedParentId}`);
}

console.log('\n' + '='.repeat(60));
console.log('📊 RÉSULTAT FINAL:', matchFound ? '✅ SUCCÈS' : '❌ ÉCHEC');