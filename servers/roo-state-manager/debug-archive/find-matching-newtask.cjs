const fs = require('fs');

// Lire le fichier UI du parent (ac8aa7b4)
const parentUiPath = 'C:\\Users\\jsboi\\AppData\\Roaming\\Code\\User\\globalStorage\\rooveterinaryinc.roo-cline\\tasks\\ac8aa7b4-319c-4925-a139-4f4adca81921\\ui_messages.json';
const parentMessages = JSON.parse(fs.readFileSync(parentUiPath, 'utf-8'));

// Lire le fichier UI de l'enfant (bc93a6f7)
const childUiPath = 'C:\\Users\\jsboi\\AppData\\Roaming\\Code\\User\\globalStorage\\rooveterinaryinc.roo-cline\\tasks\\bc93a6f7-cd2e-4686-a832-46e3cd14d338\\ui_messages.json';
const childMessages = JSON.parse(fs.readFileSync(childUiPath, 'utf-8'));

// Extraire l'instruction initiale de l'enfant
const firstChildSay = childMessages.find(msg => 
    msg.type === 'say' && msg.say === 'text' && msg.text && msg.text.length > 20
);

if (!firstChildSay) {
    console.log('❌ Pas d\'instruction initiale trouvée pour l\'enfant');
    process.exit(1);
}

const childInstruction = firstChildSay.text;
console.log('📝 Instruction initiale enfant (200 premiers caractères):');
console.log(childInstruction.substring(0, 200));
console.log('\n');

// Extraire tous les newTask du parent
const newTaskMessages = parentMessages.filter(msg => {
    if (msg.type === 'ask' && msg.ask === 'tool') {
        try {
            let toolData = null;
            if (typeof msg.text === 'object') {
                toolData = msg.text;
            } else if (typeof msg.text === 'string') {
                toolData = JSON.parse(msg.text);
            }
            return toolData && toolData.tool === 'newTask';
        } catch {
            return false;
        }
    }
    return false;
});

console.log(`✅ Trouvé ${newTaskMessages.length} messages newTask dans le parent\n`);

// Fonction de normalisation (comme dans le code)
function normalize(text, maxLength = 192) {
    return text
        .toLowerCase()
        .replace(/&[a-z]+;/gi, '')
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, maxLength);
}

const normalizedChild = normalize(childInstruction, 192);
console.log('🔍 Instruction enfant normalisée (192 chars):');
console.log(normalizedChild);
console.log('\n');

// Chercher un match
let matchFound = false;
newTaskMessages.forEach((msg, index) => {
    let toolData = typeof msg.text === 'object' ? msg.text : JSON.parse(msg.text);
    const parentContent = toolData.content;
    const normalizedParent = normalize(parentContent, 192);
    
    // Vérifier si l'enfant commence par le parent (strict prefix)
    if (normalizedChild.startsWith(normalizedParent.substring(0, 50))) {
        console.log(`✅ MATCH TROUVÉ ! newTask #${index + 1}`);
        console.log('Parent content (200 premiers caractères):');
        console.log(parentContent.substring(0, 200));
        console.log('\nParent normalisé (192 chars):');
        console.log(normalizedParent);
        matchFound = true;
    } else {
        console.log(`❌ Pas de match pour newTask #${index + 1} (50 premiers chars): "${normalizedParent.substring(0, 50)}"`);
    }
});

if (!matchFound) {
    console.log('\n⚠️  AUCUN MATCH TROUVÉ ! Cela confirme le bug.');
}