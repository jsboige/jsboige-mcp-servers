/**
 * Tests unitaires pour le service de décision d'indexation
 * Vérifie les mécanismes d'idempotence et de skip anti-fuite
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { IndexingDecisionService } from '../../../src/services/indexing-decision.js';
import { ConversationSkeleton } from '../../../src/types/conversation.js';
import { IndexStatus, INDEX_VERSION_CURRENT } from '../../../src/types/indexing.js';

describe('IndexingDecisionService', () => {
    let service: IndexingDecisionService;
    let mockSkeleton: ConversationSkeleton;

    beforeEach(() => {
        // Reset des variables d'environnement
        delete process.env.ROO_INDEX_FORCE;
        delete process.env.ROO_INDEX_VERSION;
        
        service = new IndexingDecisionService();
        
        // Squelette de test de base
        mockSkeleton = {
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
    });

    describe('Force Reindex Mode', () => {
        it('devrait ignorer tous les skips en mode force', () => {
            process.env.ROO_INDEX_FORCE = '1';
            service = new IndexingDecisionService(); // Re-créer pour prendre en compte l'env
            
            // Même avec un statut "success" récent, doit indexer
            mockSkeleton.metadata.indexingState = {
                indexStatus: 'success',
                lastIndexedAt: new Date().toISOString(),
                nextReindexAfter: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
            };
            
            const decision = service.shouldIndex(mockSkeleton);
            
            expect(decision.shouldIndex).toBe(true);
            expect(decision.reason).toContain('FORCE_REINDEX');
            expect(decision.action).toBe('index');
        });

        it('devrait indexer même avec échec permanent en mode force', () => {
            process.env.ROO_INDEX_FORCE = 'true';
            service = new IndexingDecisionService();
            
            mockSkeleton.metadata.indexingState = {
                indexStatus: 'failed',
                indexError: 'Erreur permanente test'
            };
            
            const decision = service.shouldIndex(mockSkeleton);
            
            expect(decision.shouldIndex).toBe(true);
            expect(decision.reason).toContain('FORCE_REINDEX');
        });
    });

    describe('Skip Logic - Succès récents', () => {
        it('devrait skipper si indexé avec succès et dans le TTL', () => {
            mockSkeleton.metadata.indexingState = {
                indexStatus: 'success',
                lastIndexedAt: new Date().toISOString(),
                nextReindexAfter: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
            };
            
            const decision = service.shouldIndex(mockSkeleton);
            
            expect(decision.shouldIndex).toBe(false);
            expect(decision.reason).toContain('TTL actif');
            expect(decision.action).toBe('skip');
        });

        it('devrait skipper si contenu inchangé depuis dernière indexation', () => {
            const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
            
            mockSkeleton.metadata.lastActivity = yesterday;
            mockSkeleton.metadata.indexingState = {
                indexStatus: 'success',
                lastIndexedAt: new Date().toISOString() // Indexé après dernière activité
            };
            
            const decision = service.shouldIndex(mockSkeleton);
            
            expect(decision.shouldIndex).toBe(false);
            expect(decision.reason).toContain('inchangé depuis dernière indexation');
            expect(decision.action).toBe('skip');
        });
    });

    describe('Skip Logic - Échecs permanents', () => {
        it('devrait skipper les échecs permanents', () => {
            mockSkeleton.metadata.indexingState = {
                indexStatus: 'failed',
                indexError: 'File corrupted permanently'
            };
            
            const decision = service.shouldIndex(mockSkeleton);
            
            expect(decision.shouldIndex).toBe(false);
            expect(decision.reason).toContain('Échec permanent');
            expect(decision.action).toBe('skip');
        });
    });

    describe('Retry Logic avec Backoff', () => {
        it('devrait autoriser retry dans la limite', () => {
            mockSkeleton.metadata.indexingState = {
                indexStatus: 'retry',
                indexRetryCount: 1,
                lastIndexAttempt: new Date(Date.now() - 10 * 60 * 1000).toISOString() // 10 min ago
            };
            
            const decision = service.shouldIndex(mockSkeleton);
            
            expect(decision.shouldIndex).toBe(true);
            expect(decision.reason).toContain('Retry n°2/3');
            expect(decision.action).toBe('retry');
        });

        it('devrait skipper après maximum de tentatives', () => {
            mockSkeleton.metadata.indexingState = {
                indexStatus: 'retry',
                indexRetryCount: 3
            };
            
            const decision = service.shouldIndex(mockSkeleton);
            
            expect(decision.shouldIndex).toBe(false);
            expect(decision.reason).toContain('Maximum de tentatives atteint');
            expect(decision.action).toBe('skip');
        });

        it('devrait respecter le backoff timing', () => {
            mockSkeleton.metadata.indexingState = {
                indexStatus: 'retry',
                indexRetryCount: 1,
                lastIndexAttempt: new Date(Date.now() - 30 * 1000).toISOString() // 30 sec ago
            };
            
            const decision = service.shouldIndex(mockSkeleton);
            
            expect(decision.shouldIndex).toBe(false);
            expect(decision.reason).toContain('Backoff actif');
            expect(decision.action).toBe('skip');
            expect(decision.backoffUntil).toBeDefined();
        });
    });

    describe('Migration Logic', () => {
        it('devrait indexer si version différente', () => {
            mockSkeleton.metadata.indexingState = {
                indexStatus: 'success',
                indexVersion: '0.9',
                lastIndexedAt: new Date().toISOString()
            };
            
            const decision = service.shouldIndex(mockSkeleton);
            
            expect(decision.shouldIndex).toBe(true);
            expect(decision.reason).toContain('Migration d\'index requise');
            expect(decision.action).toBe('index');
        });

        it('devrait migrer le format legacy qdrantIndexedAt', () => {
            const skeleton: ConversationSkeleton = {
                ...mockSkeleton,
                metadata: {
                    ...mockSkeleton.metadata,
                    qdrantIndexedAt: new Date().toISOString(),
                    indexingState: undefined
                }
            };
            
            const migrated = service.migrateLegacyIndexingState(skeleton);
            
            expect(migrated).toBe(true);
            expect(skeleton.metadata.indexingState).toBeDefined();
            expect(skeleton.metadata.indexingState!.indexStatus).toBe('success');
            expect(skeleton.metadata.qdrantIndexedAt).toBeUndefined();
        });
    });

    describe('État Management', () => {
        it('devrait marquer le succès correctement', () => {
            service.markIndexingSuccess(mockSkeleton);
            
            expect(mockSkeleton.metadata.indexingState!.indexStatus).toBe('success');
            expect(mockSkeleton.metadata.indexingState!.lastIndexedAt).toBeDefined();
            expect(mockSkeleton.metadata.indexingState!.nextReindexAfter).toBeDefined();
            expect(mockSkeleton.metadata.indexingState!.indexVersion).toBe(INDEX_VERSION_CURRENT);
            expect(mockSkeleton.metadata.indexingState!.indexError).toBeUndefined();
        });

        it('devrait marquer un échec temporaire pour retry', () => {
            const errorMessage = 'Network timeout';
            
            service.markIndexingFailure(mockSkeleton, errorMessage, false);
            
            expect(mockSkeleton.metadata.indexingState!.indexStatus).toBe('retry');
            expect(mockSkeleton.metadata.indexingState!.indexError).toBe(errorMessage);
            expect(mockSkeleton.metadata.indexingState!.indexRetryCount).toBe(1);
        });

        it('devrait marquer un échec permanent', () => {
            const errorMessage = 'File corrupted';
            
            service.markIndexingFailure(mockSkeleton, errorMessage, true);
            
            expect(mockSkeleton.metadata.indexingState!.indexStatus).toBe('failed');
            expect(mockSkeleton.metadata.indexingState!.indexError).toBe(errorMessage);
        });

        it('devrait basculer vers échec permanent après max retry', () => {
            // Simuler 2 échecs précédents
            mockSkeleton.metadata.indexingState = {
                indexRetryCount: 2
            };
            
            service.markIndexingFailure(mockSkeleton, 'Retry exhausted', false);
            
            expect(mockSkeleton.metadata.indexingState!.indexStatus).toBe('failed');
        });
    });

    describe('Première indexation', () => {
        it('devrait indexer une tâche jamais indexée', () => {
            // Pas d'état d'indexation du tout
            const decision = service.shouldIndex(mockSkeleton);
            
            expect(decision.shouldIndex).toBe(true);
            expect(decision.reason).toContain('Première indexation');
            expect(decision.action).toBe('index');
        });
    });

    describe('Réindexation après modification', () => {
        it('devrait indexer si contenu modifié après succès', () => {
            const now = Date.now();
            
            mockSkeleton.metadata.lastActivity = new Date(now).toISOString();
            mockSkeleton.metadata.indexingState = {
                indexStatus: 'success',
                lastIndexedAt: new Date(now - 60 * 60 * 1000).toISOString() // 1h avant
            };
            
            const decision = service.shouldIndex(mockSkeleton);
            
            expect(decision.shouldIndex).toBe(true);
            expect(decision.reason).toContain('réindexation requise');
            expect(decision.action).toBe('index');
        });
    });
});