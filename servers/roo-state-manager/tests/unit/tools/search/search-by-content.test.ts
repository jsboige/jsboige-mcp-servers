/**
 * Tests unitaires pour l'outil search_tasks_by_content (anciennement search_tasks_semantic)
 * 
 * Tests couvrant :
 * - Renommage de l'outil de search_tasks_semantic vers search_tasks_by_content
 * - Préservation de la fonctionnalité avec le nouveau nom
 * - Compatibilité des paramètres
 * - Gestion des erreurs
 * - Intégration avec le fallback textuel
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { searchTasksByContentTool } from '../../../../src/tools/search/search-semantic.tool.js';
import { ConversationSkeleton } from '../../../../src/types/conversation.js';

// Mock Qdrant client
const mockQdrantClient = {
  search: vi.fn(),
  getCollections: vi.fn(),
  getCollection: vi.fn(),
};

// Mock OpenAI client
const mockOpenAIClient = {
  embeddings: {
    create: vi.fn()
  }
};

// Mock TaskIndexer
const mockTaskIndexer = {
  getHostIdentifier: vi.fn().mockReturnValue('test-host-123'),
};

// Mock cache
const createMockCache = (): Map<string, ConversationSkeleton> => {
  const cache = new Map<string, ConversationSkeleton>();
  
  // Ajouter quelques conversations de test
  cache.set('conv1', {
    taskId: 'conv1',
    parentTaskId: undefined,
    metadata: {
      title: 'Test Conversation 1',
      lastActivity: '2025-01-01T10:00:00Z',
      createdAt: '2025-01-01T09:00:00Z',
      messageCount: 5,
      actionCount: 2,
      totalSize: 1024,
    },
    sequence: [
      { role: 'user', content: 'User message 1', timestamp: '2025-01-01T10:00:00Z', isTruncated: false },
      { role: 'assistant', content: 'Assistant response 1', timestamp: '2025-01-01T10:01:00Z', isTruncated: false }
    ]
  });
  
  cache.set('conv2', {
    taskId: 'conv2',
    parentTaskId: undefined,
    metadata: {
      title: 'Test Conversation 2',
      lastActivity: '2025-01-02T15:30:00Z',
      createdAt: '2025-01-02T14:30:00Z',
      messageCount: 3,
      actionCount: 1,
      totalSize: 768,
    },
    sequence: [
      { role: 'user', content: 'Another test message', timestamp: '2025-01-02T15:30:00Z', isTruncated: false }
    ]
  });
  
  return cache;
};

// Mock des dépendances
vi.mock('../../../../src/services/qdrant.js', () => ({
  getQdrantClient: vi.fn(() => mockQdrantClient)
}));

vi.mock('../../../../src/services/openai.js', () => ({
  default: vi.fn(() => mockOpenAIClient)
}));

vi.doMock('../../../../src/services/task-indexer.js', () => ({
  TaskIndexer: vi.fn().mockImplementation(() => mockTaskIndexer),
  getHostIdentifier: vi.fn(() => mockTaskIndexer.getHostIdentifier())
}));

describe('🔍 search_tasks_by_content - Outil Renommé', () => {
  let mockCache: Map<string, ConversationSkeleton>;
  let consoleLogSpy: any;
  let consoleErrorSpy: any;

  beforeEach(() => {
    // Reset tous les mocks
    vi.clearAllMocks();
    
    // Configuration des retours par défaut
    mockQdrantClient.getCollections.mockResolvedValue({
      collections: [{ name: 'roo_tasks_semantic_index' }]
    });
    
    mockOpenAIClient.embeddings.create.mockResolvedValue({
      data: [{ embedding: new Array(1536).fill(0.1) }],
      model: 'text-embedding-3-small',
      usage: { prompt_tokens: 10, total_tokens: 10 }
    });
    
    mockCache = createMockCache();
    
    // Espionner les logs
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.clearAllMocks();
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  describe('Définition de l\'outil', () => {
    test('should have correct tool name', () => {
      expect(searchTasksByContentTool.definition.name).toBe('search_tasks_by_content');
    });

    test('should not have old tool name', () => {
      expect(searchTasksByContentTool.definition.name).not.toBe('search_tasks_semantic');
    });

    test('should have proper description', () => {
      expect(searchTasksByContentTool.definition.description).toContain('Recherche des tâches par contenu sémantique');
    });

    test('should have required search_query parameter', () => {
      const schema = searchTasksByContentTool.definition.inputSchema;
      expect(schema.properties.search_query).toBeDefined();
      expect(schema.required).toContain('search_query');
    });

    test('should have optional parameters', () => {
      const schema = searchTasksByContentTool.definition.inputSchema;
      expect(schema.properties.conversation_id).toBeDefined();
      expect(schema.properties.max_results).toBeDefined();
      expect(schema.properties.workspace).toBeDefined();
      expect(schema.properties.diagnose_index).toBeDefined();
    });
  });

  describe('Fonctionnalité de recherche sémantique', () => {
    test('should perform semantic search with query', async () => {
      const searchResults = [
        {
          id: 'result1',
          score: 0.95,
          payload: {
            task_id: 'task1',
            content: 'Relevant content about testing',
            chunk_type: 'message_exchange',
            workspace: 'test-workspace',
            task_title: 'Test Task 1',
            host_os: 'test-host-123'
          }
        }
      ];
      
      mockQdrantClient.search.mockResolvedValueOnce(searchResults);
      
      const result = await searchTasksByContentTool.handler(
        { search_query: 'testing semantic search' },
        mockCache,
        vi.fn().mockResolvedValue(true),
        vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'Fallback result' }] })
      );
      
      expect(mockOpenAIClient.embeddings.create).toHaveBeenCalledWith({
        model: 'text-embedding-3-small',
        input: 'testing semantic search'
      });
      
      expect(mockQdrantClient.search).toHaveBeenCalledWith(
        'roo_tasks_semantic_index',
        expect.objectContaining({
          vector: expect.any(Array),
          limit: 10, // valeur par défaut
          with_payload: true
        })
      );
      
      const resultText = result.content[0].type === 'text' ? result.content[0].text : '';
      const parsedResult = JSON.parse(resultText);
      
      expect(parsedResult.results).toHaveLength(1);
      expect(parsedResult.results[0]).toMatchObject({
        taskId: 'task1',
        score: 0.95,
        match: expect.stringContaining('Relevant content')
      });
    });

    test('should filter by conversation_id when provided', async () => {
      const searchResults = [
        {
          id: 'result1',
          score: 0.95,
          payload: {
            task_id: 'conv1',
            content: 'Content from conversation 1',
            chunk_type: 'message_exchange'
          }
        }
      ];
      
      mockQdrantClient.search.mockResolvedValueOnce(searchResults);
      
      const result = await searchTasksByContentTool.handler(
        { 
          search_query: 'test query',
          conversation_id: 'conv1'
        },
        mockCache,
        vi.fn().mockResolvedValue(true),
        vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'Fallback' }] })
      );
      
      expect(mockQdrantClient.search).toHaveBeenCalledWith(
        'roo_tasks_semantic_index',
        expect.objectContaining({
          filter: {
            must: [
              {
                key: "task_id",
                match: {
                  value: "conv1"
                }
              }
            ]
          }
        })
      );
    });

    test('should filter by workspace when provided', async () => {
      const searchResults = [
        {
          id: 'result1',
          score: 0.95,
          payload: {
            task_id: 'task1',
            content: 'Content from specific workspace',
            chunk_type: 'message_exchange',
            workspace: 'specific-workspace'
          }
        }
      ];
      
      mockQdrantClient.search.mockResolvedValueOnce(searchResults);
      
      const result = await searchTasksByContentTool.handler(
        { 
          search_query: 'test query',
          workspace: 'specific-workspace'
        },
        mockCache,
        vi.fn().mockResolvedValue(true),
        vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'Fallback' }] })
      );
      
      expect(mockQdrantClient.search).toHaveBeenCalledWith(
        'roo_tasks_semantic_index',
        expect.objectContaining({
          filter: {
            must: [
              {
                key: "workspace",
                match: {
                  value: "specific-workspace"
                }
              }
            ]
          }
        })
      );
    });

    test('should respect max_results parameter', async () => {
      const searchResults = Array.from({ length: 5 }, (_, i) => ({
        id: `result${i}`,
        score: 0.9 - i * 0.01,
        payload: {
          task_id: `task${i}`,
          content: `Content ${i}`,
          chunk_type: 'message_exchange'
        }
      }));
      
      mockQdrantClient.search.mockResolvedValueOnce(searchResults);
      
      const result = await searchTasksByContentTool.handler(
        {
          search_query: 'test query',
          max_results: 5
        },
        mockCache,
        vi.fn().mockResolvedValue(true),
        vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'Fallback' }] })
      );
      
      expect(mockQdrantClient.search).toHaveBeenCalledWith(
        'roo_tasks_semantic_index',
        expect.objectContaining({
          limit: 5
        })
      );
      
      const resultText = result.content[0].type === 'text' ? result.content[0].text : '';
      const parsedResult = JSON.parse(resultText);
      
      expect(parsedResult.results).toHaveLength(5);
    });
  });

  describe('Mode diagnostic', () => {
    test('should return diagnostic information when diagnose_index is true', async () => {
      const result = await searchTasksByContentTool.handler(
        { 
          search_query: 'test query',
          diagnose_index: true
        },
        mockCache,
        vi.fn().mockResolvedValue(true),
        vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'Fallback' }] })
      );
      
      const resultText = result.content[0].type === 'text' ? result.content[0].text : '';
      
      expect(resultText).toContain('Diagnostic de l\'index sémantique');
      expect(resultText).toContain('Collection: roo_tasks_semantic_index');
      expect(resultText).toContain('Existe: Oui');
      expect(resultText).toContain('Cache local: 2'); // Notre mock cache a 2 conversations
      
      // Ne devrait pas appeler OpenAI ou Qdrant search en mode diagnostic
      expect(mockOpenAIClient.embeddings.create).not.toHaveBeenCalled();
      expect(mockQdrantClient.search).not.toHaveBeenCalled();
    });

    test('should handle diagnostic errors gracefully', async () => {
      mockQdrantClient.getCollections.mockRejectedValueOnce(new Error('Qdrant connection failed'));
      
      const result = await searchTasksByContentTool.handler(
        { 
          search_query: 'test query',
          diagnose_index: true
        },
        mockCache,
        vi.fn().mockResolvedValue(true),
        vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'Fallback' }] })
      );
      
      const resultText = result.content[0].type === 'text' ? result.content[0].text : '';
      
      expect(resultText).toContain('Erreur lors du diagnostic');
      expect(resultText).toContain('Qdrant connection failed');
    });
  });

  describe('Gestion des erreurs et fallback', () => {
    test('should fallback to text search on semantic error', async () => {
      const semanticError = new Error('Semantic search failed');
      mockQdrantClient.search.mockRejectedValueOnce(semanticError);
      
      const fallbackHandler = vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'Fallback search results' }]
      });
      
      const result = await searchTasksByContentTool.handler(
        { search_query: 'test query' },
        mockCache,
        vi.fn().mockResolvedValue(true),
        fallbackHandler
      );
      
      expect(fallbackHandler).toHaveBeenCalledWith(
        { search_query: 'test query' },
        mockCache
      );
      
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('Recherche sémantique échouée, utilisation du fallback textuel')
      );
      
      const resultText = result.content[0].type === 'text' ? result.content[0].text : '';
      expect(resultText).toBe('Fallback search results');
    });

    test('should handle OpenAI embedding errors', async () => {
      const embeddingError = new Error('Embedding generation failed');
      mockOpenAIClient.embeddings.create.mockRejectedValueOnce(embeddingError);
      
      const fallbackHandler = vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'Fallback search results' }]
      });
      
      const result = await searchTasksByContentTool.handler(
        { search_query: 'test query' },
        mockCache,
        vi.fn().mockResolvedValue(true),
        fallbackHandler
      );
      
      expect(fallbackHandler).toHaveBeenCalledWith(
        { search_query: 'test query' },
        mockCache
      );
      
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('[INFO] Recherche sémantique échouée')
      );
    });
  });

  describe('Enrichissement des résultats', () => {
    test('should include host identifier in results', async () => {
      const searchResults = [
        {
          id: 'result1',
          score: 0.95,
          payload: {
            task_id: 'task1',
            content: 'Test content',
            chunk_type: 'message_exchange',
            host_os: 'different-host'
          }
        }
      ];
      
      mockQdrantClient.search.mockResolvedValueOnce(searchResults);
      
      const result = await searchTasksByContentTool.handler(
        { search_query: 'test query' },
        mockCache,
        vi.fn().mockResolvedValue(true),
        vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'Fallback' }] })
      );
      
      const resultText = result.content[0].type === 'text' ? result.content[0].text : '';
      const parsedResult = JSON.parse(resultText);
      
      expect(parsedResult.current_machine).toMatchObject({
        host_id: 'test-host-123',
        search_timestamp: expect.any(String),
        query: 'test query',
        results_count: 1
      });
    });

    test('should provide cross-machine analysis', async () => {
      const searchResults = [
        {
          id: 'result1',
          score: 0.95,
          payload: {
            task_id: 'task1',
            content: 'Content from host A',
            host_os: 'host-a'
          }
        },
        {
          id: 'result2',
          score: 0.85,
          payload: {
            task_id: 'task2',
            content: 'Content from host B',
            host_os: 'host-b'
          }
        }
      ];
      
      mockQdrantClient.search.mockResolvedValueOnce(searchResults);
      
      const result = await searchTasksByContentTool.handler(
        { search_query: 'test query' },
        mockCache,
        vi.fn().mockResolvedValue(true),
        vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'Fallback' }] })
      );
      
      const resultText = result.content[0].type === 'text' ? result.content[0].text : '';
      const parsedResult = JSON.parse(resultText);
      
      expect(parsedResult.cross_machine_analysis).toMatchObject({
        machines_found: ['host-a', 'host-b'],
        results_by_machine: {
          'host-a': 1,
          'host-b': 1
        }
      });
    });
  });
});