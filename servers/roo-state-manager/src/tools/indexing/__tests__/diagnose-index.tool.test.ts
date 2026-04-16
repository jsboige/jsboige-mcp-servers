/**
 * Tests pour diagnose-index.tool.ts
 * Module de diagnostic de l'index sémantique Qdrant
 *
 * Issue #656 - Phase 2.4 : Couverture Tests
 * Priorité MOYENNE - Diagnostic index
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QdrantClient } from '@qdrant/js-client-rest';
import OpenAI from 'openai';

// Create mock instances FIRST (before vi.mock)
const mockQdrantClient = {
  getCollections: vi.fn(),
  getCollection: vi.fn()
} as unknown as QdrantClient;

const mockOpenAIClient = {
  embeddings: {
    create: vi.fn()
  }
} as unknown as OpenAI;

// Mock QdrantClient - return mock instance
vi.mock('@qdrant/js-client-rest', () => ({
  QdrantClient: vi.fn(function() {
    return mockQdrantClient;
  })
}));

// Mock OpenAI - return mock instance
vi.mock('openai', () => ({
  default: vi.fn(function() {
    return mockOpenAIClient;
  })
}));

// Mock the service modules
vi.mock('../../services/qdrant.js', () => ({
  getQdrantClient: vi.fn(() => mockQdrantClient),
  resetQdrantClient: vi.fn()
}));

vi.mock('../../services/openai.js', () => ({
  getOpenAIClient: vi.fn(() => mockOpenAIClient),
  getEmbeddingModel: vi.fn(() => 'text-embedding-3-small')
}));

import { handleDiagnoseSemanticIndex, _resetConnectivityCache } from '../diagnose-index.tool.js';
import * as qdrantService from '../../services/qdrant.js';
import * as openaiService from '../../services/openai.js';

const mockedGetQdrantClient = vi.mocked(qdrantService.getQdrantClient);
const mockedGetOpenAIClient = vi.mocked(openaiService.getOpenAIClient);
const mockedGetEmbeddingModel = vi.mocked(openaiService.getEmbeddingModel);

describe('diagnose-index', () => {
  const mockConversationCache = new Map();

  beforeEach(() => {
    vi.clearAllMocks();
    _resetConnectivityCache();

    // Set up default environment variables
    process.env.QDRANT_URL = 'http://localhost:6333';
    process.env.QDRANT_API_KEY = 'test-key';
    process.env.QDRANT_COLLECTION_NAME = 'roo_tasks_semantic_index';
    process.env.EMBEDDING_API_KEY = 'test-embedding-key';
    process.env.EMBEDDING_API_BASE_URL = 'http://localhost:11434';
    process.env.EMBEDDING_MODEL = 'text-embedding-3-small';
    process.env.EMBEDDING_DIMENSIONS = '1536';

    // Set up default mocks
    mockedGetQdrantClient.mockReturnValue(mockQdrantClient);
    mockedGetOpenAIClient.mockReturnValue(mockOpenAIClient);
    mockedGetEmbeddingModel.mockReturnValue('text-embedding-3-small');

    // Set up default Qdrant responses
    (mockQdrantClient.getCollections as any).mockResolvedValue({
      collections: [
        {
          name: 'roo_tasks_semantic_index',
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
        }
      ]
    });

    (mockQdrantClient.getCollection as any).mockResolvedValue({
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

    // Set up default OpenAI response
    (mockOpenAIClient.embeddings.create as any).mockResolvedValue({
      data: [{ embedding: new Array(1536).fill(0.1) }]
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('healthy collection scenario', () => {
    it('should return healthy status when collection exists and has points', async () => {
      const result = await handleDiagnoseSemanticIndex(mockConversationCache);
      const text = result.content[0].text as string;
      const diagnostics = JSON.parse(text);

      expect(diagnostics.status).toBe('healthy');
      expect(diagnostics.details.collection_exists).toBe(true);
      expect(diagnostics.details.qdrant_connection).toBe('success');
      expect(diagnostics.details.openai_connection).toBe('success');
    });

    it('should include collection info when healthy', async () => {
      const result = await handleDiagnoseSemanticIndex(mockConversationCache);
      const text = result.content[0].text as string;
      const diagnostics = JSON.parse(text);

      expect(diagnostics.details.collection_info).toBeDefined();
      expect(diagnostics.details.collection_info.points_count).toBe(100);
      expect(diagnostics.details.collection_info.vectors_count).toBe(1000);
    });
  });

  describe('missing collection scenario', () => {
    it('should return missing_collection status when collection does not exist', async () => {
      (mockQdrantClient.getCollections as any).mockResolvedValue({
        collections: [
          { name: 'other_collection' }
        ]
      });

      const result = await handleDiagnoseSemanticIndex(mockConversationCache);
      const text = result.content[0].text as string;
      const diagnostics = JSON.parse(text);

      expect(diagnostics.status).toBe('missing_collection');
      expect(diagnostics.details.collection_exists).toBe(false);
      expect(diagnostics.errors).toContainEqual(
        expect.stringContaining("n'existe pas dans Qdrant")
      );
    });

    it('should provide recommendation for missing collection', async () => {
      (mockQdrantClient.getCollections as any).mockResolvedValue({
        collections: []
      });

      const result = await handleDiagnoseSemanticIndex(mockConversationCache);
      const text = result.content[0].text as string;
      const diagnostics = JSON.parse(text);

      expect(diagnostics.recommendations).toContainEqual(
        expect.stringContaining('rebuild_task_index')
      );
    });
  });

  describe('empty collection scenario', () => {
    it('should return empty_collection status when collection has no points', async () => {
      (mockQdrantClient.getCollection as any).mockResolvedValue({
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

      const result = await handleDiagnoseSemanticIndex(mockConversationCache);
      const text = result.content[0].text as string;
      const diagnostics = JSON.parse(text);

      expect(diagnostics.status).toBe('empty_collection');
      expect(diagnostics.errors).toContainEqual(
        expect.stringContaining('ne contient aucun point indexé')
      );
    });
  });

  describe('Qdrant connection failure scenarios', () => {
    it('should return connection_failed when getCollections fails', async () => {
      (mockQdrantClient.getCollections as any).mockRejectedValue(
        new Error('ECONNREFUSED')
      );

      const result = await handleDiagnoseSemanticIndex(mockConversationCache);
      const text = result.content[0].text as string;
      const diagnostics = JSON.parse(text);

      expect(diagnostics.status).toBe('connection_failed');
      expect(diagnostics.details.qdrant_connection).toBe('failed');
      expect(diagnostics.errors).toContainEqual(
        expect.stringContaining('Impossible de se connecter à Qdrant')
      );
    });

    it('should continue checking OpenAI even when Qdrant fails', async () => {
      (mockQdrantClient.getCollections as any).mockRejectedValue(
        new Error('Qdrant down')
      );

      const result = await handleDiagnoseSemanticIndex(mockConversationCache);
      const text = result.content[0].text as string;
      const diagnostics = JSON.parse(text);

      // Should still have OpenAI check results
      expect(diagnostics.details.openai_connection).toBeDefined();
      expect(mockOpenAIClient.embeddings.create).toHaveBeenCalled();
    });

    it('should provide recommendation for Qdrant connection failure', async () => {
      (mockQdrantClient.getCollections as any).mockRejectedValue(
        new Error('Connection timeout')
      );

      const result = await handleDiagnoseSemanticIndex(mockConversationCache);
      const text = result.content[0].text as string;
      const diagnostics = JSON.parse(text);

      expect(diagnostics.recommendations).toContainEqual(
        expect.stringContaining('Qdrant')
      );
    });
  });

  describe('OpenAI connection failure scenarios', () => {
    it('should detect OpenAI connection failure', async () => {
      (mockOpenAIClient.embeddings.create as any).mockRejectedValue(
        new Error('OpenAI API error')
      );

      const result = await handleDiagnoseSemanticIndex(mockConversationCache);
      const text = result.content[0].text as string;
      const diagnostics = JSON.parse(text);

      expect(diagnostics.details.openai_connection).toBe('failed');
      expect(diagnostics.errors).toContainEqual(
        expect.stringContaining('OpenAI')
      );
    });

    it('should provide recommendation for OpenAI connection failure', async () => {
      (mockOpenAIClient.embeddings.create as any).mockRejectedValue(
        new Error('Authentication failed')
      );

      const result = await handleDiagnoseSemanticIndex(mockConversationCache);
      const text = result.content[0].text as string;
      const diagnostics = JSON.parse(text);

      expect(diagnostics.recommendations).toContainEqual(
        expect.stringContaining('EMBEDDING_API_KEY')
      );
    });

    it('should detect failed embedding with zero length', async () => {
      (mockOpenAIClient.embeddings.create as any).mockResolvedValue({
        data: [{ embedding: [] }] // Empty embedding
      });

      const result = await handleDiagnoseSemanticIndex(mockConversationCache);
      const text = result.content[0].text as string;
      const diagnostics = JSON.parse(text);

      expect(diagnostics.details.openai_connection).toBe('failed');
    });
  });

  describe('missing environment variables', () => {
    it('should detect missing QDRANT_URL', async () => {
      delete process.env.QDRANT_URL;

      const result = await handleDiagnoseSemanticIndex(mockConversationCache);
      const text = result.content[0].text as string;
      const diagnostics = JSON.parse(text);

      expect(diagnostics.details.environment_variables.QDRANT_URL).toBe(false);
      expect(diagnostics.errors).toContainEqual(
        expect.stringContaining('QDRANT_URL')
      );
    });

    it('should detect multiple missing environment variables', async () => {
      delete process.env.QDRANT_URL;
      delete process.env.EMBEDDING_API_KEY;
      delete process.env.EMBEDDING_DIMENSIONS;

      const result = await handleDiagnoseSemanticIndex(mockConversationCache);
      const text = result.content[0].text as string;
      const diagnostics = JSON.parse(text);

      expect(diagnostics.errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining('Variables d\'environnement manquantes')
        ])
      );
    });
  });

  describe('environment variables validation', () => {
    it('should list all environment variables status', async () => {
      const result = await handleDiagnoseSemanticIndex(mockConversationCache);
      const text = result.content[0].text as string;
      const diagnostics = JSON.parse(text);

      expect(diagnostics.details.environment_variables).toEqual({
        QDRANT_URL: true,
        QDRANT_API_KEY: true,
        QDRANT_COLLECTION_NAME: true,
        EMBEDDING_API_KEY: true,
        EMBEDDING_API_BASE_URL: true,
        EMBEDDING_MODEL: true,
        EMBEDDING_DIMENSIONS: true
      });
    });
  });

  describe('diagnostics structure', () => {
    it('should return valid JSON structure', async () => {
      const result = await handleDiagnoseSemanticIndex(mockConversationCache);
      const text = result.content[0].text as string;

      expect(() => JSON.parse(text)).not.toThrow();
    });

    it('should include timestamp', async () => {
      const result = await handleDiagnoseSemanticIndex(mockConversationCache);
      const text = result.content[0].text as string;
      const diagnostics = JSON.parse(text);

      expect(diagnostics.timestamp).toBeDefined();
      const date = new Date(diagnostics.timestamp);
      expect(date.toString()).not.toBe('Invalid Date');
    });

    it('should include collection name', async () => {
      const result = await handleDiagnoseSemanticIndex(mockConversationCache);
      const text = result.content[0].text as string;
      const diagnostics = JSON.parse(text);

      expect(diagnostics.collection_name).toBe('roo_tasks_semantic_index');
    });
  });

  describe('recommendations generation', () => {
    it('should provide no recommendations when everything is healthy', async () => {
      const result = await handleDiagnoseSemanticIndex(mockConversationCache);
      const text = result.content[0].text as string;
      const diagnostics = JSON.parse(text);

      expect(diagnostics.recommendations).toEqual([]);
    });

    it('should provide multiple recommendations for multiple issues', async () => {
      (mockQdrantClient.getCollections as any).mockRejectedValue(new Error('Qdrant down'));
      (mockOpenAIClient.embeddings.create as any).mockRejectedValue(new Error('OpenAI down'));
      delete process.env.QDRANT_URL;

      const result = await handleDiagnoseSemanticIndex(mockConversationCache);
      const text = result.content[0].text as string;
      const diagnostics = JSON.parse(text);

      expect(diagnostics.recommendations.length).toBeGreaterThan(0);
    });
  });
});
