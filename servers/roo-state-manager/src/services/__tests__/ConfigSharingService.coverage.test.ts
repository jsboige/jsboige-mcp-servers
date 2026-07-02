/**
 * #833 Sprint C3 — coverage complement for ConfigSharingService.ts
 *
 * Add-only, tests-only. Zero source / existing-test change (net-zero submodule pointer;
 * branch off origin/main `3fa67aa8`). Lane `src/services/**`.
 *
 * The nominal suite (`ConfigSharingService.test.ts`) constructs the service against
 * mock paths that do NOT exist on disk, so every collector short-circuits to `[]`
 * (the "files exist" happy paths stay cold) and the #2413 post-apply validators are
 * never invoked. This file mocks the fs + service boundary so those private helpers
 * run their happy/catch/branch arms.
 *
 * Every private method is exercised via `(service as any).<name>()`. Each assertion is
 * anchored to a source line in ConfigSharingService.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── fs boundary ────────────────────────────────────────────────────────────
// Only the promises.* methods the targets touch + existsSync are overridden;
// everything else (incl. mkdirSync, real logger fs usage) stays real via `...actual`.
const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn(),
  mkdir: vi.fn(),
  readFile: vi.fn(),
  copyFile: vi.fn(),
  writeFile: vi.fn(),
  stat: vi.fn(),
}));
vi.mock('fs', async () => {
  const actual = await vi.importActual<any>('fs');
  const promises = {
    ...actual.promises,
    mkdir: fsMock.mkdir,
    readFile: fsMock.readFile,
    copyFile: fsMock.copyFile,
    writeFile: fsMock.writeFile,
    stat: fsMock.stat,
  };
  return {
    ...actual,
    existsSync: fsMock.existsSync,
    promises,
    default: { ...actual, existsSync: fsMock.existsSync, promises },
  };
});

// ── os.homedir (collectClaudeConfig) ───────────────────────────────────────
const osMock = vi.hoisted(() => ({ homedir: vi.fn(() => '/home/test') }));
vi.mock('os', async () => {
  const actual = await vi.importActual<any>('os');
  return { ...actual, homedir: osMock.homedir, default: { ...actual, homedir: osMock.homedir } };
});

// ── ConfigNormalizationService (ctor dependency — mirrors nominal suite) ────
vi.mock('../ConfigNormalizationService', () => {
  const ConfigNormalizationService = vi.fn();
  (ConfigNormalizationService as any).prototype.normalize = vi.fn((c: any) => Promise.resolve(c));
  return { ConfigNormalizationService };
});

// ── InventoryService (ctor + collectSchedules) ─────────────────────────────
const inventoryMock = vi.hoisted(() => ({ getMachineInventory: vi.fn() }));
vi.mock('../roosync/InventoryService', () => ({
  InventoryService: { getInstance: () => inventoryMock },
}));

// ── RooSettingsService (validateProfileApplication + collectSettings) ───────
const rooSettingsMock = vi.hoisted(() => ({
  isAvailable: vi.fn(),
  getSetting: vi.fn(),
  getStateDbPath: vi.fn(() => '/mock/state.vscdb'),
  extractSettings: vi.fn(),
}));
vi.mock('../RooSettingsService', () => ({
  RooSettingsService: vi.fn(() => rooSettingsMock),
}));

// ── ConfigHealthCheckService (validateConfigApplication) ────────────────────
const healthMock = vi.hoisted(() => ({ checkHealth: vi.fn() }));
vi.mock('../ConfigHealthCheckService', () => ({
  ConfigHealthCheckService: vi.fn(() => healthMock),
}));

// ── ServicesConfigService (collectServices) ────────────────────────────────
const servicesMock = vi.hoisted(() => ({ collect: vi.fn() }));
const isValidServiceNameMock = vi.hoisted(() => vi.fn());
vi.mock('../ServicesConfigService', () => {
  const ServicesConfigService: any = vi.fn(() => servicesMock);
  ServicesConfigService.isValidServiceName = isValidServiceNameMock;
  return { ServicesConfigService };
});

// ── SchtasksConfigService (collectSchtasks) ────────────────────────────────
const schtasksMock = vi.hoisted(() => ({ collect: vi.fn() }));
vi.mock('../SchtasksConfigService', () => ({
  SchtasksConfigService: vi.fn(() => schtasksMock),
}));

// ── getSettingsPath (collectModesYaml) ─────────────────────────────────────
const getSettingsPathMock = vi.hoisted(() => vi.fn(() => '/mock/roo-settings-dir'));
vi.mock('../../utils/extension-paths', () => ({ getSettingsPath: getSettingsPathMock }));

import { ConfigSharingService } from '../ConfigSharingService';

const HEX64 = /^[0-9a-f]{64}$/;

describe('ConfigSharingService — #833 C3 coverage complement', () => {
  let service: any;

  beforeEach(() => {
    vi.clearAllMocks();
    // fs baseline: writes/copies succeed, stat has a size, calculateHash reads a Buffer.
    fsMock.mkdir.mockResolvedValue(undefined);
    fsMock.copyFile.mockResolvedValue(undefined);
    fsMock.writeFile.mockResolvedValue(undefined);
    fsMock.stat.mockResolvedValue({ size: 123 });
    fsMock.readFile.mockResolvedValue(Buffer.from('file-bytes'));
    fsMock.existsSync.mockReturnValue(true);
    osMock.homedir.mockReturnValue('/home/test');
    inventoryMock.getMachineInventory.mockResolvedValue({ paths: { rooExtensions: '/roo-ext' } });
    rooSettingsMock.isAvailable.mockReturnValue(false);
    rooSettingsMock.getStateDbPath.mockReturnValue('/mock/state.vscdb');
    healthMock.checkHealth.mockResolvedValue({ healthy: true });
    servicesMock.collect.mockResolvedValue({ services: [] });
    isValidServiceNameMock.mockReturnValue(true);
    schtasksMock.collect.mockResolvedValue({ count: 0 });
    getSettingsPathMock.mockReturnValue('/mock/roo-settings-dir');

    const configService = { getSharedStatePath: vi.fn().mockReturnValue('/mock/shared/state') } as any;
    const inventoryCollector = { collectInventory: vi.fn().mockResolvedValue({ paths: {} }) } as any;
    service = new ConfigSharingService(configService, inventoryCollector);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // mergeSchedulesById (L2117-2140) — pure logic
  // ══════════════════════════════════════════════════════════════════════════
  describe('mergeSchedulesById', () => {
    it('adds a source schedule that has no id (L2122-2125 true arm)', () => {
      const out = (service as any).mergeSchedulesById([{ name: 'a' }], []);
      expect(out).toHaveLength(1);
      expect(out[0]).toEqual({ name: 'a' });
    });

    it('merges source over target when ids match — source fields win (L2129-2131)', () => {
      const out = (service as any).mergeSchedulesById(
        [{ id: 'x', v: 9 }],
        [{ id: 'x', v: 1, keep: 2 }],
      );
      expect(out).toHaveLength(1);
      expect(out[0]).toEqual({ id: 'x', v: 9, keep: 2 });
    });

    it('adds a source schedule with a new id and preserves target (L2132-2135)', () => {
      const out = (service as any).mergeSchedulesById([{ id: 'y', v: 1 }], [{ id: 'x' }]);
      expect(out).toHaveLength(2);
      expect(out.map((s: any) => s.id).sort()).toEqual(['x', 'y']);
    });

    it('handles match + new-id + no-id in one pass (all arms)', () => {
      const out = (service as any).mergeSchedulesById(
        [{ id: 'a', x: 2 }, { id: 'b' }, { noId: true }],
        [{ id: 'a', x: 1, kept: true }],
      );
      expect(out).toHaveLength(3);
      const a = out.find((s: any) => s.id === 'a');
      expect(a).toEqual({ id: 'a', x: 2, kept: true }); // source override + preserved field
      expect(out.some((s: any) => s.id === 'b')).toBe(true);
      expect(out.some((s: any) => s.noId === true)).toBe(true);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // validateConfigApplication (L1333-1380) — #2413
  // ══════════════════════════════════════════════════════════════════════════
  describe('validateConfigApplication', () => {
    it('skips rules_config without calling the health checker (L1341-1343)', async () => {
      const res = await (service as any).validateConfigApplication([{ path: '/p/rules.md', type: 'rules_config' }]);
      expect(res.performed).toBe(true);
      expect(res.success).toBe(true);
      expect(res.targetValidations[0]).toEqual({ target: '/p/rules.md', success: true, details: { skipped: 'text file' } });
      expect(healthMock.checkHealth).not.toHaveBeenCalled();
    });

    it('reports success with undefined details when healthy (L1360-1363 true arm)', async () => {
      healthMock.checkHealth.mockResolvedValue({ healthy: true });
      const res = await (service as any).validateConfigApplication([{ path: '/p/mcp.json', type: 'mcp_config' }]);
      expect(res.success).toBe(true);
      expect(res.targetValidations[0]).toEqual({ target: '/p/mcp.json', success: true, details: undefined });
    });

    it('surfaces errors when unhealthy (L1360-1363 false arm)', async () => {
      healthMock.checkHealth.mockResolvedValue({ healthy: false, errors: ['bad json'] });
      const res = await (service as any).validateConfigApplication([{ path: '/p/mcp.json', type: 'mcp_config' }]);
      expect(res.success).toBe(false);
      expect(res.targetValidations[0].details).toEqual({ errors: ['bad json'] });
    });

    it('maps a known type verbatim (settings_config) — no fallback', async () => {
      await (service as any).validateConfigApplication([{ path: '/p/s.json', type: 'settings_config' }]);
      expect(healthMock.checkHealth).toHaveBeenCalledWith('/p/s.json', 'settings_config', expect.objectContaining({ checks: ['file_readable', 'json_valid'] }));
    });

    it('falls back to mcp_config for an unknown type (L1354 || arm)', async () => {
      await (service as any).validateConfigApplication([{ path: '/p/x', type: 'totally_unknown' }]);
      expect(healthMock.checkHealth).toHaveBeenCalledWith('/p/x', 'mcp_config', expect.anything());
    });

    it('catches a health-check throw (L1365-1371)', async () => {
      healthMock.checkHealth.mockRejectedValue(new Error('boom'));
      const res = await (service as any).validateConfigApplication([{ path: '/p/mcp.json', type: 'mcp_config' }]);
      expect(res.success).toBe(false);
      expect(res.targetValidations[0]).toEqual({ target: '/p/mcp.json', success: false, details: { error: 'boom' } });
    });

    it('aggregates allSuccess=false across mixed results (L1374 every)', async () => {
      healthMock.checkHealth
        .mockResolvedValueOnce({ healthy: true })
        .mockResolvedValueOnce({ healthy: false, errors: ['x'] });
      const res = await (service as any).validateConfigApplication([
        { path: '/a', type: 'mcp_config' },
        { path: '/b', type: 'mcp_config' },
      ]);
      expect(res.success).toBe(false);
      expect(res.targetValidations).toHaveLength(2);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // validateProfileApplication (L1229-1325) — #2413
  // ══════════════════════════════════════════════════════════════════════════
  describe('validateProfileApplication', () => {
    it('flags a missing .roomodes file (L1238-1239)', async () => {
      fsMock.existsSync.mockReturnValue(false);
      const res = await (service as any).validateProfileApplication({ modeOverrides: {} }, {}, '/x/.roomodes');
      expect(res.performed).toBe(true);
      expect(res.success).toBe(false);
      expect(res.drift).toEqual(expect.arrayContaining([{ field: '.roomodes', expected: 'existing file', actual: 'missing' }]));
    });

    it('parses JSON .roomodes and reports no drift when modes match (L1245, L1318-1324)', async () => {
      fsMock.readFile.mockResolvedValue(JSON.stringify({ customModes: [{ slug: 'code', apiConfigId: 'cfg1' }] }));
      const res = await (service as any).validateProfileApplication({ modeOverrides: { code: 'cfg1' } }, {}, '/x/.roomodes');
      expect(res.success).toBe(true);
      expect(res.drift).toBeUndefined();
    });

    it('falls back to YAML parse when content is not JSON (L1246-1247)', async () => {
      fsMock.readFile.mockResolvedValue('customModes:\n  - slug: code\n    apiConfigId: cfg1\n');
      const res = await (service as any).validateProfileApplication({ modeOverrides: { code: 'cfg1' } }, {}, '/x/.roomodes');
      expect(res.success).toBe(true);
    });

    it('captures a readFile error as parse drift (L1249-1251)', async () => {
      fsMock.readFile.mockRejectedValue(new Error('io'));
      const res = await (service as any).validateProfileApplication({ modeOverrides: {} }, {}, '/x/.roomodes');
      expect(res.drift).toEqual(expect.arrayContaining([{ field: '.roomodes', expected: 'parseable content', actual: 'parse error: io' }]));
    });

    it('flags a mode missing from deployed customModes (L1261-1267)', async () => {
      fsMock.readFile.mockResolvedValue(JSON.stringify({ customModes: [] }));
      const res = await (service as any).validateProfileApplication({ modeOverrides: { code: 'cfg1' } }, {}, '/x/.roomodes');
      expect(res.success).toBe(false);
      expect(res.drift).toEqual(expect.arrayContaining([{ field: 'customModes.code', expected: 'present', actual: 'missing' }]));
    });

    it('flags an apiConfigId mismatch, echoing the deployed value (L1269-1275)', async () => {
      fsMock.readFile.mockResolvedValue(JSON.stringify({ customModes: [{ slug: 'code', apiConfigId: 'other' }] }));
      const res = await (service as any).validateProfileApplication({ modeOverrides: { code: 'cfg1' } }, {}, '/x/.roomodes');
      expect(res.drift).toEqual(expect.arrayContaining([{ field: 'customModes.code.apiConfigId', expected: 'cfg1', actual: 'other' }]));
    });

    it('reports actual=null when deployed mode lacks apiConfigId (L1273 ?? arm)', async () => {
      fsMock.readFile.mockResolvedValue(JSON.stringify({ customModes: [{ slug: 'code' }] }));
      const res = await (service as any).validateProfileApplication({ modeOverrides: { code: 'cfg1' } }, {}, '/x/.roomodes');
      expect(res.drift).toEqual(expect.arrayContaining([{ field: 'customModes.code.apiConfigId', expected: 'cfg1', actual: null }]));
    });

    it('flags customModes that is not an array (L1277-1283 else-if)', async () => {
      fsMock.readFile.mockResolvedValue(JSON.stringify({ customModes: 'nope' }));
      const res = await (service as any).validateProfileApplication({ modeOverrides: { code: 'cfg1' } }, {}, '/x/.roomodes');
      expect(res.drift).toEqual(expect.arrayContaining([{ field: '.roomodes.customModes', expected: 'array', actual: 'string' }]));
    });

    it('marks activeApiConfigInSync=true when state.vscdb matches defaultApiConfig (L1305-1307)', async () => {
      fsMock.readFile.mockResolvedValue(JSON.stringify({ customModes: [{ slug: 'code', apiConfigId: 'cfg1' }] }));
      rooSettingsMock.isAvailable.mockReturnValue(true);
      rooSettingsMock.getSetting.mockResolvedValue('cfgX');
      const res = await (service as any).validateProfileApplication(
        { modeOverrides: { code: 'cfg1' }, defaultApiConfig: 'cfgX' }, {}, '/x/.roomodes');
      expect(res.success).toBe(true);
      expect(res.activeApiConfigName).toBe('cfgX');
      expect(res.activeApiConfigInSync).toBe(true);
    });

    it('flags state.vscdb drift when it differs from defaultApiConfig (L1296-1304)', async () => {
      fsMock.readFile.mockResolvedValue(JSON.stringify({ customModes: [{ slug: 'code', apiConfigId: 'cfg1' }] }));
      rooSettingsMock.isAvailable.mockReturnValue(true);
      rooSettingsMock.getSetting.mockResolvedValue('cfgY');
      const res = await (service as any).validateProfileApplication(
        { modeOverrides: { code: 'cfg1' }, defaultApiConfig: 'cfgX' }, {}, '/x/.roomodes');
      expect(res.success).toBe(false);
      expect(res.activeApiConfigInSync).toBe(false);
      expect(res.drift).toEqual(expect.arrayContaining([{ field: 'state.vscdb.currentApiConfigName', expected: 'cfgX', actual: 'cfgY' }]));
    });

    it('reports activeApiConfigName only when profile has no defaultApiConfig (L1295 false)', async () => {
      fsMock.readFile.mockResolvedValue(JSON.stringify({ customModes: [{ slug: 'code', apiConfigId: 'cfg1' }] }));
      rooSettingsMock.isAvailable.mockReturnValue(true);
      rooSettingsMock.getSetting.mockResolvedValue('cfgZ');
      const res = await (service as any).validateProfileApplication({ modeOverrides: { code: 'cfg1' } }, {}, '/x/.roomodes');
      expect(res.success).toBe(true);
      expect(res.activeApiConfigName).toBe('cfgZ');
      expect(res.activeApiConfigInSync).toBeUndefined();
    });

    it('coerces a non-string currentApiConfigName to undefined (L1292 false)', async () => {
      fsMock.readFile.mockResolvedValue(JSON.stringify({ customModes: [{ slug: 'code', apiConfigId: 'cfg1' }] }));
      rooSettingsMock.isAvailable.mockReturnValue(true);
      rooSettingsMock.getSetting.mockResolvedValue(42);
      const res = await (service as any).validateProfileApplication(
        { modeOverrides: { code: 'cfg1' }, defaultApiConfig: 'cfgX' }, {}, '/x/.roomodes');
      expect(res.activeApiConfigName).toBeUndefined();
      expect(res.activeApiConfigInSync).toBeUndefined();
    });

    it('treats a state.vscdb read throw as non-fatal (L1313-1316 catch)', async () => {
      fsMock.readFile.mockResolvedValue(JSON.stringify({ customModes: [{ slug: 'code', apiConfigId: 'cfg1' }] }));
      rooSettingsMock.isAvailable.mockReturnValue(true);
      rooSettingsMock.getSetting.mockRejectedValue(new Error('db locked'));
      const res = await (service as any).validateProfileApplication({ modeOverrides: { code: 'cfg1' } }, {}, '/x/.roomodes');
      expect(res.success).toBe(true); // no mode drift → still success
      expect(res.activeApiConfigInSync).toBeUndefined();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // collectClaudeConfig (L1860-1891)
  // ══════════════════════════════════════════════════════════════════════════
  describe('collectClaudeConfig', () => {
    it('returns [] when ~/.claude.json is absent (L1867-1870)', async () => {
      fsMock.existsSync.mockReturnValue(false);
      const files = await (service as any).collectClaudeConfig('/tmp/cc');
      expect(files).toEqual([]);
    });

    it('collects the file on the happy path (L1872-1885)', async () => {
      const files = await (service as any).collectClaudeConfig('/tmp/cc');
      expect(files).toHaveLength(1);
      expect(files[0]).toMatchObject({ path: 'claude-config/.claude.json', type: 'claude_config', size: 123 });
      expect(files[0].hash).toMatch(HEX64);
      expect(fsMock.copyFile).toHaveBeenCalled();
    });

    it('swallows a copy error and returns [] (L1886-1888 catch)', async () => {
      fsMock.copyFile.mockRejectedValue(new Error('EACCES'));
      const files = await (service as any).collectClaudeConfig('/tmp/cc');
      expect(files).toEqual([]);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // collectModesYaml (L1897-1929)
  // ══════════════════════════════════════════════════════════════════════════
  describe('collectModesYaml', () => {
    it('returns [] when custom_modes.yaml is absent (L1905-1907)', async () => {
      fsMock.existsSync.mockReturnValue(false);
      const files = await (service as any).collectModesYaml('/tmp/my');
      expect(files).toEqual([]);
    });

    it('collects custom_modes.yaml on the happy path (L1910-1923)', async () => {
      const files = await (service as any).collectModesYaml('/tmp/my');
      expect(files).toHaveLength(1);
      expect(files[0]).toMatchObject({ path: 'modes-yaml/custom_modes.yaml', type: 'modes_yaml', size: 123 });
      expect(getSettingsPathMock).toHaveBeenCalled();
    });

    it('swallows a copy error and returns [] (L1924-1926 catch)', async () => {
      fsMock.copyFile.mockRejectedValue(new Error('EACCES'));
      const files = await (service as any).collectModesYaml('/tmp/my');
      expect(files).toEqual([]);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // collectServices (L1934-1971) — #2409
  // ══════════════════════════════════════════════════════════════════════════
  describe('collectServices', () => {
    it('strips the services: prefix, validates and collects (L1940-1965)', async () => {
      servicesMock.collect.mockResolvedValue({ services: [{ name: 'jupyter' }] });
      const files = await (service as any).collectServices('/tmp/s', ['services:jupyter']);
      expect(isValidServiceNameMock).toHaveBeenCalledWith('jupyter');
      expect(servicesMock.collect).toHaveBeenCalledWith(['jupyter']);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatchObject({ path: 'services/services-state.json', type: 'other', size: 123 });
    });

    it('warns on an unknown service name but still collects (L1942-1944)', async () => {
      isValidServiceNameMock.mockReturnValue(false);
      servicesMock.collect.mockResolvedValue({ services: [] });
      const files = await (service as any).collectServices('/tmp/s', ['services:bogus']);
      expect(isValidServiceNameMock).toHaveBeenCalledWith('bogus');
      expect(files).toHaveLength(1);
    });

    it('swallows a collect error and returns [] (L1966-1968 catch)', async () => {
      servicesMock.collect.mockRejectedValue(new Error('sc query failed'));
      const files = await (service as any).collectServices('/tmp/s', ['services:jupyter']);
      expect(files).toEqual([]);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // collectSettings (L1973-2008)
  // ══════════════════════════════════════════════════════════════════════════
  describe('collectSettings', () => {
    it('returns [] when state.vscdb is unavailable (L1980-1983)', async () => {
      rooSettingsMock.isAvailable.mockReturnValue(false);
      const files = await (service as any).collectSettings('/tmp/rs');
      expect(files).toEqual([]);
      expect(rooSettingsMock.getStateDbPath).toHaveBeenCalled();
    });

    it('extracts sync-safe settings on the happy path (L1985-2001)', async () => {
      rooSettingsMock.isAvailable.mockReturnValue(true);
      rooSettingsMock.extractSettings.mockResolvedValue({ metadata: { keysCount: 5, totalKeys: 10 } });
      const files = await (service as any).collectSettings('/tmp/rs');
      expect(rooSettingsMock.extractSettings).toHaveBeenCalledWith('safe');
      expect(files).toHaveLength(1);
      expect(files[0]).toMatchObject({ path: 'roo-settings/roo-settings.json', type: 'roo_settings', size: 123 });
    });

    it('swallows an extract error and returns [] (L2002-2005 catch)', async () => {
      rooSettingsMock.isAvailable.mockReturnValue(true);
      rooSettingsMock.extractSettings.mockRejectedValue(new Error('sqlite busy'));
      const files = await (service as any).collectSettings('/tmp/rs');
      expect(files).toEqual([]);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // collectSchtasks (L2034-2064) — #2408
  // ══════════════════════════════════════════════════════════════════════════
  describe('collectSchtasks', () => {
    it('collects the schtasks inventory on the happy path (L2039-2057)', async () => {
      schtasksMock.collect.mockResolvedValue({ count: 3, tasks: [] });
      const files = await (service as any).collectSchtasks('/tmp/st');
      expect(files).toHaveLength(1);
      expect(files[0]).toMatchObject({ path: 'schtasks/schtasks-inventory.json', type: 'other', size: 123 });
      expect(fsMock.writeFile).toHaveBeenCalled();
    });

    it('swallows a collect error and returns [] (L2058-2060 catch)', async () => {
      schtasksMock.collect.mockRejectedValue(new Error('schtasks.exe missing'));
      const files = await (service as any).collectSchtasks('/tmp/st');
      expect(files).toEqual([]);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // collectSchedules (L2069-2107) — #2411
  // ══════════════════════════════════════════════════════════════════════════
  describe('collectSchedules', () => {
    it('returns [] when inventory has no rooExtensions path (L2075-2077)', async () => {
      inventoryMock.getMachineInventory.mockResolvedValue({ paths: {} });
      const files = await (service as any).collectSchedules('/tmp/sch');
      expect(files).toEqual([]);
    });

    it('returns [] when schedules.json is absent (L2082-2084)', async () => {
      inventoryMock.getMachineInventory.mockResolvedValue({ paths: { rooExtensions: '/roo-ext' } });
      fsMock.existsSync.mockReturnValue(false);
      const files = await (service as any).collectSchedules('/tmp/sch');
      expect(files).toEqual([]);
    });

    it('collects schedules.json on the happy path (L2087-2101)', async () => {
      const files = await (service as any).collectSchedules('/tmp/sch');
      expect(files).toHaveLength(1);
      expect(files[0]).toMatchObject({ path: 'schedules/schedules.json', type: 'schedules_config', size: 123 });
      expect(fsMock.copyFile).toHaveBeenCalled();
    });

    it('swallows a copy error and returns [] (L2102-2104 catch)', async () => {
      fsMock.copyFile.mockRejectedValue(new Error('EPERM'));
      const files = await (service as any).collectSchedules('/tmp/sch');
      expect(files).toEqual([]);
    });
  });
});
