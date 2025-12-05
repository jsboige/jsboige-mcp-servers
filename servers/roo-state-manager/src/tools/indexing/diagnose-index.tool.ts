/**
 * Diagnostic de l'index sémantique Qdrant
 */

import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ConversationSkeleton } from '../../types/conversation.js';
import { getQdrantClient } from '../../services/qdrant.js';
import getOpenAIClient from '../../services/openai.js';

/**
 * Diagnostique l'état de l'index sémantique
 */
export async function handleDiagnoseSemanticIndex(
    conversationCache: Map<string, ConversationSkeleton>
): Promise<CallToolResult> {
    const collectionName = process.env.QDRANT_COLLECTION_NAME || 'roo_tasks_semantic_index';
    const diagnostics: any = {
        timestamp: new Date().toISOString(),
        collection_name: collectionName,
        status: 'unknown',
        errors: [],
        details: {},
    };

    try {
        // Test de connectivité à Qdrant
        const qdrant = getQdrantClient();
        diagnostics.details.qdrant_connection = 'success';

        try {
            // Vérifier si la collection existe
            const collections = await qdrant.getCollections();
            const collection = collections.collections.find(c => c.name === collectionName);
            
            if (collection) {
                diagnostics.details.collection_exists = true;
                
                // Obtenir des informations sur la collection
                const collectionInfo = await qdrant.getCollection(collectionName);
                diagnostics.details.collection_info = {
                    vectors_count: (collectionInfo as any).vectors_count,
                    indexed_vectors_count: collectionInfo.indexed_vectors_count || 0,
                    points_count: collectionInfo.points_count,
                    config: {
                        distance: collectionInfo.config?.params?.vectors?.distance || 'unknown',
                        size: collectionInfo.config?.params?.vectors?.size || 'unknown',
                    },
                };
                
                if (collectionInfo.points_count === 0) {
                    diagnostics.status = 'empty_collection';
                    diagnostics.errors.push('La collection existe mais ne contient aucun point indexé');
                } else {
                    diagnostics.status = 'healthy';
                }
            } else {
                diagnostics.details.collection_exists = false;
                diagnostics.status = 'missing_collection';
                diagnostics.errors.push(`La collection '${collectionName}' n'existe pas dans Qdrant`);
            }
        } catch (collectionError: any) {
            diagnostics.errors.push(`Erreur lors de l'accès à la collection: ${collectionError.message}`);
            diagnostics.status = 'collection_error';
        }

        // Test de connectivité à OpenAI
        try {
            const openai = getOpenAIClient();
            const testEmbedding = await openai.embeddings.create({
                model: 'text-embedding-3-small',
                input: 'test connectivity',
            });
            diagnostics.details.openai_connection = testEmbedding.data[0].embedding.length > 0 ? 'success' : 'failed';
        } catch (openaiError: any) {
            diagnostics.errors.push(`Erreur OpenAI: ${openaiError.message}`);
            diagnostics.details.openai_connection = 'failed';
        }

        // Vérifier les variables d'environnement nécessaires
        console.log('[DEBUG] Environment variables during diagnostic:');
        console.log(`QDRANT_URL: ${process.env.QDRANT_URL ? 'SET' : 'NOT SET'}`);
        console.log(`QDRANT_API_KEY: ${process.env.QDRANT_API_KEY ? 'SET' : 'NOT SET'}`);
        console.log(`QDRANT_COLLECTION_NAME: ${process.env.QDRANT_COLLECTION_NAME ? 'SET' : 'NOT SET'}`);
        console.log(`OPENAI_API_KEY: ${process.env.OPENAI_API_KEY ? 'SET' : 'NOT SET'}`);
        
        const envVars = {
            QDRANT_URL: !!process.env.QDRANT_URL,
            QDRANT_API_KEY: !!process.env.QDRANT_API_KEY,
            QDRANT_COLLECTION_NAME: !!process.env.QDRANT_COLLECTION_NAME,
            OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
        };
        diagnostics.details.environment_variables = envVars;

        const missingEnvVars = Object.entries(envVars)
            .filter(([, exists]) => !exists)
            .map(([varName]) => varName);
        
        if (missingEnvVars.length > 0) {
            diagnostics.errors.push(`Variables d'environnement manquantes: ${missingEnvVars.join(', ')}`);
        }

    } catch (connectionError: any) {
        diagnostics.status = 'connection_failed';
        diagnostics.details.qdrant_connection = 'failed';
        diagnostics.errors.push(`Impossible de se connecter à Qdrant: ${connectionError.message}`);
    }

    // Recommandations basées sur le diagnostic
    const recommendations: string[] = [];
    if (diagnostics.status === 'missing_collection') {
        recommendations.push('Utilisez l\'outil rebuild_task_index pour créer et peupler la collection');
    }
    if (diagnostics.status === 'empty_collection') {
        recommendations.push('La collection existe mais est vide. Lancez rebuild_task_index pour l\'indexer');
    }
    if (diagnostics.details.openai_connection === 'failed') {
        recommendations.push('Vérifiez votre clé API OpenAI dans les variables d\'environnement');
    }
    if (diagnostics.details.qdrant_connection === 'failed') {
        recommendations.push('Vérifiez la configuration Qdrant (URL, clé API, connectivité réseau)');
    }

    diagnostics.recommendations = recommendations;

    return {
        content: [{
            type: 'text',
            text: JSON.stringify(diagnostics, null, 2)
        }]
    };
}