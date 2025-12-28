/**
 * Tests unitaires pour l'outil roosync_compare_config
 * 
 * @module tests/unit/tools/roosync/compare-config
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { roosyncCompareConfig, compareConfigToolMetadata } from '../../../../src/tools/roosync/compare-config.js';

// Mock du service RooSync
const mockRooSyncService = {
  getConfig: vi.fn(),
  loadDashboard: vi.fn(),
  compareRealConfigurations: vi.fn()
};

// Mock de getRooSyncService
vi.mock('../../../../src/services/RooSyncService.js', () => ({
  getRooSyncService: () => mockRooSyncService,
  RooSyncServiceError: class extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.code = code;
      this.name = 'RooSyncServiceError';
    }
  }
}));

describe('roosync_compare_config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('devrait avoir les métadonnées correctes', () => {
    expect(compareConfigToolMetadata.name).toBe('roosync_compare_config');
    expect(compareConfigToolMetadata.description).toContain('Compare les configurations Roo');
    expect(compareConfigToolMetadata.description).toContain('Supporte également la comparaison avec des profils');
    expect(compareConfigToolMetadata.inputSchema.properties.target.description).toContain('ID de la machine cible ou du profil');
  });

  it('devrait supporter la comparaison standard entre deux machines', async () => {
    const args = {
      source: 'local-machine',
      target: 'remote-machine'
    };

    mockRooSyncService.getConfig.mockReturnValue({ machineId: 'local-machine' });
    mockRooSyncService.compareRealConfigurations.mockResolvedValue({
      sourceMachine: 'local-machine',
      targetMachine: 'remote-machine',
      hostId: 'local-host',
      differences: [],
      summary: { total: 0, critical: 0, important: 0, warning: 0, info: 0 }
    });

    const result = await roosyncCompareConfig(args);

    expect(mockRooSyncService.compareRealConfigurations).toHaveBeenCalledWith(
      'local-machine',
      'remote-machine',
      false
    );
    expect(result.source).toBe('local-machine');
    expect(result.target).toBe('remote-machine');
  });

  it('devrait supporter la comparaison avec un profil', async () => {
    const args = {
      source: 'local-machine',
      target: 'profile:dev'
    };

    mockRooSyncService.getConfig.mockReturnValue({ machineId: 'local-machine' });
    mockRooSyncService.compareRealConfigurations.mockResolvedValue({
      sourceMachine: 'local-machine',
      targetMachine: 'profile:dev',
      hostId: 'local-host',
      differences: [],
      summary: { total: 0, critical: 0, important: 0, warning: 0, info: 0 }
    });

    const result = await roosyncCompareConfig(args);

    expect(mockRooSyncService.compareRealConfigurations).toHaveBeenCalledWith(
      'local-machine',
      'profile:dev',
      false
    );
    expect(result.target).toBe('profile:dev');
  });
});