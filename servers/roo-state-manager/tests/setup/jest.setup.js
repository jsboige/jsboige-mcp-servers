import { vi, beforeEach } from 'vitest';
import dotenv from 'dotenv';
import path from 'path';

// Charger les variables d'environnement depuis le fichier .env
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// Configuration globale des mocks pour la console
global.console = {
  ...console,
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn()
};

// Mock des variables d'environnement pour les tests (surcharge les valeurs du .env si nécessaire)
process.env.NODE_ENV = 'test';
process.env.ROOSYNC_TEST_MODE = 'true';

// Si les variables ne sont pas dans le .env, utiliser des valeurs par défaut pour les tests
if (!process.env.QDRANT_URL) process.env.QDRANT_URL = 'http://localhost:6333';
if (!process.env.QDRANT_API_KEY) process.env.QDRANT_API_KEY = 'test-key';
if (!process.env.OPENAI_API_KEY) process.env.OPENAI_API_KEY = 'sk-test-key';
if (!process.env.OPENAI_CHAT_MODEL_ID) process.env.OPENAI_CHAT_MODEL_ID = 'gpt-4o-mini';
if (!process.env.QDRANT_COLLECTION_NAME) process.env.QDRANT_COLLECTION_NAME = 'roo_tasks_semantic_index';

// Mock des APIs externes
vi.mock('openai', () => ({
  OpenAI: vi.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [{ message: { content: 'test response' } }]
        })
      }
    },
    embeddings: {
      create: vi.fn().mockResolvedValue({
        data: [{ embedding: new Array(1536).fill(0.1) }]
      })
    }
  }))
}));

// Mock du client Qdrant
vi.mock('@qdrant/js-client-rest', () => ({
  QdrantClient: vi.fn().mockImplementation(() => ({
    upsert: vi.fn().mockResolvedValue({}),
    getCollections: vi.fn().mockResolvedValue({ collections: [] }),
    getCollection: vi.fn().mockResolvedValue({ points_count: 0 }),
    createCollection: vi.fn().mockResolvedValue({}),
    deleteCollection: vi.fn().mockResolvedValue({}),
    search: vi.fn().mockResolvedValue({
      points: [
        {
          id: 'test-point',
          score: 0.9,
          payload: { task_id: 'test-task', content: 'test content' }
        }
      ]
    })
  }))
}));

// Mock pour SynthesisOrchestratorService - Version améliorée avec gestion d'erreur
let mockErrorMode = false;

// Hook global pour réinitialiser le mode d'erreur avant chaque test
beforeEach(() => {
  mockErrorMode = false;
  console.error('[MOCK SETUP] beforeEach: Resetting mockErrorMode to FALSE');
});

// Exporter le contrôleur de mode d'erreur pour les tests
global.setMockErrorMode = (enabled) => {
  mockErrorMode = enabled;
  console.error(`[MOCK SETUP] setMockErrorMode called with: ${enabled}`);
};

vi.mock('../src/services/synthesis/SynthesisOrchestratorService.js', () => {
  const mockInstance = {
    synthesizeConversation: vi.fn().mockImplementation(async (taskId, options) => {
      // Toujours retourner une réponse de succès pour les tests
      console.error(`[MOCK DEBUG] Returning SUCCESS response for taskId=${taskId}`);
      
      return {
        taskId: taskId,
        analysisEngineVersion: '3.0.0-phase3',
        analysisTimestamp: new Date().toISOString(),
        synthesis: {
          initialContextSummary: 'Mock context summary',
          finalTaskSummary: 'Mock final summary',
          keyInsights: ['Insight 1', 'Insight 2'],
          recommendations: ['Recommendation 1'],
          nextSteps: ['Next step 1'],
          qualityScore: 0.8,
          confidenceLevel: 0.9
        },
        contextTrace: {
          rootTaskId: taskId,
          parentTaskId: undefined,
          previousSiblingTaskIds: []
        },
        objectives: { primary: 'Mock objective' },
        strategy: { type: 'mock-strategy' },
        quality: { score: 0.8, confidence: 'medium' },
        metrics: {
          contextLength: 1000,
          wasCondensed: true,
          condensedBatchPath: '/test/batch.json',
          processingTimeMs: 100,
          llmCallsCount: 1,
          totalTokensUsed: 1000,
          cacheHitRate: 0.8
        },
        llmModelId: 'mock-gpt-4'
      };
    }),
    startBatchSynthesis: vi.fn().mockRejectedValue(new Error('Pas encore implémenté (Phase 1: Squelette)')),
    // Méthode pour activer le mode d'erreur (utilisé dans les tests)
    _setErrorMode: (enabled) => { mockErrorMode = enabled; }
  };
  
  return {
    SynthesisOrchestratorService: vi.fn().mockImplementation(() => mockInstance)
  };
});

// Mock du système de fichiers
// Mock fs/promises avec toutes les méthodes nécessaires
/*
const mockFsPromises = {
  access: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue(JSON.stringify({})),
  writeFile: vi.fn().mockResolvedValue(undefined),
  readdir: vi.fn().mockResolvedValue(['file1.json', 'file2.json']),
  stat: vi.fn().mockResolvedValue({ isDirectory: () => true }),
  mkdir: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
  copyFile: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined)
};

vi.mock('fs/promises', () => {
  return {
    default: mockFsPromises,
    ...mockFsPromises
  };
});

// Mock du système de fichiers
vi.mock('fs', () => {
  const mockFs = {
    existsSync: vi.fn(() => true),
    readFileSync: vi.fn(() => JSON.stringify({})),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn(() => ['file1.json', 'file2.json']),
    statSync: vi.fn(() => ({ isDirectory: () => true })),
    rmSync: vi.fn(),
    promises: mockFsPromises
  };
  
  return {
    default: mockFs,
    ...mockFs
  };
});
*/

// Mock du module path
vi.mock('path', () => {
  const mockPath = {
    join: vi.fn((...args) => args.join('/')),
    basename: vi.fn((path) => path.split('/').pop() || path),
    dirname: vi.fn((path) => path.split('/').slice(0, -1).join('/') || '.'),
    resolve: vi.fn((...args) => args.join('/')),
    relative: vi.fn((from, to) => to),
    sep: '/',
    extname: vi.fn((path) => {
      const lastDot = path.lastIndexOf('.');
      return lastDot >= 0 ? path.slice(lastDot) : '';
    }),
    parse: vi.fn((path) => {
      const base = path.split('/').pop() || '';
      const ext = base.includes('.') ? base.split('.').pop() : '';
      return { root: '', dir: base.split('.')[0], base, ext };
    })
  };
  
  return {
    default: mockPath,
    ...mockPath
  };
});

// Mock du module os
vi.mock('os', () => ({
  platform: vi.fn(() => 'win32'),
  arch: vi.fn(() => 'x64'),
  cpus: vi.fn(() => [{ model: 'test-cpu' }]),
  totalmem: vi.fn(() => 8000000000),
  freemem: vi.fn(() => 4000000000),
  homedir: vi.fn(() => '/mock/home'),
  tmpdir: vi.fn(() => '/mock/tmp')
}));

// Mock du module uuid
vi.mock('uuid', () => ({
  v4: vi.fn(() => 'test-uuid-' + Math.random().toString(36).substr(2, 9)),
  v1: vi.fn(() => 'test-uuid-v1-' + Math.random().toString(36).substr(2, 9))
}));

// Mock du logger winston
vi.mock('winston', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })),
  format: {
    combine: vi.fn(),
    timestamp: vi.fn(),
    errors: vi.fn(),
    json: vi.fn(),
    printf: vi.fn()
  },
  transports: {
    Console: vi.fn(),
    File: vi.fn()
  }
}));

// Mock pour les services de parsing et d'extraction
vi.mock('../src/services/xml-parsing.service.js', () => ({
  extractNewTaskInstructions: vi.fn(() => [
    {
      mode: 'task',
      message: 'Test instruction',
      timestamp: new Date().toISOString()
    }
  ]),
}));

// Mock pour RooStorageDetector
vi.mock('../src/utils/RooStorageDetector.js', () => ({
  default: {
    analyzeConversation: vi.fn(() => ({
      metadata: {
        lastActivity: new Date().toISOString(),
        createdAt: new Date().toISOString()
      },
      childTaskInstructionPrefixes: []
    })),
    extractNewTaskInstructions: vi.fn(() => [
      {
        mode: 'task',
        message: 'Test instruction',
        timestamp: new Date().toISOString()
      }
    ]),
  }
}));

// Mock pour HierarchyReconstructionEngine
vi.mock('../src/services/HierarchyReconstructionEngine.js', () => ({
  default: vi.fn().mockImplementation(() => ({
    executePhase1: vi.fn().mockResolvedValue({
      processedCount: 5,
      parsedCount: 3,
      totalInstructionsExtracted: 3,
      errors: [],
      radixTreeSize: 3
    }),
    executePhase2: vi.fn().mockResolvedValue({
      resolvedCount: 4,
      unresolvedCount: 1,
      reconstructionRate: 80,
      depthLevels: { 'test-id': 1 },
      resolutionMethods: { 'radix_tree': 2, 'radix_tree_exact': 1 }
    }),
    exportHierarchicalTree: vi.fn().mockResolvedValue([
      { taskId: 'root', depth: 0 },
      { taskId: 'child1', depth: 1, parentTaskId: 'root' },
      { taskId: 'child2', depth: 1, parentTaskId: 'root' }
    ]),
    exportHierarchicalMarkdown: vi.fn().mockResolvedValue('# Test Markdown\n## Child 1\n## Child 2'),
  }))
}));

// Mock pour TaskIndexer
vi.mock('../src/services/task-indexer.js', () => ({
  default: vi.fn().mockImplementation(() => ({
    getCollectionStatus: vi.fn().mockResolvedValue({
      exists: true,
      pointsCount: 100,
      vectorSize: 1536
    }),
    resetCollection: vi.fn().mockResolvedValue(undefined),
    safeQdrantUpsert: vi.fn().mockResolvedValue(undefined),
    upsertPointsBatch: vi.fn().mockResolvedValue(undefined),
  }))
}));

// Mock pour PowerShellExecutor
vi.mock('../src/services/PowerShellExecutor.js', () => ({
  default: vi.fn().mockImplementation(() => ({
    executeScript: vi.fn().mockRejectedValue(new Error('PowerShell execution failed: spawn pwsh.exe ENOENT')),
  }))
}));

// Mock pour RooSyncService
vi.mock('../src/services/RooSyncService.js', () => ({
  default: vi.fn().mockImplementation(() => ({
    loadDashboard: vi.fn().mockResolvedValue({
      version: '2.1.0',
      status: 'synced',
      overallStatus: 'synced',
      lastSync: new Date().toISOString(),
      lastUpdate: new Date().toISOString(),
      machines: {
        'myia-ai-01': {
          status: 'online',
          lastSync: new Date().toISOString(),
          diffsCount: 0,
          pendingDecisions: 0
        },
        'myia-po-2024': {
          status: 'online',
          lastSync: new Date().toISOString(),
          diffsCount: 0,
          pendingDecisions: 0
        },
      },
      machinesArray: [],
      stats: {
        totalDecisions: 0,
        appliedDecisions: 0,
        pendingDecisions: 0,
        totalDiffs: 0,
      },
      summary: {
        totalMachines: 0,
        onlineMachines: 0,
        totalDiffs: 0,
        totalPendingDecisions: 0,
      },
    }),
  }))
}));

// Mock pour BaselineService
vi.mock('../src/services/BaselineService.js', () => ({
  default: vi.fn().mockImplementation(() => ({
    loadBaseline: vi.fn().mockRejectedValue(new Error('Baseline not found')),
    compareWithBaseline: vi.fn().mockResolvedValue(null),
    createSyncDecisions: vi.fn().mockResolvedValue([]),
    applyDecision: vi.fn().mockRejectedValue(new Error('Decision not approved')),
    updateBaseline: vi.fn().mockRejectedValue(new Error('Invalid baseline')),
    getState: vi.fn().mockReturnValue({
      currentBaseline: null,
      lastComparison: null,
      decisions: [],
    }),
  }))
}));