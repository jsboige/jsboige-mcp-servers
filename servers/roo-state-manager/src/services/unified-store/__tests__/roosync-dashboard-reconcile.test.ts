/**
 * Tests for the periodic GDrive→PG dashboard reconcile (#3151 Phase C
 * residual — symmetric to the channel reconcile #3292).
 *
 * @module services/unified-store/__tests__/roosync-dashboard-reconcile
 *
 * Real fixture files in a temp dashboards dir + injected reader/writer
 * doubles. The env gate is driven directly (save/restore in
 * beforeEach/afterEach), same contract as the channel reconcile tests.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  reconcileDashboardsFromGDrive,
  isDashboardReconcileArmed,
  startDashboardReconcileDaemon,
  stopDashboardReconcileDaemon,
  getDashboardReconcileStatus,
} from '../roosync-dashboard-reconcile.js';
import { extractPersistedMessageIds } from '../../../tools/roosync/dashboard-markdown.js';
import type { RooSyncDashboardRow, RooSyncDashboardMessageRow } from '../types.js';

vi.unmock('fs');
vi.unmock('fs/promises');

function fixture(key: string, messages: string[], idlessCount = 0): string {
  const blocks: string[] = [];
  let i = 0;
  for (const id of messages) {
    // Real write format: [msg:] sits IMMEDIATELY after the header line —
    // the parser anchors it there (dashboard-markdown.ts msgMatch regex).
    blocks.push(
      `### [2026-09-17T10:0${i}:00Z] m1|w1\n[msg: ${id}]\ncontent ${i}\n\n---`
    );
    i++;
  }
  for (let j = 0; j < idlessCount; j++) {
    blocks.push(`### [2026-09-17T10:1${j}:00Z] m1|w1\nid-less content ${j}\n\n---`);
  }
  return [
    '---',
    'type: workspace',
    `key: ${key}`,
    "lastModified: '2026-09-17T10:00:00Z'",
    'lastModifiedBy:',
    '  machineId: m1',
    '  workspace: w1',
    `totalMessages: ${messages.length + idlessCount}`,
    '---',
    '',
    '## Status',
    '',
    'status body',
    '',
    '## Intercom',
    '',
    ...blocks.map((b) => b + '\n'),
  ].join('\n');
}

describe('roosync-dashboard-reconcile (#3151 Phase C)', () => {
  let dashboardsDir: string;
  let savedDualWrite: string | undefined;
  let savedPgUrl: string | undefined;
  let readerThrows: Set<string>;
  /** Writer double — records every sync call. */
  let writerCalls: { key: string; row: RooSyncDashboardRow; messages: RooSyncDashboardMessageRow[]; opts?: Record<string, unknown> }[];
  /** Simulated PG journal state — the reader double serves THIS, the writer
   * double mutates it (DO NOTHING insert), so the module's honest post-insert
   * re-read sees the healed state exactly like the real store. */
  let pgIds: Map<string, string[]>;

  const readerDouble = {
    async getRooSyncDashboard(key: string) {
      if (readerThrows.has(key)) throw new Error('pg down for ' + key);
      const ids = pgIds.get(key);
      if (!ids) return null;
      return {
        dashboard: {} as RooSyncDashboardRow,
        messages: ids.map((id) => ({ dashboard_key: key, message_id: id } as RooSyncDashboardMessageRow)),
      };
    },
  };

  const writerDouble = {
    async syncRooSyncDashboard(
      row: RooSyncDashboardRow,
      messages: RooSyncDashboardMessageRow[],
      opts?: Record<string, unknown>
    ) {
      writerCalls.push({ key: row.key, row, messages, opts });
      // Simulate the DO NOTHING insert: the journal gains the ids.
      const ids = pgIds.get(row.key) ?? [];
      ids.push(...messages.map((m) => m.message_id as string));
      pgIds.set(row.key, ids);
    },
  };

  const readerViewing = (key: string, ids: string[]) => {
    pgIds.set(key, [...ids]);
  };

  beforeEach(() => {
    dashboardsDir = join(__dirname, '../../../__test-data__/reconcile-dashboards');
    if (existsSync(dashboardsDir)) rmSync(dashboardsDir, { recursive: true, force: true });
    mkdirSync(dashboardsDir, { recursive: true });
    savedDualWrite = process.env.UNIFIED_STORE_DUAL_WRITE;
    savedPgUrl = process.env.UNIFIED_STORE_PG_URL;
    process.env.UNIFIED_STORE_DUAL_WRITE = '1';
    process.env.UNIFIED_STORE_PG_URL = 'postgres://user:pass@pg.test:5432/store';
    readerThrows = new Set();
    writerCalls = [];
    pgIds = new Map();
  });

  afterEach(() => {
    process.env.UNIFIED_STORE_DUAL_WRITE = savedDualWrite;
    process.env.UNIFIED_STORE_PG_URL = savedPgUrl;
    stopDashboardReconcileDaemon();
    if (existsSync(dashboardsDir)) rmSync(dashboardsDir, { recursive: true, force: true });
  });

  test('not armed → skipped-not-armed, zero IO', async () => {
    delete process.env.UNIFIED_STORE_DUAL_WRITE;
    expect(isDashboardReconcileArmed()).toBe(false);
    writeFileSync(join(dashboardsDir, 'workspace-a.md'), fixture('workspace-a', ['id-1']));
    const result = await reconcileDashboardsFromGDrive({
      dashboardsDir,
      reader: readerDouble as never,
      writer: writerDouble as never,
    });
    expect(result.status).toBe('skipped-not-armed');
    expect(writerCalls).toHaveLength(0);
  });

  test('imports ONLY the missing journal rows of a gap key, with backfill semantics', async () => {
    writeFileSync(join(dashboardsDir, 'workspace-a.md'), fixture('workspace-a', ['id-1', 'id-2', 'id-3']));
    readerViewing('workspace-a', ['id-1', 'id-2']); // id-3 is disk-only
    const result = await reconcileDashboardsFromGDrive({
      dashboardsDir,
      reader: readerDouble as never,
      writer: writerDouble as never,
    });
    expect(result.status).toBe('ok');
    expect(result.keysWithGap).toBe(1);
    expect(result.gapMessages).toBe(1);
    expect(result.alreadyPresent).toBe(2);
    expect(result.reconciled).toBe(1);
    expect(writerCalls).toHaveLength(1);
    expect(writerCalls[0].key).toBe('workspace-a');
    expect(writerCalls[0].messages.map((m) => m.message_id)).toEqual(['id-3']);
    expect(writerCalls[0].opts).toEqual({ backfill: true });
    // Full dashboard row (status content), not a truncated one.
    expect(writerCalls[0].row.content).toContain('status body');
  });

  test('no gap → no writer call', async () => {
    writeFileSync(join(dashboardsDir, 'workspace-a.md'), fixture('workspace-a', ['id-1']));
    readerViewing('workspace-a', ['id-1']);
    const result = await reconcileDashboardsFromGDrive({
      dashboardsDir,
      reader: readerDouble as never,
      writer: writerDouble as never,
    });
    expect(result.keysWithGap).toBe(0);
    expect(writerCalls).toHaveLength(0);
  });

  test('key never backfilled (reader null) → all persisted ids imported', async () => {
    writeFileSync(join(dashboardsDir, 'machine-x.md'), fixture('machine-x', ['id-1', 'id-2']));
    const result = await reconcileDashboardsFromGDrive({
      dashboardsDir,
      reader: readerDouble as never,
      writer: writerDouble as never,
    });
    expect(result.keysWithGap).toBe(1);
    expect(result.gapMessages).toBe(2);
    expect(result.reconciled).toBe(2);
    expect(writerCalls[0].messages).toHaveLength(2);
  });

  test('id-less (pre-v3) messages are skipped and counted, never imported', async () => {
    writeFileSync(join(dashboardsDir, 'workspace-a.md'), fixture('workspace-a', ['id-1'], 2));
    const result = await reconcileDashboardsFromGDrive({
      dashboardsDir,
      reader: readerDouble as never,
      writer: writerDouble as never,
    });
    expect(result.idlessSkipped).toBe(2);
    expect(result.gapMessages).toBe(1); // only id-1
    expect(writerCalls[0].messages.map((m) => m.message_id)).toEqual(['id-1']);
  });

  test('reader failure on one key → that key is not blind-imported, others proceed', async () => {
    writeFileSync(join(dashboardsDir, 'workspace-a.md'), fixture('workspace-a', ['id-1']));
    writeFileSync(join(dashboardsDir, 'workspace-b.md'), fixture('workspace-b', ['id-2']));
    readerThrows.add('workspace-a');
    const result = await reconcileDashboardsFromGDrive({
      dashboardsDir,
      reader: readerDouble as never,
      writer: writerDouble as never,
    });
    expect(result.errors).toBe(1);
    expect(result.failures[0]).toContain('workspace-a.md');
    expect(writerCalls).toHaveLength(1);
    expect(writerCalls[0].key).toBe('workspace-b');
  });

  test('corrupt file (no frontmatter) → counted, pass continues', async () => {
    writeFileSync(join(dashboardsDir, 'workspace-bad.md'), 'no frontmatter here');
    writeFileSync(join(dashboardsDir, 'workspace-ok.md'), fixture('workspace-ok', ['id-1']));
    const result = await reconcileDashboardsFromGDrive({
      dashboardsDir,
      reader: readerDouble as never,
      writer: writerDouble as never,
    });
    expect(result.errors).toBe(1);
    expect(result.parsedKeys).toBe(1);
    expect(writerCalls[0].key).toBe('workspace-ok');
  });

  test('unkeyed files (.bak, DASHBOARD.md, archives) are not scanned', async () => {
    writeFileSync(join(dashboardsDir, 'workspace-a.md.bak'), fixture('workspace-a', ['id-1']));
    writeFileSync(join(dashboardsDir, 'DASHBOARD.md'), fixture('x', ['id-2']));
    const result = await reconcileDashboardsFromGDrive({
      dashboardsDir,
      reader: readerDouble as never,
      writer: writerDouble as never,
    });
    expect(result.filesScanned).toBe(0);
    expect(writerCalls).toHaveLength(0);
  });

  test('BOM + CRLF files parse (same normalization as the tool read path)', async () => {
    const content = fixture('workspace-a', ['id-1']);
    const crlf = content.replace(/\n/g, '\r\n');
    writeFileSync(join(dashboardsDir, 'workspace-a.md'), '﻿' + crlf, 'utf-8');
    const result = await reconcileDashboardsFromGDrive({
      dashboardsDir,
      reader: readerDouble as never,
      writer: writerDouble as never,
    });
    expect(result.parsedKeys).toBe(1);
    expect(result.gapMessages).toBe(1);
  });

  test('daemon: start is idempotent, stop keeps lastRun readable', async () => {
    vi.useFakeTimers();
    try {
      startDashboardReconcileDaemon({ dashboardsDir });
      expect(getDashboardReconcileStatus().running).toBe(true);
      startDashboardReconcileDaemon({ dashboardsDir }); // duplicate — ignored
      stopDashboardReconcileDaemon();
      const status = getDashboardReconcileStatus();
      expect(status.running).toBe(false);
      expect(status.lastRun).toBeNull(); // never fired (90s initial delay not advanced)
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('extractPersistedMessageIds', () => {
  test('collects [msg:] ids only — [reply-to:] and bare headers excluded', () => {
    const content = [
      '## Intercom',
      '',
      '### [t1] m|w',
      '',
      '[msg: abc]',
      '[reply-to: xyz]',
      '',
      'body',
      '',
      '### [t2] m|w',
      '',
      'no id line',
      '',
    ].join('\n');
    const ids = extractPersistedMessageIds(content);
    expect(ids.size).toBe(1);
    expect(ids.has('abc')).toBe(true);
    expect(ids.has('xyz')).toBe(false);
  });
});
