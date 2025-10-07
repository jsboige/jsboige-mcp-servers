import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function debugToolCalls() {
  const fixturePath = path.join(__dirname, '../tests/fixtures/real-tasks/ac8aa7b4-319c-4925-a139-4f4adca81921/ui_messages.json');
  
  console.log('🔍 Debug extractToolCalls sur fixture\n');
  
  const content = await fs.readFile(fixturePath, 'utf8');
  const messages = JSON.parse(content);
  
  console.log(`📊 Total messages: ${messages.length}\n`);
  
  // Filtrer les messages ask:tool
  const askToolMessages = messages.filter(m => m.ask === 'tool');
  console.log(`🎯 Messages avec ask:'tool': ${askToolMessages.length}\n`);
  
  // Analyser les 3 premiers
  for (let i = 0; i < Math.min(3, askToolMessages.length); i++) {
    const m = askToolMessages[i];
    console.log(`--- Message ${i + 1} ---`);
    console.log(`Timestamp: ${m.ts}`);
    console.log(`Type: ${m.type}`);
    console.log(`Ask: ${m.ask}`);
    console.log(`Text (first 200 chars): ${m.text?.substring(0, 200)}`);
    
    try {
      const toolData = JSON.parse(m.text);
      console.log(`✅ JSON Parse OK`);
      console.log(`Tool: ${toolData.tool}`);
      console.log(`Mode: ${toolData.mode}`);
      console.log(`Has content: ${!!toolData.content}`);
      console.log(`Has message: ${!!toolData.message}`);
      
      // Vérifier la condition du filtre
      const hasMode = !!toolData.mode;
      const hasMessage = !!(toolData.message || toolData.content);
      const isNewTask = toolData.tool === 'new_task' || toolData.tool === 'newTask';
      
      console.log(`\n🧪 Tests de filtrage:`);
      console.log(`  - isNewTask: ${isNewTask}`);
      console.log(`  - hasMode: ${hasMode}`);
      console.log(`  - hasMessage: ${hasMessage}`);
      console.log(`  - PASSE FILTRE: ${isNewTask && hasMode && hasMessage}`);
    } catch (e) {
      console.log(`❌ JSON Parse Error: ${e.message}`);
    }
    console.log('');
  }
}

debugToolCalls().catch(console.error);