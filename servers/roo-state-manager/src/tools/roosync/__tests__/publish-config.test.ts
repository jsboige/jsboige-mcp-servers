/**
 * Tests unitaires pour roosyncPublishConfig
 *
 * Couvre publish-config.ts :
 * - Succès : status, message, version, targetPath, machineId
 * - Propagation ConfigSharingServiceError
 * - Wrapping erreur générique
 *
 * @module tools/roosync/__tests__/publish-config.test
 * @version 1.0.0 (#492)
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// ─────────────────── mocks ───────────────────

const mockPublishConfig = vi.fn();
const mockGetConfigSharingService = vi.fn(() => ({
  publishConfig: mockPublishConfig
}));

vi.mock('../../../services/RooSyncService.js', () => ({
  getRooSyncService: vi.fn(() => ({
    getConfigSharingService: mockGetConfigSharingService
  }))
}));

vi.mock('../../../types/errors.js', () => ({
  ConfigSharingServiceError: class ConfigSharingServiceError extends Error {
    constructor(message: string, public code: string, public context?: any) {
      super(message);
      this.name = 'ConfigSharingServiceError';
    }
  },
  ConfigSharingServiceErrorCode: {
    PUBLISH_FAILED: 'PUBLISH_FAILED'
  }
}));

// ─────────────────── import SUT après mocks ───────────────────

import { roosyncPublishConfig } from '../publish-config.js';
import { ConfigSharingServiceError } from '../../../types/errors.js';

// ─────────────────── tests ───────────────────

describe('roosyncPublishConfig', () => {
  const baseArgs = {
    packagePath: '/tmp/config-package',
    version: '2.2.0',
    description: 'Test config publish'
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockPublishConfig.mockResolvedValue({
      machineId: 'myia-ai-01',
      version: '2.2.0',
      path: '/gdrive/configs/myia-ai-01/config.zip'
    });
  });

  // ── succès ──

  test('retourne status=success sur succès', async () => {
    const result = await roosyncPublishConfig(baseArgs);

    expect(result.status).toBe('success');
  });

  test('retourne la version du résultat', async () => {
    const result = await roosyncPublishConfig(baseArgs);

    expect(result.version).toBe('2.2.0');
  });

  test('retourne le machineId du résultat', async () => {
    const result = await roosyncPublishConfig(baseArgs);

    expect(result.machineId).toBe('myia-ai-01');
  });

  test('retourne le targetPath du résultat', async () => {
    const result = await roosyncPublishConfig(baseArgs);

    expect(result.targetPath).toBe('/gdrive/configs/myia-ai-01/config.zip');
  });

  test('message contient le machineId', async () => {
    const result = await roosyncPublishConfig(baseArgs);

    expect(result.message).toContain('myia-ai-01');
  });

  test('message contient "locale" si machineId absent dans le résultat', async () => {
    mockPublishConfig.mockResolvedValue({ version: '2.2.0', path: '/some/path' });

    const result = await roosyncPublishConfig(baseArgs);

    expect(result.message).toContain('locale');
  });

  test('passe packagePath, version et description au service', async () => {
    await roosyncPublishConfig(baseArgs);

    expect(mockPublishConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        packagePath: '/tmp/config-package',
        version: '2.2.0',
        description: 'Test config publish'
      })
    );
  });

  test('passe machineId optionnel au service', async () => {
    await roosyncPublishConfig({ ...baseArgs, machineId: 'myia-po-2025' });

    expect(mockPublishConfig).toHaveBeenCalledWith(
      expect.objectContaining({ machineId: 'myia-po-2025' })
    );
  });

  // ── erreurs ──

  test('propage ConfigSharingServiceError sans wrapping', async () => {
    const original = new ConfigSharingServiceError('Already published', 'PUBLISH_FAILED');
    mockPublishConfig.mockRejectedValue(original);

    await expect(roosyncPublishConfig(baseArgs)).rejects.toBeInstanceOf(ConfigSharingServiceError);
  });

  test('propage le même objet ConfigSharingServiceError', async () => {
    const original = new ConfigSharingServiceError('Already published', 'PUBLISH_FAILED');
    mockPublishConfig.mockRejectedValue(original);

    let caught: any;
    try {
      await roosyncPublishConfig(baseArgs);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(original);
  });

  test('wrap les erreurs génériques en ConfigSharingServiceError', async () => {
    mockPublishConfig.mockRejectedValue(new Error('Network error'));

    await expect(roosyncPublishConfig(baseArgs))
      .rejects.toBeInstanceOf(ConfigSharingServiceError);
  });

  test('message de wrapping contient l\'erreur originale', async () => {
    mockPublishConfig.mockRejectedValue(new Error('Disk full'));

    await expect(roosyncPublishConfig(baseArgs))
      .rejects.toThrow('Disk full');
  });

  test('message de wrapping mentionne "publication"', async () => {
    mockPublishConfig.mockRejectedValue(new Error('timeout'));

    await expect(roosyncPublishConfig(baseArgs))
      .rejects.toThrow('publication');
  });

  test('wrap les erreurs non-Error (string)', async () => {
    mockPublishConfig.mockRejectedValue('string error');

    await expect(roosyncPublishConfig(baseArgs))
      .rejects.toBeInstanceOf(ConfigSharingServiceError);
  });
});
