const fs = require('fs');
const path = require('path');

// Simuler la fonction d'extraction comme dans le code réel
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
                // Pattern principal : messages "ask" avec tool "newTask"
                if (message.type === 'ask' && message.ask === 'tool') {
                    try {
                        let toolData = null;
                        
                        if (typeof message.text === 'object' && message.text) {
                            toolData = message.text;
                        } else if (typeof message.text === 'string') {
                            try { toolData = JSON.parse(message.text); } catch {}
                        }
                
                        if (toolData && toolData.tool === 'newTask' && toolData.content) {
                            const content = String(toolData.content);
                            
                            instructions.push({
                                timestamp: message.ts || Date.now(),
                                mode: String(toolData.mode || 'task'),
                                message: content.substring(0, 200),
                                taskId: toolData.taskId
                            });
                            
                            console.log(`✅ Extracted newTask #${instructions.length}: "${content.substring(0, 50)}..."`);
                        }
                    } catch (error) {
                        console.error(`❌ Error parsing message:`, error.message);
                    }
                }
            }
        }
    } catch (error) {
        console.error(`❌ Error reading file:`, error);
        return instructions;
    }
    
    return instructions;
}

// Fonction de normalisation
function computeInstructionPrefix(text, maxLength = 192) {
    return text
        .toLowerCase()
        .replace(/&[a-z]+;/gi, '')
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, maxLength);
}

const parentUiPath = 'C:\\Users\\jsboi\\AppData\\Roaming\\Code\\User\\globalStorage\\rooveterinaryinc.roo-cline\\tasks\\ac8aa7b4-319c-4925-a139-4f4adca81921\\ui_messages.json';

console.log('📖 Extraction des instructions newTask du parent...\n');
const instructions = extractSubtaskInstructions(parentUiPath);

console.log(`\n✅ Total instructions extraites: ${instructions.length}\n`);

// Normaliser et afficher les 5 derniers
console.log('🔍 Les 5 derniers newTask normalisés:');
instructions.slice(-5).forEach((inst, index) => {
    const normalized = computeInstructionPrefix(inst.message, 192);
    console.log(`\n${instructions.length - 4 + index}. ${normalized.substring(0, 80)}...`);
});

// Comparer avec l'instruction enfant
const childUiPath = 'C:\\Users\\jsboi\\AppData\\Roaming\\Code\\User\\globalStorage\\rooveterinaryinc.roo-cline\\tasks\\bc93a6f7-cd2e-4686-a832-46e3cd14d338\\ui_messages.json';
const childMessages = JSON.parse(fs.readFileSync(childUiPath, 'utf-8'));
const firstChildSay = childMessages.find(msg => 
    msg.type === 'say' && msg.say === 'text' && msg.text && msg.text.length > 20
);

if (firstChildSay) {
    const childNormalized = computeInstructionPrefix(firstChildSay.text, 192);
    console.log(`\n\n🎯 Instruction enfant normalisée:\n${childNormalized.substring(0, 80)}...`);
    
    // Tester le match avec exact-trie simulation
    console.log('\n\n🔬 Test de matching:');
    let found = false;
    instructions.forEach((inst, index) => {
        const parentNormalized = computeInstructionPrefix(inst.message, 192);
        if (childNormalized.startsWith(parentNormalized.substring(0, 50))) {
            console.log(`✅ MATCH avec instruction #${index + 1}`);
            found = true;
        }
    });
    
    if (!found) {
        console.log('❌ AUCUN MATCH TROUVÉ');
    }
}