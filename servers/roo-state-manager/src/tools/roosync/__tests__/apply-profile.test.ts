/**
 * Tests for roosync_config apply_profile action
 * #498 Phase 2: Deploy model profiles via roosync_config
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { ConfigArgsSchema, roosyncConfig } from '../config.js';
import { ConfigSharingServiceError, ConfigSharingServiceErrorCode } from '../../../types/errors.js';

// Mock RooSyncService
const mockCollectConfig = vi.fn();
const mockPublishConfig = vi.fn();
const mockApplyConfig = vi.fn();
const mockApplyProfile = vi.fn();
const mockGetConfigVersion = vi.fn();

vi.mock('../../../services/RooSyncService.js', () => ({
  getRooSyncService: () => ({
    getConfigSharingService: () => ({
      collectConfig: mockCollectConfig,
      publishConfig: mockPublishConfig,
      applyConfig: mockApplyConfig,
      applyProfile: mockApplyProfile
    }),
    getConfigService: () => ({
      getConfigVersion: mockGetConfigVersion
    })
  })
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ConfigArgsSchema - apply_profile', () => {
  test('should accept apply_profile action with profileName', () => {
    const result = ConfigArgsSchema.parse({
      action: 'apply_profile',
      profileName: 'Production (Qwen 3.5 local + GLM-5 cloud)'
    });
    expect(result.action).toBe('apply_profile');
    expect(result.profileName).toBe('Production (Qwen 3.5 local + GLM-5 cloud)');
  });

  test('should reject apply_profile without profileName', () => {
    expect(() => ConfigArgsSchema.parse({
      action: 'apply_profile'
    })).toThrow();
  });

  test('should accept apply_profile with sourceMachineId', () => {
    const result = ConfigArgsSchema.parse({
      action: 'apply_profile',
      profileName: 'Production',
      sourceMachineId: 'myia-ai-01'
    });
    expect(result.sourceMachineId).toBe('myia-ai-01');
  });

  test('should accept apply_profile with dryRun', () => {
    const result = ConfigArgsSchema.parse({
      action: 'apply_profile',
      profileName: 'Production',
      dryRun: true
    });
    expect(result.dryRun).toBe(true);
  });

  test('should accept apply_profile with backup=false', () => {
    const result = ConfigArgsSchema.parse({
      action: 'apply_profile',
      profileName: 'Production',
      backup: false
    });
    expect(result.backup).toBe(false);
  });
});

describe('roosyncConfig - apply_profile action', () => {
  test('should call applyProfile with correct options', async () => {
    mockApplyProfile.mockResolvedValue({
      success: true,
      profileName: 'Production (Qwen 3.5 local + GLM-5 cloud)',
      modesConfigured: 15,
      apiConfigsCount: 2,
      backupPath: '/tmp/backup',
      changes: {
        modeApiConfigs: { 'code-simple': 'simple', 'code-complex': 'default' },
        profileThresholds: { simple: 80, default: 80 }
      }
    });

    const result = await roosyncConfig({
      action: 'apply_profile',
      profileName: 'Production (Qwen 3.5 local + GLM-5 cloud)'
    } as any);

    expect(mockApplyProfile).toHaveBeenCalledWith({
      profileName: 'Production (Qwen 3.5 local + GLM-5 cloud)',
      sourceMachineId: undefined,
      backup: true,
      dryRun: false
    });

    expect(result.status).toBe('success');
    expect(result.profileName).toBe('Production (Qwen 3.5 local + GLM-5 cloud)');
    expect(result.modesConfigured).toBe(15);
    expect(result.apiConfigsCount).toBe(2);
  });

  test('should pass sourceMachineId to applyProfile', async () => {
    mockApplyProfile.mockResolvedValue({
      success: true,
      profileName: 'Production',
      modesConfigured: 10,
      apiConfigsCount: 2
    });

    await roosyncConfig({
      action: 'apply_profile',
      profileName: 'Production',
      sourceMachineId: 'myia-ai-01'
    } as any);

    expect(mockApplyProfile).toHaveBeenCalledWith({
      profileName: 'Production',
      sourceMachineId: 'myia-ai-01',
      backup: true,
      dryRun: false
    });
  });

  test('should pass dryRun and backup flags', async () => {
    mockApplyProfile.mockResolvedValue({
      success: true,
      profileName: 'Production',
      modesConfigured: 10,
      apiConfigsCount: 2
    });

    await roosyncConfig({
      action: 'apply_profile',
      profileName: 'Production',
      dryRun: true,
      backup: false
    } as any);

    expect(mockApplyProfile).toHaveBeenCalledWith({
      profileName: 'Production',
      sourceMachineId: undefined,
      backup: false,
      dryRun: true
    });
  });

  test('should return error status when applyProfile fails', async () => {
    mockApplyProfile.mockResolvedValue({
      success: false,
      profileName: 'NonExistent',
      modesConfigured: 0,
      apiConfigsCount: 0,
      errors: ['Profil non trouvé']
    });

    const result = await roosyncConfig({
      action: 'apply_profile',
      profileName: 'NonExistent'
    } as any);

    expect(result.status).toBe('error');
    expect(result.errors).toContain('Profil non trouvé');
  });

  test('should throw when profileName is missing', async () => {
    await expect(roosyncConfig({
      action: 'apply_profile'
    } as any)).rejects.toThrow('profileName est requis');
  });

  test('should propagate ConfigSharingServiceError', async () => {
    mockApplyProfile.mockRejectedValue(
      new ConfigSharingServiceError(
        'model-configs.json non trouvé',
        ConfigSharingServiceErrorCode.PATH_NOT_AVAILABLE,
        {}
      )
    );

    await expect(roosyncConfig({
      action: 'apply_profile',
      profileName: 'Production'
    } as any)).rejects.toThrow('model-configs.json non trouvé');
  });

  test('should include changes in successful result', async () => {
    const changes = {
      modeApiConfigs: {
        'code-simple': 'simple',
        'code-complex': 'default',
        'debug-simple': 'simple',
        'debug-complex': 'default',
        'code': 'default'
      },
      profileThresholds: { simple: 80, default: 80 }
    };

    mockApplyProfile.mockResolvedValue({
      success: true,
      profileName: 'Production',
      modesConfigured: 5,
      apiConfigsCount: 2,
      changes
    });

    const result = await roosyncConfig({
      action: 'apply_profile',
      profileName: 'Production'
    } as any);

    expect(result.changes).toEqual(changes);
    expect(result.changes.modeApiConfigs['code-simple']).toBe('simple');
    expect(result.changes.profileThresholds.simple).toBe(80);
  });
});
