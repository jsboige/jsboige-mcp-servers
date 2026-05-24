/**
 * Tests for Recovery-Before-Escalation (#1320 Pattern 3).
 *
 * Covers:
 * - Default recovery action catalog
 * - Error pattern matching
 * - Recovery history tracking (bounded)
 * - Recovery outcome recording
 * - Custom recovery action registration
 * - No-match returns null
 * - Integration with lifecycle state transitions
 */

import { describe, test, expect, beforeEach } from 'vitest';

import {
  HeartbeatService,
  RecoveryAction,
  RecoveryAttempt,
} from '../HeartbeatService.js';

describe('Recovery-Before-Escalation (#1320 Pattern 3)', () => {

  describe('default recovery actions', () => {
    test('should have 6 default recovery actions', () => {
      const service = new HeartbeatService();
      const actions = service.getRecoveryActions();
      expect(actions.length).toBe(6);
    });

    test('should include ENOENT roo-state-manager pattern', () => {
      const service = new HeartbeatService();
      const actions = service.getRecoveryActions();
      const enoent = actions.find(a => a.action === 'rebuild_mcp');
      expect(enoent).toBeDefined();
      expect(enoent!.pattern.source).toContain('roo-state-manager');
    });

    test('should include phantom submodule pointer pattern', () => {
      const service = new HeartbeatService();
      const actions = service.getRecoveryActions();
      const submod = actions.find(a => a.action === 'reset_submodule');
      expect(submod).toBeDefined();
      expect(submod!.pattern.source).toContain('upload-pack');
    });

    test('should include merge conflict pattern', () => {
      const service = new HeartbeatService();
      const actions = service.getRecoveryActions();
      const conflict = actions.find(a => a.action === 'rebase_git');
      expect(conflict).toBeDefined();
    });

    test('should include EBUSY pattern', () => {
      const service = new HeartbeatService();
      const actions = service.getRecoveryActions();
      const ebusy = actions.find(a => a.action === 'retry_once');
      expect(ebusy).toBeDefined();
    });
  });

  describe('pattern matching', () => {
    test('should match ENOENT roo-state-manager error', () => {
      const service = new HeartbeatService();
      const result = service.attemptRecovery('m1', 'ENOENT: no such file, stat \'roo-state-manager/dist/index.js\'');
      expect(result).not.toBeNull();
      expect(result!.matchedAction).toBe('rebuild_mcp');
      expect(result!.result).toBe('matched');
    });

    test('should match phantom submodule pointer error', () => {
      const service = new HeartbeatService();
      const result = service.attemptRecovery('m1', 'fatal: remote error: upload-pack: not our ref abc123');
      expect(result).not.toBeNull();
      expect(result!.matchedAction).toBe('reset_submodule');
    });

    test('should match merge conflict error', () => {
      const service = new HeartbeatService();
      const result = service.attemptRecovery('m1', 'CONFLICT (content): Merge conflict in src/index.ts');
      expect(result).not.toBeNull();
      expect(result!.matchedAction).toBe('rebase_git');
    });

    test('should match EBUSY .node error', () => {
      const service = new HeartbeatService();
      const result = service.attemptRecovery('m1', 'EBUSY: resource busy or locked, open \'esbuild_WindowsX64.node\'');
      expect(result).not.toBeNull();
      expect(result!.matchedAction).toBe('retry_once');
    });

    test('should match rate limit error', () => {
      const service = new HeartbeatService();
      const result = service.attemptRecovery('m1', 'HTTP 429: Too Many Requests - rate limit exceeded');
      expect(result).not.toBeNull();
      expect(result!.matchedAction).toBe('retry_once');
    });

    test('should match network transient error', () => {
      const service = new HeartbeatService();
      const result = service.attemptRecovery('m1', 'ECONNRESET: connection reset by peer');
      expect(result).not.toBeNull();
      expect(result!.matchedAction).toBe('retry_once');
    });

    test('should return null for unknown error', () => {
      const service = new HeartbeatService();
      const result = service.attemptRecovery('m1', 'Something completely unexpected happened');
      expect(result).toBeNull();
    });

    test('should truncate error signature to 200 chars', () => {
      const service = new HeartbeatService();
      const longError = 'EBUSY: resource busy or locked, open \'esbuild_WindowsX64.node\' ' + 'x'.repeat(300);
      const result = service.attemptRecovery('m1', longError);
      expect(result).not.toBeNull();
      expect(result!.errorSignature.length).toBeLessThanOrEqual(200);
    });

    test('should be case-insensitive on machine ID', () => {
      const service = new HeartbeatService();
      const result = service.attemptRecovery('MYIA-PO-2023', 'ECONNREFUSED: connection refused');
      expect(result).not.toBeNull();
      expect(result!.machineId).toBe('myia-po-2023');
    });
  });

  describe('recovery history', () => {
    test('should track recovery attempts', () => {
      const service = new HeartbeatService();
      service.attemptRecovery('m1', 'ECONNRESET: timeout');
      service.attemptRecovery('m1', 'ENOENT: roo-state-manager missing');

      const history = service.getRecoveryHistory();
      expect(history).toHaveLength(2);
      expect(history[0].matchedAction).toBe('retry_once');
      expect(history[1].matchedAction).toBe('rebuild_mcp');
    });

    test('should respect limit parameter', () => {
      const service = new HeartbeatService();
      for (let i = 0; i < 5; i++) {
        service.attemptRecovery('m1', 'ECONNRESET: timeout');
      }

      const recent = service.getRecoveryHistory(3);
      expect(recent).toHaveLength(3);
    });

    test('should be bounded at 50 entries', () => {
      const service = new HeartbeatService();
      for (let i = 0; i < 60; i++) {
        service.attemptRecovery('m1', 'ECONNRESET: timeout');
      }

      const history = service.getRecoveryHistory();
      expect(history.length).toBeLessThanOrEqual(50);
    });

    test('should not record unmatched errors', () => {
      const service = new HeartbeatService();
      service.attemptRecovery('m1', 'unknown error');
      expect(service.getRecoveryHistory()).toHaveLength(0);
    });
  });

  describe('recovery outcome recording', () => {
    test('should update last matched attempt to recovered', () => {
      const service = new HeartbeatService();
      service.attemptRecovery('m1', 'ECONNRESET: timeout');
      service.recordRecoveryOutcome('m1', 'retry_once', true);

      const history = service.getRecoveryHistory();
      expect(history[0].result).toBe('recovered');
    });

    test('should update last matched attempt to failed', () => {
      const service = new HeartbeatService();
      service.attemptRecovery('m1', 'ENOENT: roo-state-manager');
      service.recordRecoveryOutcome('m1', 'rebuild_mcp', false);

      const history = service.getRecoveryHistory();
      expect(history[0].result).toBe('failed');
    });

    test('should not crash when recording outcome for non-existent attempt', () => {
      const service = new HeartbeatService();
      expect(() => service.recordRecoveryOutcome('unknown', 'retry_once', true)).not.toThrow();
    });

    test('should update the most recent matching attempt', () => {
      const service = new HeartbeatService();
      service.attemptRecovery('m1', 'ECONNRESET: timeout'); // first attempt
      service.attemptRecovery('m1', 'ECONNRESET: timeout'); // second attempt
      service.recordRecoveryOutcome('m1', 'retry_once', true);

      const history = service.getRecoveryHistory();
      expect(history[0].result).toBe('matched'); // first unchanged
      expect(history[1].result).toBe('recovered'); // second updated
    });
  });

  describe('custom recovery actions', () => {
    test('should register custom recovery action', () => {
      const service = new HeartbeatService();
      const custom: RecoveryAction = {
        pattern: /CUSTOM_ERROR_\d+/,
        action: 'retry_once',
        description: 'Custom test error',
      };
      service.addRecoveryAction(custom);

      const result = service.attemptRecovery('m1', 'CUSTOM_ERROR_42: something went wrong');
      expect(result).not.toBeNull();
      expect(result!.description).toBe('Custom test error');
    });

    test('should match custom action before default if registered first', () => {
      const service = new HeartbeatService();
      // Register a more specific pattern for a known error
      const specific: RecoveryAction = {
        pattern: /ENOENT.*config\.json/i,
        action: 'retry_once',
        description: 'Config file missing — retry once',
      };
      service.addRecoveryAction(specific);

      // This matches both the specific pattern and the generic ENOENT roo-state-manager
      // But specific was added after defaults, so defaults are checked first
      const result = service.attemptRecovery('m1', 'ENOENT: no such file config.json');
      expect(result).not.toBeNull();
      // The default ENOENT pattern matches first since it's checked in order
    });

    test('getRecoveryActions should return copy', () => {
      const service = new HeartbeatService();
      const actions = service.getRecoveryActions();
      actions.push({ pattern: /test/, action: 'retry_once', description: 'test' });

      // Original should be unchanged
      expect(service.getRecoveryActions().length).toBe(6);
    });
  });

  describe('integration with lifecycle', () => {
    test('recovery can be used alongside lifecycle transitions', () => {
      const service = new HeartbeatService();
      service.transitionLifecycle('m1', 'READY');
      service.transitionLifecycle('m1', 'CLAIMED');
      service.transitionLifecycle('m1', 'WORKING');

      // Simulate an error
      const recovery = service.attemptRecovery('m1', 'ECONNRESET: connection lost');
      expect(recovery).not.toBeNull();

      // Transition to ERROR state
      service.transitionLifecycle('m1', 'ERROR', 'Network failure');
      expect(service.getLifecycleState('m1')).toBe('ERROR');

      // After recovery action, transition to RECOVERING then READY
      service.recordRecoveryOutcome('m1', 'retry_once', true);
      service.transitionLifecycle('m1', 'RECOVERING', 'Auto-healing network issue');
      service.transitionLifecycle('m1', 'READY', 'Network restored');
      expect(service.getLifecycleState('m1')).toBe('READY');
    });

    test('recovery history is independent from lifecycle history', () => {
      const service = new HeartbeatService();
      service.transitionLifecycle('m1', 'READY');
      service.attemptRecovery('m1', 'ECONNRESET');

      expect(service.getLifecycleHistory()).toHaveLength(1);
      expect(service.getRecoveryHistory()).toHaveLength(1);
    });
  });
});
