/**
 * Tests unitaires pour roosync_search (CONS-11)
 *
 * Outil consolidé remplaçant search_tasks_by_content
 * Couvre les 3 actions : semantic, text, diagnose
 *
 * Framework: Vitest
 */

import { roosyncSearchTool, handleRooSyncSearch } from '../../../../src/tools/search/roosync-search.tool.js';
import { _resetEmbeddingCircuitBreaker, INFRASTRUCTURE_ERROR_MODES } from '../../../../src/tools/search/search-semantic.tool.js';
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
    getQdrantClient: vi.fn(() => mockQdrantClient),
    isLargeCollection: vi.fn(() => Promise.resolve(false)),
    getCollectionSize: vi.fn(() => Promise.resolve(0))
}));

vi.mock('../../../../src/services/openai.js', () => ({
    default: vi.fn(() => mockOpenAIClient),
    // #4352 (a5): semantic query paths read through the interactive (query) client.
    getEmbeddingQueryClient: vi.fn(() => mockOpenAIClient),
    getEmbeddingModel: vi.fn(() => 'text-embedding-3-small'),
    getEmbeddingDimensions: vi.fn(() => 1536)
}));

vi.mock('../../../../src/services/task-indexer.js', () => ({
    TaskIndexer: class {},
    getHostIdentifier: vi.fn(() => 'test-host-os')
}));

vi.mock('../../../../src/services/task-indexer/ChunkExtractor.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../../src/services/task-indexer/ChunkExtractor.js')>()),
    getHostIdentifier: vi.fn(() => 'test-host-os')
}));

const mockTextFallback = vi.hoisted(() => vi.fn());
// Captured at module-mock time; re-applied in beforeEach because the CI config
// sets mockReset:true, which wipes any implementation installed here.
const actualFallbackRef = vi.hoisted(() => ({ current: null as null | ((args: any, cache: any) => Promise<any>) }));

vi.mock('../../../../src/tools/search/search-fallback.tool.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../../src/tools/search/search-fallback.tool.js')>();
    actualFallbackRef.current = actual.handleSearchTasksSemanticFallback as any;
    return { ...actual, handleSearchTasksSemanticFallback: mockTextFallback };
});

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
        // mockReset:true wipes factory-time implementations — delegate to the real
        // fallback handler unless a test overrides it.
        mockTextFallback.mockImplementation((...args: any[]) => (actualFallbackRef.current as any)(...args));

        // #2167: Reset circuit breaker + query embedding cache between tests
        _resetEmbeddingCircuitBreaker();

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

        it('should include all search parameters with their declared types', () => {
            const props = (roosyncSearchTool.inputSchema as any).properties;
            expect(props.search_query).toMatchObject({ type: 'string' });
            expect(props.conversation_id).toMatchObject({ type: 'string' });
            expect(props.max_results).toMatchObject({ type: 'number' });
            expect(props.workspace).toMatchObject({ type: 'string' });
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
                { action: 'semantic', search_query: 'test query', max_results: 5, workspace: 'd:\\test-workspace' },
                conversationCache,
                ensureCacheFreshCallback,
                fallbackHandler
            );

            expect(mockOpenAIClient.embeddings.create).toHaveBeenCalledWith({
                model: 'text-embedding-3-small',
                input: 'test query'
            });
            expect(result.isError).toBe(false);
            const content = JSON.parse((result.content[0] as any).text);
            expect(content.results).toHaveLength(1);
            expect(content.results[0].taskId).toBe('task-1');
        });

        it('#883: basename filters on workspace_name, full path on workspace', async () => {
            await handleRooSyncSearch(
                { action: 'semantic', search_query: 'test', workspace: 'my-workspace' },
                conversationCache,
                ensureCacheFreshCallback,
                fallbackHandler
            );

            // Basename → uses workspace_name field for cross-machine matching
            const searchCall = mockQdrantClient.search.mock.calls[0][1];
            expect(searchCall.filter.must).toContainEqual({ key: 'workspace_name', match: { value: 'my-workspace' } });
        });

        it('#883: missing workspace → global semantic search, no workspace filter', async () => {
            const result = await handleRooSyncSearch(
                { action: 'semantic', search_query: 'test query' },
                conversationCache,
                ensureCacheFreshCallback,
                fallbackHandler
            );
            // Le nom d'origine (« auto-default workspace ») décrivait un comportement
            // qui n'existe pas : #883 impose un workspace OPTIONNEL, sans défaut.
            // Sans workspace, la recherche Qdrant est globale — aucune condition
            // workspace/workspace_name dans le filtre (mesuré : filter === undefined).
            expect(result.isError).toBe(false);
            const searchCall = mockQdrantClient.search.mock.calls[0][1];
            const conditions = searchCall.filter?.must ?? [];
            expect(conditions).not.toContainEqual(
                expect.objectContaining({ key: 'workspace_name' })
            );
            expect(conditions).not.toContainEqual(
                expect.objectContaining({ key: 'workspace' })
            );
        });

        it('#249: auto-fallback to text search when semantic fails, with degraded warning', async () => {
            // Before #1496: semantic errors caused a silent fallback to text search,
            // which masked embedding backend regressions for days (cf #1407, #1451).
            // #1496 added strict_mode=true which blocked fallback entirely.
            // #249: Now retries once, then auto-falls back to text WITH a warning flag
            // so agents still get results but know semantic is degraded.
            mockOpenAIClient.embeddings.create.mockRejectedValue(new Error('OpenAI Error'));

            const result = await handleRooSyncSearch(
                { action: 'semantic', search_query: 'test query', workspace: 'd:\\test-workspace' },
                conversationCache,
                ensureCacheFreshCallback,
                fallbackHandler
            );

            // Should NOT error — auto-fallback provides text results
            expect(result.isError).toBeUndefined();
            // #4287: block 0 = human-readable SEMANTIC DEGRADED warning, block 1 =
            // structured payload (contract change vs pre-#4287 single-JSON shape).
            const warning = (result.content[0] as any).text;
            expect(warning).toMatch(/SEMANTIC DEGRADED/i);
            const resultText = (result.content[1] as any).text;
            const parsed = JSON.parse(resultText);
            // Must include semantic_degraded flag so agents know results are from text fallback
            expect(parsed.semantic_degraded).toBe(true);
            expect(parsed.semantic_error).toContain('Semantic search failed');
        });

        it('enriches a structured fallback payload even when a warning precedes it', async () => {
            mockOpenAIClient.embeddings.create.mockRejectedValue(new Error('fetch failed'));
            mockTextFallback.mockResolvedValue({
                content: [
                    { type: 'text', text: 'Filters chunk_type are NOT APPLIED in text fallback mode.' },
                    { type: 'text', text: JSON.stringify({ results: [], warnings: ['Filters chunk_type are NOT APPLIED'] }) },
                ],
            } as CallToolResult);
            const result = await handleRooSyncSearch(
                { action: 'semantic', search_query: 'test query', exclude_tool_results: true },
                conversationCache, ensureCacheFreshCallback, fallbackHandler
            );
            const parsed = JSON.parse((result.content[2] as any).text);
            expect(parsed.semantic_degraded).toBe(true);
            expect(parsed.fallback_used).toBe(true);
            expect(parsed.warnings[0]).toContain('NOT APPLIED');
            expect((result.content[1] as any).text).toContain('NOT APPLIED');
        });

        it('flags an unclassified functional error instead of calling it a backend outage', async () => {
            mockQdrantClient.search.mockRejectedValue(new Error('TypeError: malformed production payload'));
            const result = await handleRooSyncSearch(
                { action: 'semantic', search_query: 'test query' },
                conversationCache, ensureCacheFreshCallback, fallbackHandler
            );
            // #249 keeps the text fallback for every semantic failure, but the
            // classified mode must travel with it: `unknown` is not an outage.
            expect(result.isError).toBeUndefined();
            expect((result.content[0] as any).text).toContain('UNCLASSIFIED');
            const parsed = JSON.parse((result.content[1] as any).text);
            expect(parsed.semantic_degraded).toBe(true);
            expect(parsed.semantic_error_mode).toBe('unknown');
            // #2609 D1: the reason is the REAL mode, not the hardcoded outage token;
            // #2609 D2: `unknown` is not an outage, so no backend claim is made.
            expect(parsed.fallback_reason).toBe('unknown');
            expect(parsed.fallback_reason).not.toBe('embedding_api_error');
            expect((result.content[0] as any).text).not.toContain('embedding backend unreachable');
        });

        it('#2609 D1/D2: a known INFRASTRUCTURE mode keeps the backend-outage reason', async () => {
            mockOpenAIClient.embeddings.create.mockRejectedValue(new Error('fetch failed'));
            const result = await handleRooSyncSearch(
                { action: 'semantic', search_query: 'test query' },
                conversationCache, ensureCacheFreshCallback, fallbackHandler
            );
            const warning = (result.content[0] as any).text;
            expect(warning).toContain('embedding backend unreachable');
            const parsed = JSON.parse((result.content[1] as any).text);
            expect(INFRASTRUCTURE_ERROR_MODES.has(parsed.semantic_error_mode)).toBe(true);
            expect(parsed.fallback_reason).toBe('embedding_api_error');
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
            expect(result.isError).toBeUndefined();
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

            expect(result.isError).toBeUndefined();
            expect(diagnoseHandler).toHaveBeenCalledTimes(1);
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

            expect(result.isError).toBe(false);
            // #883: Verify filter contains conversation_id and workspace
            const searchCall = mockQdrantClient.search.mock.calls[0][1];
            // conversation_id filter
            expect(searchCall.filter.must).toContainEqual({ key: 'task_id', match: { value: 'conv-123' } });
            // workspace basename → workspace_name field
            expect(searchCall.filter.must).toContainEqual({ key: 'workspace_name', match: { value: 'test-ws' } });
        });
    });

    // ============================================================
    // #2473: max_results clamp [1, 100]
    // ============================================================

    describe('#2473 max_results clamp', () => {
        it('should clamp max_results > 100 to 100', async () => {
            const result = await handleRooSyncSearch(
                { action: 'semantic', search_query: 'test query', max_results: 500, workspace: 'd:\\test-workspace' },
                conversationCache,
                ensureCacheFreshCallback,
                fallbackHandler
            );

            expect(result.isError).toBe(false);
            const searchCall = mockQdrantClient.search.mock.calls[0][1];
            // #3043 (SDDD #2766): diversify-by-task over-fetches by DIVERSIFY_OVERFETCH=3
            // Pre-fix limit was 100 (clamped from 500). New effectiveLimit = 100*3.
            expect(searchCall.limit).toBe(100 * 3);
        });

        it('should clamp max_results < 1 to 1', async () => {
            const result = await handleRooSyncSearch(
                { action: 'semantic', search_query: 'test query', max_results: 0, workspace: 'd:\\test-workspace' },
                conversationCache,
                ensureCacheFreshCallback,
                fallbackHandler
            );

            expect(result.isError).toBe(false);
            const searchCall = mockQdrantClient.search.mock.calls[0][1];
            // max_results=0 is falsy, falls back to default 10 then clamped
            // #3043: diversify-by-task over-fetches by 3 → effectiveLimit = 10*3
            expect(searchCall.limit).toBe(10 * 3);
        });

        it('should preserve max_results within [1, 100]', async () => {
            const result = await handleRooSyncSearch(
                { action: 'semantic', search_query: 'test query', max_results: 50, workspace: 'd:\\test-workspace' },
                conversationCache,
                ensureCacheFreshCallback,
                fallbackHandler
            );

            expect(result.isError).toBe(false);
            const searchCall = mockQdrantClient.search.mock.calls[0][1];
            // #3043: diversify-by-task over-fetches by 3 → effectiveLimit = 50*3
            expect(searchCall.limit).toBe(50 * 3);
        });
    });
});
