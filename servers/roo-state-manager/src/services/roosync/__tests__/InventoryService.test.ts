import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { InventoryService } from '../InventoryService';

vi.mock('fs/promises');
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    homedir: vi.fn(() => '/mock/home'),
    hostname: vi.fn(() => 'test-machine'),
    type: vi.fn(() => 'Windows_NT'),
    release: vi.fn(() => '10.0.19045'),
    userInfo: vi.fn(() => ({ username: 'test-user' })),
  };
});

// Mock getSharedStatePath used in saveToSharedState
vi.mock('../../../utils/shared-state-path.js', () => ({
  getSharedStatePath: vi.fn(() => '/mock/shared-state'),
}));

// Mock existsSync for saveToSharedState directory creation
vi.mock('fs', () => ({
  existsSync: vi.fn(() => true),
}));

// Mock readJSONFileWithoutBOM for ALL JSON file reads
// (the service uses this for mcp_settings.json, ~/.claude.json, modes.json)
vi.mock('../../../utils/encoding-helpers.js', () => ({
  readJSONFileWithoutBOM: vi.fn(),
}));

import { readJSONFileWithoutBOM } from '../../../utils/encoding-helpers.js';

/**
 * Helper: set up readJSONFileWithoutBOM to return data based on file path substrings.
 * The service reads these paths:
 * - mcp_settings.json → collectMcpServers
 * - .claude.json → collectClaudeConfig
 * - modes.json → collectRooModes
 * - inventories/{id}.json → loadRemoteInventory
 */
function mockReadJSONByPath(pathMap: Record<string, any>) {
  vi.mocked(readJSONFileWithoutBOM).mockImplementation(((filePath: string) => {
    for (const [substring, data] of Object.entries(pathMap)) {
      if (filePath.includes(substring)) {
        return Promise.resolve(data);
      }
    }
    return Promise.reject(new Error(`ENOENT: ${filePath}`));
  }) as any);
}

describe('InventoryService', () => {
  let service: InventoryService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = InventoryService.getInstance();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ============================================================
  // Singleton pattern
  // ============================================================
  describe('getInstance', () => {
    it('should return the same instance (singleton)', () => {
      const a = InventoryService.getInstance();
      const b = InventoryService.getInstance();
      expect(a).toBe(b);
    });
  });

  // ============================================================
  // getMachineInventory — local collection
  // ============================================================
  describe('getMachineInventory (local)', () => {
    it('should collect MCP servers correctly', async () => {
      const mockMcpSettings = {
        mcpServers: {
          'test-server': {
            command: 'node',
            args: ['index.js'],
            disabled: false,
            autoStart: true,
          },
        },
      };

      vi.mocked(fs.access).mockResolvedValue(undefined);
      mockReadJSONByPath({
        'mcp_settings.json': mockMcpSettings,
      });

      const inventory = await service.getMachineInventory();

      expect(inventory.inventory.mcpServers).toHaveLength(1);
      expect(inventory.inventory.mcpServers[0]).toEqual({
        name: 'test-server',
        enabled: true,
        autoStart: true,
        command: 'node',
        transportType: undefined,
        alwaysAllow: undefined,
        description: undefined,
      });
    });

    it('should handle missing MCP settings file gracefully', async () => {
      vi.mocked(fs.access).mockRejectedValue(new Error('ENOENT'));
      // readJSONFileWithoutBOM will also reject since file doesn't exist

      const inventory = await service.getMachineInventory();

      expect(inventory.inventory.mcpServers).toHaveLength(1);
      expect(inventory.inventory.mcpServers[0].status).toBe('absent');
    });

    it('should handle MCP settings read error', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(readJSONFileWithoutBOM).mockRejectedValue(new Error('permission denied'));

      const inventory = await service.getMachineInventory();

      expect(inventory.inventory.mcpServers).toHaveLength(1);
      expect(inventory.inventory.mcpServers[0].status).toBe('error');
      expect(inventory.inventory.mcpServers[0].error).toBe('permission denied');
    });

    it('should mark disabled MCP servers as enabled=false', async () => {
      const mockMcpSettings = {
        mcpServers: {
          'disabled-server': {
            command: 'node',
            disabled: true,
          },
          'active-server': {
            command: 'node',
            disabled: false,
          },
        },
      };

      vi.mocked(fs.access).mockResolvedValue(undefined);
      mockReadJSONByPath({
        'mcp_settings.json': mockMcpSettings,
      });

      const inventory = await service.getMachineInventory();

      const servers = inventory.inventory.mcpServers;
      expect(servers).toHaveLength(2);
      expect(servers.find((s) => s.name === 'disabled-server')?.enabled).toBe(false);
      expect(servers.find((s) => s.name === 'active-server')?.enabled).toBe(true);
    });

    it('should collect system info correctly', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      mockReadJSONByPath({});

      const inventory = await service.getMachineInventory();

      expect(inventory.inventory.systemInfo).toEqual({
        os: 'Windows_NT 10.0.19045',
        hostname: 'test-machine',
        username: 'test-user',
        powershellVersion: '7.x',
      });
    });

    it('should normalize machineId to lowercase', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      mockReadJSONByPath({});
      vi.mocked(fs.writeFile).mockResolvedValue();

      const inventory = await service.getMachineInventory('Test-MACHINE');

      expect(inventory.machineId).toBe('test-machine');
    });

    it('should use hostname when no machineId provided', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      mockReadJSONByPath({});
      vi.mocked(fs.writeFile).mockResolvedValue();

      const inventory = await service.getMachineInventory();

      expect(inventory.machineId).toBe('test-machine');
    });

    it('should return empty scripts (simplified inventory)', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      mockReadJSONByPath({});

      const inventory = await service.getMachineInventory();

      expect(inventory.inventory.scripts.categories).toEqual({});
      expect(inventory.inventory.scripts.all).toEqual([]);
    });

    it('should return empty SDDD specs (simplified inventory)', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      mockReadJSONByPath({});

      const inventory = await service.getMachineInventory();

      expect(inventory.inventory.sdddSpecs).toEqual([]);
    });

    it('should include paths in inventory output', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      mockReadJSONByPath({});

      const inventory = await service.getMachineInventory();

      expect(inventory.paths).toBeDefined();
      expect(inventory.paths.mcpSettings).toContain('globalStorage');
      expect(inventory.paths.claudeJson).toContain('.claude.json');
      expect(inventory.paths.projectMcpJson).toContain('.mcp.json');
      expect(inventory.paths.claudeSettings).toContain('settings.json');
    });

    it('should include timestamp in inventory', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      mockReadJSONByPath({});

      const before = new Date().toISOString();
      const inventory = await service.getMachineInventory();
      const after = new Date().toISOString();

      expect(inventory.timestamp >= before).toBe(true);
      expect(inventory.timestamp <= after).toBe(true);
    });
  });

  // ============================================================
  // collectClaudeConfig
  // ============================================================
  describe('collectClaudeConfig', () => {
    it('should extract model from ~/.claude.json', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      mockReadJSONByPath({
        '.claude.json': { model: 'claude-sonnet-4-6' },
      });
      vi.mocked(fs.writeFile).mockResolvedValue();

      const inventory = await service.getMachineInventory();

      expect(inventory.inventory.claudeConfig).toBeDefined();
      expect(inventory.inventory.claudeConfig?.model).toBe('claude-sonnet-4-6');
    });

    it('should extract env vars from MCP servers in ~/.claude.json', async () => {
      const claudeJson = {
        model: 'claude-sonnet-4-6',
        mcpServers: {
          'roo-state-manager': {
            env: {
              ROOSYNC_MACHINE_ID: 'myia-po-2026',
              QDRANT_URL: 'https://qdrant.myia.io',
              OTHER_VAR: 'ignored',
            },
          },
          'sk-agent': {
            env: {
              OPENAI_API_KEY: 'sk-test',
              EMBEDDING_MODEL: 'text-embedding-3',
            },
          },
        },
      };

      vi.mocked(fs.access).mockResolvedValue(undefined);
      mockReadJSONByPath({
        '.claude.json': claudeJson,
      });
      vi.mocked(fs.writeFile).mockResolvedValue();

      const inventory = await service.getMachineInventory();
      const env = inventory.inventory.claudeConfig?.env;

      expect(env).toBeDefined();
      expect(env?.ROOSYNC_MACHINE_ID).toBe('myia-po-2026');
      expect(env?.QDRANT_URL).toBe('https://qdrant.myia.io');
      expect(env?.OPENAI_API_KEY).toBe('sk-test');
      expect(env?.EMBEDDING_MODEL).toBe('text-embedding-3');
      // OTHER_VAR does not match ROOSYNC_|QDRANT_|OPENAI_|EMBEDDING_
      expect(env?.OTHER_VAR).toBeUndefined();
    });

    it('should deduplicate env vars across MCP servers', async () => {
      const claudeJson = {
        mcpServers: {
          'mcp-a': {
            env: { ROOSYNC_SHARED_PATH: '/path/a' },
          },
          'mcp-b': {
            env: { ROOSYNC_SHARED_PATH: '/path/b' },
          },
        },
      };

      vi.mocked(fs.access).mockResolvedValue(undefined);
      mockReadJSONByPath({
        '.claude.json': claudeJson,
      });
      vi.mocked(fs.writeFile).mockResolvedValue();

      const inventory = await service.getMachineInventory();
      const env = inventory.inventory.claudeConfig?.env;

      // Should take first occurrence
      expect(env?.ROOSYNC_SHARED_PATH).toBe('/path/a');
    });

    it('should count MCP servers in ~/.claude.json', async () => {
      const claudeJson = {
        mcpServers: {
          'server-a': {},
          'server-b': {},
          'server-c': {},
        },
      };

      vi.mocked(fs.access).mockResolvedValue(undefined);
      mockReadJSONByPath({
        '.claude.json': claudeJson,
      });
      vi.mocked(fs.writeFile).mockResolvedValue();

      const inventory = await service.getMachineInventory();

      expect(inventory.inventory.claudeConfig?.mcpServersCount).toBe(3);
    });

    it('should collect migrations from ~/.claude.json', async () => {
      const claudeJson = {
        sonnet45MigrationComplete: true,
        opus45MigrationComplete: false,
        thinkingMigrationComplete: true,
        opusProMigrationComplete: true,
        sonnet1m45MigrationComplete: false,
      };

      vi.mocked(fs.access).mockResolvedValue(undefined);
      mockReadJSONByPath({
        '.claude.json': claudeJson,
      });
      vi.mocked(fs.writeFile).mockResolvedValue();

      const inventory = await service.getMachineInventory();

      const migrations = inventory.inventory.claudeConfig?.migrationsComplete;
      expect(migrations).toBeDefined();
      expect(migrations).toContain('sonnet45');
      expect(migrations).toContain('thinking');
      expect(migrations).toContain('opusPro');
      expect(migrations).not.toContain('opus45');
      expect(migrations).not.toContain('sonnet1m45');
    });

    it('should return undefined claudeConfig when ~/.claude.json missing', async () => {
      // Make access fail for .claude.json but succeed for others
      vi.mocked(fs.access).mockImplementation(async (filePath: string) => {
        if (filePath.toString().includes('.claude.json')) {
          throw new Error('ENOENT');
        }
        return undefined;
      });
      mockReadJSONByPath({
        'mcp_settings.json': {},
      });
      vi.mocked(fs.writeFile).mockResolvedValue();

      const inventory = await service.getMachineInventory();

      expect(inventory.inventory.claudeConfig).toBeUndefined();
    });

    it('should handle ~/.claude.json read error gracefully', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      // readJSONFileWithoutBOM throws for .claude.json but succeeds for mcp_settings
      vi.mocked(readJSONFileWithoutBOM).mockImplementation(((filePath: string) => {
        if (filePath.includes('.claude.json')) {
          return Promise.reject(new Error('corrupt'));
        }
        if (filePath.includes('mcp_settings.json')) {
          return Promise.resolve({});
        }
        return Promise.resolve({});
      }) as any);
      vi.mocked(fs.writeFile).mockResolvedValue();

      // Should not throw
      const inventory = await service.getMachineInventory();
      expect(inventory).toBeDefined();
      expect(inventory.inventory.claudeConfig).toBeUndefined();
    });
  });

  // ============================================================
  // collectRooModes
  // ============================================================
  describe('collectRooModes', () => {
    it('should collect Roo modes from modes.json', async () => {
      const modesJson = {
        modes: [
          { slug: 'code-simple', name: 'Code Simple' },
          { slug: 'code-complex', name: 'Code Complex' },
        ],
      };

      vi.mocked(fs.access).mockResolvedValue(undefined);
      mockReadJSONByPath({
        'modes.json': modesJson,
      });
      vi.mocked(fs.writeFile).mockResolvedValue();

      const inventory = await service.getMachineInventory();

      expect(inventory.inventory.rooModes).toHaveLength(2);
      expect(inventory.inventory.rooModes[0].slug).toBe('code-simple');
    });

    it('should return empty array when modes.json missing', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      // modes.json not in pathMap → ENOENT
      mockReadJSONByPath({
        'mcp_settings.json': {},
      });
      vi.mocked(fs.writeFile).mockResolvedValue();

      const inventory = await service.getMachineInventory();

      expect(inventory.inventory.rooModes).toEqual([]);
    });

    it('should handle modes.json read error gracefully', async () => {
      vi.mocked(fs.access).mockImplementation(async (filePath: string) => {
        if (filePath.toString().includes('modes.json')) {
          throw new Error('ENOENT');
        }
        return undefined;
      });
      vi.mocked(readJSONFileWithoutBOM).mockResolvedValue({});
      vi.mocked(fs.writeFile).mockResolvedValue();

      const inventory = await service.getMachineInventory();

      expect(inventory.inventory.rooModes).toEqual([]);
    });
  });

  // ============================================================
  // loadRemoteInventory
  // ============================================================
  describe('loadRemoteInventory', () => {
    it('should load remote inventory from shared state', async () => {
      const remoteInventory = {
        machineId: 'remote-machine',
        timestamp: '2026-04-01T00:00:00Z',
        inventory: { mcpServers: [], rooModes: [], sdddSpecs: [], scripts: { categories: {}, all: [] }, tools: {}, slashCommands: [], terminalCommands: { allowed: [], restricted: [] }, systemInfo: { os: 'Windows_NT', hostname: 'remote-machine', username: 'user', powershellVersion: '7.x' } },
        paths: {},
      };

      vi.mocked(readJSONFileWithoutBOM).mockResolvedValue(remoteInventory);

      // Set ROOSYNC_SHARED_PATH env var for this test
      const originalEnv = process.env.ROOSYNC_SHARED_PATH;
      process.env.ROOSYNC_SHARED_PATH = '/mock/shared';

      try {
        const inventory = await service.getMachineInventory('remote-machine');

        expect(inventory.machineId).toBe('remote-machine');
        expect(inventory.inventory.systemInfo.hostname).toBe('remote-machine');
      } finally {
        if (originalEnv !== undefined) {
          process.env.ROOSYNC_SHARED_PATH = originalEnv;
        } else {
          delete process.env.ROOSYNC_SHARED_PATH;
        }
      }
    });

    it('should throw when ROOSYNC_SHARED_PATH not configured for remote', async () => {
      const originalEnv = process.env.ROOSYNC_SHARED_PATH;
      delete process.env.ROOSYNC_SHARED_PATH;

      try {
        await expect(service.getMachineInventory('nonexistent-machine'))
          .rejects.toThrow('ROOSYNC_SHARED_PATH');
      } finally {
        if (originalEnv !== undefined) {
          process.env.ROOSYNC_SHARED_PATH = originalEnv;
        }
      }
    });

    it('should throw when remote inventory file not found', async () => {
      const originalEnv = process.env.ROOSYNC_SHARED_PATH;
      process.env.ROOSYNC_SHARED_PATH = '/mock/shared';

      const enoent = new Error('ENOENT') as NodeJS.ErrnoException;
      enoent.code = 'ENOENT';
      vi.mocked(readJSONFileWithoutBOM).mockRejectedValue(enoent);

      try {
        await expect(service.getMachineInventory('ghost-machine'))
          .rejects.toThrow("n'existe pas");
      } finally {
        if (originalEnv !== undefined) {
          process.env.ROOSYNC_SHARED_PATH = originalEnv;
        } else {
          delete process.env.ROOSYNC_SHARED_PATH;
        }
      }
    });

    it('should throw on machineId mismatch in remote inventory', async () => {
      const originalEnv = process.env.ROOSYNC_SHARED_PATH;
      process.env.ROOSYNC_SHARED_PATH = '/mock/shared';

      vi.mocked(readJSONFileWithoutBOM).mockResolvedValue({
        machineId: 'wrong-machine',
        timestamp: '2026-04-01T00:00:00Z',
        inventory: {},
        paths: {},
      });

      try {
        await expect(service.getMachineInventory('expected-machine'))
          .rejects.toThrow('Incoh');
      } finally {
        if (originalEnv !== undefined) {
          process.env.ROOSYNC_SHARED_PATH = originalEnv;
        } else {
          delete process.env.ROOSYNC_SHARED_PATH;
        }
      }
    });

    it('should handle JSON parse error in remote inventory', async () => {
      const originalEnv = process.env.ROOSYNC_SHARED_PATH;
      process.env.ROOSYNC_SHARED_PATH = '/mock/shared';

      vi.mocked(readJSONFileWithoutBOM).mockRejectedValue(new Error('Unexpected token'));

      try {
        await expect(service.getMachineInventory('broken-machine'))
          .rejects.toThrow();
      } finally {
        if (originalEnv !== undefined) {
          process.env.ROOSYNC_SHARED_PATH = originalEnv;
        } else {
          delete process.env.ROOSYNC_SHARED_PATH;
        }
      }
    });
  });

  // ============================================================
  // saveToSharedState
  // ============================================================
  describe('saveToSharedState', () => {
    it('should save inventory to shared state directory', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      mockReadJSONByPath({});
      vi.mocked(fs.writeFile).mockResolvedValue();

      await service.getMachineInventory();

      // writeFile is called for saveToSharedState
      expect(fs.writeFile).toHaveBeenCalled();
      const writeCall = vi.mocked(fs.writeFile).mock.calls.find(
        (call) => call[0].toString().includes('inventories')
      );
      expect(writeCall).toBeDefined();
      expect(writeCall![0].toString()).toContain('test-machine.json');
    });

    it('should create inventories directory if missing', async () => {
      // existsSync returns false → mkdir should be called
      const { existsSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(false);

      vi.mocked(fs.access).mockResolvedValue(undefined);
      mockReadJSONByPath({});
      vi.mocked(fs.writeFile).mockResolvedValue();
      vi.mocked(fs.mkdir).mockResolvedValue(undefined as any);

      await service.getMachineInventory();

      expect(fs.mkdir).toHaveBeenCalled();
      const mkdirCall = vi.mocked(fs.mkdir).mock.calls.find(
        (call) => call[0].toString().includes('inventories')
      );
      expect(mkdirCall).toBeDefined();
      expect(mkdirCall![1]).toEqual({ recursive: true });
    });

    it('should not throw when saveToSharedState fails', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      mockReadJSONByPath({});
      vi.mocked(fs.writeFile).mockRejectedValue(new Error('disk full'));

      // Should NOT throw — saveToSharedState is non-blocking
      const inventory = await service.getMachineInventory();
      expect(inventory).toBeDefined();
    });
  });
});
