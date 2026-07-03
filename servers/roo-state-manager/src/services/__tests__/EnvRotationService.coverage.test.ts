/**
 * #833 Sprint C3 — EnvRotationService branch coverage (po-2026 lane `src/services/**`)
 *
 * The base `EnvRotationService.test.ts` (16 tests, real AES-256-GCM crypto + fs
 * mocks) covers encrypt/decrypt round-trip, randomness, missing/short key,
 * wrong-key auth-tag failure, wire round-trip, publish (reject/missing/empty/
 * success/dryRun), and apply (reject/no-published/success/corruption/dryRun).
 * It leaves a cluster of genuine conditional branches cold:
 *
 * - `getEncryptionKey` **32-char boundary pass** (L89-92): base tests 48 chars
 *   (pass) and 8 chars (fail) — the exact 32-char minimum pass arm is cold.
 * - `validateService` **accepts each allowed service** (L153-161): base only
 *   asserts the reject arm; the pass arm for rsm/sk-agent/embedding/mcp-auth is
 *   exercised implicitly but never asserted directly.
 * - `publish` **description default in metadata** (L229): base never passes
 *   `description` nor asserts the `Env rotation for ${service}` default surfaces
 *   in the written metadata JSON.
 * - `publish` **win32 mode-0o600 warn** (L256-258): platform branch — fires only
 *   on win32. Asserted conditionally (skipIf non-win32 to stay green on ubuntu CI).
 * - `apply` **versions.length===0** (L308-315): envDir exists but contains no
 *   `.json` files — base always provides 1 version.
 * - `apply` **encPath missing** (L331-338): `.json` metadata exists but the
 *   `.enc` file is absent — base never hits this guard.
 * - `apply` **multi-version latest sort** (L318-327): base provides exactly 1
 *   version; the timestamp-sort loop selecting the newest of N is cold.
 * - `apply` **backup=false** (L374 guard): base always uses the default
 *   backup=true; the no-backup arm (copyFile never called) is cold.
 * - `apply` **backup when target does not exist** (L374 `&& existsSync`): base
 *   has the target existing; the target-absent arm (no backup even with
 *   backup=true) is cold.
 * - `apply` **targetDir mkdir** (L382-385): base has existsSync true everywhere;
 *   the mkdir-for-target-dir branch is cold.
 * - `apply` **win32 mode-warn** (L388-390): platform branch, conditional skip.
 * - `writeAuditLog` **envDir mkdir + catch** (L177-179, L184-187): the
 *   env-dir-doesn't-exist mkdir branch, and the non-blocking appendFile-failure
 *   catch (publish/apply still succeed).
 * - `deserializeEncrypted` **boundary** (L136): exactly 60 bytes (throws) and
 *   exactly 61 bytes (passes, 1-byte ciphertext) — base tests 9 bytes.
 * - `keysWritten` **comment exclusion** (L359): lines starting with `#` are
 *   excluded from the count — base asserts >0 but not the comment filter.
 *
 * A regression in any of these branches would pass the nominal suite silently.
 * This add-only file pins them, each assertion anchored on a source line of
 * `EnvRotationService.ts`. Uses the established fs-mock + real-crypto pattern.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  mockExistsSync,
  mockMkdirSync,
  mockReadFile,
  mockWriteFile,
  mockReaddir,
  mockAppendFile,
  mockCopyFile,
} = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
  mockMkdirSync: vi.fn(),
  mockReadFile: vi.fn(),
  mockWriteFile: vi.fn(),
  mockReaddir: vi.fn(),
  mockAppendFile: vi.fn(),
  mockCopyFile: vi.fn(),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: actual,
    existsSync: mockExistsSync,
    mkdirSync: mockMkdirSync,
    promises: {
      readFile: mockReadFile,
      writeFile: mockWriteFile,
      readdir: mockReaddir,
      appendFile: mockAppendFile,
      copyFile: mockCopyFile,
    },
  };
});

vi.mock('../../utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

import { EnvRotationService, ALLOWED_SERVICES } from '../EnvRotationService.js';

// Source constants (EnvRotationService.ts L17-19) — module-private `const`, not re-exported.
// Mirrored here for wire-format boundary math (deserializeEncrypted L136).
const SALT_LENGTH = 32;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

const ENV_KEY = 'x'.repeat(48);

describe('EnvRotationService — branch coverage (#833 C3, source-grounded)', () => {
  let service: EnvRotationService;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ROOSYNC_ENV_KEY = ENV_KEY;
    mockExistsSync.mockReturnValue(false);
    mockMkdirSync.mockReturnValue(undefined);
    mockReadFile.mockRejectedValue(new Error('ENOENT'));
    mockWriteFile.mockResolvedValue(undefined);
    mockReaddir.mockResolvedValue([]);
    mockAppendFile.mockResolvedValue(undefined);
    mockCopyFile.mockResolvedValue(undefined);
    service = new EnvRotationService();
  });

  afterEach(() => {
    delete process.env.ROOSYNC_ENV_KEY;
  });

  // ============================================================
  // getEncryptionKey — 32-char boundary pass (L89-92)
  // ============================================================
  describe('getEncryptionKey — 32-char minimum boundary (L89-92)', () => {
    test('a 32-char key passes (encrypt does not throw) — boundary arm L89', () => {
      process.env.ROOSYNC_ENV_KEY = 'y'.repeat(32); // exactly the minimum
      expect(() => service.encrypt(Buffer.from('KEY=val\n'))).not.toThrow();
    });

    test('a 31-char key is rejected (too short)', () => {
      process.env.ROOSYNC_ENV_KEY = 'z'.repeat(31);
      expect(() => service.encrypt(Buffer.from('KEY=val\n'))).toThrow(/too short/i);
    });
  });

  // ============================================================
  // validateService — each allowed service accepted (L153-161)
  // ============================================================
  describe('validateService — allowlist pass arm (L153-161)', () => {
    test.each([...ALLOWED_SERVICES])('service "%s" is accepted (no throw, not in message)', async (svc) => {
      mockExistsSync.mockReturnValue(false); // envPath missing → early return, but past validateService
      const res = await service.publish({
        service: svc, envPath: '/x/.env', sharedStatePath: '/s', version: '1', machineId: 'm1',
      });
      // Reached past validateService (L194) → returns the not-found error, NOT the allowlist rejection.
      expect(res.status).toBe('error');
      expect(res.message).not.toMatch(/allowlist/);
    });

    test('reject message lists all allowed services (L158)', async () => {
      await expect(
        service.publish({ service: 'bogus', envPath: '/x/.env', sharedStatePath: '/s', version: '1', machineId: 'm1' })
      ).rejects.toThrow(/rsm, sk-agent, embedding, mcp-auth/);
    });
  });

  // ============================================================
  // publish — description default in metadata (L229)
  // ============================================================
  describe('publish — description default in metadata (L229)', () => {
    test('omitting description writes the "Env rotation for ${service}" default', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFile.mockResolvedValue('API_KEY=val\n');

      await service.publish({
        service: 'rsm', envPath: '/x/.env', sharedStatePath: '/s', version: '1', machineId: 'm1',
      });

      // metadata .json is the second writeFile call (after .enc). Inspect its content.
      const jsonCall = mockWriteFile.mock.calls.find(
        (c: any[]) => typeof c[0] === 'string' && c[0].endsWith('.json')
      );
      expect(jsonCall).toBeDefined();
      const meta = JSON.parse(jsonCall![1] as string);
      expect(meta.description).toBe('Env rotation for rsm');
    });

    test('a provided description is preserved verbatim in metadata', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFile.mockResolvedValue('API_KEY=val\n');

      await service.publish({
        service: 'rsm', envPath: '/x/.env', sharedStatePath: '/s', version: '1', machineId: 'm1',
        description: 'Custom rotation note',
      });

      const jsonCall = mockWriteFile.mock.calls.find(
        (c: any[]) => typeof c[0] === 'string' && c[0].endsWith('.json')
      );
      const meta = JSON.parse(jsonCall![1] as string);
      expect(meta.description).toBe('Custom rotation note');
    });
  });

  // ============================================================
  // publish — win32 mode-0o600 warn (L256-258)
  // ============================================================
  describe('publish — win32 mode-warn (L256-258)', () => {
    test.skipIf(process.platform !== 'win32')(
      'on win32, publish logs the mode:0o600-ignored warning (L256-258)', async () => {
        // The logger is mocked fresh per createLogger; capture via the factory spy.
        const { createLogger } = await import('../../utils/logger.js');
        const inst = (createLogger as unknown as vi.Mock).mock.results.at(-1)?.value;
        mockExistsSync.mockReturnValue(true);
        mockReadFile.mockResolvedValue('API_KEY=val\n');

        await service.publish({
          service: 'rsm', envPath: '/x/.env', sharedStatePath: '/s', version: '1', machineId: 'm1',
        });

        // Source L257: logger.warn(`Windows: mode:0o600 ignored for ${encryptedPath}...`) — single string arg.
        expect(inst.warn).toHaveBeenCalledWith(expect.stringMatching(/mode:0o600 ignored/));
      }
    );
  });

  // ============================================================
  // apply — versions.length===0 (L308-315)
  // ============================================================
  describe('apply — envDir exists but no .json versions (L308-315)', () => {
    test('dir exists but contains no .json files → "No versions found"', async () => {
      mockExistsSync.mockReturnValue(true); // envDir exists
      mockReaddir.mockResolvedValue(['1.enc', 'readme.txt'] as never); // no .json
      const res = await service.apply({ service: 'rsm', targetEnvPath: '/x/.env', sharedStatePath: '/s' });
      expect(res.status).toBe('error');
      expect(res.message).toMatch(/No versions found/);
    });
  });

  // ============================================================
  // apply — encPath missing (L331-338)
  // ============================================================
  describe('apply — encrypted file missing (L331-338)', () => {
    test('metadata .json exists but the .enc file is absent → "Encrypted file missing"', async () => {
      mockExistsSync.mockImplementation((p: any) => {
        // envDir exists, .json metadata path exists, but .enc path does NOT.
        const ps = String(p);
        if (ps.endsWith('.enc')) return false;
        return true;
      });
      mockReaddir.mockResolvedValue(['1.json'] as never);
      mockReadFile.mockResolvedValue(JSON.stringify({
        service: 'rsm', version: '1', timestamp: '2026-01-01T00:00:00.000Z', size: 10,
      }));

      const res = await service.apply({ service: 'rsm', targetEnvPath: '/x/.env', sharedStatePath: '/s' });
      expect(res.status).toBe('error');
      expect(res.message).toMatch(/Encrypted file missing/);
    });
  });

  // ============================================================
  // apply — multi-version latest sort (L318-327)
  // ============================================================
  describe('apply — multi-version latest sort (L318-327)', () => {
    test('picks the newest timestamp among several versions', async () => {
      const plaintext = Buffer.from('API_KEY=secret\n', 'utf-8');
      const enc = service.encrypt(plaintext);
      const wire = service.serializeEncrypted(enc);

      mockExistsSync.mockReturnValue(true);
      // Two versions: v1 older, v2 newer. readdir returns both .json.
      mockReaddir.mockResolvedValue(['1.json', '2.json'] as never);
      mockReadFile.mockImplementation(async (p: { toString: () => string }) => {
        const ps = p.toString();
        if (ps.endsWith('1.json')) return JSON.stringify({ version: '1', timestamp: '2026-01-01T00:00:00.000Z', size: 10 });
        if (ps.endsWith('2.json')) return JSON.stringify({ version: '2', timestamp: '2026-06-01T00:00:00.000Z', size: 10 });
        if (ps.endsWith('2.enc')) return wire; // only the newest .enc is read
        if (ps.endsWith('1.enc')) return wire;
        throw new Error('ENOENT');
      });

      const res = await service.apply({ service: 'rsm', targetEnvPath: '/x/.env', sharedStatePath: '/s' });
      expect(res.status).toBe('success');
      // The success message names the latest version (v2), proving the sort picked the newest.
      expect(res.message).toMatch(/v2/);
      // readFile for the v2 .enc was the one consumed (v2.enc read after metadata sort).
      const encReads = mockReadFile.mock.calls.filter((c: any[]) => String(c[0]).endsWith('.enc')).map((c) => String(c[0]));
      expect(encReads.some((p) => p.endsWith('2.enc'))).toBe(true);
    });
  });

  // ============================================================
  // apply — backup=false (L374 guard)
  // ============================================================
  describe('apply — backup=false (L374 guard)', () => {
    test('backup=false never calls copyFile even when target exists', async () => {
      const plaintext = Buffer.from('API_KEY=secret\n', 'utf-8');
      const enc = service.encrypt(plaintext);
      const wire = service.serializeEncrypted(enc);
      mockExistsSync.mockReturnValue(true);
      mockReaddir.mockResolvedValue(['1.json'] as never);
      mockReadFile.mockImplementation(async (p: { toString: () => string }) => {
        const ps = p.toString();
        if (ps.endsWith('1.json')) return JSON.stringify({ version: '1', timestamp: '2026-01-01T00:00:00.000Z', size: 10 });
        if (ps.endsWith('1.enc')) return wire;
        throw new Error('ENOENT');
      });

      const res = await service.apply({
        service: 'rsm', targetEnvPath: '/x/.env', sharedStatePath: '/s', backup: false,
      });
      expect(res.status).toBe('success');
      expect(mockCopyFile).not.toHaveBeenCalled();
      expect(res.backupPath).toBeUndefined();
    });

    test('backup=true but target absent → no backup created (L374 && existsSync guard)', async () => {
      const plaintext = Buffer.from('API_KEY=secret\n', 'utf-8');
      const wire = service.serializeEncrypted(service.encrypt(plaintext));
      // targetEnvPath does NOT exist → backup arm skipped even though backup=true (default).
      mockExistsSync.mockImplementation((p: any) => !String(p).endsWith('/.env'));
      mockReaddir.mockResolvedValue(['1.json'] as never);
      mockReadFile.mockImplementation(async (p: { toString: () => string }) => {
        const ps = p.toString();
        if (ps.endsWith('1.json')) return JSON.stringify({ version: '1', timestamp: '2026-01-01T00:00:00.000Z', size: 10 });
        if (ps.endsWith('1.enc')) return wire;
        throw new Error('ENOENT');
      });

      const res = await service.apply({ service: 'rsm', targetEnvPath: '/x/.env', sharedStatePath: '/s' });
      expect(res.status).toBe('success');
      expect(mockCopyFile).not.toHaveBeenCalled();
      expect(res.backupPath).toBeUndefined();
    });
  });

  // ============================================================
  // apply — targetDir mkdir (L382-385)
  // ============================================================
  describe('apply — target directory created if absent (L382-385)', () => {
    test('mkdirSync is called for the target dir when it does not exist', async () => {
      const plaintext = Buffer.from('API_KEY=secret\n', 'utf-8');
      const wire = service.serializeEncrypted(service.encrypt(plaintext));
      // targetEnvPath '/target-absent/.env' → dirname '/target-absent' must NOT exist
      // (to fire the mkdir branch), while envDir + encPath still exist.
      mockExistsSync.mockImplementation((p: any) => !/target-absent$/.test(String(p)));
      mockReaddir.mockResolvedValue(['1.json'] as never);
      mockReadFile.mockImplementation(async (p: { toString: () => string }) => {
        const ps = p.toString();
        if (ps.endsWith('1.json')) return JSON.stringify({ version: '1', timestamp: '2026-01-01T00:00:00.000Z', size: 10 });
        if (ps.endsWith('1.enc')) return wire;
        throw new Error('ENOENT');
      });

      await service.apply({ service: 'rsm', targetEnvPath: '/target-absent/.env', sharedStatePath: '/s', backup: false });
      // dirname('/target-absent/.env') = '/target-absent' → mkdirSync called for it (L384).
      expect(mockMkdirSync).toHaveBeenCalledWith('/target-absent', { recursive: true });
    });
  });

  // ============================================================
  // apply — win32 mode-warn (L388-390)
  // ============================================================
  describe('apply — win32 mode-warn (L388-390)', () => {
    test.skipIf(process.platform !== 'win32')(
      'on win32, apply logs the mode:0o600-ignored warning for the target (L388-390)', async () => {
        const { createLogger } = await import('../../utils/logger.js');
        const inst = (createLogger as unknown as vi.Mock).mock.results.at(-1)?.value;
        const plaintext = Buffer.from('API_KEY=secret\n', 'utf-8');
        const wire = service.serializeEncrypted(service.encrypt(plaintext));
        mockExistsSync.mockReturnValue(true);
        mockReaddir.mockResolvedValue(['1.json'] as never);
        mockReadFile.mockImplementation(async (p: { toString: () => string }) => {
          const ps = p.toString();
          if (ps.endsWith('1.json')) return JSON.stringify({ version: '1', timestamp: '2026-01-01T00:00:00.000Z', size: 10 });
          if (ps.endsWith('1.enc')) return wire;
          throw new Error('ENOENT');
        });

        await service.apply({ service: 'rsm', targetEnvPath: '/x/.env', sharedStatePath: '/s', backup: false });
        // Source L389: single string arg.
        expect(inst.warn).toHaveBeenCalledWith(expect.stringMatching(/mode:0o600 ignored/));
      }
    );
  });

  // ============================================================
  // writeAuditLog — envDir mkdir + non-blocking catch (L177-179, L184-187)
  // ============================================================
  describe('writeAuditLog — envDir mkdir + non-blocking catch (L177-179, L184-187)', () => {
    test('audit envDir does not exist → mkdirSync creates it (L177-179)', async () => {
      // Terminal-segment 'env' matcher: matches join('/s','env') but NOT envPath '/x/.env'
      // (the char before 'env' there is '.', not '/' or '\') → envPath stays "existing",
      // publish proceeds past L197, and writeAuditLog's envDir is the only "absent" path.
      mockExistsSync.mockImplementation((p: any) => !/[\\/]env$/.test(String(p)));
      mockReadFile.mockResolvedValue('API_KEY=val\n');

      await service.publish({
        service: 'rsm', envPath: '/x/.env', sharedStatePath: '/s', version: '1', machineId: 'm1',
      });
      // writeAuditLog builds join(sharedStatePath,'env') and mkdirs it when absent (L176-179).
      // Match any separator — path.join normalizes per-platform, so don't pin the exact string.
      expect(mockMkdirSync).toHaveBeenCalledWith(
        expect.stringMatching(/[\\/]env$/),
        { recursive: true }
      );
    });

    test('appendFile failure is non-blocking — publish still succeeds (L184-187 catch)', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFile.mockResolvedValue('API_KEY=val\n');
      mockAppendFile.mockRejectedValue(new Error('GDrive full')); // audit write fails

      const res = await service.publish({
        service: 'rsm', envPath: '/x/.env', sharedStatePath: '/s', version: '1', machineId: 'm1',
      });
      // The catch swallows the audit failure → publish still returns success.
      expect(res.status).toBe('success');
      expect(mockAppendFile).toHaveBeenCalled(); // audit was attempted
    });
  });

  // ============================================================
  // deserializeEncrypted — boundary (L136)
  // ============================================================
  describe('deserializeEncrypted — length boundary (L136)', () => {
    const HEADER = SALT_LENGTH + IV_LENGTH + TAG_LENGTH; // 32+12+16 = 60
    test(`exactly ${HEADER} bytes (header only, no ciphertext byte) → throws "too short"`, () => {
      // L136: `< HEADER + 1` → at exactly HEADER, the `< 61` check throws.
      expect(() => service.deserializeEncrypted(Buffer.alloc(HEADER))).toThrow(/too short/i);
    });
    test(`exactly ${HEADER + 1} bytes → passes (1-byte ciphertext)`, () => {
      const wire = Buffer.alloc(HEADER + 1, 0x41);
      const back = service.deserializeEncrypted(wire);
      expect(back.salt.length).toBe(SALT_LENGTH);
      expect(back.iv.length).toBe(IV_LENGTH);
      expect(back.tag.length).toBe(TAG_LENGTH);
      expect(back.ciphertext.length).toBe(1);
    });
  });

  // ============================================================
  // keysWritten — comment exclusion (L359)
  // ============================================================
  describe('apply keysWritten — comment lines excluded (L359)', () => {
    test('comment lines (#) and blank lines are not counted toward keysWritten', async () => {
      const content = 'API_KEY=val\n# this is a comment\nOTHER=2\n\nTHIRD=3\n';
      const plaintext = Buffer.from(content, 'utf-8');
      const wire = service.serializeEncrypted(service.encrypt(plaintext));
      mockExistsSync.mockReturnValue(true);
      mockReaddir.mockResolvedValue(['1.json'] as never);
      mockReadFile.mockImplementation(async (p: { toString: () => string }) => {
        const ps = p.toString();
        if (ps.endsWith('1.json')) return JSON.stringify({ version: '1', timestamp: '2026-01-01T00:00:00.000Z', size: plaintext.length });
        if (ps.endsWith('1.enc')) return wire;
        throw new Error('ENOENT');
      });

      const res = await service.apply({ service: 'rsm', targetEnvPath: '/x/.env', sharedStatePath: '/s', backup: false });
      expect(res.status).toBe('success');
      // L359: filter includes '=' AND not starting with '#'. The blank line has no '='.
      // Valid keys: API_KEY, OTHER, THIRD = 3 (comment + blank excluded).
      expect(res.keysWritten).toBe(3);
    });
  });
});

// ─────────────────── local helpers ───────────────────

/** path.join that works regardless of platform separator for mock-path matching. */
function joinPath(...segs: string[]): string {
  return segs.join(process.platform === 'win32' ? '\\' : '/');
}
