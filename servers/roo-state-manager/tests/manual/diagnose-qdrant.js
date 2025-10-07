#!/usr/bin/env node

/**
 * 🔬 DIAGNOSTIC QDRANT - MCP ROO-STATE-MANAGER
 * Script de diagnostic pour les problèmes de connexion Qdrant
 */

import { getQdrantClient } from './build/src/services/qdrant.js';
import dotenv from 'dotenv';

// Charger les variables d'environnement
dotenv.config();

const COLLECTION_NAME = process.env.QDRANT_COLLECTION_NAME || 'roo_tasks_semantic_index';

console.log('🔬 DIAGNOSTIC QDRANT - DÉBUT');
console.log('================================');

async function testBasicConnectivity() {
    console.log('\n📡 TEST 1: CONNECTIVITÉ DE BASE');
    console.log('--------------------------------');
    
    const url = process.env.QDRANT_URL;
    const apiKey = process.env.QDRANT_API_KEY;
    
    console.log(`URL: ${url}`);
    console.log(`API Key présente: ${!!apiKey}`);
    console.log(`Collection: ${COLLECTION_NAME}`);
    
    if (!url) {
        console.error('❌ QDRANT_URL non définie');
        return false;
    }
    
    if (!apiKey) {
        console.error('❌ QDRANT_API_KEY non définie');
        return false;
    }
    
    try {
        console.log('🔄 Test fetch direct...');
        const response = await fetch(`${url}/collections`, {
            method: 'GET',
            headers: {
                'api-key': apiKey,
                'Content-Type': 'application/json',
            },
            timeout: 10000
        });
        
        console.log(`✅ Réponse HTTP: ${response.status} ${response.statusText}`);
        
        if (response.ok) {
            const data = await response.json();
            console.log(`📊 Collections trouvées: ${data.result?.collections?.length || 0}`);
            return true;
        } else {
            console.error(`❌ Erreur HTTP: ${response.status}`);
            return false;
        }
    } catch (error) {
        console.error(`❌ Erreur fetch:`, error.message);
        console.error(`   Type: ${error.constructor.name}`);
        console.error(`   Code: ${error.code || 'N/A'}`);
        return false;
    }
}

async function testQdrantClient() {
    console.log('\n🔧 TEST 2: CLIENT QDRANT');
    console.log('-------------------------');
    
    try {
        console.log('🔄 Initialisation client Qdrant...');
        const client = getQdrantClient();
        console.log('✅ Client initialisé');
        
        console.log('🔄 Test getCollections...');
        const collections = await client.getCollections();
        console.log(`✅ Collections récupérées: ${collections.collections.length}`);
        
        // Vérifier si notre collection existe
        const ourCollection = collections.collections.find(c => c.name === COLLECTION_NAME);
        if (ourCollection) {
            console.log(`✅ Collection '${COLLECTION_NAME}' trouvée`);
            console.log(`   Points: ${ourCollection.points_count}`);
            console.log(`   Status: ${ourCollection.status}`);
        } else {
            console.log(`⚠️ Collection '${COLLECTION_NAME}' non trouvée`);
        }
        
        return true;
    } catch (error) {
        console.error(`❌ Erreur client Qdrant:`, error.message);
        console.error(`   Type: ${error.constructor.name}`);
        console.error(`   Stack:`, error.stack?.split('\n').slice(0, 3).join('\n'));
        return false;
    }
}

async function testCollectionOperations() {
    console.log('\n📊 TEST 3: OPÉRATIONS COLLECTION');
    console.log('----------------------------------');
    
    try {
        const client = getQdrantClient();
        
        console.log(`🔄 Test count points sur '${COLLECTION_NAME}'...`);
        const countResult = await client.count(COLLECTION_NAME);
        console.log(`✅ Points dans collection: ${countResult.count}`);
        
        console.log('🔄 Test info collection...');
        const collectionInfo = await client.getCollection(COLLECTION_NAME);
        console.log(`✅ Info collection récupérée:`);
        console.log(`   Status: ${collectionInfo.status}`);
        console.log(`   Points: ${collectionInfo.points_count}`);
        console.log(`   Segments: ${collectionInfo.segments_count}`);
        
        return true;
    } catch (error) {
        console.error(`❌ Erreur opérations collection:`, error.message);
        console.error(`   Type: ${error.constructor.name}`);
        
        // Analyser le type d'erreur spécifique
        if (error.message.includes('fetch failed')) {
            console.error('🔍 DIAGNOSTIC: Erreur "fetch failed" détectée');
            console.error('   Causes possibles:');
            console.error('   - Timeout réseau');
            console.error('   - Serveur Qdrant indisponible');
            console.error('   - Problème DNS/proxy');
            console.error('   - Limite de connexions');
        }
        
        return false;
    }
}

async function testSimpleUpsert() {
    console.log('\n📤 TEST 4: UPSERT SIMPLE');
    console.log('-------------------------');
    
    try {
        const client = getQdrantClient();
        
        // Créer un point de test simple
        const testPoint = {
            id: `test-${Date.now()}`,
            vector: Array(1536).fill(0).map(() => Math.random() - 0.5), // Vecteur aléatoire 1536D
            payload: {
                test: true,
                timestamp: new Date().toISOString(),
                diagnostic: 'qdrant-connectivity-test'
            }
        };
        
        console.log('🔄 Test upsert point simple...');
        await client.upsert(COLLECTION_NAME, {
            wait: true,
            points: [testPoint]
        });
        
        console.log(`✅ Upsert réussi - Point ID: ${testPoint.id}`);
        
        // Nettoyer le point de test
        console.log('🔄 Nettoyage point de test...');
        await client.delete(COLLECTION_NAME, {
            wait: true,
            points: [testPoint.id]
        });
        
        console.log('✅ Point de test supprimé');
        return true;
        
    } catch (error) {
        console.error(`❌ Erreur upsert:`, error.message);
        console.error(`   Type: ${error.constructor.name}`);
        
        // Diagnostic spécifique pour les erreurs d'upsert
        if (error.message.includes('fetch failed')) {
            console.error('🔍 DIAGNOSTIC: Erreur "fetch failed" sur upsert');
            console.error('   Solutions possibles:');
            console.error('   - Augmenter timeout réseau');
            console.error('   - Vérifier taille des payloads');
            console.error('   - Réduire batch size');
            console.error('   - Implémenter retry avec backoff');
        }
        
        return false;
    }
}

async function runDiagnostic() {
    console.log(`🕐 Début diagnostic: ${new Date().toISOString()}`);
    
    const results = {
        connectivity: false,
        client: false,
        operations: false,
        upsert: false
    };
    
    try {
        results.connectivity = await testBasicConnectivity();
        
        if (results.connectivity) {
            results.client = await testQdrantClient();
            
            if (results.client) {
                results.operations = await testCollectionOperations();
                results.upsert = await testSimpleUpsert();
            }
        }
        
    } catch (error) {
        console.error('❌ Erreur générale diagnostic:', error);
    }
    
    console.log('\n📋 RÉSUMÉ DIAGNOSTIC');
    console.log('====================');
    console.log(`Connectivité de base: ${results.connectivity ? '✅' : '❌'}`);
    console.log(`Client Qdrant: ${results.client ? '✅' : '❌'}`);
    console.log(`Opérations collection: ${results.operations ? '✅' : '❌'}`);
    console.log(`Test upsert: ${results.upsert ? '✅' : '❌'}`);
    
    const allPassed = Object.values(results).every(r => r);
    console.log(`\n🎯 VERDICT: ${allPassed ? '✅ QDRANT OPÉRATIONNEL' : '❌ PROBLÈMES DÉTECTÉS'}`);
    
    if (!allPassed) {
        console.log('\n🔧 RECOMMANDATIONS:');
        if (!results.connectivity) {
            console.log('- Vérifier QDRANT_URL et QDRANT_API_KEY');
            console.log('- Tester connectivité réseau vers le serveur');
        }
        if (!results.operations) {
            console.log('- Vérifier que la collection existe');
            console.log('- Augmenter les timeouts réseau');
        }
        if (!results.upsert) {
            console.log('- Implémenter retry avec backoff exponentiel');
            console.log('- Réduire la taille des batches');
        }
    }
    
    console.log(`\n🕐 Fin diagnostic: ${new Date().toISOString()}`);
}

// Exécuter le diagnostic
runDiagnostic().catch(console.error);