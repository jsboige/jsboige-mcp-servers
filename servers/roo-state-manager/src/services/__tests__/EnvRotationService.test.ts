/**
 * Tests for EnvRotationService.ts
 * Issue #2642 — test coverage audit gap (0 tests, security-critical live prod code)
 * Issue #2410 — VibeSync Epic #2406 Phase 2 (env secret rotation)
 *
 * Uses REAL crypto (scrypt + AES-256-GCM) — mocks only fs + logger.
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

const ENV_KEY = 'x'.repeat(48); // 48 chars — above the 32-char minimum

describe('EnvRotationService', () => {
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
  // ALLOWED_SERVICES (security allowlist)
  // ============================================================
  describe('ALLOWED_SERVICES', () => {
    test('contains exactly the 4 permitted services', () => {
      expect([...ALLOWED_SERVICES]).toEqual(['rsm', 'sk-agent', 'embedding', 'mcp-auth']);
    });
  });

  // ============================================================
  // encrypt / decrypt (real AES-256-GCM)
  // ============================================================
  describe('encrypt / decrypt', () => {
    test('decrypt(encrypt(plaintext)) round-trips to the original', () => {
      const plaintext = Buffer.from('API_KEY=secret123\nOTHER=value\n', 'utf-8');
      const enc = service.encrypt(plaintext);
      const dec = service.decrypt(enc.ciphertext, enc.iv, enc.tag, enc.salt);
      expect(dec.equals(plaintext)).toBe(true);
    });

    test('encrypt produces different ciphertext + iv + salt for the same plaintext (randomness)', () => {
      const plaintext = Buffer.from('KEY=val\n', 'utf-8');
      const a = service.encrypt(plaintext);
      const b = service.encrypt(plaintext);
      expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
      expect(a.iv.equals(b.iv)).toBe(false);
      expect(a.salt.equals(b.salt)).toBe(false);
    });

    test('encrypt throws if ROOSYNC_ENV_KEY is missing', () => {
      delete process.env.ROOSYNC_ENV_KEY;
      expect(() => service.encrypt(Buffer.from('KEY=val\n'))).toThrow(/ROOSYNC_ENV_KEY/);
    });

    test('encrypt throws if ROOSYNC_ENV_KEY is shorter than 32 chars', () => {
      process.env.ROOSYNC_ENV_KEY = 'shortkey'; // 8 chars
      expect(() => service.encrypt(Buffer.from('KEY=val\n'))).toThrow(/too short/i);
    });

    test('decrypt with a wrong key fails (GCM auth tag verification)', () => {
      const enc = service.encrypt(Buffer.from('KEY=val\n', 'utf-8'));
      process.env.ROOSYNC_ENV_KEY = 'y'.repeat(48); // different key
      expect(() => service.decrypt(enc.ciphertext, enc.iv, enc.tag, enc.salt)).toThrow();
    });
  });

  // ============================================================
  // serializeEncrypted / deserializeEncrypted (wire format)
  // ============================================================
  describe('serializeEncrypted / deserializeEncrypted', () => {
    test('round-trip preserves salt, iv, tag, ciphertext', () => {
      const enc = service.encrypt(Buffer.from('KEY=val\n', 'utf-8'));
      const wire = service.serializeEncrypted(enc);
      const back = service.deserializeEncrypted(wire);
      expect(back.salt.equals(enc.salt)).toBe(true);
      expect(back.iv.equals(enc.iv)).toBe(true);
      expect(back.tag.equals(enc.tag)).toBe(true);
      expect(back.ciphertext.equals(enc.ciphertext)).toBe(true);
    });

    test('deserialize throws on input shorter than the header', () => {
      expect(() => service.deserializeEncrypted(Buffer.from('too-short'))).toThrow(/too short/i);
    });
  });

  // ============================================================
  // publish
  // ============================================================
  describe('publish', () => {
    test('rejects a service not in the allowlist', async () => {
      await expect(
        service.publish({
          service: 'evil-service',
          envPath: '/x/.env',
          sharedStatePath: '/s',
          version: '1',
          machineId: 'm1',
        })
      ).rejects.toThrow(/not in the env rotation allowlist/);
    });

    test('returns error when the source .env does not exist', async () => {
      mockExistsSync.mockReturnValue(false); // envPath missing
      const res = await service.publish({
        service: 'rsm',
        envPath: '/x/.env',
        sharedStatePath: '/s',
        version: '1',
        machineId: 'm1',
      });
      expect(res.status).toBe('error');
      expect(res.message).toMatch(/not found/);
    });

    test('returns warning when the source .env is empty', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFile.mockResolvedValue('   \n  '); // whitespace-only
      const res = await service.publish({
        service: 'rsm',
        envPath: '/x/.env',
        sharedStatePath: '/s',
        version: '1',
        machineId: 'm1',
      });
      expect(res.status).toBe('warning');
      expect(res.message).toMatch(/empty/);
    });

    test('success: encrypts and writes .enc + metadata .json + audit log', async () => {
      mockExistsSync.mockReturnValue(true); // envPath exists
      const content = 'API_KEY=secret\nOTHER=val\n';
      mockReadFile.mockResolvedValue(content);

      const res = await service.publish({
        service: 'rsm',
        envPath: '/x/.env',
        sharedStatePath: '/s',
        version: '1',
        machineId: 'm1',
      });

      expect(res.status).toBe('success');
      expect(res.size).toBe(Buffer.byteLength(content, 'utf-8'));
      expect(mockWriteFile).toHaveBeenCalled(); // .enc + metadata .json
      expect(mockAppendFile).toHaveBeenCalled(); // audit log
    });

    test('dryRun: reports success without writing the encrypted artifact', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFile.mockResolvedValue('API_KEY=secret\n');

      const res = await service.publish({
        service: 'rsm',
        envPath: '/x/.env',
        sharedStatePath: '/s',
        version: '1',
        machineId: 'm1',
        dryRun: true,
      });

      expect(res.status).toBe('success');
      expect(res.message).toMatch(/DRY RUN/);
      expect(mockWriteFile).not.toHaveBeenCalled();
      expect(mockAppendFile).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // apply
  // ============================================================
  describe('apply', () => {
    test('rejects a service not in the allowlist', async () => {
      await expect(
        service.apply({ service: 'evil', targetEnvPath: '/x/.env', sharedStatePath: '/s' })
      ).rejects.toThrow(/not in the env rotation allowlist/);
    });

    test('returns error when no env has been published for the service', async () => {
      mockExistsSync.mockReturnValue(false); // envDir missing
      const res = await service.apply({
        service: 'rsm',
        targetEnvPath: '/x/.env',
        sharedStatePath: '/s',
      });
      expect(res.status).toBe('error');
      expect(res.message).toMatch(/No env published/);
    });

    test('success: decrypts latest version, backs up existing target, writes new .env', async () => {
      const plaintext = Buffer.from('API_KEY=secret\nOTHER=val\n', 'utf-8');
      const enc = service.encrypt(plaintext);
      const wire = service.serializeEncrypted(enc);
      const metadata = {
        service: 'rsm',
        version: '1',
        timestamp: '2026-01-01T00:00:00.000Z',
        size: plaintext.length,
        algorithm: 'aes-256-gcm',
      };

      mockExistsSync.mockReturnValue(true); // envDir + encPath + existing target (backup)
      mockReaddir.mockResolvedValue(['1.json'] as never);
      mockReadFile.mockImplementation(async (p: { toString: () => string }) => {
        const ps = p.toString();
        if (ps.endsWith('1.json')) return JSON.stringify(metadata);
        if (ps.endsWith('1.enc')) return wire;
        throw new Error('ENOENT');
      });

      const res = await service.apply({
        service: 'rsm',
        targetEnvPath: '/x/.env',
        sharedStatePath: '/s',
      });

      expect(res.status).toBe('success');
      expect(res.keysWritten).toBeGreaterThan(0);
      expect(mockCopyFile).toHaveBeenCalled(); // backup of existing target
      expect(mockWriteFile).toHaveBeenCalled(); // new .env write
    });

    test('error when decrypted content has no KEY=VALUE line (corruption / key mismatch)', async () => {
      const plaintext = Buffer.from('this is just prose, not an env file at all\n', 'utf-8');
      const enc = service.encrypt(plaintext);
      const wire = service.serializeEncrypted(enc);
      const metadata = {
        service: 'rsm',
        version: '1',
        timestamp: '2026-01-01T00:00:00.000Z',
        size: plaintext.length,
      };

      mockExistsSync.mockReturnValue(true);
      mockReaddir.mockResolvedValue(['1.json'] as never);
      mockReadFile.mockImplementation(async (p: { toString: () => string }) => {
        const ps = p.toString();
        if (ps.endsWith('1.json')) return JSON.stringify(metadata);
        if (ps.endsWith('1.enc')) return wire;
        throw new Error('ENOENT');
      });

      const res = await service.apply({
        service: 'rsm',
        targetEnvPath: '/x/.env',
        sharedStatePath: '/s',
      });

      expect(res.status).toBe('error');
      expect(res.message).toMatch(/does not appear to be a valid/);
    });

    test('dryRun: reports success without writing the target', async () => {
      const plaintext = Buffer.from('API_KEY=secret\n', 'utf-8');
      const enc = service.encrypt(plaintext);
      const wire = service.serializeEncrypted(enc);
      const metadata = {
        service: 'rsm',
        version: '1',
        timestamp: '2026-01-01T00:00:00.000Z',
        size: plaintext.length,
      };

      mockExistsSync.mockReturnValue(true);
      mockReaddir.mockResolvedValue(['1.json'] as never);
      mockReadFile.mockImplementation(async (p: { toString: () => string }) => {
        const ps = p.toString();
        if (ps.endsWith('1.json')) return JSON.stringify(metadata);
        if (ps.endsWith('1.enc')) return wire;
        throw new Error('ENOENT');
      });

      const res = await service.apply({
        service: 'rsm',
        targetEnvPath: '/x/.env',
        sharedStatePath: '/s',
        dryRun: true,
      });

      expect(res.status).toBe('success');
      expect(res.message).toMatch(/DRY RUN/);
      expect(mockWriteFile).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // Audit trail — #2410 grain 2 (web1, dispatch ai-01 05/10):
  // ONE [ENV-ROTATION] line per rotation attempt, success AND
  // failure — never a value.
  // ============================================================
  describe('audit trail — one [ENV-ROTATION] line per rotation, incl. failures (#2410)', () => {
    /** Reads the Nth JSONL line written via appendFile. */
    function auditLine(call = 0): Record<string, unknown> {
      expect(mockAppendFile).toHaveBeenCalledTimes(call + 1);
      const raw = (mockAppendFile.mock.calls[call] as unknown[])[1] as string;
      return JSON.parse(raw);
    }

    test('publish success: line carries the [ENV-ROTATION] marker, service+version+machine, key count — and no value', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFile.mockResolvedValue('API_KEY=secret-value-xyz\nOTHER=val2\n# comment\n');

      await service.publish({
        service: 'rsm',
        envPath: '/x/.env',
        sharedStatePath: '/s',
        version: '2',
        machineId: 'm1',
      });

      const line = auditLine(0);
      expect(line.marker).toBe('[ENV-ROTATION]');
      expect(line.action).toBe('publish');
      expect(line.service).toBe('rsm');
      expect(line.version).toBe('2');
      expect(line.machineId).toBe('m1');
      expect(line.status).toBe('success');
      expect(line.keysWritten).toBe(2); // 2 KEY=VALUE lines, comment excluded
      // Never a value: the serialized line must not leak env content
      const raw = (mockAppendFile.mock.calls[0] as unknown[])[1] as string;
      expect(raw).not.toContain('secret-value-xyz');
      expect(raw).not.toContain('val2');
    });

    test('publish failure (source .env missing): still exactly one line, status error', async () => {
      mockExistsSync.mockReturnValue(false); // envPath missing

      await service.publish({
        service: 'rsm',
        envPath: '/x/.env',
        sharedStatePath: '/s',
        version: '2',
        machineId: 'm1',
      });

      const line = auditLine(0);
      expect(line.marker).toBe('[ENV-ROTATION]');
      expect(line.action).toBe('publish');
      expect(line.status).toBe('error');
      expect(String(line.error)).toMatch(/not found/i);
    });

    test('apply failure (nothing published): one line, status error', async () => {
      mockExistsSync.mockReturnValue(false); // envDir missing

      await service.apply({ service: 'rsm', targetEnvPath: '/x/.env', sharedStatePath: '/s' });

      const line = auditLine(0);
      expect(line.marker).toBe('[ENV-ROTATION]');
      expect(line.action).toBe('apply');
      expect(line.service).toBe('rsm');
      expect(line.status).toBe('error');
    });

    test('apply decrypt failure (key mismatch): returns status error — not a throw — plus audit line', async () => {
      const plaintext = Buffer.from('API_KEY=secret\n', 'utf-8');
      const enc = service.encrypt(plaintext);
      const wire = service.serializeEncrypted(enc);
      const metadata = { service: 'rsm', version: '1', timestamp: '2026-01-01T00:00:00.000Z', size: plaintext.length };

      mockExistsSync.mockReturnValue(true);
      mockReaddir.mockResolvedValue(['1.json'] as never);
      mockReadFile.mockImplementation(async (p: { toString: () => string }) => {
        const ps = p.toString();
        if (ps.endsWith('1.json')) return JSON.stringify(metadata);
        if (ps.endsWith('1.enc')) return wire;
        throw new Error('ENOENT');
      });
      process.env.ROOSYNC_ENV_KEY = 'y'.repeat(48); // WRONG key → GCM auth failure

      const res = await service.apply({ service: 'rsm', targetEnvPath: '/x/.env', sharedStatePath: '/s' });

      expect(res.status).toBe('error');
      expect(res.message).toMatch(/decrypt/i);
      const line = auditLine(0);
      expect(line.marker).toBe('[ENV-ROTATION]');
      expect(line.action).toBe('apply');
      expect(line.status).toBe('error');
      // The crypto error message must not smuggle plaintext into the journal
      const raw = (mockAppendFile.mock.calls[0] as unknown[])[1] as string;
      expect(raw).not.toContain('secret');
    });

    test('apply failure (decrypted content invalid): one line, status error', async () => {
      const plaintext = Buffer.from('just prose, not env\n', 'utf-8');
      const enc = service.encrypt(plaintext);
      const wire = service.serializeEncrypted(enc);
      const metadata = { service: 'rsm', version: '1', timestamp: '2026-01-01T00:00:00.000Z', size: plaintext.length };

      mockExistsSync.mockReturnValue(true);
      mockReaddir.mockResolvedValue(['1.json'] as never);
      mockReadFile.mockImplementation(async (p: { toString: () => string }) => {
        const ps = p.toString();
        if (ps.endsWith('1.json')) return JSON.stringify(metadata);
        if (ps.endsWith('1.enc')) return wire;
        throw new Error('ENOENT');
      });

      await service.apply({ service: 'rsm', targetEnvPath: '/x/.env', sharedStatePath: '/s' });

      const line = auditLine(0);
      expect(line.status).toBe('error');
      expect(line.marker).toBe('[ENV-ROTATION]');
    });

    test('apply success: line carries marker, version, keysWritten', async () => {
      const plaintext = Buffer.from('API_KEY=secret\nOTHER=val\n', 'utf-8');
      const enc = service.encrypt(plaintext);
      const wire = service.serializeEncrypted(enc);
      const metadata = { service: 'rsm', version: '7', timestamp: '2026-01-01T00:00:00.000Z', size: plaintext.length };

      mockExistsSync.mockReturnValue(true);
      mockReaddir.mockResolvedValue(['7.json'] as never);
      mockReadFile.mockImplementation(async (p: { toString: () => string }) => {
        const ps = p.toString();
        if (ps.endsWith('7.json')) return JSON.stringify(metadata);
        if (ps.endsWith('7.enc')) return wire;
        throw new Error('ENOENT');
      });

      await service.apply({ service: 'rsm', targetEnvPath: '/x/.env', sharedStatePath: '/s' });

      const line = auditLine(0);
      expect(line.marker).toBe('[ENV-ROTATION]');
      expect(line.action).toBe('apply');
      expect(line.version).toBe('7');
      expect(line.keysWritten).toBe(2);
      expect(line.status).toBe('success');
    });
  });

  // ============================================================
  // Concurrent publishes — #2410 (dispatch ai-01 22/10): two
  // publish() in flight on the SAME service+version. Contract:
  // every artifact write is a COMPLETE wire (salt/iv/tag travel
  // WITH the ciphertext, so a reader never sees a torn buffer),
  // last write wins, and each attempt still gets its own audit
  // line.
  // ============================================================
  describe('concurrent publishes — same service+version (#2410)', () => {
    const CONTENT_A = 'API_KEY=alpha\nSOURCE=machine-a\n';
    const CONTENT_B = 'API_KEY=beta\nSOURCE=machine-b\n';

    beforeEach(() => {
      mockExistsSync.mockReturnValue(true);
      mockReadFile.mockImplementation(async (p: { toString: () => string }) =>
        p.toString().startsWith('/a/') ? CONTENT_A : CONTENT_B
      );
    });

    test('both succeed; every .enc write is a complete decryptable wire; last-write-wins', async () => {
      const [ra, rb] = await Promise.all([
        service.publish({ service: 'rsm', envPath: '/a/.env', sharedStatePath: '/s', version: '3', machineId: 'machine-a' }),
        service.publish({ service: 'rsm', envPath: '/b/.env', sharedStatePath: '/s', version: '3', machineId: 'machine-b' }),
      ]);
      expect(ra.status).toBe('success');
      expect(rb.status).toBe('success');

      // 2 publishes × (.enc + .json metadata) = 4 artifact writes
      expect(mockWriteFile).toHaveBeenCalledTimes(4);
      const encWrites = mockWriteFile.mock.calls.filter(c => String(c[0]).endsWith('3.enc'));
      expect(encWrites).toHaveLength(2);

      // Every .enc write is a COMPLETE wire decrypting to one of the two
      // sources — never a torn buffer, even mid-race.
      for (const call of encWrites) {
        const parts = service.deserializeEncrypted(call[1] as Buffer);
        const plain = service.decrypt(parts.ciphertext, parts.iv, parts.tag, parts.salt).toString('utf-8');
        expect([CONTENT_A, CONTENT_B]).toContain(plain);
      }

      // Last-write-wins: the LAST .enc write to the shared path is the
      // artifact that stands, and it is itself complete + decryptable.
      const lastWire = encWrites[encWrites.length - 1][1] as Buffer;
      const last = service.deserializeEncrypted(lastWire);
      const lastPlain = service.decrypt(last.ciphertext, last.iv, last.tag, last.salt).toString('utf-8');
      expect([CONTENT_A, CONTENT_B]).toContain(lastPlain);
    });

    test('one audit line per attempt — 2 lines, both success, each naming its machine', async () => {
      await Promise.all([
        service.publish({ service: 'rsm', envPath: '/a/.env', sharedStatePath: '/s', version: '3', machineId: 'machine-a' }),
        service.publish({ service: 'rsm', envPath: '/b/.env', sharedStatePath: '/s', version: '3', machineId: 'machine-b' }),
      ]);

      expect(mockAppendFile).toHaveBeenCalledTimes(2);
      const lines = mockAppendFile.mock.calls.map(c => JSON.parse(String((c as unknown[])[1])));
      for (const line of lines) {
        expect(line.marker).toBe('[ENV-ROTATION]');
        expect(line.action).toBe('publish');
        expect(line.status).toBe('success');
      }
      expect(new Set(lines.map(l => l.machineId))).toEqual(new Set(['machine-a', 'machine-b']));
    });
  });

  // ============================================================
  // Concurrent publishes on DIFFERENT versions — no conflict:
  // independent artifacts, independent audit lines.
  // ============================================================
  describe('concurrent publishes — different versions: independent artifacts (#2410)', () => {
    test('each version writes its own .enc + .json + audit line', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFile.mockImplementation(async (p: { toString: () => string }) =>
        p.toString().startsWith('/a/') ? 'API_KEY=alpha\n' : 'API_KEY=beta\n'
      );

      const [r4, r5] = await Promise.all([
        service.publish({ service: 'rsm', envPath: '/a/.env', sharedStatePath: '/s', version: '4', machineId: 'ma' }),
        service.publish({ service: 'rsm', envPath: '/b/.env', sharedStatePath: '/s', version: '5', machineId: 'mb' }),
      ]);
      expect(r4.status).toBe('success');
      expect(r5.status).toBe('success');

      expect(mockWriteFile).toHaveBeenCalledTimes(4);
      expect(mockWriteFile.mock.calls.filter(c => String(c[0]).endsWith('4.enc'))).toHaveLength(1);
      expect(mockWriteFile.mock.calls.filter(c => String(c[0]).endsWith('5.enc'))).toHaveLength(1);
      expect(mockAppendFile).toHaveBeenCalledTimes(2);
    });
  });
});
