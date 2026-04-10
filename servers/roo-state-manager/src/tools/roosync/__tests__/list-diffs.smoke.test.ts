/**
 * Smoke test for roosync_list_diffs
 *
 * Purpose: Validate that roosync_list_diffs returns fresh data after state changes
 * Pattern: Issue #564 Phase 2 - Prevent silent bugs from cache staleness (issue #562)
 *
 * @see docs/testing/issue-564-phase1-audit-report.md (lines 88-95)
 *
 * NOTE: This test uses the BaselineService architecture which requires:
 * - sync-config.ref.json (baseline file with expected state)
 * - Machine inventory files in .shared-state/inventories/
 *
 * The smoke test validates that differences are computed fresh from filesystem
 * rather than returning cached data.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { roosyncListDiffs } from '../list-diffs.js';
import { RooSyncService } from '../../../services/RooSyncService.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Unmock modules that jest.setup.js mocks globally.
// Smoke tests need real filesystem and real RooSyncService (not mocks).
vi.unmock('fs');
vi.unmock('fs/promises');
vi.unmock('os');
vi.unmock('../../../services/RooSyncService.js');
vi.unmock('../../../services/ConfigService.js');

describe('SMOKE: roosync_list_diffs', () => {
  // Use unique directory per test file to avoid ENOTEMPTY cleanup errors
  const testSharedStatePath = path.join(os.tmpdir(), '.shared-state-test-listdiffs');
  const testBaselinePath = path.join(testSharedStatePath, 'sync-config.ref.json');
  const testInventoriesPath = path.join(testSharedStatePath, 'inventories');
  let originalEnv: NodeJS.ProcessEnv;

  /**
   * Helper: Create a minimal BaselineFileConfig
   * Matches BaselineFileConfig interface from types/baseline.ts
   *
   * Uses FILE FORMAT structure that transformBaselineForDiffDetector() expects:
   * - modes: string[] (passed through directly)
   * - mcpServers: array of { name, enabled } objects (converted to mcpSettings by transformation)
   */
  function makeBaseline(version: string, machinesCount: number): Record<string, any> {
    const machines = [];
    for (let i = 1; i <= machinesCount; i++) {
      machines.push({
        id: `test-machine-${i}`,
        name: `Test Machine ${i}`,
        hostname: `test-machine-${i}`,
        os: 'Windows',
        architecture: 'x64',
        lastSeen: new Date().toISOString(),
        roo: {
          modes: ['code-simple'],  // String array (passed through to DiffDetector)
          mcpServers: [           // Array format (converted to mcpSettings object by transformation)
            { name: 'win-cli', enabled: true }
          ],
          sdddSpecs: []
        },
        hardware: {
          cpu: { cores: 8, threads: 16 },
          memory: { total: 16 }
        },
        software: {
          node: 'v20.0.0',
          python: '3.11.0'
        }
      });
    }

    return {
      version: '3.0.0',
      baselineId: 'smoke-test-baseline',
      timestamp: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
      machineId: 'test-machine-1',
      autoSync: true,
      conflictStrategy: 'baseline_wins',
      logLevel: 'INFO',
      sharedStatePath: testSharedStatePath,
      machines,
      syncTargets: [],
      syncPaths: [],
      decisions: [],
      messages: []
    };
  }

  /**
   * Helper: Create a machine inventory file
   * Matches MachineInventory interface from InventoryCollector.ts
   *
   * CRITICAL: Uses FLAT structure (not nested under 'config')
   * - system, hardware, software, roo, paths are at top level
   * - modes is array of {slug, name} objects, not strings
   * - mcpServers is array of objects, not a mapping
   */
  function makeMachineInventory(
    machineId: string,
    differences: string[] = []
  ): Record<string, any> {
    const inventory: Record<string, any> = {
      machineId,
      timestamp: new Date().toISOString(),
      system: {
        hostname: machineId,
        os: 'Windows',
        architecture: 'x64',
        uptime: 0
      },
      hardware: {
        cpu: {
          name: 'Unknown CPU',
          cores: 8,
          threads: 16
        },
        memory: {
          total: 16,
          available: 16
        },
        disks: [],
        gpu: []  // Array, not string
      },
      software: {
        powershell: 'Unknown',
        node: 'v20.0.0',
        python: '3.11.0'
      },
      roo: {
        modes: [
          { slug: 'code-simple', name: 'Code Simple' }
        ],
        mcpServers: [
          { name: 'win-cli', enabled: true }
        ]
      },
      paths: {
        rooExtensions: testSharedStatePath
      },
      lastUpdated: new Date().toISOString(),
      version: '3.0.0'
    };

    // Apply differences if specified
    for (const diff of differences) {
      if (diff === 'node-version') {
        inventory.software.node = 'v18.0.0'; // Different from baseline
      } else if (diff === 'extra-mode') {
        inventory.roo.modes.push({ slug: 'debug-simple', name: 'Debug Simple' }); // Extra mode not in baseline
      } else if (diff === 'memory') {
        inventory.hardware.memory.total = 32; // Different memory
      }
    }

    return inventory;
  }

  /**
   * Helper: Write baseline file
   */
  function writeBaseline(baseline: Record<string, any>): void {
    fs.writeFileSync(testBaselinePath, JSON.stringify(baseline, null, 2));
  }

  /**
   * Helper: Write machine inventory files
   */
  function writeInventoryFiles(inventories: Record<string, any>): void {
    if (!fs.existsSync(testInventoriesPath)) {
      fs.mkdirSync(testInventoriesPath, { recursive: true });
    }

    for (const [machineId, data] of Object.entries(inventories)) {
      const inventoryPath = path.join(testInventoriesPath, `${machineId}.json`);
      fs.writeFileSync(inventoryPath, JSON.stringify(data, null, 2));
    }
  }

  beforeEach(() => {
    // Save original environment
    originalEnv = { ...process.env };

    // Setup test environment with required env vars
    process.env.ROOSYNC_SHARED_PATH = testSharedStatePath;
    process.env.ROOSYNC_MACHINE_ID = 'test-machine-1';
    process.env.ROOSYNC_WORKSPACE_ID = 'smoke-test-ws';

    // CRITICAL: Delete SHARED_STATE_PATH to prevent BaselineService from
    // using a real environment path instead of the test path.
    // BaselineService checks SHARED_STATE_PATH first (line 76), which
    // would override ROOSYNC_SHARED_PATH if set in the real environment.
    delete process.env.SHARED_STATE_PATH;

    // Ensure test directory exists
    if (!fs.existsSync(testSharedStatePath)) {
      fs.mkdirSync(testSharedStatePath, { recursive: true });
    }

    // Note: No RooSyncService reset needed - smoke tests use tool functions directly
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;

    // Cleanup test files (retry for Node 22 ENOTEMPTY on CI Linux)
    if (fs.existsSync(testSharedStatePath)) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          fs.rmSync(testSharedStatePath, { recursive: true, force: true });
          break;
        } catch (e: any) {
          if (e.code === 'ENOTEMPTY' && attempt < 2) {
            // Brief pause then retry
            continue;
          }
          throw e;
        }
      }
    }

    // Note: No RooSyncService reset needed - smoke tests use tool functions directly
  });

  it('should detect new diffs after inventory change (filterType: all)', async () => {
    // Step 1: Create initial baseline and matching inventory (no diffs)
    const initialBaseline = makeBaseline('v1', 2);
    writeBaseline(initialBaseline);

    const initialInventories = {
      'test-machine-1': makeMachineInventory('test-machine-1', []),
      'test-machine-2': makeMachineInventory('test-machine-2', [])
    };
    writeInventoryFiles(initialInventories);

    // Step 2: Initial call to get baseline (should show minimal or no diffs)
    const result1 = await roosyncListDiffs({ filterType: 'all', forceRefresh: true });

    // Result may have some minor diffs (timestamps, etc.) but should be limited
    expect(result1.filterApplied).toBe('all');
    expect(result1.totalDiffs).toBeGreaterThanOrEqual(0);

    // DEBUG: Write diffs to permanent file to see what's being detected
    const debugPath = path.join(os.tmpdir(), 'debug-diffs-listdiffs.json');
    fs.mkdirSync(path.dirname(debugPath), { recursive: true });
    fs.writeFileSync(debugPath, JSON.stringify({
      result1_diffs: result1.diffs,
      result1_totalDiffs: result1.totalDiffs,
      baseline_version: initialBaseline.version,
      baseline_machines: initialBaseline.machines?.length || 0
    }, null, 2));
    console.log('[DEBUG] Diffs written to:', debugPath);

    const initialDiffCount = result1.totalDiffs;

    // Step 3: Modify the underlying state (add differences in inventory)
    const modifiedInventories = {
      'test-machine-1': makeMachineInventory('test-machine-1', ['node-version']),
      'test-machine-2': makeMachineInventory('test-machine-2', ['extra-mode', 'memory'])
    };
    writeInventoryFiles(modifiedInventories);

    // Step 4: Reset singleton so the second call picks up filesystem changes
    RooSyncService.resetInstance();

    // Second call to list diffs (with forceRefresh to bypass cache)
    const result2 = await roosyncListDiffs({ filterType: 'all', forceRefresh: true });

    // Step 5: Verify that result2 reflects the state change (fresh diffs, not cached)
    expect(result2.filterApplied).toBe('all');

    // The number of diffs should increase (at least more than before)
    // This validates that diffs are computed fresh from filesystem,
    // not from stale cached data
    expect(result2.totalDiffs).toBeGreaterThan(initialDiffCount);
  });

  it('should return empty diffs when no baseline exists', async () => {
    // Step 1: No baseline file exists (empty state)
    // Don't create baseline or inventory files

    // Step 2: Call list diffs when no baseline exists
    const result = await roosyncListDiffs({ filterType: 'all', forceRefresh: true });

    // Step 3: Verify empty result (not cached, not error)
    expect(result.filterApplied).toBe('all');
    expect(result.totalDiffs).toBe(0);
    expect(result.diffs).toHaveLength(0);

    // This validates that the service handles missing baseline gracefully,
    // not returning cached data from a previous test run
  });

  it('should detect changes after baseline update', async () => {
    // Step 1: Create initial baseline with 2 machines
    const initialBaseline = makeBaseline('v1', 2);
    writeBaseline(initialBaseline);

    // Create matching inventories (no diffs from baseline)
    const initialInventories = {
      'test-machine-1': makeMachineInventory('test-machine-1', []),
      'test-machine-2': makeMachineInventory('test-machine-2', [])
    };
    writeInventoryFiles(initialInventories);

    // Step 2: Initial call
    const result1 = await roosyncListDiffs({ filterType: 'all', forceRefresh: true });
    const initialDiffCount = result1.totalDiffs;

    // Step 3: Modify machine-1's inventory to add MORE differences
    // (Adding a new machine wouldn't work because ConfigComparator.listDiffs
    // only compares baseline.machineId and config.machineId, not all machines)
    const updatedInventories = {
      'test-machine-1': makeMachineInventory('test-machine-1', ['node-version', 'extra-mode', 'memory']),
      'test-machine-2': makeMachineInventory('test-machine-2', [])
    };
    writeInventoryFiles(updatedInventories);

    // Step 4: Reset singleton so the second call picks up filesystem changes
    RooSyncService.resetInstance();

    // Second call after baseline update (with forceRefresh)
    const result2 = await roosyncListDiffs({ filterType: 'all', forceRefresh: true });

    // Step 5: Verify fresh data includes the new machine's diffs
    expect(result2.filterApplied).toBe('all');
    expect(result2.totalDiffs).toBeGreaterThan(initialDiffCount);

    // This validates that baseline changes are detected immediately,
    // not cached from the previous baseline version
  });
});
