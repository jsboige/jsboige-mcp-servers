import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BaselineLoader } from '../../../../src/services/baseline/BaselineLoader.js';
import { ConfigValidator } from '../../../../src/services/baseline/ConfigValidator.js';
import { BaselineServiceErrorCode } from '../../../../src/types/baseline.js';
import { promises as fs } from 'fs';
import { existsSync } from 'fs';

// Mock fs
vi.mock('fs', () => ({
  promises: {
    readFile: vi.fn()
  },
  existsSync: vi.fn()
}));

describe('BaselineLoader', () => {
  let loader: BaselineLoader;
  let mockValidator: ConfigValidator;

  beforeEach(() => {
    mockValidator = {
      ensureValidBaselineFileConfig: vi.fn(),
      validateBaselineFileConfig: vi.fn(),
      validateBaselineConfig: vi.fn(),
      ensureValidBaselineConfig: vi.fn()
    } as unknown as ConfigValidator;

    loader = new BaselineLoader(mockValidator);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('loadBaseline', () => {
    it('should return null if file does not exist', async () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const result = await loader.loadBaseline('non-existent-file.json');

      expect(result).toBeNull();
      expect(existsSync).toHaveBeenCalledWith('non-existent-file.json');
    });

    it('should load and transform baseline file correctly', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      const mockContent = JSON.stringify({
        version: '1.0.0',
        baselineId: 'test-baseline',
        machineId: 'test-machine',
        timestamp: '2023-01-01T00:00:00Z',
        machines: [{
          id: 'test-machine',
          roo: {
            modes: ['code'],
            mcpServers: [{ name: 'test-server', enabled: true, command: 'node', autoStart: true, transportType: 'stdio' }]
          },
          hardware: { cpu: { cores: 4, threads: 8 }, memory: { total: 16000 } },
          software: { node: '18.0', python: '3.10' },
          os: 'windows',
          architecture: 'x64'
        }]
      });
      vi.mocked(fs.readFile).mockResolvedValue(mockContent);

      const result = await loader.loadBaseline('baseline.json');

      expect(result).not.toBeNull();
      expect(result?.machineId).toBe('test-machine');
      expect(result?.config.roo.modes).toEqual(['code']);
      expect(result?.config.roo.mcpSettings).toHaveProperty('test-server');
      expect(mockValidator.ensureValidBaselineFileConfig).toHaveBeenCalled();
    });

    it('should throw BASELINE_INVALID error for invalid JSON', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(fs.readFile).mockResolvedValue('invalid-json');

      try {
        await loader.loadBaseline('baseline.json');
      } catch (error: any) {
        expect(error.code).toBe(BaselineServiceErrorCode.BASELINE_INVALID);
      }
    });

    it('should propagate validation errors', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(fs.readFile).mockResolvedValue('{}');
      vi.mocked(mockValidator.ensureValidBaselineFileConfig).mockImplementation(() => {
        throw new Error('Validation failed');
      });

      await expect(loader.loadBaseline('baseline.json')).rejects.toThrow('Validation failed');
    });
  });

  describe('readBaselineFile', () => {
    it('should throw BASELINE_NOT_FOUND if file does not exist', async () => {
      vi.mocked(existsSync).mockReturnValue(false);

      try {
        await loader.readBaselineFile('non-existent.json');
      } catch (error: any) {
        expect(error.code).toBe(BaselineServiceErrorCode.BASELINE_NOT_FOUND);
      }
    });

    it('should return parsed content for valid file', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      const mockObj = { version: '1.0.0' };
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(mockObj));

      const result = await loader.readBaselineFile('baseline.json');

      expect(result).toEqual(mockObj);
    });
  });

  describe('transformBaselineForDiffDetector', () => {
    it('should transform BaselineFileConfig to BaselineConfig', () => {
      const fileConfig: any = {
        version: '1.0.0',
        baselineId: 'test-baseline',
        machineId: 'test-machine',
        timestamp: '2023-01-01T00:00:00Z',
        machines: [{
          id: 'test-machine',
          roo: {
            modes: ['code'],
            mcpServers: [{ name: 'test-server', enabled: true, command: 'node', autoStart: true, transportType: 'stdio' }]
          },
          hardware: { cpu: { cores: 4, threads: 8 }, memory: { total: 16000 } },
          software: { node: '18.0', python: '3.10' },
          os: 'windows',
          architecture: 'x64'
        }]
      };

      const result = loader.transformBaselineForDiffDetector(fileConfig);

      expect(result.machineId).toBe('test-machine');
      expect(result.config.roo.modes).toEqual(['code']);
      expect(result.config.roo.mcpSettings['test-server'].enabled).toBe(true);
      expect(result.config.hardware.cpu.cores).toBe(4);
      expect(result.config.software.node).toBe('18.0');
    });

    it('should handle missing machine data gracefully', () => {
      const fileConfig: any = {
        version: '1.0.0',
        baselineId: 'test-baseline',
        machineId: 'test-machine',
        timestamp: '2023-01-01T00:00:00Z',
        machines: []
      };

      const result = loader.transformBaselineForDiffDetector(fileConfig);

      expect(result.machineId).toBe('test-machine');
      expect(result.config.roo.modes).toEqual([]);
      expect(result.config.hardware.cpu.cores).toBe(0);
    });
  });
});