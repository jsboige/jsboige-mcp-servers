/**
 * Coverage tests for config.ts — branches non couvertes par le fresh measure
 * (71.72% stmts / 77.77% branch / 100% funcs).
 *
 * Le fresh measure identifiait le plus gros gap = **le short-circuit `env:`
 * rotation** (#2410, L177-237, ~57 LOC) ENTIEREMENT non couvert : la suite
 * existante (config.test.ts 750+ lignes + config.integration.test.ts) couvre
 * targets/publish/apply/scope/apply_profile MAIS aucune rotation de secret
 * `env:`. Second gap = apply_profile validation drift branch (L393-397).
 *
 * Tests ciblés (anti-busy-work #2083 — pas de re-test des paths couverts) :
 *  - env: publish happy-path (multi-target loop + envPath override via process.env)
 *  - env: publish throw quand version/description manquants
 *  - env: apply happy-path (backup default true)
 *  - env: collect → warning 'not applicable'
 *  - apply_profile validation drift (success=false → status 'drift')
 *  - apply_profile validation OK (success=true → message '+ validation OK')
 *
 * @module tools/roosync/__tests__/config.coverage
 * Issue: Vein D Lane R (po-2023) coverage dispatch
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  mockGetConfigSharingService,
  mockGetConfigService,
  mockCollectConfig,
  mockPublishConfig,
  mockApplyConfig,
  mockApplyProfile,
  mockGetSharedStatePath,
  mockGetConfigVersion,
  mockEnvPublish,
  mockEnvApply,
} = vi.hoisted(() => ({
  mockGetConfigSharingService: vi.fn(),
  mockGetConfigService: vi.fn(),
  mockCollectConfig: vi.fn(),
  mockPublishConfig: vi.fn(),
  mockApplyConfig: vi.fn(),
  mockApplyProfile: vi.fn(),
  mockGetSharedStatePath: vi.fn(),
  mockGetConfigVersion: vi.fn(),
  mockEnvPublish: vi.fn(),
  mockEnvApply: vi.fn(),
}));

vi.mock('../../../services/lazy-roosync.js', () => ({
  getRooSyncService: vi.fn(async () => ({
    getConfigSharingService: mockGetConfigSharingService,
    getConfigService: mockGetConfigService,
  })),
}));

vi.mock('../../../types/errors.js', () => ({
  ConfigSharingServiceError: class extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.name = 'ConfigSharingServiceError';
      this.code = code;
    }
  },
  ConfigSharingServiceErrorCode: {
    INVALID_TARGET_FORMAT: 'INVALID_TARGET_FORMAT',
    PUBLISH_FAILED: 'PUBLISH_FAILED',
    COLLECTION_FAILED: 'COLLECTION_FAILED',
  },
}));

vi.mock('../../../services/EnvRotationService.js', () => ({
  EnvRotationService: class {
    publish(...args: unknown[]) { return mockEnvPublish(...args); }
    apply(...args: unknown[]) { return mockEnvApply(...args); }
  },
}));

let roosyncConfig: typeof import('../config.js')['roosyncConfig'];

beforeEach(async () => {
  vi.clearAllMocks();
  mockGetConfigSharingService.mockReturnValue({
    collectConfig: mockCollectConfig,
    publishConfig: mockPublishConfig,
    applyConfig: mockApplyConfig,
    applyProfile: mockApplyProfile,
  });
  mockGetConfigService.mockReturnValue({
    getSharedStatePath: mockGetSharedStatePath,
    getConfigVersion: mockGetConfigVersion,
  });
  mockGetSharedStatePath.mockReturnValue('/shared/state');
  mockGetConfigVersion.mockResolvedValue(null);
  // env defaults
  mockEnvPublish.mockResolvedValue({ service: 'qdrant', ok: true });
  mockEnvApply.mockResolvedValue({ service: 'qdrant', ok: true });

  vi.resetModules();
  ({ roosyncConfig } = await import('../config.js'));
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ============================================================
// env: rotation short-circuit (#2410, L177-237) — publish + apply + collect
// ============================================================
describe('env: rotation short-circuit (#2410, L177-237)', () => {
  test('publish happy-path: iterates env: targets, envPath default config/{service}/.env', async () => {
    mockEnvPublish.mockResolvedValue({ service: 'qdrant', ok: true });

    const result = await roosyncConfig({
      action: 'publish',
      targets: ['env:qdrant', 'env:openai'],
      version: '2.3.0',
      description: 'rotate keys',
    });

    expect(result.status).toBe('success');
    expect(mockEnvPublish).toHaveBeenCalledTimes(2);
    // envPath default = config/qdrant/.env (no _ENV_PATH override)
    const firstCall = mockEnvPublish.mock.calls[0][0] as { service: string; envPath: string };
    expect(firstCall.service).toBe('qdrant');
    expect(firstCall.envPath).toBe('config/qdrant/.env');
  });

  test('publish uses {SERVICE}_ENV_PATH override when present', async () => {
    process.env.QDRANT_ENV_PATH = '/custom/qdrant/.env';
    try {
      await roosyncConfig({
        action: 'publish',
        targets: ['env:qdrant'],
        version: '2.3.0',
        description: 'rotate',
      });

      const call = mockEnvPublish.mock.calls[0][0] as { envPath: string };
      expect(call.envPath).toBe('/custom/qdrant/.env');
    } finally {
      delete process.env.QDRANT_ENV_PATH;
    }
  });

  test('publish throws when version or description missing (L186-192)', async () => {
    await expect(
      roosyncConfig({ action: 'publish', targets: ['env:qdrant'] } as never),
    ).rejects.toMatchObject({
      code: 'INVALID_TARGET_FORMAT',
      message: expect.stringContaining("env: publish requiert 'version' et 'description'"),
    });
    expect(mockEnvPublish).not.toHaveBeenCalled();
  });

  test('apply happy-path: backup defaults to true, iterates targets (L213-230)', async () => {
    mockEnvApply.mockResolvedValue({ service: 'qdrant', ok: true, backupPath: '/bk' });

    const result = await roosyncConfig({
      action: 'apply',
      targets: ['env:qdrant'],
    });

    expect(result.status).toBe('success');
    expect(mockEnvApply).toHaveBeenCalledTimes(1);
    const call = mockEnvApply.mock.calls[0][0] as { backup: boolean; targetEnvPath: string };
    expect(call.backup).toBe(true); // default
    expect(call.targetEnvPath).toBe('config/qdrant/.env');
  });

  test('apply honors explicit backup=false', async () => {
    await roosyncConfig({ action: 'apply', targets: ['env:qdrant'], backup: false });

    const call = mockEnvApply.mock.calls[0][0] as { backup: boolean };
    expect(call.backup).toBe(false);
  });

  test('collect with env: targets → warning "not applicable" (L232-236)', async () => {
    const result = await roosyncConfig({
      action: 'collect',
      targets: ['env:qdrant'],
    } as never);

    expect(result.status).toBe('warning');
    expect(result.message).toContain('not applicable');
    // configSharingService.collectConfig must NOT be called for env targets
    expect(mockCollectConfig).not.toHaveBeenCalled();
  });

  test('non-env targets do not trigger env short-circuit (configSharingService used)', async () => {
    mockCollectConfig.mockResolvedValue({
      filesCount: 2,
      packagePath: '/pkg',
      totalSize: 100,
      manifest: {},
    });

    await roosyncConfig({ action: 'collect', targets: ['mcp', 'modes'] });

    // Mixed targets with NO env: → goes through normal collectConfig
    expect(mockCollectConfig).toHaveBeenCalled();
    expect(mockEnvPublish).not.toHaveBeenCalled();
  });
});

// ============================================================
// apply_profile validation branches (L393-397, L399-415)
// Existing suite mocks validation as undefined → drift + OK-message branches dead.
// ============================================================
describe('apply_profile validation branches (L393-415)', () => {
  test('validation success=false → status "drift" + drift-count message', async () => {
    mockApplyProfile.mockResolvedValue({
      success: true,
      profileName: 'Production',
      modesConfigured: 5,
      apiConfigsCount: 2,
      roomodesGenerated: true,
      validation: { success: false, drift: ['key1', 'key2'] },
    });

    const result = await roosyncConfig({
      action: 'apply_profile',
      profileName: 'Production',
      validate: true,
    });

    expect(result.status).toBe('drift');
    expect(result.message).toContain('drift détecté');
    expect(result.message).toContain('2 entrées');
  });

  test('validation success=true → status "success" + "validation OK" message', async () => {
    mockApplyProfile.mockResolvedValue({
      success: true,
      profileName: 'Production',
      modesConfigured: 5,
      apiConfigsCount: 2,
      roomodesGenerated: true,
      validation: { success: true },
    });

    const result = await roosyncConfig({
      action: 'apply_profile',
      profileName: 'Production',
      validate: true,
    });

    expect(result.status).toBe('success');
    expect(result.message).toContain('validation OK');
  });

  test('roomodes generation failure → "(⚠️ .roomodes non régénéré)" suffix (L389-391)', async () => {
    mockApplyProfile.mockResolvedValue({
      success: true,
      profileName: 'Production',
      modesConfigured: 5,
      apiConfigsCount: 2,
      roomodesGenerated: false,
      errors: ['Erreur de génération .roomodes: permission denied'],
    });

    const result = await roosyncConfig({
      action: 'apply_profile',
      profileName: 'Production',
    });

    expect(result.status).toBe('success');
    expect(result.message).toContain('.roomodes non régénéré');
  });
});
