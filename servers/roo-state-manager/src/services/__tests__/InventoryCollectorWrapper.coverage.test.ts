/**
 * #833 Sprint C3 — branch/statement-coverage complement for InventoryCollectorWrapper.
 *
 * Add-only, tests-only. Zero source / existing-test change. The existing
 * `InventoryCollectorWrapper.test.ts` drives loadFromSharedState with a null
 * collector and a getSharedStatePath mock that (silently) targets the wrong module
 * (`server-helpers.js` instead of the SUT's `shared-state-path.js`), so it never
 * reaches:
 *   - the InventoryService fallback block (collectInventory L74-116),
 *   - convertToBaselineFormat (L342-405, only reached when the collector returns
 *     a non-null inventory),
 *   - the per-source catch arms (L70, L114, L157, L168, L181) and the BOM /
 *     convertRawToBaselineFormat left-hand arms.
 *
 * This file mocks the CORRECT modules and controls fs + InventoryService + the
 * injected collector per test to reach those paths.
 *
 * Not covered (skip-with-evidence, not a test gap):
 *   - L58/59/60 `catch (loadError)` around `this.loadFromSharedState(...)` —
 *     UNREACHABLE. loadFromSharedState's whole body is wrapped in try/catch
 *     (L134-264) that returns null on any error, so the awaited call never
 *     rejects; the outer catch can never fire.
 *   - L230-233 `if (!latestFile)` and L234-237 `catch (sortError)` — the sort
 *     runs only when machineFiles.length > 0 (guarded L199), so allSorted[0] is
 *     always defined, and Array.prototype.sort over a pure comparator does not
 *     throw. Both are defensive guards with no reachable input.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  readFile: vi.fn(),
  readdir: vi.fn(),
  existsSync: vi.fn(),
  getSharedStatePath: vi.fn(() => '/mock/shared'),
  getMachineInventory: vi.fn(),
}));

vi.mock('fs', () => ({
  promises: { readFile: h.readFile, readdir: h.readdir },
  existsSync: h.existsSync,
}));
vi.mock('../../utils/shared-state-path.js', () => ({ getSharedStatePath: h.getSharedStatePath }));
vi.mock('../../utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../roosync/InventoryService.js', () => ({
  InventoryService: { getInstance: vi.fn(() => ({ getMachineInventory: h.getMachineInventory })) },
}));

import { InventoryCollectorWrapper } from '../InventoryCollectorWrapper.js';
import type { InventoryCollector } from '../InventoryCollector.js';

const BOM = '﻿';

function makeWrapper(collectorImpl?: any) {
  const collector = {
    collectInventory: collectorImpl ?? vi.fn().mockResolvedValue(null),
    getCacheStats: vi.fn(),
    clearCache: vi.fn(),
  } as unknown as InventoryCollector;
  return new InventoryCollectorWrapper(collector);
}

/** Drive loadFromSharedState to a clean null (no exact file, empty dir). */
function noSharedState() {
  h.existsSync.mockReturnValue(false);
  h.readdir.mockResolvedValue([]);
}

describe('InventoryCollectorWrapper — residual coverage (#833 C3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.getSharedStatePath.mockReturnValue('/mock/shared');
    h.existsSync.mockReturnValue(false);
    h.readdir.mockResolvedValue([]);
    h.readFile.mockResolvedValue('{}');
    h.getMachineInventory.mockResolvedValue(null);
  });
  afterEach(() => vi.restoreAllMocks());

  // ---- collectInventory: local collector catch (L70 both instanceof arms) ---
  it('logs and continues when the local collector rejects with an Error (L70 error.message arm)', async () => {
    noSharedState();
    const wrapper = makeWrapper(vi.fn().mockRejectedValue(new Error('collector boom')));
    // shared=null, local throws, service=null → throws InventoryCollectorError (L119) → rethrown (L124).
    await expect(wrapper.collectInventory('m1')).rejects.toThrow(/Échec collecte inventaire/);
  });

  it('logs and continues when the local collector rejects with a non-Error (L70 String arm)', async () => {
    noSharedState();
    const wrapper = makeWrapper(vi.fn().mockRejectedValue('string-failure'));
    await expect(wrapper.collectInventory('m1')).rejects.toThrow(/Échec collecte inventaire/);
  });

  // ---- collectInventory: InventoryService fallback success (L78-113) --------
  it('builds a baseline from InventoryService when shared+local yield nothing (L78-113)', async () => {
    noSharedState();
    h.getMachineInventory.mockResolvedValue({
      machineId: 'm1',
      timestamp: '2025-10-02T00:00:00Z',
      inventory: {
        // three map arms: slug, name (slug absent), String(m) (both absent → primitive)
        rooModes: [{ slug: 'code' }, { name: 'debug' }, 'orchestrator'],
        systemInfo: { powershellVersion: '7.4', os: 'Windows 11' },
      },
      paths: { rooExtensions: 'D:/roo' },
    });
    const wrapper = makeWrapper(); // collector → null

    const result = await wrapper.collectInventory('m1');
    expect(result).not.toBeNull();
    expect(result!.machineId).toBe('m1');
    expect(result!.config.roo.modes).toEqual(['code', 'debug', 'orchestrator']);
    expect(result!.config.software.powershell).toBe('7.4');
    expect(result!.config.system.os).toBe('Windows 11');
    expect((result!.metadata as any).source).toBe('local');
  });

  it('uses defaults when the InventoryService payload omits rooModes/systemInfo (L86 ||[], L97/L102 ?. arms)', async () => {
    noSharedState();
    h.getMachineInventory.mockResolvedValue({
      machineId: 'm2',
      timestamp: 't',
      inventory: {}, // no rooModes, no systemInfo
      paths: {},
    });
    const wrapper = makeWrapper();

    const result = await wrapper.collectInventory('m2');
    expect(result!.config.roo.modes).toEqual([]);
    expect(result!.config.software.powershell).toBe('N/A');
    expect(result!.config.system.os).toBe('N/A');
  });

  // ---- collectInventory: InventoryService throws (L114-116) -----------------
  it('logs and continues when InventoryService.getMachineInventory rejects (L114 catch)', async () => {
    noSharedState();
    h.getMachineInventory.mockRejectedValue(new Error('service down'));
    const wrapper = makeWrapper();
    await expect(wrapper.collectInventory('m3')).rejects.toThrow(/Échec collecte inventaire/);
  });

  // ---- convertToBaselineFormat via a non-null collector (L64-67, L357-395) --
  it('converts a fully-populated local inventory, preserving paths (convertToBaselineFormat left arms + L394 true)', async () => {
    h.existsSync.mockReturnValue(false);
    h.readdir.mockResolvedValue([]); // shared → null
    const fullInventory = {
      machineId: 'local-1',
      timestamp: 't',
      hardware: {
        cpu: { cores: 8, threads: 16 },
        memory: { total: 32_000_000_000 },
        disks: [{ drive: 'C:', size: 500_000_000_000 }, {}], // 2nd: drive/size absent
        gpu: [{ name: 'RTX 4090' }],
      },
      software: { powershell: '7.4', node: '20.0', python: '3.11' },
      system: { os: 'Windows 11', architecture: 'x64' },
      paths: { rooExtensions: 'D:/roo' },
    };
    const wrapper = makeWrapper(vi.fn().mockResolvedValue(fullInventory));

    const result = await wrapper.collectInventory('local-1');
    expect(result!.config.hardware.cpu.cores).toBe(8);
    expect(result!.config.hardware.cpu.threads).toBe(16);
    expect(result!.config.hardware.gpu).toBe('RTX 4090');
    expect(result!.config.hardware.disks[0].name).toBe('C:');
    expect(result!.config.hardware.disks[1].name).toBe('Unknown');
    expect(result!.config.software.node).toBe('20.0');
    expect((result!.paths as any).rooExtensions).toBe('D:/roo');
  });

  it('converts a minimal local inventory, defaulting every field (convertToBaselineFormat right arms + L397 else)', async () => {
    h.existsSync.mockReturnValue(false);
    h.readdir.mockResolvedValue([]);
    const minimalInventory = {
      machineId: 'local-2',
      timestamp: 't',
      hardware: { disks: [], gpu: [] }, // no cpu, no memory
      software: {},
      system: {},
      // no paths → L380 default + L394 false → L397
    };
    const wrapper = makeWrapper(vi.fn().mockResolvedValue(minimalInventory));

    const result = await wrapper.collectInventory('local-2');
    expect(result!.config.hardware.cpu.cores).toBe(0);
    expect(result!.config.hardware.memory.total).toBe(0);
    expect(result!.config.hardware.gpu).toBe('None');
    expect(result!.config.software.powershell).toBe('Unknown');
    expect(result!.config.system.os).toBe('Unknown');
    expect((result!.paths as any).rooExtensions).toBeUndefined();
  });

  // ---- loadFromSharedState: exact file, readFile throws (L157 catch) --------
  it('logs and falls through when the exact shared file read throws (L157 exactError arm)', async () => {
    h.existsSync.mockImplementation((p: string) => p.includes('m4.json') && !p.includes('.toLowerCase'));
    h.readFile.mockRejectedValue(new Error('EACCES'));
    h.readdir.mockResolvedValue([]); // then dir empty → null
    const wrapper = makeWrapper(); // collector null, service null
    await expect(wrapper.collectInventory('m4')).rejects.toThrow(/Échec collecte inventaire/);
    expect(h.readFile).toHaveBeenCalled();
  });

  // ---- loadFromSharedState: exact file full raw + BOM (convertRaw left) -----
  it('parses the exact shared file (with BOM) into a baseline via convertRawToBaselineFormat (L150-155, gpu array)', async () => {
    h.existsSync.mockImplementation((p: string) => p.includes('m5.json'));
    const raw = {
      machineId: 'm5', timestamp: 't',
      roo: { modes: ['code'], mcpServers: { srv: { cmd: 'x' } } },
      hardware: {
        cpu: { cores: 4, threads: 8 },
        memory: { total: 16_000_000_000 },
        disks: [{ drive: 'C:', size: 250_000_000_000 }, {}],
        gpu: [{ name: 'GTX 1080' }, { name: 'GTX 1070' }],
      },
      software: { powershell: '5.1', node: '18', python: '3.10' },
      system: { os: 'Windows 10', architecture: 'x64' },
      paths: { rooExtensions: 'C:/roo' },
    };
    h.readFile.mockResolvedValue(BOM + JSON.stringify(raw)); // BOM → L151-153 slice
    const wrapper = makeWrapper();

    const result = await wrapper.collectInventory('m5');
    expect(result!.machineId).toBe('m5');
    expect(result!.config.roo.modes).toEqual(['code']);
    expect(result!.config.hardware.gpu).toBe('GTX 1080, GTX 1070'); // array → join
    expect(result!.config.hardware.cpu.cores).toBe(4);
    expect((result!.metadata as any).source).toBe('remote');
  });

  it('defaults every field when the exact shared file holds a minimal object (convertRaw right arms, gpu None, L325 else)', async () => {
    h.existsSync.mockImplementation((p: string) => p.includes('m6.json'));
    h.readFile.mockResolvedValue(JSON.stringify({ machineId: 'm6', timestamp: 't' }));
    const wrapper = makeWrapper();

    const result = await wrapper.collectInventory('m6');
    expect(result!.config.roo.modes).toEqual([]);
    expect(result!.config.hardware.cpu.cores).toBe(0);
    expect(result!.config.hardware.gpu).toBe('None');
    expect(result!.config.software.node).toBe('N/A');
    expect((result!.paths as any).rooExtensions).toBeUndefined();
  });

  // ---- loadFromSharedState: lowercase file branch + BOM + gpu-object --------
  it('reads the case-insensitive shared file (with BOM) and handles a single gpu object (L159-167, L296 else)', async () => {
    // exact (m7.json) missing, lowercase (m7.json from machineId.toLowerCase) present.
    // machineId 'M7' → exact 'M7.json' absent, lower 'm7.json' present.
    h.existsSync.mockImplementation((p: string) => p.includes('m7.json') && !p.includes('M7.json'));
    const raw = {
      machineId: 'M7', timestamp: 't',
      hardware: { gpu: { name: 'Quadro' } }, // single object → Array.isArray false → gpu.name
    };
    h.readFile.mockResolvedValue(BOM + JSON.stringify(raw));
    const wrapper = makeWrapper();

    const result = await wrapper.collectInventory('M7');
    expect(result!.config.hardware.gpu).toBe('Quadro');
  });

  it('logs and falls through when the lowercase shared file read throws (L168 exactError arm)', async () => {
    h.existsSync.mockImplementation((p: string) => p.includes('m8.json') && !p.includes('M8.json'));
    h.readFile.mockRejectedValue(new Error('EACCES-lower'));
    h.readdir.mockResolvedValue([]);
    const wrapper = makeWrapper();
    await expect(wrapper.collectInventory('M8')).rejects.toThrow(/Échec collecte inventaire/);
  });

  // ---- loadFromSharedState: readdir throws (L181 catch) ---------------------
  it('returns null (falls through) when the shared directory read throws (L181 readdirError arm)', async () => {
    h.existsSync.mockReturnValue(false); // no exact/lowercase file
    h.readdir.mockRejectedValue(new Error('ENOENT dir'));
    const wrapper = makeWrapper();
    await expect(wrapper.collectInventory('m9')).rejects.toThrow(/Échec collecte inventaire/);
  });

  // ---- loadFromSharedState: main dir path, -fixed priority, BOM (L191-260) --
  it('picks the newest -fixed timestamped file from the directory listing and strips its BOM (L213-260, L247)', async () => {
    h.existsSync.mockReturnValue(false); // force the readdir path
    h.readdir.mockResolvedValue([
      'm10-2025-10-17T14-20-00-000Z.json',
      'm10-2025-10-18T11-36-21-070Z-fixed.json',
      'unrelated.json',
    ]);
    const raw = { machineId: 'm10', timestamp: 't', roo: { modes: ['debug'] } };
    h.readFile.mockResolvedValue(BOM + JSON.stringify(raw));
    const wrapper = makeWrapper();

    const result = await wrapper.collectInventory('m10');
    expect(result!.machineId).toBe('m10');
    expect(result!.config.roo.modes).toEqual(['debug']);
    // the -fixed file must have been the one read
    const readArg = (h.readFile.mock.calls.at(-1)?.[0] as string) || '';
    expect(readArg).toContain('-fixed');
  });

  // ---- loadFromSharedState: outer catch on malformed JSON (L261 catch) ------
  it('returns null (falls through) when the selected file holds malformed JSON (L261 outer catch)', async () => {
    h.existsSync.mockReturnValue(false);
    h.readdir.mockResolvedValue(['m11-2025-10-18T11-36-21-070Z.json']);
    h.readFile.mockResolvedValue('{ this is : not json'); // JSON.parse throws → caught L261
    const wrapper = makeWrapper();
    await expect(wrapper.collectInventory('m11')).rejects.toThrow(/Échec collecte inventaire/);
  });

  // ---- catch-ternary String() arms (L157 / L169 / L181 second arm) ---------
  it('logs the String() arm when the exact file read rejects with a non-Error (L157 String arm)', async () => {
    h.existsSync.mockImplementation((p: string) => p.includes('s1.json'));
    h.readFile.mockRejectedValue('exact-string-fail'); // non-Error → String(exactError)
    h.readdir.mockResolvedValue([]);
    const wrapper = makeWrapper();
    await expect(wrapper.collectInventory('s1')).rejects.toThrow(/Échec collecte inventaire/);
  });

  it('logs the String() arm when the lowercase file read rejects with a non-Error (L169 String arm)', async () => {
    h.existsSync.mockImplementation((p: string) => p.includes('s2.json') && !p.includes('S2.json'));
    h.readFile.mockRejectedValue('lower-string-fail');
    h.readdir.mockResolvedValue([]);
    const wrapper = makeWrapper();
    await expect(wrapper.collectInventory('S2')).rejects.toThrow(/Échec collecte inventaire/);
  });

  it('logs the String() arm when the directory read rejects with a non-Error (L181 String arm)', async () => {
    h.existsSync.mockReturnValue(false);
    h.readdir.mockRejectedValue('readdir-string-fail');
    const wrapper = makeWrapper();
    await expect(wrapper.collectInventory('s3')).rejects.toThrow(/Échec collecte inventaire/);
  });

  // ---- convert right-arms: disks/gpu keys absent, gpu object w/o name ------
  it('defaults disks/gpu to [] when the local inventory omits those keys entirely (L363/L367 || [] arms)', async () => {
    h.existsSync.mockReturnValue(false);
    h.readdir.mockResolvedValue([]);
    const inv = { machineId: 'l3', timestamp: 't', hardware: {}, software: {}, system: {} };
    const wrapper = makeWrapper(vi.fn().mockResolvedValue(inv));

    const result = await wrapper.collectInventory('l3');
    expect(result!.config.hardware.disks).toEqual([]);
    expect(result!.config.hardware.gpu).toBe('None');
  });

  it('labels a single gpu object without a name as Unknown (convertRaw L298 || arm)', async () => {
    h.existsSync.mockImplementation((p: string) => p.includes('s5.json'));
    const raw = { machineId: 's5', timestamp: 't', hardware: { gpu: { vendor: 'x' } } }; // object, no .name
    h.readFile.mockResolvedValue(JSON.stringify(raw));
    const wrapper = makeWrapper();

    const result = await wrapper.collectInventory('s5');
    expect(result!.config.hardware.gpu).toBe('Unknown');
  });

  // ---- extractTimestampFromFilename fallback (L435 false → L438-439) --------
  // NB: extractTimestampFromFilename runs during the sort comparator, so a
  // filter-passing filename with no ISO match exercises the new Date(0) fallback.
  // (The dated sibling's captured stamp is dash-separated — '…T11-36-21-070Z' —
  // which `new Date` parses to Invalid Date/NaN, so intra-group ordering is a
  // no-op; asserting a winner would be brittle, so we only assert a valid load.)
  it('falls back to epoch for a matching file with no ISO timestamp (L438-439)', async () => {
    h.existsSync.mockReturnValue(false);
    h.readdir.mockResolvedValue(['s6-nostamp.json', 's6-2025-10-18T11-36-21-070Z.json']);
    h.readFile.mockResolvedValue(JSON.stringify({ machineId: 's6', timestamp: 't' }));
    const wrapper = makeWrapper();

    const result = await wrapper.collectInventory('s6');
    expect(result).not.toBeNull();
    expect(result!.machineId).toBe('s6');
  });
});
