/**
 * Test manuel de la logique extractMainInstructionFromUI
 * Valide le fallback api_req_started
 */

import { RooStorageDetector } from '../../build/src/utils/roo-storage-detector.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const testDir = path.join(__dirname, 'temp-test-data');

async function setup() {
  await fs.mkdir(testDir, { recursive: true });
}

async function cleanup() {
  await fs.rm(testDir, { recursive: true, force: true });
}

async function testCompleteInstruction() {
  console.log('\n🧪 Test 1: Instruction complète dans say/text');
  
  const filePath = path.join(testDir, 'complete.json');
  const messages = [
    {
      ts: 1759082704597,
      type: 'say',
      say: 'text',
      text: 'Ceci est une instruction complète et suffisamment longue pour être utilisée directement'
    }
  ];

  await fs.writeFile(filePath, JSON.stringify(messages));
  const result = await RooStorageDetector.extractMainInstructionFromUI(filePath);

  console.log(`   Résultat: "${result}"`);
  console.log(`   ✅ Test réussi: Contient "instruction complète": ${result?.includes('instruction complète')}`);
  console.log(`   ✅ Longueur > 50: ${(result?.length || 0) > 50}`);
}

async function testTruncatedWithFallback() {
  console.log('\n🧪 Test 2: Instruction tronquée avec fallback api_req_started');
  
  const filePath = path.join(testDir, 'truncated.json');
  const messages = [
    {
      ts: 1759082704597,
      type: 'say',
      say: 'text',
      text: 'MISSION ARCHITECTURALE CRITIQUE...'
    },
    {
      ts: 1759082711779,
      type: 'say',
      say: 'api_req_started',
      text: JSON.stringify({
        request: '<task>\nMISSION ARCHITECTURALE CRITIQUE : Refactoriser le système de cache pour améliorer les performances\n</task>\n\n<environment_details>\n# VSCode Visible Files\n\n\n# VSCode Open Tabs\n</environment_details>',
        apiProtocol: 'openai',
        tokensIn: 56553,
        tokensOut: 413
      })
    }
  ];

  await fs.writeFile(filePath, JSON.stringify(messages));
  const result = await RooStorageDetector.extractMainInstructionFromUI(filePath);

  console.log(`   Résultat: "${result}"`);
  console.log(`   ✅ Contient "Refactoriser": ${result?.includes('Refactoriser')}`);
  console.log(`   ✅ Ne contient pas "<task>": ${!result?.includes('<task>')}`);
  console.log(`   ✅ Ne contient pas "...": ${!result?.includes('...')}`);
}

async function testEllipsisWithFallback() {
  console.log('\n🧪 Test 3: Instruction avec "..." déclenchant le fallback');
  
  const filePath = path.join(testDir, 'ellipsis.json');
  const messages = [
    {
      ts: 1759082704597,
      type: 'say',
      say: 'text',
      text: 'Cette instruction est suffisamment longue mais se termine par des points de suspension...'
    },
    {
      ts: 1759082711779,
      type: 'say',
      say: 'api_req_started',
      text: JSON.stringify({
        request: '<task>\nCette instruction est suffisamment longue mais se termine par des points de suspension et contient la suite complète du texte avec tous les détails nécessaires\n</task>',
        apiProtocol: 'openai'
      })
    }
  ];

  await fs.writeFile(filePath, JSON.stringify(messages));
  const result = await RooStorageDetector.extractMainInstructionFromUI(filePath);

  console.log(`   Résultat: "${result}"`);
  console.log(`   ✅ Contient "suite complète": ${result?.includes('suite complète')}`);
  console.log(`   ✅ Ne contient pas "...": ${!result?.includes('...')}`);
}

async function testNoApiReqFallback() {
  console.log('\n🧪 Test 4: Courte instruction sans api_req_started (fallback sur say/text)');
  
  const filePath = path.join(testDir, 'no-api-req.json');
  const messages = [
    {
      ts: 1759082704597,
      type: 'say',
      say: 'text',
      text: 'Courte instruction'
    }
  ];

  await fs.writeFile(filePath, JSON.stringify(messages));
  const result = await RooStorageDetector.extractMainInstructionFromUI(filePath);

  console.log(`   Résultat: "${result}"`);
  console.log(`   ✅ Égal à "Courte instruction": ${result === 'Courte instruction'}`);
}

async function testNoSayTextButApiReq() {
  console.log('\n🧪 Test 5: Pas de say/text mais api_req_started existe');
  
  const filePath = path.join(testDir, 'no-say-text.json');
  const messages = [
    {
      ts: 1759082711779,
      type: 'say',
      say: 'api_req_started',
      text: JSON.stringify({
        request: '<task>\nInstruction dans api_req_started seulement\n</task>'
      })
    }
  ];

  await fs.writeFile(filePath, JSON.stringify(messages));
  const result = await RooStorageDetector.extractMainInstructionFromUI(filePath);

  console.log(`   Résultat: "${result}"`);
  console.log(`   ✅ Contient "api_req_started seulement": ${result?.includes('api_req_started seulement')}`);
}

async function runAllTests() {
  console.log('='.repeat(80));
  console.log('🚀 Test manuel: extractMainInstructionFromUI - Logique de fallback');
  console.log('='.repeat(80));

  try {
    await setup();
    
    await testCompleteInstruction();
    await testTruncatedWithFallback();
    await testEllipsisWithFallback();
    await testNoApiReqFallback();
    await testNoSayTextButApiReq();

    console.log('\n' + '='.repeat(80));
    console.log('✅ Tous les tests sont terminés');
    console.log('='.repeat(80));

  } catch (error) {
    console.error('\n❌ Erreur lors des tests:', error);
    throw error;
  } finally {
    await cleanup();
  }
}

runAllTests().catch(console.error);