import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock PowerShellExecutor — must use vi.hoisted for reference in mock factory
const mockExecuteScript = vi.hoisted(() => vi.fn());
vi.mock('../../../src/services/PowerShellExecutor.js', () => ({
  PowerShellExecutor: vi.fn(() => ({ executeScript: mockExecuteScript })),
}));

// Mock logger
vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  DeploymentHelpers,
  getDeploymentHelpers,
  resetDeploymentHelpers,
  type DeploymentResult,
} from '../../../src/utils/deployment-helpers.js';

function makeSuccessResult(overrides?: Partial<DeploymentResult>): DeploymentResult {
  return {
    success: true,
    scriptName: 'test.ps1',
    duration: 100,
    exitCode: 0,
    stdout: 'OK',
    stderr: '',
    ...overrides,
  };
}

describe('DeploymentHelpers', () => {
  let helpers: DeploymentHelpers;

  beforeEach(() => {
    vi.clearAllMocks();
    resetDeploymentHelpers();
    helpers = new DeploymentHelpers('/fake/scripts');
  });

  describe('constructor', () => {
    it('uses provided scriptsBasePath', () => {
      const h = new DeploymentHelpers('/custom/path');
      // Verified indirectly via executeDeploymentScript
      expect(h).toBeDefined();
    });

    it('falls back to ROO_HOME env var', () => {
      const original = process.env.ROO_HOME;
      process.env.ROO_HOME = '/custom/roo';
      const h = new DeploymentHelpers();
      expect(h).toBeDefined();
      process.env.ROO_HOME = original;
    });

    it('falls back to d:/roo-extensions when no ROO_HOME', () => {
      const original = process.env.ROO_HOME;
      delete process.env.ROO_HOME;
      const h = new DeploymentHelpers();
      expect(h).toBeDefined();
      process.env.ROO_HOME = original;
    });
  });

  describe('executeDeploymentScript', () => {
    it('executes script and returns success result', async () => {
      mockExecuteScript.mockResolvedValue({
        success: true,
        exitCode: 0,
        stdout: 'deployed',
        stderr: '',
      });

      const result = await helpers.executeDeploymentScript('deploy.ps1');

      expect(result.success).toBe(true);
      expect(result.scriptName).toBe('deploy.ps1');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('deployed');
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });

    it('passes args to executor', async () => {
      mockExecuteScript.mockResolvedValue({
        success: true,
        exitCode: 0,
        stdout: '',
        stderr: '',
      });

      await helpers.executeDeploymentScript('script.ps1', ['-Flag', 'value']);

      expect(mockExecuteScript).toHaveBeenCalledWith(
        expect.stringContaining('script.ps1'),
        ['-Flag', 'value'],
        expect.objectContaining({ timeout: 300000 }),
      );
    });

    it('appends -WhatIf when dryRun is true', async () => {
      mockExecuteScript.mockResolvedValue({
        success: true,
        exitCode: 0,
        stdout: '',
        stderr: '',
      });

      await helpers.executeDeploymentScript('script.ps1', ['-Arg1'], { dryRun: true });

      expect(mockExecuteScript).toHaveBeenCalledWith(
        expect.any(String),
        ['-Arg1', '-WhatIf'],
        expect.any(Object),
      );
    });

    it('uses custom timeout when provided', async () => {
      mockExecuteScript.mockResolvedValue({
        success: true,
        exitCode: 0,
        stdout: '',
        stderr: '',
      });

      await helpers.executeDeploymentScript('script.ps1', [], { timeout: 60000 });

      expect(mockExecuteScript).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({ timeout: 60000 }),
      );
    });

    it('passes env variables to executor', async () => {
      mockExecuteScript.mockResolvedValue({
        success: true,
        exitCode: 0,
        stdout: '',
        stderr: '',
      });

      await helpers.executeDeploymentScript('script.ps1', [], {
        env: { MY_VAR: 'value' },
      });

      expect(mockExecuteScript).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({ env: { MY_VAR: 'value' } }),
      );
    });

    it('returns error result when script fails', async () => {
      mockExecuteScript.mockResolvedValue({
        success: false,
        exitCode: 1,
        stdout: '',
        stderr: 'error output',
      });

      const result = await helpers.executeDeploymentScript('fail.ps1');

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.error).toBe('Script failed with exit code 1');
      expect(result.stderr).toBe('error output');
    });

    it('handles exceptions from executor', async () => {
      mockExecuteScript.mockRejectedValue(new Error('timeout'));

      const result = await helpers.executeDeploymentScript('crash.ps1');

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(-1);
      expect(result.error).toContain('Exception');
      expect(result.error).toContain('timeout');
      expect(result.stderr).toContain('timeout');
    });

    it('handles non-Error exceptions', async () => {
      mockExecuteScript.mockRejectedValue('string error');

      const result = await helpers.executeDeploymentScript('crash.ps1');

      expect(result.success).toBe(false);
      expect(result.error).toContain('string error');
    });

    it('measures duration accurately', async () => {
      mockExecuteScript.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({
          success: true, exitCode: 0, stdout: '', stderr: '',
        }), 50)),
      );

      const result = await helpers.executeDeploymentScript('slow.ps1');

      expect(result.duration).toBeGreaterThanOrEqual(40);
    });
  });

  describe('convenience methods', () => {
    beforeEach(() => {
      mockExecuteScript.mockResolvedValue({
        success: true,
        exitCode: 0,
        stdout: '',
        stderr: '',
      });
    });

    it('deployModes calls deploy-modes.ps1', async () => {
      await helpers.deployModes();
      expect(mockExecuteScript).toHaveBeenCalledWith(
        expect.stringContaining('deploy-modes.ps1'),
        [],
        expect.any(Object),
      );
    });

    it('deployMCPs calls install-mcps.ps1', async () => {
      await helpers.deployMCPs();
      expect(mockExecuteScript).toHaveBeenCalledWith(
        expect.stringContaining('install-mcps.ps1'),
        [],
        expect.any(Object),
      );
    });

    it('createProfile passes profile name to create-profile.ps1', async () => {
      await helpers.createProfile('test-profile');
      expect(mockExecuteScript).toHaveBeenCalledWith(
        expect.stringContaining('create-profile.ps1'),
        ['-ProfileName', 'test-profile'],
        expect.any(Object),
      );
    });

    it('createCleanModes calls create-clean-modes.ps1', async () => {
      await helpers.createCleanModes();
      expect(mockExecuteScript).toHaveBeenCalledWith(
        expect.stringContaining('create-clean-modes.ps1'),
        [],
        expect.any(Object),
      );
    });

    it('forceDeployWithEncodingFix calls correct script', async () => {
      await helpers.forceDeployWithEncodingFix();
      expect(mockExecuteScript).toHaveBeenCalledWith(
        expect.stringContaining('force-deploy-with-encoding-fix.ps1'),
        [],
        expect.any(Object),
      );
    });

    it('convenience methods forward options', async () => {
      await helpers.deployModes({ dryRun: true, timeout: 60000 });
      expect(mockExecuteScript).toHaveBeenCalledWith(
        expect.any(String),
        ['-WhatIf'],
        expect.objectContaining({ timeout: 60000 }),
      );
    });
  });
});

describe('getDeploymentHelpers / resetDeploymentHelpers', () => {
  afterEach(() => {
    resetDeploymentHelpers();
  });

  it('returns singleton instance', () => {
    const a = getDeploymentHelpers();
    const b = getDeploymentHelpers();
    expect(a).toBe(b);
  });

  it('reset creates new instance', () => {
    const a = getDeploymentHelpers();
    resetDeploymentHelpers();
    const b = getDeploymentHelpers();
    expect(a).not.toBe(b);
  });

  it('respects custom path only on first call', () => {
    const a = getDeploymentHelpers('/first');
    const b = getDeploymentHelpers('/second');
    expect(a).toBe(b);
  });
});
