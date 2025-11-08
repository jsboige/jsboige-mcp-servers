import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Lit les N premières lignes d'un fichier JSON SANS tout charger en mémoire
 */
async function readFirstLines(filePath, lineCount = 10) {
  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });
  
  const lines = [];
  let count = 0;
  
  for await (const line of rl) {
    lines.push(line);
    count++;
    if (count >= lineCount) {
      rl.close();
      fileStream.destroy();
      break;
    }
  }
  
  return lines.join('\n');
}

async function main() {
  const fixturePath = path.join(__dirname, '../tests/fixtures/real-tasks/ac8aa7b4-319c-4925-a139-4f4adca81921/ui_messages.json');
  
  console.log('=== INSPECTION FORMAT FIXTURE ===\n');
  console.log(`Fixture : ${fixturePath}\n`);
  
  try {
    const firstLines = await readFirstLines(fixturePath, 20);
    
    console.log('--- 20 Premières Lignes ---');
    console.log(firstLines);
    console.log('\n--- Fin des 20 premières lignes ---\n');
    
    // Essayer de parser juste le début pour comprendre la structure
    let structure;
    try {
      // Si c'est un array JSON valide, on devrait voir [ au début
      if (firstLines.trim().startsWith('[')) {
        console.log('✅ Détecté : Array JSON');
        
        // Essayer de parser au moins le premier élément
        const firstElement = firstLines.match(/\[\s*(\{[^}]+\})/s);
        if (firstElement) {
          const parsed = JSON.parse(firstElement[1]);
          console.log('\n📦 Structure premier élément :');
          console.log(JSON.stringify(parsed, null, 2));
        }
      } else {
        console.log('❌ Format non-reconnu');
      }
    } catch (e) {
      console.error('Erreur parsing partiel:', e.message);
    }
    
    // Chercher les patterns connus
    console.log('\n--- Patterns Détectés ---');
    if (firstLines.includes('"ask"')) {
      console.log('✅ Contient "ask"');
    }
    if (firstLines.includes('"say"')) {
      console.log('✅ Contient "say"');
    }
    if (firstLines.includes('"tool"')) {
      console.log('✅ Contient "tool"');
    }
    if (firstLines.includes('"new_task"')) {
      console.log('✅ Contient "new_task"');
    }
    if (firstLines.includes('"api_req_started"')) {
      console.log('✅ Contient "api_req_started"');
    }
    
  } catch (error) {
    console.error('❌ Erreur lecture:', error.message);
  }
}

main().catch(console.error);