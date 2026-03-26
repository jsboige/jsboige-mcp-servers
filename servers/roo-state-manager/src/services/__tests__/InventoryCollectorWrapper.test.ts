/**
 * Tests pour InventoryCollectorWrapper
 * Issue #833 - Test Suite Audit - P0: Service sans test
 *
 * Coverage: Services 96% → 100%
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InventoryCollectorWrapper } from '../InventoryCollectorWrapper.js';
import { InventoryCollector, type MachineInventory } from '../InventoryCollector.js';
import { InventoryCollectorError, InventoryCollectorErrorCode } from '../../types/errors.js';

// Mock des modules
vi.mock('fs', () => ({
  promises: {
    readdir: vi.fn(),
    readFile: vi.fn()
  },
  existsSync: vi.fn()
}));

vi.mock('path', () => ({
  join: vi.fn((...args) => args.join('/'))
}));

vi.mock('../../utils/server-helpers.js', () => ({
  getSharedStatePath: vi.fn(() => '/mock/shared-state')
}));

vi.mock('../../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}));

vi.mock('../roosync/InventoryService.js', () => ({
  InventoryService: {
    getInstance: vi.fn(() => ({
      getMachineInventory: vi.fn().mockResolvedValue(null)
    }))
  }
}));

import { promises as fs } from 'fs';
import { existsSync } from 'fs';

describe('InventoryCollectorWrapper', () => {
  let wrapper: InventoryCollectorWrapper;
  let mockCollector: InventoryCollector;

  beforeEach(() => {
    vi.clearAllMocks();

    // Créer un mock de l'InventoryCollector
    mockCollector = {
      collectInventory: vi.fn().mockResolvedValue(null),
      getCacheStats: vi.fn().mockReturnValue({ size: 0, entries: [] }),
      clearCache: vi.fn()
    } as unknown as InventoryCollector;

    wrapper = new InventoryCollectorWrapper(mockCollector);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Constructor', () => {
    it('should create instance with InventoryCollector', () => {
      expect(wrapper).toBeInstanceOf(InventoryCollectorWrapper);
    });
  });

  describe('collectInventory - Shared State Loading', () => {
    it('should return inventory from exact file match when exists', async () => {
      // Arrange
      const machineId = 'myia-ai-01';
      const mockInventory = {
        machineId,
        timestamp: '2025-10-02T12:00:00Z',
        config: {
          roo: { modes: ['code'], mcpServers: {} },
          hardware: { cpu: { cores: 8, threads: 16 }, memory: { total: 32000000000 }, disks: [], gpu: 'None' },
          software: { powershell: '5.1', node: '20.0.0', python: '3.11' },
          system: { os: 'Windows 11', architecture: 'x64' }
        }
      };

      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(mockInventory));

      // Act
      const result = await wrapper.collectInventory(machineId);

      // Assert
      expect(result).not.toBeNull();
      expect(result?.machineId).toBe(machineId);
    });

    it('should handle case-insensitive file matching', async () => {
      // Arrange
      const machineId = 'MYIA-AI-01';
      const mockInventory = {
        machineId: 'myia-ai-01',
        timestamp: '2025-10-02T12:00:00Z',
        config: {
          roo: { modes: [], mcpServers: {} },
          hardware: { cpu: { cores: 8, threads: 16 }, memory: { total: 32000000000 }, disks: [], gpu: 'None' },
          software: { powershell: '5.1', node: '20.0.0', python: '3.11' },
          system: { os: 'Windows 11', architecture: 'x64' }
        }
      };

      vi.mocked(existsSync).mockImplementation((path) => {
        if (typeof path === 'string' && path.includes('myia-ai-01.json')) return true;
        return false;
      });
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(mockInventory));

      // Act
      const result = await wrapper.collectInventory(machineId);

      // Assert
      expect(result).not.toBeNull();
      expect(result?.machineId).toBe('myia-ai-01');
    });

    it('should strip BOM from JSON content', async () => {
      // Arrange
      const machineId = 'myia-ai-01';
      const mockInventory = {
        machineId,
        timestamp: '2025-10-02T12:00:00Z',
        config: {
          roo: { modes: [], mcpServers: {} },
          hardware: { cpu: { cores: 8, threads: 16 }, memory: { total: 32000000000 }, disks: [], gpu: 'None' },
          software: { powershell: '5.1', node: '20.0.0', python: '3.11' },
          system: { os: 'Windows 11', architecture: 'x64' }
        }
      };

      // BOM UTF-8 = 0xFEFF
      const jsonWithBOM = '\uFEFF' + JSON.stringify(mockInventory);

      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(fs.readFile).mockResolvedValue(jsonWithBOM);

      // Act
      const result = await wrapper.collectInventory(machineId);

      // Assert
      expect(result).not.toBeNull();
      expect(result?.machineId).toBe(machineId);
    });

    it('should search for timestamped files when exact match not found', async () => {
      // Arrange
      const machineId = 'myia-po-2024';
      const mockInventory = {
        machineId,
        timestamp: '2025-10-02T12:00:00Z',
        config: {
          roo: { modes: [], mcpServers: {} },
          hardware: { cpu: { cores: 8, threads: 16 }, memory: { total: 16000000000 }, disks: [], gpu: 'None' },
          software: { powershell: '5.1', node: '20.0.0', python: '3.11' },
          system: { os: 'Windows 11', architecture: 'x64' }
        }
      };

      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(fs.readdir).mockResolvedValue([
        'myia-po-2024-2025-10-18T11-36-21-070Z.json',
        'myia-po-2024-2025-10-17T14-20-00-000Z.json'
      ] as any);
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(mockInventory));

      // Act
      const result = await wrapper.collectInventory(machineId);

      // Assert
      expect(result).not.toBeNull();
      expect(result?.machineId).toBe(machineId);
    });

    it('should prioritize -fixed files over regular files', async () => {
      // Arrange
      const machineId = 'myia-po-2024';
      const fixedInventory = {
        machineId,
        timestamp: '2025-10-18T12:00:00Z',
        config: {
          roo: { modes: [], mcpServers: {} },
          hardware: { cpu: { cores: 8, threads: 16 }, memory: { total: 16000000000 }, disks: [], gpu: 'None' },
          software: { powershell: '5.1', node: '20.0.0', python: '3.11' },
          system: { os: 'Windows 11', architecture: 'x64' }
        }
      };

      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(fs.readdir).mockResolvedValue([
        'myia-po-2024-2025-10-18T11-36-21-070Z.json',
        'myia-po-2024-2025-10-18T11-36-21-070Z-fixed.json'
      ] as any);

      // Le fichier -fixed doit être lu en priorité
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(fixedInventory));

      // Act
      const result = await wrapper.collectInventory(machineId);

      // Assert
      expect(result).not.toBeNull();
      expect(result?.machineId).toBe(machineId);
    });

    it('should return null when no inventory files found in shared state', async () => {
      // Arrange
      const machineId = 'unknown-machine';
      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(fs.readdir).mockResolvedValue([]);
      vi.mocked(mockCollector.collectInventory).mockResolvedValue(null);

      // Act & Assert
      await expect(wrapper.collectInventory(machineId)).rejects.toThrow(InventoryCollectorError);
    });
  });

  describe('collectInventory - Fallback Chain', () => {
    it('should fallback to InventoryCollector when shared state fails', async () => {
      // Arrange
      const machineId = 'myia-ai-01';
      const localInventory: MachineInventory = {
        machineId,
        timestamp: '2025-10-02T12:00:00Z',
        hardware: {
          cpu: { cores: 8, threads: 16 },
          memory: { total: 32000000000 },
          disks: [{ drive: 'C', size: 512000000000 }],
          gpu: [{ name: 'NVIDIA RTX 3080' }]
        },
        software: {
          powershell: '5.1',
          node: '20.0.0',
          python: '3.11'
        },
        system: {
          os: 'Windows 11 Pro',
          architecture: 'x64'
        },
        metadata: {
          collectionDuration: 1500,
          source: 'local',
          collectorVersion: '1.0.0'
        }
      };

      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(fs.readdir).mockRejectedValue(new Error('Directory not found'));
      vi.mocked(mockCollector.collectInventory).mockResolvedValue(localInventory);

      // Act
      const result = await wrapper.collectInventory(machineId);

      // Assert
      expect(result).not.toBeNull();
      expect(result?.machineId).toBe(machineId);
      expect(mockCollector.collectInventory).toHaveBeenCalledWith(machineId, false);
    });

    it('should throw InventoryCollectorError when all sources fail', async () => {
      // Arrange
      const machineId = 'broken-machine';
      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(fs.readdir).mockRejectedValue(new Error('No access'));
      vi.mocked(mockCollector.collectInventory).mockRejectedValue(new Error('Local failed'));

      // Act & Assert
      await expect(wrapper.collectInventory(machineId)).rejects.toThrow(InventoryCollectorError);
    });

    it('should pass forceRefresh to underlying collector', async () => {
      // Arrange
      const machineId = 'myia-ai-01';
      const localInventory: MachineInventory = {
        machineId,
        timestamp: '2025-10-02T12:00:00Z',
        hardware: {
          cpu: { cores: 8, threads: 16 },
          memory: { total: 32000000000 },
          disks: [],
          gpu: []
        },
        software: { powershell: '5.1', node: '20.0.0', python: '3.11' },
        system: { os: 'Windows 11', architecture: 'x64' },
        metadata: { collectionDuration: 500, source: 'local', collectorVersion: '1.0.0' }
      };

      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(fs.readdir).mockRejectedValue(new Error('No files'));
      vi.mocked(mockCollector.collectInventory).mockResolvedValue(localInventory);

      // Act
      await wrapper.collectInventory(machineId, true);

      // Assert
      expect(mockCollector.collectInventory).toHaveBeenCalledWith(machineId, true);
    });
  });

  describe('collectInventory - Error Handling', () => {
    it('should handle JSON parse errors gracefully', async () => {
      // Arrange
      const machineId = 'myia-ai-01';
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(fs.readFile).mockResolvedValue('invalid json {{{');
      vi.mocked(fs.readdir).mockResolvedValue([]);
      vi.mocked(mockCollector.collectInventory).mockResolvedValue(null);

      // Act & Assert
      await expect(wrapper.collectInventory(machineId)).rejects.toThrow();
    });

    it('should handle empty directory gracefully', async () => {
      // Arrange
      const machineId = 'new-machine';
      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(fs.readdir).mockResolvedValue([]);
      vi.mocked(mockCollector.collectInventory).mockResolvedValue(null);

      // Act & Assert
      await expect(wrapper.collectInventory(machineId)).rejects.toThrow(InventoryCollectorError);
    });
  });

  describe('File Selection Logic', () => {
    it('should select most recent file by timestamp', async () => {
      // Arrange
      const machineId = 'myia-po-2024';
      const recentInventory = {
        machineId,
        timestamp: '2025-10-18T12:00:00Z',
        config: {
          roo: { modes: [], mcpServers: {} },
          hardware: { cpu: { cores: 8, threads: 16 }, memory: { total: 16000000000 }, disks: [], gpu: 'None' },
          software: { powershell: '5.1', node: '20.0.0', python: '3.11' },
          system: { os: 'Windows 11', architecture: 'x64' }
        }
      };

      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(fs.readdir).mockResolvedValue([
        'myia-po-2024-2025-10-17T10-00-00-000Z.json',  // Older
        'myia-po-2024-2025-10-18T15-30-00-000Z.json'   // Newer
      ] as any);
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(recentInventory));

      // Act
      const result = await wrapper.collectInventory(machineId);

      // Assert
      expect(result).not.toBeNull();
      expect(fs.readdir).toHaveBeenCalled();
    });

    it('should handle files without timestamp using fallback', async () => {
      // Arrange
      const machineId = 'myia-po-2024';
      const inventory = {
        machineId,
        timestamp: '2025-10-18T12:00:00Z',
        config: {
          roo: { modes: [], mcpServers: {} },
          hardware: { cpu: { cores: 8, threads: 16 }, memory: { total: 16000000000 }, disks: [], gpu: 'None' },
          software: { powershell: '5.1', node: '20.0.0', python: '3.11' },
          system: { os: 'Windows 11', architecture: 'x64' }
        }
      };

      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(fs.readdir).mockResolvedValue([
        'myia-po-2024-no-timestamp.json'
      ] as any);
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(inventory));

      // Act
      const result = await wrapper.collectInventory(machineId);

      // Assert
      expect(result).not.toBeNull();
    });
  });

  describe('Format Conversion', () => {
    it('should convert legacy format to baseline format correctly', async () => {
      // Arrange
      const machineId = 'myia-ai-01';
      const legacyInventory = {
        machineId,
        timestamp: '2025-10-02T12:00:00Z',
        roo: {
          modes: ['code', 'debug'],
          mcpServers: { 'test-server': { enabled: true } }
        },
        hardware: {
          cpu: { cores: 8, threads: 16 },
          memory: { total: 32000000000 },
          disks: [{ drive: 'C', size: 512000000000 }],
          gpu: [{ name: 'NVIDIA RTX 3080' }]
        },
        software: { powershell: '5.1', node: '20.0.0', python: '3.11' },
        system: { os: 'Windows 11', architecture: 'x64' }
      };

      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(legacyInventory));

      // Act
      const result = await wrapper.collectInventory(machineId);

      // Assert
      expect(result).not.toBeNull();
      expect(result?.config.roo.modes).toEqual(['code', 'debug']);
      expect(result?.config.hardware.cpu.cores).toBe(8);
      expect(result?.config.software.powershell).toBe('5.1');
      expect(result?.config.system.os).toBe('Windows 11');
    });

    it('should preserve paths field when available', async () => {
      // Arrange
      const machineId = 'myia-ai-01';
      const inventoryWithPaths = {
        machineId,
        timestamp: '2025-10-02T12:00:00Z',
        config: {
          roo: { modes: [], mcpServers: {} },
          hardware: { cpu: { cores: 8, threads: 16 }, memory: { total: 32000000000 }, disks: [], gpu: 'None' },
          software: { powershell: '5.1', node: '20.0.0', python: '3.11' },
          system: { os: 'Windows 11', architecture: 'x64' }
        },
        paths: {
          rooExtensions: '/path/to/extensions',
          mcpSettings: '/path/to/mcp',
          rooConfig: '/path/to/config',
          scripts: '/path/to/scripts'
        }
      };

      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(inventoryWithPaths));

      // Act
      const result = await wrapper.collectInventory(machineId);

      // Assert
      expect(result).not.toBeNull();
      expect(result?.paths).toBeDefined();
      expect(result?.paths?.rooExtensions).toBe('/path/to/extensions');
    });
  });
});
