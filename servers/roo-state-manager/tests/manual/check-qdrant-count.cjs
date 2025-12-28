const { QdrantClient } = require('@qdrant/js-client-rest');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

// Bypass SSL verification for self-signed certificates
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const QDRANT_URL = process.env.QDRANT_URL;
const QDRANT_API_KEY = process.env.QDRANT_API_KEY;
const COLLECTION_NAME = process.env.QDRANT_COLLECTION_NAME || 'roo_tasks_semantic_index';

async function checkCount() {
    console.log(`Connecting to Qdrant at ${QDRANT_URL}...`);
    const client = new QdrantClient({
        url: QDRANT_URL,
        apiKey: QDRANT_API_KEY,
    });

    try {
        const collectionInfo = await client.getCollection(COLLECTION_NAME);
        console.log(`Collection: ${COLLECTION_NAME}`);
        console.log(`Status: ${collectionInfo.status}`);
        console.log(`Points count: ${collectionInfo.points_count}`);
        console.log(`Indexed vectors: ${collectionInfo.indexed_vectors_count}`);

        // Vérifier si la tâche spécifique est indexée
        const taskId = 'f387d961-e41f-40f5-8d67-afefe6a4564c';
        const searchResult = await client.scroll(COLLECTION_NAME, {
            filter: {
                must: [
                    {
                        key: "task_id",
                        match: {
                            value: taskId
                        }
                    }
                ]
            },
            limit: 1,
            with_payload: true
        });

        if (searchResult.points.length > 0) {
            console.log(`✅ Task ${taskId} found in index!`);
            console.log(`Sample point ID: ${searchResult.points[0].id}`);
        } else {
            console.log(`❌ Task ${taskId} NOT found in index.`);
        }

    } catch (error) {
        console.error('Error checking Qdrant:', error.message);
        if (error.response) {
            console.error('Response data:', error.response.data);
        }
    }
}

checkCount();