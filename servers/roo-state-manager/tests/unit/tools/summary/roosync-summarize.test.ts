/**
 * Tests unitaires pour l'outil roosync_summarize (CONS-12)
 *
 * Teste les 3 types d'opérations:
 * - type: 'trace' - Résumé simple de conversation
 * - type: 'cluster' - Résumé de grappe de tâches
 * - type: 'synthesis' - Synthèse LLM complète
 *
 * Ces tests se concentrent sur la validation des arguments et le dispatch correct
 * vers les handlers appropriés. Les tests d'intégration complète sont réalisés
 * manuellement via le wrapper MCP.
 */

import { describe, it, expect } from 'vitest';
import { handleRooSyncSummarize } from '../../../../src/tools/summary/roosync-summarize.tool.js';
import { ConversationSkeleton } from '../../../../src/types/conversation.js';
import { StateManagerError } from '../../../../src/types/errors.js';

// Helper function minimale pour les tests de validation
async function getConversationSkeletonMock(taskId: string): Promise<ConversationSkeleton | null> {
    if (taskId === 'non-existent-task') {
        return null;
    }
    // Retourne un skeleton minimal valide pour les autres cas
    return {
        taskId,
        metadata: {
            lastActivity: new Date().toISOString(),
            createdAt: new Date().toISOString(),
            messageCount: 0,
            actionCount: 0,
            totalSize: 0
        },
        sequence: []
    } as ConversationSkeleton;
}

describe('roosync_summarize - CONS-12', () => {

    describe('Validation des arguments (tests critiques)', () => {
        it('devrait rejeter si type est manquant', async () => {
            await expect(
                handleRooSyncSummarize(
                    { taskId: 'test-123' } as any,
                    getConversationSkeletonMock
                )
            ).rejects.toThrow(StateManagerError);
        });

        it('devrait rejeter si taskId est manquant', async () => {
            await expect(
                handleRooSyncSummarize(
                    { type: 'trace' } as any,
                    getConversationSkeletonMock
                )
            ).rejects.toThrow(StateManagerError);
        });

        it('devrait rejeter si type est invalide', async () => {
            await expect(
                handleRooSyncSummarize(
                    { type: 'invalid', taskId: 'test-123' } as any,
                    getConversationSkeletonMock
                )
            ).rejects.toThrow(StateManagerError);
        });

        it('devrait accepter type=trace avec arguments valides', async () => {
            await expect(
                handleRooSyncSummarize(
                    {
                        type: 'trace',
                        taskId: 'test-123',
                        outputFormat: 'markdown'
                    },
                    getConversationSkeletonMock
                )
            ).resolves.toBeDefined();
        });

        it('devrait accepter type=cluster avec arguments valides', async () => {
            const findChildTasksMock = async () => [];
            await expect(
                handleRooSyncSummarize(
                    {
                        type: 'cluster',
                        taskId: 'test-123',
                        outputFormat: 'markdown'
                    },
                    getConversationSkeletonMock,
                    findChildTasksMock
                )
            ).resolves.toBeDefined();
        });

        it('devrait rejeter type=synthesis (désactivé — stubs #767/#768)', async () => {
            await expect(
                handleRooSyncSummarize(
                    {
                        type: 'synthesis',
                        taskId: 'test-123',
                        outputFormat: 'json'
                    },
                    getConversationSkeletonMock
                )
            ).rejects.toThrow('disabled');
        });
    });

    describe('Dispatch vers handlers appropriés', () => {
        it('devrait appeler le handler trace pour type=trace', async () => {
            const result = await handleRooSyncSummarize(
                {
                    type: 'trace',
                    taskId: 'test-123',
                    detailLevel: 'Summary'
                },
                getConversationSkeletonMock
            );

            expect(typeof result).toBe('string');
        });

        it('devrait appeler le handler cluster pour type=cluster', async () => {
            const findChildTasksMock = async () => [];
            const result = await handleRooSyncSummarize(
                {
                    type: 'cluster',
                    taskId: 'test-123'
                },
                getConversationSkeletonMock,
                findChildTasksMock
            );

            expect(typeof result).toBe('string');
        });

        it('devrait rejeter synthesis (désactivé — stubs #767/#768)', async () => {
            await expect(
                handleRooSyncSummarize(
                    {
                        type: 'synthesis',
                        taskId: 'test-123',
                        outputFormat: 'json'
                    },
                    getConversationSkeletonMock
                )
            ).rejects.toThrow('disabled');
        });
    });

    describe('Propagation des paramètres', () => {
        it('devrait propager les paramètres trace correctement', async () => {
            const result = await handleRooSyncSummarize(
                {
                    type: 'trace',
                    taskId: 'test-123',
                    detailLevel: 'Summary',
                    outputFormat: 'markdown',
                    truncationChars: 500,
                    compactStats: true
                },
                getConversationSkeletonMock
            );

            expect(typeof result).toBe('string');
        });

        it('devrait propager les paramètres cluster correctement', async () => {
            const findChildTasksMock = async () => [];
            const result = await handleRooSyncSummarize(
                {
                    type: 'cluster',
                    taskId: 'test-123',
                    clusterMode: 'aggregated',
                    includeClusterStats: true,
                    crossTaskAnalysis: false
                },
                getConversationSkeletonMock,
                findChildTasksMock
            );

            expect(typeof result).toBe('string');
        });

        it('devrait rejeter synthesis même avec paramètres valides (désactivé — stubs #767/#768)', async () => {
            await expect(
                handleRooSyncSummarize(
                    {
                        type: 'synthesis',
                        taskId: 'test-123',
                        outputFormat: 'markdown'
                    },
                    getConversationSkeletonMock
                )
            ).rejects.toThrow('disabled');
        });
    });

    describe('Gestion d\'erreurs', () => {
        it('devrait gérer une conversation inexistante pour trace', async () => {
            await expect(
                handleRooSyncSummarize(
                    {
                        type: 'trace',
                        taskId: 'non-existent-task'
                    },
                    getConversationSkeletonMock
                )
            ).rejects.toThrow();
        });

        it('devrait rejeter synthesis même avec conversation inexistante (désactivé avant dispatch)', async () => {
            await expect(
                handleRooSyncSummarize(
                    {
                        type: 'synthesis',
                        taskId: 'non-existent-task'
                    },
                    getConversationSkeletonMock
                )
            ).rejects.toThrow('disabled');
        });
    });

    describe('Compatibilité backward (smoke tests)', () => {
        it('devrait supporter tous les paramètres de generate_trace_summary', async () => {
            const result = await handleRooSyncSummarize(
                {
                    type: 'trace',
                    taskId: 'test-123',
                    detailLevel: 'Full',
                    outputFormat: 'html',
                    truncationChars: 1000,
                    compactStats: false,
                    includeCss: true,
                    generateToc: true,
                    startIndex: 1,
                    endIndex: 10
                },
                getConversationSkeletonMock
            );

            expect(typeof result).toBe('string');
        });

        it('devrait supporter tous les paramètres de generate_cluster_summary', async () => {
            const findChildTasksMock = async () => [];
            const result = await handleRooSyncSummarize(
                {
                    type: 'cluster',
                    taskId: 'test-123',
                    childTaskIds: [],
                    clusterMode: 'detailed',
                    includeClusterStats: true,
                    crossTaskAnalysis: true,
                    maxClusterDepth: 5,
                    clusterSortBy: 'chronological',
                    includeClusterTimeline: true,
                    showTaskRelationships: true
                },
                getConversationSkeletonMock,
                findChildTasksMock
            );

            expect(typeof result).toBe('string');
        });

        it('devrait rejeter synthesis backward compat (désactivé — stubs #767/#768)', async () => {
            await expect(
                handleRooSyncSummarize(
                    {
                        type: 'synthesis',
                        taskId: 'test-123',
                        outputFormat: 'json'
                    },
                    getConversationSkeletonMock
                )
            ).rejects.toThrow('disabled');
        });
    });
});
