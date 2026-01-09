/**
 * Tests unitaires pour FileLockManager (implémentation simple)
 *
 * Ce fichier teste le système de verrouillage de fichiers pour prévenir
 * les problèmes de concurrence dans RooSync.
 *
 * IMPORTANT: Ces tests utilisent le mock fs existant dans jest.setup.js
 *
 * @module FileLockManager.simple.test
 * @version 1.0.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { FileLockManager, getFileLockManager, LockOptions, LockOperationResult } from '@/services/roosync/FileLockManager.simple';

/**
 * Classe de test pour FileLockManager
 */
describe('FileLockManager Simple', () => {
  let lockManager: FileLockManager;
  let testDir: string;
  let testFilePath: string;

  /**
   * Configuration avant chaque test
   */
  beforeEach(async () => {
    // Créer un répertoire de test dans le workspace
    testDir = join(process.cwd(), 'test-lock-temp-' + Date.now());
    await fs.mkdir(testDir, { recursive: true });
    
    testFilePath = join(testDir, 'test-file.json');
    
    // Créer un fichier de test initial
    await fs.writeFile(testFilePath, JSON.stringify({ counter: 0 }));
    
    // Obtenir l'instance singleton de FileLockManager
    lockManager = getFileLockManager();
  });

  /**
   * Nettoyage après chaque test
   */
  afterEach(async () => {
    // Nettoyer le répertoire de test
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch (error) {
      // Ignorer les erreurs de nettoyage
    }
  });

  /**
   * Test: Acquisition et libération de verrou basique
   */
  it('should acquire and release a lock successfully', async () => {
    const release = await lockManager.acquireLock(testFilePath);
    
    expect(release).toBeDefined();
    expect(typeof release).toBe('function');
    
    // Libérer le verrou
    await release();
  });

  /**
   * Test: Mise à jour de fichier JSON avec verrou
   */
  it('should update JSON file with lock', async () => {
    const result = await lockManager.updateJsonWithLock(
      testFilePath,
      (data: any) => {
        return { ...data, counter: data.counter + 1 };
      }
    );

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ counter: 1 });

    // Vérifier que le fichier a été mis à jour
    const content = await fs.readFile(testFilePath, 'utf-8');
    const fileData = JSON.parse(content);
    expect(fileData).toEqual({ counter: 1 });
  });

  /**
   * Test: Gestion des erreurs dans l'opération
   */
  it('should handle errors in operation', async () => {
    const result = await lockManager.withLock(
      testFilePath,
      async () => {
        throw new Error('Test error');
      }
    );

    expect(result.success).toBe(false);
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error?.message).toBe('Test error');
  });

  /**
   * Test: Lecture de fichier avec verrou
   */
  it('should read file with lock', async () => {
    const result = await lockManager.readWithLock(testFilePath);

    expect(result.success).toBe(true);
    expect(result.data).toBe('{"counter":0}');
  });

  /**
   * Test: Écriture de fichier avec verrou
   */
  it('should write file with lock', async () => {
    const newData = JSON.stringify({ counter: 42 });
    const result = await lockManager.writeWithLock(testFilePath, newData);

    expect(result.success).toBe(true);

    // Vérifier que le fichier a été écrit
    const content = await fs.readFile(testFilePath, 'utf-8');
    const fileData = JSON.parse(content);
    expect(fileData).toEqual({ counter: 42 });
  });

  /**
   * Test: Vérification de verrou
   */
  it('should check if file is locked', async () => {
    // Acquérir un verrou
    const release = await lockManager.acquireLock(testFilePath);

    // Vérifier que le fichier est verrouillé
    const isLocked = await lockManager.isLocked(testFilePath);
    expect(isLocked).toBe(true);

    // Libérer le verrou
    await release();

    // Vérifier que le fichier n'est plus verrouillé
    const isLockedAfter = await lockManager.isLocked(testFilePath);
    expect(isLockedAfter).toBe(false);
  });

  /**
   * Test: Options de verrouillage personnalisées
   */
  it('should use custom lock options', async () => {
    const customOptions: LockOptions = {
      retries: 3,
      minTimeout: 10,
      maxTimeout: 50,
      stale: 5000
    };

    const result = await lockManager.withLock(
      testFilePath,
      async () => {
        return { custom: true };
      },
      customOptions
    );

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ custom: true });
  });

  /**
   * Test: Gestion des fichiers inexistants
   */
  it('should handle non-existent files gracefully', async () => {
    const nonExistentPath = join(testDir, 'non-existent.json');

    const result = await lockManager.readWithLock(nonExistentPath);

    expect(result.success).toBe(false);
    expect(result.error).toBeInstanceOf(Error);
  });

  /**
   * Test: Concurrence - plusieurs opérations simultanées
   */
  it('should handle concurrent operations safely', async () => {
    const operations = 10;
    const promises: Promise<LockOperationResult<any>>[] = [];

    // Lancer plusieurs opérations simultanées
    for (let i = 0; i < operations; i++) {
      promises.push(
        lockManager.updateJsonWithLock(
          testFilePath,
          (data: any) => {
            return { ...data, counter: data.counter + 1 };
          }
        )
      );
    }

    // Attendre que toutes les opérations se terminent
    const results = await Promise.all(promises);

    // Vérifier que toutes les opérations ont réussi
    results.forEach(result => {
      expect(result.success).toBe(true);
    });

    // Vérifier que le compteur final est correct
    const content = await fs.readFile(testFilePath, 'utf-8');
    const fileData = JSON.parse(content);
    expect(fileData.counter).toBe(operations);
  });

  /**
   * Test: Concurrence - avec délais pour simuler des opérations longues
   */
  it('should handle concurrent operations with delays', async () => {
    const operations = 5;
    const promises: Promise<LockOperationResult<any>>[] = [];

    // Lancer des opérations avec des délais variables
    for (let i = 0; i < operations; i++) {
      promises.push(
        lockManager.updateJsonWithLock(
          testFilePath,
          async (data: any) => {
            // Simuler une opération longue
            await new Promise(resolve => setTimeout(resolve, Math.random() * 50));
            return { ...data, counter: data.counter + 1 };
          }
        )
      );
    }

    // Attendre que toutes les opérations se terminent
    const results = await Promise.all(promises);

    // Vérifier que toutes les opérations ont réussi
    results.forEach(result => {
      expect(result.success).toBe(true);
    });

    // Vérifier que le compteur final est correct
    const content = await fs.readFile(testFilePath, 'utf-8');
    const fileData = JSON.parse(content);
    expect(fileData.counter).toBe(operations);
  });

  /**
   * Test: Singleton - getFileLockManager retourne la même instance
   */
  it('should return same instance from getFileLockManager', () => {
    const instance1 = getFileLockManager();
    const instance2 = getFileLockManager();

    expect(instance1).toBe(instance2);
  });

  /**
   * Test: Mise à jour complexe de JSON
   */
  it('should handle complex JSON updates', async () => {
    const complexData = {
      nested: {
        level1: {
          level2: {
            value: 'test'
          }
        }
      },
      array: [1, 2, 3]
    };

    await fs.writeFile(testFilePath, JSON.stringify(complexData));

    const result = await lockManager.updateJsonWithLock(
      testFilePath,
      (data: any) => {
        return {
          ...data,
          nested: {
            ...data.nested,
            level1: {
              ...data.nested.level1,
              level2: {
                ...data.nested.level1.level2,
                value: 'updated',
                added: true
              }
            }
          },
          array: [...data.array, 4]
        };
      }
    );

    expect(result.success).toBe(true);
    expect(result.data.nested.level1.level2.value).toBe('updated');
    expect(result.data.nested.level1.level2.added).toBe(true);
    expect(result.data.array).toEqual([1, 2, 3, 4]);
  });
});

/**
 * Tests d'intégration pour FileLockManager avec PresenceManager
 */
describe('FileLockManager Integration Simple', () => {
  let lockManager: FileLockManager;
  let testDir: string;
  let presenceFilePath: string;

  beforeEach(async () => {
    testDir = join(process.cwd(), 'test-presence-temp-' + Date.now());
    await fs.mkdir(testDir, { recursive: true });
    
    presenceFilePath = join(testDir, 'presence-test-machine.json');
    
    lockManager = getFileLockManager();
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch (error) {
      // Ignorer les erreurs de nettoyage
    }
  });

  /**
   * Test: Simulation de mise à jour de présence concurrente
   */
  it('should simulate concurrent presence updates', async () => {
    const initialPresence = {
      machineId: 'test-machine',
      status: 'online',
      lastSeen: new Date().toISOString(),
      metadata: { counter: 0 }
    };

    await fs.writeFile(presenceFilePath, JSON.stringify(initialPresence));

    // Simuler 5 mises à jour concurrentes
    const updates = 5;
    const promises: Promise<LockOperationResult<any>>[] = [];

    for (let i = 0; i < updates; i++) {
      promises.push(
        lockManager.updateJsonWithLock(
          presenceFilePath,
          (data: any) => {
            return {
              ...data,
              metadata: {
                ...data.metadata,
                counter: data.metadata.counter + 1
              },
              lastSeen: new Date().toISOString()
            };
          }
        )
      );
    }

    const results = await Promise.all(promises);

    // Vérifier que toutes les mises à jour ont réussi
    results.forEach(result => {
      expect(result.success).toBe(true);
    });

    // Vérifier que le compteur final est correct
    const content = await fs.readFile(presenceFilePath, 'utf-8');
    const presenceData = JSON.parse(content);
    expect(presenceData.metadata.counter).toBe(updates);
  });

  /**
   * Test: Simulation de suppression de présence concurrente
   */
  it('should handle concurrent presence removal', async () => {
    const initialPresence = {
      machineId: 'test-machine',
      status: 'online'
    };

    await fs.writeFile(presenceFilePath, JSON.stringify(initialPresence));

    // Tenter de supprimer le fichier avec verrou
    const result = await lockManager.withLock<void>(
      presenceFilePath,
      async () => {
        await fs.unlink(presenceFilePath);
      }
    );

    expect(result.success).toBe(true);

    // Vérifier que le fichier a été supprimé
    const exists = await fs.access(presenceFilePath).then(() => true).catch(() => false);
    expect(exists).toBe(false);
  });
});
