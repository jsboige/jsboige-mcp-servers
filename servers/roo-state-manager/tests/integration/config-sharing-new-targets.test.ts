/**
 * Tests I/O reels pour les nouveaux targets de roosync_config
 * (roomodes, model-configs, rules)
 *
 * Issue #433 - Validates real filesystem collect + apply behavior
 * using temp directories instead of mocks.
 *
 * @version 1.0.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Unmock fs to use real filesystem for integration tests
vi.unmock('fs/promises');
vi.unmock('fs');

import { ConfigSharingService } from '../../src/services/ConfigSharingService.js';
import { join } from 'path';
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';

// --- Temp directory paths ---
let tempRoot: string;
let rooExtensionsDir: string; // simulates workspace root
let sharedStateDir: string;   // simulates GDrive shared state
let homeRooDir: string;       // simulates ~/.roo/rules/

// --- Mock InventoryService to point at temp dirs ---
const mockGetMachineInventory = vi.fn();

vi.mock('../../src/services/roosync/InventoryService.js', () => ({
  InventoryService: {
    getInstance: () => ({
      getMachineInventory: mockGetMachineInventory
    })
  }
}));

// Mock ConfigNormalizationService - pass-through (normalize returns input as-is)
vi.mock('../../src/services/ConfigNormalizationService.js', () => ({
  ConfigNormalizationService: class {
    normalize(config: any, _type?: string) { return Promise.resolve(config); }
    denormalize(config: any, _type?: string) { return Promise.resolve(config); }
  }
}));

// Mock Qdrant
vi.mock('@qdrant/js-client-rest', () => ({
  QdrantClient: vi.fn().mockImplementation(() => ({
    getCollections: vi.fn().mockResolvedValue({ collections: [] }),
    createCollection: vi.fn().mockResolvedValue(true),
    upsert: vi.fn().mockResolvedValue(true),
    search: vi.fn().mockResolvedValue([])
  }))
}));

// Mock VectorIndexer
vi.mock('../../src/services/task-indexer/VectorIndexer.js', () => ({
  indexTask: vi.fn().mockResolvedValue([]),
  updateSkeletonIndexTimestamp: vi.fn().mockResolvedValue(undefined),
  resetCollection: vi.fn().mockResolvedValue(undefined),
  countPointsByHostOs: vi.fn().mockResolvedValue(0),
  upsertPointsBatch: vi.fn().mockResolvedValue(undefined),
  qdrantRateLimiter: {}
}));

// Mock RooStorageDetector
vi.mock('../../src/utils/roo-storage-detector.js', () => ({
  RooStorageDetector: {
    detectStorageLocations: vi.fn().mockResolvedValue(['c:/dev/test'])
  }
}));

// Sample fixture data
const SAMPLE_ROOMODES = {
  customModes: [
    {
      slug: 'test-mode',
      name: 'Test Mode',
      roleDefinition: 'A test mode for validation',
      groups: ['read']
    },
    {
      slug: 'complex-mode',
      name: 'Complex Mode',
      roleDefinition: 'A complex mode with tools',
      groups: ['read', 'edit', 'command']
    }
  ]
};

const SAMPLE_MODEL_CONFIGS = {
  profiles: {
    default: {
      provider: 'anthropic',
      model: 'claude-sonnet-4-5-20250929'
    },
    expensive: {
      provider: 'anthropic',
      model: 'claude-opus-4-6'
    }
  }
};

const SAMPLE_RULE_1 = `# Security Rules

## General
- Never expose secrets
- Always validate input
`;

const SAMPLE_RULE_2 = `# Coding Standards

## TypeScript
- Use strict mode
- No any types
`;

describe('#433 - Config Sharing New Targets I/O Tests', () => {
  let service: ConfigSharingService;

  beforeEach(async () => {
    // Create isolated temp directory structure
    tempRoot = await mkdtemp(join(tmpdir(), 'roo-config-test-'));
    rooExtensionsDir = join(tempRoot, 'workspace');
    sharedStateDir = join(tempRoot, 'shared-state');
    homeRooDir = join(tempRoot, 'home-roo');

    await mkdir(rooExtensionsDir, { recursive: true });
    await mkdir(sharedStateDir, { recursive: true });
    await mkdir(join(homeRooDir, 'rules'), { recursive: true });

    // Configure mock inventory to point at temp dirs
    mockGetMachineInventory.mockResolvedValue({
      paths: {
        rooExtensions: rooExtensionsDir,
        mcpSettings: join(tempRoot, 'mock-claude.json')
      }
    });

    // Instantiate service with mock config pointing at temp shared state
    const mockConfigService = {
      getSharedStatePath: vi.fn().mockReturnValue(sharedStateDir),
    } as any;

    const mockInventoryCollector = {
      collectInventory: vi.fn().mockResolvedValue({
        paths: {
          mcpSettings: join(tempRoot, 'mock-claude.json'),
          rooExtensions: rooExtensionsDir
        }
      }),
    } as any;

    service = new ConfigSharingService(mockConfigService, mockInventoryCollector);
  });

  afterEach(async () => {
    // Clean up temp directory
    if (tempRoot && existsSync(tempRoot)) {
      await rm(tempRoot, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  // =====================================================
  // COLLECT TESTS
  // =====================================================

  describe('collectConfig - roomodes', () => {
    it('should collect a real .roomodes JSON file', async () => {
      // Arrange: create a real .roomodes file
      await writeFile(
        join(rooExtensionsDir, '.roomodes'),
        JSON.stringify(SAMPLE_ROOMODES, null, 2)
      );

      // Act
      const result = await service.collectConfig({
        targets: ['roomodes'],
        description: 'Test roomodes collect'
      });

      // Assert
      expect(result.filesCount).toBe(1);
      expect(result.manifest.files[0].type).toBe('roomodes_config');
      expect(result.manifest.files[0].path).toBe('roomodes/.roomodes');
      expect(result.manifest.files[0].size).toBeGreaterThan(0);
      expect(result.manifest.files[0].hash).toBeTruthy();

      // Verify the collected file content matches
      const collectedPath = join(result.packagePath, 'roomodes', '.roomodes');
      expect(existsSync(collectedPath)).toBe(true);
      const content = JSON.parse(await readFile(collectedPath, 'utf-8'));
      expect(content.customModes).toHaveLength(2);
      expect(content.customModes[0].slug).toBe('test-mode');

      // Cleanup temp collect dir
      await rm(result.packagePath, { recursive: true, force: true });
    });

    it('should produce empty manifest when .roomodes is missing', async () => {
      // Act: no .roomodes file exists
      const result = await service.collectConfig({
        targets: ['roomodes'],
        description: 'Test missing roomodes'
      });

      // Assert
      expect(result.filesCount).toBe(0);
      expect(result.manifest.files).toHaveLength(0);

      await rm(result.packagePath, { recursive: true, force: true });
    });
  });

  describe('collectConfig - model-configs', () => {
    it('should collect a real model-configs.json file', async () => {
      // Arrange
      await mkdir(join(rooExtensionsDir, 'roo-config'), { recursive: true });
      await writeFile(
        join(rooExtensionsDir, 'roo-config', 'model-configs.json'),
        JSON.stringify(SAMPLE_MODEL_CONFIGS, null, 2)
      );

      // Act
      const result = await service.collectConfig({
        targets: ['model-configs'],
        description: 'Test model-configs collect'
      });

      // Assert
      expect(result.filesCount).toBe(1);
      expect(result.manifest.files[0].type).toBe('model_config');
      expect(result.manifest.files[0].path).toBe('model-configs/model-configs.json');

      const collectedPath = join(result.packagePath, 'model-configs', 'model-configs.json');
      const content = JSON.parse(await readFile(collectedPath, 'utf-8'));
      expect(content.profiles.default.provider).toBe('anthropic');

      await rm(result.packagePath, { recursive: true, force: true });
    });

    it('should produce empty manifest when model-configs.json is missing', async () => {
      const result = await service.collectConfig({
        targets: ['model-configs'],
        description: 'Test missing model-configs'
      });

      expect(result.filesCount).toBe(0);

      await rm(result.packagePath, { recursive: true, force: true });
    });
  });

  describe('collectConfig - rules', () => {
    it('should collect real .md rule files from rules-global/', async () => {
      // Arrange
      const rulesGlobalDir = join(rooExtensionsDir, 'roo-config', 'rules-global');
      await mkdir(rulesGlobalDir, { recursive: true });
      await writeFile(join(rulesGlobalDir, '00-security.md'), SAMPLE_RULE_1);
      await writeFile(join(rulesGlobalDir, '01-coding.md'), SAMPLE_RULE_2);
      // Non-.md file should be ignored
      await writeFile(join(rulesGlobalDir, 'notes.txt'), 'This should be ignored');

      // Act
      const result = await service.collectConfig({
        targets: ['rules'],
        description: 'Test rules collect'
      });

      // Assert: only .md files collected
      expect(result.filesCount).toBe(2);
      const types = result.manifest.files.map(f => f.type);
      expect(types).toEqual(['rules_config', 'rules_config']);

      const paths = result.manifest.files.map(f => f.path).sort();
      expect(paths).toEqual(['rules/00-security.md', 'rules/01-coding.md']);

      // Verify raw text copy (no JSON normalization)
      const rule1Path = join(result.packagePath, 'rules', '00-security.md');
      const rule1Content = await readFile(rule1Path, 'utf-8');
      expect(rule1Content).toBe(SAMPLE_RULE_1);

      await rm(result.packagePath, { recursive: true, force: true });
    });

    it('should produce empty manifest when rules-global/ is missing', async () => {
      const result = await service.collectConfig({
        targets: ['rules'],
        description: 'Test missing rules'
      });

      expect(result.filesCount).toBe(0);

      await rm(result.packagePath, { recursive: true, force: true });
    });

    it('should ignore non-.md files in rules-global/', async () => {
      const rulesGlobalDir = join(rooExtensionsDir, 'roo-config', 'rules-global');
      await mkdir(rulesGlobalDir, { recursive: true });
      await writeFile(join(rulesGlobalDir, 'readme.txt'), 'Not a rule');
      await writeFile(join(rulesGlobalDir, 'config.json'), '{}');

      const result = await service.collectConfig({
        targets: ['rules'],
        description: 'Test non-md files'
      });

      expect(result.filesCount).toBe(0);

      await rm(result.packagePath, { recursive: true, force: true });
    });
  });

  describe('collectConfig - multiple targets', () => {
    it('should collect roomodes + model-configs + rules together', async () => {
      // Arrange: set up all three
      await writeFile(
        join(rooExtensionsDir, '.roomodes'),
        JSON.stringify(SAMPLE_ROOMODES, null, 2)
      );
      await mkdir(join(rooExtensionsDir, 'roo-config', 'rules-global'), { recursive: true });
      await writeFile(
        join(rooExtensionsDir, 'roo-config', 'model-configs.json'),
        JSON.stringify(SAMPLE_MODEL_CONFIGS, null, 2)
      );
      await writeFile(
        join(rooExtensionsDir, 'roo-config', 'rules-global', '00-security.md'),
        SAMPLE_RULE_1
      );

      // Act
      const result = await service.collectConfig({
        targets: ['roomodes', 'model-configs', 'rules'],
        description: 'Test all new targets'
      });

      // Assert
      expect(result.filesCount).toBe(3); // 1 roomodes + 1 model-configs + 1 rule

      const typeMap = new Map(result.manifest.files.map(f => [f.type, f.path]));
      expect(typeMap.has('roomodes_config')).toBe(true);
      expect(typeMap.has('model_config')).toBe(true);
      expect(typeMap.has('rules_config')).toBe(true);

      await rm(result.packagePath, { recursive: true, force: true });
    });
  });

  // =====================================================
  // APPLY TESTS
  // =====================================================

  describe('applyConfig - roomodes (replacement)', () => {
    it('should apply .roomodes with full replacement (not merge)', async () => {
      // Arrange: set up a published config in shared state
      const machineId = 'test-machine';
      const configVersion = 'v1.0.0-20260209';
      const machineConfigDir = join(sharedStateDir, 'configs', machineId, configVersion);
      await mkdir(machineConfigDir, { recursive: true });

      // Source .roomodes (what we want to apply)
      const sourceRoomodes = { customModes: [{ slug: 'new-mode', name: 'New', roleDefinition: 'New mode', groups: ['read'] }] };
      await mkdir(join(machineConfigDir, 'roomodes'), { recursive: true });
      await writeFile(
        join(machineConfigDir, 'roomodes', '.roomodes'),
        JSON.stringify(sourceRoomodes, null, 2)
      );

      // Manifest
      const manifest = {
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        author: machineId,
        description: 'Test apply',
        files: [{ path: 'roomodes/.roomodes', hash: 'abc', type: 'roomodes_config', size: 100 }]
      };
      await writeFile(join(machineConfigDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

      // latest.json pointer
      await writeFile(
        join(sharedStateDir, 'configs', machineId, 'latest.json'),
        JSON.stringify({ path: machineConfigDir })
      );

      // Existing .roomodes on the "local machine" (should be REPLACED, not merged)
      const existingRoomodes = { customModes: [{ slug: 'old-mode', name: 'Old', roleDefinition: 'Old mode', groups: ['edit'] }] };
      await writeFile(
        join(rooExtensionsDir, '.roomodes'),
        JSON.stringify(existingRoomodes, null, 2)
      );

      // Act
      const result = await service.applyConfig({
        version: 'latest',
        machineId,
        targets: ['roomodes']
      });

      // Assert: file was replaced, not merged
      expect(result.success).toBe(true);
      expect(result.filesApplied).toBe(1);

      const appliedContent = JSON.parse(
        await readFile(join(rooExtensionsDir, '.roomodes'), 'utf-8')
      );
      // Should only have the new mode, not the old one (replacement, not merge)
      expect(appliedContent.customModes).toHaveLength(1);
      expect(appliedContent.customModes[0].slug).toBe('new-mode');

      // Verify backup was created
      const workspaceFiles = await readdir(rooExtensionsDir);
      const backups = workspaceFiles.filter(f => f.startsWith('.roomodes.backup_'));
      expect(backups.length).toBe(1);
    });
  });

  describe('applyConfig - model-configs (replacement)', () => {
    it('should apply model-configs.json with full replacement', async () => {
      const machineId = 'test-machine';
      const configVersion = 'v1.0.0-20260209';
      const machineConfigDir = join(sharedStateDir, 'configs', machineId, configVersion);
      await mkdir(machineConfigDir, { recursive: true });

      // Source model-configs
      const sourceModelConfigs = { profiles: { minimal: { provider: 'openai', model: 'gpt-4o' } } };
      await mkdir(join(machineConfigDir, 'model-configs'), { recursive: true });
      await writeFile(
        join(machineConfigDir, 'model-configs', 'model-configs.json'),
        JSON.stringify(sourceModelConfigs, null, 2)
      );

      const manifest = {
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        author: machineId,
        description: 'Test apply model-configs',
        files: [{ path: 'model-configs/model-configs.json', hash: 'def', type: 'model_config', size: 50 }]
      };
      await writeFile(join(machineConfigDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

      await writeFile(
        join(sharedStateDir, 'configs', machineId, 'latest.json'),
        JSON.stringify({ path: machineConfigDir })
      );

      // Existing model-configs (should be REPLACED)
      await mkdir(join(rooExtensionsDir, 'roo-config'), { recursive: true });
      await writeFile(
        join(rooExtensionsDir, 'roo-config', 'model-configs.json'),
        JSON.stringify(SAMPLE_MODEL_CONFIGS, null, 2)
      );

      // Act
      const result = await service.applyConfig({
        version: 'latest',
        machineId,
        targets: ['model-configs']
      });

      // Assert
      expect(result.success).toBe(true);
      expect(result.filesApplied).toBe(1);

      const appliedContent = JSON.parse(
        await readFile(join(rooExtensionsDir, 'roo-config', 'model-configs.json'), 'utf-8')
      );
      // Should have only the new profile, not the old ones
      expect(appliedContent.profiles.minimal).toBeDefined();
      expect(appliedContent.profiles.default).toBeUndefined();
      expect(appliedContent.profiles.expensive).toBeUndefined();

      // Verify backup
      const configFiles = await readdir(join(rooExtensionsDir, 'roo-config'));
      const backups = configFiles.filter(f => f.startsWith('model-configs.json.backup_'));
      expect(backups.length).toBe(1);
    });
  });

  describe('applyConfig - rules (text copy)', () => {
    it('should apply rules as raw text files (not JSON parsed)', async () => {
      const machineId = 'test-machine';
      const configVersion = 'v1.0.0-20260209';
      const machineConfigDir = join(sharedStateDir, 'configs', machineId, configVersion);
      await mkdir(machineConfigDir, { recursive: true });

      // Source rules
      await mkdir(join(machineConfigDir, 'rules'), { recursive: true });
      await writeFile(join(machineConfigDir, 'rules', '00-security.md'), SAMPLE_RULE_1);
      await writeFile(join(machineConfigDir, 'rules', '01-coding.md'), SAMPLE_RULE_2);

      const manifest = {
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        author: machineId,
        description: 'Test apply rules',
        files: [
          { path: 'rules/00-security.md', hash: 'ghi', type: 'rules_config', size: 60 },
          { path: 'rules/01-coding.md', hash: 'jkl', type: 'rules_config', size: 50 }
        ]
      };
      await writeFile(join(machineConfigDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

      await writeFile(
        join(sharedStateDir, 'configs', machineId, 'latest.json'),
        JSON.stringify({ path: machineConfigDir })
      );

      // Mock homedir() to point at our temp dir
      // The applyConfig uses homedir() for rules destination
      const osModule = await import('os');
      const originalHomedir = osModule.homedir;
      vi.spyOn(osModule, 'homedir').mockReturnValue(join(tempRoot, 'home-roo-parent'));

      // Create the target directory structure
      const rulesDestDir = join(tempRoot, 'home-roo-parent', '.roo', 'rules');
      await mkdir(rulesDestDir, { recursive: true });

      // Pre-existing rule (should get backup)
      await writeFile(join(rulesDestDir, '00-security.md'), '# Old Security Rule');

      // Act
      const result = await service.applyConfig({
        version: 'latest',
        machineId,
        targets: ['rules']
      });

      // Assert
      expect(result.success).toBe(true);
      expect(result.filesApplied).toBe(2);

      // Verify rules are raw text (not JSON)
      const appliedRule1 = await readFile(join(rulesDestDir, '00-security.md'), 'utf-8');
      expect(appliedRule1).toBe(SAMPLE_RULE_1);

      const appliedRule2 = await readFile(join(rulesDestDir, '01-coding.md'), 'utf-8');
      expect(appliedRule2).toBe(SAMPLE_RULE_2);

      // Verify backup was created for the pre-existing file
      const ruleFiles = await readdir(rulesDestDir);
      const backups = ruleFiles.filter(f => f.startsWith('00-security.md.backup_'));
      expect(backups.length).toBe(1);

      // Restore homedir mock
      vi.restoreAllMocks();
    });

    it('should create rules directory if it does not exist', async () => {
      const machineId = 'test-machine';
      const configVersion = 'v1.0.0-20260209';
      const machineConfigDir = join(sharedStateDir, 'configs', machineId, configVersion);
      await mkdir(machineConfigDir, { recursive: true });

      await mkdir(join(machineConfigDir, 'rules'), { recursive: true });
      await writeFile(join(machineConfigDir, 'rules', '00-security.md'), SAMPLE_RULE_1);

      const manifest = {
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        author: machineId,
        description: 'Test rules auto-create dir',
        files: [
          { path: 'rules/00-security.md', hash: 'mno', type: 'rules_config', size: 60 }
        ]
      };
      await writeFile(join(machineConfigDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

      await writeFile(
        join(sharedStateDir, 'configs', machineId, 'latest.json'),
        JSON.stringify({ path: machineConfigDir })
      );

      // Mock homedir to a path WITHOUT existing .roo/rules/
      const osModule = await import('os');
      vi.spyOn(osModule, 'homedir').mockReturnValue(join(tempRoot, 'fresh-home'));

      const rulesDir = join(tempRoot, 'fresh-home', '.roo', 'rules');
      // Do NOT create rulesDir - it should be auto-created

      // Act
      const result = await service.applyConfig({
        version: 'latest',
        machineId,
        targets: ['rules']
      });

      // Assert
      expect(result.success).toBe(true);
      expect(result.filesApplied).toBe(1);
      expect(existsSync(join(rulesDir, '00-security.md'))).toBe(true);

      vi.restoreAllMocks();
    });
  });

  // =====================================================
  // EDGE CASES
  // =====================================================

  describe('edge cases', () => {
    it('should handle invalid .roomodes JSON gracefully', async () => {
      // Arrange: write invalid JSON to .roomodes
      await writeFile(join(rooExtensionsDir, '.roomodes'), 'not valid json {{{');

      // Act & Assert: should throw during collect
      await expect(
        service.collectConfig({ targets: ['roomodes'], description: 'Test invalid JSON' })
      ).rejects.toThrow();
    });

    it('should apply roomodes to a new file (create, not update)', async () => {
      const machineId = 'test-machine';
      const configVersion = 'v1.0.0-20260209';
      const machineConfigDir = join(sharedStateDir, 'configs', machineId, configVersion);
      await mkdir(machineConfigDir, { recursive: true });

      const sourceRoomodes = { customModes: [{ slug: 'fresh', name: 'Fresh', roleDefinition: 'A fresh mode', groups: ['read'] }] };
      await mkdir(join(machineConfigDir, 'roomodes'), { recursive: true });
      await writeFile(
        join(machineConfigDir, 'roomodes', '.roomodes'),
        JSON.stringify(sourceRoomodes, null, 2)
      );

      const manifest = {
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        author: machineId,
        description: 'Test create roomodes',
        files: [{ path: 'roomodes/.roomodes', hash: 'pqr', type: 'roomodes_config', size: 80 }]
      };
      await writeFile(join(machineConfigDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
      await writeFile(
        join(sharedStateDir, 'configs', machineId, 'latest.json'),
        JSON.stringify({ path: machineConfigDir })
      );

      // NO existing .roomodes on the workspace

      // Act
      const result = await service.applyConfig({
        version: 'latest',
        machineId,
        targets: ['roomodes']
      });

      // Assert
      expect(result.success).toBe(true);
      expect(result.filesApplied).toBe(1);

      const content = JSON.parse(await readFile(join(rooExtensionsDir, '.roomodes'), 'utf-8'));
      expect(content.customModes[0].slug).toBe('fresh');

      // No backup should exist (file was created, not updated)
      const files = await readdir(rooExtensionsDir);
      const backups = files.filter(f => f.includes('.backup_'));
      expect(backups.length).toBe(0);
    });

    it('should handle dryRun for apply without modifying files', async () => {
      const machineId = 'test-machine';
      const configVersion = 'v1.0.0-20260209';
      const machineConfigDir = join(sharedStateDir, 'configs', machineId, configVersion);
      await mkdir(machineConfigDir, { recursive: true });

      const sourceRoomodes = { customModes: [{ slug: 'dry', name: 'Dry', roleDefinition: 'Dry run mode', groups: ['read'] }] };
      await mkdir(join(machineConfigDir, 'roomodes'), { recursive: true });
      await writeFile(
        join(machineConfigDir, 'roomodes', '.roomodes'),
        JSON.stringify(sourceRoomodes, null, 2)
      );

      const manifest = {
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        author: machineId,
        description: 'Test dryRun',
        files: [{ path: 'roomodes/.roomodes', hash: 'stu', type: 'roomodes_config', size: 70 }]
      };
      await writeFile(join(machineConfigDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
      await writeFile(
        join(sharedStateDir, 'configs', machineId, 'latest.json'),
        JSON.stringify({ path: machineConfigDir })
      );

      // Pre-existing .roomodes
      const originalContent = JSON.stringify({ customModes: [{ slug: 'original' }] });
      await writeFile(join(rooExtensionsDir, '.roomodes'), originalContent);

      // Act: dryRun
      const result = await service.applyConfig({
        version: 'latest',
        machineId,
        targets: ['roomodes'],
        dryRun: true
      });

      // Assert: no files modified
      expect(result.success).toBe(true);
      expect(result.filesApplied).toBe(0); // dryRun doesn't apply

      const afterContent = await readFile(join(rooExtensionsDir, '.roomodes'), 'utf-8');
      expect(afterContent).toBe(originalContent); // unchanged

      // No backup created either
      const files = await readdir(rooExtensionsDir);
      const backups = files.filter(f => f.includes('.backup_'));
      expect(backups.length).toBe(0);
    });
  });

  // =====================================================
  // ROUND-TRIP TEST (collect -> simulate publish -> apply)
  // =====================================================

  describe('round-trip collect -> apply', () => {
    it('should produce identical content after collect and apply for roomodes', async () => {
      // Arrange: create source .roomodes
      await writeFile(
        join(rooExtensionsDir, '.roomodes'),
        JSON.stringify(SAMPLE_ROOMODES, null, 2)
      );

      // Step 1: Collect
      const collectResult = await service.collectConfig({
        targets: ['roomodes'],
        description: 'Round-trip test'
      });

      // Step 2: Simulate publish by copying collected files to shared state structure
      const machineId = 'round-trip-machine';
      const configVersion = 'v1.0.0-roundtrip';
      const machineConfigDir = join(sharedStateDir, 'configs', machineId, configVersion);
      await mkdir(machineConfigDir, { recursive: true });

      // Copy collected roomodes
      const srcFile = join(collectResult.packagePath, 'roomodes', '.roomodes');
      await mkdir(join(machineConfigDir, 'roomodes'), { recursive: true });
      const collectedContent = await readFile(srcFile, 'utf-8');
      await writeFile(join(machineConfigDir, 'roomodes', '.roomodes'), collectedContent);

      // Write manifest
      await writeFile(
        join(machineConfigDir, 'manifest.json'),
        JSON.stringify(collectResult.manifest, null, 2)
      );

      // Write latest.json
      await writeFile(
        join(sharedStateDir, 'configs', machineId, 'latest.json'),
        JSON.stringify({ path: machineConfigDir })
      );

      // Step 3: Delete the original .roomodes to simulate a fresh machine
      await rm(join(rooExtensionsDir, '.roomodes'));

      // Step 4: Apply
      const applyResult = await service.applyConfig({
        version: 'latest',
        machineId,
        targets: ['roomodes']
      });

      // Assert: the applied content matches the original
      expect(applyResult.success).toBe(true);
      expect(applyResult.filesApplied).toBe(1);

      const finalContent = JSON.parse(
        await readFile(join(rooExtensionsDir, '.roomodes'), 'utf-8')
      );
      expect(finalContent).toEqual(SAMPLE_ROOMODES);

      // Cleanup collect temp
      await rm(collectResult.packagePath, { recursive: true, force: true });
    });
  });
});
