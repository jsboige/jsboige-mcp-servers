/**
 * Tests unitaires pour diagnose-index.tool.ts
 * Module de diagnostic de l'index sémantique Qdrant
 *
 * Issue #656 - Phase 2.4 : Couverture Tests
 * Priorité HAUTE - Diagnostic Qdrant (indexation)
 *
 * Issue #833 Sprint C3 - deep diagnostics coverage (web1 lane `src/tools/indexing/`)
 * Le bloc `if (deep && diagnostics.status === 'healthy') { ... }` (L231-323) + ses
 * recommandations (L356-370) n'étaient couverts par aucun des 3 fichiers de test
 * (32 + 19 + 9 = 60 tests existants), ouvrant un gap de ~65 lignes sur le fichier.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock QdrantClient and OpenAI clients using hoisting to avoid initialization order issues
// Matching the pattern from search-semantic.tool.test.ts
const { mockQdrantClient, mockOpenAIClient } = vi.hoisted(() => ({
	mockQdrantClient: {
		getCollections: vi.fn(),
		getCollection: vi.fn(),
		scroll: vi.fn()
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
import { handleDiagnoseSemanticIndex, _resetConnectivityCache, _classifyOpenAIError, _classifyDeepDiagnosticError } from '../diagnose-index.tool.js';
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
		_resetConnectivityCache();

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
			// #3217: collection_error now requires the bounded probe read to fail too.
			// Without this, the unmocked vi.fn() resolves undefined and the probe
			// would succeed → status would degrade to 'degraded', not 'collection_error'.
			mockQdrantClient.scroll.mockRejectedValue(new Error('Permission denied'));
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

	// ============================================================
	// #3217 — getCollection failure is probe-gated (no false negative).
	// getCollection() aborts on large collections (exhaustive point count >
	// client timeout, "This operation was aborted") while a real read succeeds
	// in under a second — diagnose must not report collection_error for a
	// collection that is actually readable.
	// ============================================================

	describe('#3217 — probe-gated collection status', () => {
		beforeEach(() => {
			mockQdrantClient.getCollections.mockResolvedValue({
				collections: [{ name: 'test-roo-state-manager' }]
			});
			// The ai-01 incident signature (2026-08-22T10:55:38Z): AbortController timeout.
			mockQdrantClient.getCollection.mockRejectedValue(new Error('This operation was aborted'));
		});

		it('downgrades to degraded when a bounded real read succeeds (metadata timeout, collection fine)', async () => {
			mockQdrantClient.scroll.mockResolvedValue({ points: [] });

			const parsed = JSON.parse((await handleDiagnoseSemanticIndex(conversationCache)).content[0].text);

			expect(parsed.status).toBe('degraded');
			expect(parsed.details.collection_probe).toBe('readable');
			// Self-consistency restored: no more collection_error while the connection
			// succeeded and the collection exists.
			expect(parsed.details.qdrant_connection).toBe('success');
			expect(parsed.details.collection_exists).toBe(true);
			expect(parsed.errors.some((e: string) => e.includes('collection_error→degraded'))).toBe(true);
		});

		it('probes with a bounded scroll (limit 1, no payload, no vector)', async () => {
			mockQdrantClient.scroll.mockResolvedValue({ points: [] });

			await handleDiagnoseSemanticIndex(conversationCache);

			expect(mockQdrantClient.scroll).toHaveBeenCalledWith(
				'test-roo-state-manager',
				{ limit: 1, with_payload: false, with_vector: false }
			);
		});

		it('keeps collection_error when the probe read ALSO fails (genuinely inaccessible)', async () => {
			mockQdrantClient.scroll.mockRejectedValue(new Error('connect ECONNREFUSED'));

			const parsed = JSON.parse((await handleDiagnoseSemanticIndex(conversationCache)).content[0].text);

			expect(parsed.status).toBe('collection_error');
			expect(parsed.details.collection_probe).toBe('unreadable');
			expect(parsed.errors.some((e: string) => e.includes('Lecture de test échouée'))).toBe(true);
		});

		it('recommends no collection action when readable despite metadata failure', async () => {
			mockQdrantClient.scroll.mockResolvedValue({ points: [] });

			const parsed = JSON.parse((await handleDiagnoseSemanticIndex(conversationCache)).content[0].text);

			expect(parsed.recommendations.some((r: string) => r.includes('recherche sémantique reste opérationnelle'))).toBe(true);
		});

		it('recommends Qdrant-side action when genuinely unreadable', async () => {
			mockQdrantClient.scroll.mockRejectedValue(new Error('boom'));

			const parsed = JSON.parse((await handleDiagnoseSemanticIndex(conversationCache)).content[0].text);

			expect(parsed.recommendations.some((r: string) => r.includes('réellement inaccessible'))).toBe(true);
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

		it('should list missing environment variables in warnings, not errors (#3257)', async () => {
			delete process.env.EMBEDDING_API_KEY;
			delete process.env.QDRANT_URL;

			const result = await handleDiagnoseSemanticIndex(conversationCache);

			const parsed = JSON.parse(result.content[0].text);
			// #3257: env-var absence is the explicit non-blocking warning category —
			// a fully-working setup (connections above all succeeded) must not be
			// degraded to non-healthy by it.
			expect(parsed.warnings.some(e => e.includes('Variables d\'environnement manquantes'))).toBe(true);
			expect(parsed.warnings.some(e => e.includes('EMBEDDING_API_KEY'))).toBe(true);
			expect(parsed.warnings.some(e => e.includes('QDRANT_URL'))).toBe(true);
			expect(parsed.errors).toHaveLength(0);
			expect(parsed.status).toBe('healthy');
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

	// ============================================================
	// Deep diagnostics (src L231-323) + recommendations L356-370
	// #833 Sprint C3: complete coverage of the `if (deep && healthy)`
	// branch (sourced from #1244 fields-coverage improvements).
	// ============================================================

	describe('deep diagnostics', () => {
		beforeEach(() => {
			// Healthy baseline Qdrant + OpenAI responses (re-assert for each test)
			mockQdrantClient.getCollections.mockResolvedValue({
				collections: [{ name: 'test-roo-state-manager' }]
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
				data: [{ embedding: new Array(1536).fill(0.1) }]
			});
		});

		it('skips deep diagnostics when status is not healthy', async () => {
			// Source: L231 — `if (deep && diagnostics.status === 'healthy')`.
			// When Qdrant collection is missing → status='missing_collection' → skip.
			mockQdrantClient.getCollections.mockResolvedValue({ collections: [] });
			mockQdrantClient.scroll.mockResolvedValue([]);

			const result = await handleDiagnoseSemanticIndex(
				conversationCache,
				{ deep: true }
			);

			const parsed = JSON.parse(result.content[0].text);
			// scroll MUST NOT be called when status is not healthy (L231 guard).
			expect(mockQdrantClient.scroll).not.toHaveBeenCalled();
			expect(parsed.details.deep_diagnostics).toBeUndefined();
		});

		it('aggregates source distribution, workspace distribution, and field coverage', async () => {
			// Source: L245-303 — source_counts, workspace_counts, field_presence aggregation
			// + sorted top-workspaces + samples.
			mockQdrantClient.scroll.mockResolvedValue({
				points: [
					{
						id: 'p1',
						payload: {
							source: 'roo',
							workspace_name: 'roo-extensions',
							task_id: 'a',
							workspace: 'w',
							timestamp: '2026-07-01',
							chunk_type: 'msg',
							role: 'assistant',
							host_os: 'win',
							task_title: 'T1',
							model: 'opus'
						}
					},
					{
						id: 'p2',
						payload: {
							source: 'claude-code',
							workspace_name: 'roo-extensions',
							task_id: 'b',
							workspace: 'w',
							timestamp: '2026-07-02',
							chunk_type: 'msg',
							role: 'user',
							host_os: 'win',
							task_title: 'T2',
							model: 'haiku'
						}
					},
					{
						id: 'p3',
						payload: {} // Missing everything → '__unknown__' / '__missing__'
					}
				]
			});

			const result = await handleDiagnoseSemanticIndex(
				conversationCache,
				{ deep: true, sample_size: 100 }
			);

			const parsed = JSON.parse(result.content[0].text);
			const dd = parsed.details.deep_diagnostics;
			expect(dd.sample_size_actual).toBe(3);
			expect(dd.sample_size_requested).toBe(100);
			// source distribution (L254-255)
			expect(dd.source_distribution.roo).toBe(1);
			expect(dd.source_distribution['claude-code']).toBe(1);
			expect(dd.source_distribution.__unknown__).toBe(1);
			// workspace_name distribution (L259-262)
			expect(dd.workspace_distribution_top[0]).toMatchObject({
				name: 'roo-extensions',
				count: 2,
				pct: 66.7
			});
			expect(dd.workspace_distribution_distinct).toBe(1); // roo-extensions (missing excluded)
			// field coverage (L266-270 + L291-294)
			expect(dd.field_coverage_pct.task_id).toBeCloseTo(66.7, 1);
			expect(dd.field_coverage_pct.workspace_name).toBeCloseTo(66.7, 1);
			// payload samples (L273-282, capped at 5)
			expect(dd.payload_samples.length).toBe(3);
			expect(dd.payload_samples[0].id).toBe('p1');
		});

		it('#3344: reports workspace_name coverage broken down by source and machine', async () => {
			// A global rate can mask a lane at 0% (measured: myia-po-2024 0/150 with
			// workspace_name). The per-group coverage must expose the failing lane.
			mockQdrantClient.scroll.mockResolvedValue({
				points: [
					{ id: 'p1', payload: { source: 'roo', workspace_name: 'W', host_os: 'hostA-win', task_id: 'a', timestamp: '2026-07-01' } },
					{ id: 'p2', payload: { source: 'roo', host_os: 'hostB-win', task_id: 'b', timestamp: '2026-07-02' } },
					{ id: 'p3', payload: { source: 'claude-code', workspace_name: 'X', host_os: 'hostA-win', task_id: 'c', timestamp: '2026-07-03' } },
					{ id: 'p4', payload: { source: 'claude-code', host_os: 'hostB-win', task_id: 'd', timestamp: '2026-07-04' } },
					{ id: 'p5', payload: {} }
				]
			});

			const result = await handleDiagnoseSemanticIndex(conversationCache, { deep: true });
			const parsed = JSON.parse(result.content[0].text);
			const dd = parsed.details.deep_diagnostics;

			expect(dd.workspace_name_coverage_by_source).toEqual({
				roo: { total: 2, with_workspace_name: 1, pct: 50 },
				'claude-code': { total: 2, with_workspace_name: 1, pct: 50 },
				'__unknown__': { total: 1, with_workspace_name: 0, pct: 0 },
			});
			expect(dd.workspace_name_coverage_by_machine['hostA-win']).toEqual({ total: 2, with_workspace_name: 2, pct: 100 });
			expect(dd.workspace_name_coverage_by_machine['hostB-win']).toEqual({ total: 2, with_workspace_name: 0, pct: 0 });
			expect(dd.workspace_name_coverage_by_machine['__unknown__']).toEqual({ total: 1, with_workspace_name: 0, pct: 0 });
		});

		it('emits workspace_name error below 50% coverage', async () => {
			// Source: L307-312 — `if (fieldCoveragePct.workspace_name ?? 0 < 50)` → error
			mockQdrantClient.scroll.mockResolvedValue({
				points: [
					{ id: 'p1', payload: { source: 'roo', workspace_name: '', timestamp: '2026-07-01', task_id: 'a' } },
					{ id: 'p2', payload: { source: 'roo', timestamp: '2026-07-01', task_id: 'b' } }
				]
			});

			const result = await handleDiagnoseSemanticIndex(
				conversationCache,
				{ deep: true }
			);

			const parsed = JSON.parse(result.content[0].text);
			// workspace_name populated in 0% (both empty/missing)
			const wsErr = parsed.errors.find((e: string) => e.includes('workspace_name populated in'));
			expect(wsErr).toBeDefined();
			expect(wsErr).toContain('0%');
		});

		it('emits timestamp error below 50% coverage', async () => {
			// Source: L313-318 — `if (fieldCoveragePct.timestamp ?? 0 < 50)` → error
			mockQdrantClient.scroll.mockResolvedValue({
				points: [
					{ id: 'p1', payload: { source: 'roo', workspace_name: 'w1', task_id: 'a' } },
					{ id: 'p2', payload: { source: 'roo', workspace_name: 'w2', task_id: 'b' } }
				]
			});

			const result = await handleDiagnoseSemanticIndex(
				conversationCache,
				{ deep: true }
			);

			const parsed = JSON.parse(result.content[0].text);
			const tsErr = parsed.errors.find((e: string) => e.includes('timestamp populated in'));
			expect(tsErr).toBeDefined();
		});

		it('surfaces deep diagnostics failure as soft error without throwing', async () => {
			// Source: deep catch — never throws. #3257: the failure is ALSO reflected
			// in the verdict now (degraded, not healthy) and carries a typed reason.
			mockQdrantClient.scroll.mockRejectedValue(new Error('scroll timeout'));

			const result = await handleDiagnoseSemanticIndex(
				conversationCache,
				{ deep: true }
			);

			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.details.deep_diagnostics.error).toBe('scroll timeout');
			expect(parsed.errors.some((e: string) => e.includes('Deep diagnostics failed'))).toBe(true);
			// #3257: an explicitly requested diagnostic part that failed must degrade
			// the verdict — a consumer reading only `status` must not conclude the
			// requested diagnostic ran to completion.
			expect(parsed.status).toBe('degraded');
			expect(parsed.details.deep_diagnostics.abort_reason).toBe('timeout');
			// Infrastructure stays healthy separately: only the deep pass failed.
			expect(parsed.infrastructure_status).toMatchObject({
				qdrant: 'healthy',
				embeddings: 'healthy',
				deep_diagnostics: 'failed'
			});
		});

		it('adds workspace_name recommendation when field coverage < 50%', async () => {
			// Source: L356-363 — recommendation emitted only when deep ran successfully
			// (no error on dd) AND field_coverage_pct.workspace_name < 50%.
			mockQdrantClient.scroll.mockResolvedValue({
				points: [
					{ id: 'p1', payload: { source: 'roo', workspace_name: '', timestamp: '2026-07-01', task_id: 'a' } },
					{ id: 'p2', payload: { source: 'roo', workspace_name: '', timestamp: '2026-07-01', task_id: 'b' } }
				]
			});

			const result = await handleDiagnoseSemanticIndex(
				conversationCache,
				{ deep: true }
			);

			const parsed = JSON.parse(result.content[0].text);
			const rec = parsed.recommendations.find((r: string) => r.includes('workspace_name peu populé'));
			expect(rec).toBeDefined();
			// #3344: the recommendation now splits the two cohorts (derivation gap vs
			// missing workspace coordinates) instead of pointing only at ChunkExtractor
			// (which covers just the 3.5% derivation gap — ai-01 counter-sample).
			expect(rec).toContain('repair_workspace');
			expect(rec).toContain('coverage_by_source');
		});

		it('adds source recommendation when __unknown__ exceeds sampleSize * 0.5', async () => {
			// Source: L364-369 — recommendation emitted when
			// (source_distribution['__unknown__'] ?? 0) > sampleSize * 0.5.
			// With 4/5 points having no source and sample_size=5 → 4 > 2.5 = true.
			mockQdrantClient.scroll.mockResolvedValue({
				points: [
					{ id: 'p1', payload: { workspace_name: 'w', timestamp: '2026-07-01' } },
					{ id: 'p2', payload: { workspace_name: 'w', timestamp: '2026-07-02' } },
					{ id: 'p3', payload: { workspace_name: 'w', timestamp: '2026-07-03' } },
					{ id: 'p4', payload: { workspace_name: 'w', timestamp: '2026-07-04' } },
					{ id: 'p5', payload: { source: 'roo', workspace_name: 'w', timestamp: '2026-07-05' } }
				]
			});

			const result = await handleDiagnoseSemanticIndex(
				conversationCache,
				{ deep: true, sample_size: 5 }
			);

			const parsed = JSON.parse(result.content[0].text);
			const rec = parsed.recommendations.find((r: string) => r.includes('points sans champ `source`'));
			expect(rec).toBeDefined();
			expect(rec).toContain('ChunkExtractor Roo');
		});
	});

	// ============================================================
	// #3257 — deep diagnostics abort: no false green.
	// po-2025 incident (2026-08-24): diagnose(deep=true) returned
	// status:healthy + errors:["Deep diagnostics failed: This operation was
	// aborted"] + recommendations:[] simultaneously. A watchdog reading only
	// `status` concluded the requested diagnostic was complete.
	// Fix: degraded verdict + typed abort_reason + separate infrastructure_status
	// + actionable recommendation. Recurrence of the #2547 masking class.
	// ============================================================

	describe('#3257 — deep diagnostics abort degrades the verdict', () => {
		beforeEach(() => {
			// Healthy baseline: collection exists with points, embeddings OK —
			// only the deep scroll fails (the incident's exact configuration).
			mockQdrantClient.getCollections.mockResolvedValue({
				collections: [{ name: 'test-roo-state-manager' }]
			});
			mockQdrantClient.getCollection.mockResolvedValue({
				vectors_count: 1000,
				indexed_vectors_count: 1000,
				points_count: 100,
				config: { params: { vectors: { distance: 'Cosine', size: 1536 } } }
			});
			mockOpenAIClient.embeddings.create.mockResolvedValue({
				data: [{ embedding: new Array(1536).fill(0.1) }]
			});
		});

		it('reproduces the po-2025 incident: QdrantClientTimeoutError abort → degraded, not healthy', async () => {
			// Realistic incident shape (verified in @qdrant/js-client-rest@1.16.2
			// dist/cjs/api-client.js): the client's timeout middleware converts its
			// internal AbortError into QdrantClientTimeoutError, message preserved.
			const timeoutErr: any = new Error('This operation was aborted');
			timeoutErr.name = 'QdrantClientTimeoutError';
			mockQdrantClient.scroll.mockRejectedValue(timeoutErr);

			const parsed = JSON.parse((await handleDiagnoseSemanticIndex(
				conversationCache,
				{ deep: true, sample_size: 1000, top_n_workspaces: 20 }
			)).content[0].text);

			// Acceptance: deep=true + abort → degraded|partial (NOT healthy).
			expect(parsed.status).toBe('degraded');
			// Typed, structured reason — not just the generic text.
			expect(parsed.details.deep_diagnostics.abort_reason).toBe('timeout');
			expect(parsed.details.deep_diagnostics.error).toBe('This operation was aborted');
			expect(parsed.errors.some((e: string) => e.includes('reason=timeout'))).toBe(true);
			// Acceptance: infrastructure status stays exposed separately.
			expect(parsed.infrastructure_status).toEqual({
				qdrant: 'healthy',
				embeddings: 'healthy',
				deep_diagnostics: 'failed'
			});
			// Acceptance: actionable recommendation (the incident output had none).
			expect(parsed.recommendations.some((r: string) => r.includes('Réduisez sample_size'))).toBe(true);
			expect(parsed.recommendations.some((r: string) => r.includes('QDRANT_TIMEOUT_MS'))).toBe(true);
		});

		it('distinguishes caller cancellation from internal timeout (raw AbortError)', async () => {
			// A RAW AbortError cannot be the client's internal timeout — the client's
			// middleware converts its own into QdrantClientTimeoutError. So a bare
			// AbortError reaching the handler is an external abort (caller/transport).
			const abortErr: any = new Error('This operation was aborted');
			abortErr.name = 'AbortError';
			abortErr.code = 'ABORT_ERR';
			mockQdrantClient.scroll.mockRejectedValue(abortErr);

			const parsed = JSON.parse((await handleDiagnoseSemanticIndex(
				conversationCache,
				{ deep: true }
			)).content[0].text);

			expect(parsed.details.deep_diagnostics.abort_reason).toBe('caller_cancelled');
			expect(parsed.status).toBe('degraded');
			expect(parsed.recommendations.some((r: string) => r.includes('annulés par l\'appelant'))).toBe(true);
		});

		it('AbortError with a TimeoutError cause classifies as timeout', async () => {
			// AbortSignal.timeout() rejects with an AbortError whose cause is a
			// DOMException named 'TimeoutError' — that signature means timeout.
			const causeErr: any = new Error('The operation was aborted due to timeout');
			causeErr.name = 'TimeoutError';
			const abortErr: any = new Error('This operation was aborted');
			abortErr.name = 'AbortError';
			abortErr.cause = causeErr;
			mockQdrantClient.scroll.mockRejectedValue(abortErr);

			const parsed = JSON.parse((await handleDiagnoseSemanticIndex(
				conversationCache,
				{ deep: true }
			)).content[0].text);

			expect(parsed.details.deep_diagnostics.abort_reason).toBe('timeout');
		});

		it('routes a 5xx scroll failure to server_abort with a backend-check recommendation', async () => {
			mockQdrantClient.scroll.mockRejectedValue({ status: 503, message: 'Service Unavailable' });

			const parsed = JSON.parse((await handleDiagnoseSemanticIndex(
				conversationCache,
				{ deep: true }
			)).content[0].text);

			expect(parsed.details.deep_diagnostics.abort_reason).toBe('server_abort');
			expect(parsed.status).toBe('degraded');
			expect(parsed.recommendations.some((r: string) => r.includes('interrompus par le serveur'))).toBe(true);
		});

		it('reports deep_diagnostics:completed and keeps healthy when the deep pass succeeds', async () => {
			mockQdrantClient.scroll.mockResolvedValue({
				points: [{ id: 'p1', payload: { source: 'roo', workspace_name: 'w', timestamp: '2026-07-01', task_id: 'a' } }]
			});

			const parsed = JSON.parse((await handleDiagnoseSemanticIndex(
				conversationCache,
				{ deep: true }
			)).content[0].text);

			expect(parsed.status).toBe('healthy');
			expect(parsed.infrastructure_status).toEqual({
				qdrant: 'healthy',
				embeddings: 'healthy',
				deep_diagnostics: 'completed'
			});
		});

		it('reports deep_diagnostics:skipped when deep was not requested', async () => {
			const parsed = JSON.parse((await handleDiagnoseSemanticIndex(conversationCache)).content[0].text);

			expect(parsed.infrastructure_status).toEqual({
				qdrant: 'healthy',
				embeddings: 'healthy',
				deep_diagnostics: 'skipped'
			});
		});
	});

	// ============================================================
	// #3257 — generic no-false-green invariant: healthy requires errors[] empty.
	// Deep-diagnostics aborts were the triggering incident, but the same masking
	// existed for dimension mismatches (errors pushed, verdict stayed healthy).
	// ============================================================

	describe('#3257 — no false green (generic invariant)', () => {
		it('degrades healthy→degraded on dimension mismatch (previously healthy-with-errors)', async () => {
			mockQdrantClient.getCollections.mockResolvedValue({
				collections: [{ name: 'test-roo-state-manager' }]
			});
			// Collection built at 1536, live embedding returns 768 → mismatch.
			mockQdrantClient.getCollection.mockResolvedValue({
				vectors_count: 1000,
				indexed_vectors_count: 1000,
				points_count: 100,
				config: { params: { vectors: { distance: 'Cosine', size: 1536 } } }
			});
			mockOpenAIClient.embeddings.create.mockResolvedValue({
				data: [{ embedding: new Array(768).fill(0.1) }]
			});

			const parsed = JSON.parse((await handleDiagnoseSemanticIndex(conversationCache)).content[0].text);

			// Searches return 0 results in this state — healthy was a false green.
			expect(parsed.status).toBe('degraded');
			expect(parsed.errors.some((e: string) => e.includes('Dimension mismatch'))).toBe(true);
			expect(parsed.errors.some((e: string) => e.includes('rétrogradé healthy→degraded'))).toBe(true);
		});

		it('keeps healthy silent: zero errors, zero warnings noise', async () => {
			mockQdrantClient.getCollections.mockResolvedValue({
				collections: [{ name: 'test-roo-state-manager' }]
			});
			mockQdrantClient.getCollection.mockResolvedValue({
				vectors_count: 1000,
				indexed_vectors_count: 1000,
				points_count: 100,
				config: { params: { vectors: { distance: 'Cosine', size: 1536 } } }
			});
			mockOpenAIClient.embeddings.create.mockResolvedValue({
				data: [{ embedding: new Array(1536).fill(0.1) }]
			});

			const parsed = JSON.parse((await handleDiagnoseSemanticIndex(conversationCache)).content[0].text);

			expect(parsed.status).toBe('healthy');
			expect(parsed.errors).toHaveLength(0);
			expect(parsed.warnings).toHaveLength(0);
			expect(parsed.recommendations).toHaveLength(0);
		});
	});

	// ============================================================
	// #3257 — _classifyDeepDiagnosticError (unit): timeout interne vs
	// annulation par l'appelant vs server abort vs sample rejection.
	// ============================================================

	describe('_classifyDeepDiagnosticError (unit)', () => {
		it('classifies QdrantClientTimeoutError as timeout (structural, Phase A)', () => {
			const err: any = new Error('This operation was aborted');
			err.name = 'QdrantClientTimeoutError';
			expect(_classifyDeepDiagnosticError(err)).toBe('timeout');
		});

		it('classifies a bare AbortError as caller_cancelled (Phase B)', () => {
			const err: any = new Error('This operation was aborted');
			err.name = 'AbortError';
			expect(_classifyDeepDiagnosticError(err)).toBe('caller_cancelled');
		});

		it('classifies ABORT_ERR code without name as caller_cancelled', () => {
			expect(_classifyDeepDiagnosticError({ code: 'ABORT_ERR', message: 'This operation was aborted' })).toBe('caller_cancelled');
		});

		it('classifies AbortError with TimeoutError cause as timeout', () => {
			expect(
				_classifyDeepDiagnosticError({ name: 'AbortError', message: 'aborted', cause: { name: 'TimeoutError', message: 'due to timeout' } })
			).toBe('timeout');
		});

		it('classifies AbortError with ETIMEDOUT code as timeout', () => {
			expect(
				_classifyDeepDiagnosticError({ name: 'AbortError', code: 'ETIMEDOUT', message: 'This operation was aborted' })
			).toBe('timeout');
		});

		it('structural timeout name wins over the "aborted" message (phase order guard)', () => {
			// The exact trap: QdrantClientTimeoutError's message IS "This operation
			// was aborted" — if the abort check ran first, internal timeouts would
			// misclassify as caller_cancelled.
			expect(_classifyDeepDiagnosticError({ name: 'QdrantClientTimeoutError', message: 'This operation was aborted' })).toBe('timeout');
		});

		it('classifies HTTP 503/500 as server_abort', () => {
			expect(_classifyDeepDiagnosticError({ status: 503, message: 'Service Unavailable' })).toBe('server_abort');
			expect(_classifyDeepDiagnosticError({ status: 500, message: 'Internal Server Error' })).toBe('server_abort');
		});

		it('classifies ECONNRESET / socket hang up as server_abort', () => {
			expect(_classifyDeepDiagnosticError({ code: 'ECONNRESET', message: 'read ECONNRESET' })).toBe('server_abort');
			expect(_classifyDeepDiagnosticError(new Error('socket hang up'))).toBe('server_abort');
		});

		it('classifies a 4xx explicitly about the sample as sample_limit_rejected', () => {
			expect(_classifyDeepDiagnosticError({ status: 400, message: 'sample size exceeds limit' })).toBe('sample_limit_rejected');
			expect(_classifyDeepDiagnosticError({ status: 413, message: 'requested size too large' })).toBe('sample_limit_rejected');
		});

		it('does NOT classify an unrelated 4xx as sample_limit_rejected', () => {
			expect(_classifyDeepDiagnosticError({ status: 404, message: 'not found' })).toBe('unknown');
			expect(_classifyDeepDiagnosticError({ status: 400, message: 'bad request shape' })).toBe('unknown');
		});

		it('falls back to timeout on generic timeout keywords (plain Error)', () => {
			expect(_classifyDeepDiagnosticError(new Error('scroll timeout'))).toBe('timeout');
			expect(_classifyDeepDiagnosticError(new Error('request timed out'))).toBe('timeout');
		});

		it('returns unknown for undefined/null/empty shapes', () => {
			expect(_classifyDeepDiagnosticError(undefined)).toBe('unknown');
			expect(_classifyDeepDiagnosticError(null)).toBe('unknown');
			expect(_classifyDeepDiagnosticError({})).toBe('unknown');
		});
	});

	// ============================================================
	// #2766 — OpenAI error type classification (typed status vs blanket 'failed')
	// Goal: kill the false-positive key-rotation loop (network/service failures were
	// indistinguishable from auth failures, triggering useless key rotations fleet-wide).
	// ============================================================

	describe('_classifyOpenAIError (unit)', () => {
		it('classifies HTTP 401 as auth_401', () => {
			expect(_classifyOpenAIError({ status: 401, message: 'Unauthorized' })).toBe('auth_401');
		});

		it('classifies SDK code invalid_api_key as auth_401', () => {
			expect(_classifyOpenAIError({ code: 'invalid_api_key', message: 'Incorrect API key provided' })).toBe('auth_401');
		});

		it('classifies "Invalid API key" message (plain Error, no .status) as auth_401', () => {
			// Real-world: vLLM proxies sometimes return a bare Error without a .status field.
			expect(_classifyOpenAIError(new Error('Invalid API key'))).toBe('auth_401');
		});

		it('classifies HTTP 503 as service_503', () => {
			expect(_classifyOpenAIError({ status: 503, message: 'Service Unavailable' })).toBe('service_503');
		});

		it('classifies HTTP 500 as service_503', () => {
			expect(_classifyOpenAIError({ status: 500, message: 'Internal Server Error' })).toBe('service_503');
		});

		it('classifies ECONNREFUSED code as conn_refused', () => {
			expect(_classifyOpenAIError({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:6333' })).toBe('conn_refused');
		});

		it('classifies cause.code ECONNREFUSED as conn_refused', () => {
			// fetch() wraps the socket error in .cause — the real errno lives there.
			expect(_classifyOpenAIError({ message: 'fetch failed', cause: { code: 'ECONNREFUSED' } })).toBe('conn_refused');
		});

		it('classifies ETIMEDOUT code as network_timeout', () => {
			expect(_classifyOpenAIError({ code: 'ETIMEDOUT', message: 'connect ETIMEDOUT' })).toBe('network_timeout');
		});

		it('classifies "timed out" message as network_timeout', () => {
			expect(_classifyOpenAIError(new Error('Request timed out after 30000ms'))).toBe('network_timeout');
		});

		it('classifies curl exit code 28 message as network_timeout', () => {
			expect(_classifyOpenAIError(new Error('Command failed: curl ... exit code 28'))).toBe('network_timeout');
		});

		it('returns unknown for an unrecognized error', () => {
			expect(_classifyOpenAIError(new Error('something weird happened'))).toBe('unknown');
		});

		it('returns unknown for undefined/null/empty shapes', () => {
			expect(_classifyOpenAIError(undefined)).toBe('unknown');
			expect(_classifyOpenAIError(null)).toBe('unknown');
			expect(_classifyOpenAIError({})).toBe('unknown');
		});

		it('prefers auth_401 when status is the higher-signal 401', () => {
			// A 401 with a 503-ish message → auth wins (HTTP status is more authoritative than substring).
			expect(_classifyOpenAIError({ status: 401, message: 'service down maybe' })).toBe('auth_401');
		});

		// ============================================================
		// Review-driven regression guards (Hermes + po-2026 review on PR #881).
		// These pin the v2 phase-separation fix (structural status checked before
		// any substring), which the v1 mixed-OR classifier got wrong.
		// ============================================================

		it('prefers service_503 when status is 503 even if message says unauthorized (po-2026 #1)', () => {
			// The exact edge case the v1 mixed-OR misclassified: status 503 + "unauthorized"
			// body → returned auth_401 (substring short-circuited before the service branch).
			// Phase A structural-status check now wins → service_503.
			expect(_classifyOpenAIError({ status: 503, message: 'upstream Unauthorized proxy error' })).toBe('service_503');
		});

		it('does not match bare numeric substrings like "4014ms" (Hermes non-blocking)', () => {
			// v1 had msg.includes('401') which falsely caught "request took 4014ms".
			// v2 dropped bare numeric substrings → no status/code/keyword → unknown.
			expect(_classifyOpenAIError(new Error('request took 4014ms'))).toBe('unknown');
		});

		it('classifies HTTP 403 as auth_401', () => {
			// 403 Forbidden is also a credential/permission signal → auth bucket.
			expect(_classifyOpenAIError({ status: 403, message: 'Forbidden' })).toBe('auth_401');
		});
	});

	describe('openai_error_type integration (diagnose output)', () => {
		// Re-use the healthy Qdrant baseline; only the OpenAI rejection varies per test.
		beforeEach(() => {
			mockQdrantClient.getCollections.mockResolvedValue({
				collections: [{ name: 'test-roo-state-manager' }]
			});
			mockQdrantClient.getCollection.mockResolvedValue({
				vectors_count: 1000,
				indexed_vectors_count: 1000,
				points_count: 100,
				config: { params: { vectors: { distance: 'Cosine', size: 1536 } } }
			});
		});

		it('emits openai_error_type=auth_401 while keeping openai_connection=failed on 401', async () => {
			mockOpenAIClient.embeddings.create.mockRejectedValue({ status: 401, message: 'Unauthorized' });

			const parsed = JSON.parse((await handleDiagnoseSemanticIndex(conversationCache)).content[0].text);

			// openai_connection stays 'failed' (back-compat: downstream consumers at L328/L344 check === 'failed').
			expect(parsed.details.openai_connection).toBe('failed');
			expect(parsed.details.openai_error_type).toBe('auth_401');
		});

		it('emits openai_error_type=network_timeout on ETIMEDOUT and routes reco to network (NOT key)', async () => {
			mockOpenAIClient.embeddings.create.mockRejectedValue({ code: 'ETIMEDOUT', message: 'connect ETIMEDOUT' });

			const parsed = JSON.parse((await handleDiagnoseSemanticIndex(conversationCache)).content[0].text);

			expect(parsed.details.openai_error_type).toBe('network_timeout');
			// The key-rotation reco MUST NOT fire for a network failure (this is the loop we're killing).
			expect(parsed.recommendations).not.toContain(
				'Vérifiez EMBEDDING_API_KEY et EMBEDDING_API_BASE_URL dans .env (self-hosted vLLM)'
			);
			expect(parsed.recommendations.some((r: string) => r.includes('Timeout atteint'))).toBe(true);
			expect(parsed.recommendations.some((r: string) => r.includes('NE PAS faire de rotation de la clé'))).toBe(true);
		});

		it('emits openai_error_type=service_503 on HTTP 503 and routes reco to service', async () => {
			mockOpenAIClient.embeddings.create.mockRejectedValue({ status: 503, message: 'Service Unavailable' });

			const parsed = JSON.parse((await handleDiagnoseSemanticIndex(conversationCache)).content[0].text);

			expect(parsed.details.openai_error_type).toBe('service_503');
			expect(parsed.recommendations.some((r: string) => r.includes('HTTP 503'))).toBe(true);
			expect(parsed.recommendations.some((r: string) => r.includes('NE PAS faire de rotation de la clé'))).toBe(true);
		});

		it('emits openai_error_type=conn_refused on ECONNREFUSED and routes reco to port/service', async () => {
			mockOpenAIClient.embeddings.create.mockRejectedValue({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:6333' });

			const parsed = JSON.parse((await handleDiagnoseSemanticIndex(conversationCache)).content[0].text);

			expect(parsed.details.openai_error_type).toBe('conn_refused');
			expect(parsed.recommendations.some((r: string) => r.includes('Connexion refusée'))).toBe(true);
			expect(parsed.recommendations.some((r: string) => r.includes('NE PAS faire de rotation de la clé'))).toBe(true);
		});

		it('downgrades healthy→degraded even with a typed error (#2547 consumer intact)', async () => {
			// Regression guard: the L328 downgrade checks openai_connection === 'failed' (NOT error_type),
			// so a typed failure must still downgrade — otherwise status stays 'healthy' masking the outage.
			mockOpenAIClient.embeddings.create.mockRejectedValue({ code: 'ETIMEDOUT', message: 'connect ETIMEDOUT' });

			const parsed = JSON.parse((await handleDiagnoseSemanticIndex(conversationCache)).content[0].text);

			expect(parsed.status).toBe('degraded');
			expect(parsed.errors.some((e: string) => e.includes('status downgraded from healthy to degraded'))).toBe(true);
		});

		it('does NOT emit openai_error_type on success', async () => {
			// Success path must not pollute the output with an error_type field.
			mockOpenAIClient.embeddings.create.mockResolvedValue({
				data: [{ embedding: new Array(1536).fill(0.1) }]
			});

			const parsed = JSON.parse((await handleDiagnoseSemanticIndex(conversationCache)).content[0].text);

			expect(parsed.details.openai_connection).toBe('success');
			expect(parsed.details.openai_error_type).toBeUndefined();
		});
	});
});
