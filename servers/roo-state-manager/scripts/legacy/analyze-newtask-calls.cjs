#!/usr/bin/env node
/**
 * Script d'analyse des appels newTask dans ui_messages.json
 * Usage: node analyze-newtask-calls.cjs <filepath>
 */

const fs = require('fs');
const readline = require('readline');

const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: node analyze-newtask-calls.cjs <filepath>');
  process.exit(1);
}

console.log(`Analyse de: ${filePath}`);
console.log('Recherche de TOUTES les occurrences de {\\"tool\\":\\"newTask\\"...\n');

let newTaskCount = 0;
const taskIds = [];
let lineNumber = 0;

const rl = readline.createInterface({
  input: fs.createReadStream(filePath),
  crlfDelay: Infinity
});

rl.on('line', (line) => {
  lineNumber++;
  
  // Chercher TOUTES les occurrences dans la ligne (pas juste la première)
  // Pattern: {\"tool\":\"newTask\" (avec backslashes échappés)
  const pattern = /\{\\"tool\\":\\"newTask\\"/g;
  const matches = line.match(pattern);
  
  if (matches && matches.length > 0) {
    console.log(`📍 Ligne ${lineNumber}: ${matches.length} occurrence(s) trouvée(s)\n`);
    
    // Pour chaque occurrence, essayer d'extraire le contexte
    let searchStart = 0;
    let occurrence = 0;
    
    while (true) {
      const idx = line.indexOf('{\\"tool\\":\\"newTask\\"', searchStart);
      if (idx === -1) break;
      
      occurrence++;
      newTaskCount++;
      
      // Extraire un contexte autour (300 chars avant et après)
      const contextStart = Math.max(0, idx - 50);
      const contextEnd = Math.min(line.length, idx + 400);
      const context = line.substring(contextStart, contextEnd);
      
      // Chercher taskId dans ce contexte
      const taskIdMatch = context.match(/\\"taskId\\":\\"([a-f0-9\-]{36})\\"/);
      if (taskIdMatch) {
        const taskId = taskIdMatch[1];
        taskIds.push(taskId);
        console.log(`[${newTaskCount}] Occurrence ${occurrence}: taskId = ${taskId}`);
      } else {
        console.log(`[${newTaskCount}] Occurrence ${occurrence}: taskId NON TROUVÉ dans le contexte`);
      }
      
      // Afficher un extrait du contexte
      const shortContext = context.substring(0, 200).replace(/\n/g, ' ');
      console.log(`    Contexte: ...${shortContext}...\n`);
      
      searchStart = idx + 20; // Avancer pour la prochaine occurrence
    }
  }
});

rl.on('close', () => {
  console.log('\n=== RÉSUMÉ ===');
  console.log(`Total newTask trouvés: ${newTaskCount}`);
  console.log(`TaskIds identifiés: ${taskIds.length}`);
  
  if (taskIds.length > 0) {
    console.log('\nListe des taskIds:');
    taskIds.forEach(id => console.log(`  - ${id}`));
  }
  
  if (taskIds.length < newTaskCount) {
    console.log(`\n⚠️  ATTENTION: ${newTaskCount - taskIds.length} occurrence(s) sans taskId identifiable dans le contexte`);
  }
});