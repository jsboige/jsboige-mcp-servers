/**
 * Tests unitaires pour diagnose-index.tool.ts
 * Module de diagnostic de l'index sémantique Qdrant
 *
 * Issue #656 - Phase 2.4 : Couverture Tests
 * Priorité HAUTE - Diagnostic Qdrant (indexation)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock QdrantClient and OpenAI clients using hoisting to avoid initialization order issues
// Matching the pattern from search-semantic.tool.test.ts
const { mockQdrantClient, mockOpenAIClient } = vi.hoisted(() => ({
	mockQdrantClient: {
		getCollections: vi.fn(),
		getCollection: vi.fn()
	},
	mockOpenAIClient: {
		embeddings: {
			create: vi.fn()
		}
	}
}));

// Mock the qdrant service module - return mock instance directly
// Path: from __tests__/ go up 3 levels to reach src/, then services/
vi.mock('../../../services/qdrant.js', () => ({
	getQdrantClient: () => mockQdrantClient,
	resetQdrantClient: vi.fn()
}));

// Mock the openai service module
// Note: getEmbeddingModel is defined as a factory function (not vi.fn()) since
// the test only needs it to return a value, not to track calls to it
vi.mock('../../../services/openai.js', () => ({
	default: () => mockOpenAIClient,
	getChatOpenAIClient: vi.fn(),
	getEmbeddingModel: () => 'text-embedding-3-small',
	getEmbeddingDimensions: vi.fn(() => 1536)
}));

// Import the module under test (static import, mocks are hoisted)
import { handleDiagnoseSemanticIndex } from '../diagnose-index.tool.js';
import type { ConversationSkeleton } from '../../types/conversation.js';

describe('diagnose-index.tool (unit tests)', () => {
	const origEnv = { ...process.env };
	let conversationCache: Map<string, ConversationSkeleton>;

	// Helper function to set up default mocks (healthy state)
	const setupDefaultMocks = () => {
		// Default mocks for Qdrant and OpenAI (baseline healthy state)
		// CRITICAL: The mock must return a resolved Promise, not a plain object
		// CRITICAL: Use the collection name from environment variable (default: 'test_collection')
		// IMPORTANT: Read collection name at mock setup time, not call time
		const collectionName = process.env.QDRANT_COLLECTION_NAME || 'roo_tasks_semantic_index';
		mockQdrantClient.getCollections.mockResolvedValue({
			collections: [{ name: collectionName }]
		});
		mockQdrantClient.getCollection.mockResolvedValue({
			vectors_count: 1000,
			indexed_vectors_count: 1000,
			points_count: 100,
			config: {
				params: {
					vectors: {
						distance: 'Cosine',
						size: 1536
					}
				}
			}
		});
		mockOpenAIClient.embeddings.create.mockResolvedValue({
			data: [{ embedding: new Array(1536).fill(0.1) }]
		});
	};

	beforeEach(() => {
		// Clear all mocks (not resetModules - we want to keep the module cached)
		vi.clearAllMocks();

		// Reset env vars
		process.env = { ...origEnv };
		// Set default env vars for most tests
		process.env.QDRANT_URL = 'https://qdrant.example.com';
		process.env.QDRANT_API_KEY = 'test-key';
		process.env.QDRANT_COLLECTION_NAME = 'test-roo-state-manager';
		process.env.EMBEDDING_API_KEY = 'embedding-key';
		process.env.EMBEDDING_API_BASE_URL = 'https://embeddings.example.com';
		process.env.EMBEDDING_MODEL = 'text-embedding-3-small';
		process.env.EMBEDDING_DIMENSIONS = '1536';
		// Create empty cache
		conversationCache = new Map();
		// Set up default mocks (Qdrant API responses)
		setupDefaultMocks();
	});

	afterEach(() => {
		// Reset env vars
		process.env = { ...origEnv };
	});

	describe('debug - mock verification', () => {
		it('should verify mock setup is correct', async () => {
			// Verify the mock client instance has the required methods
			const client = mockQdrantClient;
			expect(client.getCollections).toBeDefined();
			expect(client.getCollection).toBeDefined();

			// Verify the mock functions are the ones we set up
			expect(mockQdrantClient.getCollections).toBeDefined();
			expect(mockQdrantClient.getCollection).toBeDefined();
		});

		it('should trace through the implementation', async () => {
			const collectionsResult = await mockQdrantClient.getCollections();
			expect(collectionsResult.collections).toBeDefined();

			const result = await handleDiagnoseSemanticIndex(conversationCache);

			expect(mockQdrantClient.getCollections).toHaveBeenCalled();

			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.status).toBeDefined();
		});
	});

	describe('healthy collection scenario', () => {
		beforeEach(() => {
			// Set up this scenario's mocks (override defaults)
			const collName = process.env.QDRANT_COLLECTION_NAME;

			mockQdrantClient.getCollections.mockResolvedValue({
				collections: [
					{ name: collName || 'test-roo-state-manager' }
				]
			});
			mockQdrantClient.getCollection.mockResolvedValue({
				vectors_count: 1000,
				indexed_vectors_count: 1000,
				points_count: 100,
				config: {
					params: {
						vectors: {
							distance: 'Cosine',
							size: 1536
						}
					}
				}
			});
			mockOpenAIClient.embeddings.create.mockResolvedValue({
				data: [{ embedding: new Array(1536).fill(0.1) }]
			});
		});

		it('should return healthy status when collection exists with points', async () => {
			const result = await handleDiagnoseSemanticIndex(conversationCache);

			expect(mockQdrantClient.getCollections).toHaveBeenCalled();

			expect(result.content).toHaveLength(1);
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.status).toBe('healthy');
			expect(parsed.errors).toHaveLength(0);
		});

		it('should include collection info when healthy', async () => {
			const result = await handleDiagnoseSemanticIndex(conversationCache);

			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.details.collection_exists).toBe(true);
			expect(parsed.details.collection_info).toEqual({
				vectors_count: 1000,
				indexed_vectors_count: 1000,
				points_count: 100,
				config: {
					distance: 'Cosine',
					size: 1536
				}
			});
		});

		it('should have no recommendations when healthy', async () => {
			const result = await handleDiagnoseSemanticIndex(conversationCache);

			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.recommendations).toHaveLength(0);
		});
	});

	describe('missing collection scenario', () => {
		beforeEach(() => {
			// Set up this scenario's mocks (override defaults)
			mockQdrantClient.getCollections.mockResolvedValue({
				collections: [
					{ name: 'other_collection' }
				]
			});
		});

		it('should return missing_collection status', async () => {
			const result = await handleDiagnoseSemanticIndex(conversationCache);

			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.status).toBe('missing_collection');
		});

		it('should report collection_exists as false', async () => {
			const result = await handleDiagnoseSemanticIndex(conversationCache);

			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.details.collection_exists).toBe(false);
		});

		it('should recommend rebuild when collection missing', async () => {
			const result = await handleDiagnoseSemanticIndex(conversationCache);

			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.recommendations).toContain(
				"Utilisez l'outil rebuild_task_index pour créer et peupler la collection"
			);
		});
	});

	describe('empty collection scenario', () => {
		beforeEach(() => {
			// Set up this scenario's mocks (override defaults)
			mockQdrantClient.getCollections.mockResolvedValue({
				collections: [
					{ name: 'test-roo-state-manager' }
				]
			});
			mockQdrantClient.getCollection.mockResolvedValue({
				vectors_count: 0,
				indexed_vectors_count: 0,
				points_count: 0,
				config: {
					params: {
						vectors: {
							distance: 'Cosine',
							size: 1536
						}
					}
				}
			});
		});

		it('should return empty_collection status when points_count is 0', async () => {
			const result = await handleDiagnoseSemanticIndex(conversationCache);

			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.status).toBe('empty_collection');
		});

		it('should include error about empty collection', async () => {
			const result = await handleDiagnoseSemanticIndex(conversationCache);

			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.errors).toContain(
				'La collection existe mais ne contient aucun point indexé'
			);
		});

		it('should recommend indexing when collection empty', async () => {
			const result = await handleDiagnoseSemanticIndex(conversationCache);

			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.recommendations).toContain(
				"La collection existe mais est vide. Lancez rebuild_task_index pour l'indexer"
			);
		});
	});

	describe('Qdrant connection failure scenario', () => {
		beforeEach(() => {
			// Set up this scenario's mocks (override defaults)
			mockQdrantClient.getCollections.mockRejectedValue(new Error('ECONNREFUSED'));
		});

		it('should return connection_failed status', async () => {
			const result = await handleDiagnoseSemanticIndex(conversationCache);

			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.status).toBe('connection_failed');
		});

		it('should report qdrant_connection as failed', async () => {
			const result = await handleDiagnoseSemanticIndex(conversationCache);

			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.details.qdrant_connection).toBe('failed');
		});

		it('should include connection error in errors array', async () => {
			const result = await handleDiagnoseSemanticIndex(conversationCache);

			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.errors.some(e => e.includes('Impossible de se connecter à Qdrant'))).toBe(true);
		});

		it('should recommend checking Qdrant config', async () => {
			const result = await handleDiagnoseSemanticIndex(conversationCache);

			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.recommendations).toContain(
				'Vérifiez la configuration Qdrant (URL, clé API, connectivité réseau)'
			);
		});
	});

	describe('collection access error scenario', () => {
		beforeEach(() => {
			// Set up this scenario's mocks (override defaults)
			mockQdrantClient.getCollections.mockResolvedValue({
				collections: [
					{ name: 'test-roo-state-manager' }
				]
			});
			mockQdrantClient.getCollection.mockRejectedValue(new Error('Permission denied'));
		});

		it('should return collection_error status', async () => {
			const result = await handleDiagnoseSemanticIndex(conversationCache);

			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.status).toBe('collection_error');
		});

		it('should include collection access error in errors', async () => {
			const result = await handleDiagnoseSemanticIndex(conversationCache);

			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.errors.some(e => e.includes('Erreur lors de l\'accès à la collection'))).toBe(true);
		});
	});

	describe('OpenAI connection failure scenario', () => {
		beforeEach(() => {
			// Set up this scenario's mocks (override defaults)
			mockQdrantClient.getCollections.mockResolvedValue({
				collections: [
					{ name: 'test-roo-state-manager' }
				]
			});
			mockQdrantClient.getCollection.mockResolvedValue({
				vectors_count: 1000,
				indexed_vectors_count: 1000,
				points_count: 100,
				config: {
					params: {
						vectors: {
							distance: 'Cosine',
							size: 1536
						}
					}
				}
			});
			mockOpenAIClient.embeddings.create.mockRejectedValue(new Error('Invalid API key'));
		});

		it('should report openai_connection as failed', async () => {
			const result = await handleDiagnoseSemanticIndex(conversationCache);

			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.details.openai_connection).toBe('failed');
		});

		it('should include OpenAI error in errors array', async () => {
			const result = await handleDiagnoseSemanticIndex(conversationCache);

			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.errors.some(e => e.includes('Erreur OpenAI'))).toBe(true);
		});

		it('should recommend checking embedding config', async () => {
			const result = await handleDiagnoseSemanticIndex(conversationCache);

			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.recommendations).toContain(
				'Vérifiez EMBEDDING_API_KEY et EMBEDDING_API_BASE_URL dans .env (self-hosted vLLM)'
			);
		});
	});

	describe('OpenAI embedding success scenario', () => {
		beforeEach(() => {
			// Set up this scenario's mocks (override defaults)
			mockQdrantClient.getCollections.mockResolvedValue({
				collections: [
					{ name: 'test-roo-state-manager' }
				]
			});
			mockQdrantClient.getCollection.mockResolvedValue({
				vectors_count: 1000,
				points_count: 100,
				config: {
					params: {
						vectors: {
							distance: 'Cosine',
							size: 1536
						}
					}
				}
			});
		});

		it('should report openai_connection as success when embedding works', async () => {
			const result = await handleDiagnoseSemanticIndex(conversationCache);

			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.details.openai_connection).toBe('success');
		});

		it('should call embeddings.create with correct params', async () => {
			await handleDiagnoseSemanticIndex(conversationCache);

			expect(mockOpenAIClient.embeddings.create).toHaveBeenCalledWith({
				model: 'text-embedding-3-small',
				input: 'test connectivity'
			});
		});
	});

	describe('environment variables detection', () => {
		beforeEach(() => {
			// Set up this scenario's mocks (override defaults)
			mockQdrantClient.getCollections.mockResolvedValue({
				collections: [
					{ name: 'test-roo-state-manager' }
				]
			});
			mockQdrantClient.getCollection.mockResolvedValue({
				vectors_count: 1000,
				points_count: 100,
				config: {
					params: {
						vectors: {
							distance: 'Cosine',
							size: 1536
						}
					}
				}
			});
		});

		it('should detect all environment variables when set', async () => {
			const result = await handleDiagnoseSemanticIndex(conversationCache);

			const parsed = JSON.parse(result.content[0].text);
			const envVars = parsed.details.environment_variables;

			expect(envVars.QDRANT_URL).toBe(true);
			expect(envVars.QDRANT_API_KEY).toBe(true);
			expect(envVars.QDRANT_COLLECTION_NAME).toBe(true);
			expect(envVars.EMBEDDING_API_KEY).toBe(true);
			expect(envVars.EMBEDDING_API_BASE_URL).toBe(true);
			expect(envVars.EMBEDDING_MODEL).toBe(true);
			expect(envVars.EMBEDDING_DIMENSIONS).toBe(true);
		});

		it('should detect missing environment variables', async () => {
			delete process.env.EMBEDDING_API_KEY;
			delete process.env.EMBEDDING_DIMENSIONS;

			const result = await handleDiagnoseSemanticIndex(conversationCache);

			const parsed = JSON.parse(result.content[0].text);
			const envVars = parsed.details.environment_variables;

			expect(envVars.EMBEDDING_API_KEY).toBe(false);
			expect(envVars.EMBEDDING_DIMENSIONS).toBe(false);
		});

		it('should list missing environment variables in errors', async () => {
			delete process.env.EMBEDDING_API_KEY;
			delete process.env.QDRANT_URL;

			const result = await handleDiagnoseSemanticIndex(conversationCache);

			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.errors.some(e => e.includes('Variables d\'environnement manquantes'))).toBe(true);
			expect(parsed.errors.some(e => e.includes('EMBEDDING_API_KEY'))).toBe(true);
			expect(parsed.errors.some(e => e.includes('QDRANT_URL'))).toBe(true);
		});
	});

	describe('report structure', () => {
		beforeEach(() => {
			// Set up this scenario's mocks (override defaults)
			mockQdrantClient.getCollections.mockResolvedValue({
				collections: [
					{ name: 'test-roo-state-manager' }
				]
			});
			mockQdrantClient.getCollection.mockResolvedValue({
				vectors_count: 1000,
				points_count: 100,
				config: {
					params: {
						vectors: {
							distance: 'Cosine',
							size: 1536
						}
					}
				}
			});
		});

		it('should include timestamp in ISO format', async () => {
			const result = await handleDiagnoseSemanticIndex(conversationCache);

			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
		});

		it('should include collection_name from env or default', async () => {
			process.env.QDRANT_COLLECTION_NAME = 'my_custom_collection';

			const result = await handleDiagnoseSemanticIndex(conversationCache);

			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.collection_name).toBe('my_custom_collection');
		});

		it('should use default collection name when env not set', async () => {
			delete process.env.QDRANT_COLLECTION_NAME;

			const result = await handleDiagnoseSemanticIndex(conversationCache);

			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.collection_name).toBe('roo_tasks_semantic_index');
		});

		it('should always return valid CallToolResult structure', async () => {
			const result = await handleDiagnoseSemanticIndex(conversationCache);

			expect(result).toHaveProperty('content');
			expect(Array.isArray(result.content)).toBe(true);
			expect(result.content[0]).toHaveProperty('type', 'text');
			expect(result.content[0]).toHaveProperty('text');
			expect(typeof result.content[0].text).toBe('string');
		});
	});

	describe('edge cases', () => {
		it('should handle undefined indexed_vectors_count', async () => {
			mockQdrantClient.getCollections.mockResolvedValue({
				collections: [
					{ name: 'test-roo-state-manager' }
				]
			});
			mockQdrantClient.getCollection.mockResolvedValue({
				vectors_count: 1000,
				points_count: 100,
				config: {
					params: {
						vectors: {
							distance: 'Cosine',
							size: 1536
						}
					}
				}
				// No indexed_vectors_count
			});

			const result = await handleDiagnoseSemanticIndex(conversationCache);

			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.details.collection_info.indexed_vectors_count).toBe(0);
		});

		it('should handle undefined vector config params', async () => {
			mockQdrantClient.getCollections.mockResolvedValue({
				collections: [
					{ name: 'test-roo-state-manager' }
				]
			});
			mockQdrantClient.getCollection.mockResolvedValue({
				vectors_count: 1000,
				points_count: 100,
				config: {
					params: {
						// No vectors config
					}
				}
			});

			const result = await handleDiagnoseSemanticIndex(conversationCache);

			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.details.collection_info.config.distance).toBe('unknown');
			expect(parsed.details.collection_info.config.size).toBe('unknown');
		});

		it('should handle empty embedding response', async () => {
			mockQdrantClient.getCollections.mockResolvedValue({
				collections: [
					{ name: 'test-roo-state-manager' }
				]
			});
			mockQdrantClient.getCollection.mockResolvedValue({
				vectors_count: 1000,
				points_count: 100,
				config: {
					params: {
						vectors: {
							distance: 'Cosine',
							size: 1536
						}
					}
				}
			});
			mockOpenAIClient.embeddings.create.mockResolvedValue({
				data: [{ embedding: [] }] // Empty embedding
			});

			const result = await handleDiagnoseSemanticIndex(conversationCache);

			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.details.openai_connection).toBe('failed');
		});
	});
});
