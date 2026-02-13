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
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ConversationSkeleton } from '../../../../src/types/conversation.js';

// Mock des services d'indexation
vi.mock('../../../../src/services/task-indexer.js', () => ({
    TaskIndexer: class {
        resetCollection = vi.fn().mockResolvedValue(undefined);
    },
    getHostIdentifier: vi.fn(() => 'test-host-os'),
    indexTask: vi.fn().mockResolvedValue([{ id: 'point-1' }])
}));

vi.mock('../../../../src/utils/roo-storage-detector.js', () => ({
    RooStorageDetector: {
        findConversationById: vi.fn().mockResolvedValue({ path: '/fake/path/task-123' })
    }
}));

vi.mock('../../../../src/services/qdrant.js', () => ({
    getQdrantClient: vi.fn(() => ({
        getCollections: vi.fn().mockResolvedValue({ collections: [] }),
        getCollection: vi.fn().mockRejectedValue(new Error('Collection not found'))
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

        vi.clearAllMocks();
    });

    // ============================================================
    // Tests pour la définition de l'outil
    // ============================================================

    describe('tool definition', () => {
        it('should have correct name', () => {
            expect(roosyncIndexingTool.name).toBe('roosync_indexing');
        });

        it('should have action enum with 4 values', () => {
            const actionProp = (roosyncIndexingTool.inputSchema as any).properties.action;
            expect(actionProp.enum).toEqual(['index', 'reset', 'rebuild', 'diagnose']);
        });

        it('should require action parameter', () => {
            expect((roosyncIndexingTool.inputSchema as any).required).toContain('action');
        });

        it('should include all parameters', () => {
            const props = (roosyncIndexingTool.inputSchema as any).properties;
            expect(props.task_id).toBeDefined();
            expect(props.confirm).toBeDefined();
            expect(props.workspace_filter).toBeDefined();
            expect(props.max_tasks).toBeDefined();
            expect(props.dry_run).toBeDefined();
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
            // Le résultat dépend de l'indexation réelle, on vérifie juste qu'il n'est pas une erreur de validation
            expect((result.content[0] as any).text).toBeDefined();
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

            // Le reset appelle TaskIndexer.resetCollection() en interne
            expect((result.content[0] as any).text).toBeDefined();
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
            expect(result.isError).toBeFalsy();
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

            // Le diagnostic retourne toujours un résultat structuré
            expect((result.content[0] as any).text).toBeDefined();
            // Ne devrait pas avoir appelé le rebuildHandler
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
