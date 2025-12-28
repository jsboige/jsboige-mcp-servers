import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConfigSharingService } from '../ConfigSharingService';
import { IConfigService, IInventoryCollector } from '../../types/baseline';
import { ConfigNormalizationService } from '../ConfigNormalizationService';

// Mock ConfigNormalizationService
vi.mock('../ConfigNormalizationService', () => {
  const ConfigNormalizationService = vi.fn();
  ConfigNormalizationService.prototype.normalize = vi.fn().mockImplementation((config) => Promise.resolve(config));
  return { ConfigNormalizationService };
});

describe('ConfigSharingService', () => {
  let service: ConfigSharingService;
  let mockConfigService: IConfigService;
  let mockInventoryCollector: IInventoryCollector;

  beforeEach(() => {
    mockConfigService = {
      getSharedStatePath: vi.fn().mockReturnValue('/mock/shared/state'),
    } as any;

    mockInventoryCollector = {
      collectInventory: vi.fn().mockResolvedValue({}),
    } as any;

    service = new ConfigSharingService(mockConfigService, mockInventoryCollector);
  });

  it('should initialize correctly', () => {
    expect(service).toBeDefined();
  });

  describe('compareWithBaseline', () => {
    it('should return a diff result', async () => {
      const config = { test: 'value' };
      const result = await service.compareWithBaseline(config);
      
      expect(result).toBeDefined();
      expect(result.changes).toBeDefined();
      expect(result.summary).toBeDefined();
    });
  });
});