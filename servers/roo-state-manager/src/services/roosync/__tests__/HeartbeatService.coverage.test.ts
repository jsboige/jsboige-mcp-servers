/**
 * #833 Sprint C3 — HeartbeatService lifecycle + recovery branch coverage
 * (po-2026 lane `src/services/roosync/**`)
 *
 * The existing `HeartbeatService.test.ts` (46 tests) covers the ADR 008
 * in-memory passive model thoroughly — register/check/getState/scheduler
 * metrics (#1442)/status-change callbacks. It leaves the ENTIRE #1320
 * subsystem cold, however: the agent lifecycle state machine
 * (`transitionLifecycle`, VALID_TRANSITIONS, history bounding) and the
 * Recovery-Before-Escalation Pattern 3 layer (`attemptRecovery`,
 * `DEFAULT_RECOVERY_ACTIONS` regex matrix, `recordRecoveryOutcome`,
 * custom-action registration). This add-only file targets those residual
 * branches so a regression in the lifecycle validation or recovery
 * matching actually fails a test instead of silently passing through.
 *
 * Every assertion is anchored on a source line of `HeartbeatService.ts`.
 * Pure in-memory — no fs, no fake timers, no GDrive.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

import {
  HeartbeatService,
  HeartbeatServiceError,
} from '../HeartbeatService.js';
import type {
  AgentLifecycleState,
  RecoveryAction,
} from '../HeartbeatService.js';

describe('HeartbeatService — #1320 lifecycle + recovery coverage (source-grounded)', () => {
  let service: HeartbeatService;

  beforeEach(() => {
    service = new HeartbeatService();
  });

  // ============================================================
  // transitionLifecycle — auto-register (source L247-258)
  // ============================================================
  describe('transitionLifecycle — auto-register', () => {
    test('auto-registers an unknown machine with BOOTSTRAPPING initial state (L247-258)', () => {
      // Machine not yet known → auto-register at BOOTSTRAPPING, then transition.
      const event = service.transitionLifecycle('fresh-machine', 'READY');

      expect(event.fromState).toBe('BOOTSTRAPPING');
      expect(event.toState).toBe('READY');
      // State mutation: lifecycleState is now READY.
      expect(service.getLifecycleState('fresh-machine')).toBe('READY');
      // Machine now appears in heartbeat data (auto-registered).
      expect(service.getHeartbeatData('fresh-machine')).toBeDefined();
    });

    test('auto-register lowercases the machineId (L243, L256)', () => {
      service.transitionLifecycle('MY-MACHINE', 'READY');
      expect(service.getLifecycleState('my-machine')).toBe('READY');
    });
  });

  // ============================================================
  // transitionLifecycle — no-op same-state (source L262-265)
  // ============================================================
  describe('transitionLifecycle — no-op same-state', () => {
    test('returns a transition event without throwing when state is unchanged (L262-265)', () => {
      service.transitionLifecycle('m', 'READY'); // BOOTSTRAPPING → READY

      const cb = vi.fn();
      service.onLifecycleChange(cb);

      const ev = service.transitionLifecycle('m', 'READY'); // READY → READY = no-op

      // Source L264 returns a synthetic event (fromState === toState).
      expect(ev.fromState).toBe('READY');
      expect(ev.toState).toBe('READY');
      // No-op does NOT fire the lifecycle callback (early return before L296).
      expect(cb).not.toHaveBeenCalled();
      // No-op does NOT push a history entry (early return before L289).
      const history = service.getLifecycleHistory();
      expect(history).toHaveLength(1);
      expect(history[0].toState).toBe('READY');
    });
  });

  // ============================================================
  // transitionLifecycle — INVALID_TRANSITION throw (source L268-272)
  // ============================================================
  describe('transitionLifecycle — invalid transition', () => {
    test('throws HeartbeatServiceError(code=INVALID_TRANSITION) on a disallowed transition (L268-272)', () => {
      // Reach IDLE: BOOTSTRAPPING → READY → IDLE (both valid per L48-49).
      service.transitionLifecycle('m', 'READY');
      service.transitionLifecycle('m', 'IDLE');
      expect(service.getLifecycleState('m')).toBe('IDLE');

      // IDLE → WORKING is NOT in VALID_TRANSITIONS['IDLE'] = ['CLAIMED','READY','ERROR'] (L53).
      try {
        service.transitionLifecycle('m', 'WORKING');
        throw new Error('Expected transitionLifecycle to throw');
      } catch (e) {
        expect(e).toBeInstanceOf(HeartbeatServiceError);
        expect((e as HeartbeatServiceError).code).toBe('INVALID_TRANSITION');
        // Message is prefixed by the constructor (L119) and lists allowed transitions (L269).
        const msg = (e as Error).message;
        expect(msg).toContain('[HeartbeatService]');
        expect(msg).toContain('IDLE');
        expect(msg).toContain('WORKING');
      }
      // State is unchanged after a rejected transition.
      expect(service.getLifecycleState('m')).toBe('IDLE');
    });
  });

  // ============================================================
  // transitionLifecycle — event + state mutation + callback (L282-298)
  // ============================================================
  describe('transitionLifecycle — valid transition side-effects', () => {
    test('mutates lifecycleState, records metadata, and fires onLifecycleChange callback (L282-298)', () => {
      const cb = vi.fn();
      service.onLifecycleChange(cb);

      const event = service.transitionLifecycle('m', 'READY', 'initial bootstrap done');

      // State mutation (L282-285).
      const data = service.getHeartbeatData('m')!;
      expect(data.lifecycleState).toBe('READY');
      expect(data.metadata.lifecycleReason).toBe('initial bootstrap done');
      expect(data.metadata.lifecycleSince).toBeDefined();

      // Callback fired exactly once with the event (L296-298).
      expect(cb).toHaveBeenCalledTimes(1);
      const passed = cb.mock.calls[0][0];
      expect(passed).toMatchObject({
        machineId: 'm',
        fromState: 'BOOTSTRAPPING',
        toState: 'READY',
        reason: 'initial bootstrap done',
      });

      // Returned event mirrors the recorded one.
      expect(event.machineId).toBe('m');
      expect(event.timestamp).toBeDefined();
    });
  });

  // ============================================================
  // transitionLifecycle — history bounded at MAX_HISTORY (L289-292)
  // ============================================================
  describe('transitionLifecycle — history bounding', () => {
    test('lifecycle history is capped at MAX_HISTORY=100 entries (L289-292, L168)', () => {
      // Reach IDLE: BOOTSTRAPPING → READY → IDLE.
      service.transitionLifecycle('m', 'READY');
      service.transitionLifecycle('m', 'IDLE');

      // The IDLE → CLAIMED → WORKING → REPORTING → IDLE cycle is fully valid
      // (L50-53) and loops indefinitely, each step pushing one history entry.
      const cycle: AgentLifecycleState[] = ['CLAIMED', 'WORKING', 'REPORTING', 'IDLE'];
      for (let i = 0; i < 110; i++) {
        service.transitionLifecycle('m', cycle[i % cycle.length]);
      }

      // 2 (bootstrap path) + 110*4 = 442 events pushed, but slice(-100) bounds it (L291).
      const history = service.getLifecycleHistory();
      expect(history).toHaveLength(100);
      // The last entry is the most recent transition.
      expect(history[99].toState).toBe(cycle[(109) % cycle.length]);
    });
  });

  // ============================================================
  // getLifecycleState / getLifecycleHistory — queries + defensive copy
  // ============================================================
  describe('getLifecycleState / getLifecycleHistory', () => {
    test('getLifecycleState returns undefined for an unknown machine (L306-308)', () => {
      expect(service.getLifecycleState('never-seen')).toBeUndefined();
    });

    test('getLifecycleHistory(limit) returns the last N entries (L315)', () => {
      service.transitionLifecycle('m', 'READY');
      service.transitionLifecycle('m', 'IDLE');
      service.transitionLifecycle('m', 'CLAIMED');

      const limited = service.getLifecycleHistory(2);
      expect(limited).toHaveLength(2);
      // Last two transitions: IDLE→CLAIMED is the final one.
      expect(limited[1].toState).toBe('CLAIMED');
    });

    test('getLifecycleHistory returns a defensive copy (L316 spread)', () => {
      service.transitionLifecycle('m', 'READY');
      const before = service.getLifecycleHistory();
      const len = before.length;

      // Mutate the returned array — internal state must be unaffected.
      before.length = 0;
      before.push({} as never);

      expect(service.getLifecycleHistory()).toHaveLength(len);
    });
  });

  // ============================================================
  // attemptRecovery — DEFAULT_RECOVERY_ACTIONS regex matrix (L138-145, L342-361)
  // ============================================================
  describe('attemptRecovery — DEFAULT_RECOVERY_ACTIONS matrix', () => {
    const cases: Array<{ msg: string; action: RecoveryAction['action']; line: number }> = [
      { msg: 'ENOENT: no such file roo-state-manager/build/index.js', action: 'rebuild_mcp', line: 139 },
      { msg: 'fatal: remote error: upload-pack: not our ref abc123', action: 'reset_submodule', line: 140 },
      { msg: 'CONFLICT (content): Merge conflict in src/index.ts', action: 'rebase_git', line: 141 },
      { msg: 'Error: EBUSY: resource busy or locked .node binding', action: 'retry_once', line: 142 },
      { msg: 'rate.limit exceeded — HTTP 429 too many requests', action: 'retry_once', line: 143 },
      { msg: 'fetch failed: ECONNREFUSED 127.0.0.1:6333 (also ECONNRESET/ETIMEDOUT)', action: 'retry_once', line: 144 },
    ];

    for (const { msg, action, line } of cases) {
      test(`matches "${action}" for pattern at source L${line} (L342-343)`, () => {
        const attempt = service.attemptRecovery('m', msg);
        expect(attempt).not.toBeNull();
        expect(attempt!.machineId).toBe('m');
        expect(attempt!.matchedAction).toBe(action);
        expect(attempt!.result).toBe('matched'); // L350
        expect(attempt!.errorSignature).toBe(msg.slice(0, 200)); // L346
        expect(attempt!.timestamp).toBeDefined();
      });
    }

    test('returns null when no pattern matches (L364-365)', () => {
      const attempt = service.attemptRecovery('m', 'something completely unrelated to any known failure');
      expect(attempt).toBeNull();
      // No history recorded for a no-match.
      expect(service.getRecoveryHistory()).toHaveLength(0);
    });

    test('lowercases the machineId before recording (L339)', () => {
      const attempt = service.attemptRecovery('UPPER-MACHINE', 'ENOENT roo-state-manager');
      expect(attempt!.machineId).toBe('upper-machine');
    });
  });

  // ============================================================
  // attemptRecovery — recovery history bounded (L354-356, L171)
  // ============================================================
  describe('attemptRecovery — recovery history bounding', () => {
    test('recovery history is capped at MAX_RECOVERY_HISTORY=50 entries (L355-356)', () => {
      for (let i = 0; i < 55; i++) {
        // Same matching pattern each iteration — each push is one history entry.
        service.attemptRecovery('m', 'ENOENT roo-state-manager');
      }
      // 55 attempts, but slice(-50) bounds it (L356).
      expect(service.getRecoveryHistory()).toHaveLength(50);
    });
  });

  // ============================================================
  // recordRecoveryOutcome (L371-377)
  // ============================================================
  describe('recordRecoveryOutcome', () => {
    test('marks the latest matching attempt as recovered (L372-374)', () => {
      service.attemptRecovery('m', 'ENOENT roo-state-manager'); // result='matched'
      service.recordRecoveryOutcome('m', 'rebuild_mcp', true);

      const history = service.getRecoveryHistory();
      expect(history[0].result).toBe('recovered');
    });

    test('marks the latest matching attempt as failed (L374)', () => {
      service.attemptRecovery('m', 'ENOENT roo-state-manager');
      service.recordRecoveryOutcome('m', 'rebuild_mcp', false);

      expect(service.getRecoveryHistory()[0].result).toBe('failed');
    });

    test('targets only the LATEST matching attempt when several exist (L372 reverse().find)', () => {
      service.attemptRecovery('m', 'ENOENT roo-state-manager'); // #1 matched
      service.attemptRecovery('m', 'ENOENT roo-state-manager'); // #2 matched
      service.recordRecoveryOutcome('m', 'rebuild_mcp', true);   // marks #2

      const history = service.getRecoveryHistory();
      expect(history[0].result).toBe('matched'); // #1 untouched
      expect(history[1].result).toBe('recovered'); // #2 (latest) marked
    });

    test('is a no-op when no prior matching attempt exists (L373 falsy guard)', () => {
      // No attemptRecovery called for rebase_git → find returns undefined → no mutation, no throw.
      expect(() => service.recordRecoveryOutcome('m', 'rebase_git', true)).not.toThrow();
      expect(service.getRecoveryHistory()).toHaveLength(0);
    });

    test('is a no-op when the machine has never had any attempt', () => {
      expect(() => service.recordRecoveryOutcome('ghost', 'rebuild_mcp', false)).not.toThrow();
    });
  });

  // ============================================================
  // getRecoveryHistory — defensive copy (L383-384)
  // ============================================================
  describe('getRecoveryHistory', () => {
    test('returns a defensive copy (L384 spread)', () => {
      service.attemptRecovery('m', 'ENOENT roo-state-manager');
      const history = service.getRecoveryHistory();

      history.length = 0;
      history.push({} as never);

      expect(service.getRecoveryHistory()).toHaveLength(1);
    });
  });

  // ============================================================
  // addRecoveryAction / getRecoveryActions (L390-399)
  // ============================================================
  describe('addRecoveryAction / getRecoveryActions', () => {
    test('getRecoveryActions returns the 6 defaults by default (L178, L398)', () => {
      const actions = service.getRecoveryActions();
      expect(actions).toHaveLength(6);
      const described = actions.map((a) => a.action).sort();
      expect(described).toEqual(['rebase_git', 'rebuild_mcp', 'reset_submodule', 'retry_once', 'retry_once', 'retry_once']);
    });

    test('addRecoveryAction appends a custom action that then matches (L391)', () => {
      service.addRecoveryAction({
        pattern: /OOM|out of memory/i,
        action: 'retry_once',
        description: 'custom OOM handler',
      });

      // 6 defaults + 1 custom.
      expect(service.getRecoveryActions()).toHaveLength(7);

      const attempt = service.attemptRecovery('m', 'process killed: OOM (out of memory)');
      expect(attempt).not.toBeNull();
      expect(attempt!.matchedAction).toBe('retry_once');
      expect(attempt!.description).toBe('custom OOM handler');
    });

    test('getRecoveryActions returns a defensive copy (L398 spread)', () => {
      const actions = service.getRecoveryActions();
      actions.push({} as RecoveryAction);

      // Internal list unaffected.
      expect(service.getRecoveryActions()).toHaveLength(6);
    });
  });
});
