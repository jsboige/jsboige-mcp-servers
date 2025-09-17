import { LLMService } from './src/services/synthesis/LLMService.js';

async function testLLMService() {
    try {
        console.log('🧪 Test direct du LLMService Phase 3...');
        
        // Créer une instance du LLMService avec config par défaut
        const llmService = new LLMService();
        
        // Test d'un appel simple
        const contextTest = "Test de contexte pour validation Pipeline Phase 3";
        const taskId = "test-direct-phase3";
        
        console.log('📞 Appel generateSynthesis...');
        
        const result = await llmService.generateSynthesis(contextTest, taskId);
        
        console.log('✅ LLMService réussit !');
        console.log('📊 Résultat:', {
            modelId: result.context.modelId,
            tokens: result.usage.totalTokens,
            cost: result.usage.estimatedCost,
            response_preview: result.response.substring(0, 200) + '...'
        });
        
    } catch (error) {
        console.error('❌ Erreur LLMService:', error.message);
    }
}

testLLMService();