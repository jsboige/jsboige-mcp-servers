/**
 * #2411 — Tests for schedules target (collect + apply + applyProfile overrides)
 *
 * Covers:
 * - mergeSchedulesById: ID-based merge strategy
 * - schedules target in applyConfig: ID-based merge with backup
 * - schedulesOverrides in applyProfile: profile-level schedule overrides
 * - rulesOverrides in applyProfile: profile-level rules sync
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { existsSync } from 'fs';
import { ConfigSharingService } from '../../../src/services/ConfigSharingService.js';

// Mock InventoryService
const mockGetMachineInventory = vi.fn();
vi.mock('../../../src/services/roosync/InventoryService.js', () => ({
  InventoryService: {
    getInstance: () => ({
      getMachineInventory: mockGetMachineInventory,
    }),
  },
}));

// Mock ConfigService
const mockGetSharedStatePath = vi.fn();
const mockConfigService = {
  getSharedStatePath: mockGetSharedStatePath,
};

// Mock InventoryCollector
const mockInventoryCollector = {
  collectInventory: vi.fn(),
};

// Helper to create a temp directory
async function createTempDir(prefix: string): Promise<string> {
  const tmpDir = path.join(process.cwd(), 'temp', `${prefix}-${Date.now()}`);
  await fs.mkdir(tmpDir, { recursive: true });
  return tmpDir;
}

// Helper to clean up temp directories
async function cleanupTempDir(dir: string) {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {}
}

describe('SchedulesTarget #2411', () => {
  let service: ConfigSharingService;
  let tempDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetSharedStatePath.mockReturnValue('/tmp/shared-state');
    mockGetMachineInventory.mockResolvedValue({
      paths: {
        rooExtensions: path.join(process.cwd(), 'test-workspace'),
        mcpSettings: '/tmp/mcp_settings.json',
      },
    });
    service = new ConfigSharingService(
      mockConfigService as any,
      mockInventoryCollector as any
    );
    tempDir = await createTempDir('sched-test');
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  describe('collectSchedules', () => {
    it('should collect schedules.json from .roo/', async () => {
      const workspaceDir = path.join(tempDir, 'workspace');
      const rooDir = path.join(workspaceDir, '.roo');
      await fs.mkdir(rooDir, { recursive: true });

      const schedulesData = {
        schedules: [
          { id: '123', name: 'Test Schedule', mode: 'code-simple' },
        ],
      };
      await fs.writeFile(
        path.join(rooDir, 'schedules.json'),
        JSON.stringify(schedulesData)
      );

      mockGetMachineInventory.mockResolvedValue({
        paths: { rooExtensions: workspaceDir },
      });

      const result = await service.collectConfig({
        targets: ['schedules'],
      });

      expect(result.filesCount).toBe(1);
      expect(result.manifest.files[0].path).toBe('schedules/schedules.json');
      expect(result.manifest.files[0].type).toBe('schedules_config');
    });

    it('should handle missing schedules.json gracefully', async () => {
      const workspaceDir = path.join(tempDir, 'workspace');
      await fs.mkdir(workspaceDir, { recursive: true });

      mockGetMachineInventory.mockResolvedValue({
        paths: { rooExtensions: workspaceDir },
      });

      const result = await service.collectConfig({
        targets: ['schedules'],
      });

      expect(result.filesCount).toBe(0);
    });
  });

  describe('applyConfig with schedules target', () => {
    it('should merge schedules by ID from package into local', async () => {
      // Setup shared state with package
      const configDir = path.join(tempDir, 'configs', 'machine1', 'v1.0-timestamp');
      const schedulesDir = path.join(configDir, 'schedules');
      await fs.mkdir(schedulesDir, { recursive: true });

      const packageSchedules = {
        schedules: [
          { id: '100', name: 'Updated Schedule', mode: 'code-complex', active: true },
          { id: '200', name: 'New Schedule', mode: 'debug-simple' },
        ],
      };
      await fs.writeFile(
        path.join(schedulesDir, 'schedules.json'),
        JSON.stringify(packageSchedules)
      );

      // Setup manifest
      const manifest = {
        version: '1.0',
        timestamp: new Date().toISOString(),
        author: 'test',
        description: 'test',
        files: [
          {
            path: 'schedules/schedules.json',
            hash: 'abc',
            type: 'schedules_config',
            size: 100,
          },
        ],
      };
      await fs.writeFile(
        path.join(configDir, 'manifest.json'),
        JSON.stringify(manifest)
      );

      // Setup latest.json
      const machineDir = path.join(tempDir, 'configs', 'machine1');
      await fs.writeFile(
        path.join(machineDir, 'latest.json'),
        JSON.stringify({ version: '1.0', path: configDir, manifest })
      );

      // Setup local workspace with existing schedules
      const workspaceDir = path.join(tempDir, 'workspace');
      const rooDir = path.join(workspaceDir, '.roo');
      await fs.mkdir(rooDir, { recursive: true });

      const localSchedules = {
        schedules: [
          { id: '100', name: 'Old Schedule', mode: 'code-simple', active: false },
          { id: '300', name: 'Local Schedule', mode: 'ask-simple' },
        ],
      };
      await fs.writeFile(
        path.join(rooDir, 'schedules.json'),
        JSON.stringify(localSchedules)
      );

      mockGetSharedStatePath.mockReturnValue(path.join(tempDir, 'shared-state'));
      // Create shared-state path structure
      const ssDir = path.join(tempDir, 'shared-state', 'configs', 'machine1');
      await fs.mkdir(ssDir, { recursive: true });
      await fs.writeFile(
        path.join(ssDir, 'latest.json'),
        JSON.stringify({ version: '1.0', path: configDir, manifest })
      );
      // Copy config dir into shared-state
      const ssConfigDir = path.join(tempDir, 'shared-state', 'configs', 'machine1', 'v1.0-timestamp');
      await fs.mkdir(ssConfigDir, { recursive: true });
      const ssSchedulesDir = path.join(ssConfigDir, 'schedules');
      await fs.mkdir(ssSchedulesDir, { recursive: true });
      await fs.writeFile(
        path.join(ssSchedulesDir, 'schedules.json'),
        JSON.stringify(packageSchedules)
      );
      await fs.writeFile(
        path.join(ssConfigDir, 'manifest.json'),
        JSON.stringify(manifest)
      );

      mockGetMachineInventory.mockResolvedValue({
        paths: { rooExtensions: workspaceDir, mcpSettings: '/tmp/mcp.json' },
      });

      const result = await service.applyConfig({
        machineId: 'machine1',
        targets: ['schedules'],
      });

      expect(result.success).toBe(true);
      expect(result.filesApplied).toBeGreaterThanOrEqual(1);

      // Verify merged result
      const mergedRaw = await fs.readFile(
        path.join(rooDir, 'schedules.json'),
        'utf-8'
      );
      const merged = JSON.parse(mergedRaw);

      // Should have 3 schedules: updated 100, new 200, preserved 300
      expect(merged.schedules).toHaveLength(3);

      const schedule100 = merged.schedules.find((s: any) => s.id === '100');
      expect(schedule100.name).toBe('Updated Schedule');
      expect(schedule100.mode).toBe('code-complex');

      const schedule200 = merged.schedules.find((s: any) => s.id === '200');
      expect(schedule200.name).toBe('New Schedule');

      const schedule300 = merged.schedules.find((s: any) => s.id === '300');
      expect(schedule300.name).toBe('Local Schedule');
    });

    it('should create schedules.json if local file does not exist', async () => {
      // Setup shared state
      const ssDir = path.join(tempDir, 'shared-state', 'configs', 'machine1');
      const configDir = path.join(ssDir, 'v1.0-timestamp');
      const schedulesDir = path.join(configDir, 'schedules');
      await fs.mkdir(schedulesDir, { recursive: true });

      const packageSchedules = {
        schedules: [{ id: '400', name: 'Fresh Schedule', mode: 'code-simple' }],
      };
      await fs.writeFile(
        path.join(schedulesDir, 'schedules.json'),
        JSON.stringify(packageSchedules)
      );

      const manifest = {
        version: '1.0',
        timestamp: new Date().toISOString(),
        author: 'test',
        description: 'test',
        files: [
          {
            path: 'schedules/schedules.json',
            hash: 'abc',
            type: 'schedules_config',
            size: 50,
          },
        ],
      };
      await fs.writeFile(
        path.join(configDir, 'manifest.json'),
        JSON.stringify(manifest)
      );
      await fs.writeFile(
        path.join(ssDir, 'latest.json'),
        JSON.stringify({ version: '1.0', path: configDir, manifest })
      );

      mockGetSharedStatePath.mockReturnValue(path.join(tempDir, 'shared-state'));

      // Workspace without .roo/schedules.json
      const workspaceDir = path.join(tempDir, 'workspace');
      await fs.mkdir(workspaceDir, { recursive: true });

      mockGetMachineInventory.mockResolvedValue({
        paths: { rooExtensions: workspaceDir, mcpSettings: '/tmp/mcp.json' },
      });

      const result = await service.applyConfig({
        machineId: 'machine1',
        targets: ['schedules'],
      });

      expect(result.success).toBe(true);

      const created = JSON.parse(
        await fs.readFile(
          path.join(workspaceDir, '.roo', 'schedules.json'),
          'utf-8'
        )
      );
      expect(created.schedules).toHaveLength(1);
      expect(created.schedules[0].id).toBe('400');
    });
  });

  describe('applyProfile with schedulesOverrides', () => {
    it('should merge schedules from profile overrides', async () => {
      const workspaceDir = path.join(tempDir, 'workspace');
      const rooConfigDir = path.join(workspaceDir, 'roo-config');
      const rooDir = path.join(workspaceDir, '.roo');
      await fs.mkdir(rooConfigDir, { recursive: true });
      await fs.mkdir(rooDir, { recursive: true });

      // Create model-configs.json with profile containing schedulesOverrides
      const modelConfigs = {
        profiles: [
          {
            name: 'TestProfile',
            description: 'Test',
            modeOverrides: { 'code-simple': 'default' },
            schedulesOverrides: [
              { id: '100', name: 'Override Schedule', mode: 'code-complex' },
              { id: '500', name: 'New Profile Schedule', mode: 'ask-simple' },
            ],
          },
        ],
        apiConfigs: { default: { id: 'default' } },
      };
      await fs.writeFile(
        path.join(rooConfigDir, 'model-configs.json'),
        JSON.stringify(modelConfigs)
      );

      // Create existing schedules
      const localSchedules = {
        schedules: [
          { id: '100', name: 'Old Schedule', mode: 'code-simple' },
          { id: '300', name: 'Local Only', mode: 'debug-simple' },
        ],
      };
      await fs.writeFile(
        path.join(rooDir, 'schedules.json'),
        JSON.stringify(localSchedules)
      );

      // Create generate-modes.js (mock)
      const scriptsDir = path.join(rooConfigDir, 'scripts');
      await fs.mkdir(scriptsDir, { recursive: true });
      await fs.writeFile(
        path.join(scriptsDir, 'generate-modes.js'),
        'console.log("mock");'
      );

      mockGetMachineInventory.mockResolvedValue({
        paths: { rooExtensions: workspaceDir },
      });

      const result = await service.applyProfile({
        profileName: 'TestProfile',
        generateModes: false, // Skip modes generation for test
      });

      expect(result.success).toBe(true);
      expect(result.schedulesApplied).toBe(2);
      expect(result.changes?.schedulesMerged).toContain('100');
      expect(result.changes?.schedulesMerged).toContain('500');

      // Verify merged schedules
      const merged = JSON.parse(
        await fs.readFile(path.join(rooDir, 'schedules.json'), 'utf-8')
      );
      expect(merged.schedules).toHaveLength(3);

      const s100 = merged.schedules.find((s: any) => s.id === '100');
      expect(s100.name).toBe('Override Schedule');
      expect(s100.mode).toBe('code-complex');

      const s500 = merged.schedules.find((s: any) => s.id === '500');
      expect(s500.name).toBe('New Profile Schedule');

      // Local-only preserved
      const s300 = merged.schedules.find((s: any) => s.id === '300');
      expect(s300.name).toBe('Local Only');
    });

    it('should skip schedules when profile has no schedulesOverrides', async () => {
      const workspaceDir = path.join(tempDir, 'workspace');
      const rooConfigDir = path.join(workspaceDir, 'roo-config');
      await fs.mkdir(rooConfigDir, { recursive: true });

      const modelConfigs = {
        profiles: [
          {
            name: 'NoSchedulesProfile',
            modeOverrides: { 'code-simple': 'default' },
            // No schedulesOverrides
          },
        ],
        apiConfigs: { default: { id: 'default' } },
      };
      await fs.writeFile(
        path.join(rooConfigDir, 'model-configs.json'),
        JSON.stringify(modelConfigs)
      );

      mockGetMachineInventory.mockResolvedValue({
        paths: { rooExtensions: workspaceDir },
      });

      const result = await service.applyProfile({
        profileName: 'NoSchedulesProfile',
        generateModes: false,
      });

      expect(result.success).toBe(true);
      expect(result.schedulesApplied).toBeUndefined();
    });
  });

  describe('applyProfile with rulesOverrides', () => {
    it('should copy rules with + prefix and remove with - prefix', async () => {
      const workspaceDir = path.join(tempDir, 'workspace');
      const rooConfigDir = path.join(workspaceDir, 'roo-config');
      const rooRulesDir = path.join(workspaceDir, '.roo', 'rules');
      const rulesGlobalDir = path.join(rooConfigDir, 'rules-global');
      await fs.mkdir(rooConfigDir, { recursive: true });
      await fs.mkdir(rooRulesDir, { recursive: true });
      await fs.mkdir(rulesGlobalDir, { recursive: true });

      // Source rules in rules-global
      await fs.writeFile(
        path.join(rulesGlobalDir, 'new-rule.md'),
        '# New Rule\nContent here'
      );

      // Existing rule to remove
      await fs.writeFile(
        path.join(rooRulesDir, 'old-rule.md'),
        '# Old Rule\nRemove this'
      );

      // Local rule that should be preserved
      await fs.writeFile(
        path.join(rooRulesDir, 'keep-local.md'),
        '# Keep Me'
      );

      const modelConfigs = {
        profiles: [
          {
            name: 'RulesProfile',
            modeOverrides: { 'code-simple': 'default' },
            rulesOverrides: ['+new-rule.md', '-old-rule.md'],
          },
        ],
        apiConfigs: { default: { id: 'default' } },
      };
      await fs.writeFile(
        path.join(rooConfigDir, 'model-configs.json'),
        JSON.stringify(modelConfigs)
      );

      mockGetMachineInventory.mockResolvedValue({
        paths: { rooExtensions: workspaceDir },
      });

      const result = await service.applyProfile({
        profileName: 'RulesProfile',
        generateModes: false,
      });

      expect(result.success).toBe(true);
      expect(result.rulesApplied).toBe(2);
      expect(result.changes?.rulesSynced).toContain('new-rule.md');
      expect(result.changes?.rulesSynced).toContain('old-rule.md');

      // new-rule.md should exist
      const newRule = await fs.readFile(
        path.join(rooRulesDir, 'new-rule.md'),
        'utf-8'
      );
      expect(newRule).toContain('New Rule');

      // old-rule.md should be removed
      await expect(
        fs.access(path.join(rooRulesDir, 'old-rule.md'))
      ).rejects.toThrow();

      // keep-local.md should be preserved
      const localRule = await fs.readFile(
        path.join(rooRulesDir, 'keep-local.md'),
        'utf-8'
      );
      expect(localRule).toContain('Keep Me');
    });

    it('should not remove *-local.md files', async () => {
      const workspaceDir = path.join(tempDir, 'workspace');
      const rooConfigDir = path.join(workspaceDir, 'roo-config');
      const rooRulesDir = path.join(workspaceDir, '.roo', 'rules');
      await fs.mkdir(rooConfigDir, { recursive: true });
      await fs.mkdir(rooRulesDir, { recursive: true });

      await fs.writeFile(
        path.join(rooRulesDir, 'my-local.md'),
        '# Local Rule'
      );

      const modelConfigs = {
        profiles: [
          {
            name: 'ProtectLocalProfile',
            modeOverrides: { 'code-simple': 'default' },
            rulesOverrides: ['-my-local.md'],
          },
        ],
        apiConfigs: { default: { id: 'default' } },
      };
      await fs.writeFile(
        path.join(rooConfigDir, 'model-configs.json'),
        JSON.stringify(modelConfigs)
      );

      mockGetMachineInventory.mockResolvedValue({
        paths: { rooExtensions: workspaceDir },
      });

      const result = await service.applyProfile({
        profileName: 'ProtectLocalProfile',
        generateModes: false,
      });

      expect(result.success).toBe(true);

      // my-local.md should still exist (protected)
      const content = await fs.readFile(
        path.join(rooRulesDir, 'my-local.md'),
        'utf-8'
      );
      expect(content).toContain('Local Rule');
    });
  });
});
