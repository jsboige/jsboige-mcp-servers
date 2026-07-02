/**
 * #833 Sprint C3 — InventoryService branch coverage (po-2026 lane `src/services/roosync/**`)
 *
 * The existing `InventoryService.test.ts` (32 tests) covers the API surface
 * thoroughly — local collection (mcp/modes/systemInfo/paths), collectClaudeConfig
 * (model/env-vars/dedup/count/migrations/missing/error), collectRooModes, the
 * full loadRemoteInventory error matrix, and saveToSharedState. It leaves two
 * genuine defensive clusters cold, however:
 *
 * - `getPowershellVersion` (L226-244): the `execSync` mock always returns
 *   `'7.4.6'`, so the three fallback arms are never exercised — (1) pwsh throws
 *   → retry with `powershell` (L234-239), (2) both throw → `'Unknown'`
 *   (L240-242), (3) empty output → `'Unknown'` (L232 `output || 'Unknown'`,
 *   L239). The PowerShell-version-detection resilience is entirely untested.
 * - `collectClaudeConfig` skillUsage passthrough (L301-303): every fixture
 *   omits `claudeJson.skillUsage`, so the `config.skillUsage = ...` line is cold.
 *
 * A regression collapsing any of these (e.g. dropping the `powershell` fallback,
 * or returning `''` instead of `'Unknown'`) would pass the nominal suite
 * silently. This add-only file pins them, each assertion anchored on a source
 * line of `InventoryService.ts`. Reuses the established hoisted-mock pattern.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import { execSync } from 'child_process';

const { mockExecSync } = vi.hoisted(() => ({
  // Default = pwsh succeeds (mirrors the nominal suite). Reconfigured per-test.
  mockExecSync: vi.fn(() => '7.4.6'),
}));

vi.mock('fs/promises');
vi.mock('child_process', () => ({
  execSync: mockExecSync,
}));
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    homedir: vi.fn(() => '/mock/home'),
    hostname: vi.fn(() => 'test-machine'),
    type: vi.fn(() => 'Windows_NT'),
    release: vi.fn(() => '10.0.19045'),
    userInfo: vi.fn(() => ({ username: 'test-user' })),
  };
});

vi.mock('../../../utils/shared-state-path.js', () => ({
  getSharedStatePath: vi.fn(() => '/mock/shared-state'),
}));
vi.mock('fs', () => ({
  existsSync: vi.fn(() => true),
}));
vi.mock('../../../utils/encoding-helpers.js', () => ({
  readJSONFileWithoutBOM: vi.fn(),
}));

import { readJSONFileWithoutBOM } from '../../../utils/encoding-helpers.js';
import { InventoryService } from '../InventoryService';

function mockReadJSONByPath(pathMap: Record<string, any>) {
  vi.mocked(readJSONFileWithoutBOM).mockImplementation(((filePath: string) => {
    for (const [substring, data] of Object.entries(pathMap)) {
      if (filePath.includes(substring)) {
        return Promise.resolve(data);
      }
    }
    return Promise.reject(new Error(`ENOENT: ${filePath}`));
  }) as any);
}

describe('InventoryService — branch coverage (#833 C3, source-grounded)', () => {
  let service: InventoryService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecSync.mockImplementation(() => '7.4.6');
    service = InventoryService.getInstance();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ============================================================
  // getPowershellVersion — pwsh fails, fallback to `powershell` (L233-239)
  // ============================================================
  describe('getPowershellVersion — pwsh → powershell fallback', () => {
    it('falls back to powershell.exe when pwsh throws (L233-239)', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      mockReadJSONByPath({});
      vi.mocked(fs.writeFile).mockResolvedValue();

      // 1st call (pwsh) throws → 2nd call (powershell) returns a version.
      mockExecSync
        .mockImplementationOnce(() => {
          throw new Error('pwsh not found');
        })
        .mockImplementationOnce(() => '5.1.22621');

      const inventory = await service.getMachineInventory();

      // The fallback Windows PowerShell version surfaces in systemInfo.
      expect(inventory.inventory.systemInfo.powershellVersion).toBe('5.1.22621');
      // Both invocations happened — confirming the retry, not a cached default.
      expect(mockExecSync).toHaveBeenCalledTimes(2);
      // The 2nd call targets powershell.exe (L235 command), not pwsh (L228).
      const secondCmd = (mockExecSync.mock.calls[1][1] as any)?.encoding
        ? mockExecSync.mock.calls[1][0]
        : mockExecSync.mock.calls[1][0];
      expect(secondCmd).toContain('powershell');
    });
  });

  // ============================================================
  // getPowershellVersion — both throw → 'Unknown' (L240-242)
  // ============================================================
  describe('getPowershellVersion — both shells unavailable', () => {
    it('returns "Unknown" when both pwsh and powershell throw (L240-242)', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      mockReadJSONByPath({});
      vi.mocked(fs.writeFile).mockResolvedValue();

      // Both calls throw → inner catch returns 'Unknown'.
      mockExecSync.mockImplementation(() => {
        throw new Error('no shell available');
      });

      const inventory = await service.getMachineInventory();

      expect(inventory.inventory.systemInfo.powershellVersion).toBe('Unknown');
      // Two attempts before giving up.
      expect(mockExecSync).toHaveBeenCalledTimes(2);
    });
  });

  // ============================================================
  // getPowershellVersion — empty output → 'Unknown' (L232)
  // ============================================================
  describe('getPowershellVersion — empty output', () => {
    it('coerces empty pwsh output to "Unknown" via `output || "Unknown"` (L232)', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      mockReadJSONByPath({});
      vi.mocked(fs.writeFile).mockResolvedValue();

      // pwsh returns a whitespace-only string → trim() → '' → falsy → 'Unknown'.
      mockExecSync.mockImplementation(() => '   ');

      const inventory = await service.getMachineInventory();

      expect(inventory.inventory.systemInfo.powershellVersion).toBe('Unknown');
      // Empty output on the 1st (pwsh) call short-circuits — no powershell retry.
      expect(mockExecSync).toHaveBeenCalledTimes(1);
    });
  });

  // ============================================================
  // collectClaudeConfig — skillUsage passthrough (L301-303)
  // ============================================================
  describe('collectClaudeConfig — skillUsage', () => {
    it('passes claudeJson.skillUsage through to config (L301-303)', async () => {
      const skillUsage = { 'memory-inject': 42, executor: 7, coordinate: 3 };
      const claudeJson = {
        model: 'claude-sonnet-4-6',
        skillUsage,
      };

      vi.mocked(fs.access).mockResolvedValue(undefined);
      mockReadJSONByPath({ '.claude.json': claudeJson });
      vi.mocked(fs.writeFile).mockResolvedValue();

      const inventory = await service.getMachineInventory();

      // L302 assigns the whole object by reference.
      expect(inventory.inventory.claudeConfig?.skillUsage).toEqual(skillUsage);
      expect(inventory.inventory.claudeConfig?.skillUsage).toBe(skillUsage);
    });

    it('omits skillUsage from config when absent in ~/.claude.json (L301 guard)', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      mockReadJSONByPath({ '.claude.json': { model: 'claude-haiku-4-5' } });
      vi.mocked(fs.writeFile).mockResolvedValue();

      const inventory = await service.getMachineInventory();

      // No skillUsage key → the L301 guard is false → config.skillUsage unset.
      expect(inventory.inventory.claudeConfig).toBeDefined();
      expect(inventory.inventory.claudeConfig?.skillUsage).toBeUndefined();
    });
  });
});
