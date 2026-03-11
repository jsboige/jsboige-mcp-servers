/**
 * Test de debug pour CommitLogService
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Unmock fs to use real filesystem for integration tests
vi.unmock('fs/promises');
vi.unmock('fs');
// Unmock RooSyncService to use real implementation (not jest.setup.js global mock)
vi.unmock('../../src/services/RooSyncService.js');

import { mkdtemp, rm, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { RooSyncService } from '../../src/services/RooSyncService.js';
import { CommitLogService } from '../../src/services/roosync/CommitLogService.js';

describe('Debug CommitLogService', () => {
  let tempDir: string;
  let sharedPath: string;

  beforeEach(async () => {
    RooSyncService.resetInstance();
    tempDir = await mkdtemp(join(tmpdir(), 'debug-test-'));
    sharedPath = join(tempDir, 'shared');
    await mkdir(sharedPath, { recursive: true });
    await mkdir(join(sharedPath, 'commit-log'), { recursive: true });
  });

  afterEach(async () => {
    RooSyncService.resetInstance();
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch (error: any) {
      // Ignore Windows-specific errors when dir is locked (file handles not released yet)
      if (error.code !== 'ENOTEMPTY' && error.code !== 'EPERM' && error.code !== 'EBUSY') {
        console.warn('Failed to cleanup temp dir:', error.message);
      }
    }
  });

  it('direct CommitLogService creation works', async () => {
    const cls = new CommitLogService({
      commitLogPath: join(sharedPath, 'commit-log'),
      syncInterval: 30000,
      maxEntries: 10000,
      maxRetryAttempts: 3,
      retryDelay: 5000,
      enableCompression: false,
      compressionAge: 86400000,
      enableSigning: false,
      hashAlgorithm: 'sha256'
    });

    expect(cls).toBeDefined();
    expect(cls).toBeInstanceOf(CommitLogService);
  });

  it('RooSyncService.getCommitLogService returns instance', async () => {
    const service = RooSyncService.getInstance(undefined, {
      machineId: 'test-machine',
      sharedPath,
      autoSync: false,
      conflictStrategy: 'manual',
      logLevel: 'info'
    });

    expect(service).toBeDefined();
    expect(service).toBeInstanceOf(RooSyncService);

    const cls = service.getCommitLogService();
    expect(cls).toBeDefined();
    expect(cls).toBeInstanceOf(CommitLogService);

    // Clean up: stop the CommitLogService to release file handles
    await service.stopCommitLogService();
  });
});
