/**
 * Tests for the roosync recovery decision endpoint (#1320 — Recovery-Before-Escalation).
 *
 * Uses a REAL HeartbeatService instance (pure in-memory, no I/O) behind the
 * mocked service locator, so the DEFAULT_RECOVERY_ACTIONS patterns are
 * exercised through the actual classification code — not a re-declaration.
 *
 * Covers:
 * - errorMessage matching each default pattern → matched action
 * - unknown error → no_match (caller escalates)
 * - outcome recording (recovered / failed) then history visibility
 * - history bounded and returned in order
 * - diagnose routing: action='recovery' forwards args and shapes the result
 *
 * @module tools/roosync/__tests__/recovery.test
 * @version 1.0.0
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { HeartbeatService } from '../../../services/roosync/HeartbeatService.js';
import type { RecoveryAttempt } from '../../../services/roosync/HeartbeatService.js';

let heartbeat: HeartbeatService;

vi.mock('../../../services/lazy-roosync.js', () => ({
  getRooSyncService: vi.fn(async () => ({
    getHeartbeatService: () => heartbeat,
  })),
}));

import { reportRecovery } from '../recovery.js';
import { roosyncDiagnose } from '../diagnose.js';

beforeEach(() => {
  heartbeat = new HeartbeatService();
});

describe('reportRecovery — classification', () => {
  test.each([
    ['ENOENT: no such file .../roo-state-manager/build-out/index.js', 'rebuild_mcp'],
    ['git fetch failed: upload-pack: not our ref 67514ec1', 'reset_submodule'],
    ['CONFLICT (content): Merge conflict in src/index.ts', 'rebase_git'],
    ['Error: EBUSY: resource busy or locked model.node', 'retry_once'],
    ['HTTP 429 too many requests', 'retry_once'],
    ['fetch failed: ECONNREFUSED 127.0.0.1:6333', 'retry_once'],
  ])('%s → %s', async (errorMessage, expectedAction) => {
    const result = await reportRecovery({ errorMessage, machineId: 'myia-po-2023' });
    expect(result.success).toBe(true);
    expect(result.mode).toBe('matched');
    expect(result.matchedAction).toBe(expectedAction);
    expect(result.description).toBeTruthy();
  });

  test('unknown error returns no_match (escalation path)', async () => {
    const result = await reportRecovery({ errorMessage: 'SyntaxError: unexpected token', machineId: 'm1' });
    expect(result.success).toBe(true);
    expect(result.mode).toBe('no_match');
    expect(result.matchedAction).toBeUndefined();
    expect(result.description).toMatch(/escalate/i);
  });

  test('machineId defaults to lowercased hostname', async () => {
    const result = await reportRecovery({ errorMessage: 'ETIMEDOUT' });
    expect(result.machineId).toMatch(/^[a-z0-9-]+$/);
  });
});

describe('reportRecovery — outcome + history', () => {
  test('outcome recorded as recovered, visible in history', async () => {
    await reportRecovery({ errorMessage: 'ETIMEDOUT gateway', machineId: 'm1' });
    const outcome = await reportRecovery({ outcomeAction: 'retry_once', success: true, machineId: 'm1' });
    expect(outcome.mode).toBe('outcome_recorded');
    expect(outcome.description).toBe('recovered');

    const history = await reportRecovery({ machineId: 'm1' });
    expect(history.mode).toBe('history');
    const entries = history.history as RecoveryAttempt[];
    expect(entries).toHaveLength(1);
    expect(entries[0].result).toBe('recovered');
    expect(entries[0].matchedAction).toBe('retry_once');
  });

  test('outcome recorded as failed when success omitted', async () => {
    await reportRecovery({ errorMessage: 'CONFLICT Merge conflict in file', machineId: 'm1' });
    await reportRecovery({ outcomeAction: 'rebase_git', machineId: 'm1' });
    const history = await reportRecovery({});
    expect((history.history as RecoveryAttempt[])[0].result).toBe('failed');
  });

  test('history respects limit', async () => {
    for (let i = 0; i < 3; i++) {
      await reportRecovery({ errorMessage: `ETIMEDOUT attempt ${i}`, machineId: 'm1' });
    }
    const history = await reportRecovery({ limit: 2 });
    expect(history.history).toHaveLength(2);
  });
});

describe('roosync_diagnose routing — action recovery', () => {
  test('forwards errorMessage and returns matched action in message + data', async () => {
    const result = await roosyncDiagnose({
      action: 'recovery',
      errorMessage: 'ENOENT roo-state-manager build missing',
      machineId: 'myia-ai-01',
    });
    expect(result.success).toBe(true);
    expect(result.action).toBe('recovery');
    expect(result.message).toContain('rebuild_mcp');
    expect(result.data.mode).toBe('matched');
    expect(result.data.matchedAction).toBe('rebuild_mcp');
  });

  test('no_match surfaces escalation guidance', async () => {
    const result = await roosyncDiagnose({ action: 'recovery', errorMessage: 'weird failure' });
    expect(result.data.mode).toBe('no_match');
    expect(result.message).toMatch(/escalate/i);
  });

  test('history mode via diagnose', async () => {
    await roosyncDiagnose({ action: 'recovery', errorMessage: 'ECONNRESET' });
    const result = await roosyncDiagnose({ action: 'recovery' });
    expect(result.data.mode).toBe('history');
    expect(result.data.history).toHaveLength(1);
  });
});
