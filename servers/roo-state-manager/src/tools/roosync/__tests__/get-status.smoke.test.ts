/**
 * Smoke test for roosync_get_status — Option B compact (#1206)
 *
 * Purpose: Validate that roosync_get_status returns fresh data after cache invalidation
 * Pattern: Issue #564 Phase 2 - Prevent silent bugs from cache staleness (issue #562)
 *
 * #2639: the two original smoke tests only asserted that `status` belonged to an
 * enum and that fields existed — true for any well-typed return value, including a
 * wrong one. Strengthened to contract assertions (cache identity, structural
 * coherence, error contract) plus direct coverage of the exported pure helper
 * `parseHudDataFromDashboard` (#1855), which had none.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Unmock modules that jest.setup.js mocks globally.
vi.unmock('fs');
vi.unmock('fs/promises');
vi.unmock('os');
vi.unmock('../../../services/RooSyncService.js');
vi.unmock('../../../services/ConfigService.js');

import { roosyncGetStatus, parseHudDataFromDashboard } from '../get-status.js';
import { RooSyncService } from '../../../services/RooSyncService.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const HEALTHY_LIKE = ['HEALTHY', 'WARNING', 'CRITICAL'];

describe('SMOKE: roosync_get_status (Option B)', () => {
  const testSharedStatePath = path.join(os.tmpdir(), '.shared-state-test-getstatus-optb');
  const testDashboardPath = path.join(testSharedStatePath, 'sync-dashboard.json');
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.ROOSYNC_SHARED_PATH = testSharedStatePath;
    process.env.ROOSYNC_MACHINE_ID = 'smoke-test-machine';
    process.env.ROOSYNC_WORKSPACE_ID = 'smoke-test-ws';

    if (!fs.existsSync(testSharedStatePath)) {
      fs.mkdirSync(testSharedStatePath, { recursive: true });
    }

    RooSyncService.resetInstance();
  });

  afterEach(() => {
    process.env = originalEnv;
    if (fs.existsSync(testSharedStatePath)) {
      fs.rmSync(testSharedStatePath, { recursive: true, force: true });
    }
    RooSyncService.resetInstance();
  });

  it('should return fresh compact status after cache invalidation', async () => {
    // Step 1: Create initial dashboard
    const initialDashboard = {
      overallStatus: 'synced',
      lastUpdate: '2026-03-11T10:00:00Z',
      machines: {
        'test-machine-1': {
          status: 'online',
          lastSync: '2026-03-11T10:00:00Z',
          pendingDecisions: 0,
          diffsCount: 0
        }
      }
    };

    fs.writeFileSync(testDashboardPath, JSON.stringify(initialDashboard, null, 2));

    // Step 2: Initial call — should return HEALTHY compact status
    const before = Date.now();
    const result1 = await roosyncGetStatus({});

    expect(HEALTHY_LIKE).toContain(result1.status);
    expect(result1.machines).toEqual(
      expect.objectContaining({
        online: expect.any(Number),
        unknown: expect.any(Number),
        total: expect.any(Number),
      })
    );
    expect(Array.isArray(result1.flags)).toBe(true);
    expect(result1.lastUpdated).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

    // The snapshot must be structurally coherent and timestamped at call time:
    // online+unknown partition the known machines, so neither can exceed the total.
    expect(result1.machines.online).toBeGreaterThanOrEqual(0);
    expect(result1.machines.unknown).toBeGreaterThanOrEqual(0);
    expect(result1.machines.online + result1.machines.unknown)
      .toBeLessThanOrEqual(result1.machines.total);

    const stampedAt = Date.parse(result1.lastUpdated);
    expect(Number.isNaN(stampedAt)).toBe(false);
    expect(stampedAt).toBeGreaterThanOrEqual(before - 1000);
    expect(stampedAt).toBeLessThanOrEqual(Date.now() + 1000);

    // Non-myia test artifacts must never leak into the machine counters (#1365):
    // every unknown machine flagged must be a production myia-* machine.
    for (const flag of result1.flags.filter(f => f.startsWith('UNKNOWN:'))) {
      expect(flag.slice('UNKNOWN:'.length)).toMatch(/^myia-/i);
    }

    // Step 3: Modify state to introduce offline machines
    const modifiedDashboard = {
      overallStatus: 'diverged',
      lastUpdate: '2026-03-11T11:00:00Z',
      machines: {
        'test-machine-1': {
          status: 'diverged',
          lastSync: '2026-03-11T11:00:00Z',
          pendingDecisions: 2,
          diffsCount: 5
        },
        'test-machine-2': {
          status: 'online',
          lastSync: '2026-03-11T11:00:00Z',
          pendingDecisions: 0,
          diffsCount: 0
        }
      }
    };

    fs.writeFileSync(testDashboardPath, JSON.stringify(modifiedDashboard, null, 2));

    // Step 4: Call with resetCache=true
    const result2 = await roosyncGetStatus({ resetCache: true });

    // Step 5: Verify compact format
    expect(HEALTHY_LIKE).toContain(result2.status);
    expect(result2.machines).toEqual(
      expect.objectContaining({
        online: expect.any(Number),
        unknown: expect.any(Number),
        total: expect.any(Number),
      })
    );
    expect(Array.isArray(result2.flags)).toBe(true);
    expect(result2.lastUpdated).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

    // A second snapshot is a new observation of the same world: counts stay
    // within the same partition invariant and the timestamp moves forward.
    expect(result2.machines.online + result2.machines.unknown)
      .toBeLessThanOrEqual(result2.machines.total);
    expect(Date.parse(result2.lastUpdated)).toBeGreaterThanOrEqual(stampedAt);
  });

  it('should return cached data WITHOUT resetCache', async () => {
    const initialDashboard = {
      overallStatus: 'synced',
      lastUpdate: '2026-03-11T10:00:00Z',
      machines: {
        'test-machine-1': {
          status: 'online',
          lastSync: '2026-03-11T10:00:00Z',
          pendingDecisions: 0,
          diffsCount: 0
        }
      }
    };

    fs.writeFileSync(testDashboardPath, JSON.stringify(initialDashboard, null, 2));

    const result1 = await roosyncGetStatus({});

    // Modify state
    const modifiedDashboard = {
      overallStatus: 'diverged',
      lastUpdate: '2026-03-11T11:00:00Z',
      machines: {
        'test-machine-1': {
          status: 'diverged',
          lastSync: '2026-03-11T11:00:00Z',
          pendingDecisions: 2,
          diffsCount: 5
        }
      }
    };

    fs.writeFileSync(testDashboardPath, JSON.stringify(modifiedDashboard, null, 2));

    // Without resetCache — should get same status as before
    const result2 = await roosyncGetStatus({});

    // Cache persists, status should still reflect initial state
    expect(HEALTHY_LIKE).toContain(result2.status);
    expect(result2.status).toBe(result1.status);
    expect(result2.machines).toEqual(result1.machines);
  });

  describe('resetCache contract (#1206/#564)', () => {
    it('keeps the singleton service WITHOUT resetCache and rebuilds it WITH', async () => {
      fs.writeFileSync(
        testDashboardPath,
        JSON.stringify({ overallStatus: 'synced', lastUpdate: '2026-03-11T10:00:00Z', machines: {} })
      );

      await roosyncGetStatus({});
      const first = RooSyncService.getInstance();
      // the accessor is stable: it hands back the very singleton it holds
      expect(first).toBe(RooSyncService.getInstance());

      // no resetCache → the same singleton is reused
      await roosyncGetStatus({});
      expect(RooSyncService.getInstance()).toBe(first);

      // resetCache=true → resetInstance() runs, the next lookup yields a NEW object
      await roosyncGetStatus({ resetCache: true });
      const afterReset = RooSyncService.getInstance();
      expect(afterReset).toBe(RooSyncService.getInstance());
      expect(afterReset).not.toBe(first);
    });
  });

  describe('machineFilter contract', () => {
    it('rejects an unknown machine with MACHINE_NOT_FOUND instead of returning a snapshot', async () => {
      fs.writeFileSync(
        testDashboardPath,
        JSON.stringify({ overallStatus: 'synced', lastUpdate: '2026-03-11T10:00:00Z', machines: {} })
      );

      await expect(roosyncGetStatus({ machineFilter: 'myia-zzz-nope' }))
        .rejects.toMatchObject({ code: 'MACHINE_NOT_FOUND' });
      await expect(roosyncGetStatus({ machineFilter: 'myia-zzz-nope' }))
        .rejects.toThrow(/non trouvée/);
    });
  });
});

describe('parseHudDataFromDashboard (#1855)', () => {
  const recent = () => new Date().toISOString();
  const stale = () => new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();

  const intercom = (blocks: string[]) =>
    ['# Dashboard', '', '## Status', 'whatever', '', '## Intercom', '', ...blocks].join('\n');

  it('returns empty collections when the dashboard has no Intercom section', () => {
    const parsed = parseHudDataFromDashboard('# Dashboard\n\n## Status\nnothing here\n');

    expect(parsed.activeClaims).toEqual([]);
    expect(parsed.activeStages).toEqual([]);
  });

  it('returns empty collections on the explicit "no message" placeholder', () => {
    const parsed = parseHudDataFromDashboard(intercom(['*Aucun message.*']));

    expect(parsed.activeClaims).toEqual([]);
    expect(parsed.activeStages).toEqual([]);
  });

  it('extracts a recent CLAIMED message with its machine, issue and timestamp', () => {
    const ts = recent();
    const parsed = parseHudDataFromDashboard(
      intercom([
        `### [${ts}] myia-po-2023 |roo-extensions`,
        '[CLAIMED] #2639 — renforcement des assertions faibles',
        '',
      ])
    );

    expect(parsed.activeClaims).toHaveLength(1);
    expect(parsed.activeClaims[0].machineId).toBe('myia-po-2023');
    expect(parsed.activeClaims[0].issue).toBe('#2639');
    expect(parsed.activeClaims[0].timestamp).toBe(ts);
    expect(parsed.activeClaims[0].content).toContain('[CLAIMED]');
  });

  it('reports "unknown" as the issue when a CLAIMED message carries no issue number', () => {
    const parsed = parseHudDataFromDashboard(
      intercom([`### [${recent()}] myia-po-2024 |CoursIA`, '[CLAIMED] starting work', ''])
    );

    expect(parsed.activeClaims).toHaveLength(1);
    expect(parsed.activeClaims[0].issue).toBe('unknown');
  });

  it('ignores messages older than the 2h HUD window', () => {
    const parsed = parseHudDataFromDashboard(
      intercom([
        `### [${stale()}] myia-po-2023 |roo-extensions`,
        '[CLAIMED] #1 — vieux claim',
        '[EXEC]',
        '',
      ])
    );

    expect(parsed.activeClaims).toEqual([]);
    expect(parsed.activeStages).toEqual([]);
  });

  it('collects pipeline stage tags from recent messages', () => {
    const ts = recent();
    const parsed = parseHudDataFromDashboard(
      intercom([
        `### [${ts}] myia-po-2025 |CoursIA`,
        '[PLAN] puis [EXEC] sur #3111',
        '',
        `### [${ts}] myia-web1 |VPS`,
        '[VERIFY] build vert',
        '',
      ])
    );

    expect(parsed.activeStages.map(s => s.stage).sort()).toEqual(['EXEC', 'PLAN', 'VERIFY']);
    expect(parsed.activeStages.map(s => s.machineId).sort())
      .toEqual(['myia-po-2025', 'myia-po-2025', 'myia-web1']);
    // a message that is not a claim must not fabricate one
    expect(parsed.activeClaims).toEqual([]);
  });

  it('skips malformed blocks without throwing', () => {
    const parsed = parseHudDataFromDashboard(
      intercom([
        '### pas-un-header-valide',
        '[CLAIMED] #1 — sans séparateur machine|workspace',
        '',
        `### [${recent()}] myia-po-2026 |hermes-agent`,
        '[FIX] #42',
        '',
      ])
    );

    expect(parsed.activeClaims).toEqual([]);
    expect(parsed.activeStages).toHaveLength(1);
    expect(parsed.activeStages[0].stage).toBe('FIX');
  });
});
