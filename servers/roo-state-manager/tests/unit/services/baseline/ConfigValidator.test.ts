import { describe, it, expect, beforeEach } from 'vitest';
import { ConfigValidator } from '../../../../src/services/baseline/ConfigValidator.js';
import { BaselineConfig, BaselineFileConfig, BaselineServiceErrorCode } from '../../../../src/types/baseline.js';

describe('ConfigValidator', () => {
  let validator: ConfigValidator;

  beforeEach(() => {
    validator = new ConfigValidator();
  });

  describe('validateBaselineConfig', () => {
    it('should return true for a valid BaselineConfig', () => {
      const validConfig: BaselineConfig = {
        machineId: 'test-machine',
        version: '1.0.0',
        lastUpdated: '2023-01-01T00:00:00Z',
        config: {
          roo: { modes: [], mcpSettings: {}, userSettings: {} },
          hardware: { cpu: { model: 'test', cores: 4, threads: 8 }, memory: { total: 16000 }, disks: [], gpu: 'test' },
          software: { powershell: '7.0', node: '18.0', python: '3.10' },
          system: { os: 'windows', architecture: 'x64' }
        }
      };

      expect(validator.validateBaselineConfig(validConfig)).toBe(true);
    });

    it('should return false for an invalid BaselineConfig (missing fields)', () => {
      const invalidConfig = {
        machineId: 'test-machine'
        // Missing other required fields
      } as BaselineConfig;

      expect(validator.validateBaselineConfig(invalidConfig)).toBe(false);
    });
  });

  describe('validateBaselineFileConfig', () => {
    it('should return true for a valid BaselineFileConfig', () => {
      const validFileConfig = {
        version: '1.0.0',
        baselineId: 'test-baseline',
        machineId: 'test-machine',
        timestamp: '2023-01-01T00:00:00Z',
        machines: [{
          id: 'test-machine',
          name: 'Test Machine',
          hostname: 'test-machine',
          lastSeen: '2023-01-01T00:00:00Z',
          roo: { modes: [], mcpServers: [], sdddSpecs: [] },
          hardware: { cpu: { cores: 4, threads: 8 }, memory: { total: 16000 } },
          software: { node: '18.0', python: '3.10' },
          os: 'windows',
          architecture: 'x64'
        }]
      } as unknown as BaselineFileConfig;

      expect(validator.validateBaselineFileConfig(validFileConfig)).toBe(true);
    });

    it('should return false for an invalid BaselineFileConfig (missing machines)', () => {
      const invalidFileConfig = {
        version: '1.0.0',
        baselineId: 'test-baseline',
        machineId: 'test-machine',
        timestamp: '2023-01-01T00:00:00Z',
        machines: [] // Empty array
      } as unknown as BaselineFileConfig;

      expect(validator.validateBaselineFileConfig(invalidFileConfig)).toBe(false);
    });
  });

  describe('ensureValidBaselineConfig', () => {
    it('should not throw for a valid BaselineConfig', () => {
      const validConfig: BaselineConfig = {
        machineId: 'test-machine',
        version: '1.0.0',
        lastUpdated: '2023-01-01T00:00:00Z',
        config: {
          roo: { modes: [], mcpSettings: {}, userSettings: {} },
          hardware: { cpu: { model: 'test', cores: 4, threads: 8 }, memory: { total: 16000 }, disks: [], gpu: 'test' },
          software: { powershell: '7.0', node: '18.0', python: '3.10' },
          system: { os: 'windows', architecture: 'x64' }
        }
      };

      expect(() => validator.ensureValidBaselineConfig(validConfig)).not.toThrow();
    });

    it('should throw BaselineServiceError for an invalid BaselineConfig', () => {
      const invalidConfig = {
        machineId: 'test-machine'
      } as BaselineConfig;

      try {
        validator.ensureValidBaselineConfig(invalidConfig);
      } catch (error: any) {
        expect(error.code).toBe(BaselineServiceErrorCode.BASELINE_INVALID);
        expect(error.message).toBe('Configuration baseline invalide');
      }
    });
  });

  describe('ensureValidBaselineFileConfig', () => {
    it('should not throw for a valid BaselineFileConfig', () => {
      const validFileConfig = {
        version: '1.0.0',
        baselineId: 'test-baseline',
        machineId: 'test-machine',
        timestamp: '2023-01-01T00:00:00Z',
        machines: [{
          id: 'test-machine',
          name: 'Test Machine',
          hostname: 'test-machine',
          lastSeen: '2023-01-01T00:00:00Z',
          roo: { modes: [], mcpServers: [], sdddSpecs: [] },
          hardware: { cpu: { cores: 4, threads: 8 }, memory: { total: 16000 } },
          software: { node: '18.0', python: '3.10' },
          os: 'windows',
          architecture: 'x64'
        }]
      } as unknown as BaselineFileConfig;

      expect(() => validator.ensureValidBaselineFileConfig(validFileConfig)).not.toThrow();
    });

    it('should throw BaselineServiceError for an invalid BaselineFileConfig', () => {
      const invalidFileConfig = {
        version: '1.0.0',
        baselineId: 'test-baseline',
        machineId: 'test-machine',
        timestamp: '2023-01-01T00:00:00Z',
        machines: []
      } as unknown as BaselineFileConfig;

      try {
        validator.ensureValidBaselineFileConfig(invalidFileConfig);
      } catch (error: any) {
        expect(error.code).toBe(BaselineServiceErrorCode.BASELINE_INVALID);
        expect(error.message).toBe('Configuration baseline invalide');
      }
    });

    it('should throw BaselineServiceError if required fields are missing', () => {
        const invalidFileConfig = {
            // Missing version, baselineId, machineId, timestamp
            machines: [{
                id: 'test-machine',
                lastSeen: '2023-01-01T00:00:00Z',
                status: 'online',
                roo: { modes: [], mcpServers: [] },
                hardware: { cpu: { cores: 4, threads: 8 }, memory: { total: 16000 } },
                software: { node: '18.0', python: '3.10' },
                os: 'windows',
                architecture: 'x64'
            }]
        } as unknown as BaselineFileConfig;

        try {
            validator.ensureValidBaselineFileConfig(invalidFileConfig);
        } catch (error: any) {
            expect(error.code).toBe(BaselineServiceErrorCode.BASELINE_INVALID);
        }
    });
  });
});