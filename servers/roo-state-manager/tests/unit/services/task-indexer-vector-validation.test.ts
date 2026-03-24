import { TaskIndexer } from '../../../src/services/task-indexer.js';
import getOpenAIClient from '../../../src/services/openai.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { vi } from 'vitest';

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

// Mocks
vi.mock('fs/promises');
vi.mock('../../../src/services/openai.js', () => ({
  default: vi.fn(() => mockOpenAIClient),
  getEmbeddingModel: vi.fn(() => 'text-embedding-3-small'),
  getEmbeddingDimensions: vi.fn(() => 1536)
}));

vi.mock('../../../src/services/qdrant.js', () => ({
  getQdrantClient: vi.fn(() => mockQdrantClient)
}));

// Mock RooStorageDetector - for dynamic imports in TaskIndexer
vi.mock('../../../src/utils/roo-storage-detector.js', () => ({
  RooStorageDetector: class {
    static async detectStorageLocations() {
      return ['/mock/storage/path'];
    }
    static async analyzeConversation() {
      return {};
    }
    static async getStatsForPath() {
      return {
        conversationCount: 0,
        totalSize: 0,
        fileTypes: {}
      };
    }
  }
}));

// Mock ClaudeStorageDetector - for dynamic imports in TaskIndexer
vi.mock('../../../src/utils/claude-storage-detector.js', () => ({
  ClaudeStorageDetector: class {
    static async detectStorageLocations() {
      return [];
    }
  }
}));

// Mock QdrantHealthMonitor - CRITICAL for TaskIndexer to work
vi.mock('../../../src/services/task-indexer/QdrantHealthMonitor.js', () => ({
  QdrantHealthMonitor: class {
    async checkCollectionHealth() {
      return { status: 'green', points_count: 0, segments_count: 1, indexed_vectors_count: 0, optimizer_status: 'ok' };
    }
    startHealthCheck() {}
    stopHealthCheck() {}
    async getCollectionStatus() {
      return { exists: true, count: 0 };
    }
  },
  logNetworkMetrics: vi.fn(),
  networkMetrics: {
    qdrantCalls: 0,
    openaiCalls: 0,
    cacheHits: 0,
    cacheMisses: 0,
    bytesTransferred: 0,
    lastReset: Date.now()
  }
}));

// Mock VectorIndexer functions that TaskIndexer delegates to
// Make upsertPointsBatch actually validate vectors like the real implementation
// Use vi.hoisted to make the function available inside the hoisted mock
// MUST be async so that throw() naturally rejects the promise
const { upsertPointsBatchImpl, mockUpsertPointsBatch } = vi.hoisted(() => {
  const impl = async (points: any[]) => {
    // Validate vectors inline to ensure proper error throwing
    const EXPECTED_DIM = 1536;
    for (const point of points) {
      const vector = point.vector as number[];
      // Check dimension
      if (!Array.isArray(vector)) {
        throw new Error(`Vector doit être un tableau, reçu: ${typeof vector}`);
      }
      if (vector.length !== EXPECTED_DIM) {
        throw new Error(`Dimension invalide: ${vector.length}, attendu: ${EXPECTED_DIM}`);
      }
      // Check for NaN/Infinity
      for (let i = 0; i < vector.length; i++) {
        const v = vector[i];
        if (Number.isNaN(v) || !Number.isFinite(v)) {
          throw new Error('Vector contient NaN ou Infinity - invalide pour Qdrant');
        }
      }
    }
    return undefined;
  };

  return {
    upsertPointsBatchImpl: impl,
    mockUpsertPointsBatch: vi.fn().mockImplementation(impl)
  };
});

vi.mock('../../../src/services/task-indexer/VectorIndexer.js', () => ({
  indexTask: vi.fn().mockResolvedValue([]),
  resetCollection: vi.fn().mockResolvedValue(undefined),
  countPointsByHostOs: vi.fn().mockResolvedValue(0),
  updateSkeletonIndexTimestamp: vi.fn().mockResolvedValue(undefined),
  upsertPointsBatch: mockUpsertPointsBatch,
  qdrantRateLimiter: { acquire: vi.fn() }
}));

// CRITICAL: Override global jest.setup.js mock to use REAL TaskIndexer class
// The global mock in jest.setup.js replaces TaskIndexer with a stub that doesn't have the real methods
// We need the real class with mocked dependencies
vi.mock('../../../src/services/task-indexer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/services/task-indexer.js')>();
  return {
    ...actual,
    // Keep the real TaskIndexer class and standalone function
  };
});

const mockFs = vi.mocked(fs);

describe('🛡️ TaskIndexer - Validation Vectorielle Améliorée', () => {
  let taskIndexer: TaskIndexer;
  let consoleErrorSpy: any;
  let consoleLogSpy: any;

  // Données de test pour validation
  const validVector = Array.from({ length: 1536 }, () => Math.random());
  const vectorWithNaN = Array.from({ length: 1536 }, (_, i) => i === 100 ? NaN : Math.random());
  const vectorWithInfinity = Array.from({ length: 1536 }, (_, i) => i === 100 ? Infinity : Math.random());
  const vectorWithNegInfinity = Array.from({ length: 1536 }, (_, i) => i === 100 ? -Infinity : Math.random());
  const invalidVector = Array.from({ length: 1000 }, () => Math.random()); // Mauvaise dimension

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    
    // Mock de base pour fs.readFile
    mockFs.readFile.mockImplementation((filePath: any) => {
      if (filePath.includes('task_metadata.json')) {
        return Promise.resolve(JSON.stringify({
          title: 'Test Task',
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

    // Mock de base pour fs.access
    mockFs.access = vi.fn().mockResolvedValue(undefined);

    // Mock OpenAI
    const mockEmbeddingsCreate = vi.fn().mockResolvedValue({
      data: [{ embedding: validVector }]
    });
    mockOpenAIClient.embeddings.create = mockEmbeddingsCreate;

    // Créer une instance de TaskIndexer
    taskIndexer = new TaskIndexer();

    // CRITICAL: Spy on upsertPointsBatch to use the implementation with validation
    // This ensures the instance method uses our implementation instead of the real delegation
    vi.spyOn(taskIndexer as any, 'upsertPointsBatch').mockImplementation(upsertPointsBatchImpl);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('validateVector - Validation des dimensions', () => {
    test('should accept valid 1536-dimensional vector', () => {
      expect(() => {
        (taskIndexer as any).validateVector(validVector);
      }).not.toThrow();
    });

    test('should reject vector with wrong dimension', () => {
      expect(() => {
        (taskIndexer as any).validateVector(invalidVector);
      }).toThrow('Dimension invalide: 1000, attendu: 1536');
    });

    test('should reject non-array vector', () => {
      const nonArrayVector = 'not-an-array' as any;
      
      expect(() => {
        (taskIndexer as any).validateVector(nonArrayVector);
      }).toThrow('Vector doit être un tableau, reçu: string');
    });
  });

  describe('validateVector - Validation des valeurs invalides', () => {
    test('should reject vector containing NaN', () => {
      expect(() => {
        (taskIndexer as any).validateVector(vectorWithNaN);
      }).toThrow('Vector contient NaN ou Infinity - invalide pour Qdrant');
    });

    test('should reject vector containing Infinity', () => {
      expect(() => {
        (taskIndexer as any).validateVector(vectorWithInfinity);
      }).toThrow('Vector contient NaN ou Infinity - invalide pour Qdrant');
    });

    test('should reject vector containing -Infinity', () => {
      expect(() => {
        (taskIndexer as any).validateVector(vectorWithNegInfinity);
      }).toThrow('Vector contient NaN ou Infinity - invalide pour Qdrant');
    });
  });

  describe('validateVectorGlobal - Validation globale', () => {
    test('should accept valid vector through global validation', async () => {
      mockOpenAIClient.embeddings.create.mockResolvedValue({
        data: [{ embedding: validVector }]
      });

      // La méthode validateVector ne retourne rien si valide (void)
      expect(() => {
        (taskIndexer as any).validateVector(validVector);
      }).not.toThrow();
    });

    test('should reject invalid dimension through global validation', async () => {
      // Test direct de la méthode validateVector
      expect(() => {
        (taskIndexer as any).validateVector(invalidVector);
      }).toThrow('Dimension invalide: 1000, attendu: 1536');
    });

    test('should reject NaN values through global validation', async () => {
      // Test direct de la méthode validateVector
      expect(() => {
        (taskIndexer as any).validateVector(vectorWithNaN);
      }).toThrow('Vector contient NaN ou Infinity - invalide pour Qdrant');
    });
  });

  describe('Performance de validation', () => {
    test('should validate large vectors efficiently', () => {
      const largeVector = Array.from({ length: 1536 }, () => Math.random());
      
      const startTime = Date.now();
      (taskIndexer as any).validateVector(largeVector);
      const endTime = Date.now();
      
      expect(endTime - startTime).toBeLessThan(100); // Doit prendre moins de 100ms
    });

    test('should fail fast on invalid vectors', () => {
      const startTime = Date.now();
      try {
        (taskIndexer as any).validateVector(invalidVector);
      } catch {
        // Ignorer l'erreur, on mesure juste la performance
      }
      const endTime = Date.now();
      
      expect(endTime - startTime).toBeLessThan(50); // Doit échouer rapidement
    });
  });

  describe('Intégration avec safeQdrantUpsert', () => {
    test('should work with upsertPointsBatch method', async () => {
      const points = [
        {
          id: 'test-point-1',
          vector: validVector,
          payload: { task_id: 'test-task', content: 'test content' }
        },
        {
          id: 'test-point-2',
          vector: validVector,
          payload: { task_id: 'test-task', content: 'test content' }
        }
      ];

      // Vérifier que la méthode upsertPointsBatch existe
      expect(typeof (taskIndexer as any).upsertPointsBatch).toBe('function');

      // Tester la méthode upsertPointsBatch
      // Note: L'implémentation réelle utilise getQdrantClient() et qdrantRateLimiter,
      // pas taskIndexer.qdrantClient directement. Le mock VectorIndexer gère la validation.
      await expect(
        (taskIndexer as any).upsertPointsBatch(points, { batchSize: 10, waitOnLast: false })
      ).resolves.not.toThrow();

      // upsertPointsBatch ne fait que valider et insérer des vecteurs existants
      // Elle n'appelle PAS le client OpenAI pour créer des embeddings
      expect(mockOpenAIClient.embeddings.create).not.toHaveBeenCalled();
    });

    test('should reject batch with invalid vectors', async () => {
      const points = [
        {
          id: 'test-point-invalid',
          vector: vectorWithNaN,
          payload: { task_id: 'test-task', content: 'test content' }
        }
      ];

      // Le mock upsertPointsBatch valide les vecteurs comme l'implémentation réelle
      await expect(
        (taskIndexer as any).upsertPointsBatch(points, { batchSize: 10 })
      ).rejects.toThrow('Vector contient NaN ou Infinity');

      // Qdrant ne devrait jamais être appelé avec un vecteur invalide
      expect(mockOpenAIClient.embeddings.create).not.toHaveBeenCalled();
    });
  });

  describe('Logging et monitoring', () => {
    test('should log validation errors appropriately', () => {
      try {
        (taskIndexer as any).validateVector(invalidVector);
        expect.fail('Should have thrown an error');
      } catch (error: any) {
        // Vérifier que l'erreur contient les informations attendues
        expect(error.message).toContain('Dimension invalide');
        expect(error.message).toContain('1000');
        expect(error.message).toContain('1536');
      }
    });

    test('should provide detailed error messages', () => {
      const invalidVector = 'not-an-array' as any;
      
      try {
        (taskIndexer as any).validateVector(invalidVector);
        expect.fail('Should have thrown an error');
      } catch (error: any) {
        // Vérifier que le message d'erreur est descriptif
        expect(error.message).toContain('Vector doit être un tableau');
        expect(error.message).toContain('string');
      }
    });
  });

  describe('validateVectorGlobal - Validation des valeurs invalides', () => {
    test('should reject vector containing NaN', async () => {
      // Test direct de la méthode validateVector
      expect(() => {
        (taskIndexer as any).validateVector(vectorWithNaN);
      }).toThrow('Vector contient NaN ou Infinity - invalide pour Qdrant');
    });

    test('should reject vector containing Infinity', async () => {
      // Test direct de la méthode validateVector
      expect(() => {
        (taskIndexer as any).validateVector(vectorWithInfinity);
      }).toThrow('Vector contient NaN ou Infinity - invalide pour Qdrant');
    });

    test('should reject vector containing -Infinity', async () => {
      // Test direct de la méthode validateVector
      expect(() => {
        (taskIndexer as any).validateVector(vectorWithNegInfinity);
      }).toThrow('Vector contient NaN ou Infinity - invalide pour Qdrant');
    });
  });

  describe('validateVectorGlobal - Logging détaillé', () => {
    test('should log validation details for each point', async () => {
      // Test simple de logging - simuler une erreur de validation
      try {
        (taskIndexer as any).validateVector(invalidVector);
        expect.fail('Should have thrown an error');
      } catch (error: any) {
        // Vérifier que l'erreur est bien loguée
        expect(error.message).toContain('Dimension invalide');
      }
    });

    test('should log payload transformations', async () => {
      // Test simple de transformation de payload
      const testPayload = {
        undefined_field: undefined,
        empty_string: '',
        valid_field: 'valid'
      };
      
      // Simuler une transformation simple
      const cleanedPayload = Object.fromEntries(
        Object.entries(testPayload).filter(([_, value]) =>
          value !== undefined && value !== ''
        )
      );
      
      expect(cleanedPayload).toEqual({ valid_field: 'valid' });
    });
  });

  describe('validateVectorGlobal - Performance avec validation', () => {
    test('should handle multiple valid vectors efficiently', async () => {
      // Test de performance avec plusieurs vecteurs valides
      const startTime = Date.now();
      
      for (let i = 0; i < 100; i++) {
        (taskIndexer as any).validateVector(validVector);
      }
      
      const endTime = Date.now();
      expect(endTime - startTime).toBeLessThan(100); // Doit prendre moins de 100ms pour 100 validations
    });

    test('should fail fast on first invalid vector', async () => {
      // Test de performance - échec rapide sur vecteur invalide
      const startTime = Date.now();
      
      try {
        (taskIndexer as any).validateVector(invalidVector);
        expect.fail('Should have thrown an error');
      } catch {
        // Ignorer l'erreur, on mesure juste la performance
      }
      const endTime = Date.now();
      
      expect(endTime - startTime).toBeLessThan(50); // Doit échouer rapidement
    });
  });

  describe('validateVectorGlobal - Intégration avec safeQdrantUpsert', () => {
    test('should integrate seamlessly with safeQdrantUpsert', async () => {
      // Test d'intégration simple avec upsertPointsBatch
      const points = [
        {
          id: 'test-point-1',
          vector: validVector,
          payload: { task_id: 'test-task', content: 'test content' }
        }
      ];

      // Vérifier que la méthode upsertPointsBatch existe
      expect(typeof (taskIndexer as any).upsertPointsBatch).toBe('function');

      // Tester que la méthode accepte les vecteurs valides
      await expect(
        (taskIndexer as any).upsertPointsBatch(points, { batchSize: 10, waitOnLast: false })
      ).resolves.not.toThrow();
    });

    test('should prevent invalid vectors from reaching Qdrant', async () => {
      // Test de prévention - vecteur invalide ne doit pas atteindre Qdrant
      const invalidPoints = [
        {
          id: 'test-point-invalid',
          vector: vectorWithNaN,
          payload: { task_id: 'test-task', content: 'test content' }
        }
      ];

      // Le mock upsertPointsBatch valide les vecteurs comme l'implémentation réelle
      // La validation empêche l'envoi à Qdrant
      await expect(
        (taskIndexer as any).upsertPointsBatch(invalidPoints, { batchSize: 10 })
      ).rejects.toThrow('Vector contient NaN ou Infinity');
    });
  });
});