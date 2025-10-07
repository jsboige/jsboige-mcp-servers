import OpenAI from 'openai';

async function testMinimal() {
    try {
        const client = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY
        });
        
        const result = await client.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role: 'user', content: 'Bonjour' }],
            temperature: 0.1,
            max_tokens: 100
        });
        
        console.log('✅ Succès:', result.choices[0].message.content);
    } catch (error) {
        console.error('❌ Erreur:', error.message);
    }
}

testMinimal();