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
});
