import getOpenAIClient from './src/services/openai.js';

async function testSingleton() {
    try {
        console.log('🧪 Test du singleton OpenAI...');
        
        const client = getOpenAIClient();
        
        const result = await client.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role: 'user', content: 'Dis juste "OK" pour tester' }],
            temperature: 0.1,
            max_tokens: 5
        });
        
        console.log('✅ Succès singleton:', result.choices[0].message.content);
    } catch (error) {
        console.error('❌ Erreur singleton:', error.message);
    }
}

testSingleton();