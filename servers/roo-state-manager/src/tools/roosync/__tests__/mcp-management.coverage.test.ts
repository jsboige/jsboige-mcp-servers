/**
 * Coverage tests for mcp-management.ts — branches non couvertes par le fresh
 * coverage measure (84.78% → gaps ciblés, anti-busy-work #2083).
 *
 * Fresh measure identifiait les gaps suivants (tous NON couverts par les 3 test
 * files existants, ou skip à cause de l'état module-level `lastReadTimestamp`) :
 *
 *  - WRITE_NOT_AUTHORIZED pour 5 subActions write (L227-231, 278-282, 317-321,
 *    366-370, 407-411). Le test étendu L149 "writing without prior read" est
 *    { skip: true } : `lastReadTimestamp` est module-level et fuit entre tests,
 *    personne n'avait résolu l'isolation.
 *  - checkWriteAuthorization null (L95-99) + expired (L106-111).
 *  - getAuthorizationStatus null (L124-127) + expired (L133-136).
 *  - runNpmBuild retry EBUSY (L604-606) + throw BUILD_FAILED (L608-611).
 *  - handleRebuildAction cwd detection : options.cwd (L505) + args[0] path (L507).
 *  - cleanupEmptyAutoApprove : empty-array delete (L644-645).
 *
 * Isolation : `vi.resetModules()` + dynamic import pour réinitialiser
 * `lastReadTimestamp` (module-level) avant chaque test. `vi.spyOn(Date, 'now')`
 * pour simuler l'expiry (>5min) sans fake timers (évite les interactions
 * délicates avec exec callbacks).
 *
 * @module tools/roosync/__tests__/mcp-management.coverage
 * Issue: Vein D Lane R (po-2023) coverage dispatch
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  mockReadFile,
  mockWriteFile,
  mockAccess,
  mockUtimes,
  mockExec,
} = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
  mockWriteFile: vi.fn(),
  mockAccess: vi.fn(),
  mockUtimes: vi.fn(),
  mockExec: vi.fn(),
}));

vi.mock('fs/promises', () => ({
  readFile: mockReadFile,
  writeFile: mockWriteFile,
  access: mockAccess,
  utimes: mockUtimes,
}));

vi.mock('child_process', () => ({
  exec: mockExec,
}));

vi.mock('os', () => ({
  default: { homedir: () => '/home/test', tmpdir: () => '/tmp' },
  homedir: () => '/home/test',
  tmpdir: () => '/tmp',
}));

vi.mock('../../../services/roosync/HeartbeatService.js', () => ({
  HeartbeatServiceError: class extends Error {
    code: string;
    constructor(msg: string, code: string) {
      super(msg);
      this.code = code;
      this.name = 'HeartbeatServiceError';
    }
  },
}));

// NOTE: roosyncMcpManagement is imported dynamically after vi.resetModules() in
// beforeEach so that the module-level `lastReadTimestamp` is fresh (null) for
// every test. A static top-level import would share state across tests.
let roosyncMcpManagement: typeof import('../mcp-management.js')['roosyncMcpManagement'];
let originalAppData: string | undefined;

const TEST_SETTINGS = {
  mcpServers: {
    'test-server': {
      command: 'node',
      args: ['server.js'],
      cwd: '/tmp/test',
      disabled: false,
    },
  },
};

beforeEach(async () => {
  vi.clearAllMocks();
  originalAppData = process.env.APPDATA;
  process.env.APPDATA = '/home/test';
  process.env.VITEST = 'true';
  mockReadFile.mockResolvedValue(JSON.stringify(TEST_SETTINGS));
  mockWriteFile.mockResolvedValue(undefined);
  mockAccess.mockResolvedValue(undefined);
  mockUtimes.mockResolvedValue(undefined);
  mockExec.mockImplementation((_cmd: string, _opts: unknown, cb: (e: unknown, o: string, e2: string) => void) =>
    cb(null, 'build ok', ''),
  );
  // Reset module-level `lastReadTimestamp` (the isolation problem that forced
  // the existing suite to skip WRITE_NOT_AUTHORIZED tests).
  vi.resetModules();
  const mod = await import('../mcp-management.js');
  roosyncMcpManagement = mod.roosyncMcpManagement;
});

afterEach(() => {
  if (originalAppData === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = originalAppData;
  vi.restoreAllMocks();
});

// ============================================================
// WRITE_NOT_AUTHORIZED — fresh module, no prior read
// Covers: L95-99 (checkWriteAuthorization null), L124-127 (getAuthorizationStatus
// null), L227-231 (write), L278-282 (update_server), L317-321 (update_server_field),
// L366-370 (toggle_server), L407-411 (sync_always_allow).
// ============================================================
describe('WRITE_NOT_AUTHORIZED — fresh module, no prior read', () => {
  test('write without prior read → WRITE_NOT_AUTHORIZED', async () => {
    await expect(
      roosyncMcpManagement({
        action: 'manage',
        subAction: 'write',
        settings: { mcpServers: { s: { command: 'node' } } },
        backup: false,
      }),
    ).rejects.toMatchObject({ code: 'WRITE_NOT_AUTHORIZED' });
  });

  test('update_server without prior read → WRITE_NOT_AUTHORIZED', async () => {
    await expect(
      roosyncMcpManagement({
        action: 'manage',
        subAction: 'update_server',
        server_name: 'test-server',
        server_config: { command: 'node' },
        backup: false,
      }),
    ).rejects.toMatchObject({ code: 'WRITE_NOT_AUTHORIZED' });
  });

  test('update_server_field without prior read → WRITE_NOT_AUTHORIZED', async () => {
    await expect(
      roosyncMcpManagement({
        action: 'manage',
        subAction: 'update_server_field',
        server_name: 'test-server',
        server_config: { disabled: true },
        backup: false,
      }),
    ).rejects.toMatchObject({ code: 'WRITE_NOT_AUTHORIZED' });
  });

  test('toggle_server without prior read → WRITE_NOT_AUTHORIZED', async () => {
    await expect(
      roosyncMcpManagement({
        action: 'manage',
        subAction: 'toggle_server',
        server_name: 'test-server',
        backup: false,
      }),
    ).rejects.toMatchObject({ code: 'WRITE_NOT_AUTHORIZED' });
  });

  test('sync_always_allow without prior read → WRITE_NOT_AUTHORIZED', async () => {
    await expect(
      roosyncMcpManagement({
        action: 'manage',
        subAction: 'sync_always_allow',
        server_name: 'test-server',
        tools: ['tool_a'],
        backup: false,
      }),
    ).rejects.toMatchObject({ code: 'WRITE_NOT_AUTHORIZED' });
  });
});

// ============================================================
// Authorization expiry — read then advance Date.now() >5min
// Covers: L106-111 (checkWriteAuthorization expired), L133-136 (getAuthorizationStatus
// expired).
// ============================================================
describe('authorization expiry — read then >5min', () => {
  test('write after read but >5min elapsed → WRITE_NOT_AUTHORIZED (expired message)', async () => {
    const t0 = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValue(t0);

    // read at t0 → recordSuccessfulRead sets lastReadTimestamp = t0
    await roosyncMcpManagement({ action: 'manage', subAction: 'read' });

    // advance beyond WRITE_AUTHORIZATION_TIMEOUT (5 min)
    nowSpy.mockReturnValue(t0 + 6 * 60 * 1000);

    await expect(
      roosyncMcpManagement({
        action: 'manage',
        subAction: 'write',
        settings: { mcpServers: { s: { command: 'node' } } },
        backup: false,
      }),
    ).rejects.toMatchObject({ code: 'WRITE_NOT_AUTHORIZED' });
  });
});

// ============================================================
// runNpmBuild — EBUSY retry logic
// Covers: L604-606 (EBUSY backoff+continue), L608-611 (BUILD_FAILED throw).
// Note: L614-615 (post-loop throw) is defensive unreachable code (every loop
// iteration either returns or throws) — not force-covered (anti-busy-work).
// ============================================================
describe('runNpmBuild — EBUSY retry logic', () => {
  test('EBUSY on first attempt then success → retried once and built', async () => {
    vi.useFakeTimers();
    let call = 0;
    mockExec.mockImplementation((_c: string, _o: unknown, cb: (e: unknown, o: string, e2: string) => void) => {
      call++;
      if (call === 1) {
        const err: Error & { code?: string } = new Error('EBUSY: resource busy');
        err.code = 'EBUSY';
        cb(err, '', '');
      } else {
        cb(null, 'build ok', '');
      }
    });

    const pending = roosyncMcpManagement({ action: 'rebuild', mcp_name: 'test-server' });
    // Resolve the 2000ms backoff delay (attempt 1 → attempt 2).
    await vi.advanceTimersByTimeAsync(2500);
    const result = await pending;

    expect(result.success).toBe(true);
    expect(result.action).toBe('rebuild');
    // runNpmBuild retried once (EBUSY → backoff → success). Count ONLY the
    // `npm run build` exec calls — handleRebuildAction also calls touchFile
    // (powershell.exe) which shares mockExec, so total exec calls = 3 here.
    const npmBuildCalls = mockExec.mock.calls.filter(c => String(c[0]).includes('npm run build')).length;
    expect(npmBuildCalls).toBe(2);
    vi.useRealTimers();
  });

  test('non-EBUSY build error → BUILD_FAILED immediately (no retry)', async () => {
    let call = 0;
    mockExec.mockImplementation((_c: string, _o: unknown, cb: (e: unknown, o: string, e2: string) => void) => {
      call++;
      cb(new Error('TS2304: Cannot find name'), '', '');
    });

    await expect(roosyncMcpManagement({ action: 'rebuild', mcp_name: 'test-server' })).rejects.toMatchObject({
      code: 'BUILD_FAILED',
    });
    expect(call).toBe(1); // non-retryable → no backoff, no second attempt
  });
});

// ============================================================
// handleRebuildAction — cwd path detection fallbacks
// Covers: L505 (options.cwd), L507 (args[0] path → dirname(dirname)).
// ============================================================
describe('handleRebuildAction — cwd path detection fallbacks', () => {
  test('uses options.cwd when top-level cwd is absent', async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        mcpServers: { 'opt-server': { command: 'node', args: ['s.js'], options: { cwd: '/opt/mcp' } } },
      }),
    );

    const result = await roosyncMcpManagement({ action: 'rebuild', mcp_name: 'opt-server' });

    expect(result.success).toBe(true);
    expect(result.details.mcpPath).toBe('/opt/mcp');
  });

  test('uses args[0] path (dirname×2) when no cwd nor options.cwd', async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        mcpServers: { 'args-server': { command: 'node', args: ['/srv/mcp/build/index.js'] } },
      }),
    );

    const result = await roosyncMcpManagement({ action: 'rebuild', mcp_name: 'args-server' });

    expect(result.success).toBe(true);
    // path.dirname(path.dirname('/srv/mcp/build/index.js')) = '/srv/mcp'
    expect(result.details.mcpPath).toBe('/srv/mcp');
  });
});

// ============================================================
// cleanupEmptyAutoApprove — empty-array delete (#552)
// Covers: L641-645 (autoApprove: [] → delete before write).
// ============================================================
describe('cleanupEmptyAutoApprove — empty autoApprove arrays removed on write (#552)', () => {
  test('write strips empty autoApprove arrays from server configs', async () => {
    // read first to obtain write authorization
    mockReadFile.mockResolvedValue(JSON.stringify({ mcpServers: { 's': { command: 'node' } } }));
    await roosyncMcpManagement({ action: 'manage', subAction: 'read' });

    const settingsWithEmptyAutoApprove = {
      mcpServers: {
        's': { command: 'node', args: ['x'], autoApprove: [] as string[] },
      },
    };
    await roosyncMcpManagement({
      action: 'manage',
      subAction: 'write',
      settings: settingsWithEmptyAutoApprove,
      backup: false,
    });

    expect(mockWriteFile).toHaveBeenCalledTimes(1);
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
    expect(written.mcpServers.s.autoApprove).toBeUndefined();
  });
});
