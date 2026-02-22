/**
 * Tests unitaires pour FileLockManager (proper-lockfile version)
 *
 * Couvre :
 * - acquireLock : succès (fichier existant / non existant)
 * - acquireLock : échec (LOCK_ACQUISITION_FAILED)
 * - releaseLock : verrou connu / inconnu
 * - withLock : opération réussie / échouée
 * - writeWithLock : succès
 * - readWithLock : succès
 * - updateJsonWithLock : mise à jour / erreur parse
 * - cleanupAllLocks : vide tous les verrous
 * - isLocked : locked / unlocked / erreur
 * - forceRelease : succès / FORCE_RELEASE_FAILED
 * - getFileLockManager : singleton
 *
 * @module services/roosync/__tests__/FileLockManager.test
 * @version 1.0.0 (#492)
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// ─────────────────── mocks (vi.hoisted) ───────────────────

const { mockLock, mockUnlock, mockCheck, mockMkdir, mockAccess, mockWriteFile, mockReadFile } = vi.hoisted(() => ({
  mockLock: vi.fn(),
  mockUnlock: vi.fn(),
  mockCheck: vi.fn(),
  mockMkdir: vi.fn(),
  mockAccess: vi.fn(),
  mockWriteFile: vi.fn(),
  mockReadFile: vi.fn(),
}));

vi.mock('proper-lockfile', () => ({
  default: {
    lock: (...args: any[]) => mockLock(...args),
    unlock: (...args: any[]) => mockUnlock(...args),
    check: (...args: any[]) => mockCheck(...args),
  },
}));

vi.mock('fs', () => {
  const fsMock = {
    mkdir: (...args: any[]) => mockMkdir(...args),
    access: (...args: any[]) => mockAccess(...args),
    writeFile: (...args: any[]) => mockWriteFile(...args),
    readFile: (...args: any[]) => mockReadFile(...args),
  };
  return {
    promises: fsMock,
    default: { promises: fsMock },
  };
});

import {
  FileLockManager,
  FileLockManagerError,
  getFileLockManager,
} from '../FileLockManager.js';

// ─────────────────── helpers ───────────────────

/** Crée une release fn mock qui resolve immédiatement */
function makeRelease(): vi.Mock {
  return vi.fn().mockResolvedValue(undefined);
}

// ─────────────────── setup ───────────────────

let manager: FileLockManager;

beforeEach(() => {
  vi.clearAllMocks();
  manager = new FileLockManager();

  // Re-apply implementations après restoreMocks: true
  mockMkdir.mockResolvedValue(undefined);
  mockAccess.mockResolvedValue(undefined);   // file already exists
  mockWriteFile.mockResolvedValue(undefined);
  mockReadFile.mockResolvedValue('{}');
  mockLock.mockResolvedValue(makeRelease());
  mockUnlock.mockResolvedValue(undefined);
  mockCheck.mockResolvedValue(true);
});

// ─────────────────── tests ───────────────────

describe('FileLockManager', () => {

  // ============================================================
  // acquireLock - succès
  // ============================================================

  describe('acquireLock - succès', () => {
    test('retourne une fonction release quand le verrou est acquis', async () => {
      const release = await manager.acquireLock('/tmp/test.json');
      expect(typeof release).toBe('function');
    });

    test('crée le répertoire parent', async () => {
      await manager.acquireLock('/tmp/subdir/test.json');
      expect(mockMkdir).toHaveBeenCalledWith('/tmp/subdir', { recursive: true });
    });

    test('ne crée pas le fichier si access réussit (fichier existant)', async () => {
      mockAccess.mockResolvedValue(undefined);
      await manager.acquireLock('/tmp/existing.json');
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    test('crée le fichier avec {} si access échoue (fichier inexistant)', async () => {
      mockAccess.mockRejectedValue(new Error('ENOENT'));
      await manager.acquireLock('/tmp/new.json');
      expect(mockWriteFile).toHaveBeenCalledWith('/tmp/new.json', '{}');
    });

    test('appelle lockfile.lock avec realpath: false et fs: fsSync', async () => {
      await manager.acquireLock('/tmp/test.json');
      expect(mockLock).toHaveBeenCalledWith(
        '/tmp/test.json',
        expect.objectContaining({ realpath: false })
      );
    });

    test('stocke le verrou dans la map interne', async () => {
      await manager.acquireLock('/tmp/test.json');
      // Le verrou doit être relâchable via releaseLock
      await expect(manager.releaseLock('/tmp/test.json')).resolves.toBeUndefined();
    });

    test('respecte les options custom (retries, stale)', async () => {
      await manager.acquireLock('/tmp/test.json', { retries: 5, stale: 60000 });
      expect(mockLock).toHaveBeenCalledWith(
        '/tmp/test.json',
        expect.objectContaining({ retries: 5, stale: 60000 })
      );
    });
  });

  // ============================================================
  // acquireLock - échec
  // ============================================================

  describe('acquireLock - échec', () => {
    test('lève FileLockManagerError si lockfile.lock échoue', async () => {
      mockLock.mockRejectedValue(new Error('locked'));
      await expect(manager.acquireLock('/tmp/test.json'))
        .rejects.toBeInstanceOf(FileLockManagerError);
    });

    test('code d\'erreur est LOCK_ACQUISITION_FAILED', async () => {
      mockLock.mockRejectedValue(new Error('locked'));
      try {
        await manager.acquireLock('/tmp/test.json');
        expect.fail('Should throw');
      } catch (err: any) {
        expect(err.code).toBe('LOCK_ACQUISITION_FAILED');
      }
    });

    test('message contient le chemin du fichier', async () => {
      mockLock.mockRejectedValue(new Error('locked'));
      try {
        await manager.acquireLock('/tmp/my-file.json');
        expect.fail('Should throw');
      } catch (err: any) {
        expect(err.message).toContain('/tmp/my-file.json');
      }
    });
  });

  // ============================================================
  // releaseLock
  // ============================================================

  describe('releaseLock', () => {
    test('appelle la fonction release stockée', async () => {
      const releaseFn = makeRelease();
      mockLock.mockResolvedValue(releaseFn);
      await manager.acquireLock('/tmp/test.json');
      await manager.releaseLock('/tmp/test.json');
      expect(releaseFn).toHaveBeenCalled();
    });

    test('supprime le verrou de la map interne', async () => {
      const releaseFn = makeRelease();
      mockLock.mockResolvedValue(releaseFn);
      await manager.acquireLock('/tmp/test.json');
      await manager.releaseLock('/tmp/test.json');
      // Appeler une deuxième fois ne doit pas rappeler releaseFn
      await manager.releaseLock('/tmp/test.json');
      expect(releaseFn).toHaveBeenCalledTimes(1);
    });

    test('ne fait rien si le fichier n\'est pas dans la map', async () => {
      // Pas de throw, juste silencieux
      await expect(manager.releaseLock('/tmp/unknown.json')).resolves.toBeUndefined();
    });

    test('gère les erreurs de release silencieusement (warn)', async () => {
      const releaseFn = vi.fn().mockRejectedValue(new Error('release failed'));
      mockLock.mockResolvedValue(releaseFn);
      await manager.acquireLock('/tmp/test.json');
      // Ne doit pas lever d'exception
      await expect(manager.releaseLock('/tmp/test.json')).resolves.toBeUndefined();
    });
  });

  // ============================================================
  // withLock
  // ============================================================

  describe('withLock', () => {
    test('exécute l\'opération et retourne success=true', async () => {
      const result = await manager.withLock('/tmp/test.json', async () => 'result');
      expect(result.success).toBe(true);
      expect(result.data).toBe('result');
    });

    test('retourne success=false si l\'opération lève une erreur', async () => {
      const result = await manager.withLock('/tmp/test.json', async () => {
        throw new Error('Operation error');
      });
      expect(result.success).toBe(false);
      expect(result.error?.message).toBe('Operation error');
    });

    test('libère toujours le verrou (finally), même si opération échoue', async () => {
      const releaseFn = makeRelease();
      mockLock.mockResolvedValue(releaseFn);

      await manager.withLock('/tmp/test.json', async () => {
        throw new Error('fail');
      });

      expect(releaseFn).toHaveBeenCalled();
    });

    test('retourne success=false si acquireLock échoue', async () => {
      mockLock.mockRejectedValue(new Error('Cannot lock'));
      const result = await manager.withLock('/tmp/test.json', async () => 'ok');
      expect(result.success).toBe(false);
    });

    test('withLock retourne error avec type Error', async () => {
      const result = await manager.withLock('/tmp/test.json', async () => {
        throw 'string error';
      });
      expect(result.error).toBeInstanceOf(Error);
    });
  });

  // ============================================================
  // writeWithLock
  // ============================================================

  describe('writeWithLock', () => {
    test('écrit le contenu et retourne success=true', async () => {
      const result = await manager.writeWithLock('/tmp/data.json', '{"key": "value"}');
      expect(result.success).toBe(true);
    });

    test('appelle fs.writeFile avec le contenu fourni', async () => {
      await manager.writeWithLock('/tmp/data.json', 'hello world');
      expect(mockWriteFile).toHaveBeenCalledWith(
        '/tmp/data.json',
        'hello world',
        'utf-8'
      );
    });

    test('retourne success=false si writeFile échoue', async () => {
      // mockAccess résout (fichier existe) → acquireLock N'appelle PAS writeFile
      // → seul appel writeFile = l'écriture réelle dans l'opération
      mockWriteFile.mockRejectedValueOnce(new Error('Disk full'));
      const result = await manager.writeWithLock('/tmp/data.json', 'content');
      expect(result.success).toBe(false);
    });
  });

  // ============================================================
  // readWithLock
  // ============================================================

  describe('readWithLock', () => {
    test('lit le contenu et retourne success=true', async () => {
      mockReadFile.mockResolvedValue('file content');
      const result = await manager.readWithLock('/tmp/data.json');
      expect(result.success).toBe(true);
      expect(result.data).toBe('file content');
    });

    test('appelle fs.readFile avec utf-8', async () => {
      mockReadFile.mockResolvedValue('data');
      await manager.readWithLock('/tmp/data.json');
      expect(mockReadFile).toHaveBeenCalledWith('/tmp/data.json', 'utf-8');
    });

    test('retourne success=false si readFile échoue', async () => {
      mockReadFile.mockRejectedValue(new Error('File not found'));
      const result = await manager.readWithLock('/tmp/missing.json');
      expect(result.success).toBe(false);
    });
  });

  // ============================================================
  // updateJsonWithLock
  // ============================================================

  describe('updateJsonWithLock', () => {
    test('lit, transforme et écrit le JSON', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({ count: 5 }));
      const result = await manager.updateJsonWithLock<{ count: number }>(
        '/tmp/data.json',
        (data) => ({ count: data.count + 1 })
      );
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ count: 6 });
    });

    test('appelle writeFile avec le JSON mis à jour', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({ name: 'test' }));
      await manager.updateJsonWithLock<{ name: string }>(
        '/tmp/data.json',
        (data) => ({ name: data.name.toUpperCase() })
      );
      expect(mockWriteFile).toHaveBeenCalledWith(
        '/tmp/data.json',
        expect.stringContaining('TEST'),
        'utf-8'
      );
    });

    test('retourne success=false si JSON invalide', async () => {
      mockReadFile.mockResolvedValue('invalid-json{{{');
      const result = await manager.updateJsonWithLock('/tmp/bad.json', (d) => d);
      expect(result.success).toBe(false);
    });
  });

  // ============================================================
  // cleanupAllLocks
  // ============================================================

  describe('cleanupAllLocks', () => {
    test('appelle release sur tous les verrous actifs', async () => {
      const release1 = makeRelease();
      const release2 = makeRelease();
      mockLock
        .mockResolvedValueOnce(release1)
        .mockResolvedValueOnce(release2);

      await manager.acquireLock('/tmp/file1.json');
      await manager.acquireLock('/tmp/file2.json');
      await manager.cleanupAllLocks();

      expect(release1).toHaveBeenCalled();
      expect(release2).toHaveBeenCalled();
    });

    test('vide la map après nettoyage', async () => {
      const releaseFn = makeRelease();
      mockLock.mockResolvedValue(releaseFn);
      await manager.acquireLock('/tmp/file.json');
      await manager.cleanupAllLocks();
      // Ne doit plus rien appeler si on appelle releaseLock maintenant
      vi.clearAllMocks();
      await manager.releaseLock('/tmp/file.json');
      expect(releaseFn).not.toHaveBeenCalled();
    });

    test('gère les erreurs de release silencieusement', async () => {
      const failRelease = vi.fn().mockRejectedValue(new Error('release error'));
      mockLock.mockResolvedValue(failRelease);
      await manager.acquireLock('/tmp/file.json');
      // Ne doit pas throw
      await expect(manager.cleanupAllLocks()).resolves.toBeUndefined();
    });

    test('fonctionne si aucun verrou actif', async () => {
      await expect(manager.cleanupAllLocks()).resolves.toBeUndefined();
    });
  });

  // ============================================================
  // isLocked
  // ============================================================

  describe('isLocked', () => {
    test('retourne true si lockfile.check retourne non-null', async () => {
      mockCheck.mockResolvedValue(true);
      expect(await manager.isLocked('/tmp/file.json')).toBe(true);
    });

    test('retourne false si lockfile.check retourne null', async () => {
      mockCheck.mockResolvedValue(null);
      expect(await manager.isLocked('/tmp/file.json')).toBe(false);
    });

    test('retourne false si lockfile.check lève une erreur', async () => {
      mockCheck.mockRejectedValue(new Error('check failed'));
      expect(await manager.isLocked('/tmp/file.json')).toBe(false);
    });
  });

  // ============================================================
  // forceRelease
  // ============================================================

  describe('forceRelease', () => {
    test('appelle lockfile.unlock', async () => {
      await manager.forceRelease('/tmp/locked.json');
      expect(mockUnlock).toHaveBeenCalledWith('/tmp/locked.json');
    });

    test('supprime le verrou de la map interne', async () => {
      const releaseFn = makeRelease();
      mockLock.mockResolvedValue(releaseFn);
      await manager.acquireLock('/tmp/locked.json');
      await manager.forceRelease('/tmp/locked.json');
      // releaseLock ne doit plus appeler releaseFn
      vi.clearAllMocks();
      await manager.releaseLock('/tmp/locked.json');
      expect(releaseFn).not.toHaveBeenCalled();
    });

    test('lève FileLockManagerError si unlock échoue', async () => {
      mockUnlock.mockRejectedValue(new Error('Cannot unlock'));
      await expect(manager.forceRelease('/tmp/locked.json'))
        .rejects.toBeInstanceOf(FileLockManagerError);
    });

    test('code d\'erreur est FORCE_RELEASE_FAILED', async () => {
      mockUnlock.mockRejectedValue(new Error('unlock error'));
      try {
        await manager.forceRelease('/tmp/locked.json');
        expect.fail('Should throw');
      } catch (err: any) {
        expect(err.code).toBe('FORCE_RELEASE_FAILED');
      }
    });
  });

  // ============================================================
  // getFileLockManager (singleton)
  // ============================================================

  describe('getFileLockManager', () => {
    test('retourne une instance FileLockManager', () => {
      const instance = getFileLockManager();
      expect(instance).toBeInstanceOf(FileLockManager);
    });

    test('retourne toujours la même instance (singleton)', () => {
      const a = getFileLockManager();
      const b = getFileLockManager();
      expect(a).toBe(b);
    });
  });

  // ============================================================
  // FileLockManagerError
  // ============================================================

  describe('FileLockManagerError', () => {
    test('nom de l\'erreur est FileLockManagerError', () => {
      const err = new FileLockManagerError('test error');
      expect(err.name).toBe('FileLockManagerError');
    });

    test('message contient [FileLockManager] prefix', () => {
      const err = new FileLockManagerError('something went wrong');
      expect(err.message).toContain('[FileLockManager]');
    });

    test('code optionnel est accessible', () => {
      const err = new FileLockManagerError('test', 'MY_CODE');
      expect(err.code).toBe('MY_CODE');
    });

    test('sans code, code est undefined', () => {
      const err = new FileLockManagerError('test');
      expect(err.code).toBeUndefined();
    });
  });
});
