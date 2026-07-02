/**
 * InventoryCollector — branch/coverage complement (#833 Sprint C3, po-2023 lane src/services/**)
 *
 * The pre-existing InventoryCollector.test.ts is shallow (9 tests, ~24% branch): its module mocks
 * are written relative to the __tests__ dir (`../utils/...`, `../utils/server-helpers.js`) whereas
 * the SUT imports `../utils/...` FROM src/services (i.e. src/utils/...). Those specifiers resolve to
 * different absolute paths, so the mocks never intercept and every collectInventory call short-circuits
 * to null before touching the real logic (getSharedStatePath, the PowerShell exec path, the two
 * loadInventoryFile formats, saveToSharedState).
 *
 * This ADD-ONLY file mocks the CORRECT modules (`../../utils/shared-state-path.js`, logger, git-helpers)
 * plus `fs`/`os`/`child_process`, so the uncovered branches are reached deterministically. Every
 * assertion cites the source line it exercises in InventoryCollector.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync, promises as fsp } from 'fs';
import os from 'os';

// --- mutable holder for the child_process.exec stub (execAsync is built at module-load, L22) ---
const h = vi.hoisted(() => ({
  // Node's real exec has a custom promisify returning {stdout,stderr}; a plain mock does not,
  // so generic promisify(exec) resolves with the single 2nd callback arg -> pass one object.
  execImpl: (_cmd: string, _opts: any, cb: (e: any, r?: any) => void) => cb(null, { stdout: '', stderr: '' }),
}));

vi.mock('child_process', () => ({
  exec: (cmd: string, opts: any, cb: any) => h.execImpl(cmd, opts, cb),
}));

// The SUT (src/services/InventoryCollector.ts) imports `../utils/shared-state-path.js` = src/utils/...
// From this test file (src/services/__tests__/) that same module is `../../utils/shared-state-path.js`.
vi.mock('../../utils/shared-state-path.js', () => ({
  getSharedStatePath: vi.fn(() => '/mock/shared'),
}));

vi.mock('../../utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../utils/git-helpers.js', () => ({
  getGitHelpers: () => ({
    verifyGitAvailable: vi.fn().mockResolvedValue({ available: true, version: 'git 2.40.0' }),
  }),
}));

vi.mock('fs', () => {
  const promises = {
    readFile: vi.fn(),
    readdir: vi.fn(),
    mkdir: vi.fn(),
    writeFile: vi.fn(),
  };
  const api = {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    promises,
  };
  return { ...api, default: api };
});

vi.mock('os', () => {
  const api = {
    hostname: vi.fn(() => 'myia-po-2023'),
    platform: vi.fn(() => 'win32'),
    arch: vi.fn(() => 'x64'),
    uptime: vi.fn(() => 12345),
    cpus: vi.fn(() => [{ model: 'x' }, { model: 'x' }, { model: 'x' }, { model: 'x' }]),
    totalmem: vi.fn(() => 16_000_000_000),
    freemem: vi.fn(() => 8_000_000_000),
  };
  return { ...api, default: api };
});

// Import AFTER the mocks so the module-load `promisify(exec)` binds to the stub.
import { InventoryCollector, type MachineInventory } from '../InventoryCollector.js';

const LOCAL = 'myia-po-2023'; // matches os.hostname() mock -> isLocalMachine true (L296-298)
const REMOTE = 'remote-box';  // not hostname, not ai-01 -> remote (L300)

/** A full "raw" nested inventory (PowerShell script format) that exercises every `||` LEFT branch. */
function rawNestedFull(machineId = LOCAL) {
  return {
    machineId,
    timestamp: '2026-07-02T10:00:00Z',
    paths: { root: '/x' },
    inventory: {
      systemInfo: {
        hostname: 'HOST-A', os: 'Windows 11', architecture: 'amd64', uptime: 999,
        processor: 'Ryzen 9', cpuCores: 12, cpuThreads: 24,
        totalMemory: 64_000_000_000, availableMemory: 32_000_000_000,
        disks: [{ drive: 'C:', size: 1, free: 1 }], gpu: [{ name: 'RTX', memory: 8 }],
      },
      tools: { powershell: { version: '7.4' }, node: { version: '20.1' }, python: { version: '3.11' } },
      mcpServers: [{ name: 'roo-state-manager', enabled: true, command: 'node', transportType: 'stdio', alwaysAllow: [], description: 'd' }],
      rooModes: [{ slug: 'code', name: 'Code', defaultModel: 'sonnet', tools: [], allowedFilePatterns: [] }],
      sdddSpecs: { a: 1 }, scripts: { b: 2 },
      rooConfig: { modelProfile: { hash: 'H1', profiles: {}, apiConfigs: {}, modeApiConfigs: {}, profileThresholds: {}, lastModified: 't' } },
      vscodeConfig: { v: 1 }, wslDistros: ['Ubuntu'], dockerDetails: { d: 1 }, pythonEnvs: { p: 1 },
      windowsServices: [{ s: 1 }], gpuDetails: [{ g: 1 }], listeningPorts: [{ protocol: 'TCP' }],
    },
  };
}

describe('InventoryCollector — coverage complement (#833 C3)', () => {
  let collector: InventoryCollector;

  beforeEach(() => {
    vi.clearAllMocks();
    // sensible non-throwing defaults; individual tests override existsSync / readFile / readFileSync
    vi.mocked(fsp.mkdir).mockResolvedValue(undefined as any);
    vi.mocked(fsp.writeFile).mockResolvedValue(undefined as any);
    vi.mocked(fsp.readdir).mockResolvedValue([] as any);
    h.execImpl = (_c, _o, cb) => cb(null, { stdout: '', stderr: '' });
    collector = new InventoryCollector();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ---- loadFromSharedState: exact {machineId}.json + loadInventoryFile "raw" format (L509-511, L574-662) ----
  it('loads exact shared-state file in "raw" nested format and maps every field', async () => {
    vi.mocked(existsSync).mockImplementation((p: any) => String(p).includes('inventories') || String(p).includes(`${LOCAL}.json`));
    vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify(rawNestedFull(LOCAL)) as any);

    const inv = await collector.collectInventory(LOCAL) as MachineInventory;

    // exact-file branch L509-511 taken; loadInventoryFile "raw" gate L574 true
    expect(inv).not.toBeNull();
    expect(inv.machineId).toBe(LOCAL);           // L578
    expect(inv.system.hostname).toBe('HOST-A');  // L581 LEFT of ||
    expect(inv.system.os).toBe('Windows 11');    // L582 LEFT
    expect(inv.hardware.cpu.name).toBe('Ryzen 9'); // L593 LEFT
    expect(inv.hardware.cpu.cores).toBe(12);       // L594 LEFT
    expect(inv.hardware.memory.total).toBe(64_000_000_000); // L598 LEFT
    expect(inv.software.powershell).toBe('7.4');   // L617 LEFT
    expect(inv.software.node).toBe('20.1');        // L618
    expect(inv.roo.mcpServers[0].name).toBe('roo-state-manager'); // L626-627
    expect(inv.roo.modes[0].slug).toBe('code');    // L634-635
    expect(inv.roo.modelProfile?.hash).toBe('H1'); // L644-645 (modelProfile present branch)
    expect(inv.wslDistros).toEqual(['Ubuntu']);    // L656
    expect((inv as any).listeningPorts[0].protocol).toBe('TCP'); // L661
  });

  // ---- collectInventory cache hit: second call short-circuits at isCacheValid (L276-278) ----
  it('returns the cached inventory on the second call without re-reading shared state', async () => {
    vi.mocked(existsSync).mockImplementation((p: any) => String(p).includes('inventories') || String(p).includes(`${LOCAL}.json`));
    vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify(rawNestedFull(LOCAL)) as any);

    const first = await collector.collectInventory(LOCAL);   // primes cache via loadInventoryFile L675
    const readsAfterFirst = vi.mocked(fsp.readFile).mock.calls.length;
    const second = await collector.collectInventory(LOCAL);  // isCacheValid true -> L278 return cache

    expect(second).toBe(first);                                  // same cached object reference
    expect(vi.mocked(fsp.readFile).mock.calls.length).toBe(readsAfterFirst); // no extra read
  });

  // ---- isCacheValid expired branch (L473-479): age >= TTL -> delete + re-fetch ----
  it('re-loads when the cached entry has expired past the 1h TTL', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-02T00:00:00Z'));
    const c = new InventoryCollector();
    vi.mocked(existsSync).mockImplementation((p: any) => String(p).includes('inventories') || String(p).includes(`${LOCAL}.json`));
    vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify(rawNestedFull(LOCAL)) as any);

    await c.collectInventory(LOCAL);                    // cache timestamp = now (fake)
    const readsAfterPrime = vi.mocked(fsp.readFile).mock.calls.length;
    vi.advanceTimersByTime(3_600_001);                 // > cacheTTL 3600000ms (L227)
    await c.collectInventory(LOCAL);                   // isCacheValid false (L474/476) -> re-read

    expect(vi.mocked(fsp.readFile).mock.calls.length).toBe(readsAfterPrime + 1);
  });

  // ---- loadFromSharedState: exact-lowercase branch + loadInventoryFile "baseline" format (L512-514, L663-666) ----
  it('falls back to the lowercased exact filename and accepts the "baseline" direct format', async () => {
    const MIXED = 'MyIA-Po-2023';
    const baseline: any = { machineId: MIXED, timestamp: 't', paths: {}, system: { hostname: 'h' }, hardware: {}, software: {}, roo: {} };
    vi.mocked(existsSync).mockImplementation((p: any) => {
      const s = String(p);
      if (s.includes(`${MIXED}.json`)) return false;                 // exact (mixed) NOT found -> L512
      if (s.includes(`${MIXED.toLowerCase()}.json`)) return true;    // lowercased found
      return s.includes('inventories');
    });
    vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify(baseline) as any);

    const inv = await collector.collectInventory(MIXED) as MachineInventory;

    expect(inv).not.toBeNull();
    expect(inv.machineId).toBe(MIXED);   // "baseline" branch L666 returns raw as-is
    expect(inv.system.hostname).toBe('h');
  });

  // ---- loadFromSharedState: timestamped readdir match path (L518-541) ----
  it('selects the most recent timestamped file when no exact match exists', async () => {
    vi.mocked(existsSync).mockImplementation((p: any) => {
      const s = String(p);
      if (s.endsWith(`${LOCAL}.json`)) return false;   // neither exact nor lower (same casing)
      return s.includes('inventories');
    });
    vi.mocked(fsp.readdir).mockResolvedValue([
      `${LOCAL}-2026-07-01.json`,
      `${LOCAL}-2026-07-02.json`,  // lexicographically greatest -> sort().reverse() picks this (L530-531)
      'unrelated.json',
    ] as any);
    const captured: string[] = [];
    vi.mocked(fsp.readFile).mockImplementation(((fp: any) => { captured.push(String(fp)); return Promise.resolve(JSON.stringify(rawNestedFull(LOCAL))); }) as any);

    const inv = await collector.collectInventory(LOCAL) as MachineInventory;

    expect(inv).not.toBeNull();
    expect(captured[0]).toContain(`${LOCAL}-2026-07-02.json`); // latest file loaded (L539-541)
  });

  // ---- loadFromSharedState: dir missing + remote machine -> null (L499-502, L300-302) ----
  it('returns null for a remote machine with no shared-state directory', async () => {
    vi.mocked(existsSync).mockReturnValue(false); // inventoriesDir missing L499
    const inv = await collector.collectInventory(REMOTE);
    expect(inv).toBeNull(); // remote + no shared -> L302
  });

  // ---- loadFromSharedState: dir present but zero matching files -> null (L533-535) ----
  it('returns null when the inventories dir has no file for the machine', async () => {
    vi.mocked(existsSync).mockImplementation((p: any) => String(p).includes('inventories') && !String(p).endsWith('.json'));
    vi.mocked(fsp.readdir).mockResolvedValue(['someone-else.json'] as any);
    const inv = await collector.collectInventory(REMOTE);
    expect(inv).toBeNull(); // machineFiles.length === 0 -> L535, then remote -> null
  });

  // ---- loadFromSharedState: readdir throws -> catch -> null (L543-546) ----
  it('returns null (graceful) when reading the shared-state dir throws', async () => {
    vi.mocked(existsSync).mockImplementation((p: any) => String(p).includes('inventories') && !String(p).endsWith('.json'));
    vi.mocked(fsp.readdir).mockRejectedValue(new Error('EACCES'));
    const inv = await collector.collectInventory(REMOTE);
    expect(inv).toBeNull(); // catch L544 -> null
  });

  // ---- loadInventoryFile: "raw" gate true but inventory has no systemInfo/tools -> fallback branches (L585-590, L603-615, L620-624) ----
  it('applies os.* fallbacks when the raw inventory lacks systemInfo/tools', async () => {
    const raw = { machineId: LOCAL, timestamp: 't', paths: {}, inventory: {} }; // inventory truthy, systemInfo/tools absent
    vi.mocked(existsSync).mockImplementation((p: any) => String(p).includes('inventories') || String(p).includes(`${LOCAL}.json`));
    vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify(raw) as any);

    const inv = await collector.collectInventory(LOCAL) as MachineInventory;

    expect(inv.system.hostname).toBe('myia-po-2023'); // os.hostname() fallback L586
    expect(inv.system.architecture).toBe('x64');       // os.arch() fallback L588
    expect(inv.hardware.cpu.name).toBe('Unknown');     // L605 RIGHT branch
    expect(inv.hardware.cpu.cores).toBe(4);            // os.cpus().length fallback L606
    expect(inv.software.powershell).toBe('Unknown');   // L621 RIGHT branch
    expect(inv.roo.mcpServers).toEqual([]);            // (raw.inventory?.mcpServers || []) L626
    expect(inv.roo.modelProfile).toBeUndefined();      // rooConfig absent -> L644 undefined
  });

  // ---- loadInventoryFile: unrecognized format -> null (L667-669) ----
  it('returns null for an inventory file whose shape matches no known format', async () => {
    vi.mocked(existsSync).mockImplementation((p: any) => String(p).includes('inventories') || String(p).includes(`${LOCAL}.json`));
    vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify({ nonsense: true }) as any); // no machineId/timestamp/paths
    const inv = await collector.collectInventory(LOCAL);
    // loadInventoryFile returns null (L669); LOCAL machine then falls through to PS-exec which
    // finds no script (existsSync false for the .ps1) -> also null (L322). Net: null.
    expect(inv).toBeNull();
  });

  // ---- loadInventoryFile: BOM strip (L562-564) + JSON parse error catch (L681-683) ----
  it('strips a UTF-8 BOM and returns null when the file is not valid JSON', async () => {
    vi.mocked(existsSync).mockImplementation((p: any) => String(p).includes('inventories') || String(p).includes(`${LOCAL}.json`));
    // BOM prefix + broken JSON: BOM stripped (L563), JSON.parse throws -> catch L682 -> null
    vi.mocked(fsp.readFile).mockResolvedValue(('﻿' + '{ not json') as any);
    // No script fallback either -> stays null
    const inv = await collector.collectInventory(LOCAL);
    expect(inv).toBeNull();
  });

  // ---- collectInventory PS-exec fallback: full mapping over rawInventory (L307-453, LEFT branches) ----
  it('runs the PowerShell fallback and maps a full rawInventory (LEFT branches L379-438)', async () => {
    // Shared state absent so we reach the exec fallback; script + json output exist.
    vi.mocked(existsSync).mockImplementation((p: any) => {
      const s = String(p);
      if (s.includes('inventories')) return false;               // loadFromSharedState -> null (L501)
      if (s.includes('Get-MachineInventory.ps1')) return true;   // script found (L320 false-branch)
      if (s.includes('inv-out.json')) return true;               // json output found (L357)
      return false;
    });
    h.execImpl = (_c, _o, cb) => cb(null, { stdout: 'log line\nC:/tmp/inv-out.json', stderr: '' }); // last line = abs path (has ':')
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(rawNestedFull(LOCAL)) as any);

    const inv = await collector.collectInventory(LOCAL, true) as MachineInventory; // forceRefresh -> still tries shared first (L284) then exec

    expect(inv).not.toBeNull();
    expect(inv.system.hostname).toBe('HOST-A');   // L379 LEFT
    expect(inv.hardware.cpu.name).toBe('Ryzen 9'); // L386 LEFT
    expect(inv.software.powershell).toBe('7.4');   // L398 LEFT
    expect(inv.roo.mcpServers[0].name).toBe('roo-state-manager'); // L403-404
    expect((inv as any).listeningPorts[0].protocol).toBe('TCP');  // L438
    expect(vi.mocked(fsp.writeFile)).toHaveBeenCalled(); // saveToSharedState wrote the file (L709)
  });

  // ---- collectInventory PS-exec: minimal rawInventory -> os.* fallbacks (L379-438 RIGHT branches) ----
  it('maps a minimal rawInventory via os.* fallbacks in the PowerShell path', async () => {
    vi.mocked(existsSync).mockImplementation((p: any) => {
      const s = String(p);
      if (s.includes('inventories')) return false;
      if (s.includes('Get-MachineInventory.ps1')) return true;
      if (s.includes('inv-out.json')) return true;
      return false;
    });
    h.execImpl = (_c, _o, cb) => cb(null, { stdout: 'C:/tmp/inv-out.json', stderr: 'a warning' }); // also exercises stderr log L341-342
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ machineId: LOCAL, timestamp: 't' }) as any); // no inventory

    const inv = await collector.collectInventory(LOCAL) as MachineInventory;

    expect(inv).not.toBeNull();
    expect(inv.system.hostname).toBe('myia-po-2023'); // os.hostname() RIGHT L379
    expect(inv.hardware.cpu.name).toBe('Unknown');    // L386 RIGHT
    expect(inv.hardware.cpu.cores).toBe(4);           // os.cpus().length L387
    expect(inv.software.powershell).toBe('Unknown');  // L398 RIGHT
    expect(inv.roo.mcpServers).toEqual([]);           // L403 default
  });

  // ---- collectInventory PS-exec: script not found -> null (L320-322) ----
  it('returns null when the PowerShell inventory script is missing', async () => {
    vi.mocked(existsSync).mockReturnValue(false); // inventoriesDir + script both false
    const inv = await collector.collectInventory(LOCAL);
    expect(inv).toBeNull(); // script not found L322
  });

  // ---- collectInventory PS-exec: JSON output file not found -> null (L357-359) ----
  it('returns null when the script output JSON path does not exist', async () => {
    vi.mocked(existsSync).mockImplementation((p: any) => {
      const s = String(p);
      if (s.includes('Get-MachineInventory.ps1')) return true; // script exists
      return false;                                            // inventoriesDir + json both false
    });
    h.execImpl = (_c, _o, cb) => cb(null, { stdout: 'C:/tmp/missing.json', stderr: '' });
    const inv = await collector.collectInventory(LOCAL);
    expect(inv).toBeNull(); // json not found L359
  });

  // ---- collectInventory PS-exec: exec rejects -> catch -> null (L455-457) ----
  it('returns null (graceful degradation) when the PowerShell exec fails', async () => {
    vi.mocked(existsSync).mockImplementation((p: any) => String(p).includes('Get-MachineInventory.ps1'));
    h.execImpl = (_c, _o, cb) => cb(new Error('powershell boom'));
    const inv = await collector.collectInventory(LOCAL);
    expect(inv).toBeNull(); // catch L456 -> null
  });

  // ---- getCacheStats / clearCache after populating the cache (L721-724, L729-739) ----
  it('reports and clears cache stats after a successful collect', async () => {
    vi.mocked(existsSync).mockImplementation((p: any) => String(p).includes('inventories') || String(p).includes(`${LOCAL}.json`));
    vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify(rawNestedFull(LOCAL)) as any);
    await collector.collectInventory(LOCAL);

    const stats = collector.getCacheStats();
    expect(stats.size).toBe(1);                        // L736
    expect(stats.entries[0].machineId).toBe(LOCAL);    // L730-731
    expect(typeof stats.entries[0].age).toBe('number');// L732

    collector.clearCache();                            // L723
    expect(collector.getCacheStats().size).toBe(0);
  });
});
