/**
 * Tests unitaires pour CommitLogService
 *
 * Couvre :
 * - Construction et initialisation
 * - appendCommit : ajout d'entrées avec lock, hash, séquence
 * - getCommit / getLatestCommits / getCommitsSince / getPendingCommits
 * - applyCommit / applyPendingCommits
 * - rollbackCommit
 * - verifyConsistency
 * - compressOldEntries / cleanupFailedEntries
 * - startAutoSync / stopAutoSync
 * - getState / getStatistics / resetCommitLog
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock fs before importing the module
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue('{}'),
    promises: {
      mkdir: vi.fn().mockResolvedValue(undefined),
      readdir: vi.fn().mockResolvedValue([]),
      readFile: vi.fn().mockResolvedValue('{}'),
      writeFile: vi.fn().mockResolvedValue(undefined),
      unlink: vi.fn().mockResolvedValue(undefined),
    },
  };
});

// Mock logger
vi.mock('../../../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { CommitLogService, CommitLogServiceError } from '../CommitLogService.js';
import { CommitEntryType, CommitStatus } from '../../../types/commit-log.js';
import { existsSync } from 'fs';
import { promises as fsPromises } from 'fs';

function createCommitEntry(overrides?: Record<string, any>) {
  return {
    type: CommitEntryType.CONFIG,
    machineId: 'test-machine',
    status: CommitStatus.PENDING,
    data: {
      configPath: '/test/config.json',
      changeType: 'update' as const,
    },
    ...overrides,
  };
}

describe('CommitLogService', () => {
  let service: CommitLogService;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    // Default: no existing state file
    (existsSync as any).mockReturnValue(false);

    service = new CommitLogService({
      commitLogPath: '/tmp/test-commit-log',
    });
    await service.waitForInitialization();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // === Constructor & Initialization ===

  describe('constructor', () => {
    it('should create service with default config', () => {
      expect(service).toBeDefined();
      expect(service.isInitialized()).toBe(true);
    });

    it('should initialize with empty state', () => {
      const state = service.getState();
      expect(state.currentSequenceNumber).toBe(0);
      expect(state.entries.size).toBe(0);
      expect(state.entriesByStatus.pending).toHaveLength(0);
      expect(state.entriesByStatus.applied).toHaveLength(0);
    });

    it('should create directories on initialization', () => {
      expect(fsPromises.mkdir).toHaveBeenCalledTimes(2);
    });

    it('should handle initialization failure gracefully', async () => {
      (fsPromises.mkdir as any).mockRejectedValueOnce(new Error('permission denied'));
      const failService = new CommitLogService({ commitLogPath: '/bad/path' });
      await failService.waitForInitialization();
      expect(failService.isInitialized()).toBe(false);
    });
  });

  // === appendCommit ===

  describe('appendCommit', () => {
    it('should append a commit with incrementing sequence', async () => {
      const entry = createCommitEntry();
      const result = await service.appendCommit(entry);

      expect(result.success).toBe(true);
      expect(result.sequenceNumber).toBe(1);
      expect(result.hash).toBeDefined();
      expect(result.hash!.length).toBeGreaterThan(0);
    });

    it('should increment sequence numbers', async () => {
      const r1 = await service.appendCommit(createCommitEntry());
      const r2 = await service.appendCommit(createCommitEntry());
      const r3 = await service.appendCommit(createCommitEntry());

      expect(r1.sequenceNumber).toBe(1);
      expect(r2.sequenceNumber).toBe(2);
      expect(r3.sequenceNumber).toBe(3);
    });

    it('should save commit entry and state to disk', async () => {
      await service.appendCommit(createCommitEntry());

      // writeFile called for commit entry + state save
      expect(fsPromises.writeFile).toHaveBeenCalled();
    });

    it('should update statistics after append', async () => {
      await service.appendCommit(createCommitEntry());
      const stats = service.getStatistics();

      expect(stats.totalEntries).toBe(1);
      expect(stats.pendingEntries).toBe(1);
    });

    it('should add to pending status list for PENDING entries', async () => {
      await service.appendCommit(createCommitEntry({ status: CommitStatus.PENDING }));
      const state = service.getState();
      expect(state.entriesByStatus.pending).toContain(1);
    });

    it('should fail if lock cannot be acquired', async () => {
      // Simulate existing lock file
      (existsSync as any).mockReturnValue(true);

      const result = await service.appendCommit(createCommitEntry());
      expect(result.success).toBe(false);
      expect(result.error).toContain('lock');
    });
  });

  // === getCommit ===

  describe('getCommit', () => {
    it('should retrieve committed entry from memory', async () => {
      await service.appendCommit(createCommitEntry());
      const entry = await service.getCommit(1);

      expect(entry).not.toBeNull();
      expect(entry!.sequenceNumber).toBe(1);
      expect(entry!.type).toBe(CommitEntryType.CONFIG);
    });

    it('should return null for non-existent entry', async () => {
      const entry = await service.getCommit(999);
      expect(entry).toBeNull();
    });

    it('should try loading from disk if not in memory', async () => {
      // Create a fresh service, entry not in memory
      const freshService = new CommitLogService({ commitLogPath: '/tmp/test2' });
      await freshService.waitForInitialization();

      (fsPromises.readFile as any).mockResolvedValueOnce(JSON.stringify({
        sequenceNumber: 5,
        type: CommitEntryType.HEARTBEAT,
        machineId: 'disk-machine',
        timestamp: '2026-01-01T00:00:00Z',
        status: CommitStatus.APPLIED,
        data: { status: 'online' },
        hash: 'abc123',
      }));

      const entry = await freshService.getCommit(5);
      expect(entry).not.toBeNull();
      expect(entry!.machineId).toBe('disk-machine');
    });
  });

  // === getLatestCommits ===

  describe('getLatestCommits', () => {
    it('should return latest N commits sorted descending', async () => {
      await service.appendCommit(createCommitEntry({ machineId: 'first' }));
      await service.appendCommit(createCommitEntry({ machineId: 'second' }));
      await service.appendCommit(createCommitEntry({ machineId: 'third' }));

      const result = await service.getLatestCommits(2);
      expect(result.entries).toHaveLength(2);
      expect(result.entries[0].sequenceNumber).toBe(3);
      expect(result.entries[1].sequenceNumber).toBe(2);
      expect(result.totalCount).toBe(3);
      expect(result.hasMore).toBe(true);
    });

    it('should return all if count exceeds total', async () => {
      await service.appendCommit(createCommitEntry());
      const result = await service.getLatestCommits(10);
      expect(result.entries).toHaveLength(1);
      expect(result.hasMore).toBe(false);
    });
  });

  // === getCommitsSince ===

  describe('getCommitsSince', () => {
    it('should return entries since a timestamp', async () => {
      await service.appendCommit(createCommitEntry());
      // The entry was created just now, so searching from 1 hour ago should find it
      const hourAgo = new Date(Date.now() - 3600000).toISOString();
      const result = await service.getCommitsSince(hourAgo);

      expect(result.entries.length).toBeGreaterThanOrEqual(1);
    });

    it('should return empty for future timestamp', async () => {
      await service.appendCommit(createCommitEntry());
      const future = new Date(Date.now() + 86400000).toISOString();
      const result = await service.getCommitsSince(future);

      expect(result.entries).toHaveLength(0);
    });
  });

  // === getPendingCommits ===

  describe('getPendingCommits', () => {
    it('should return only pending commits', async () => {
      await service.appendCommit(createCommitEntry({ status: CommitStatus.PENDING }));
      await service.appendCommit(createCommitEntry({ status: CommitStatus.APPLIED }));

      const pending = await service.getPendingCommits();
      expect(pending).toHaveLength(1);
      expect(pending[0].status).toBe(CommitStatus.PENDING);
    });

    it('should return sorted by sequence number', async () => {
      await service.appendCommit(createCommitEntry({ status: CommitStatus.PENDING }));
      await service.appendCommit(createCommitEntry({ status: CommitStatus.PENDING }));

      const pending = await service.getPendingCommits();
      expect(pending[0].sequenceNumber).toBeLessThan(pending[1].sequenceNumber);
    });
  });

  // === applyCommit ===

  describe('applyCommit', () => {
    it('should apply a pending commit', async () => {
      await service.appendCommit(createCommitEntry({ status: CommitStatus.PENDING }));

      // Reset mock so lock file doesn't exist
      (existsSync as any).mockReturnValue(false);

      const result = await service.applyCommit(1);
      expect(result.success).toBe(true);
      expect(result.sequenceNumber).toBe(1);
      expect(result.appliedAt).toBeDefined();
    });

    it('should move entry from pending to applied status', async () => {
      await service.appendCommit(createCommitEntry({ status: CommitStatus.PENDING }));
      (existsSync as any).mockReturnValue(false);

      await service.applyCommit(1);

      const state = service.getState();
      expect(state.entriesByStatus.pending).not.toContain(1);
      expect(state.entriesByStatus.applied).toContain(1);
    });

    it('should fail for non-existent entry', async () => {
      (existsSync as any).mockReturnValue(false);
      const result = await service.applyCommit(999);
      expect(result.success).toBe(false);
      expect(result.error).toContain('non trouvée');
    });

    it('should fail for non-pending entry', async () => {
      await service.appendCommit(createCommitEntry({ status: CommitStatus.APPLIED }));
      (existsSync as any).mockReturnValue(false);

      const result = await service.applyCommit(1);
      expect(result.success).toBe(false);
      expect(result.error).toContain('pas en attente');
    });

    it('should fail if lock cannot be acquired', async () => {
      await service.appendCommit(createCommitEntry({ status: CommitStatus.PENDING }));
      // Simulate lock exists
      (existsSync as any).mockReturnValue(true);

      const result = await service.applyCommit(1);
      expect(result.success).toBe(false);
      expect(result.error).toContain('lock');
    });
  });

  // === applyPendingCommits ===

  describe('applyPendingCommits', () => {
    it('should apply all pending commits', async () => {
      await service.appendCommit(createCommitEntry({ status: CommitStatus.PENDING }));
      await service.appendCommit(createCommitEntry({ status: CommitStatus.PENDING }));

      (existsSync as any).mockReturnValue(false);
      const results = await service.applyPendingCommits();

      expect(results).toHaveLength(2);
      expect(results.every(r => r.success)).toBe(true);
    });
  });

  // === rollbackCommit ===

  describe('rollbackCommit', () => {
    it('should rollback a commit', async () => {
      await service.appendCommit(createCommitEntry({ status: CommitStatus.PENDING }));
      (existsSync as any).mockReturnValue(false);

      const result = await service.rollbackCommit(1, 'test rollback');
      expect(result).toBe(true);

      const entry = await service.getCommit(1);
      expect(entry!.status).toBe(CommitStatus.ROLLED_BACK);
    });

    it('should move entry to rolledBack status list', async () => {
      await service.appendCommit(createCommitEntry({ status: CommitStatus.PENDING }));
      (existsSync as any).mockReturnValue(false);

      await service.rollbackCommit(1, 'reason');

      const state = service.getState();
      expect(state.entriesByStatus.rolledBack).toContain(1);
      expect(state.entriesByStatus.pending).not.toContain(1);
    });

    it('should return false for non-existent entry', async () => {
      (existsSync as any).mockReturnValue(false);
      const result = await service.rollbackCommit(999, 'reason');
      expect(result).toBe(false);
    });

    it('should return false if lock not acquired', async () => {
      (existsSync as any).mockReturnValue(true);
      const result = await service.rollbackCommit(1, 'reason');
      expect(result).toBe(false);
    });
  });

  // === verifyConsistency ===

  describe('verifyConsistency', () => {
    it('should report consistent for empty log', async () => {
      const result = await service.verifyConsistency();
      expect(result.isConsistent).toBe(true);
      expect(result.inconsistentEntries).toHaveLength(0);
      expect(result.statistics.consistencyRate).toBe(1.0);
    });

    it('should report consistent for valid sequential entries', async () => {
      await service.appendCommit(createCommitEntry());
      await service.appendCommit(createCommitEntry());

      const result = await service.verifyConsistency();
      expect(result.isConsistent).toBe(true);
    });

    it('should detect sequence number gaps', async () => {
      // Manually inject entries with a gap
      const internalState = service._getInternalState();
      internalState.entries.set(1, {
        sequenceNumber: 1,
        type: CommitEntryType.CONFIG,
        machineId: 'test',
        timestamp: new Date().toISOString(),
        status: CommitStatus.APPLIED,
        data: { configPath: '/x', changeType: 'update' as const },
        hash: 'abc',
      });
      internalState.entries.set(3, {
        sequenceNumber: 3,
        type: CommitEntryType.CONFIG,
        machineId: 'test',
        timestamp: new Date().toISOString(),
        status: CommitStatus.APPLIED,
        data: { configPath: '/y', changeType: 'update' as const },
        hash: 'def',
      });
      internalState.currentSequenceNumber = 3;

      const result = await service.verifyConsistency();
      expect(result.isConsistent).toBe(false);
      expect(result.inconsistentEntries.length).toBeGreaterThan(0);
    });

    it('should detect hash inconsistencies', async () => {
      await service.appendCommit(createCommitEntry());

      // Tamper with the hash
      const internalState = service._getInternalState();
      const entry = internalState.entries.get(1)!;
      entry.hash = 'tampered-hash';

      const result = await service.verifyConsistency();
      expect(result.isConsistent).toBe(false);
      expect(result.inconsistentEntries.some(e => e.issue.includes('Hash'))).toBe(true);
    });
  });

  // === compressOldEntries ===

  describe('compressOldEntries', () => {
    it('should return 0 when compression disabled', async () => {
      const noCompressService = new CommitLogService({
        commitLogPath: '/tmp/no-compress',
        enableCompression: false,
      });
      await noCompressService.waitForInitialization();

      const count = await noCompressService.compressOldEntries();
      expect(count).toBe(0);
    });

    it('should return 0 for fresh entries (not yet compressed)', async () => {
      await service.appendCommit(createCommitEntry());
      const count = await service.compressOldEntries();
      // Currently returns 0 (TODO in source)
      expect(count).toBe(0);
    });
  });

  // === cleanupFailedEntries ===

  describe('cleanupFailedEntries', () => {
    it('should remove failed entries exceeding max retries', async () => {
      // Manually add a failed entry with high retry count
      const internalState = service._getInternalState();
      internalState.entries.set(1, {
        sequenceNumber: 1,
        type: CommitEntryType.CONFIG,
        machineId: 'test',
        timestamp: new Date().toISOString(),
        status: CommitStatus.FAILED,
        data: { configPath: '/x', changeType: 'update' as const },
        hash: 'abc',
        metadata: { retryCount: 5 },
      });
      internalState.entriesByStatus.failed.push(1);
      internalState.currentSequenceNumber = 1;

      const removed = await service.cleanupFailedEntries();
      expect(removed).toBe(1);
      expect(internalState.entries.has(1)).toBe(false);
    });

    it('should not remove failed entries under max retries', async () => {
      const internalState = service._getInternalState();
      internalState.entries.set(1, {
        sequenceNumber: 1,
        type: CommitEntryType.CONFIG,
        machineId: 'test',
        timestamp: new Date().toISOString(),
        status: CommitStatus.FAILED,
        data: { configPath: '/x', changeType: 'update' as const },
        hash: 'abc',
        metadata: { retryCount: 1 },
      });
      internalState.entriesByStatus.failed.push(1);

      const removed = await service.cleanupFailedEntries();
      expect(removed).toBe(0);
    });
  });

  // === Auto Sync ===

  describe('autoSync', () => {
    it('should start and stop auto sync', async () => {
      vi.useFakeTimers();

      await service.startAutoSync();
      // Calling start again should warn but not throw
      await service.startAutoSync();

      await service.stopAutoSync();

      vi.useRealTimers();
    });

    it('should stop auto sync when not started', async () => {
      // Should not throw
      await service.stopAutoSync();
    });
  });

  // === getState / getStatistics ===

  describe('getState', () => {
    it('should return a copy of state', () => {
      const state = service.getState();
      expect(state.currentSequenceNumber).toBe(0);
      expect(state.metadata.version).toBe('1.0.0');
    });

    it('should return statistics', () => {
      const stats = service.getStatistics();
      expect(stats.totalEntries).toBe(0);
      expect(stats.pendingEntries).toBe(0);
    });
  });

  // === resetCommitLog ===

  describe('resetCommitLog', () => {
    it('should throw without confirmation', async () => {
      await expect(service.resetCommitLog(false)).rejects.toThrow('Confirmation requise');
    });

    it('should reset all state with confirmation', async () => {
      await service.appendCommit(createCommitEntry());
      (existsSync as any).mockReturnValue(false);
      (fsPromises.readdir as any).mockResolvedValue(['0000001.json', 'state.json']);

      await service.resetCommitLog(true);

      const state = service.getState();
      expect(state.currentSequenceNumber).toBe(0);
      expect(state.entries.size).toBe(0);
      expect(state.statistics.totalEntries).toBe(0);
    });

    it('should fail if lock cannot be acquired', async () => {
      (existsSync as any).mockReturnValue(true);
      await expect(service.resetCommitLog(true)).rejects.toThrow('lock');
    });
  });

  // === CommitLogServiceError ===

  describe('CommitLogServiceError', () => {
    it('should create error with code', () => {
      const error = new CommitLogServiceError('test error', 'TEST_CODE');
      expect(error.message).toContain('test error');
      expect(error.code).toBe('TEST_CODE');
      expect(error.name).toBe('CommitLogServiceError');
    });
  });
});
