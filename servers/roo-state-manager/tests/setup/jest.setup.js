import { vi } from 'vitest';

// Configuration globale des mocks pour la console
global.console = {
  ...console,
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn()
};

// Mock des variables d'environnement pour les tests
process.env.NODE_ENV = 'test';
process.env.ROOSYNC_TEST_MODE = 'true';
process.env.QDRANT_URL = 'http://localhost:6333';
process.env.QDRANT_API_KEY = 'test-key';
process.env.OPENAI_API_KEY = 'sk-test-key';
process.env.OPENAI_CHAT_MODEL_ID = 'gpt-4o-mini';
process.env.QDRANT_COLLECTION_NAME = 'roo_tasks_semantic_index';

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

// Mock du système de fichiers
vi.mock('fs', () => ({
  existsSync: vi.fn(() => true),
  readFileSync: vi.fn(() => JSON.stringify({})),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(() => ['file1.json', 'file2.json']),
  statSync: vi.fn(() => ({ isDirectory: () => true }))
}));

// Mock fs/promises avec toutes les méthodes nécessaires
vi.mock('fs/promises', () => {
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
  
  return {
    default: mockFsPromises,
    ...mockFsPromises
  };
});

// Mock du module path
vi.mock('path', () => ({
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
}));

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

// Mock pour SynthesisService
vi.mock('../src/services/synthesis.service.js', () => ({
  default: vi.fn().mockImplementation(() => ({
    generateSynthesis: vi.fn().mockResolvedValue({
      taskId: 'real-task-id',
      analysisEngineVersion: '2.0.0-phase2',
      synthesis: 'Test synthesis content'
    }),
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