/**
 * Tests d'exécution pour codebase_search
 *
 * Couvre les chemins d'exécution de la fonction handleCodebaseSearch
 * pour améliorer la couverture de tests (23.34% -> objectif 80%+)
 *
 * @module search/codebase-search-execution.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	handleCodebaseSearch,
	getWorkspaceCollectionName
} from '../../../../src/tools/search/search-codebase.tool.js';

// Mock de Qdrant
const mockQuery = vi.fn();
const mockGetCollection = vi.fn();

vi.mock('../../../../src/services/qdrant.js', () => ({
	getQdrantClient: () => ({
		query: mockQuery,
		getCollection: mockGetCollection
	})
}));

// Mock de OpenAI
const mockEmbeddingsCreate = vi.fn();

vi.mock('openai', () => ({
	default: vi.fn().mockImplementation(() => ({
		embeddings: {
			create: mockEmbeddingsCreate
		}
	}))
}));

// Mock process.env
const originalEnv = process.env;

function setupMocks() {
	mockQuery.mockReset();
	mockGetCollection.mockReset();
	mockEmbeddingsCreate.mockReset();

	mockEmbeddingsCreate.mockResolvedValue({
		data: [{ embedding: new Array(2560).fill(0.1) }]
	});

	mockGetCollection.mockResolvedValue({ status: 'green' });

	mockQuery.mockResolvedValue({
		points: [
			{
				score: 0.95,
				payload: {
					filePath: 'src/test.ts',
					codeChunk: 'export function test() { return true; }',
					startLine: 10,
					endLine: 12,
					pathSegments: ['src', 'test.ts']
				}
			},
			{
				score: 0.75,
				payload: {
					filePath: 'src/other.ts',
					codeChunk: 'const value = 42;',
					startLine: 5,
					endLine: 5,
					pathSegments: ['src', 'other.ts']
				}
			}
		]
	});
}

describe('codebase_search - handleCodebaseSearch - Validation', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		process.env = { ...originalEnv };
		process.env.EMBEDDING_API_KEY = 'test-key';
		mockEmbeddingsCreate.mockResolvedValue({
			data: [{ embedding: new Array(2560).fill(0.1) }]
		});
	});

	afterEach(() => {
		process.env = { ...originalEnv };
	});

	it('devrait rejeter une query vide', async () => {
		const result = await handleCodebaseSearch({ query: '' });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain('requis');
	});

	it('devrait rejeter une query avec seulement des espaces', async () => {
		const result = await handleCodebaseSearch({ query: '   ' });
		expect(result.isError).toBe(true);
	});

	it('devrait rejeter query undefined', async () => {
		const result = await handleCodebaseSearch({ query: undefined as any });
		expect(result.isError).toBe(true);
	});
});

describe('codebase_search - handleCodebaseSearch - Collection not found', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		process.env = { ...originalEnv };
		process.env.EMBEDDING_API_KEY = 'test-key';
		mockEmbeddingsCreate.mockResolvedValue({
			data: [{ embedding: new Array(2560).fill(0.1) }]
		});
		mockGetCollection.mockImplementation(() => {
			throw new Error('Collection not found');
		});
	});

	afterEach(() => {
		process.env = { ...originalEnv };
	});

	it('devrait retourner collection_not_found si aucune collection trouvée', async () => {
		const result = await handleCodebaseSearch({ query: 'test' });
		expect(result.isError).toBe(false);
		const response = JSON.parse(result.content[0].text);
		expect(response.status).toBe('collection_not_found');
		expect(response.tried_collections).toBeDefined();
		expect(response.tried_collections.length).toBeGreaterThan(0);
	});

	it('devrait inclure un hint pour indexer le workspace', async () => {
		const result = await handleCodebaseSearch({ query: 'test', workspace: 'd:\\test' });
		const response = JSON.parse(result.content[0].text);
		expect(response.hint).toContain('indexé par Roo Code');
	});

	it('devrait inclure le workspace testé', async () => {
		const result = await handleCodebaseSearch({ query: 'test', workspace: 'c:\\projects\\test' });
		const response = JSON.parse(result.content[0].text);
		expect(response.workspace).toBe('c:\\projects\\test');
	});
});

describe('codebase_search - handleCodebaseSearch - Search success', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		process.env = { ...originalEnv };
		process.env.EMBEDDING_API_KEY = 'test-key';
		setupMocks();
	});

	afterEach(() => {
		process.env = { ...originalEnv };
	});

	it('devrait retourner les résultats formatés', async () => {
		const result = await handleCodebaseSearch({ query: 'test function' });
		expect(result.isError).toBe(false);
		const response = JSON.parse(result.content[0].text);
		expect(response.status).toBe('success');
		expect(response.results_count).toBe(2);
	});

	it('devrait inclure le score et la relevance', async () => {
		const result = await handleCodebaseSearch({ query: 'test' });
		const response = JSON.parse(result.content[0].text);
		expect(response.results[0].score).toBe(0.95);
		expect(response.results[0].relevance).toBe('excellent');
		expect(response.results[1].relevance).toBe('good');
	});

	it('devrait inclure un snippet extrait', async () => {
		const result = await handleCodebaseSearch({ query: 'function' });
		const response = JSON.parse(result.content[0].text);
		expect(response.results[0].snippet).toBeDefined();
		expect(response.results[0].snippet).toContain('function');
	});

	it('devrait inclure les numéros de ligne', async () => {
		const result = await handleCodebaseSearch({ query: 'test' });
		const response = JSON.parse(result.content[0].text);
		expect(response.results[0].lines).toBe('10-12');
		expect(response.results[0].start_line).toBe(10);
		expect(response.results[0].end_line).toBe(12);
	});

	it('devrait respecter le paramètre limit', async () => {
		await handleCodebaseSearch({ query: 'test', limit: 5 });
		expect(mockQuery).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ limit: 5 })
		);
	});

	it('devrait plafonner le limit à MAX_LIMIT', async () => {
		await handleCodebaseSearch({ query: 'test', limit: 100 });
		expect(mockQuery).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ limit: 30 })
		);
	});

	it('devrait utiliser le min_score fourni', async () => {
		await handleCodebaseSearch({ query: 'test', min_score: 0.8 });
		expect(mockQuery).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ score_threshold: 0.8 })
		);
	});

	it('devrait utiliser le workspace par défaut si non fourni', async () => {
		const result = await handleCodebaseSearch({ query: 'test' });
		const response = JSON.parse(result.content[0].text);
		expect(response.workspace).toBeDefined();
	});
});

describe('codebase_search - handleCodebaseSearch - Directory filter', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		process.env = { ...originalEnv };
		process.env.EMBEDDING_API_KEY = 'test-key';
		mockEmbeddingsCreate.mockResolvedValue({
			data: [{ embedding: new Array(2560).fill(0.1) }]
		});
		mockGetCollection.mockResolvedValue({ status: 'green' });
		mockQuery.mockResolvedValue({ points: [] });
	});

	afterEach(() => {
		process.env = { ...originalEnv };
	});

	it('devrait construire un filtre pour directory_prefix', async () => {
		await handleCodebaseSearch({ query: 'test', directory_prefix: 'src/services' });
		expect(mockQuery).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				filter: expect.objectContaining({
					must: expect.arrayContaining([
						expect.objectContaining({ key: 'pathSegments.0', match: { value: 'src' } }),
						expect.objectContaining({ key: 'pathSegments.1', match: { value: 'services' } })
					])
				})
			})
		);
	});

	it('devrait normaliser les séparateurs', async () => {
		await handleCodebaseSearch({ query: 'test', directory_prefix: 'src\\services' });
		expect(mockQuery).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				filter: expect.objectContaining({
					must: expect.arrayContaining([
						expect.objectContaining({ key: 'pathSegments.0', match: { value: 'src' } })
					])
				})
			})
		);
	});

	it('devrait ignorer les segments vides', async () => {
		await handleCodebaseSearch({ query: 'test', directory_prefix: 'src//services/' });
		expect(mockQuery).toHaveBeenCalled();
	});
});

describe('codebase_search - handleCodebaseSearch - Results filtering', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		process.env = { ...originalEnv };
		process.env.EMBEDDING_API_KEY = 'test-key';
		mockEmbeddingsCreate.mockResolvedValue({
			data: [{ embedding: new Array(2560).fill(0.1) }]
		});
		mockGetCollection.mockResolvedValue({ status: 'green' });
	});

	afterEach(() => {
		process.env = { ...originalEnv };
	});

	it('devrait filtrer les résultats sans filePath', async () => {
		mockQuery.mockResolvedValue({
			points: [
				{ score: 0.9, payload: { codeChunk: 'test' } },
				{ score: 0.8, payload: { filePath: 'valid.ts', codeChunk: 'valid' } }
			]
		});

		const result = await handleCodebaseSearch({ query: 'test' });
		const response = JSON.parse(result.content[0].text);
		expect(response.results_count).toBe(1);
		expect(response.results[0].file_path).toBe('valid.ts');
	});

	it('devrait filtrer les résultats sans codeChunk', async () => {
		mockQuery.mockResolvedValue({
			points: [
				{ score: 0.9, payload: { filePath: 'test.ts' } },
				{ score: 0.8, payload: { filePath: 'valid.ts', codeChunk: 'valid' } }
			]
		});

		const result = await handleCodebaseSearch({ query: 'test' });
		const response = JSON.parse(result.content[0].text);
		expect(response.results_count).toBe(1);
		expect(response.results[0].file_path).toBe('valid.ts');
	});

	it('devrait gérer les résultats sans startLine/endLine', async () => {
		mockQuery.mockResolvedValue({
			points: [
				{ score: 0.9, payload: { filePath: 'no-lines.ts', codeChunk: 'code' } }
			]
		});

		const result = await handleCodebaseSearch({ query: 'test' });
		const response = JSON.parse(result.content[0].text);
		expect(response.results[0].lines).toBeUndefined();
	});
});

describe('codebase_search - workspace collection name', () => {
	it('devrait générer le même nom pour le même workspace', () => {
		const name1 = getWorkspaceCollectionName('d:\\test');
		const name2 = getWorkspaceCollectionName('d:\\test');
		expect(name1).toBe(name2);
	});

	it('devrait générer des noms différents pour des workspaces différents', () => {
		const name1 = getWorkspaceCollectionName('d:\\test');
		const name2 = getWorkspaceCollectionName('d:\\other');
		expect(name1).not.toBe(name2);
	});
});
