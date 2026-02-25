/**
 * Tests unitaires pour DeploymentHelpers
 *
 * Couvre :
 * - executeDeploymentScript : succès
 * - executeDeploymentScript : échec (exitCode != 0)
 * - executeDeploymentScript : exception interne
 * - executeDeploymentScript : dryRun ajoute -WhatIf
 * - deployModes, deployMCPs, createCleanModes, forceDeployWithEncodingFix
 * - createProfile : passe le nom du profil
 * - getDeploymentHelpers : singleton
 * - resetDeploymentHelpers : réinitialise le singleton
 *
 * @module utils/__tests__/deployment-helpers.test
 * @version 1.0.0 (#492)
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// ─────────────────── mocks (vi.hoisted) ───────────────────
// restoreMocks: true (vitest.config.ts) appelle mockRestore() après chaque test.
// Toutes les références aux mock functions doivent passer par vi.hoisted().

const {
  mockExecuteScript,
  mockLoggerInfo,
  mockLoggerError,
  mockCreateLogger,
  MockPowerShellExecutor,
} = vi.hoisted(() => {
  const mockExecuteScript = vi.fn();
  const mockLoggerInfo = vi.fn();
  const mockLoggerError = vi.fn();
  const mockCreateLogger = vi.fn();
  const MockPowerShellExecutor = vi.fn().mockImplementation(() => ({
    executeScript: mockExecuteScript,
  }));
  return { mockExecuteScript, mockLoggerInfo, mockLoggerError, mockCreateLogger, MockPowerShellExecutor };
});

vi.mock('../../services/PowerShellExecutor.js', () => ({
  PowerShellExecutor: MockPowerShellExecutor,
}));

vi.mock('../logger.js', () => ({
  createLogger: (...args: any[]) => mockCreateLogger(...args),
}));

import {
  DeploymentHelpers,
  getDeploymentHelpers,
  resetDeploymentHelpers,
} from '../deployment-helpers.js';

// ─────────────────── helpers ───────────────────

function makeSuccessResult(overrides: Partial<{ stdout: string; stderr: string; exitCode: number }> = {}) {
  return {
    success: true,
    exitCode: overrides.exitCode ?? 0,
    stdout: overrides.stdout ?? 'OK',
    stderr: overrides.stderr ?? '',
  };
}

function makeFailureResult(exitCode = 1) {
  return {
    success: false,
    exitCode,
    stdout: '',
    stderr: 'Error output',
  };
}

// ─────────────────── setup ───────────────────

let helpers: DeploymentHelpers;

beforeEach(() => {
  vi.clearAllMocks();
  resetDeploymentHelpers();

  // Re-appliquer les implémentations après restoreMocks: true
  mockCreateLogger.mockReturnValue({
    info: mockLoggerInfo,
    error: mockLoggerError,
    warn: vi.fn(),
    debug: vi.fn(),
  });
  MockPowerShellExecutor.mockImplementation(() => ({
    executeScript: mockExecuteScript,
  }));

  helpers = new DeploymentHelpers('/scripts');
});

// ─────────────────── tests ───────────────────

describe('DeploymentHelpers', () => {

  // ============================================================
  // executeDeploymentScript - succès
  // ============================================================

  describe('executeDeploymentScript - succès', () => {
    test('retourne success=true si executor retourne success=true', async () => {
      mockExecuteScript.mockResolvedValue(makeSuccessResult());

      const result = await helpers.executeDeploymentScript('test.ps1');

      expect(result.success).toBe(true);
    });

    test('retourne le nom du script', async () => {
      mockExecuteScript.mockResolvedValue(makeSuccessResult());

      const result = await helpers.executeDeploymentScript('deploy-modes.ps1');

      expect(result.scriptName).toBe('deploy-modes.ps1');
    });

    test('retourne stdout et stderr du résultat executor', async () => {
      mockExecuteScript.mockResolvedValue(makeSuccessResult({ stdout: 'Deploy OK', stderr: 'warn' }));

      const result = await helpers.executeDeploymentScript('test.ps1');

      expect(result.stdout).toBe('Deploy OK');
      expect(result.stderr).toBe('warn');
    });

    test('retourne exitCode 0 pour un succès', async () => {
      mockExecuteScript.mockResolvedValue(makeSuccessResult());

      const result = await helpers.executeDeploymentScript('test.ps1');

      expect(result.exitCode).toBe(0);
    });

    test('duration est un nombre positif', async () => {
      mockExecuteScript.mockResolvedValue(makeSuccessResult());

      const result = await helpers.executeDeploymentScript('test.ps1');

      expect(result.duration).toBeGreaterThanOrEqual(0);
      expect(typeof result.duration).toBe('number');
    });

    test('pas de champ error si succès', async () => {
      mockExecuteScript.mockResolvedValue(makeSuccessResult());

      const result = await helpers.executeDeploymentScript('test.ps1');

      expect(result.error).toBeUndefined();
    });
  });

  // ============================================================
  // executeDeploymentScript - échec
  // ============================================================

  describe('executeDeploymentScript - échec', () => {
    test('retourne success=false si executor retourne success=false', async () => {
      mockExecuteScript.mockResolvedValue(makeFailureResult(2));

      const result = await helpers.executeDeploymentScript('test.ps1');

      expect(result.success).toBe(false);
    });

    test('retourne le bon exitCode', async () => {
      mockExecuteScript.mockResolvedValue(makeFailureResult(42));

      const result = await helpers.executeDeploymentScript('test.ps1');

      expect(result.exitCode).toBe(42);
    });

    test('retourne un champ error contenant l\'exitCode', async () => {
      mockExecuteScript.mockResolvedValue(makeFailureResult(1));

      const result = await helpers.executeDeploymentScript('test.ps1');

      expect(result.error).toContain('1');
    });

    test('appelle logger.error si script échoue', async () => {
      mockExecuteScript.mockResolvedValue(makeFailureResult(1));

      await helpers.executeDeploymentScript('test.ps1');

      expect(mockLoggerError).toHaveBeenCalled();
    });
  });

  // ============================================================
  // executeDeploymentScript - exception
  // ============================================================

  describe('executeDeploymentScript - exception', () => {
    test('retourne success=false si executor lève une exception', async () => {
      mockExecuteScript.mockRejectedValue(new Error('PowerShell not found'));

      const result = await helpers.executeDeploymentScript('test.ps1');

      expect(result.success).toBe(false);
    });

    test('retourne exitCode -1 en cas d\'exception', async () => {
      mockExecuteScript.mockRejectedValue(new Error('Timeout'));

      const result = await helpers.executeDeploymentScript('test.ps1');

      expect(result.exitCode).toBe(-1);
    });

    test('retourne le message d\'erreur dans stderr', async () => {
      mockExecuteScript.mockRejectedValue(new Error('PowerShell crashed'));

      const result = await helpers.executeDeploymentScript('test.ps1');

      expect(result.stderr).toContain('PowerShell crashed');
    });

    test('retourne un champ error avec préfixe "Exception:"', async () => {
      mockExecuteScript.mockRejectedValue(new Error('unexpected'));

      const result = await helpers.executeDeploymentScript('test.ps1');

      expect(result.error).toContain('Exception:');
    });
  });

  // ============================================================
  // dryRun
  // ============================================================

  describe('dryRun', () => {
    test('ajoute -WhatIf aux arguments si dryRun=true', async () => {
      mockExecuteScript.mockResolvedValue(makeSuccessResult());

      await helpers.executeDeploymentScript('test.ps1', ['-Param', 'val'], { dryRun: true });

      const callArgs = mockExecuteScript.mock.calls[0][1];
      expect(callArgs).toContain('-WhatIf');
    });

    test('n\'ajoute pas -WhatIf si dryRun=false', async () => {
      mockExecuteScript.mockResolvedValue(makeSuccessResult());

      await helpers.executeDeploymentScript('test.ps1', [], { dryRun: false });

      const callArgs = mockExecuteScript.mock.calls[0][1];
      expect(callArgs).not.toContain('-WhatIf');
    });
  });

  // ============================================================
  // Méthodes spécialisées
  // ============================================================

  describe('deployModes', () => {
    test('exécute deploy-modes.ps1', async () => {
      mockExecuteScript.mockResolvedValue(makeSuccessResult());

      await helpers.deployModes();

      const scriptPath = mockExecuteScript.mock.calls[0][0] as string;
      expect(scriptPath).toContain('deploy-modes.ps1');
    });
  });

  describe('deployMCPs', () => {
    test('exécute install-mcps.ps1', async () => {
      mockExecuteScript.mockResolvedValue(makeSuccessResult());

      await helpers.deployMCPs();

      const scriptPath = mockExecuteScript.mock.calls[0][0] as string;
      expect(scriptPath).toContain('install-mcps.ps1');
    });
  });

  describe('createProfile', () => {
    test('exécute create-profile.ps1 avec le nom du profil', async () => {
      mockExecuteScript.mockResolvedValue(makeSuccessResult());

      await helpers.createProfile('my-profile');

      const args = mockExecuteScript.mock.calls[0][1] as string[];
      expect(args).toContain('my-profile');
    });

    test('inclut -ProfileName dans les arguments', async () => {
      mockExecuteScript.mockResolvedValue(makeSuccessResult());

      await helpers.createProfile('test-profile');

      const args = mockExecuteScript.mock.calls[0][1] as string[];
      expect(args).toContain('-ProfileName');
    });
  });

  describe('createCleanModes', () => {
    test('exécute create-clean-modes.ps1', async () => {
      mockExecuteScript.mockResolvedValue(makeSuccessResult());

      await helpers.createCleanModes();

      const scriptPath = mockExecuteScript.mock.calls[0][0] as string;
      expect(scriptPath).toContain('create-clean-modes.ps1');
    });
  });

  describe('forceDeployWithEncodingFix', () => {
    test('exécute force-deploy-with-encoding-fix.ps1', async () => {
      mockExecuteScript.mockResolvedValue(makeSuccessResult());

      await helpers.forceDeployWithEncodingFix();

      const scriptPath = mockExecuteScript.mock.calls[0][0] as string;
      expect(scriptPath).toContain('force-deploy-with-encoding-fix.ps1');
    });
  });

  // ============================================================
  // getDeploymentHelpers / resetDeploymentHelpers
  // ============================================================

  describe('getDeploymentHelpers', () => {
    test('retourne une instance DeploymentHelpers', () => {
      const instance = getDeploymentHelpers('/test-path');
      expect(instance).toBeInstanceOf(DeploymentHelpers);
    });

    test('retourne la même instance (singleton)', () => {
      const a = getDeploymentHelpers('/path-a');
      const b = getDeploymentHelpers('/path-b');
      expect(a).toBe(b);
    });
  });

  describe('resetDeploymentHelpers', () => {
    test('après reset, getDeploymentHelpers retourne une nouvelle instance', () => {
      const a = getDeploymentHelpers('/first');
      resetDeploymentHelpers();
      const b = getDeploymentHelpers('/second');
      expect(a).not.toBe(b);
    });
  });
});
