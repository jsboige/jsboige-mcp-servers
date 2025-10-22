import { decode } from 'html-entities';
import { parseEncodedAssistantMessage } from '../src/services/AssistantMessageParser.js';

// Exemple de contenu extrait du JSON de conversation
const rawContent = `
Je vais corriger le problème d'indentation des balises \`<details>\` dans le code TypeScript. Commençons par rechercher toutes les occurrences.

<update_todo_list>
<todos>
[x] Rechercher les balises <details> indentées dans TraceSummaryService.ts
[ ] Identifier toutes les méthodes concernées
[ ] Corriger l'indentation avec apply_diff pour chaque méthode
</todos>
</update_todo_list>

<search_files>
<path>d:/dev/roo-extensions/mcps/internal/servers/roo-state-manager/src/services</path>
<regex>^\\s{4,}<details></regex>
<file_pattern>*.ts</file_pattern>
</search_files>
`;

console.log("=== CONTENU BRUT ===");
console.log(rawContent.substring(0, 500));

console.log("\n=== APRÈS DÉCODAGE HTML ===");
const decoded = decode(rawContent);
console.log(decoded.substring(0, 500));

console.log("\n=== RECHERCHE DE BALISES ===");
console.log("Contient '<update_todo_list>' ?", decoded.includes('<update_todo_list>'));
console.log("Contient '<search_files>' ?", decoded.includes('<search_files>'));
console.log("Contient '<read_file>' ?", decoded.includes('<read_file>'));

console.log("\n=== TEST PARSER ===");
const parsed = parseEncodedAssistantMessage(rawContent);

console.log("Nombre de blocs parsés:", parsed.length);
for (let i = 0; i < parsed.length; i++) {
    const block = parsed[i];
    console.log(`\nBloc ${i + 1}:`);
    console.log("  Type:", block.type);
    
    if (block.type === 'tool_use') {
        console.log("  Nom outil:", block.name);
        console.log("  Paramètres:", Object.keys(block.params));
    } else {
        console.log("  Longueur texte:", block.content.length);
        console.log("  Premier 100 chars:", block.content.substring(0, 100));
    }
}