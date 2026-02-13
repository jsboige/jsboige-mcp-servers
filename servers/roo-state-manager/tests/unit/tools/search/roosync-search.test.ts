/**
 * Tests unitaires pour roosync_search (CONS-11)
 *
 * Outil consolidé remplaçant search_tasks_by_content
 * Couvre les 3 actions : semantic, text, diagnose
 *
 * Framework: Vitest
 */

import { roosyncSearchTool, handleRooSyncSearch } from '../../../../src/tools/search/roosync-search.tool.js';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// Mocks
const mockQdrantClient = {
    search: vi.fn(),
    getCollection: vi.fn(),
};

const mockOpenAIClient = {
    embeddings: {
        create: vi.fn()
    }
};

vi.mock('../../../../src/services/qdrant.js', () => ({
    getQdrantClient: vi.fn(() => mockQdrantClient)
}));

vi.mock('../../../../src/services/openai.js', () => ({
    default: vi.fn(() => mockOpenAIClient),
    getEmbeddingModel: vi.fn(() => 'text-embedding-3-small'),
    getEmbeddingDimensions: vi.fn(() => 1536)
}));

vi.mock('../../../../src/services/task-indexer.js', () => ({
    TaskIndexer: class {},
    getHostIdentifier: vi.fn(() => 'test-host-os')
}));

describe('roosync_search - CONS-11', () => {
    let conversationCache: Map<string, any>;
    let ensureCacheFreshCallback: any;
    let fallbackHandler: any;
    let diagnoseHandler: any;

    beforeEach(() => {
        conversationCache = new Map();
        ensureCacheFreshCallback = vi.fn().mockResolvedValue(true);
        fallbackHandler = vi.fn().mockResolvedValue({
            content: [{ type: 'text', text: 'Fallback result' }]
        });
        diagnoseHandler = vi.fn().mockResolvedValue({
            content: [{ type: 'text', text: 'Diagnostic result' }]
        });

        vi.clearAllMocks();

        mockOpenAIClient.embeddings.create.mockResolvedValue({
            data: [{ embedding: Array(1536).fill(0.1) }]
        });

        mockQdrantClient.search.mockResolvedValue([
            {
                id: 'chunk-1',
                score: 0.95,
                payload: {
                    task_id: 'task-1',
                    content: 'Test content match',
                    chunk_type: 'message_exchange',
                    workspace: 'test-workspace',
                    task_title: 'Test Task',
                    host_os: 'test-host-os'
                }
            }
        ]);
    });

    // ============================================================
    // Tests pour la définition de l'outil
    // ============================================================

    describe('tool definition', () => {
        it('should have correct name', () => {
            expect(roosyncSearchTool.name).toBe('roosync_search');
        });

        it('should have action enum with 3 values', () => {
            const actionProp = (roosyncSearchTool.inputSchema as any).properties.action;
            expect(actionProp.enum).toEqual(['semantic', 'text', 'diagnose']);
        });

        it('should require action parameter', () => {
            expect((roosyncSearchTool.inputSchema as any).required).toContain('action');
        });

        it('should include all search parameters', () => {
            const props = (roosyncSearchTool.inputSchema as any).properties;
            expect(props.search_query).toBeDefined();
            expect(props.conversation_id).toBeDefined();
            expect(props.max_results).toBeDefined();
            expect(props.workspace).toBeDefined();
        });
    });

    // ============================================================
    // Tests pour validation des arguments
    // ============================================================

    describe('argument validation', () => {
        it('should return error when action is missing', async () => {
            const result = await handleRooSyncSearch(
                {} as any,
                conversationCache,
                ensureCacheFreshCallback,
                fallbackHandler
            );
            expect(result.isError).toBe(true);
            expect((result.content[0] as any).text).toContain('action');
        });

        it('should return error when action is invalid', async () => {
            const result = await handleRooSyncSearch(
                { action: 'invalid' as any },
                conversationCache,
                ensureCacheFreshCallback,
                fallbackHandler
            );
            expect(result.isError).toBe(true);
            expect((result.content[0] as any).text).toContain('invalide');
        });

        it('should return error when search_query is missing for semantic', async () => {
            const result = await handleRooSyncSearch(
                { action: 'semantic' },
                conversationCache,
                ensureCacheFreshCallback,
                fallbackHandler
            );
            expect(result.isError).toBe(true);
            expect((result.content[0] as any).text).toContain('search_query');
        });

        it('should return error when search_query is missing for text', async () => {
            const result = await handleRooSyncSearch(
                { action: 'text' },
                conversationCache,
                ensureCacheFreshCallback,
                fallbackHandler
            );
            expect(result.isError).toBe(true);
            expect((result.content[0] as any).text).toContain('search_query');
        });
    });

    // ============================================================
    // Tests pour action=semantic
    // ============================================================

    describe('action: semantic', () => {
        it('should perform semantic search successfully', async () => {
            const result = await handleRooSyncSearch(
                { action: 'semantic', search_query: 'test query', max_results: 5 },
                conversationCache,
                ensureCacheFreshCallback,
                fallbackHandler
            );

            expect(mockOpenAIClient.embeddings.create).toHaveBeenCalledWith({
                model: 'text-embedding-3-small',
                input: 'test query'
            });
            expect(result.isError).toBeFalsy();
            const content = JSON.parse((result.content[0] as any).text);
            expect(content.results).toHaveLength(1);
            expect(content.results[0].taskId).toBe('task-1');
        });

        it('should pass workspace filter', async () => {
            await handleRooSyncSearch(
                { action: 'semantic', search_query: 'test', workspace: 'my-workspace' },
                conversationCache,
                ensureCacheFreshCallback,
                fallbackHandler
            );

            expect(mockQdrantClient.search).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({
                    filter: {
                        must: [
                            { key: 'workspace', match: { value: 'my-workspace' } }
                        ]
                    }
                })
            );
        });

        it('should fallback to text on semantic error', async () => {
            mockOpenAIClient.embeddings.create.mockRejectedValue(new Error('OpenAI Error'));

            const result = await handleRooSyncSearch(
                { action: 'semantic', search_query: 'test query' },
                conversationCache,
                ensureCacheFreshCallback,
                fallbackHandler
            );

            expect(fallbackHandler).toHaveBeenCalled();
            expect((result.content[0] as any).text).toBe('Fallback result');
        });
    });

    // ============================================================
    // Tests pour action=text
    // ============================================================

    describe('action: text', () => {
        it('should perform text search in cache', async () => {
            conversationCache.set('task-1', {
                metadata: { title: 'Hello World Task', workspace: 'ws1' },
                truncatedInstruction: 'Do something with hello',
                sequence: [],
                isCompleted: false
            });

            const result = await handleRooSyncSearch(
                { action: 'text', search_query: 'hello' },
                conversationCache,
                ensureCacheFreshCallback,
                fallbackHandler
            );

            expect(ensureCacheFreshCallback).toHaveBeenCalled();
            expect(result.isError).toBeFalsy();
            const content = JSON.parse((result.content[0] as any).text);
            expect(content.success).toBe(true);
            expect(content.searchType).toBe('text');
            expect(content.results.length).toBeGreaterThanOrEqual(1);
        });

        it('should filter by workspace in text search', async () => {
            conversationCache.set('task-ws1', {
                metadata: { title: 'WS1 Task', workspace: 'workspace-1' },
                truncatedInstruction: 'Test',
                sequence: [],
                isCompleted: false
            });
            conversationCache.set('task-ws2', {
                metadata: { title: 'WS2 Task', workspace: 'workspace-2' },
                truncatedInstruction: 'Test',
                sequence: [],
                isCompleted: false
            });

            const result = await handleRooSyncSearch(
                { action: 'text', search_query: 'Task', workspace: 'workspace-1' },
                conversationCache,
                ensureCacheFreshCallback,
                fallbackHandler
            );

            const content = JSON.parse((result.content[0] as any).text);
            expect(content.metadata.workspace).toBe('workspace-1');
        });
    });

    // ============================================================
    // Tests pour action=diagnose
    // ============================================================

    describe('action: diagnose', () => {
        it('should call diagnose handler', async () => {
            const result = await handleRooSyncSearch(
                { action: 'diagnose' },
                conversationCache,
                ensureCacheFreshCallback,
                fallbackHandler,
                diagnoseHandler
            );

            expect(diagnoseHandler).toHaveBeenCalled();
            expect((result.content[0] as any).text).toBe('Diagnostic result');
        });

        it('should not require search_query for diagnose', async () => {
            const result = await handleRooSyncSearch(
                { action: 'diagnose' },
                conversationCache,
                ensureCacheFreshCallback,
                fallbackHandler,
                diagnoseHandler
            );

            expect(result.isError).toBeFalsy();
        });
    });

    // ============================================================
    // Backward compatibility
    // ============================================================

    describe('backward compatibility', () => {
        it('should handle same parameters as search_tasks_by_content', async () => {
            const result = await handleRooSyncSearch(
                {
                    action: 'semantic',
                    search_query: 'test query',
                    conversation_id: 'conv-123',
                    max_results: 10,
                    workspace: 'test-ws'
                },
                conversationCache,
                ensureCacheFreshCallback,
                fallbackHandler
            );

            expect(result.isError).toBeFalsy();
            expect(mockQdrantClient.search).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({
                    filter: {
                        must: expect.arrayContaining([
                            { key: 'task_id', match: { value: 'conv-123' } },
                            { key: 'workspace', match: { value: 'test-ws' } }
                        ])
                    }
                })
            );
        });
    });
});
