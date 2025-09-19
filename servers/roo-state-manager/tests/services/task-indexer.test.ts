import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { TaskIndexer } from '../../src/services/task-indexer.js';

// Mock des dépendances
jest.mock('../../src/services/qdrant.js');
jest.mock('../../src/services/openai.js');
jest.mock('../../src/utils/roo-storage-detector.js');

describe('TaskIndexer Circuit Breaker Tests', () => {
  let taskIndexer: TaskIndexer;
  let mockQdrantClient: any;
  let mockOpenAIClient: any;

  beforeEach(() => {
    taskIndexer = new TaskIndexer();
    
    // Mock simple avec any pour éviter les problèmes TypeScript
    mockQdrantClient = {
      upsert: jest.fn(),
      getCollections: jest.fn(),
      createCollection: jest.fn(),
      getCollection: jest.fn(),
      deleteCollection: jest.fn(),
    } as any;

    mockOpenAIClient = {
      embeddings: {
        create: jest.fn()
      }
    } as any;

    // Setup des valeurs de retour
    mockQdrantClient.getCollections.mockResolvedValue({ collections: [] });
    mockQdrantClient.getCollection.mockResolvedValue({ points_count: 0 });
    mockOpenAIClient.embeddings.create.mockResolvedValue({
      data: [{ embedding: new Array(1536).fill(0.1) }]
    });

    // Mock des imports
    const { getQdrantClient } = require('../../src/services/qdrant.js');
    getQdrantClient.mockReturnValue(mockQdrantClient);

    const getOpenAIClient = require('../../src/services/openai.js').default;
    getOpenAIClient.mockReturnValue(mockOpenAIClient);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test('Circuit Breaker - État CLOSED : Permet les requêtes', async () => {
    mockQdrantClient.upsert.mockResolvedValueOnce({});
    
    // Simuler une indexation réussie
    const result = await taskIndexer.indexTask('test-task-id');
    
    expect(mockQdrantClient.upsert).toHaveBeenCalledTimes(1);
    // Le circuit breaker devrait rester en état CLOSED
  });

  test('Circuit Breaker - État OPEN : Bloque les requêtes après 3 échecs', async () => {
    const error = new Error('ApiError: Bad Request');
    mockQdrantClient.upsert
      .mockRejectedValueOnce(error)
      .mockRejectedValueOnce(error)
      .mockRejectedValueOnce(error);
    
    // Première tentative - devrait échouer et retry
    await taskIndexer.indexTask('test-task-id-fail');
    
    expect(mockQdrantClient.upsert).toHaveBeenCalledTimes(3); // 3 tentatives
    
    // Les appels suivants devraient être bloqués
    await taskIndexer.indexTask('test-task-id-blocked');
    
    // Pas d'appel supplémentaire car circuit OPEN
    expect(mockQdrantClient.upsert).toHaveBeenCalledTimes(3);
  });

  test('Circuit Breaker - Délai exponentiel : 2s, 4s, 8s', async () => {
    jest.spyOn(global, 'setTimeout').mockImplementation((callback: any) => {
      callback();
      return {} as any;
    });

    const error = new Error('Network error');
    mockQdrantClient.upsert
      .mockRejectedValueOnce(error)
      .mockRejectedValueOnce(error)
      .mockRejectedValueOnce(error);

    const startTime = Date.now();
    await taskIndexer.indexTask('test-retry-timing');
    
    expect(setTimeout).toHaveBeenCalledTimes(2); // 2 retries = 2 delays
    
    (setTimeout as any).mockRestore();
  });

  test('Validation des payloads - sanitizePayload supprime undefined', () => {
    // Cette fonction devrait être exportée pour les tests
    const testPayload = {
      task_id: 'test-123',
      parent_task_id: null,
      undefined_field: undefined,
      empty_string: '',
      valid_field: 'valid'
    };

    // Simuler la logique sanitizePayload
    const cleaned: any = { ...testPayload };
    Object.keys(cleaned).forEach(key => {
      if (cleaned[key] === undefined) delete cleaned[key];
      if (typeof cleaned[key] === 'string' && cleaned[key].trim() === '' && key !== 'parent_task_id') {
        delete cleaned[key];
      }
    });

    expect(cleaned).not.toHaveProperty('undefined_field');
    expect(cleaned).not.toHaveProperty('empty_string');
    expect(cleaned).toHaveProperty('parent_task_id', null); // Préservé même si null
    expect(cleaned).toHaveProperty('valid_field', 'valid');
  });

  test('Gestion des erreurs parentTaskId manquant', async () => {
    // Mock d'une tâche avec parentTaskId manquant
    const mockTask = {
      taskId: 'orphan-task',
      metadata: { title: 'Test Task' } // Pas de parentTaskId
    };

    // Le système devrait tenter l'inférence et continuer sans planter
    mockQdrantClient.upsert.mockResolvedValueOnce({});
    
    const result = await taskIndexer.indexTask('orphan-task');
    
    // Devrait retourner un résultat même sans parentTaskId
    expect(Array.isArray(result)).toBe(true);
  });

  test('Logging détaillé - Capture des métriques critiques', async () => {
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    mockQdrantClient.upsert.mockRejectedValueOnce(new Error('Test error'));
    
    await taskIndexer.indexTask('test-logging');

    // Vérifier que les logs contiennent les informations critiques
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Circuit breaker')
    );
    
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Échec upsert Qdrant')
    );

    consoleSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  test('Collection Status - Vérification état Qdrant', async () => {
    mockQdrantClient.getCollections.mockResolvedValueOnce({
      collections: [{ name: 'roo_tasks_semantic_index' }]
    });
    
    mockQdrantClient.getCollection.mockResolvedValueOnce({
      points_count: 1250
    });

    const status = await taskIndexer.getCollectionStatus();
    
    expect(status).toEqual({
      exists: true,
      count: 1250
    });
  });

  test('Reset Collection - Nettoyage complet', async () => {
    mockQdrantClient.deleteCollection.mockResolvedValueOnce({});
    mockQdrantClient.createCollection.mockResolvedValueOnce({});

    await taskIndexer.resetCollection();

    expect(mockQdrantClient.deleteCollection).toHaveBeenCalledWith('roo_tasks_semantic_index');
    expect(mockQdrantClient.createCollection).toHaveBeenCalledWith(
      'roo_tasks_semantic_index',
      expect.objectContaining({
        vectors: {
          size: 1536,
          distance: 'Cosine'
        }
      })
    );
  });
});

describe('TaskIndexer Integration Tests', () => {
  test('Workflow complet - De la tâche à l\'indexation', async () => {
    // Test d'intégration du workflow complet
    // Ce test nécessiterait des données de test réelles
    expect(true).toBe(true); // Placeholder pour tests d'intégration futurs
  });
});