process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // FIX: Ignorer erreurs SSL pour test
require('dotenv').config({ path: '.env' });
const { OpenAI } = require('openai');
const { QdrantClient } = require('@qdrant/js-client-rest');

async function testOpenAI() {
    console.log('🔍 Test OpenAI...');
    if (!process.env.OPENAI_API_KEY) {
        console.error('❌ OPENAI_API_KEY manquante');
        return;
    }
    try {
        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        const response = await openai.embeddings.create({
            model: 'text-embedding-3-small',
            input: 'test connection',
        });
        console.log('✅ OpenAI OK. Embedding length:', response.data[0].embedding.length);
    } catch (error) {
        console.error('❌ Erreur OpenAI:', error.message);
        if (error.response) console.error('Détails:', error.response.data);
    }
}

async function testQdrant() {
    console.log('🔍 Test Qdrant...');
    if (!process.env.QDRANT_URL) {
        console.error('❌ QDRANT_URL manquante');
        return;
    }

    // Test Fetch Natif
    try {
        console.log('📡 Test Fetch Natif vers /collections...');
        const response = await fetch(`${process.env.QDRANT_URL}/collections`, {
            headers: {
                'api-key': process.env.QDRANT_API_KEY
            }
        });

        if (response.ok) {
            const data = await response.json();
            console.log('✅ Fetch Natif OK. Collections:', data.result.collections.map(c => c.name).join(', '));
        } else {
            console.error('❌ Fetch Natif Failed:', response.status, response.statusText);
            const text = await response.text();
            console.error('Body:', text);
        }
    } catch (error) {
        console.error('❌ Erreur Fetch Natif:', error.message);
        if (error.cause) console.error('Cause:', error.cause);
    }

    // Test Client JS
    try {
        console.log('📡 Test Client JS...');
        const client = new QdrantClient({
            url: process.env.QDRANT_URL,
            apiKey: process.env.QDRANT_API_KEY,
            checkCompatibility: false,
        });
        const collections = await client.getCollections();
        console.log('✅ Qdrant Client OK. Collections:', collections.collections.map(c => c.name).join(', '));
    } catch (error) {
        console.error('❌ Erreur Qdrant Client:', error.message);
    }
}

async function run() {
    await testOpenAI();
    await testQdrant();
}

run();