const fs = require('fs');
const path = require('path');

// Lire le fichier UI du parent (ac8aa7b4) pour trouver un new_task
const parentUiPath = 'C:\\Users\\jsboi\\AppData\\Roaming\\Code\\User\\globalStorage\\rooveterinaryinc.roo-cline\\tasks\\ac8aa7b4-319c-4925-a139-4f4adca81921\\ui_messages.json';

console.log('📖 Lecture du fichier UI parent...');
const content = fs.readFileSync(parentUiPath, 'utf-8');
const messages = JSON.parse(content);

console.log(`📊 Total messages: ${messages.length}`);

// Chercher les messages new_task
const newTaskMessages = messages.filter(msg => {
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

console.log(`\n✅ Trouvé ${newTaskMessages.length} messages newTask`);

if (newTaskMessages.length > 0) {
    console.log('\n📝 Premier exemple de newTask:');
    const first = newTaskMessages[0];
    console.log(JSON.stringify(first, null, 2));
    
    console.log('\n📝 Contenu du tool:');
    let toolData = typeof first.text === 'object' ? first.text : JSON.parse(first.text);
    console.log(JSON.stringify(toolData, null, 2));
}

// Maintenant lire le fichier UI de l'enfant pour l'instruction initiale
console.log('\n\n📖 Lecture du fichier UI enfant (bc93a6f7)...');
const childUiPath = 'C:\\Users\\jsboi\\AppData\\Roaming\\Code\\User\\globalStorage\\rooveterinaryinc.roo-cline\\tasks\\bc93a6f7-cd2e-4686-a832-46e3cd14d338\\ui_messages.json';

const childContent = fs.readFileSync(childUiPath, 'utf-8');
const childMessages = JSON.parse(childContent);

console.log(`📊 Total messages enfant: ${childMessages.length}`);

// Trouver la première instruction (premier message say avec texte)
const firstSay = childMessages.find(msg => 
    msg.type === 'say' && msg.say === 'text' && msg.text && msg.text.length > 20
);

if (firstSay) {
    console.log('\n📝 Première instruction enfant:');
    console.log(firstSay.text.substring(0, 300) + '...');
}