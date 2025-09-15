// Test rapide pour valider les corrections d'indexation
import { indexTask } from './build/src/services/task-indexer.js';
// Configuration des variables d'environnement pour le test
process.env.QDRANT_URL = 'http://localhost:6333';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'your-openai-key';

console.log(`🔧 QDRANT_URL: ${process.env.QDRANT_URL}`);
console.log(`🔧 OPENAI_API_KEY présente: ${!!process.env.OPENAI_API_KEY}`);


async function testIndexing() {
    console.log('🔍 Test de l\'indexation sémantique...');
    
    const testTaskId = '66f82c36-efca-470d-921b-1258ce80485e';
    const testTaskPath = 'C:\\Users\\jsboi\\AppData\\Roaming\\Code\\User\\globalStorage\\rooveterinaryinc.roo-cline\\tasks\\66f82c36-efca-470d-921b-1258ce80485e';
    
    try {
        console.log(`📋 Test: ${testTaskId}`);
        console.log(`📁 Chemin: ${testTaskPath}`);
        
        const result = await indexTask(testTaskId, testTaskPath);
        console.log(`✅ Résultat: ${result.length} chunks indexés`);
        console.log('📊 Points:', result);
        
    } catch (error) {
        console.error('❌ Erreur:', error.message);
        console.error('📍 Stack:', error.stack);
    }
}

testIndexing().catch(console.error);