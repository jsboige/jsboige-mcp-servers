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

// Mock du service task-indexer pour le host_id
const mockTaskIndexer = {
  getHostIdentifier: () => 'test-host-123'
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
  getHostIdentifier: mockTaskIndexer.getHostIdentifier
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
      collections: [{ name: 'roo_tasks_semantic_index_test' }]
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
      expect(searchTasksByContentTool.definition.inputSchema.properties.search_query).toBeDefined();
    });

    test('should have optional parameters', () => {
      expect(searchTasksByContentTool.definition.inputSchema.properties.conversation_id).toBeDefined();
      expect(searchTasksByContentTool.definition.inputSchema.properties.max_results).toBeDefined();
      expect(searchTasksByContentTool.definition.inputSchema.properties.diagnose_index).toBeDefined();
      expect(searchTasksByContentTool.definition.inputSchema.properties.workspace).toBeDefined();
    });
  });

  describe('Fonctionnalité de recherche sémantique', () => {
    test('should perform semantic search with query', async () => {
      // Configuration du mock
      mockQdrantClient.search.mockResolvedValue({
        points: [
          {
            id: 'test-point-1',
            score: 0.85,
            payload: {
              task_id: 'conv1',
              content: 'User message 1',
              chunk_id: 'chunk-1',
              chunk_type: 'message_exchange',
              workspace: 'test-workspace',
              task_title: 'Test Conversation 1',
              message_index: 1,
              total_messages: 5,
              role: 'user',
              timestamp: '2025-01-01T10:00:00Z',
              host_os: 'test-host-123'
            }
          }
        ]
      });

      const result = await searchTasksByContentTool.handler({
        search_query: 'test query'
      });

      expect(result.isError).toBe(false);
      expect(result.content).toBeDefined();
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content).toHaveLength(1);
      expect(result.content[0]).toMatchObject({
        taskId: 'conv1',
        score: 0.85,
        match: 'User message 1',
        metadata: {
          chunk_id: 'chunk-1',
          chunk_type: 'message_exchange',
          workspace: 'test-workspace',
          task_title: 'Test Conversation 1',
          message_index: 1,
          total_messages: 5,
          role: 'user',
          timestamp: '2025-01-01T10:00:00Z',
          host_os: 'test-host-123'
        }
      });
    });

    test('should filter by conversation_id when provided', async () => {
      // Configuration du mock
      mockQdrantClient.search.mockResolvedValue({
        points: [
          {
            id: 'test-point-1',
            score: 0.85,
            payload: {
              task_id: 'conv1',
              content: 'User message 1',
              chunk_id: 'chunk-1',
              chunk_type: 'message_exchange',
              workspace: 'test-workspace',
              task_title: 'Test Conversation 1',
              message_index: 1,
              total_messages: 5,
              role: 'user',
              timestamp: '2025-01-01T10:00:00Z',
              host_os: 'test-host-123'
            }
          }
        ]
      });

      const result = await searchTasksByContentTool.handler({
        search_query: 'test query',
        conversation_id: 'conv1'
      });

      // Vérifier que le filtre a été appliqué
      expect(mockQdrantClient.search).toHaveBeenCalledWith(
        'roo_tasks_semantic_index_test',
        expect.objectContaining({
          vector: expect.any(Array),
          limit: undefined,
          filter: {
            must: [
              {
                key: "task_id",
                match: {
                  value: "conv1"
                }
              }
            ]
          },
          with_payload: true
        })
      );
    });

    test('should filter by workspace when provided', async () => {
      // Configuration du mock
      mockQdrantClient.search.mockResolvedValue({
        points: [
          {
            id: 'test-point-1',
            score: 0.85,
            payload: {
              task_id: 'conv1',
              content: 'User message 1',
              chunk_id: 'chunk-1',
              chunk_type: 'message_exchange',
              workspace: 'test-workspace',
              task_title: 'Test Conversation 1',
              message_index: 1,
              total_messages: 5,
              role: 'user',
              timestamp: '2025-01-01T10:00:00Z',
              host_os: 'test-host-123'
            }
          }
        ]
      });

      const result = await searchTasksByContentTool.handler({
        search_query: 'test query',
        workspace: 'test-workspace'
      });

      // Vérifier que le filtre a été appliqué
      expect(mockQdrantClient.search).toHaveBeenCalledWith(
        'roo_tasks_semantic_index_test',
        expect.objectContaining({
          vector: expect.any(Array),
          limit: undefined,
          filter: {
            must: [
              {
                key: "workspace",
                match: {
                  value: "test-workspace"
                }
              }
            ]
          },
          with_payload: true
        })
      );
    });

    test('should respect max_results parameter', async () => {
      // Configuration du mock
      mockQdrantClient.search.mockResolvedValue({
        points: [
          {
            id: 'test-point-1',
            score: 0.85,
            payload: {
              task_id: 'conv1',
              content: 'User message 1',
              chunk_id: 'chunk-1',
              chunk_type: 'message_exchange',
              workspace: 'test-workspace',
              task_title: 'Test Conversation 1',
              message_index: 1,
              total_messages: 5,
              role: 'user',
              timestamp: '2025-01-01T10:00:00Z',
              host_os: 'test-host-123'
            }
          }
        ]
      });

      const result = await searchTasksByContentTool.handler({
        search_query: 'test query',
        max_results: 1
      });

      // Vérifier que le paramètre a été appliqué
      expect(mockQdrantClient.search).toHaveBeenCalledWith(
        'roo_tasks_semantic_index_test',
        expect.objectContaining({
          vector: expect.any(Array),
          limit: 1,
          filter: undefined,
          with_payload: true
        })
      );
    });
  });

  describe('Mode diagnostic', () => {
    test('should return diagnostic information when diagnose_index is true', async () => {
      // Configuration du mock pour le diagnostic
      mockQdrantClient.getCollections.mockResolvedValue({
        collections: [
          { name: 'roo_tasks_semantic_index_test', status: 'green' },
          { name: 'other_collection', status: 'yellow' }
        ]
      });

      mockQdrantClient.getCollection.mockResolvedValue({
        status: 'green',
        points_count: 1000,
        segments_count: 5,
        indexed_vectors_count: 950,
        optimizer_status: { error: 'ok' }
      });

      const result = await searchTasksByContentTool.handler({
        search_query: 'test query',
        diagnose_index: true
      });

      expect(result.isError).toBe(false);
      expect(result.content).toBeDefined();
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content).toHaveLength(1);
      
      const diagnosticContent = result.content[0];
      expect(diagnosticContent.type).toBe('text');
      expect(diagnosticContent.text).toContain('Diagnostic de l\'index sémantique:');
      expect(diagnosticContent.text).toContain('Collection: roo_tasks_semantic_index_test');
      expect(diagnosticContent.text).toContain('Existe: Oui');
      expect(diagnosticContent.text).toContain('Points: 1000');
      expect(diagnosticContent.text).toContain('Vérification nécessaire');
      expect(diagnosticContent.text).toContain('Cache local: 2 conversations');
    });

    test('should handle diagnostic errors gracefully', async () => {
      // Configuration du mock pour simuler une erreur
      mockQdrantClient.getCollections.mockRejectedValue(new Error('Qdrant connection failed'));

      const result = await searchTasksByContentTool.handler({
        search_query: 'test query',
        diagnose_index: true
      });

      expect(result.isError).toBe(true);
      expect(result.content).toBeDefined();
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content).toHaveLength(1);
      
      const errorContent = result.content[0];
      expect(errorContent.type).toBe('text');
      expect(errorContent.text).toContain('Erreur lors du diagnostic:');
      expect(errorContent.text).toContain('Qdrant connection failed');
    });
  });

  describe('Gestion des erreurs et fallback', () => {
    test('should fallback to text search on semantic error', async () => {
      // Configuration du mock pour simuler une erreur sémantique
      mockQdrantClient.search.mockRejectedValue(new Error('Semantic search failed'));

      // Configuration du mock pour que le cache retourne des résultats
      mockCache = createMockCache();

      const result = await searchTasksByContentTool.handler({
        search_query: 'test query'
      });

      expect(result.isError).toBe(false);
      expect(result.content).toBeDefined();
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content).toHaveLength(2); // conv1 et conv2 du cache
      
      // Vérifier que la recherche textuelle a été utilisée
      expect(result.content[0]).toMatchObject({
        taskId: 'conv1',
        score: expect.any(Number),
        match: expect.stringContaining('User message 1'),
        metadata: expect.objectContaining({
          task_title: 'Test Conversation 1'
        })
      });
    });

    test('should handle OpenAI embedding errors', async () => {
      // Configuration du mock pour simuler une erreur OpenAI
      mockOpenAIClient.embeddings.create.mockRejectedValue(new Error('OpenAI API error'));

      const result = await searchTasksByContentTool.handler({
        search_query: 'test query'
      });

      expect(result.isError).toBe(true);
      expect(result.content).toBeDefined();
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content).toHaveLength(1);
      
      const errorContent = result.content[0];
      expect(errorContent.type).toBe('text');
      expect(errorContent.text).toContain('Erreur lors de la recherche sémantique:');
      expect(errorContent.text).toContain('OpenAI API error');
    });
  });

  describe('Enrichissement des résultats', () => {
    test('should include host identifier in results', async () => {
      // Configuration du mock
      mockQdrantClient.search.mockResolvedValue({
        points: [
          {
            id: 'test-point-1',
            score: 0.85,
            payload: {
              task_id: 'conv1',
              content: 'User message 1',
              chunk_id: 'chunk-1',
              chunk_type: 'message_exchange',
              workspace: 'test-workspace',
              task_title: 'Test Conversation 1',
              message_index: 1,
              total_messages: 5,
              role: 'user',
              timestamp: '2025-01-01T10:00:00Z',
              host_os: 'test-host-123'
            }
          }
        ]
      });

      const result = await searchTasksByContentTool.handler({
        search_query: 'test query'
      });

      expect(result.isError).toBe(false);
      expect(result.content).toBeDefined();
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content).toHaveLength(1);
      
      const searchResult = result.content[0];
      expect(searchResult).toHaveProperty('current_machine');
      expect(searchResult.current_machine).toHaveProperty('host_id');
      expect(searchResult.current_machine.host_id).toBe('test-host-123');
      expect(searchResult.current_machine).toHaveProperty('search_timestamp');
      expect(searchResult.current_machine).toHaveProperty('query');
      expect(searchResult.current_machine).toHaveProperty('results_count');
      expect(searchResult.current_machine.results_count).toBe(1);
    });

    test('should provide cross-machine analysis', async () => {
      // Configuration du mock avec différentes machines
      mockQdrantClient.search.mockResolvedValue({
        points: [
          {
            id: 'test-point-1',
            score: 0.85,
            payload: {
              task_id: 'conv1',
              content: 'User message 1',
              chunk_id: 'chunk-1',
              chunk_type: 'message_exchange',
              workspace: 'test-workspace',
              task_title: 'Test Conversation 1',
              message_index: 1,
              total_messages: 5,
              role: 'user',
              timestamp: '2025-01-01T10:00:00Z',
              host_os: 'windows-x64-1'
            }
          },
          {
            id: 'test-point-2',
            score: 0.75,
            payload: {
              task_id: 'conv2',
              content: 'Another test message',
              chunk_id: 'chunk-2',
              chunk_type: 'message_exchange',
              workspace: 'test-workspace',
              task_title: 'Test Conversation 2',
              message_index: 1,
              total_messages: 3,
              role: 'user',
              timestamp: '2025-01-02T15:30:00Z',
              host_os: 'linux-arm64-2'
            }
          }
        ]
      });

      const result = await searchTasksByContentTool.handler({
        search_query: 'test query'
      });

      expect(result.isError).toBe(false);
      expect(result.content).toBeDefined();
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content).toHaveLength(1);
      
      const searchResult = result.content[0];
      expect(searchResult).toHaveProperty('cross_machine_analysis');
      expect(searchResult.cross_machine_analysis).toHaveProperty('machines_found');
      expect(searchResult.cross_machine_analysis.machines_found).toEqual(['windows-x64-1', 'linux-arm64-2']);
      expect(searchResult.cross_machine_analysis).toHaveProperty('results_by_machine');
      expect(searchResult.cross_machine_analysis.results_by_machine).toEqual({
        'windows-x64-1': 1,
        'linux-arm64-2': 1
      });
    });
  });
});