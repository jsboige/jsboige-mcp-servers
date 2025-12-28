const { QdrantClient } = require('@qdrant/js-client-rest');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config({ path: '../../.env' });

// Désactiver la vérification SSL stricte pour le développement
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const COLLECTION_NAME = process.env.QDRANT_COLLECTION_NAME || 'roo_tasks_semantic_index';

async function runDiagnostic() {
    console.log('🔍 Démarrage du diagnostic Qdrant Payload...');
    console.log(`URL: ${process.env.QDRANT_URL}`);
    console.log(`Collection: ${COLLECTION_NAME}`);

    const client = new QdrantClient({
        url: process.env.QDRANT_URL,
        apiKey: process.env.QDRANT_API_KEY,
        checkCompatibility: false,
    });

    // 1. Vérifier si la collection existe
    try {
        const collections = await client.getCollections();
        const exists = collections.collections.some(c => c.name === COLLECTION_NAME);
        console.log(`Collection exists: ${exists}`);

        if (!exists) {
            console.log('Création de la collection de test...');
            await client.createCollection(COLLECTION_NAME, {
                vectors: { size: 1536, distance: 'Cosine' }
            });
        }
    } catch (error) {
        console.error('Erreur connexion/collection:', error.message);
        return;
    }

    // 2. Test Payload Minimal
    console.log('\n--- Test 1: Payload Minimal ---');
    try {
        const pointId = uuidv4();
        await client.upsert(COLLECTION_NAME, {
            points: [{
                id: pointId,
                vector: new Array(1536).fill(0.1),
                payload: { test: "minimal" }
            }]
        });
        console.log('✅ Test 1 Réussi');
    } catch (error) {
        console.error('❌ Test 1 Échoué:', error.message);
        if (error.response) console.error('Response:', error.response.data);
    }

    // 3. Test Payload Complet (Simulé)
    console.log('\n--- Test 2: Payload Complet Simulé ---');
    try {
        const pointId = uuidv4();
        const payload = {
            chunk_id: pointId,
            task_id: uuidv4(),
            parent_task_id: null, // Null est souvent problématique
            root_task_id: null,
            chunk_type: 'message_exchange',
            sequence_order: 1,
            timestamp: new Date().toISOString(),
            indexed: true,
            content: "Test content",
            content_summary: "Summary",
            participants: ['user', 'assistant'],
            tool_details: null, // Null ici aussi
            workspace: "d:/test",
            task_title: "Test Task",
            message_index: 1,
            total_messages: 10,
            role: "user",
            host_os: "Windows_NT",
            chunk_index: 1,
            total_chunks: 1,
            original_chunk_id: uuidv4()
        };

        await client.upsert(COLLECTION_NAME, {
            points: [{
                id: pointId,
                vector: new Array(1536).fill(0.1),
                payload: payload
            }]
        });
        console.log('✅ Test 2 Réussi');
    } catch (error) {
        console.error('❌ Test 2 Échoué:', error.message);
        if (error.response) {
             console.error('Response Status:', error.response.status);
             console.error('Response Data:', JSON.stringify(error.response.data, null, 2));
        }
    }

    // 4. Test Payload avec Nulls supprimés
    console.log('\n--- Test 3: Payload Sans Nulls ---');
    try {
        const pointId = uuidv4();
        const payload = {
            chunk_id: pointId,
            task_id: uuidv4(),
            // parent_task_id supprimé
            // root_task_id supprimé
            chunk_type: 'message_exchange',
            sequence_order: 1,
            timestamp: new Date().toISOString(),
            indexed: true,
            content: "Test content",
            content_summary: "Summary",
            participants: ['user', 'assistant'],
            // tool_details supprimé
            workspace: "d:/test",
            task_title: "Test Task",
            message_index: 1,
            total_messages: 10,
            role: "user",
            host_os: "Windows_NT",
            chunk_index: 1,
            total_chunks: 1,
            original_chunk_id: uuidv4()
        };

        await client.upsert(COLLECTION_NAME, {
            points: [{
                id: pointId,
                vector: new Array(1536).fill(0.1),
                payload: payload
            }]
        });
        console.log('✅ Test 3 Réussi');
    } catch (error) {
        console.error('❌ Test 3 Échoué:', error.message);
        if (error.response) console.error('Response:', error.response.data);
    }
}

runDiagnostic();