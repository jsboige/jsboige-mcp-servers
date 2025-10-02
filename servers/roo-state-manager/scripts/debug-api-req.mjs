import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function debugApiReq() {
  const fixturePath = path.join(__dirname, '../tests/fixtures/real-tasks/ac8aa7b4-319c-4925-a139-4f4adca81921/ui_messages.json');
  
  console.log('🔍 Debug api_req_started sur fixture\n');
  
  const content = await fs.readFile(fixturePath, 'utf8');
  const messages = JSON.parse(content);
  
  // Filtrer les messages api_req_started
  const apiMessages = messages.filter(m => m.say === 'api_req_started');
  console.log(`📊 Messages api_req_started: ${apiMessages.length}\n`);
  
  // Analyser les 2 premiers
  for (let i = 0; i < Math.min(2, apiMessages.length); i++) {
    const m = apiMessages[i];
    console.log(`--- Message ${i + 1} ---`);
    console.log(`Timestamp: ${m.ts}`);
    console.log(`Type: ${m.type}`);
    console.log(`Say: ${m.say}`);
    
    try {
      const apiData = JSON.parse(m.text);
      console.log(`✅ JSON Parse OK`);
      console.log(`Has request: ${!!apiData.request}`);
      
      if (apiData.request) {
        console.log(`Request (first 500 chars):\n${apiData.request.substring(0, 500)}`);
        
        // Chercher pattern newTask dans request
        const hasNewTask = apiData.request.includes('<new_task>') || 
                          apiData.request.includes('newTask') ||
                          apiData.request.includes('new_task');
        console.log(`\n🎯 Contains newTask pattern: ${hasNewTask}`);
        
        if (hasNewTask) {
          // Essayer d'extraire le tool name
          const toolMatch = apiData.request.match(/<(\w+)>/);
          if (toolMatch) {
            console.log(`✅ Found tool tag: <${toolMatch[1]}>`);
          }
        }
      }
    } catch (e) {
      console.log(`❌ JSON Parse Error: ${e.message}`);
    }
    console.log('\n' + '='.repeat(70) + '\n');
  }
}

debugApiReq().catch(console.error);