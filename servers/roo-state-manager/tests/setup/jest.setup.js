import { vi, beforeEach } from 'vitest';
// dotenv already loaded by setup-env.ts (setupFiles order)

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
if (!process.env.ROOSYNC_SHARED_PATH) process.env.ROOSYNC_SHARED_PATH = process.env.TMPDIR || process.env.TMP || '/tmp';
if (!process.env.ROOSYNC_MACHINE_ID) process.env.ROOSYNC_MACHINE_ID = 'ci-test-machine';

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

// NOTE: SynthesisOrchestratorService mock removed from jest.setup.js
// SynthesisOrchestratorService tests need the real implementation.
// Tests that use it as a dependency should mock it locally in their test files.

// Mock du système de fichiers
// Mock fs/promises avec toutes les méthodes nécessaires
const mockFsPromises = {
  access: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue(JSON.stringify({})),
  writeFile: vi.fn().mockResolvedValue(undefined),
  readdir: vi.fn().mockResolvedValue(['file1.json', 'file2.json']),
  stat: vi.fn().mockResolvedValue({ isDirectory: () => true, size: 100, mtime: new Date() }),
  mkdir: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
  copyFile: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
  // Méthodes supplémentaires nécessaires pour proper-lockfile
  open: vi.fn().mockResolvedValue({ fd: 1 }),
  close: vi.fn().mockResolvedValue(undefined),
  read: vi.fn().mockResolvedValue({ bytesRead: 0, buffer: Buffer.alloc(0) }),
  write: vi.fn().mockResolvedValue({ bytesWritten: 0, buffer: Buffer.alloc(0) }),
  rename: vi.fn().mockResolvedValue(undefined),
  fstat: vi.fn().mockResolvedValue({ isDirectory: () => true, size: 100, mtime: new Date() }),
  fchmod: vi.fn().mockResolvedValue(undefined),
  fchown: vi.fn().mockResolvedValue(undefined),
  ftruncate: vi.fn().mockResolvedValue(undefined),
  futimes: vi.fn().mockResolvedValue(undefined),
  lstat: vi.fn().mockResolvedValue({ isDirectory: () => true, size: 100, mtime: new Date() }),
  link: vi.fn().mockResolvedValue(undefined),
  symlink: vi.fn().mockResolvedValue(undefined),
  readlink: vi.fn().mockResolvedValue('/mock/link'),
  realpath: vi.fn().mockResolvedValue('/mock/realpath'),
  utimes: vi.fn().mockResolvedValue(undefined),
  chmod: vi.fn().mockResolvedValue(undefined),
  chown: vi.fn().mockResolvedValue(undefined),
  appendFile: vi.fn().mockResolvedValue(undefined),
  rmdir: vi.fn().mockResolvedValue(undefined)
};

// Mock du système de fichiers
const mockFs = {
  existsSync: vi.fn(() => true),
  readFileSync: vi.fn(() => JSON.stringify({})),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(() => ['file1.json', 'file2.json']),
  statSync: vi.fn(() => ({ isDirectory: () => true, size: 100, mtime: new Date() })),
  rmSync: vi.fn(),
  promises: mockFsPromises,
  // Méthodes supplémentaires nécessaires pour proper-lockfile
  openSync: vi.fn(() => ({ fd: 1 })),
  closeSync: vi.fn(),
  readSync: vi.fn(() => ({ bytesRead: 0, buffer: Buffer.alloc(0) })),
  writeSync: vi.fn(() => ({ bytesWritten: 0, buffer: Buffer.alloc(0) })),
  renameSync: vi.fn(),
  fstatSync: vi.fn(() => ({ isDirectory: () => true, size: 100, mtime: new Date() })),
  fchmodSync: vi.fn(),
  fchownSync: vi.fn(),
  ftruncateSync: vi.fn(),
  futimesSync: vi.fn(),
  lstatSync: vi.fn(() => ({ isDirectory: () => true, size: 100, mtime: new Date() })),
  linkSync: vi.fn(),
  symlinkSync: vi.fn(),
  readlinkSync: vi.fn(() => '/mock/link'),
  realpathSync: vi.fn(() => '/mock/realpath'),
  utimesSync: vi.fn(),
  chmodSync: vi.fn(),
  chownSync: vi.fn(),
  appendFileSync: vi.fn(),
  rmdirSync: vi.fn(),
  accessSync: vi.fn(),
  unlinkSync: vi.fn(),
  copyFileSync: vi.fn(),
  // Rendre l'objet extensible pour proper-lockfile
  constants: {
    O_RDONLY: 0,
    O_WRONLY: 1,
    O_RDWR: 2,
    O_CREAT: 64,
    O_EXCL: 128,
    O_NOCTTY: 256,
    O_TRUNC: 512,
    O_APPEND: 1024,
    O_DIRECTORY: 65536,
    O_NOATIME: 262144,
    O_NOFOLLOW: 131072,
    O_SYNC: 1052672,
    O_DSYNC: 4096,
    O_SYMLINK: 2097152,
    O_NONBLOCK: 2048,
    F_OK: 0,
    R_OK: 4,
    W_OK: 2,
    X_OK: 1
  }
};

// Mock global de fs et fs/promises
// Note: Certains tests peuvent surcharger ces mocks avec vi.mock('fs', ...) localement
vi.mock('fs', () => {
  const fsMock = {
    default: mockFs,
    ...mockFs
  };
  // Rendre l'objet extensible
  Object.setPrototypeOf(fsMock, Object.prototype);
  return fsMock;
});

vi.mock('fs/promises', () => {
  const fsPromisesMock = {
    default: mockFsPromises,
    ...mockFsPromises
  };
  // Rendre l'objet extensible
  Object.setPrototypeOf(fsPromisesMock, Object.prototype);
  return fsPromisesMock;
});

// Mock du module path - Utilisation de l'implémentation réelle pour la robustesse
// MAIS avec normalisation forcée pour les tests cross-platform
vi.mock('path', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    default: actual,
    // Surcharge optionnelle si nécessaire pour normaliser les séparateurs
    // normalize: (p) => actual.normalize(p).replace(/\\/g, '/')
  };
});

// Mock du module os
// IMPORTANT: tmpdir doit pointer vers un vrai repertoire pour les tests qui
// utilisent mkdtempSync (HeartbeatService, apply-decision) sans passer par le mock fs.
// /tmp existe sur Linux (CI) et macOS. Sur Windows, ces tests utilisent le mock fs.
// NOTE: Node 20+ exige un export `default` pour les modules mockes utilises via `import os from 'os'`.
vi.mock('os', () => {
  const osMock = {
    platform: vi.fn(() => 'win32'),
    arch: vi.fn(() => 'x64'),
    cpus: vi.fn(() => [{ model: 'test-cpu' }]),
    totalmem: vi.fn(() => 8000000000),
    freemem: vi.fn(() => 4000000000),
    homedir: vi.fn(() => '/mock/home'),
    hostname: vi.fn(() => 'test-machine'),
    tmpdir: vi.fn(() => process.env.TMPDIR || process.env.TMP || '/tmp'),
    uptime: vi.fn(() => 86400),
    EOL: '\n',
    type: vi.fn(() => 'Windows_NT'),
    release: vi.fn(() => '10.0.26200'),
    networkInterfaces: vi.fn(() => ({})),
    userInfo: vi.fn(() => ({ username: 'test-user', homedir: '/mock/home' }))
  };
  return { ...osMock, default: osMock };
});

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
vi.mock('../../src/services/xml-parsing.service.js', () => ({
  extractNewTaskInstructions: vi.fn(() => [
    {
      mode: 'task',
      message: 'Test instruction',
      timestamp: new Date().toISOString()
    }
  ]),
}));

// Mock pour RooStorageDetector
vi.mock('../../src/utils/RooStorageDetector.js', () => ({
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
vi.mock('../../src/services/HierarchyReconstructionEngine.js', () => ({
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

// Mock pour TaskIndexer - Fix #634: Add named export for TypeScript imports
// The import is: import TaskIndexer from './task-indexer.js';
// So we need to export both TaskIndexer (named) and default
const MockTaskIndexer = vi.fn().mockImplementation(() => ({
  getCollectionStatus: vi.fn().mockResolvedValue({
    exists: true,
    pointsCount: 100,
    vectorSize: 1536
  }),
  resetCollection: vi.fn().mockResolvedValue(undefined),
  safeQdrantUpsert: vi.fn().mockResolvedValue(undefined),
  upsertPointsBatch: vi.fn().mockResolvedValue(undefined),
  validateVector: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../src/services/task-indexer.js', () => ({
  TaskIndexer: MockTaskIndexer,
  default: MockTaskIndexer,
}));

// Mock pour PowerShellExecutor - Fix #634: Add named export for TypeScript imports
// The import is: import { PowerShellExecutor } from './PowerShellExecutor.js';
// So we need to export both PowerShellExecutor (named) and default
const mockPowerShellExecutorInstance = {
  executeScript: vi.fn().mockRejectedValue(new Error('PowerShell execution failed: spawn pwsh.exe ENOENT')),
};

const MockPowerShellExecutor = vi.fn().mockImplementation(() => mockPowerShellExecutorInstance);

// Static methods for PowerShellExecutor
MockPowerShellExecutor.setMockPowerShellPath = vi.fn();
MockPowerShellExecutor.parseJsonOutput = vi.fn().mockReturnValue({ success: true, result: {} });
MockPowerShellExecutor.isPowerShellAvailable = vi.fn().mockReturnValue(true);
MockPowerShellExecutor.getPowerShellVersion = vi.fn().mockReturnValue('7.4.0');
MockPowerShellExecutor.getSystemPowerShellPath = vi.fn().mockReturnValue('C:\\Windows\\System32\\pwsh.exe');
MockPowerShellExecutor.getDefaultExecutor = vi.fn().mockReturnValue(mockPowerShellExecutorInstance);

vi.mock('../../src/services/PowerShellExecutor.js', () => ({
  PowerShellExecutor: MockPowerShellExecutor,
  default: MockPowerShellExecutor,
  resetDefaultExecutor: vi.fn(),
  getDefaultExecutor: MockPowerShellExecutor.getDefaultExecutor,
}));

// Mock pour RooSyncService
const mockRooSyncServiceInstance = {
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
  getConfig: vi.fn().mockReturnValue({
    sharedPath: '/mock/roosync/shared-path',
    machineId: 'ci-test-machine',
    autoSync: true,
    conflictStrategy: 'manual',
    logLevel: 'info'
  }),
  resetInstance: vi.fn(),
  getInventory: vi.fn().mockResolvedValue({
    machineId: 'ci-test-machine',
    hostname: 'test-host',
    platform: 'win32',
    arch: 'x64',
    cpus: [{ model: 'test-cpu' }],
    totalMemory: 8000000000,
    freeMemory: 4000000000,
    lastUpdate: new Date().toISOString()
  }),
  clearCache: vi.fn(),
  // getHeartbeatService mock - returns HeartbeatService instance methods
  getHeartbeatService: vi.fn(() => ({
    getHeartbeatData: vi.fn().mockResolvedValue({}),
    registerHeartbeat: vi.fn().mockResolvedValue(undefined),
    updateConfig: vi.fn().mockResolvedValue(undefined),
    startHeartbeatService: vi.fn().mockResolvedValue(undefined),
    stopHeartbeatService: vi.fn().mockResolvedValue(undefined)
  })),
  // getConfigSharingService mock - returns ConfigSharingService instance methods
  // Note: Returns the raw service result format, not the tool-wrapped format
  getConfigSharingService: vi.fn(() => ({
    collectConfig: vi.fn().mockResolvedValue({
      packagePath: '/mock/config-collect',
      manifest: {
        version: '0.0.0',
        timestamp: new Date().toISOString(),
        author: 'test-machine',
        description: 'Mock collect',
        files: []
      },
      filesCount: 0,
      totalSize: 0
    }),
    publishConfig: vi.fn().mockResolvedValue({
      success: true,
      version: '1.0.0',
      publishedPath: '/mock/configs/test-machine/config-1.0.0.json'
    }),
    applyConfig: vi.fn().mockResolvedValue({
      success: true,
      appliedFiles: [],
      backupCreated: false
    }),
    applyProfile: vi.fn().mockResolvedValue({
      success: true,
      profileName: 'test-profile'
    }),
    getDiff: vi.fn().mockResolvedValue({
      added: [],
      modified: [],
      removed: []
    }),
    getConfigVersion: vi.fn().mockResolvedValue('1.0.0')
  })),
  // getDecision mock - delegates to SyncDecisionManager
  // Signature: async getDecision(id: string): Promise<RooSyncDecision | null>
  getDecision: vi.fn().mockResolvedValue({
    id: 'test-decision-id',
    machineId: 'test-machine',
    status: 'applied',
    action: 'apply',
    targetType: 'config',
    targetId: 'test-target',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    changes: [],
    rollbackPoint: '/mock/rollback-point'
  }),
  // restoreFromRollbackPoint mock - delegates to BaselineManager
  // Signature: async restoreFromRollbackPoint(decisionId: string): Promise<RollbackRestoreResult>
  restoreFromRollbackPoint: vi.fn().mockResolvedValue({
    success: true,
    restored: true,
    decisionId: 'test-decision-id',
    timestamp: new Date().toISOString()
  }),
  // getConfigService mock - returns ConfigService instance
  // Signature: getConfigService(): ConfigService
  getConfigService: vi.fn().mockReturnValue({
    loadConfig: vi.fn().mockResolvedValue({}),
    saveConfig: vi.fn().mockResolvedValue(undefined),
    getConfig: vi.fn().mockReturnValue({})
  }),
  // getCommitLogService mock - returns CommitLogService instance
  // Signature: getCommitLogService(): CommitLogService
  getCommitLogService: vi.fn().mockReturnValue({
    logCommit: vi.fn().mockResolvedValue(undefined),
    getRecentCommits: vi.fn().mockResolvedValue([]),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined)
  }),
  // startCommitLogService mock - initializes the commit log service
  // Signature: async startCommitLogService(): Promise<void>
  startCommitLogService: vi.fn().mockResolvedValue(undefined),
  // stopCommitLogService mock - stops the commit log service
  // Signature: async stopCommitLogService(): Promise<void>
  stopCommitLogService: vi.fn().mockResolvedValue(undefined)
};

// Named export for getRooSyncService
const getRooSyncService = vi.fn(() => mockRooSyncServiceInstance);

// Named export for RooSyncServiceError
class MockRooSyncServiceError extends Error {
  constructor(message, code, details) {
    super(`[RooSync Service] ${message}`);
    this.name = 'RooSyncServiceError';
    this.code = code;
    this.details = details;
  }
}

// Fix #634: Correct mock path from tests/setup/jest.setup.js to src/services/RooSyncService.js
// Was '../src/services/RooSyncService.js' which resolves to tests/src/ (wrong, doesn't exist)
// Now '../../src/services/RooSyncService.js' which resolves to src/ (correct)
const mockRooSyncServiceClass = vi.fn().mockImplementation(() => mockRooSyncServiceInstance);
// Add static methods for tests that call them
// getInstance returns the singleton instance (used by most unit tests)
mockRooSyncServiceClass.getInstance = vi.fn((cacheOptions, config) => mockRooSyncServiceInstance);
// resetInstance is called in beforeEach to reset the singleton
mockRooSyncServiceClass.resetInstance = vi.fn();

vi.mock('../../src/services/RooSyncService.js', () => ({
  RooSyncService: mockRooSyncServiceClass,
  getRooSyncService,
  RooSyncServiceError: MockRooSyncServiceError,
  default: mockRooSyncServiceClass,
}));

// NOTE: BaselineService mock removed from jest.setup.js
// BaselineService tests need the real implementation with locally-mocked dependencies.
// Tests that use BaselineService as a dependency should mock it locally in their test files.

// NOTE: ConfigService mock removed from jest.setup.js (ROOT CAUSE FIX #636)
// ConfigService tests need the real implementation with all its methods.
// The global mock only provided 3 methods (loadConfig, saveConfig, getConfig) but
// the real ConfigService has many more methods, causing "not a function" errors.
// Tests that use ConfigService as a dependency should mock it locally in their test files.

// Mock pour InventoryCollector
vi.mock('../../src/services/InventoryCollector.js', () => ({
  InventoryCollector: vi.fn().mockImplementation(() => ({
    collect: vi.fn().mockResolvedValue({
      machineId: 'test-machine',
      hostname: 'test-host',
      platform: 'win32',
      arch: 'x64',
      cpus: [{ model: 'test-cpu' }],
      totalMemory: 8000000000,
      freeMemory: 4000000000,
    }),
    clearCache: vi.fn(),
    getCacheStats: vi.fn().mockReturnValue({ size: 0, entries: [] }),
  })),
}));

// DiffDetector: Unit tests need the real implementation, not a mock
// Tests that depend on DiffDetector should mock it locally in their test files
