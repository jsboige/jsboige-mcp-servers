/**
 * Tests unitaires pour diagnose-index.tool.ts
 *
 * Teste handleDiagnoseSemanticIndex qui diagnostique l'etat de l'index
 * semantique Qdrant : connectivite, collection, OpenAI, variables d'env.
 *
 * Statuts possibles: 'healthy', 'empty_collection', 'missing_collection',
 *                    'collection_error', 'connection_failed', 'unknown'
 *
 * Framework: Vitest
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// ============================================================
// Mocks (vi.hoisted pour ESM compatibility)
// ============================================================

const { mockGetQdrantClient, mockGetOpenAIClient, mockGetEmbeddingModel } = vi.hoisted(() => ({
    mockGetQdrantClient: vi.fn(),
    mockGetOpenAIClient: vi.fn(),
    mockGetEmbeddingModel: vi.fn()
}));

vi.mock('../../../../src/services/qdrant.js', () => ({
    getQdrantClient: mockGetQdrantClient
}));

vi.mock('../../../../src/services/openai.js', () => ({
    default: mockGetOpenAIClient,
    getOpenAIClient: mockGetOpenAIClient,
    getEmbeddingModel: mockGetEmbeddingModel
}));

import { handleDiagnoseSemanticIndex } from '../../../../src/tools/indexing/diagnose-index.tool.js';
import { ConversationSkeleton } from '../../../../src/types/conversation.js';

// ============================================================
// Helpers
// ============================================================

/** Parse the diagnostics JSON from the tool result */
function parseDiagnostics(result: any): any {
    expect(result.content).toBeDefined();
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    const diagnostics = JSON.parse(result.content[0].text);
    return diagnostics;
}

/** Create a mock Qdrant client with default behaviors */
function createMockQdrant(overrides: Partial<{
    getCollections: ReturnType<typeof vi.fn>;
    getCollection: ReturnType<typeof vi.fn>;
}> = {}) {
    return {
        getCollections: overrides.getCollections ?? vi.fn().mockResolvedValue({
            collections: [{ name: 'roo_tasks_semantic_index' }]
        }),
        getCollection: overrides.getCollection ?? vi.fn().mockResolvedValue({
            vectors_count: 150,
            indexed_vectors_count: 148,
            points_count: 150,
            config: {
                params: {
                    vectors: {
                        distance: 'Cosine',
                        size: 1536
                    }
                }
            }
        })
    };
}

/** Create a mock OpenAI client with default behaviors */
function createMockOpenAI(overrides: Partial<{
    create: ReturnType<typeof vi.fn>;
}> = {}) {
    return {
        embeddings: {
            create: overrides.create ?? vi.fn().mockResolvedValue({
                data: [{ embedding: [0.1, 0.2, 0.3] }]
            })
        }
    };
}

// ============================================================
// Test suite
// ============================================================

describe('handleDiagnoseSemanticIndex', () => {
    let conversationCache: Map<string, ConversationSkeleton>;
    let savedEnv: NodeJS.ProcessEnv;

    beforeEach(() => {
        conversationCache = new Map();
        vi.clearAllMocks();

        // Save env and set all expected variables
        savedEnv = { ...process.env };
        process.env.QDRANT_URL = 'https://qdrant.test.io:443';
        process.env.QDRANT_API_KEY = 'test-qdrant-key';
        process.env.QDRANT_COLLECTION_NAME = 'roo_tasks_semantic_index';
        process.env.EMBEDDING_API_KEY = 'test-embedding-key';
        process.env.EMBEDDING_API_BASE_URL = 'https://embeddings.test.io';
        process.env.EMBEDDING_MODEL = 'test-model';
        process.env.EMBEDDING_DIMENSIONS = '1536';

        // Default: healthy setup
        mockGetQdrantClient.mockReturnValue(createMockQdrant());
        mockGetOpenAIClient.mockReturnValue(createMockOpenAI());
        mockGetEmbeddingModel.mockReturnValue('test-model');
    });

    afterEach(() => {
        // Restore env
        process.env = savedEnv;
    });

    // ============================================================
    // Result structure
    // ============================================================

    describe('result structure', () => {
        it('should return a valid CallToolResult with JSON text content', async () => {
            const result = await handleDiagnoseSemanticIndex(conversationCache);

            expect(result).toHaveProperty('content');
            expect(result.content).toHaveLength(1);
            expect(result.content[0]).toHaveProperty('type', 'text');
            expect(result.content[0]).toHaveProperty('text');

            // Should be valid JSON
            const parsed = JSON.parse((result.content[0] as any).text);
            expect(parsed).toBeDefined();
        });

        it('should include standard diagnostic fields', async () => {
            const result = await handleDiagnoseSemanticIndex(conversationCache);
            const diag = parseDiagnostics(result);

            expect(diag).toHaveProperty('timestamp');
            expect(diag).toHaveProperty('collection_name');
            expect(diag).toHaveProperty('status');
            expect(diag).toHaveProperty('errors');
            expect(diag).toHaveProperty('details');
            expect(diag).toHaveProperty('recommendations');
            expect(Array.isArray(diag.errors)).toBe(true);
            expect(Array.isArray(diag.recommendations)).toBe(true);
        });

        it('should include a valid ISO timestamp', async () => {
            const before = new Date().toISOString();
            const result = await handleDiagnoseSemanticIndex(conversationCache);
            const after = new Date().toISOString();
            const diag = parseDiagnostics(result);

            // timestamp should be between before and after
            expect(diag.timestamp >= before).toBe(true);
            expect(diag.timestamp <= after).toBe(true);
        });

        it('should use QDRANT_COLLECTION_NAME env var for collection name', async () => {
            process.env.QDRANT_COLLECTION_NAME = 'custom_collection';
            // Update mock to match the custom collection
            const mockQdrant = createMockQdrant({
                getCollections: vi.fn().mockResolvedValue({
                    collections: [{ name: 'custom_collection' }]
                })
            });
            mockGetQdrantClient.mockReturnValue(mockQdrant);

            const result = await handleDiagnoseSemanticIndex(conversationCache);
            const diag = parseDiagnostics(result);

            expect(diag.collection_name).toBe('custom_collection');
        });

        it('should default collection name to roo_tasks_semantic_index', async () => {
            delete process.env.QDRANT_COLLECTION_NAME;

            const result = await handleDiagnoseSemanticIndex(conversationCache);
            const diag = parseDiagnostics(result);

            expect(diag.collection_name).toBe('roo_tasks_semantic_index');
        });
    });

    // ============================================================
    // Healthy collection
    // ============================================================

    describe('healthy collection', () => {
        it('should return healthy status when collection exists with points', async () => {
            const result = await handleDiagnoseSemanticIndex(conversationCache);
            const diag = parseDiagnostics(result);

            expect(diag.status).toBe('healthy');
        });

        it('should include vectors_count, indexed_vectors_count, points_count in details', async () => {
            const result = await handleDiagnoseSemanticIndex(conversationCache);
            const diag = parseDiagnostics(result);

            expect(diag.details.collection_info).toBeDefined();
            expect(diag.details.collection_info.vectors_count).toBe(150);
            expect(diag.details.collection_info.indexed_vectors_count).toBe(148);
            expect(diag.details.collection_info.points_count).toBe(150);
        });

        it('should include distance and size config in collection_info', async () => {
            const result = await handleDiagnoseSemanticIndex(conversationCache);
            const diag = parseDiagnostics(result);

            expect(diag.details.collection_info.config).toBeDefined();
            expect(diag.details.collection_info.config.distance).toBe('Cosine');
            expect(diag.details.collection_info.config.size).toBe(1536);
        });

        it('should show qdrant_connection as success', async () => {
            const result = await handleDiagnoseSemanticIndex(conversationCache);
            const diag = parseDiagnostics(result);

            expect(diag.details.qdrant_connection).toBe('success');
        });

        it('should show openai_connection as success', async () => {
            const result = await handleDiagnoseSemanticIndex(conversationCache);
            const diag = parseDiagnostics(result);

            expect(diag.details.openai_connection).toBe('success');
        });

        it('should show collection_exists as true', async () => {
            const result = await handleDiagnoseSemanticIndex(conversationCache);
            const diag = parseDiagnostics(result);

            expect(diag.details.collection_exists).toBe(true);
        });

        it('should have no errors when everything is healthy', async () => {
            const result = await handleDiagnoseSemanticIndex(conversationCache);
            const diag = parseDiagnostics(result);

            expect(diag.errors).toHaveLength(0);
        });

        it('should have no recommendations when everything is healthy', async () => {
            const result = await handleDiagnoseSemanticIndex(conversationCache);
            const diag = parseDiagnostics(result);

            expect(diag.recommendations).toHaveLength(0);
        });

        it('should handle large point counts', async () => {
            const mockQdrant = createMockQdrant({
                getCollection: vi.fn().mockResolvedValue({
                    vectors_count: 100000,
                    indexed_vectors_count: 99950,
                    points_count: 100000,
                    config: { params: { vectors: { distance: 'Cosine', size: 2560 } } }
                })
            });
            mockGetQdrantClient.mockReturnValue(mockQdrant);

            const result = await handleDiagnoseSemanticIndex(conversationCache);
            const diag = parseDiagnostics(result);

            expect(diag.status).toBe('healthy');
            expect(diag.details.collection_info.points_count).toBe(100000);
        });
    });

    // ============================================================
    // Empty collection
    // ============================================================

    describe('empty collection', () => {
        beforeEach(() => {
            const mockQdrant = createMockQdrant({
                getCollection: vi.fn().mockResolvedValue({
                    vectors_count: 0,
                    indexed_vectors_count: 0,
                    points_count: 0,
                    config: { params: { vectors: { distance: 'Cosine', size: 1536 } } }
                })
            });
            mockGetQdrantClient.mockReturnValue(mockQdrant);
        });

        it('should return empty_collection status when points_count is 0', async () => {
            const result = await handleDiagnoseSemanticIndex(conversationCache);
            const diag = parseDiagnostics(result);

            expect(diag.status).toBe('empty_collection');
        });

        it('should include error about no indexed points', async () => {
            const result = await handleDiagnoseSemanticIndex(conversationCache);
            const diag = parseDiagnostics(result);

            expect(diag.errors.length).toBeGreaterThan(0);
            const errorText = diag.errors.join(' ');
            expect(errorText).toContain('aucun point');
        });

        it('should include rebuild_task_index recommendation', async () => {
            const result = await handleDiagnoseSemanticIndex(conversationCache);
            const diag = parseDiagnostics(result);

            expect(diag.recommendations.length).toBeGreaterThan(0);
            const recoText = diag.recommendations.join(' ');
            expect(recoText).toContain('rebuild_task_index');
        });

        it('should still show collection_exists as true', async () => {
            const result = await handleDiagnoseSemanticIndex(conversationCache);
            const diag = parseDiagnostics(result);

            expect(diag.details.collection_exists).toBe(true);
        });

        it('should still show qdrant_connection as success', async () => {
            const result = await handleDiagnoseSemanticIndex(conversationCache);
            const diag = parseDiagnostics(result);

            expect(diag.details.qdrant_connection).toBe('success');
        });
    });

    // ============================================================
    // Missing collection
    // ============================================================

    describe('missing collection', () => {
        beforeEach(() => {
            const mockQdrant = createMockQdrant({
                getCollections: vi.fn().mockResolvedValue({
                    collections: [{ name: 'some_other_collection' }]
                }),
                getCollection: vi.fn()
            });
            mockGetQdrantClient.mockReturnValue(mockQdrant);
        });

        it('should return missing_collection status when collection not in list', async () => {
            const result = await handleDiagnoseSemanticIndex(conversationCache);
            const diag = parseDiagnostics(result);

            expect(diag.status).toBe('missing_collection');
        });

        it('should include error about collection not existing', async () => {
            const result = await handleDiagnoseSemanticIndex(conversationCache);
            const diag = parseDiagnostics(result);

            expect(diag.errors.length).toBeGreaterThan(0);
            const errorText = diag.errors.join(' ');
            expect(errorText).toContain("n'existe pas");
        });

        it('should include the collection name in the error message', async () => {
            const result = await handleDiagnoseSemanticIndex(conversationCache);
            const diag = parseDiagnostics(result);

            const errorText = diag.errors.join(' ');
            expect(errorText).toContain('roo_tasks_semantic_index');
        });

        it('should include rebuild_task_index recommendation', async () => {
            const result = await handleDiagnoseSemanticIndex(conversationCache);
            const diag = parseDiagnostics(result);

            expect(diag.recommendations.length).toBeGreaterThan(0);
            const recoText = diag.recommendations.join(' ');
            expect(recoText).toContain('rebuild_task_index');
        });

        it('should show collection_exists as false', async () => {
            const result = await handleDiagnoseSemanticIndex(conversationCache);
            const diag = parseDiagnostics(result);

            expect(diag.details.collection_exists).toBe(false);
        });

        it('should not call getCollection when collection is missing', async () => {
            const mockQdrant = createMockQdrant({
                getCollections: vi.fn().mockResolvedValue({
                    collections: []
                }),
                getCollection: vi.fn()
            });
            mockGetQdrantClient.mockReturnValue(mockQdrant);

            await handleDiagnoseSemanticIndex(conversationCache);

            expect(mockQdrant.getCollection).not.toHaveBeenCalled();
        });

        it('should handle empty collections list', async () => {
            const mockQdrant = createMockQdrant({
                getCollections: vi.fn().mockResolvedValue({
                    collections: []
                })
            });
            mockGetQdrantClient.mockReturnValue(mockQdrant);

            const result = await handleDiagnoseSemanticIndex(conversationCache);
            const diag = parseDiagnostics(result);

            expect(diag.status).toBe('missing_collection');
        });
    });

    // ============================================================
    // Collection error
    // ============================================================

    describe('collection error', () => {
        it('should return collection_error when getCollection throws', async () => {
            const mockQdrant = createMockQdrant({
                getCollections: vi.fn().mockResolvedValue({
                    collections: [{ name: 'roo_tasks_semantic_index' }]
                }),
                getCollection: vi.fn().mockRejectedValue(new Error('Permission denied'))
            });
            mockGetQdrantClient.mockReturnValue(mockQdrant);

            const result = await handleDiagnoseSemanticIndex(conversationCache);
            const diag = parseDiagnostics(result);

            expect(diag.status).toBe('collection_error');
        });

        it('should include the error message in diagnostics', async () => {
            const mockQdrant = createMockQdrant({
                getCollections: vi.fn().mockResolvedValue({
                    collections: [{ name: 'roo_tasks_semantic_index' }]
                }),
                getCollection: vi.fn().mockRejectedValue(new Error('Timeout reading collection'))
            });
            mockGetQdrantClient.mockReturnValue(mockQdrant);

            const result = await handleDiagnoseSemanticIndex(conversationCache);
            const diag = parseDiagnostics(result);

            expect(diag.errors.length).toBeGreaterThan(0);
            const errorText = diag.errors.join(' ');
            expect(errorText).toContain('Timeout reading collection');
        });

        it('should return collection_error when getCollections succeeds but getCollection fails', async () => {
            const mockQdrant = createMockQdrant({
                getCollections: vi.fn().mockResolvedValue({
                    collections: [{ name: 'roo_tasks_semantic_index' }]
                }),
                getCollection: vi.fn().mockRejectedValue(new Error('Internal server error'))
            });
            mockGetQdrantClient.mockReturnValue(mockQdrant);

            const result = await handleDiagnoseSemanticIndex(conversationCache);
            const diag = parseDiagnostics(result);

            expect(diag.status).toBe('collection_error');
            expect(diag.details.qdrant_connection).toBe('success');
        });

        it('should return connection_failed when getCollections throws', async () => {
            const mockQdrant = createMockQdrant({
                getCollections: vi.fn().mockRejectedValue(new Error('Network error in getCollections')),
                getCollection: vi.fn()
            });
            mockGetQdrantClient.mockReturnValue(mockQdrant);

            const result = await handleDiagnoseSemanticIndex(conversationCache);
            const diag = parseDiagnostics(result);

            // getCollections throw is caught by the inner try/catch => connection_failed
            expect(diag.status).toBe('connection_failed');
            expect(diag.details.qdrant_connection).toBe('failed');
        });
    });

    // ============================================================
    // Connection failed (Qdrant client creation fails)
    // ============================================================

    describe('connection failed', () => {
        it('should return connection_failed when getQdrantClient throws', async () => {
            mockGetQdrantClient.mockImplementation(() => {
                throw new Error('Cannot connect to Qdrant');
            });

            const result = await handleDiagnoseSemanticIndex(conversationCache);
            const diag = parseDiagnostics(result);

            expect(diag.status).toBe('connection_failed');
        });

        it('should show qdrant_connection as failed', async () => {
            mockGetQdrantClient.mockImplementation(() => {
                throw new Error('Cannot connect to Qdrant');
            });

            const result = await handleDiagnoseSemanticIndex(conversationCache);
            const diag = parseDiagnostics(result);

            expect(diag.details.qdrant_connection).toBe('failed');
        });

        it('should include the connection error message', async () => {
            mockGetQdrantClient.mockImplementation(() => {
                throw new Error('ECONNREFUSED 127.0.0.1:6333');
            });

            const result = await handleDiagnoseSemanticIndex(conversationCache);
            const diag = parseDiagnostics(result);

            expect(diag.errors.length).toBeGreaterThan(0);
            const errorText = diag.errors.join(' ');
            expect(errorText).toContain('ECONNREFUSED');
        });

        it('should include Qdrant config recommendation', async () => {
            mockGetQdrantClient.mockImplementation(() => {
                throw new Error('Cannot connect');
            });

            const result = await handleDiagnoseSemanticIndex(conversationCache);
            const diag = parseDiagnostics(result);

            expect(diag.recommendations.length).toBeGreaterThan(0);
            const recoText = diag.recommendations.join(' ');
            expect(recoText).toContain('Qdrant');
        });

        it('should still attempt OpenAI check when Qdrant connection fails', async () => {
            mockGetQdrantClient.mockImplementation(() => {
                throw new Error('Qdrant down');
            });

            await handleDiagnoseSemanticIndex(conversationCache);

            // OpenAI check always runs, even when Qdrant fails
            expect(mockGetOpenAIClient).toHaveBeenCalled();
        });

        it('should not include collection_info when connection fails', async () => {
            mockGetQdrantClient.mockImplementation(() => {
                throw new Error('Qdrant down');
            });

            const result = await handleDiagnoseSemanticIndex(conversationCache);
            const diag = parseDiagnostics(result);

            expect(diag.details.collection_info).toBeUndefined();
            expect(diag.details.collection_exists).toBeUndefined();
        });
    });

    // ============================================================
    // OpenAI connection
    // ============================================================

    describe('OpenAI connection', () => {
        it('should show openai_connection as success when embedding works', async () => {
            const result = await handleDiagnoseSemanticIndex(conversationCache);
            const diag = parseDiagnostics(result);

            expect(diag.details.openai_connection).toBe('success');
        });

        it('should show openai_connection as failed when embedding throws', async () => {
            mockGetOpenAIClient.mockReturnValue({
                embeddings: {
                    create: vi.fn().mockRejectedValue(new Error('Invalid API key'))
                }
            });

            const result = await handleDiagnoseSemanticIndex(conversationCache);
            const diag = parseDiagnostics(result);

            expect(diag.details.openai_connection).toBe('failed');
        });

        it('should include OpenAI error in errors array', async () => {
            mockGetOpenAIClient.mockReturnValue({
                embeddings: {
                    create: vi.fn().mockRejectedValue(new Error('Rate limit exceeded'))
                }
            });

            const result = await handleDiagnoseSemanticIndex(conversationCache);
            const diag = parseDiagnostics(result);

            const errorText = diag.errors.join(' ');
            expect(errorText).toContain('Rate limit exceeded');
        });

        it('should include EMBEDDING_API_KEY recommendation when OpenAI fails', async () => {
            mockGetOpenAIClient.mockReturnValue({
                embeddings: {
                    create: vi.fn().mockRejectedValue(new Error('Auth error'))
                }
            });

            const result = await handleDiagnoseSemanticIndex(conversationCache);
            const diag = parseDiagnostics(result);

            const recoText = diag.recommendations.join(' ');
            expect(recoText).toContain('EMBEDDING_API_KEY');
        });

        it('should show openai_connection as failed when embedding returns empty data', async () => {
            mockGetOpenAIClient.mockReturnValue({
                embeddings: {
                    create: vi.fn().mockResolvedValue({
                        data: [{ embedding: [] }]
                    })
                }
            });

            const result = await handleDiagnoseSemanticIndex(conversationCache);
            const diag = parseDiagnostics(result);

            expect(diag.details.openai_connection).toBe('failed');
        });

        it('should call embeddings.create with test connectivity input', async () => {
            const mockCreate = vi.fn().mockResolvedValue({
                data: [{ embedding: [0.1] }]
            });
            mockGetOpenAIClient.mockReturnValue({
                embeddings: { create: mockCreate }
            });
            mockGetEmbeddingModel.mockReturnValue('my-model');

            await handleDiagnoseSemanticIndex(conversationCache);

            expect(mockCreate).toHaveBeenCalledWith({
                model: 'my-model',
                input: 'test connectivity'
            });
        });

        it('should still report healthy status even when only OpenAI fails', async () => {
            // Qdrant is healthy, but OpenAI fails
            mockGetOpenAIClient.mockReturnValue({
                embeddings: {
                    create: vi.fn().mockRejectedValue(new Error('OpenAI down'))
                }
            });

            const result = await handleDiagnoseSemanticIndex(conversationCache);
            const diag = parseDiagnostics(result);

            // Status is determined by Qdrant collection, not OpenAI
            expect(diag.status).toBe('healthy');
            expect(diag.details.openai_connection).toBe('failed');
        });

        it('should handle getOpenAIClient throwing', async () => {
            mockGetOpenAIClient.mockImplementation(() => {
                throw new Error('No API key configured');
            });

            const result = await handleDiagnoseSemanticIndex(conversationCache);
            const diag = parseDiagnostics(result);

            expect(diag.details.openai_connection).toBe('failed');
            const errorText = diag.errors.join(' ');
            expect(errorText).toContain('No API key configured');
        });
    });

    // ============================================================
    // Environment variables
    // ============================================================

    describe('environment variables', () => {
        it('should report all env vars as present when set', async () => {
            const result = await handleDiagnoseSemanticIndex(conversationCache);
            const diag = parseDiagnostics(result);

            const envVars = diag.details.environment_variables;
            expect(envVars.QDRANT_URL).toBe(true);
            expect(envVars.QDRANT_API_KEY).toBe(true);
            expect(envVars.QDRANT_COLLECTION_NAME).toBe(true);
            expect(envVars.EMBEDDING_API_KEY).toBe(true);
            expect(envVars.EMBEDDING_API_BASE_URL).toBe(true);
            expect(envVars.EMBEDDING_MODEL).toBe(true);
            expect(envVars.EMBEDDING_DIMENSIONS).toBe(true);
        });

        it('should report missing env vars when none are set', async () => {
            delete process.env.QDRANT_URL;
            delete process.env.QDRANT_API_KEY;
            delete process.env.QDRANT_COLLECTION_NAME;
            delete process.env.EMBEDDING_API_KEY;
            delete process.env.EMBEDDING_API_BASE_URL;
            delete process.env.EMBEDDING_MODEL;
            delete process.env.EMBEDDING_DIMENSIONS;

            const result = await handleDiagnoseSemanticIndex(conversationCache);
            const diag = parseDiagnostics(result);

            const envVars = diag.details.environment_variables;
            expect(envVars.QDRANT_URL).toBe(false);
            expect(envVars.QDRANT_API_KEY).toBe(false);
            expect(envVars.QDRANT_COLLECTION_NAME).toBe(false);
            expect(envVars.EMBEDDING_API_KEY).toBe(false);
            expect(envVars.EMBEDDING_API_BASE_URL).toBe(false);
            expect(envVars.EMBEDDING_MODEL).toBe(false);
            expect(envVars.EMBEDDING_DIMENSIONS).toBe(false);
        });

        it('should include error listing missing variable names', async () => {
            delete process.env.QDRANT_URL;
            delete process.env.EMBEDDING_API_KEY;

            const result = await handleDiagnoseSemanticIndex(conversationCache);
            const diag = parseDiagnostics(result);

            const errorText = diag.errors.join(' ');
            expect(errorText).toContain('QDRANT_URL');
            expect(errorText).toContain('EMBEDDING_API_KEY');
        });

        it('should not include env error when all vars are present', async () => {
            const result = await handleDiagnoseSemanticIndex(conversationCache);
            const diag = parseDiagnostics(result);

            const envErrors = diag.errors.filter((e: string) => e.includes('environnement'));
            expect(envErrors).toHaveLength(0);
        });

        it('should report partial missing env vars correctly', async () => {
            delete process.env.EMBEDDING_MODEL;
            delete process.env.EMBEDDING_DIMENSIONS;

            const result = await handleDiagnoseSemanticIndex(conversationCache);
            const diag = parseDiagnostics(result);

            expect(diag.details.environment_variables.QDRANT_URL).toBe(true);
            expect(diag.details.environment_variables.EMBEDDING_MODEL).toBe(false);
            expect(diag.details.environment_variables.EMBEDDING_DIMENSIONS).toBe(false);

            const errorText = diag.errors.join(' ');
            expect(errorText).toContain('EMBEDDING_MODEL');
            expect(errorText).toContain('EMBEDDING_DIMENSIONS');
            expect(errorText).not.toContain('QDRANT_URL');
        });

        it('should treat empty string env vars as missing (falsy)', async () => {
            process.env.QDRANT_URL = '';

            const result = await handleDiagnoseSemanticIndex(conversationCache);
            const diag = parseDiagnostics(result);

            expect(diag.details.environment_variables.QDRANT_URL).toBe(false);
        });
    });

    // ============================================================
    // Recommendations
    // ============================================================

    describe('recommendations', () => {
        it('should recommend rebuild_task_index for missing collection', async () => {
            const mockQdrant = createMockQdrant({
                getCollections: vi.fn().mockResolvedValue({ collections: [] })
            });
            mockGetQdrantClient.mockReturnValue(mockQdrant);

            const result = await handleDiagnoseSemanticIndex(conversationCache);
            const diag = parseDiagnostics(result);

            expect(diag.recommendations.some((r: string) => r.includes('rebuild_task_index'))).toBe(true);
        });

        it('should recommend rebuild_task_index for empty collection', async () => {
            const mockQdrant = createMockQdrant({
                getCollection: vi.fn().mockResolvedValue({
                    vectors_count: 0, indexed_vectors_count: 0, points_count: 0,
                    config: { params: { vectors: { distance: 'Cosine', size: 1536 } } }
                })
            });
            mockGetQdrantClient.mockReturnValue(mockQdrant);

            const result = await handleDiagnoseSemanticIndex(conversationCache);
            const diag = parseDiagnostics(result);

            expect(diag.recommendations.some((r: string) => r.includes('rebuild_task_index'))).toBe(true);
        });

        it('should recommend Qdrant config check for connection failure', async () => {
            mockGetQdrantClient.mockImplementation(() => {
                throw new Error('Connection refused');
            });

            const result = await handleDiagnoseSemanticIndex(conversationCache);
            const diag = parseDiagnostics(result);

            expect(diag.recommendations.some((r: string) => r.includes('Qdrant'))).toBe(true);
        });

        it('should recommend EMBEDDING_API_KEY check for OpenAI failure', async () => {
            mockGetOpenAIClient.mockReturnValue({
                embeddings: {
                    create: vi.fn().mockRejectedValue(new Error('Auth failed'))
                }
            });

            const result = await handleDiagnoseSemanticIndex(conversationCache);
            const diag = parseDiagnostics(result);

            expect(diag.recommendations.some((r: string) =>
                r.includes('EMBEDDING_API_KEY') || r.includes('EMBEDDING_API_BASE_URL')
            )).toBe(true);
        });

        it('should have no recommendations when everything is healthy', async () => {
            const result = await handleDiagnoseSemanticIndex(conversationCache);
            const diag = parseDiagnostics(result);

            expect(diag.recommendations).toHaveLength(0);
        });

        it('should accumulate multiple recommendations when multiple issues exist', async () => {
            // Qdrant connection fails => no OpenAI check, but OpenAI recommendation
            // won't be added since OpenAI is never reached.
            // Instead: empty collection + OpenAI failure
            const mockQdrant = createMockQdrant({
                getCollection: vi.fn().mockResolvedValue({
                    vectors_count: 0, indexed_vectors_count: 0, points_count: 0,
                    config: { params: { vectors: { distance: 'Cosine', size: 1536 } } }
                })
            });
            mockGetQdrantClient.mockReturnValue(mockQdrant);
            mockGetOpenAIClient.mockReturnValue({
                embeddings: {
                    create: vi.fn().mockRejectedValue(new Error('OpenAI down'))
                }
            });

            const result = await handleDiagnoseSemanticIndex(conversationCache);
            const diag = parseDiagnostics(result);

            // Should have both rebuild + OpenAI recommendations
            expect(diag.recommendations.length).toBeGreaterThanOrEqual(2);
            const allRecos = diag.recommendations.join(' ');
            expect(allRecos).toContain('rebuild_task_index');
            expect(allRecos).toContain('EMBEDDING_API_KEY');
        });
    });

    // ============================================================
    // Combined scenarios
    // ============================================================

    describe('combined scenarios', () => {
        it('should handle healthy Qdrant with failed OpenAI gracefully', async () => {
            mockGetOpenAIClient.mockReturnValue({
                embeddings: {
                    create: vi.fn().mockRejectedValue(new Error('Timeout'))
                }
            });

            const result = await handleDiagnoseSemanticIndex(conversationCache);
            const diag = parseDiagnostics(result);

            expect(diag.status).toBe('healthy');
            expect(diag.details.qdrant_connection).toBe('success');
            expect(diag.details.openai_connection).toBe('failed');
            expect(diag.errors.length).toBeGreaterThan(0);
            expect(diag.recommendations.length).toBeGreaterThan(0);
        });

        it('should handle missing collection with successful OpenAI', async () => {
            const mockQdrant = createMockQdrant({
                getCollections: vi.fn().mockResolvedValue({ collections: [] })
            });
            mockGetQdrantClient.mockReturnValue(mockQdrant);

            const result = await handleDiagnoseSemanticIndex(conversationCache);
            const diag = parseDiagnostics(result);

            expect(diag.status).toBe('missing_collection');
            expect(diag.details.qdrant_connection).toBe('success');
            expect(diag.details.openai_connection).toBe('success');
        });

        it('should handle missing env vars alongside healthy connections', async () => {
            delete process.env.EMBEDDING_DIMENSIONS;

            const result = await handleDiagnoseSemanticIndex(conversationCache);
            const diag = parseDiagnostics(result);

            expect(diag.status).toBe('healthy');
            expect(diag.details.environment_variables.EMBEDDING_DIMENSIONS).toBe(false);
            expect(diag.errors.length).toBeGreaterThan(0);
        });

        it('should handle collection with missing config fields gracefully', async () => {
            const mockQdrant = createMockQdrant({
                getCollection: vi.fn().mockResolvedValue({
                    vectors_count: 10,
                    points_count: 10,
                    // No indexed_vectors_count, no config
                })
            });
            mockGetQdrantClient.mockReturnValue(mockQdrant);

            const result = await handleDiagnoseSemanticIndex(conversationCache);
            const diag = parseDiagnostics(result);

            expect(diag.status).toBe('healthy');
            expect(diag.details.collection_info.indexed_vectors_count).toBe(0);
            expect(diag.details.collection_info.config.distance).toBe('unknown');
            expect(diag.details.collection_info.config.size).toBe('unknown');
        });
    });

    // ============================================================
    // Edge cases
    // ============================================================

    describe('edge cases', () => {
        it('should not throw even when everything fails', async () => {
            mockGetQdrantClient.mockImplementation(() => {
                throw new Error('Total failure');
            });

            // Should not throw - the function handles errors internally
            const result = await handleDiagnoseSemanticIndex(conversationCache);
            const diag = parseDiagnostics(result);

            expect(diag.status).toBe('connection_failed');
        });

        it('should work with an empty conversationCache', async () => {
            const result = await handleDiagnoseSemanticIndex(new Map());
            const diag = parseDiagnostics(result);

            // conversationCache is not used by diagnose - status should be healthy
            expect(diag.status).toBe('healthy');
        });

        it('should work with a populated conversationCache', async () => {
            conversationCache.set('task-1', {
                taskId: 'task-1',
                metadata: {},
                sequence: []
            } as ConversationSkeleton);

            const result = await handleDiagnoseSemanticIndex(conversationCache);
            const diag = parseDiagnostics(result);

            expect(diag.status).toBe('healthy');
        });

        it('should handle Qdrant client returning null-like values', async () => {
            const mockQdrant = createMockQdrant({
                getCollection: vi.fn().mockResolvedValue({
                    vectors_count: null,
                    indexed_vectors_count: null,
                    points_count: 0,
                    config: null
                })
            });
            mockGetQdrantClient.mockReturnValue(mockQdrant);

            const result = await handleDiagnoseSemanticIndex(conversationCache);
            const diag = parseDiagnostics(result);

            // points_count === 0 => empty_collection
            expect(diag.status).toBe('empty_collection');
        });

        it('should use getEmbeddingModel for the embedding test', async () => {
            mockGetEmbeddingModel.mockReturnValue('custom-embedding-model');
            const mockCreate = vi.fn().mockResolvedValue({
                data: [{ embedding: [0.5] }]
            });
            mockGetOpenAIClient.mockReturnValue({
                embeddings: { create: mockCreate }
            });

            await handleDiagnoseSemanticIndex(conversationCache);

            expect(mockGetEmbeddingModel).toHaveBeenCalled();
            expect(mockCreate).toHaveBeenCalledWith(
                expect.objectContaining({ model: 'custom-embedding-model' })
            );
        });
    });
});
