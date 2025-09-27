/**
 * Test d'intégration rapide pour valider le mécanisme d'idempotence
 * Script simple sans dépendances Jest complexes
 */

import { IndexingDecisionService } from '../../build/src/services/indexing-decision.js';

// Test basique d'intégration
async function runIntegrationTest() {
    console.log('🧪 Démarrage du test d\'intégration d\'indexation...');
    
    const service = new IndexingDecisionService();
    let totalTests = 0;
    let successfulTests = 0;
    
    // Utilitaire de test
    function test(name, testFn) {
        totalTests++;
        try {
            testFn();
            console.log(`✅ ${name}`);
            successfulTests++;
        } catch (error) {
            console.error(`❌ ${name}: ${error.message}`);
        }
    }
    
    // Mock skeleton de base
    const baseSkeleton = {
        taskId: 'test-task-123',
        metadata: {
            lastActivity: new Date().toISOString(),
            createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
            messageCount: 10,
            actionCount: 5,
            totalSize: 1024
        },
        sequence: []
    };

    // Test 1: Première indexation
    test('Première indexation doit être autorisée', () => {
        const skeleton = { ...baseSkeleton };
        const decision = service.shouldIndex(skeleton);
        
        if (!decision.shouldIndex) throw new Error('Devrait indexer une nouvelle tâche');
        if (!decision.reason.includes('Première indexation')) throw new Error('Raison incorrecte');
    });

    // Test 2: Skip avec succès récent
    test('Skip avec statut success et TTL actif', () => {
        const skeleton = {
            ...baseSkeleton,
            metadata: {
                ...baseSkeleton.metadata,
                indexingState: {
                    indexStatus: 'success',
                    lastIndexedAt: new Date().toISOString(),
                    nextReindexAfter: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
                }
            }
        };
        
        const decision = service.shouldIndex(skeleton);
        
        if (decision.shouldIndex) throw new Error('Devrait skipper une tâche avec TTL actif');
        if (!decision.reason.includes('TTL actif')) throw new Error('Raison incorrecte');
    });

    // Test 3: Skip avec échec permanent
    test('Skip avec échec permanent', () => {
        const skeleton = {
            ...baseSkeleton,
            metadata: {
                ...baseSkeleton.metadata,
                indexingState: {
                    indexStatus: 'failed',
                    indexError: 'Erreur permanente'
                }
            }
        };
        
        const decision = service.shouldIndex(skeleton);
        
        if (decision.shouldIndex) throw new Error('Devrait skipper un échec permanent');
        if (!decision.reason.includes('Échec permanent')) throw new Error('Raison incorrecte');
    });

    // Test 4: Mode Force ignore tous les skips
    test('Mode Force ignore les skips', () => {
        // Sauvegarder l'env original
        const originalForce = process.env.ROO_INDEX_FORCE;
        process.env.ROO_INDEX_FORCE = '1';
        
        const forceService = new IndexingDecisionService();
        
        const skeleton = {
            ...baseSkeleton,
            metadata: {
                ...baseSkeleton.metadata,
                indexingState: {
                    indexStatus: 'failed',
                    indexError: 'Erreur permanente'
                }
            }
        };
        
        const decision = forceService.shouldIndex(skeleton);
        
        // Restaurer l'env
        if (originalForce) {
            process.env.ROO_INDEX_FORCE = originalForce;
        } else {
            delete process.env.ROO_INDEX_FORCE;
        }
        
        if (!decision.shouldIndex) throw new Error('Mode force devrait ignorer les skips');
        if (!decision.reason.includes('FORCE_REINDEX')) throw new Error('Raison incorrecte');
    });

    // Test 5: Migration legacy
    test('Migration du format legacy', () => {
        const skeleton = {
            ...baseSkeleton,
            metadata: {
                ...baseSkeleton.metadata,
                qdrantIndexedAt: new Date().toISOString()
            }
        };
        
        const migrated = service.migrateLegacyIndexingState(skeleton);
        
        if (!migrated) throw new Error('Migration devrait avoir lieu');
        if (!skeleton.metadata.indexingState) throw new Error('État d\'indexation devrait être créé');
        if (skeleton.metadata.qdrantIndexedAt) throw new Error('Ancien champ devrait être supprimé');
    });

    // Test 6: Gestion des états
    test('Marquage de succès', () => {
        const skeleton = { ...baseSkeleton };
        service.markIndexingSuccess(skeleton);
        
        if (!skeleton.metadata.indexingState) throw new Error('État d\'indexation manquant');
        if (skeleton.metadata.indexingState.indexStatus !== 'success') throw new Error('Statut incorrect');
        if (!skeleton.metadata.indexingState.lastIndexedAt) throw new Error('Timestamp manquant');
    });

    // Test 7: Gestion des échecs
    test('Marquage d\'échec temporaire', () => {
        const skeleton = { ...baseSkeleton };
        service.markIndexingFailure(skeleton, 'Timeout réseau', false);
        
        if (!skeleton.metadata.indexingState) throw new Error('État d\'indexation manquant');
        if (skeleton.metadata.indexingState.indexStatus !== 'retry') throw new Error('Statut incorrect');
        if (!skeleton.metadata.indexingState.indexError) throw new Error('Erreur manquante');
    });

    // Rapport final
    console.log('\n📊 Résultats du test d\'intégration:');
    console.log(`   ✅ Réussis: ${successfulTests}/${totalTests}`);
    console.log(`   ❌ Échecs: ${totalTests - successfulTests}/${totalTests}`);
    
    if (successfulTests === totalTests) {
        console.log('\n🎉 Tous les tests d\'intégration sont RÉUSSIS !');
        console.log('   ✅ Mécanisme d\'idempotence fonctionnel');
        console.log('   ✅ Logique de skip anti-fuite opérationnelle');
        console.log('   ✅ Gestion d\'états complète');
        console.log('   ✅ Mode force fonctionnel');
        console.log('   ✅ Migration legacy validée');
        return true;
    } else {
        console.error('\n🚨 Certains tests ont échoué !');
        return false;
    }
}

// Exécuter le test d'intégration
runIntegrationTest().then(success => {
    process.exit(success ? 0 : 1);
}).catch(error => {
    console.error('💥 Erreur critique lors du test d\'intégration:', error);
    process.exit(1);
});