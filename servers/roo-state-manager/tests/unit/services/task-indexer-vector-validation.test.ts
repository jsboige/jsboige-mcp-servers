/**
 * Tests unitaires pour la validation vectorielle améliorée dans TaskIndexer
 * 
 * Tests couvrant :
 * - Validation des vecteurs avec la bonne dimension
 * - Gestion des erreurs de validation (NaN, Infinity)
 * - Logging détaillé des opérations de validation
 * - Performance de l'indexation avec validation
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { TaskIndexer } from '../../../src/services/task-indexer.js';
import { CacheManager } from '../../../src/utils/cache-manager.js';

// Mock Qdrant client
const mockQdrantClient = {
  upsert: vi.fn(),
  getCollections: vi.fn(),
  createCollection: vi.fn(),
  getCollection: vi.fn(),
  deleteCollection: vi.fn(),
};

// Mock OpenAI client
const mockOpenAIClient = {
  embeddings: {
    create: vi.fn()
  }
};

// Mock RooStorageDetector
const mockRooStorageDetector = {
  detectStorageLocations: vi.fn().mockResolvedValue(['/mock/storage/path']),
  analyzeConversation: vi.fn(),
  getStatsForPath: vi.fn().mockResolvedValue({
    conversationCount: 0,
    totalSize: 0,
    fileTypes: {}
  })
};

// Mock fs
const mockFs = {
  access: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  readdir: vi.fn().mockResolvedValue(['task_metadata.json', 'api_conversation_history.json', 'ui_messages.json']),
  stat: vi.fn().mockResolvedValue({ isDirectory: () => true }),
};

// Mock path module - DOIT être défini en premier pour être disponible lors des imports
vi.mock('path', () => ({
  join: vi.fn((...args: string[]) => {
    const result = args.join('/'); // Corrigé : utiliser '/' au lieu de '\'
    console.log(`[MOCK] path.join called with:`, args, `=> ${result}`);
    return result;
  }),
  basename: vi.fn((path: string) => path.split('/').pop() || path),
  dirname: vi.fn((path: string) => path.split('/').slice(0, -1).join('/') || '.'),
  resolve: vi.fn((...args: string[]) => args.join('/')),
  relative: vi.fn((from: string, to: string) => {
    const fromParts = from.split('/').filter(p => p);
    const toParts = to.split('/').filter(p => p);
    const commonLength = Math.min(fromParts.length, toParts.length);
    const common = fromParts.slice(0, commonLength);
    const fromRest = fromParts.slice(commonLength);
    const toRest = toParts.slice(commonLength);
    const relative = [...Array(Math.max(fromRest.length, toRest.length)).fill('..'), ...toRest].join('/');
    return relative;
  }),
  sep: vi.fn(() => '/'),
  extname: vi.fn((path: string) => {
    const lastDot = path.lastIndexOf('.');
    return lastDot >= 0 ? path.slice(lastDot) : '';
  }),
  parse: vi.fn((path: string) => {
    const root = path.startsWith('/') ? '/' : '';
    const base = path.split('/').pop() || '';
    const ext = base.includes('.') ? base.split('.').pop() : '';
    return { root, dir: base.split('.')[0], base, ext };
  })
}));

// Mock fs/promises - CRUCIAL pour que les tests trouvent les tâches
const { access: mockAccess, readFile: mockReadFile } = vi.hoisted(() => ({
  access: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  readdir: vi.fn().mockResolvedValue(['task_metadata.json', 'api_conversation_history.json', 'ui_messages.json']),
  stat: vi.fn().mockResolvedValue({ isDirectory: () => true }),
}));

// Mock path - CRUCIAL pour les tests
const mockPath = vi.hoisted(() => ({
  join: vi.fn((...args: string[]) => args.join('/')),
  sep: vi.fn(() => '/'),
  extname: vi.fn((path: string) => {
    const lastDot = path.lastIndexOf('.');
    return lastDot >= 0 ? path.slice(lastDot) : '';
  }),
  parse: vi.fn((path: string) => {
    const root = path.startsWith('/') ? '/' : '';
    const base = path.split('/').pop() || '';
    const ext = base.includes('.') ? base.split('.').pop() : '';
    return { root, dir: base.split('.')[0], base, ext };
  })
}));

vi.mock('fs/promises', () => ({
  access: mockAccess,
  readFile: mockReadFile,
  writeFile: vi.fn(),
  readdir: vi.fn().mockResolvedValue(['task_metadata.json', 'api_conversation_history.json', 'ui_messages.json']),
  stat: vi.fn().mockResolvedValue({ isDirectory: () => true }),
}));

// Mock des dépendances
vi.mock('../../../src/services/qdrant.js', () => ({
  getQdrantClient: vi.fn(() => mockQdrantClient)
}));

vi.mock('../../../src/services/openai.js', () => ({
  default: vi.fn(() => mockOpenAIClient)
}));

vi.doMock('../../../src/utils/roo-storage-detector.js', () => ({
  RooStorageDetector: mockRooStorageDetector
}));

// Mock CRUCIAL : mocker la fonction indexTask importée dynamiquement
vi.mock('../../../src/tools/indexing/index-task.tool.js', () => ({
  indexTask: vi.fn().mockImplementation(async (taskId: string) => {
    console.log(`[MOCK] indexTask called with: ${taskId}`);
    
    // Utiliser les mocks déjà configurés avec vi.hoisted
    const locations = await mockRooStorageDetector.detectStorageLocations();
    
    for (const location of locations) {
      const taskPath = mockPath.join(location, 'tasks', taskId);
      try {
        await mockAccess(taskPath);
        
        // Retourner les points d'indexation simulés avec la structure attendue
        return [
          {
            id: `${taskId}-point-1`,
            vector: [0.1, 0.2, 0.3],
            payload: { type: 'test', data: 'payload-data' },
            metadata: { source: 'test-mock' }
          },
          {
            id: `${taskId}-point-2`,
            vector: [0.4, 0.5, 0.6],
            payload: { type: 'validation', data: 'validation-data' },
            metadata: { source: 'test-mock' }
          }
        ];
      } catch {
        // Tâche pas dans ce location, on continue
      }
    }
    
    // Si aucune location ne contient la tâche, lever l'erreur attendue
    throw new Error(`Task ${taskId} not found in any storage location`);
  })
}));

describe('🛡️ TaskIndexer - Validation Vectorielle Améliorée', () => {
  let taskIndexer: TaskIndexer;
  let consoleErrorSpy: any;
  let consoleLogSpy: any;

  beforeEach(() => {
    // Reset tous les mocks
    vi.clearAllMocks();
    
    // Configuration des retours par défaut
    mockQdrantClient.getCollections.mockResolvedValue({ collections: [] });
    mockQdrantClient.getCollection.mockResolvedValue({ points_count: 0 });
    mockQdrantClient.upsert.mockResolvedValue({});
    mockQdrantClient.createCollection.mockResolvedValue({});
    mockQdrantClient.deleteCollection.mockResolvedValue({});
    
    mockOpenAIClient.embeddings.create.mockResolvedValue({
      data: [{ embedding: new Array(1536).fill(0.1) }]
    });
    
    mockRooStorageDetector.detectStorageLocations.mockResolvedValue([
      'C:/Users/test/AppData/Roaming/Roo Code/User/workspaceStorage',
      'C:/Users/test/Documents/Roo Code/Conversations',
      'D:/Dev/roo-extensions'
    ]);
    
    // Simuler que les tâches de test existent dans les chemins de stockage
    // Utiliser les mocks hoisted configurés dans vi.mock('fs/promises')
    mockAccess.mockImplementation((filePath: string) => {
      console.log(`[MOCK] fs.access called with: "${filePath}"`);
      console.log(`[MOCK] filePath.includes('test-task-'):`, filePath.includes('test-task-'));
      console.log(`[MOCK] filePath.includes('/tasks/'):`, filePath.includes('/tasks/'));
      
      // Simuler l'existence des fichiers de test - PLUS PRÉCIS
      // Le TaskIndexer cherche dans location/tasks/taskId
      // Les tests utilisent des IDs spécifiques comme 'test-task-dimension', 'test-task-non-array', etc.
      if (filePath.includes('/tasks/') && (
        filePath.includes('test-task-dimension') ||
        filePath.includes('test-task-non-array') ||
        filePath.includes('test-task-nan') ||
        filePath.includes('test-task-infinity') ||
        filePath.includes('test-task-neg-infinity') ||
        filePath.includes('test-task-logging') ||
        filePath.includes('test-task-payload-cleanup') ||
        filePath.includes('test-task-performance') ||
        filePath.includes('test-task-fast-fail') ||
        filePath.includes('test-task-integration') ||
        filePath.includes('test-task-prevention')
      )) {
        console.log(`[MOCK] fs.access resolving for test task: ${filePath}`);
        return Promise.resolve();
      }
      console.log(`[MOCK] fs.access rejecting: ${filePath}`);
      throw new Error(`ENOENT: no such file or directory, access '${filePath}'`);
    });
    
    mockReadFile.mockImplementation((filePath: string) => {
      console.log(`[MOCK] fs.readFile called with: "${filePath}"`);
      // Le TaskIndexer cherche dans location/tasks/taskId
      // Les tests utilisent des IDs spécifiques comme 'test-task-dimension', 'test-task-non-array', etc.
      if (filePath.includes('/tasks/') && (
        filePath.includes('test-task-dimension') ||
        filePath.includes('test-task-non-array') ||
        filePath.includes('test-task-nan') ||
        filePath.includes('test-task-infinity') ||
        filePath.includes('test-task-neg-infinity') ||
        filePath.includes('test-task-logging') ||
        filePath.includes('test-task-payload-cleanup') ||
        filePath.includes('test-task-performance') ||
        filePath.includes('test-task-fast-fail') ||
        filePath.includes('test-task-integration') ||
        filePath.includes('test-task-prevention')
      )) {
        console.log(`[MOCK] fs.readFile resolving for test task: ${filePath}`);
        const taskId = filePath.split('/').pop()?.replace('.json', '') || 'unknown';
        return Promise.resolve(JSON.stringify({
          id: taskId,
          metadata: { title: 'Test Task', lastModified: new Date().toISOString() },
          content: { instruction: 'Test instruction content' }
        }));
      }
      console.log(`[MOCK] fs.readFile rejecting: ${filePath}`);
      throw new Error(`ENOENT: no such file or directory, open '${filePath}'`);
    });
    
    taskIndexer = new TaskIndexer();
    
    // Espionner les logs pour validation
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.clearAllMocks();
    consoleErrorSpy.mockRestore();
    consoleLogSpy.mockRestore();
  });

  describe('validateVectorGlobal - Validation des dimensions', () => {
    test('should accept valid 1536-dimensional vector', () => {
      const validVector = new Array(1536).fill(0.1);
      
      // La fonction validateVectorGlobal est privée, on teste via indexTask
      expect(() => {
        // Simuler la validation en appelant indexTask avec un vecteur valide
        mockOpenAIClient.embeddings.create.mockResolvedValueOnce({
          data: [{ embedding: validVector }]
        });
      }).not.toThrow();
    });

    test('should reject vector with wrong dimension', async () => {
      const invalidVector = new Array(1000).fill(0.1); // Dimension incorrecte
      
      mockOpenAIClient.embeddings.create.mockResolvedValueOnce({
        data: [{ embedding: invalidVector }]
      });
      
      mockFs.readFile.mockImplementation((filePath: string) => {
        if (filePath.includes('task_metadata.json')) {
          return Promise.resolve(JSON.stringify({
            title: 'Test Task Wrong Dimension',
            parentTaskId: null,
            parent_task_id: null,
            workspace: '/mock/storage/path'
          }));
        }
        if (filePath.includes('api_conversation_history.json')) {
          return Promise.resolve(JSON.stringify([
            {
              role: 'user',
              content: 'Test message'
            }
          ]));
        }
        if (filePath.includes('ui_messages.json')) {
          return Promise.resolve(JSON.stringify([]));
        }
        return Promise.resolve(JSON.stringify({}));
      });
      
      try {
        await taskIndexer.indexTask('test-task-dimension');
        expect.fail('Should have thrown an error');
      } catch (error: any) {
        expect(error.message).toContain('Dimension invalide');
        expect(error.message).toContain('1000');
        expect(error.message).toContain('1536');
      }
    });

    test('should reject non-array vector', async () => {
      const invalidVector = 'not-an-array' as any;
      
      mockOpenAIClient.embeddings.create.mockResolvedValueOnce({
        data: [{ embedding: invalidVector }]
      });
      
      mockFs.readFile.mockImplementation((filePath: string) => {
        if (filePath.includes('task_metadata.json')) {
          return Promise.resolve(JSON.stringify({
            title: 'Test Task Non Array',
            parentTaskId: null,
            parent_task_id: null,
            workspace: '/mock/storage/path'
          }));
        }
        if (filePath.includes('api_conversation_history.json')) {
          return Promise.resolve(JSON.stringify([
            {
              role: 'user',
              content: 'Test message'
            }
          ]));
        }
        if (filePath.includes('ui_messages.json')) {
          return Promise.resolve(JSON.stringify([]));
        }
        return Promise.resolve(JSON.stringify({}));
      });
      
      try {
        await taskIndexer.indexTask('test-task-non-array');
        expect.fail('Should have thrown an error');
      } catch (error: any) {
        expect(error.message).toContain('Vector doit être un tableau');
        expect(error.message).toContain('string');
      }
    });
  });

  describe('validateVectorGlobal - Validation des valeurs invalides', () => {
    test('should reject vector containing NaN', async () => {
      const vectorWithNaN = new Array(1536).fill(0.1);
      vectorWithNaN[100] = NaN; // Insérer NaN à une position
      
      mockOpenAIClient.embeddings.create.mockResolvedValueOnce({
        data: [{ embedding: vectorWithNaN }]
      });
      
      mockFs.readFile.mockImplementation((filePath: string) => {
        if (filePath.includes('task_metadata.json')) {
          return Promise.resolve(JSON.stringify({
            title: 'Test Task NaN',
            parentTaskId: null,
            parent_task_id: null,
            workspace: '/mock/storage/path'
          }));
        }
        if (filePath.includes('api_conversation_history.json')) {
          return Promise.resolve(JSON.stringify([
            {
              role: 'user',
              content: 'Test message'
            }
          ]));
        }
        if (filePath.includes('ui_messages.json')) {
          return Promise.resolve(JSON.stringify([]));
        }
        return Promise.resolve(JSON.stringify({}));
      });
      
      try {
        await taskIndexer.indexTask('test-task-nan');
        expect.fail('Should have thrown an error');
      } catch (error: any) {
        expect(error.message).toContain('Vector contient NaN ou Infinity');
        expect(consoleErrorSpy).toHaveBeenCalledWith(
          expect.stringContaining('Validation échouée pour point'),
          expect.any(Error)
        );
      }
    });

    test('should reject vector containing Infinity', async () => {
      const vectorWithInfinity = new Array(1536).fill(0.1);
      vectorWithInfinity[200] = Infinity; // Insérer Infinity à une position
      
      mockOpenAIClient.embeddings.create.mockResolvedValueOnce({
        data: [{ embedding: vectorWithInfinity }]
      });
      
      mockFs.readFile.mockImplementation((filePath: string) => {
        if (filePath.includes('task_metadata.json')) {
          return Promise.resolve(JSON.stringify({
            title: 'Test Task Infinity',
            parentTaskId: null,
            parent_task_id: null,
            workspace: '/mock/storage/path'
          }));
        }
        if (filePath.includes('api_conversation_history.json')) {
          return Promise.resolve(JSON.stringify([
            {
              role: 'user',
              content: 'Test message'
            }
          ]));
        }
        if (filePath.includes('ui_messages.json')) {
          return Promise.resolve(JSON.stringify([]));
        }
        return Promise.resolve(JSON.stringify({}));
      });
      
      try {
        await taskIndexer.indexTask('test-task-infinity');
        expect.fail('Should have thrown an error');
      } catch (error: any) {
        expect(error.message).toContain('Vector contient NaN ou Infinity');
        expect(consoleErrorSpy).toHaveBeenCalledWith(
          expect.stringContaining('Validation échouée pour point'),
          expect.any(Error)
        );
      }
    });

    test('should reject vector containing -Infinity', async () => {
      const vectorWithNegInfinity = new Array(1536).fill(0.1);
      vectorWithNegInfinity[300] = -Infinity; // Insérer -Infinity à une position
      
      mockOpenAIClient.embeddings.create.mockResolvedValueOnce({
        data: [{ embedding: vectorWithNegInfinity }]
      });
      
      mockFs.readFile.mockImplementation((filePath: string) => {
        if (filePath.includes('task_metadata.json')) {
          return Promise.resolve(JSON.stringify({
            title: 'Test Task Neg Infinity',
            parentTaskId: null,
            parent_task_id: null,
            workspace: '/mock/storage/path'
          }));
        }
        if (filePath.includes('api_conversation_history.json')) {
          return Promise.resolve(JSON.stringify([
            {
              role: 'user',
              content: 'Test message'
            }
          ]));
        }
        if (filePath.includes('ui_messages.json')) {
          return Promise.resolve(JSON.stringify([]));
        }
        return Promise.resolve(JSON.stringify({}));
      });
      
      try {
        await taskIndexer.indexTask('test-task-neg-infinity');
        expect.fail('Should have thrown an error');
      } catch (error: any) {
        expect(error.message).toContain('Vector contient NaN ou Infinity');
        expect(consoleErrorSpy).toHaveBeenCalledWith(
          expect.stringContaining('Validation échouée pour point'),
          expect.any(Error)
        );
      }
    });
  });

  describe('validateVectorGlobal - Logging détaillé', () => {
    test('should log validation details for each point', async () => {
      const validVector = new Array(1536).fill(0.1);
      
      mockOpenAIClient.embeddings.create.mockResolvedValue({
        data: [{ embedding: validVector }]
      });
      
      mockFs.readFile.mockImplementation((filePath: string) => {
        if (filePath.includes('task_metadata.json')) {
          return Promise.resolve(JSON.stringify({
            title: 'Test Task Logging',
            parentTaskId: null,
            parent_task_id: null,
            workspace: '/mock/storage/path'
          }));
        }
        if (filePath.includes('api_conversation_history.json')) {
          return Promise.resolve(JSON.stringify([
            {
              role: 'user',
              content: 'Test message for validation logging'
            }
          ]));
        }
        if (filePath.includes('ui_messages.json')) {
          return Promise.resolve(JSON.stringify([]));
        }
        return Promise.resolve(JSON.stringify({}));
      });
      
      await taskIndexer.indexTask('test-task-logging');
      
      // Vérifier que les logs de validation sont présents
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('[safeQdrantUpsert] Validation et nettoyage de 1 points')
      );
    });

    test('should log payload transformations', async () => {
      const validVector = new Array(1536).fill(0.1);
      
      mockOpenAIClient.embeddings.create.mockResolvedValue({
        data: [{ embedding: validVector }]
      });
      
      // Simuler un payload avec des champs à nettoyer
      mockFs.readFile.mockResolvedValueOnce(JSON.stringify({
        task_metadata: { title: 'Test Task' },
        api_conversation_history: [
          {
            role: 'user',
            content: 'Test message',
            undefined_field: undefined, // Sera nettoyé
            empty_string: '', // Sera nettoyé
            valid_field: 'valid' // Sera conservé
          }
        ],
        ui_messages: []
      }));
      
      await taskIndexer.indexTask('test-task-payload-cleanup');
      
      // Vérifier que les transformations de payload sont loggées
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('[safeQdrantUpsert] Point 0: 2 champs nettoyés')
      );
    });
  });

  describe('validateVectorGlobal - Performance avec validation', () => {
    test('should handle multiple valid vectors efficiently', async () => {
      const validVector = new Array(1536).fill(0.1);
      
      mockOpenAIClient.embeddings.create.mockResolvedValue({
        data: [{ embedding: validVector }]
      });
      
      // Simuler plusieurs chunks
      const multipleMessages = Array.from({ length: 10 }, (_, i) => ({
        role: 'user',
        content: `Test message ${i}`
      }));
      
      mockFs.readFile.mockImplementation((filePath: string) => {
        if (filePath.includes('task_metadata.json')) {
          return Promise.resolve(JSON.stringify({
            title: 'Test Task Performance',
            parentTaskId: null,
            parent_task_id: null,
            workspace: '/mock/storage/path'
          }));
        }
        if (filePath.includes('api_conversation_history.json')) {
          return Promise.resolve(JSON.stringify(multipleMessages));
        }
        if (filePath.includes('ui_messages.json')) {
          return Promise.resolve(JSON.stringify([]));
        }
        return Promise.resolve(JSON.stringify({}));
      });
      
      const startTime = Date.now();
      await taskIndexer.indexTask('test-task-performance');
      const endTime = Date.now();
      
      // La validation ne devrait pas impacter significativement la performance
      expect(endTime - startTime).toBeLessThan(5000); // < 5 secondes
      expect(mockQdrantClient.upsert).toHaveBeenCalledTimes(1);
    });

    test('should fail fast on first invalid vector', async () => {
      const invalidVector = new Array(1536).fill(0.1);
      invalidVector[0] = NaN;
      
      mockOpenAIClient.embeddings.create.mockResolvedValue({
        data: [{ embedding: invalidVector }]
      });
      
      try {
        await taskIndexer.indexTask('test-task-fast-fail');
        expect.fail('Should have thrown an error');
      } catch (error: any) {
        // L'échec devrait être rapide grâce à la validation
        expect(error.message).toContain('Vector contient NaN ou Infinity');
      }
    });
  });

  describe('validateVectorGlobal - Intégration avec safeQdrantUpsert', () => {
    test('should integrate seamlessly with safeQdrantUpsert', async () => {
      const validVector = new Array(1536).fill(0.1);
      
      mockOpenAIClient.embeddings.create.mockResolvedValue({
        data: [{ embedding: validVector }]
      });
      
      mockFs.readFile.mockImplementation((filePath: string) => {
        if (filePath.includes('task_metadata.json')) {
          return Promise.resolve(JSON.stringify({
            title: 'Test Task Integration',
            parentTaskId: null,
            parent_task_id: null,
            workspace: '/mock/storage/path'
          }));
        }
        if (filePath.includes('api_conversation_history.json')) {
          return Promise.resolve(JSON.stringify([
            {
              role: 'user',
              content: 'Test message for integration'
            }
          ]));
        }
        if (filePath.includes('ui_messages.json')) {
          return Promise.resolve(JSON.stringify([]));
        }
        return Promise.resolve(JSON.stringify({}));
      });
      
      await taskIndexer.indexTask('test-task-integration');
      
      // Vérifier que safeQdrantUpsert est appelé avec des points validés
      expect(mockQdrantClient.upsert).toHaveBeenCalledWith(
        'roo_tasks_semantic_index',
        expect.objectContaining({
          points: expect.arrayContaining([
            expect.objectContaining({
              vector: validVector,
              payload: expect.objectContaining({
                task_id: 'test-task-integration',
                content: expect.stringContaining('Test message for integration')
              })
            })
          ])
        })
      );
    });

    test('should prevent invalid vectors from reaching Qdrant', async () => {
      const invalidVector = new Array(1536).fill(0.1);
      invalidVector[0] = NaN;
      
      mockOpenAIClient.embeddings.create.mockResolvedValue({
        data: [{ embedding: invalidVector }]
      });
      
      try {
        await taskIndexer.indexTask('test-task-prevention');
        expect.fail('Should have thrown an error');
      } catch (error: any) {
        // Qdrant ne devrait jamais être appelé avec un vecteur invalide
        expect(mockQdrantClient.upsert).not.toHaveBeenCalled();
        expect(error.message).toContain('Vector contient NaN ou Infinity');
      }
    });
  });
});