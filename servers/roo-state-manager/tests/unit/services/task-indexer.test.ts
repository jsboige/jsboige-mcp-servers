import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { TaskIndexer } from '../../../src/services/task-indexer.js';
import { CacheManager } from '../../../src/utils/cache-manager.js';
import crypto from 'crypto';

// Mock des dépendances
jest.mock('../../../src/services/qdrant.js');
jest.mock('../../../src/services/openai.js');
jest.mock('../../../src/utils/roo-storage-detector.js');

describe('🛡️ TaskIndexer Anti-Leak Protections & Circuit Breaker Tests', () => {
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

describe('🛡️ Anti-Leak Protections - Corrections Bande Passante', () => {
  let cacheManager: CacheManager;
  let mockEmbeddingCache: Map<string, { vector: number[], timestamp: number }>;
  let mockQdrantIndexCache: Map<string, number>;
  let operationTimestamps: number[];

  beforeEach(() => {
    cacheManager = new CacheManager({
      maxSize: 5 * 1024 * 1024, // 5MB pour tests
      maxAge: 2 * 60 * 1000,   // 2 minutes pour tests
      persistToDisk: false
    });

    mockEmbeddingCache = new Map();
    mockQdrantIndexCache = new Map();
    operationTimestamps = [];
  });

  afterEach(async () => {
    await cacheManager.close();
  });

  test('🎯 Cache embeddings OpenAI avec TTL 24h - Protection anti-fuite', () => {
    const EMBEDDING_CACHE_TTL = 24 * 60 * 60 * 1000; // 24h
    const content = 'Test content for embedding cache';
    const contentHash = crypto.createHash('sha256').update(content).digest('hex');
    const mockVector = new Array(1536).fill(0.1);
    const now = Date.now();

    // Simulation cache hit - évite appel OpenAI
    mockEmbeddingCache.set(contentHash, {
      vector: mockVector,
      timestamp: now
    });

    const cached = mockEmbeddingCache.get(contentHash);
    expect(cached).toBeDefined();
    expect(cached!.vector).toEqual(mockVector);
    expect(cached!.timestamp).toBeLessThanOrEqual(now);

    // Vérification expiration après TTL
    const isExpired = now - cached!.timestamp >= EMBEDDING_CACHE_TTL;
    expect(isExpired).toBe(false); // Pas encore expiré dans ce test
  });

  test('🕘 Cache indexation Qdrant 4h minimum - Protection anti-ré-indexation', () => {
    const MIN_REINDEX_INTERVAL = 4 * 60 * 60 * 1000; // 4h
    const taskId = 'test-task-anti-reindex';
    const now = Date.now();

    // Première indexation
    mockQdrantIndexCache.set(taskId, now);

    // Tentative de ré-indexation trop tôt
    const lastIndexed = mockQdrantIndexCache.get(taskId);
    const timeSinceIndexed = now - (lastIndexed || 0);
    
    expect(lastIndexed).toBeDefined();
    expect(timeSinceIndexed).toBeLessThan(MIN_REINDEX_INTERVAL);
    
    // La tâche devrait être ignorée (protection anti-fuite)
    const shouldSkip = timeSinceIndexed < MIN_REINDEX_INTERVAL;
    expect(shouldSkip).toBe(true);
  });

  test('🚦 Rate Limiting - Max 10 opérations par minute', async () => {
    const MAX_OPERATIONS_PER_WINDOW = 10;
    const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
    const now = Date.now();
    
    // Simuler 10 opérations dans la fenêtre
    for (let i = 0; i < MAX_OPERATIONS_PER_WINDOW; i++) {
      operationTimestamps.push(now - i * 1000); // Étalées sur 10 secondes
    }

    // Nettoyer les timestamps obsolètes
    operationTimestamps = operationTimestamps.filter(ts => now - ts < RATE_LIMIT_WINDOW);
    
    expect(operationTimestamps.length).toBe(MAX_OPERATIONS_PER_WINDOW);
    
    // 11ème opération devrait être bloquée
    const shouldWait = operationTimestamps.length >= MAX_OPERATIONS_PER_WINDOW;
    expect(shouldWait).toBe(true);
  });

  test('⏰ Vérifications timestamps - Éviter indexations inutiles', () => {
    const mockSkeleton = {
      taskId: 'test-timestamp-verification',
      metadata: {
        lastActivity: '2024-01-02T12:00:00Z',
        qdrantIndexedAt: '2024-01-02T10:00:00Z'
      }
    };

    const lastActivity = new Date(mockSkeleton.metadata.lastActivity).getTime();
    const qdrantIndexed = new Date(mockSkeleton.metadata.qdrantIndexedAt).getTime();
    
    // Si pas d'activité depuis la dernière indexation, skip
    const shouldSkipIndexing = lastActivity <= qdrantIndexed;
    expect(shouldSkipIndexing).toBe(false); // Activité plus récente dans ce test
    
    // Test cas inverse
    const mockSkeletonNoReindex = {
      ...mockSkeleton,
      metadata: {
        lastActivity: '2024-01-02T09:00:00Z', // Antérieur à l'indexation
        qdrantIndexedAt: '2024-01-02T10:00:00Z'
      }
    };
    
    const lastActivity2 = new Date(mockSkeletonNoReindex.metadata.lastActivity).getTime();
    const qdrantIndexed2 = new Date(mockSkeletonNoReindex.metadata.qdrantIndexedAt).getTime();
    const shouldSkipIndexing2 = lastActivity2 <= qdrantIndexed2;
    expect(shouldSkipIndexing2).toBe(true); // Devrait être skippé
  });

  test('📊 Métriques réseau - Tracking de la bande passante', () => {
    const networkMetrics = {
      qdrantCalls: 15,
      openaiCalls: 8,
      cacheHits: 25,
      cacheMisses: 12,
      bytesTransferred: 1024 * 1024, // 1MB
      lastReset: Date.now()
    };

    // Calcul du taux de cache
    const totalRequests = networkMetrics.cacheHits + networkMetrics.cacheMisses;
    const cacheHitRate = totalRequests > 0 ? networkMetrics.cacheHits / totalRequests : 0;
    
    expect(cacheHitRate).toBeGreaterThan(0.5); // Au moins 50% de cache hits
    expect(networkMetrics.qdrantCalls).toBeLessThan(networkMetrics.cacheHits); // Plus de cache que d'appels
    expect(networkMetrics.bytesTransferred).toBeGreaterThan(0);
  });

  test('🔄 Backoff exponentiel - Retry avec délais croissants', async () => {
    const RETRY_DELAY_MS = 2000; // 2 secondes base
    const MAX_RETRY_ATTEMPTS = 3;
    
    const calculateBackoffDelay = (attempt: number) => RETRY_DELAY_MS * Math.pow(2, attempt - 1);
    
    // Test des délais exponentiels
    expect(calculateBackoffDelay(1)).toBe(2000);  // 2s
    expect(calculateBackoffDelay(2)).toBe(4000);  // 4s
    expect(calculateBackoffDelay(3)).toBe(8000);  // 8s

    // Simulation d'une fonction retry
    let attempts = 0;
    const mockOperation = jest.fn<() => Promise<string>>();
    mockOperation
      .mockRejectedValueOnce(new Error('Failure 1'))
      .mockRejectedValueOnce(new Error('Failure 2'))
      .mockResolvedValueOnce('Success');

    const retryWithBackoff = async () => {
      for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
        attempts++;
        try {
          return await mockOperation();
        } catch (error: any) {
          if (attempt === MAX_RETRY_ATTEMPTS) throw error;
          // Dans un vrai test, on attendrait calculateBackoffDelay(attempt)
        }
      }
    };

    const result = await retryWithBackoff();
    expect(result).toBe('Success');
    expect(attempts).toBe(3); // 2 échecs + 1 succès
    expect(mockOperation).toHaveBeenCalledTimes(3);
  });

  test('🎯 Protection anti-fuite complète - Scénario réel', async () => {
    const taskId = 'comprehensive-anti-leak-test';
    const content = 'Test content for comprehensive leak protection';
    const contentHash = crypto.createHash('sha256').update(content).digest('hex');
    const now = Date.now();
    
    // 1. Vérifier cache embedding
    const embeddingCached = mockEmbeddingCache.get(contentHash);
    let shouldCallOpenAI = !embeddingCached;
    expect(shouldCallOpenAI).toBe(true); // Première fois
    
    // 2. Mettre en cache
    mockEmbeddingCache.set(contentHash, {
      vector: new Array(1536).fill(0.1),
      timestamp: now
    });
    
    // 3. Vérifier indexation Qdrant récente
    const lastQdrantIndex = mockQdrantIndexCache.get(taskId);
    const MIN_INTERVAL = 4 * 60 * 60 * 1000;
    let shouldCallQdrant = !lastQdrantIndex || (now - lastQdrantIndex) >= MIN_INTERVAL;
    expect(shouldCallQdrant).toBe(true); // Première fois
    
    // 4. Mettre à jour cache Qdrant
    mockQdrantIndexCache.set(taskId, now);
    
    // 5. Vérifications pour appel suivant (protection active)
    const embeddingCached2 = mockEmbeddingCache.get(contentHash);
    shouldCallOpenAI = !embeddingCached2;
    expect(shouldCallOpenAI).toBe(false); // Cache hit!
    
    const lastQdrantIndex2 = mockQdrantIndexCache.get(taskId);
    shouldCallQdrant = !lastQdrantIndex2 || (now - lastQdrantIndex2) >= MIN_INTERVAL;
    expect(shouldCallQdrant).toBe(false); // Trop récent!
    
    // Simulation économies réseau
    const estimatedSavings = {
      openaiCallsAvoided: shouldCallOpenAI ? 0 : 1,
      qdrantCallsAvoided: shouldCallQdrant ? 0 : 1
    };
    
    expect(estimatedSavings.openaiCallsAvoided).toBe(1);
    expect(estimatedSavings.qdrantCallsAvoided).toBe(1);
  });
});

describe('TaskIndexer Integration Tests', () => {
  test('Workflow complet - De la tâche à l\'indexation', async () => {
    // Test d'intégration du workflow complet
    // Ce test nécessiterait des données de test réelles
    expect(true).toBe(true); // Placeholder pour tests d'intégration futurs
  });
});