/**
 * Tests unitaires pour roosync_indexing (CONS-11)
 *
 * Outil consolidé remplaçant index_task_semantic, reset_qdrant_collection,
 * rebuild_task_index, diagnose_semantic_index
 *
 * Couvre les 4 actions : index, reset, rebuild, diagnose
 *
 * Framework: Vitest
 */

import { roosyncIndexingTool, handleRooSyncIndexing } from '../../../../src/tools/indexing/roosync-indexing.tool.js';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ConversationSkeleton } from '../../../../src/types/conversation.js';

// Mock des services d'indexation.
// NB: la config vitest pose `mockReset: true` — les implémentations posées via
// .mockResolvedValue() sur les mocks de factory sont RESETTÉES avant chaque test,
// celles passées inline à vi.fn(impl) survivent. Les mocks ci-dessous doivent
// donc rester en impl inline (mesuré: findConversationById en .mockResolvedValue
// rendait undefined et le test index passait silencieusement par la branche
// « Task directory not found »).
vi.mock('../../../../src/services/task-indexer.js', () => ({
    TaskIndexer: class {
        resetCollection = vi.fn().mockResolvedValue(undefined);
    },
    getHostIdentifier: vi.fn(() => 'test-host-os'),
    indexTask: vi.fn(async () => [{ id: 'point-1' }])
}));

vi.mock('../../../../src/utils/roo-storage-detector.js', () => ({
    RooStorageDetector: {
        findConversationById: vi.fn(async () => ({ path: '/fake/path/task-123' }))
    }
}));

vi.mock('../../../../src/services/qdrant.js', () => ({
    // NB: scroll en impl inline (pas .mockResolvedValue) pour survivre au
    // mockReset:true — sans scroll, cleanup_orphans sort en early-return avec
    // « Failed to scroll Qdrant » absorbé dans errors (cleanup-orphans.ts:225).
    // points: [] arrête la boucle de scrollUniqueTaskIds (:72-75) → scan sain.
    getQdrantClient: vi.fn(() => ({
        getCollections: vi.fn().mockResolvedValue({ collections: [] }),
        getCollection: vi.fn().mockRejectedValue(new Error('Collection not found')),
        scroll: vi.fn(async () => ({ points: [] }))
    }))
}));

vi.mock('../../../../src/services/openai.js', () => ({
    default: vi.fn(() => ({
        embeddings: {
            create: vi.fn().mockRejectedValue(new Error('No API key'))
        }
    })),
    getEmbeddingModel: vi.fn(() => 'text-embedding-3-small'),
    getEmbeddingDimensions: vi.fn(() => 1536)
}));

describe('roosync_indexing - CONS-11', () => {
    let conversationCache: Map<string, ConversationSkeleton>;
    let ensureCacheFreshCallback: any;
    let saveSkeletonCallback: any;
    let qdrantIndexQueue: Set<string>;
    let setQdrantIndexingEnabled: any;
    let rebuildHandler: any;

    beforeEach(() => {
        conversationCache = new Map();
        ensureCacheFreshCallback = vi.fn().mockResolvedValue(true);
        saveSkeletonCallback = vi.fn().mockResolvedValue(undefined);
        qdrantIndexQueue = new Set();
        setQdrantIndexingEnabled = vi.fn();
        rebuildHandler = vi.fn().mockResolvedValue({
            content: [{ type: 'text', text: '# Rebuild completed\n\nTasks processed: 10' }]
        });

        // L'action=index ne traverse le garde EMBEDDING_API_KEY que si la clé
        // existe : sans stub, le test suivrait la branche erreur selon la machine.
        vi.stubEnv('EMBEDDING_API_KEY', 'test-key');
        vi.stubEnv('ROO_INDEXING_ENABLED', 'true');

        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    // ============================================================
    // Tests pour la définition de l'outil
    // ============================================================

    describe('tool definition', () => {
        it('should have correct name', () => {
            expect(roosyncIndexingTool.name).toBe('roosync_indexing');
        });

        it('should have action enum with 15 values', () => {
            const actionProp = (roosyncIndexingTool.inputSchema as any).properties.action;
            expect(actionProp.enum).toEqual(['index', 'reset', 'rebuild', 'diagnose', 'archive', 'status', 'cleanup', 'garbage_scan', 'cleanup_orphans', 'repair_gaps', 'repair_workspace', 'cleanup_failed', 'tool_usage_stats', 'save_snapshot', 'trend_report']);
        });

        it('should require action parameter', () => {
            expect((roosyncIndexingTool.inputSchema as any).required).toContain('action');
        });

        it('should include all parameters with their declared types and defaults', () => {
            const props = (roosyncIndexingTool.inputSchema as any).properties;
            expect(props.task_id).toMatchObject({ type: 'string' });
            expect(props.confirm).toMatchObject({ type: 'boolean', default: false });
            expect(props.workspace_filter).toMatchObject({ type: 'string' });
            expect(props.max_tasks).toMatchObject({ type: 'number', default: 0 });
            expect(props.dry_run).toMatchObject({ type: 'boolean', default: false });
        });
    });

    // ============================================================
    // Tests pour validation des arguments
    // ============================================================

    describe('argument validation', () => {
        it('should return error when action is missing', async () => {
            const result = await handleRooSyncIndexing(
                {} as any,
                conversationCache,
                ensureCacheFreshCallback,
                saveSkeletonCallback,
                qdrantIndexQueue,
                setQdrantIndexingEnabled,
                rebuildHandler
            );
            expect(result.isError).toBe(true);
            expect((result.content[0] as any).text).toContain('action');
        });

        it('should return error when action is invalid', async () => {
            const result = await handleRooSyncIndexing(
                { action: 'invalid' as any },
                conversationCache,
                ensureCacheFreshCallback,
                saveSkeletonCallback,
                qdrantIndexQueue,
                setQdrantIndexingEnabled,
                rebuildHandler
            );
            expect(result.isError).toBe(true);
            expect((result.content[0] as any).text).toContain('invalide');
        });

        it('should return error when task_id is missing for index action', async () => {
            const result = await handleRooSyncIndexing(
                { action: 'index' },
                conversationCache,
                ensureCacheFreshCallback,
                saveSkeletonCallback,
                qdrantIndexQueue,
                setQdrantIndexingEnabled,
                rebuildHandler
            );
            expect(result.isError).toBe(true);
            expect((result.content[0] as any).text).toContain('task_id');
        });
    });

    // ============================================================
    // Tests pour action=index
    // ============================================================

    describe('action: index', () => {
        it('should call index handler with task_id', async () => {
            // Ajouter la tâche au cache pour que le handler la trouve
            conversationCache.set('task-123', {
                taskId: 'task-123',
                metadata: {},
                sequence: []
            } as ConversationSkeleton);

            const result = await handleRooSyncIndexing(
                { action: 'index', task_id: 'task-123' },
                conversationCache,
                ensureCacheFreshCallback,
                saveSkeletonCallback,
                qdrantIndexQueue,
                setQdrantIndexingEnabled,
                rebuildHandler
            );

            expect(ensureCacheFreshCallback).toHaveBeenCalled();
            // Le mock indexTask rend [{ id: 'point-1' }] → 1 chunk. Le texte de
            // succès prouve que le dispatch a atteint indexTaskSemanticTool.handler
            // ET traversé ses gardes (kill-switch, clé d'embedding, cache).
            expect(result.isError).toBeUndefined();
            const text = (result.content[0] as any).text;
            expect(text).toContain('# Indexation sémantique terminée');
            expect(text).toContain('**Tâche:** task-123');
            expect(text).toContain('**Chunks indexés:** 1');
            expect(rebuildHandler).not.toHaveBeenCalled();
        });
    });

    // ============================================================
    // Tests pour action=reset
    // ============================================================

    describe('action: reset', () => {
        it('should call reset handler', async () => {
            const result = await handleRooSyncIndexing(
                { action: 'reset', confirm: true },
                conversationCache,
                ensureCacheFreshCallback,
                saveSkeletonCallback,
                qdrantIndexQueue,
                setQdrantIndexingEnabled,
                rebuildHandler
            );

            // Le mock TaskIndexer.resetCollection résout → resetCollection() a été
            // franchi sans lever (sinon success:false dans le catch du handler).
            expect(result.isError).toBeUndefined();
            expect(setQdrantIndexingEnabled).toHaveBeenCalledWith(true);
            // Cache vide → 0 squelettes reset, 0 tâches en queue
            expect(JSON.parse((result.content[0] as any).text)).toEqual({
                success: true,
                message: 'Collection Qdrant réinitialisée avec succès',
                skeletonsReset: 0,
                queuedForReindexing: 0
            });
        });
    });

    // ============================================================
    // Tests pour action=rebuild
    // ============================================================

    describe('action: rebuild', () => {
        it('should call rebuild handler with correct args', async () => {
            const result = await handleRooSyncIndexing(
                {
                    action: 'rebuild',
                    workspace_filter: 'my-workspace',
                    max_tasks: 5,
                    dry_run: true
                },
                conversationCache,
                ensureCacheFreshCallback,
                saveSkeletonCallback,
                qdrantIndexQueue,
                setQdrantIndexingEnabled,
                rebuildHandler
            );

            expect(rebuildHandler).toHaveBeenCalledWith({
                workspace_filter: 'my-workspace',
                max_tasks: 5,
                dry_run: true
            });
            expect((result.content[0] as any).text).toContain('Rebuild completed');
        });

        it('should work with default rebuild args', async () => {
            const result = await handleRooSyncIndexing(
                { action: 'rebuild' },
                conversationCache,
                ensureCacheFreshCallback,
                saveSkeletonCallback,
                qdrantIndexQueue,
                setQdrantIndexingEnabled,
                rebuildHandler
            );

            expect(rebuildHandler).toHaveBeenCalledWith({
                workspace_filter: undefined,
                max_tasks: undefined,
                dry_run: undefined
            });
            expect(result.isError).toBeUndefined();
            expect((result.content[0] as any).text).toContain('Rebuild completed');
        });
    });

    // ============================================================
    // Tests pour action=diagnose
    // ============================================================

    describe('action: diagnose', () => {
        it('should call diagnose handler and return diagnostics', async () => {
            const result = await handleRooSyncIndexing(
                { action: 'diagnose' },
                conversationCache,
                ensureCacheFreshCallback,
                saveSkeletonCallback,
                qdrantIndexQueue,
                setQdrantIndexingEnabled,
                rebuildHandler
            );

            // Le mock Qdrant rend getCollections → liste SANS la collection cible :
            // statut déterministe missing_collection (pas healthy par accident).
            const diagnostics = JSON.parse((result.content[0] as any).text);
            expect(diagnostics).toMatchObject({
                status: 'missing_collection',
                collection_name: 'roo_tasks_semantic_index',
                details: {
                    qdrant_connection: 'success',
                    collection_exists: false
                }
            });
            expect(diagnostics.errors).toEqual(
                expect.arrayContaining([
                    expect.stringContaining("n'existe pas dans Qdrant")
                ])
            );
            // Ne devrait pas avoir appelé le rebuildHandler
            expect(rebuildHandler).not.toHaveBeenCalled();
        });
    });

    // ============================================================
    // Tests pour action=cleanup_orphans
    // ============================================================

    describe('action: cleanup_orphans', () => {
        it('should default to dry-run scan mode and report a structured payload', async () => {
            const result = await handleRooSyncIndexing(
                { action: 'cleanup_orphans' },
                conversationCache,
                ensureCacheFreshCallback,
                saveSkeletonCallback,
                qdrantIndexQueue,
                setQdrantIndexingEnabled,
                rebuildHandler
            );

            // Le mock Qdrant n'expose pas scroll → 0 task_ids côté serveur :
            // le scan rend toujours un JSON structuré (erreurs absorbées dans
            // result.errors, jamais un throw).
            // Le tool pose explicitement isError:false (pas undefined)
            expect(result.isError).toBe(false);
            const payload = JSON.parse((result.content[0] as any).text);
            expect(payload).toMatchObject({
                action: 'cleanup_orphans',
                mode: 'dry_run',
                scan: { orphans_detected: 0 }
            });
            // Contrat de projection (roosync-indexing.tool.ts, case
            // cleanup_orphans) : errors n'est projeté QUE non vide —
            // undefined (clé absente du JSON) est le témoin d'un scan
            // sans aucune erreur absorbée (scroll/check/delete).
            expect(payload.errors).toBeUndefined();
            expect(rebuildHandler).not.toHaveBeenCalled();
        });

        it('should not call rebuild for cleanup_orphans action', async () => {
            await handleRooSyncIndexing(
                { action: 'cleanup_orphans' },
                conversationCache,
                ensureCacheFreshCallback,
                saveSkeletonCallback,
                qdrantIndexQueue,
                setQdrantIndexingEnabled,
                rebuildHandler
            );

            expect(rebuildHandler).not.toHaveBeenCalled();
        });
    });

    // ============================================================
    // Tests de dispatch correct
    // ============================================================

    describe('dispatch', () => {
        it('should not call rebuild for index action', async () => {
            conversationCache.set('task-1', {
                taskId: 'task-1',
                metadata: {},
                sequence: []
            } as ConversationSkeleton);

            await handleRooSyncIndexing(
                { action: 'index', task_id: 'task-1' },
                conversationCache,
                ensureCacheFreshCallback,
                saveSkeletonCallback,
                qdrantIndexQueue,
                setQdrantIndexingEnabled,
                rebuildHandler
            );

            expect(rebuildHandler).not.toHaveBeenCalled();
        });

        it('should not call rebuild for diagnose action', async () => {
            await handleRooSyncIndexing(
                { action: 'diagnose' },
                conversationCache,
                ensureCacheFreshCallback,
                saveSkeletonCallback,
                qdrantIndexQueue,
                setQdrantIndexingEnabled,
                rebuildHandler
            );

            expect(rebuildHandler).not.toHaveBeenCalled();
        });
    });
});
