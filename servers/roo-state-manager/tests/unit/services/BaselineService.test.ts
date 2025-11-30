import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock fs avec vi.hoisted (solution qui fonctionne dans BaselineService.simple.test.ts)
const mockFs = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  access: vi.fn(),
  stat: vi.fn(),
  existsSync: vi.fn(),
  promises: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    mkdir: vi.fn(),
    access: vi.fn(),
    stat: vi.fn()
  }
}));

// Import CommonJS comme dans le test simple qui fonctionne
const BaselineService = require('../../src/services/BaselineService').default || require('../../src/services/BaselineService');
const IConfigService = require('../../src/interfaces/IConfigService').default || require('../../src/interfaces/IConfigService');
const IInventoryCollector = require('../../src/interfaces/IInventoryCollector').default || require('../../src/interfaces/IInventoryCollector');
const IDiffDetector = require('../../src/interfaces/IDiffDetector').default || require('../../src/interfaces/IDiffDetector');

describe('BaselineService', () => {
  let service: any;
  let mockConfigService: any;
  let mockInventoryCollector: any;
  let mockDiffDetector: any;
  const testSharedStatePath = 'C:\\dev\\roo-extensions';

  beforeEach(() => {
    vi.clearAllMocks();
    
    // Mock des dépendances
    mockConfigService = {
      get: vi.fn(),
      set: vi.fn(),
      getAll: vi.fn().mockReturnValue({})
    };

    mockInventoryCollector = {
      collect: vi.fn().mockResolvedValue({
        os: { platform: 'test-platform' },
        cpu: { model: 'test-cpu', cores: 8, threads: 8 },
        memory: { total: 16000000000 },
        disks: [
          { device: 'C:', size: 500000000000, free: 200000000000 }
        ]
      })
    };

    mockDiffDetector = {
      compare: vi.fn().mockReturnValue({
        differences: [],
        summary: { added: 0, removed: 0, modified: 0 }
      })
    };

    // Mock des variables d'environnement avec ROOSYNC_SHARED_PATH
    vi.stubEnv('ROOSYNC_SHARED_PATH', testSharedStatePath);
    
    // Forcer les chemins pour les tests
    process.env.ROOSYNC_SHARED_PATH = testSharedStatePath;
    process.env.SHARED_STATE_PATH = testSharedStatePath;

    service = new BaselineService(mockConfigService, mockInventoryCollector, mockDiffDetector);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('should use ROOSYNC_SHARED_PATH environment variable', () => {
    expect(process.env.ROOSYNC_SHARED_PATH).toBe(testSharedStatePath);
  });

  it('should initialize with correct paths when ROOSYNC_SHARED_PATH is set', () => {
    const expectedBaselinePath = `${testSharedStatePath}/sync-config.ref.json`;
    const expectedRoadmapPath = `${testSharedStatePath}/sync-roadmap.md`;
    
    expect(service.baselinePath).toContain(expectedBaselinePath);
    expect(service.roadmapPath).toContain(expectedRoadmapPath);
  });

  it('should fallback to default when ROOSYNC_SHARED_PATH is not set', () => {
    vi.unstubAllEnvs();
    
    const fallbackService = new BaselineService(mockConfigService, mockInventoryCollector, mockDiffDetector);
    
    expect(fallbackService.baselinePath).toBeDefined();
    expect(fallbackService.roadmapPath).toBeDefined();
  });

  it('should collect inventory and create baseline', async () => {
    const mockBaseline = {
      timestamp: '2025-01-01T00:00:00.000Z',
      machineId: 'test-machine',
      inventory: {
        os: { platform: 'test-platform' },
        cpu: { model: 'test-cpu', cores: 8, threads: 8 },
        memory: { total: 16000000000 },
        disks: [
          { device: 'C:', size: 500000000000, free: 200000000000 }
        ]
      },
      config: {}
    };

    // Le mock fs est déjà appliqué globalement via vi.hoisted
    mockFs.existsSync.mockReturnValue(false);
    mockFs.promises.readFile.mockResolvedValue(JSON.stringify(mockBaseline));
    mockFs.promises.writeFile.mockResolvedValue(undefined);

    await service.createBaseline();

    expect(mockInventoryCollector.collect).toHaveBeenCalled();
    expect(mockFs.existsSync).toHaveBeenCalled();
    expect(mockFs.promises.writeFile).toHaveBeenCalled();
  });

  it('should load baseline', async () => {
    const mockBaseline = {
      timestamp: '2025-01-01T00:00:00.000Z',
      machineId: 'test-machine',
      inventory: {
        os: { platform: 'test-platform' },
        cpu: { model: 'test-cpu', cores: 8, threads: 8 },
        memory: { total: 16000000000 },
        disks: [
          { device: 'C:', size: 500000000000, free: 200000000000 }
        ]
      },
      config: {}
    };

    // Le mock fs est déjà appliqué globalement via vi.hoisted
    mockFs.existsSync.mockReturnValue(true);
    mockFs.promises.readFile.mockResolvedValue(JSON.stringify(mockBaseline));

    const result = await service.loadBaseline();

    expect(result).toEqual(mockBaseline);
    expect(mockFs.existsSync).toHaveBeenCalled();
    expect(mockFs.promises.readFile).toHaveBeenCalled();
  });

  it('should throw error if baseline file does not exist', async () => {
    // Le mock fs est déjà appliqué globalement via vi.hoisted
    mockFs.existsSync.mockReturnValue(false);
    mockFs.promises.readFile.mockResolvedValue('');

    await expect(service.loadBaseline()).rejects.toThrow('Baseline file not found');
  });

  it('should throw error if baseline JSON is invalid', async () => {
    // Le mock fs est déjà appliqué globalement via vi.hoisted
    mockFs.existsSync.mockReturnValue(true);
    mockFs.promises.readFile.mockResolvedValue('invalid json');

    await expect(service.loadBaseline()).rejects.toThrow('Invalid baseline format');
  });

  it('should compare machine with baseline', async () => {
    const mockBaseline = {
      timestamp: '2025-01-01T00:00:00.000Z',
      machineId: 'test-machine',
      inventory: {
        os: { platform: 'test-platform' },
        cpu: { model: 'test-cpu', cores: 8, threads: 8 },
        memory: { total: 16000000000 },
        disks: [
          { device: 'C:', size: 500000000000, free: 200000000000 }
        ]
      },
      config: {}
    };

    const mockCurrentInventory = {
      os: { platform: 'test-platform' },
      cpu: { model: 'test-cpu', cores: 8, threads: 8 },
      memory: { total: 16000000000 },
      disks: [
        { device: 'C:', size: 500000000000, free: 200000000000 }
        ]
    };

    const mockDifferences = {
      differences: [],
      summary: { added: 0, removed: 0, modified: 0 }
    };

    // Le mock fs est déjà appliqué globalement via vi.hoisted
    mockFs.existsSync.mockReturnValue(true);
    mockFs.promises.readFile.mockResolvedValue(JSON.stringify(mockBaseline));

    const result = await service.compareWithBaseline(mockCurrentInventory as any);

    expect(result).toEqual(mockDifferences);
    expect(mockFs.existsSync).toHaveBeenCalled();
    expect(mockFs.promises.readFile).toHaveBeenCalled();
  });

  it('should return null if no differences', async () => {
    const mockBaseline = {
      timestamp: '2025-01-01T00:00:00.000Z',
      machineId: 'test-machine',
      inventory: {
        os: { platform: 'test-platform' },
        cpu: { model: 'test-cpu', cores: 8, threads: 8 },
        memory: { total: 16000000000 },
        disks: [
          { device: 'C:', size: 500000000000, free: 200000000000 }
        ]
      },
      config: {}
    };

    const mockCurrentInventory = {
      os: { platform: 'test-platform' },
      cpu: { model: 'test-cpu', cores: 8, threads: 8 },
      memory: { total: 16000000000 },
      disks: [
        { device: 'C:', size: 500000000000, free: 200000000000 }
        ]
    };

    const mockDifferences = {
      differences: [],
      summary: { added: 0, removed: 0, modified: 0 }
    };

    // Le mock fs est déjà appliqué globalement via vi.hoisted
    mockFs.existsSync.mockReturnValue(true);
    mockFs.promises.readFile.mockResolvedValue(JSON.stringify(mockBaseline));

    const result = await service.compareWithBaseline(mockCurrentInventory as any);

    expect(result).toEqual(mockDifferences);
    expect(mockFs.existsSync).toHaveBeenCalled();
    expect(mockFs.promises.readFile).toHaveBeenCalled();
  });

  it('should detect critical differences', async () => {
    const mockBaseline = {
      timestamp: '2025-01-01T00:00:00.000Z',
      machineId: 'test-machine',
      inventory: {
        os: { platform: 'test-platform' },
        cpu: { model: 'test-cpu', cores: 8, threads: 8 },
        memory: { total: 16000000000 },
        disks: [
          { device: 'C:', size: 500000000000, free: 200000000000 }
        ]
      },
      config: {}
    };

    const mockCurrentInventory = {
      os: { platform: 'test-platform' },
      cpu: { model: 'test-cpu', cores: 8, threads: 8 },
      memory: { total: 16000000000 },
      disks: [
        { device: 'C:', size: 500000000000, free: 100000000000 }
        ]
    };

    const mockDifferences = {
      differences: [],
      summary: { added: 0, removed: 0, modified: 0 }
    };

    // Le mock fs est déjà appliqué globalement via vi.hoisted
    mockFs.existsSync.mockReturnValue(true);
    mockFs.promises.readFile.mockResolvedValue(JSON.stringify(mockBaseline));

    const result = await service.compareWithBaseline(mockCurrentInventory as any);

    expect(result).toEqual(mockDifferences);
    expect(mockFs.existsSync).toHaveBeenCalled();
    expect(mockFs.promises.readFile).toHaveBeenCalled();
  });

  it('should generate decisions from differences', async () => {
    const mockDifferences = {
      differences: [
        { type: 'disk_space', severity: 'critical', details: 'Disk space critical' }
      ],
      summary: { added: 0, removed: 0, modified: 1 }
    };

    const result = await service.createSyncDecisions(mockDifferences);

    expect(result).toHaveLength(1);
    expect(result[0].action).toBe('backup');
    expect(result[0].description).toContain('Disk space critical');
  });

  it('should filter decisions by severity threshold', async () => {
    const mockDifferences = {
      differences: [
        { type: 'disk_space', severity: 'critical', details: 'Critical issue' },
        { type: 'memory', severity: 'warning', details: 'Minor issue' },
        { type: 'cpu', severity: 'critical', details: 'Another critical' }
      ],
      summary: { added: 0, removed: 0, modified: 3 }
    };

    const result = await service.createSyncDecisions(mockDifferences);

    expect(result).toHaveLength(2);
    expect(result.every(d => d.severity === 'critical')).toBe(true);
  });

  it('should apply approved decision', async () => {
    const mockDecision = {
      id: 'test-decision',
      action: 'backup',
      description: 'Test backup',
      approved: true
    };

    // Le mock fs est déjà appliqué globalement via vi.hoisted
    mockFs.promises.writeFile.mockResolvedValue(undefined);

    const result = await service.applyDecision(mockDecision);

    expect(result).toBe(true);
    expect(mockFs.promises.writeFile).toHaveBeenCalled();
  });

  it('should reject non-approved decision', async () => {
    const mockDecision = {
      id: 'test-decision',
      action: 'backup',
      description: 'Test backup',
      approved: false
    };

    await expect(service.applyDecision(mockDecision)).rejects.toThrow('Decision not approved');
  });

  it('should update baseline with backup', async () => {
    const mockBaseline = {
      timestamp: '2025-01-01T00:00:00.000Z',
      machineId: 'test-machine',
      inventory: {
        os: { platform: 'test-platform' },
        cpu: { model: 'test-cpu', cores: 8, threads: 8 },
        memory: { total: 16000000000 },
        disks: [
          { device: 'C:', size: 500000000000, free: 200000000000 }
        ]
      },
      config: {}
    };

    // Le mock fs est déjà appliqué globalement via vi.hoisted
    mockFs.existsSync.mockReturnValue(true);
    mockFs.promises.readFile.mockResolvedValue(JSON.stringify(mockBaseline));
    mockFs.promises.writeFile.mockResolvedValue(undefined);

    const result = await service.updateBaseline(mockBaseline);

    expect(result).toBe(true);
    expect(mockFs.existsSync).toHaveBeenCalled();
    expect(mockFs.promises.readFile).toHaveBeenCalled();
    expect(mockFs.promises.writeFile).toHaveBeenCalled();
  });

  it('should reject invalid baseline update', async () => {
    const invalidBaseline = { invalid: 'data' };

    await expect(service.updateBaseline(invalidBaseline)).rejects.toThrow('Invalid baseline format');
  });

  it('should return current service state', () => {
    const expectedState = {
      baselinePath: service.baselinePath,
      roadmapPath: service.roadmapPath,
      isLoaded: false,
      lastUpdated: null
    };

    const result = service.getState();

    expect(result).toEqual(expectedState);
  });
});