/**
 * Tests for roosync_config apply_profile + --validate flag (#2413)
 *
 * Validates post-apply behavior :
 *  - `validate: true` + propre apply -> validation.success === true
 *  - `validate: true` + .roomodes drift -> validation.success === false + drift array
 *  - `validate: undefined` -> backwards compat, validation absent
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { ConfigArgsSchema, roosyncConfig } from '../config.js';

const mockApplyProfile = vi.fn();
const mockApplyConfig = vi.fn();
const mockCollectConfig = vi.fn();
const mockPublishConfig = vi.fn();
const mockGetConfigVersion = vi.fn();

vi.mock('../../../services/RooSyncService.js', () => ({
  getRooSyncService: () => ({
    getConfigSharingService: () => ({
      collectConfig: mockCollectConfig,
      publishConfig: mockPublishConfig,
      applyConfig: mockApplyConfig,
      applyProfile: mockApplyProfile,
    }),
    getConfigService: () => ({
      getConfigVersion: mockGetConfigVersion,
    }),
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('#2413 — ConfigArgsSchema accepts validate flag', () => {
  test('apply_profile + validate: true is accepted', () => {
    const result = ConfigArgsSchema.parse({
      action: 'apply_profile',
      profileName: 'Production',
      validate: true,
    });
    expect(result.validate).toBe(true);
  });

  test('apply + validate: true is accepted', () => {
    const result = ConfigArgsSchema.parse({
      action: 'apply',
      validate: true,
    });
    expect(result.validate).toBe(true);
  });

  test('validate is optional (backwards compat)', () => {
    const result = ConfigArgsSchema.parse({
      action: 'apply_profile',
      profileName: 'Production',
    });
    expect(result.validate).toBeUndefined();
  });
});

describe('#2413 — apply_profile with validate: true (clean apply)', () => {
  test('validate: true + clean apply -> status success + validation.success true', async () => {
    mockApplyProfile.mockResolvedValue({
      success: true,
      profileName: 'Production',
      modesConfigured: 10,
      apiConfigsCount: 2,
      roomodesGenerated: true,
      validation: {
        performed: true,
        success: true,
        activeApiConfigName: 'default',
        activeApiConfigInSync: undefined,
      },
    });

    const result = await roosyncConfig({
      action: 'apply_profile',
      profileName: 'Production',
      validate: true,
    } as any);

    expect(mockApplyProfile).toHaveBeenCalledWith({
      profileName: 'Production',
      sourceMachineId: undefined,
      backup: true,
      dryRun: false,
      validate: true,
    });
    expect(result.status).toBe('success');
    expect(result.validation).toBeDefined();
    expect(result.validation?.success).toBe(true);
    expect(result.message).toContain('validation OK');
  });
});

describe('#2413 — apply_profile with validate: true (drift detected)', () => {
  test('validate: true + .roomodes apiConfigId drift -> status drift + validation.success false', async () => {
    mockApplyProfile.mockResolvedValue({
      success: true,
      profileName: 'Production',
      modesConfigured: 10,
      apiConfigsCount: 2,
      roomodesGenerated: true,
      validation: {
        performed: true,
        success: false,
        drift: [
          {
            field: 'customModes.code-simple.apiConfigId',
            expected: 'simple',
            actual: 'default',
          },
        ],
      },
    });

    const result = await roosyncConfig({
      action: 'apply_profile',
      profileName: 'Production',
      validate: true,
    } as any);

    expect(result.status).toBe('drift');
    expect(result.validation?.success).toBe(false);
    expect(result.validation?.drift).toHaveLength(1);
    expect(result.validation?.drift?.[0]?.field).toContain('apiConfigId');
    expect(result.message).toContain('drift détecté');
  });
});

describe('#2413 — backwards compat (validate undefined)', () => {
  test('no validate flag -> applyProfile receives validate: undefined, no validation field in result', async () => {
    mockApplyProfile.mockResolvedValue({
      success: true,
      profileName: 'Production',
      modesConfigured: 10,
      apiConfigsCount: 2,
      roomodesGenerated: true,
      // validation absent — service didn't run it
    });

    const result = await roosyncConfig({
      action: 'apply_profile',
      profileName: 'Production',
    } as any);

    expect(mockApplyProfile).toHaveBeenCalledWith({
      profileName: 'Production',
      sourceMachineId: undefined,
      backup: true,
      dryRun: false,
      validate: undefined,
    });
    expect(result.status).toBe('success');
    expect(result.validation).toBeUndefined();
    expect(result.message).not.toContain('validation');
    expect(result.message).not.toContain('drift');
  });
});

describe('#2413 — apply with validate: true', () => {
  test('apply + validate: true + clean -> validation.success true propagated', async () => {
    mockGetConfigVersion.mockResolvedValue(null);
    mockApplyConfig.mockResolvedValue({
      success: true,
      filesApplied: 3,
      validation: {
        performed: true,
        success: true,
        targetValidations: [
          { target: '/tmp/mcp.json', success: true },
          { target: '/tmp/.roomodes', success: true },
          { target: '/tmp/profiles.json', success: true },
        ],
      },
    });

    const result = await roosyncConfig({
      action: 'apply',
      validate: true,
    } as any);

    expect(mockApplyConfig).toHaveBeenCalledWith(expect.objectContaining({
      validate: true,
    }));
    expect(result.status).toBe('success');
    expect(result.validation?.success).toBe(true);
    expect(result.validation?.targetValidations).toHaveLength(3);
  });

  test('apply + validate: true + a target fails -> status drift', async () => {
    mockGetConfigVersion.mockResolvedValue(null);
    mockApplyConfig.mockResolvedValue({
      success: true,
      filesApplied: 2,
      validation: {
        performed: true,
        success: false,
        targetValidations: [
          { target: '/tmp/mcp.json', success: true },
          { target: '/tmp/broken.json', success: false, details: { errors: ['JSON parse error'] } },
        ],
      },
    });

    const result = await roosyncConfig({
      action: 'apply',
      validate: true,
    } as any);

    expect(result.status).toBe('drift');
    expect(result.validation?.success).toBe(false);
    expect(result.message).toContain('drift');
  });
});
