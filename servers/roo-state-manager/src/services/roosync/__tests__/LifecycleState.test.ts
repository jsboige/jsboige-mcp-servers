/**
 * Tests for AgentLifecycleState (#1320 — claw-code state machine pattern).
 *
 * Covers:
 * - Valid transitions along the happy path (BOOTSTRAPPING → READY → CLAIMED → WORKING → REPORTING → IDLE)
 * - Error/recovery cycle (any → ERROR → RECOVERING → READY)
 * - Invalid transitions rejected with HeartbeatServiceError
 * - IDLE → CLAIMED (re-engagement)
 * - Same-state no-op (idempotent)
 * - Lifecycle history tracking
 * - Lifecycle state exposed in getHeartbeatData
 * - Callback firing on transition
 * - Auto-registration with BOOTSTRAPPING initial state
 *
 * @module services/roosync/__tests__/LifecycleState.test
 * @version 1.0.0
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

import {
  HeartbeatService,
  HeartbeatServiceError,
} from '../HeartbeatService.js';
import type { AgentLifecycleState, LifecycleTransitionEvent } from '../HeartbeatService.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AgentLifecycleState', () => {
  // ============================================================
  // Happy path: BOOTSTRAPPING → READY → CLAIMED → WORKING → REPORTING → IDLE
  // ============================================================

  describe('happy path transitions', () => {
    test('full lifecycle: BOOTSTRAPPING → READY → CLAIMED → WORKING → REPORTING → IDLE', () => {
      const service = new HeartbeatService();

      // BOOTSTRAPPING is the initial state on auto-register
      const e1 = service.transitionLifecycle('m1', 'READY', 'MCP confirmed');
      expect(e1.fromState).toBe('BOOTSTRAPPING');
      expect(e1.toState).toBe('READY');
      expect(e1.reason).toBe('MCP confirmed');

      const e2 = service.transitionLifecycle('m1', 'CLAIMED', 'Task #1234 assigned');
      expect(e2.fromState).toBe('READY');
      expect(e2.toState).toBe('CLAIMED');

      const e3 = service.transitionLifecycle('m1', 'WORKING', 'Implementation started');
      expect(e3.fromState).toBe('CLAIMED');
      expect(e3.toState).toBe('WORKING');

      const e4 = service.transitionLifecycle('m1', 'REPORTING', 'Posting [DONE]');
      expect(e4.fromState).toBe('WORKING');
      expect(e4.toState).toBe('REPORTING');

      const e5 = service.transitionLifecycle('m1', 'IDLE', 'Task complete');
      expect(e5.fromState).toBe('REPORTING');
      expect(e5.toState).toBe('IDLE');
    });

    test('IDLE → CLAIMED → WORKING (re-engagement)', () => {
      const service = new HeartbeatService();
      service.transitionLifecycle('m1', 'READY');
      service.transitionLifecycle('m1', 'IDLE');

      const e = service.transitionLifecycle('m1', 'CLAIMED', 'New dispatch');
      expect(e.fromState).toBe('IDLE');
      expect(e.toState).toBe('CLAIMED');
    });

    test('IDLE → READY (ready for dispatch)', () => {
      const service = new HeartbeatService();
      service.transitionLifecycle('m1', 'READY');
      service.transitionLifecycle('m1', 'IDLE');

      const e = service.transitionLifecycle('m1', 'READY', 'Awaiting dispatch');
      expect(e.fromState).toBe('IDLE');
      expect(e.toState).toBe('READY');
    });
  });

  // ============================================================
  // Error/Recovery cycle
  // ============================================================

  describe('error recovery cycle', () => {
    test('WORKING → ERROR → RECOVERING → READY', () => {
      const service = new HeartbeatService();
      service.transitionLifecycle('m1', 'READY');
      service.transitionLifecycle('m1', 'CLAIMED');
      service.transitionLifecycle('m1', 'WORKING');

      const e1 = service.transitionLifecycle('m1', 'ERROR', 'MCP timeout');
      expect(e1.fromState).toBe('WORKING');
      expect(e1.toState).toBe('ERROR');

      const e2 = service.transitionLifecycle('m1', 'RECOVERING', 'Restarting MCP');
      expect(e2.fromState).toBe('ERROR');
      expect(e2.toState).toBe('RECOVERING');

      const e3 = service.transitionLifecycle('m1', 'READY', 'MCP back up');
      expect(e3.fromState).toBe('RECOVERING');
      expect(e3.toState).toBe('READY');
    });

    test('BOOTSTRAPPING → ERROR (startup failure)', () => {
      const service = new HeartbeatService();

      // First call auto-registers as BOOTSTRAPPING
      const e = service.transitionLifecycle('m1', 'ERROR', 'Config not found');
      expect(e.fromState).toBe('BOOTSTRAPPING');
      expect(e.toState).toBe('ERROR');
    });

    test('ERROR → IDLE (give up recovery)', () => {
      const service = new HeartbeatService();
      service.transitionLifecycle('m1', 'READY');
      service.transitionLifecycle('m1', 'ERROR', 'Fatal');

      const e = service.transitionLifecycle('m1', 'IDLE', 'Gave up');
      expect(e.fromState).toBe('ERROR');
      expect(e.toState).toBe('IDLE');
    });

    test('RECOVERING → ERROR (recovery failed)', () => {
      const service = new HeartbeatService();
      service.transitionLifecycle('m1', 'READY');
      service.transitionLifecycle('m1', 'ERROR');
      service.transitionLifecycle('m1', 'RECOVERING');

      const e = service.transitionLifecycle('m1', 'ERROR', 'Still broken');
      expect(e.fromState).toBe('RECOVERING');
      expect(e.toState).toBe('ERROR');
    });
  });

  // ============================================================
  // Invalid transitions
  // ============================================================

  describe('invalid transitions', () => {
    test('BOOTSTRAPPING → WORKING rejected (skip READY)', () => {
      const service = new HeartbeatService();
      expect(() => service.transitionLifecycle('m1', 'WORKING')).toThrow(HeartbeatServiceError);
    });

    test('READY → REPORTING rejected (skip CLAIMED/WORKING)', () => {
      const service = new HeartbeatService();
      service.transitionLifecycle('m1', 'READY');
      expect(() => service.transitionLifecycle('m1', 'REPORTING')).toThrow(HeartbeatServiceError);
    });

    test('IDLE → WORKING rejected (must go through CLAIMED)', () => {
      const service = new HeartbeatService();
      service.transitionLifecycle('m1', 'READY');
      service.transitionLifecycle('m1', 'IDLE');
      expect(() => service.transitionLifecycle('m1', 'WORKING')).toThrow(HeartbeatServiceError);
    });

    test('error contains INVALID_TRANSITION code', () => {
      const service = new HeartbeatService();
      try {
        service.transitionLifecycle('m1', 'WORKING');
      } catch (err) {
        expect(err).toBeInstanceOf(HeartbeatServiceError);
        expect((err as HeartbeatServiceError).code).toBe('INVALID_TRANSITION');
        expect((err as HeartbeatServiceError).message).toContain('BOOTSTRAPPING');
        expect((err as HeartbeatServiceError).message).toContain('WORKING');
      }
    });
  });

  // ============================================================
  // Same-state no-op (idempotent)
  // ============================================================

  describe('same-state no-op', () => {
    test('transitioning to current state returns event without error', () => {
      const service = new HeartbeatService();
      service.transitionLifecycle('m1', 'READY');

      const e = service.transitionLifecycle('m1', 'READY');
      expect(e.fromState).toBe('READY');
      expect(e.toState).toBe('READY');
    });
  });

  // ============================================================
  // History tracking
  // ============================================================

  describe('history tracking', () => {
    test('getLifecycleHistory returns all transitions', () => {
      const service = new HeartbeatService();
      service.transitionLifecycle('m1', 'READY');
      service.transitionLifecycle('m1', 'CLAIMED');
      service.transitionLifecycle('m1', 'WORKING');

      const history = service.getLifecycleHistory();
      expect(history).toHaveLength(3);
      expect(history[0].toState).toBe('READY');
      expect(history[1].toState).toBe('CLAIMED');
      expect(history[2].toState).toBe('WORKING');
    });

    test('getLifecycleHistory respects limit parameter', () => {
      const service = new HeartbeatService();
      service.transitionLifecycle('m1', 'READY');
      service.transitionLifecycle('m1', 'CLAIMED');
      service.transitionLifecycle('m1', 'WORKING');

      const recent = service.getLifecycleHistory(2);
      expect(recent).toHaveLength(2);
      expect(recent[0].toState).toBe('CLAIMED');
      expect(recent[1].toState).toBe('WORKING');
    });

    test('history bounded at 100 entries', () => {
      const service = new HeartbeatService();
      // Cycle: READY → IDLE → READY (2 transitions per cycle)
      for (let i = 0; i < 55; i++) {
        service.transitionLifecycle('m1', 'READY');
        service.transitionLifecycle('m1', 'IDLE');
      }
      // 110 transitions total, but bounded to 100
      const history = service.getLifecycleHistory();
      expect(history.length).toBeLessThanOrEqual(100);
    });
  });

  // ============================================================
  // HeartbeatData integration
  // ============================================================

  describe('HeartbeatData integration', () => {
    test('lifecycleState exposed in getHeartbeatData', () => {
      const service = new HeartbeatService();
      service.transitionLifecycle('m1', 'READY');

      const data = service.getHeartbeatData('m1');
      expect(data?.lifecycleState).toBe('READY');
      expect(data?.metadata.lifecycleSince).toBeDefined();
    });

    test('lifecycleReason persisted in metadata', () => {
      const service = new HeartbeatService();
      service.transitionLifecycle('m1', 'READY', 'MCP tools confirmed');

      const data = service.getHeartbeatData('m1');
      expect(data?.metadata.lifecycleReason).toBe('MCP tools confirmed');
    });

    test('getLifecycleState convenience method', () => {
      const service = new HeartbeatService();
      service.transitionLifecycle('m1', 'READY');
      service.transitionLifecycle('m1', 'CLAIMED');
      service.transitionLifecycle('m1', 'WORKING');

      expect(service.getLifecycleState('m1')).toBe('WORKING');
    });

    test('getLifecycleState returns undefined for unknown machine', () => {
      const service = new HeartbeatService();
      expect(service.getLifecycleState('unknown')).toBeUndefined();
    });
  });

  // ============================================================
  // Callback
  // ============================================================

  describe('callback', () => {
    test('onLifecycleChange callback fires on transition', () => {
      const service = new HeartbeatService();
      const callback = vi.fn();
      service.onLifecycleChange(callback);

      service.transitionLifecycle('m1', 'READY');

      expect(callback).toHaveBeenCalledTimes(1);
      const event = callback.mock.calls[0][0] as LifecycleTransitionEvent;
      expect(event.fromState).toBe('BOOTSTRAPPING');
      expect(event.toState).toBe('READY');
    });

    test('callback NOT fired on same-state no-op', () => {
      const service = new HeartbeatService();
      const callback = vi.fn();
      service.onLifecycleChange(callback);

      service.transitionLifecycle('m1', 'READY');
      service.transitionLifecycle('m1', 'READY'); // no-op

      expect(callback).toHaveBeenCalledTimes(1); // only the first call
    });
  });

  // ============================================================
  // Auto-registration
  // ============================================================

  describe('auto-registration', () => {
    test('first transition auto-registers machine as BOOTSTRAPPING', () => {
      const service = new HeartbeatService();

      service.transitionLifecycle('m1', 'READY');

      // Machine should be registered in heartbeat data
      const data = service.getHeartbeatData('m1');
      expect(data).toBeDefined();
      expect(data?.status).toBe('online');
      expect(data?.lifecycleState).toBe('READY');
    });

    test('case-insensitive machine IDs', () => {
      const service = new HeartbeatService();

      service.transitionLifecycle('MYIA-PO-2023', 'READY');
      expect(service.getLifecycleState('myia-po-2023')).toBe('READY');
    });
  });

  // ============================================================
  // Multiple machines
  // ============================================================

  describe('multiple machines', () => {
    test('independent lifecycle per machine', () => {
      const service = new HeartbeatService();

      service.transitionLifecycle('m1', 'READY');
      service.transitionLifecycle('m2', 'READY');
      service.transitionLifecycle('m1', 'CLAIMED');

      expect(service.getLifecycleState('m1')).toBe('CLAIMED');
      expect(service.getLifecycleState('m2')).toBe('READY');
    });

    test('history contains events from all machines', () => {
      const service = new HeartbeatService();

      service.transitionLifecycle('m1', 'READY');
      service.transitionLifecycle('m2', 'READY');

      const history = service.getLifecycleHistory();
      expect(history).toHaveLength(2);
      expect(history[0].machineId).toBe('m1');
      expect(history[1].machineId).toBe('m2');
    });
  });
});
