/**
 * Coverage tests for roosync_init.ts — branches non couvertes par le fresh
 * coverage measure (73.07% stmts / 59.52% branch / 75% funcs).
 *
 * Le test existant (roosync_init.test.ts, 8 func tests) mock `existsSync`→false
 * pour TOUT → le script d'inventaire PowerShell n'est jamais trouvé (L230-231
 * "Script not found") → toute l'intégration inventaire (L234-313, ~80 LOC) est
 * non couverte. Gaps ciblés (fresh measure) :
 *
 *  - Intégration inventaire happy-path (L234-313) : script trouvé, exec OK,
 *    JSON lu (BOM + no-BOM), sync-config écrit (new + merge), unlink cleanup.
 *  - Inventaire : JSON file not found/invalid (L311-314).
 *  - Inventaire : exec error catch (L315-320).
 *  - Dashboard exists + machine déjà enregistrée → skip (L212-214).
 *  - Roadmap create (L331-334) + skip-quand-existe (L335-337).
 *  - Rollback dir create + skip (L340-347).
 *  - Wrap non-RSE error (L374-377).
 *
 * `vi.resetModules()` + dynamic import pour contrôler `getRooSyncService`
 * (throw cases) sans interférer avec le mock factory de la suite existante.
 *
 * @module tools/roosync/__tests__/roosync_init.coverage
 * Issue: Vein D Lane R (po-2023) coverage dispatch
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  mockGetRooSyncService,
  mockGetConfig,
  mockExistsSync,
  mockMkdirSync,
  mockWriteFileSync,
  mockReadFileSync,
  mockUnlinkSync,
  mockReadJSONWithoutBOM,
  mockExec,
} = vi.hoisted(() => ({
  mockGetRooSyncService: vi.fn(),
  mockGetConfig: vi.fn(),
  mockExistsSync: vi.fn(),
  mockMkdirSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockUnlinkSync: vi.fn(),
  mockReadJSONWithoutBOM: vi.fn(),
  mockExec: vi.fn(),
}));

vi.mock('../../../services/lazy-roosync.js', () => ({
  getRooSyncService: (...args: unknown[]) => mockGetRooSyncService(...args),
  RooSyncServiceError: class extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.name = 'RooSyncServiceError';
      this.code = code;
    }
  },
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: actual,
    existsSync: (...args: unknown[]) => mockExistsSync(...(args as [string])),
    mkdirSync: (...args: unknown[]) => mockMkdirSync(...(args as [string, unknown])),
    writeFileSync: (...args: unknown[]) => mockWriteFileSync(...(args as [string, string, string])),
    readFileSync: (...args: unknown[]) => mockReadFileSync(...(args as [string, string])),
    unlinkSync: (...args: unknown[]) => mockUnlinkSync(...(args as [string])),
  };
});

vi.mock('child_process', () => ({
  // promisify(exec) appends a (err, result) callback; we forward to mockExec.
  exec: (...args: unknown[]) => mockExec(...args),
}));

vi.mock('../../../utils/encoding-helpers.js', () => ({
  readJSONFileSyncWithoutBOM: (...args: unknown[]) => mockReadJSONWithoutBOM(...(args as [string])),
  readFileSyncWithoutBOM: vi.fn(() => ''),
  stripBOM: vi.fn((s: string) => s),
}));

vi.mock('../../../utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
  Logger: class {},
}));

let roosyncInit: typeof import('../roosync_init.js')['roosyncInit'];

const CONFIG = { machineId: 'cov-machine', sharedPath: '/shared/cov' };

beforeEach(async () => {
  vi.clearAllMocks();
  // Default: service resolves, getConfig returns canonical config.
  mockGetRooSyncService.mockResolvedValue({ getConfig: mockGetConfig });
  mockGetConfig.mockReturnValue({ ...CONFIG });
  // Default existsSync: sharedPath + script never found (existing-suite
  // baseline). Per-test overrides refine this.
  mockExistsSync.mockImplementation((p: string) => {
    if (p === CONFIG.sharedPath) return true; // sharedPath exists
    return false; // dashboard, roadmap, rollback, script, inventory json
  });
  mockMkdirSync.mockReturnValue(undefined);
  mockWriteFileSync.mockReturnValue(undefined);
  mockUnlinkSync.mockReturnValue(undefined);
  mockReadJSONWithoutBOM.mockReturnValue({ machines: {} });

  vi.resetModules();
  ({ roosyncInit } = await import('../roosync_init.js'));
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Helper: make the PowerShell inventory script "found" and a generated JSON
// "present". stdout's last line = relative inventory filename (no ':' so the
// code joins it with projectRoot).
function inventoryFound(opts?: { bom?: boolean; syncConfigExists?: boolean; unlinkThrows?: boolean }) {
  const invJson = JSON.stringify({
    inventory: { hostname: 'cov-host' },
    timestamp: '2026-07-09T00:00:00Z',
    paths: { root: '/x' },
  });
  const content = opts?.bom ? '﻿' + invJson : invJson;

  mockExistsSync.mockImplementation((p: string) => {
    if (typeof p !== 'string') return false;
    if (p === CONFIG.sharedPath) return true;
    if (p.includes('Get-MachineInventory.ps1')) return true; // script found
    if (p.includes('inv-generated.json')) return true; // generated JSON present
    if (p.includes('sync-config.json')) return !!opts?.syncConfigExists;
    return false; // dashboard/roadmap/rollback
  });
  // exec success: stdout last line = the generated JSON filename (relative).
  mockExec.mockImplementation((_cmd: unknown, _opts: unknown, cb: (e: unknown, r: { stdout: string; stderr: string }) => void) =>
    cb(null, { stdout: `log line\ninv-generated.json`, stderr: '' }),
  );
  mockReadFileSync.mockImplementation((p: string) => {
    if (typeof p === 'string' && p.includes('inv-generated.json')) return content;
    return '';
  });
  if (opts?.unlinkThrows) {
    mockUnlinkSync.mockImplementation(() => {
      throw new Error('EBUSY');
    });
  }
}

// ============================================================
// Inventory PowerShell integration — happy path + variants
// Covers L234-313 (script found → exec → JSON → sync-config → unlink).
// ============================================================
describe('inventory integration (L234-313)', () => {
  test('script found + exec OK + JSON without BOM → sync-config written (new), temp unlinked', async () => {
    inventoryFound({ syncConfigExists: false });

    const result = await roosyncInit({});

    expect(result.success).toBe(true);
    expect(result.filesCreated).toContain('sync-config.json (inventaire intégré)');
    // sync-config.json writeFileSync call: content is JSON with our machine entry
    const cfgWrite = mockWriteFileSync.mock.calls.find(
      c => typeof c[0] === 'string' && (c[0] as string).includes('sync-config.json'),
    );
    expect(cfgWrite).toBeDefined();
    const written = JSON.parse(cfgWrite![1] as string);
    expect(written.machines['cov-machine'].hostname).toBe('cov-host');
    // temp file cleaned up
    expect(mockUnlinkSync).toHaveBeenCalled();
  });

  test('JSON with UTF-8 BOM → BOM stripped before JSON.parse (L270-273)', async () => {
    inventoryFound({ bom: true });

    const result = await roosyncInit({});

    expect(result.success).toBe(true);
    // readFileSync returned a BOM-prefixed string; parse must not have thrown
    // (sync-config written with integrated inventory).
    expect(result.filesCreated).toContain('sync-config.json (inventaire intégré)');
  });

  test('sync-config already exists (no force) → merge existing config via readJSONFileSyncWithoutBOM', async () => {
    inventoryFound({ syncConfigExists: true });
    mockReadJSONWithoutBOM.mockReturnValue({ version: '2.0.0', machines: { 'other-machine': { hostname: 'x' } } });

    const result = await roosyncInit({});

    expect(result.success).toBe(true);
    expect(result.filesCreated).toContain('sync-config.json (inventaire intégré)');
    const cfgWrite = mockWriteFileSync.mock.calls.find(
      c => typeof c[0] === 'string' && (c[0] as string).includes('sync-config.json'),
    );
    const written = JSON.parse(cfgWrite![1] as string);
    // Existing machine preserved + new machine added
    expect(written.machines['other-machine']).toBeDefined();
    expect(written.machines['cov-machine']).toBeDefined();
  });

  test('exec succeeds but generated JSON file absent → warn branch, no sync-config write (L311-314)', async () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p === CONFIG.sharedPath) return true;
      if (p.includes('Get-MachineInventory.ps1')) return true; // script found
      return false; // inv file NOT present
    });
    mockExec.mockImplementation((_c: unknown, _o: unknown, cb: (e: unknown, r: { stdout: string; stderr: string }) => void) =>
      cb(null, { stdout: 'inv-missing.json', stderr: '' }),
    );

    const result = await roosyncInit({});

    expect(result.success).toBe(true);
    expect(result.filesCreated).not.toContain('sync-config.json (inventaire intégré)');
  });

  test('exec throws → caught, init continues without blocking (L315-320)', async () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p === CONFIG.sharedPath) return true;
      if (p.includes('Get-MachineInventory.ps1')) return true;
      return false;
    });
    mockExec.mockImplementation((_c: unknown, _o: unknown, cb: (e: Error | null) => void) =>
      cb(new Error('powershell exited 1')),
    );

    const result = await roosyncInit({});

    // Init must NOT fail — inventory is optional.
    expect(result.success).toBe(true);
    expect(result.filesCreated).not.toContain('sync-config.json (inventaire intégré)');
  });

  test('temp file unlink fails → warn-logged, init still succeeds (L307-310)', async () => {
    inventoryFound({ unlinkThrows: true });

    const result = await roosyncInit({});

    expect(result.success).toBe(true);
    // inventory was still integrated before the unlink failure
    expect(result.filesCreated).toContain('sync-config.json (inventaire intégré)');
  });
});

// ============================================================
// Dashboard / roadmap / rollback skip-create branches
// ============================================================
describe('skip-create branches', () => {
  test('dashboard exists + machine already registered → skip (L212-214)', async () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p === CONFIG.sharedPath) return true;
      if (typeof p === 'string' && p.includes('sync-dashboard.json')) return true;
      return false;
    });
    // existing dashboard already contains our machine
    mockReadJSONWithoutBOM.mockReturnValue({
      machines: { 'cov-machine': { status: 'online' } },
      lastUpdate: '2026-01-01',
    });

    const result = await roosyncInit({});

    expect(result.success).toBe(true);
    expect(result.filesSkipped).toContain('sync-dashboard.json (déjà existant)');
  });

  test('roadmap created when absent (L331-334)', async () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p === CONFIG.sharedPath) return true;
      // dashboard exists+registered, rollback exists, roadmap absent
      if (typeof p === 'string' && p.includes('sync-dashboard.json')) return true;
      if (typeof p === 'string' && p.includes('.rollback')) return true;
      return false;
    });
    mockReadJSONWithoutBOM.mockReturnValue({ machines: { 'cov-machine': { status: 'online' } } });

    const result = await roosyncInit({});

    expect(result.filesCreated).toContain('sync-roadmap.md');
    expect(result.filesSkipped).toContain('.rollback/ (déjà existant)');
  });

  test('roadmap skipped when already exists (L335-337)', async () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p === CONFIG.sharedPath) return true;
      if (typeof p === 'string' && p.includes('sync-dashboard.json')) return true;
      if (typeof p === 'string' && p.includes('sync-roadmap.md')) return true;
      return false;
    });
    mockReadJSONWithoutBOM.mockReturnValue({ machines: { 'cov-machine': { status: 'online' } } });

    const result = await roosyncInit({});

    expect(result.filesSkipped).toContain('sync-roadmap.md (déjà existant)');
  });
});

// ============================================================
// Error wrapping (L369-377)
// ============================================================
describe('error wrapping (L369-377)', () => {
  test('non-RooSyncServiceError thrown by getRooSyncService → wrapped as ROOSYNC_INIT_ERROR', async () => {
    mockGetRooSyncService.mockRejectedValue(new Error('disk full'));

    await expect(roosyncInit({})).rejects.toMatchObject({
      code: 'ROOSYNC_INIT_ERROR',
      message: expect.stringContaining('disk full'),
    });
  });

  test('RooSyncServiceError re-thrown as-is (L370-372)', async () => {
    const rse = new (await import('../../../services/lazy-roosync.js')).RooSyncServiceError(
      'config bad',
      'CONFIG_BAD',
    );
    mockGetRooSyncService.mockRejectedValue(rse);

    await expect(roosyncInit({})).rejects.toMatchObject({ code: 'CONFIG_BAD' });
  });
});
