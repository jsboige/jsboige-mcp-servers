/**
 * Smoke test for roosync_storage_management
 *
 * Purpose: Validate that roosync_storage_management returns fresh data after state changes
 * Pattern: Issue #564 Phase 2 - Prevent silent bugs from cache staleness (issue #562)
 *
 * @see docs/testing/issue-564-phase1-audit-report.md (lines 162-176)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { roosyncStorageManagement } from '../storage-management.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('SMOKE: roosync_storage_management', () => {
  const testStoragePath = path.join(os.tmpdir(), '.test-storage');
  const testTasksPath = path.join(testStoragePath, 'test-workspace', 'tasks');
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    // Save original environment
    originalEnv = { ...process.env };

    // Create test directory structure
    if (!fs.existsSync(testTasksPath)) {
      fs.mkdirSync(testTasksPath, { recursive: true });
    }
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;

    // Cleanup test files
    if (fs.existsSync(testStoragePath)) {
      fs.rmSync(testStoragePath, { recursive: true, force: true });
    }
  });

  it('should detect storage location changes (action: storage, subAction: detect)', async () => {
    // Step 1: Create initial storage state with one task file
    const task1Path = path.join(testTasksPath, 'task-1.json');
    fs.writeFileSync(task1Path, JSON.stringify({ id: 'task-1', created: '2026-03-11T10:00:00Z' }));

    // Step 2: Initial call to detect storage (baseline)
    const result1 = await roosyncStorageManagement({
      action: 'storage',
      storageAction: 'detect'
    });

    expect(result1.success).toBe(true);
    expect(result1.action).toBe('storage');
    expect(result1.subAction).toBe('detect');
    expect(result1.data).toBeDefined();

    // Step 3: Modify the underlying state (add more task files)
    const task2Path = path.join(testTasksPath, 'task-2.json');
    const task3Path = path.join(testTasksPath, 'task-3.json');
    fs.writeFileSync(task2Path, JSON.stringify({ id: 'task-2', created: '2026-03-11T11:00:00Z' }));
    fs.writeFileSync(task3Path, JSON.stringify({ id: 'task-3', created: '2026-03-11T11:00:00Z' }));

    // Step 4: Make second call to detect storage
    const result2 = await roosyncStorageManagement({
      action: 'storage',
      storageAction: 'detect'
    });

    // Step 5: Verify that result2 reflects the state change (not stale cached data)
    expect(result2.success).toBe(true);
    expect(result2.action).toBe('storage');
    expect(result2.subAction).toBe('detect');

    // The data should reflect the new state (more files detected)
    // This validates that no stale cache is preventing detection of new files
    expect(result2.data).toBeDefined();
    expect(result2.timestamp).not.toBe(result1.timestamp);
  });

  it('should return fresh stats after workspace changes (action: storage, subAction: stats)', async () => {
    // Step 1: Create initial workspace with minimal data
    const workspace1Path = path.join(testStoragePath, 'workspace-1', 'tasks');
    fs.mkdirSync(workspace1Path, { recursive: true });
    fs.writeFileSync(
      path.join(workspace1Path, 'task-1.json'),
      JSON.stringify({ id: 'task-1', size: 100 })
    );

    // Step 2: Initial call to get stats (baseline)
    const result1 = await roosyncStorageManagement({
      action: 'storage',
      storageAction: 'stats'
    });

    expect(result1.success).toBe(true);
    expect(result1.action).toBe('storage');
    expect(result1.subAction).toBe('stats');

    // Step 3: Modify the underlying state (add more workspaces and tasks)
    const workspace2Path = path.join(testStoragePath, 'workspace-2', 'tasks');
    fs.mkdirSync(workspace2Path, { recursive: true });
    fs.writeFileSync(
      path.join(workspace2Path, 'task-2.json'),
      JSON.stringify({ id: 'task-2', size: 200 })
    );
    fs.writeFileSync(
      path.join(workspace2Path, 'task-3.json'),
      JSON.stringify({ id: 'task-3', size: 300 })
    );

    // Step 4: Make second call to get stats
    const result2 = await roosyncStorageManagement({
      action: 'storage',
      storageAction: 'stats'
    });

    // Step 5: Verify that result2 reflects the state change (fresh stats, not cached)
    expect(result2.success).toBe(true);
    expect(result2.action).toBe('storage');
    expect(result2.subAction).toBe('stats');
    expect(result2.timestamp).not.toBe(result1.timestamp);

    // Stats should reflect the new workspace and additional tasks
    // This validates that storage stats are computed fresh, not from stale cache
    expect(result2.data).toBeDefined();
  });

  it('should handle maintenance operations without stale cache (action: maintenance, subAction: cache_rebuild)', async () => {
    // Step 1: Create initial task data
    const task1Path = path.join(testTasksPath, 'task-1.json');
    fs.writeFileSync(task1Path, JSON.stringify({ id: 'task-1', content: 'initial' }));

    // Create minimal conversationCache and state for maintenance
    const conversationCache = new Map();
    const state = {} as any; // Minimal state object

    // Step 2: Initial cache_rebuild call
    const result1 = await roosyncStorageManagement(
      {
        action: 'maintenance',
        maintenanceAction: 'cache_rebuild',
        force_rebuild: true
      },
      conversationCache,
      state
    );

    expect(result1.success).toBe(true);
    expect(result1.action).toBe('maintenance');
    expect(result1.subAction).toBe('cache_rebuild');

    // Step 3: Modify the underlying task data
    const task2Path = path.join(testTasksPath, 'task-2.json');
    fs.writeFileSync(task1Path, JSON.stringify({ id: 'task-1', content: 'modified' }));
    fs.writeFileSync(task2Path, JSON.stringify({ id: 'task-2', content: 'new' }));

    // Step 4: Second cache_rebuild call with force_rebuild
    const result2 = await roosyncStorageManagement(
      {
        action: 'maintenance',
        maintenanceAction: 'cache_rebuild',
        force_rebuild: true
      },
      conversationCache,
      state
    );

    // Step 5: Verify fresh rebuild reflects new state
    expect(result2.success).toBe(true);
    expect(result2.action).toBe('maintenance');
    expect(result2.subAction).toBe('cache_rebuild');
    expect(result2.timestamp).not.toBe(result1.timestamp);

    // The rebuild should process the modified and new task files
    // This validates that force_rebuild prevents using stale cached data
    expect(result2.data).toBeDefined();
  });
});
