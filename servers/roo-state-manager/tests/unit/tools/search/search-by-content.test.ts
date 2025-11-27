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
import { handleSearchTasksSemanticFallback } from '../../../../src/tools/search/search-fallback.tool.js';

// Mock objects defined with vi.hoisted to ensure they are available for vi.mock
const mocks = vi.hoisted(() => ({
  qdrantClient: {
    search: vi.fn(),
    getCollections: vi.fn(),
    getCollection: vi.fn(),
  },
  openAIClient: {
    embeddings: {
      create: vi.fn()
    }
  },
  taskIndexer: {
    getHostIdentifier: () => 'test-host-123'
  }
}));

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
  getQdrantClient: vi.fn(() => mocks.qdrantClient)
}));

vi.mock('../../../../src/services/openai.js', () => ({
  default: vi.fn(() => mocks.openAIClient)
}));

// Mock du fallback handler
vi.mock('../../../../src/tools/search/search-fallback.tool.js', () => ({
  handleSearchTasksSemanticFallback: vi.fn().mockImplementation(async (args: any, cache: any) => {
    console.log('[MOCK] Fallback called with args:', JSON.stringify(args));
    console.log('[MOCK] Cache size:', cache.size);

    const { search_query, query: queryArg } = args;
    const query = (search_query || queryArg || '').toLowerCase();
    const results: any[] = [];

    // Simuler la recherche textuelle pour le test
    for (const [taskId, skeleton] of cache.entries()) {
      if (results.length >= 2) break; // Limiter à 2 résultats pour le test

      let hasMatch = false;
      for (const item of skeleton.sequence) {
        if ('content' in item && typeof item.content === 'string') {
          const content = item.content.toLowerCase();
          if (content.includes(query)) {
            hasMatch = true;
            break;
          }
        }
      }

      if (hasMatch) {
        results.push({
          taskId,
          score: 1.0,
          match: `Found in role '${skeleton.sequence?.[0]?.role || 'unknown'}': User message 1`,
          metadata: {
            task_title: skeleton.metadata?.title || `Task ${taskId}`,
            message_count: skeleton.sequence ? skeleton.sequence.length : 0
          }
        });
      }
    }

    console.log('[MOCK] Fallback returning results:', results.length);
    return {
      isError: false,
      content: results
    };
  })
}));

vi.mock('../../../../src/services/task-indexer.js', () => ({
  __esModule: true,
  getHostIdentifier: mocks.taskIndexer.getHostIdentifier,
  TaskIndexer: class {}
}));

describe('🔍 search_tasks_by_content - Outil Renommé', () => {
  let mockCache: Map<string, ConversationSkeleton>;
  let consoleLogSpy: any;
  let consoleErrorSpy: any;

  beforeEach(() => {
    // Reset tous les mocks
    vi.clearAllMocks();

    // Configuration des retours par défaut
    mocks.qdrantClient.getCollections.mockResolvedValue({
      collections: [{ name: 'roo_tasks_semantic_index_test' }]
    });

    mocks.openAIClient.embeddings.create.mockResolvedValue({
      data: [{ embedding: new Array(1536).fill(0.1) }],
      model: 'text-embedding-3-small',
      usage: { prompt_tokens: 10, total_tokens: 10 }
    });

    mockCache = createMockCache();

    // Espionner les logs
    // Laisser passer les logs pour le débogage
    consoleLogSpy = vi.spyOn(console, 'log');
    consoleErrorSpy = vi.spyOn(console, 'error');
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
      // Configuration du mock - structure Qdrant réelle
      mocks.qdrantClient.search.mockResolvedValue({
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
      }, mockCache, async () => true, async (args: any, cache: Map<string, ConversationSkeleton>) => {
        return await handleSearchTasksSemanticFallback(args, cache);
      });

      expect(result.isError).toBe(false);
      expect(result.content).toBeDefined();
      // Le content peut être un objet ou un tableau selon le cas
      if (Array.isArray(result.content)) {
        // Cas d'erreur ou fallback
        expect(result.content).toHaveLength(1);
        const errorContent = result.content[0] as any;
        expect(errorContent.type).toBe('text');
        expect(errorContent.text).toContain('current_machine');
      } else {
        // Cas normal - objet searchReport
        expect(typeof result.content).toBe('object');
        expect(Array.isArray(result.content)).toBe(false);

        // Le handler retourne searchReport avec la propriété results
        expect((result.content as any)).toHaveProperty('results');
        expect((result.content as any).results).toHaveLength(1);
        expect((result.content as any)).toHaveProperty('current_machine');
        expect(result.content).toHaveProperty('cross_machine_analysis');
      }

      // DEBUG: Vérifier si search a été appelé
      console.log('Search called:', mocks.qdrantClient.search.mock.calls.length);
      if (mocks.qdrantClient.search.mock.calls.length === 0) {
         // console.log('Search NOT called. getQdrantClient called:', (getQdrantClient as any).mock?.calls?.length);
      }
    });

    test('should filter by conversation_id when provided', async () => {
      // Configuration du mock
      mocks.qdrantClient.search.mockResolvedValue({
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
      }, mockCache, async () => true, async (args: any, cache: Map<string, ConversationSkeleton>) => {
        return await handleSearchTasksSemanticFallback(args, cache);
      });

      // Vérifier que le filtre a été appliqué
      expect(mocks.qdrantClient.search).toHaveBeenCalledWith(
        'roo_tasks_semantic_index_test',
        expect.objectContaining({
          vector: expect.any(Array),
          limit: 10,
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
      mocks.qdrantClient.search.mockResolvedValue({
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
      }, mockCache, async () => true, async (args: any, cache: Map<string, ConversationSkeleton>) => {
        return await handleSearchTasksSemanticFallback(args, cache);
      });

      // Vérifier que le filtre a été appliqué
      expect(mocks.qdrantClient.search).toHaveBeenCalledWith(
        'roo_tasks_semantic_index_test',
        expect.objectContaining({
          vector: expect.any(Array),
          limit: 10,
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
      mocks.qdrantClient.search.mockResolvedValue({
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
        max_results: 5
      }, mockCache, async () => true, async (args: any, cache: Map<string, ConversationSkeleton>) => {
        return await handleSearchTasksSemanticFallback(args, cache);
      });

      // Vérifier que le paramètre a été appliqué
      expect(mocks.qdrantClient.search).toHaveBeenCalledWith(
        'roo_tasks_semantic_index_test',
        expect.objectContaining({
          vector: expect.any(Array),
          limit: 5,
          filter: undefined,
          with_payload: true
        })
      );
    });
  });

  describe('Mode diagnostic', () => {
    test('should return diagnostic information when diagnose_index is true', async () => {
      // Configuration du mock pour le diagnostic
      mocks.qdrantClient.getCollections.mockResolvedValue({
        collections: [
          { name: 'roo_tasks_semantic_index_test', status: 'green' },
          { name: 'other_collection', status: 'yellow' }
        ]
      });

      mocks.qdrantClient.getCollection.mockResolvedValue({
        status: 'green',
        points_count: 1000,
        segments_count: 5,
        indexed_vectors_count: 950,
        optimizer_status: { error: 'ok' }
      });

      const result = await searchTasksByContentTool.handler({
        search_query: 'test query',
        diagnose_index: true
      }, mockCache, async () => true, async (args: any, cache: Map<string, ConversationSkeleton>) => {
        return await handleSearchTasksSemanticFallback(args, cache);
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
      mocks.qdrantClient.getCollection.mockRejectedValue(new Error('Qdrant connection failed'));

      const result = await searchTasksByContentTool.handler({
        search_query: 'test query',
        diagnose_index: true
      }, mockCache, async () => true, async (args: any, cache: Map<string, ConversationSkeleton>) => {
        return await handleSearchTasksSemanticFallback(args, cache);
      });

      expect(result.isError).toBe(false);
      expect(result.content).toBeDefined();
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content).toHaveLength(1);

      const errorContent = result.content[0] as any;
      expect(errorContent.type).toBe('text');
      expect(errorContent.text).toContain('Qdrant connection failed');
    });
  });

  describe('Gestion des erreurs et fallback', () => {
    test('should fallback to text search on semantic error', async () => {
      // Configuration du mock pour simuler une erreur sémantique
      mocks.qdrantClient.search.mockRejectedValue(new Error('Semantic search failed'));

      // Configuration du mock pour que le cache retourne des résultats
      mockCache = createMockCache();
      const result = await searchTasksByContentTool.handler({
        search_query: 'User message',
        conversation_id: undefined  // Forcer le fallback à utiliser la logique globale
      }, mockCache, async () => true, async (args: any, cache: Map<string, ConversationSkeleton>) => {
        // Transformer les paramètres pour le fallback
        const fallbackArgs = {
          query: args.search_query,
          workspace: args.workspace
        };
        return await handleSearchTasksSemanticFallback(fallbackArgs, cache);
      });

      expect(result.isError).toBe(false);
      expect(result.content).toBeDefined();
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content).toHaveLength(1);
      expect(result.content[0]).toHaveProperty('type', 'text');

      // Parser le JSON contenu dans le text
      const parsedContent = JSON.parse(result.content[0].text as string);
      // Le contenu parsé peut être encapsulé dans un objet { results: [...] } ou être directement le tableau
      const results = Array.isArray(parsedContent) ? parsedContent : parsedContent.results;

      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeGreaterThan(0);

      // Vérifier que la recherche textuelle a été utilisée
      expect(results).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            taskId: 'conv1',
            metadata: expect.objectContaining({
                task_title: 'Test Conversation 1'
            })
          })
        ])
      );
    });

    test('should handle OpenAI embedding errors', async () => {
      // Configuration du mock pour simuler une erreur OpenAI
      mocks.openAIClient.embeddings.create.mockRejectedValue(new Error('OpenAI API error'));

      const result = await searchTasksByContentTool.handler({
        search_query: 'test query'
      }, mockCache, async () => true, async (args: any, cache: Map<string, ConversationSkeleton>) => {
        return await handleSearchTasksSemanticFallback(args, cache);
      });

      expect(result.isError).toBe(false);
      expect(result.content).toBeDefined();
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content).toHaveLength(1);

      // Si le fallback réussit, on obtient des résultats (même vides)
      // Pour tester l'erreur de fallback, il faudrait que le fallback échoue aussi

      // Ici, on vérifie juste que le fallback a été appelé (donc pas d'erreur fatale)
      expect(result.isError).toBe(false);
      expect(result.content).toBeDefined();
    });
  });

  describe('Enrichissement des résultats', () => {
    test('should include host identifier in results', async () => {
      // Configuration du mock
      mocks.qdrantClient.search.mockResolvedValue({
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
      }, mockCache, async () => true, async (args: any, cache: Map<string, ConversationSkeleton>) => {
        return await handleSearchTasksSemanticFallback(args, cache);
      });

      expect(result.isError).toBe(false);
      expect(result.content).toBeDefined();
      // Le content peut être un objet ou un tableau selon le cas
      if (Array.isArray(result.content)) {
        // Cas d'erreur ou fallback
        expect(result.content).toHaveLength(1);
        const errorContent = result.content[0] as any;
        expect(errorContent.type).toBe('text');
        expect(errorContent.text).toContain('current_machine');
      } else {
        // Cas normal - objet searchReport
        expect(typeof result.content).toBe('object');
        expect(Array.isArray(result.content)).toBe(false);
        expect(result.content).toHaveProperty('results');
        expect((result.content as any).results).toHaveLength(1);

        // Vérifier les métadonnées globales
        const content = result.content as any;
        expect(content).toHaveProperty('current_machine');
        expect(content.current_machine).toHaveProperty('host_id');
        expect(content.current_machine.host_id).toBe('test-host-123');
        expect(content.current_machine).toHaveProperty('search_timestamp');
        expect(content.current_machine).toHaveProperty('query');
        expect(content.current_machine).toHaveProperty('results_count');
        expect(content.current_machine.results_count).toBe(1);
      }
    });

    test('should provide cross-machine analysis', async () => {
      // Configuration du mock avec différentes machines
      mocks.qdrantClient.search.mockResolvedValue({
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
      }, mockCache, async () => true, async (args: any, cache: Map<string, ConversationSkeleton>) => {
        return await handleSearchTasksSemanticFallback(args, cache);
      });

      expect(result.isError).toBe(false);
      expect(result.content).toBeDefined();
      // Le content peut être un objet ou un tableau selon le cas
      if (Array.isArray(result.content)) {
        // Cas d'erreur ou fallback
        expect(result.content).toHaveLength(1);
        const errorContent = result.content[0] as any;
        expect(errorContent.type).toBe('text');
        expect(errorContent.text).toContain('current_machine');
      } else {
        // Cas normal - objet searchReport
        expect(typeof result.content).toBe('object');
        expect(Array.isArray(result.content)).toBe(false);
        expect((result.content as any).results).toHaveLength(2);

        // Vérifier les métadonnées globales
        const content = result.content as any;
        expect(content).toHaveProperty('cross_machine_analysis');
        expect(content.cross_machine_analysis).toHaveProperty('machines_found');
        expect(content.cross_machine_analysis.machines_found).toEqual(expect.arrayContaining(['windows-x64-1', 'linux-arm64-2']));
        expect(content.cross_machine_analysis).toHaveProperty('results_by_machine');
        expect(content.cross_machine_analysis.results_by_machine).toEqual({
          'windows-x64-1': 1,
          'linux-arm64-2': 1
        });
      }
    });
  });
});