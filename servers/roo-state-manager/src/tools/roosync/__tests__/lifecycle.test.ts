/**
 * Tests for the roosync_report_lifecycle MCP tool (#1320).
 *
 * @module tools/roosync/__tests__/lifecycle.test
 * @version 1.0.0
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// Mock lazy-roosync to return a HeartbeatService
const mockTransitionLifecycle = vi.fn();
const mockGetHeartbeatService = vi.fn(() => ({
  registerHeartbeat: vi.fn(),
  transitionLifecycle: mockTransitionLifecycle,
  getHeartbeatData: vi.fn(),
}));

vi.mock('../../../services/lazy-roosync.js', () => ({
  getRooSyncService: vi.fn(() => ({
    getHeartbeatService: mockGetHeartbeatService,
  })),
}));

import { reportLifecycle } from '../lifecycle.js';
import type { LifecycleTransitionEvent } from '../../../services/roosync/HeartbeatService.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('reportLifecycle tool', () => {
  test('successful transition returns success result', async () => {
    const event: LifecycleTransitionEvent = {
      machineId: 'myia-po-2023',
      fromState: 'BOOTSTRAPPING',
      toState: 'READY',
      reason: 'MCP confirmed',
      timestamp: '2026-05-24T10:00:00.000Z',
    };
    mockTransitionLifecycle.mockReturnValue(event);

    const result = await reportLifecycle({ state: 'READY', reason: 'MCP confirmed' });

    expect(result.success).toBe(true);
    expect(result.toState).toBe('READY');
    expect(result.fromState).toBe('BOOTSTRAPPING');
    expect(result.reason).toBe('MCP confirmed');
  });

  test('invalid transition returns error result', async () => {
    const { HeartbeatServiceError } = await import('../../../services/roosync/HeartbeatService.js');
    mockTransitionLifecycle.mockImplementation(() => {
      throw new HeartbeatServiceError('Invalid transition', 'INVALID_TRANSITION');
    });

    const result = await reportLifecycle({ state: 'WORKING', machineId: 'test' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid transition');
    expect(result.toState).toBe('WORKING');
  });

  test('uses hostname as default machineId', async () => {
    const event: LifecycleTransitionEvent = {
      machineId: 'test-host',
      fromState: 'BOOTSTRAPPING',
      toState: 'READY',
      timestamp: '2026-05-24T10:00:00.000Z',
    };
    mockTransitionLifecycle.mockReturnValue(event);

    await reportLifecycle({ state: 'READY' });

    expect(mockTransitionLifecycle).toHaveBeenCalledWith(
      expect.any(String),
      'READY',
      undefined
    );
  });

  test('passes machineId and reason to transitionLifecycle', async () => {
    const event: LifecycleTransitionEvent = {
      machineId: 'myia-po-2023',
      fromState: 'READY',
      toState: 'CLAIMED',
      reason: 'Issue #1320',
      timestamp: '2026-05-24T10:00:00.000Z',
    };
    mockTransitionLifecycle.mockReturnValue(event);

    await reportLifecycle({
      state: 'CLAIMED',
      machineId: 'myia-po-2023',
      reason: 'Issue #1320',
    });

    expect(mockTransitionLifecycle).toHaveBeenCalledWith(
      'myia-po-2023',
      'CLAIMED',
      'Issue #1320'
    );
  });
});
