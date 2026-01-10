/**
 * Test de diagnostic pour FileLockManager
 * 
 * Ce fichier sert à diagnostiquer les problèmes avec proper-lockfile
 * sur Windows.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { FileLockManager, getFileLockManager } from '@/services/roosync/FileLockManager';
import { tmpdir } from 'os';

describe('FileLockManager Diagnostic', () => {
  let lockManager: FileLockManager;
  let testDir: string;
  let testFilePath: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `filelock-diag-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });
    
    testFilePath = join(testDir, 'test-file.json');
    await fs.writeFile(testFilePath, JSON.stringify({ counter: 0 }));
    
    lockManager = getFileLockManager();
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch (error) {
      // Ignorer les erreurs de nettoyage
    }
  });

  it('should verify tmpdir exists', async () => {
    const tmp = tmpdir();
    console.log('tmpdir:', tmp);
    
    // Vérifier que le répertoire tmp existe
    const exists = await fs.access(tmp).then(() => true).catch(() => false);
    expect(exists).toBe(true);
  });

  it('should verify test directory exists', async () => {
    const exists = await fs.access(testDir).then(() => true).catch(() => false);
    expect(exists).toBe(true);
    console.log('testDir:', testDir);
  });

  it('should verify test file exists', async () => {
    const exists = await fs.access(testFilePath).then(() => true).catch(() => false);
    expect(exists).toBe(true);
    console.log('testFilePath:', testFilePath);
  });

  it('should acquire lock on existing file', async () => {
    const release = await lockManager.acquireLock(testFilePath);
    expect(release).toBeDefined();
    
    await release();
  });

  it('should use withLock on existing file', async () => {
    const result = await lockManager.withLock(
      testFilePath,
      async () => {
        const content = await fs.readFile(testFilePath, 'utf-8');
        return JSON.parse(content);
      }
    );

    console.log('Result:', result);
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ counter: 0 });
  });
});
