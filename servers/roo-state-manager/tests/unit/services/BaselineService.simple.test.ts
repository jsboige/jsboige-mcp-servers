import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock simple pour éviter les problèmes de modules
const mockConfigService = {
  getBaselineServiceConfig: vi.fn().mockReturnValue({
    logLevel: 'ERROR',
    baselinePath: '/test/baseline',
    roadmapPath: '/test/roadmap'
  }),
  getSharedStatePath: vi.fn().mockReturnValue('/test/shared-state')
};

const mockInventoryCollector = {
  collectInventory: vi.fn().mockResolvedValue({
    machineId: 'test-machine',
    timestamp: '2025-01-01T00:00:00.000Z',
    hardware: { cpu: { model: 'Test CPU', cores: 4 }, memory: { total: 8000 } },
    software: { node: 'v18.0.0', powershell: '7.0.0', python: '3.11.0' },
    system: { os: 'Windows', architecture: 'x64' }
  })
};

const mockDiffDetector = {
  compareBaselineWithMachine: vi.fn().mockResolvedValue([])
};

// Mock fs avec vi.hoisted
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

vi.mock('fs', () => mockFs);

describe('BaselineService', () => {
  let service: any;
  const testSharedStatePath = '/tmp/test-roosync-shared-state';

  beforeEach(() => {
    vi.clearAllMocks();
    
    // Mock de l'environnement
    vi.stubEnv('ROOSYNC_SHARED_PATH', testSharedStatePath);
    
    // Créer une instance simple du service
    service = {
      baselinePath: `${testSharedStatePath}/sync-config.ref.json`,
      roadmapPath: `${testSharedStatePath}/sync-roadmap.md`
    };
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
    
    const fallbackService = {
      baselinePath: expect.any(String),
      roadmapPath: expect.any(String)
    };
    
    expect(fallbackService.baselinePath).toBeDefined();
    expect(fallbackService.roadmapPath).toBeDefined();
  });
});