/**
 * Tests unitaires pour RollbackManager
 * #537 Phase 2
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { existsSync } from 'fs';
import { RollbackManager } from '../RollbackManager.js';
import type { Logger } from '../../utils/logger.js';

describe('RollbackManager', () => {
  let rollbackManager: RollbackManager;
  let mockLogger: Logger;
  let tempDir: string;

  beforeEach(async () => {
    mockLogger = {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn().mockReturnThis()
    } as any;

    rollbackManager = new RollbackManager(mockLogger);
    tempDir = await mkdtemp(join(tmpdir(), 'rollback-test-'));
  });

  afterEach(async () => {
    if (existsSync(tempDir)) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  describe('track()', () => {
    it('should track a backup entry', () => {
      rollbackManager.track('/path/to/file.json', '/path/to/file.json.backup_2026-03-04');

      expect(rollbackManager.size).toBe(1);
      expect(rollbackManager.hasTrackedBackups).toBe(true);
    });

    it('should track multiple entries', () => {
      rollbackManager.track('/path/to/a.json', '/path/to/a.json.backup_1');
      rollbackManager.track('/path/to/b.json', '/path/to/b.json.backup_2');

      expect(rollbackManager.size).toBe(2);
    });

    it('should overwrite previous track for same path', () => {
      rollbackManager.track('/path/to/file.json', '/path/to/file.json.backup_1');
      rollbackManager.track('/path/to/file.json', '/path/to/file.json.backup_2');

      expect(rollbackManager.size).toBe(1);
      const entries = rollbackManager.listTracked();
      expect(entries[0].backupPath).toBe('/path/to/file.json.backup_2');
    });
  });

  describe('createAndTrack()', () => {
    it('should create backup and track it', async () => {
      const originalPath = join(tempDir, 'test.json');
      await writeFile(originalPath, JSON.stringify({ test: true }));

      const backupPath = await rollbackManager.createAndTrack(originalPath);

      expect(existsSync(backupPath)).toBe(true);
      expect(rollbackManager.size).toBe(1);
      expect(backupPath).toContain('backup_');

      const backupContent = await readFile(backupPath, 'utf-8');
      expect(JSON.parse(backupContent)).toEqual({ test: true });
    });

    it('should throw if file does not exist', async () => {
      await expect(rollbackManager.createAndTrack('/nonexistent/file.json'))
        .rejects.toThrow('Impossible de créer un backup');
    });
  });

  describe('restoreAll()', () => {
    it('should restore files from backups', async () => {
      const originalPath = join(tempDir, 'config.json');
      const backupPath = join(tempDir, 'config.json.backup');

      // Create original file
      await writeFile(originalPath, JSON.stringify({ version: 1 }));
      // Create backup with different content
      await writeFile(backupPath, JSON.stringify({ version: 0, original: true }));

      // Modify original
      await writeFile(originalPath, JSON.stringify({ version: 2, modified: true }));

      // Track and restore
      rollbackManager.track(originalPath, backupPath);
      const result = await rollbackManager.restoreAll();

      expect(result.success).toBe(true);
      expect(result.restoredFiles).toContain(originalPath);

      const restoredContent = JSON.parse(await readFile(originalPath, 'utf-8'));
      expect(restoredContent).toEqual({ version: 0, original: true });
    });

    it('should cleanup backups after restore when requested', async () => {
      const originalPath = join(tempDir, 'config.json');
      const backupPath = join(tempDir, 'config.json.backup');

      await writeFile(originalPath, JSON.stringify({ test: 1 }));
      await writeFile(backupPath, JSON.stringify({ test: 0 }));

      rollbackManager.track(originalPath, backupPath);
      await rollbackManager.restoreAll(true);

      expect(existsSync(backupPath)).toBe(false);
    });

    it('should keep backups when cleanup is false', async () => {
      const originalPath = join(tempDir, 'config.json');
      const backupPath = join(tempDir, 'config.json.backup');

      await writeFile(originalPath, JSON.stringify({ test: 1 }));
      await writeFile(backupPath, JSON.stringify({ test: 0 }));

      rollbackManager.track(originalPath, backupPath);
      await rollbackManager.restoreAll(false);

      expect(existsSync(backupPath)).toBe(true);
    });

    it('should report failed restores', async () => {
      rollbackManager.track('/nonexistent/file.json', '/nonexistent/backup.json');

      const result = await rollbackManager.restoreAll();

      expect(result.success).toBe(false);
      expect(result.failedFiles.length).toBe(1);
      expect(result.failedFiles[0].path).toBe('/nonexistent/file.json');
    });

    it('should handle empty tracked backups', async () => {
      const result = await rollbackManager.restoreAll();

      expect(result.success).toBe(true);
      expect(result.restoredFiles).toEqual([]);
    });
  });

  describe('release()', () => {
    it('should clear tracked backups without restoring', async () => {
      rollbackManager.track('/path/to/file.json', '/path/to/backup.json');

      await rollbackManager.release();

      expect(rollbackManager.size).toBe(0);
      expect(rollbackManager.hasTrackedBackups).toBe(false);
    });

    it('should cleanup backups when requested', async () => {
      const backupPath = join(tempDir, 'backup.json');
      await writeFile(backupPath, JSON.stringify({ test: true }));

      rollbackManager.track('/dummy/path.json', backupPath);
      await rollbackManager.release(true);

      expect(existsSync(backupPath)).toBe(false);
    });
  });

  describe('untrack()', () => {
    it('should remove specific tracked entry', () => {
      rollbackManager.track('/path/a.json', '/backup/a.json');
      rollbackManager.track('/path/b.json', '/backup/b.json');

      const removed = rollbackManager.untrack('/path/a.json');

      expect(removed).toBe(true);
      expect(rollbackManager.size).toBe(1);
    });

    it('should return false if entry not found', () => {
      const removed = rollbackManager.untrack('/nonexistent.json');
      expect(removed).toBe(false);
    });
  });

  describe('Integration: apply with rollback pattern', () => {
    it('should demonstrate full rollback flow', async () => {
      const configPath = join(tempDir, 'config.json');

      // Initial config
      await writeFile(configPath, JSON.stringify({ setting: 'original' }));

      // Create backup before modification
      const backupPath = await rollbackManager.createAndTrack(configPath);

      // Modify config (simulating apply)
      await writeFile(configPath, JSON.stringify({ setting: 'modified', newField: true }));

      // Something goes wrong, we need to rollback
      const result = await rollbackManager.restoreAll();

      expect(result.success).toBe(true);

      const finalContent = JSON.parse(await readFile(configPath, 'utf-8'));
      expect(finalContent).toEqual({ setting: 'original' });
    });

    it('should demonstrate successful apply (no rollback needed)', async () => {
      const configPath = join(tempDir, 'config.json');

      await writeFile(configPath, JSON.stringify({ setting: 'original' }));
      await rollbackManager.createAndTrack(configPath);

      // Modification succeeds
      await writeFile(configPath, JSON.stringify({ setting: 'modified' }));

      // Release without restore
      await rollbackManager.release();

      const finalContent = JSON.parse(await readFile(configPath, 'utf-8'));
      expect(finalContent).toEqual({ setting: 'modified' });
    });
  });
});
