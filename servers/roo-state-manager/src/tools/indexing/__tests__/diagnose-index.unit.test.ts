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
import { handleDiagnoseSemanticIndex, _resetConnectivityCache } from '../diagnose-index.tool.js';
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
			// Source: L319-322 — catch wraps the deep diagnostics block; never throws.
			mockQdrantClient.scroll.mockRejectedValue(new Error('scroll timeout'));

			const result = await handleDiagnoseSemanticIndex(
				conversationCache,
				{ deep: true }
			);

			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.details.deep_diagnostics.error).toBe('scroll timeout');
			expect(parsed.errors.some((e: string) => e.includes('Deep diagnostics failed'))).toBe(true);
			// Top-level status stays healthy (Qdrant collection still OK).
			expect(parsed.status).toBe('healthy');
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
			expect(rec).toContain('ChunkExtractor.ts');
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
});
