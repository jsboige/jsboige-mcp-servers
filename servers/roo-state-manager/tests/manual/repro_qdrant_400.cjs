const { QdrantClient } = require('@qdrant/js-client-rest');
const dotenv = require('dotenv');
const path = require('path');

// Charger les variables d'environnement
dotenv.config({ path: path.join(__dirname, '../../.env') });

const QDRANT_URL = process.env.QDRANT_URL;
const QDRANT_API_KEY = process.env.QDRANT_API_KEY;
const COLLECTION_NAME = process.env.QDRANT_COLLECTION || 'roo_tasks_semantic_index';

console.log('Configuration:', {
    url: QDRANT_URL,
    collection: COLLECTION_NAME,
    hasKey: !!QDRANT_API_KEY
});

// Désactiver la vérification SSL pour le test
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const client = new QdrantClient({
    url: QDRANT_URL,
    apiKey: QDRANT_API_KEY,
    checkCompatibility: false // Désactiver la vérification de version qui échoue aussi
});

async function run() {
    // Simuler un point qui ressemble à ce que l'application envoie
    // Basé sur l'analyse du code : task_id, parent_task_id, workspace, content, etc.
    const point = {
        id: "f387d961-e41f-40f5-8d67-afefe6a4564c", // UUID v4 valide (ou v5)
        vector: new Array(1536).fill(0.1), // Vecteur valide
        payload: {
            task_id: "f387d961-e41f-40f5-8d67-afefe6a4564c",
            parent_task_id: null, // Peut-être le problème ?
            workspace: "d:\\roo-extensions",
            content: "Test content for reproduction",
            timestamp: new Date().toISOString(),
            chunk_index: 0,
            total_chunks: 1,
            type: "task_content"
        }
    };

    console.log('Tentative d\'upsert...');
    try {
        await client.upsert(COLLECTION_NAME, {
            wait: true,
            points: [point]
        });
        console.log('✅ Succès !');
    } catch (error) {
        console.error('❌ Erreur:', error.message);
        if (error.response) {
            console.error('Status:', error.response.status);
            console.error('Data:', JSON.stringify(error.response.data, null, 2));
        }
    }
}

run();