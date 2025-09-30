/**
 * TEST MINIMAL - SYNTHÈSE DIRECTE PHASE 3
 * Test d'isolation pour vérifier que LLMService fonctionne sans paramètres camelCase
 */
import { LLMService } from './build/src/services/synthesis/LLMService.js';
import getOpenAIClient from './build/src/services/openai.js';
import { config } from 'dotenv';

// Charger les variables d'environnement
config();

console.log('🧪 TEST SYNTHÈSE DIRECTE - Phase 3');

async function testLLMServiceDirect() {
    try {
        // Test 1: Vérifier le singleton OpenAI
        console.log('\n1. Test du singleton OpenAI...');
        const client = getOpenAIClient();
        console.log('✅ Client OpenAI créé:', !!client);
        console.log('✅ API Key configurée:', !!process.env.OPENAI_API_KEY);

        // Test 2: Instancier LLMService
        console.log('\n2. Test de l\'instanciation LLMService...');
        const llmService = new LLMService();
        console.log('✅ LLMService instancié');

        // Test 3: Appel LLM minimal direct
        console.log('\n3. Test d\'appel LLM minimal...');
        const simplePrompt = "Dis-moi juste 'Hello' en réponse.";
        const result = await llmService.callLLM(
            simplePrompt,
            'gpt-4o-synthesis',
            {}, // Pas de paramètres additionnels
            { test: 'minimal' }
        );

        console.log('✅ Appel LLM réussi!');
        console.log('📊 Réponse:', result.response.substring(0, 100) + '...');
        console.log('🕐 Durée:', result.duration, 'ms');
        console.log('💰 Coût estimé:', result.usage.estimatedCost);

        // Test 4: Test generateSynthesis avec contexte minimal
        console.log('\n4. Test generateSynthesis avec contexte minimal...');
        const contextMinimal = "Conversation de test : Utilisateur demande aide, Assistant répond positivement.";
        
        const synthesisResult = await llmService.generateSynthesis(
            contextMinimal,
            'test-task-id-minimal',
            'gpt-4o-synthesis'
        );

        console.log('✅ Synthèse générée!');
        console.log('📋 Résultat structured output reçu');
        console.log('🕐 Durée synthesis:', synthesisResult.duration, 'ms');

        console.log('\n🎉 TOUS LES TESTS RÉUSSIS - LLMService fonctionne!');
        
    } catch (error) {
        console.error('\n❌ ERREUR dans le test minimal:', error.message);
        console.error('📍 Stack:', error.stack);
    }
}

// Exécuter le test
testLLMServiceDirect().then(() => {
    console.log('\n✨ Test terminé');
}).catch((error) => {
    console.error('💥 Erreur fatale:', error);
});