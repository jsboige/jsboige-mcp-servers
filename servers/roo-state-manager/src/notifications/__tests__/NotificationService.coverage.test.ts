/**
 * #833 Sprint C3 — NotificationService branch coverage (po-2026 lane `notifications/**`)
 *
 * The existing `NotificationService.test.ts` (27 tests) covers the main paths but
 * leaves several branches unexercised or only weakly asserted:
 *
 * - `showSystemNotification` prefix selection (source L289): URGENT→🔴, HIGH→🟠,
 *   default→🔵. The base suite only asserts `notify()` "does not throw" when
 *   `notifyUser: true` — it never pins which emoji prefix is emitted, so a swap of
 *   the priority→emoji mapping would pass silently.
 * - `showSystemNotification` payload formatting (source L290 ternary): the
 *   `typeof payload === 'string'` arm is never hit (base suite always passes
 *   object payloads).
 * - `rejectPending` out-of-range (source L279-280): the base suite only calls
 *   `rejectPending(0)` on a non-empty queue; the `false` return for an invalid
 *   index is unasserted.
 * - `approvePending` negative index (source L265 `index < 0`): the base suite
 *   tests index 99 (high out-of-range) but never a negative index.
 * - `checkConditions` empty-array conditions (source L231/L238/L245
 *   `.length > 0` guards): an empty array means "no restriction" (skip → true).
 *   The base suite always passes non-empty arrays.
 * - `evaluateFilters` second-rule match after first type-mismatch (source L198-199
 *   `continue` then L205-212 match): the base "first matching rule" test uses two
 *   rules of the SAME eventType; the continue-then-match-on-next path is untested.
 * - `getStats.pendingApprovals` content (source L309/L316): the base suite checks
 *   `pendingApprovalsCount` but never the array shape (ruleId/timestamp).
 *
 * Every assertion is anchored on a source line of `NotificationService.ts`.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { NotificationService } from '../NotificationService.js';
import type { NotificationEvent, FilterRule, NotificationListener } from '../NotificationService.js';

// ─────────────────── helpers ───────────────────

function makeEvent(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    type: 'tool_used',
    source: 'read_file',
    priority: 'MEDIUM',
    payload: {},
    timestamp: '2026-01-01T10:00:00.000Z',
    ...overrides,
  };
}

function makeRule(overrides: Partial<FilterRule> = {}): FilterRule {
  return {
    id: 'rule-1',
    eventType: 'tool_used',
    condition: {},
    action: 'allow',
    notifyUser: false,
    ...overrides,
  };
}

function makeListener(): { listener: NotificationListener; calls: NotificationEvent[] } {
  const calls: NotificationEvent[] = [];
  const listener: NotificationListener = {
    onNotify: vi.fn(async (event) => { calls.push(event); }),
  };
  return { listener, calls };
}

// ─────────────────── setup ───────────────────

let service: NotificationService;

beforeEach(() => {
  service = new NotificationService();
  vi.clearAllMocks();
});

describe('NotificationService — branch coverage (#833 C3, source-grounded)', () => {

  // ============================================================
  // showSystemNotification — priority→prefix mapping (source L289)
  // ============================================================

  describe('showSystemNotification prefix selection (L289)', () => {
    // showSystemNotification writes to console.error (L292). Spy on it to pin the
    // exact prefix emitted for each priority tier.
    test('URGENT priority emits the 🔴 prefix (L289)', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      service.subscribe(makeListener().listener);
      service.loadFilterRules([makeRule({ notifyUser: true })]);

      await service.notify(makeEvent({ priority: 'URGENT' }));

      const line = errSpy.mock.calls.map(c => String(c[0])).find(s => s.includes('[NOTIFICATION]'));
      expect(line).toBeDefined();
      expect(line).toContain('🔴');
      errSpy.mockRestore();
    });

    test('HIGH priority emits the 🟠 prefix (L289)', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      service.subscribe(makeListener().listener);
      service.loadFilterRules([makeRule({ notifyUser: true })]);

      await service.notify(makeEvent({ priority: 'HIGH' }));

      const line = errSpy.mock.calls.map(c => String(c[0])).find(s => s.includes('[NOTIFICATION]'));
      expect(line).toBeDefined();
      expect(line).toContain('🟠');
      errSpy.mockRestore();
    });

    test('MEDIUM/LOW priority emits the default 🔵 prefix (L289)', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      service.subscribe(makeListener().listener);
      service.loadFilterRules([makeRule({ notifyUser: true })]);

      await service.notify(makeEvent({ priority: 'MEDIUM' }));

      const line = errSpy.mock.calls.map(c => String(c[0])).find(s => s.includes('[NOTIFICATION]'));
      expect(line).toBeDefined();
      // MEDIUM (and LOW) fall to the default 🔵 branch.
      expect(line).toContain('🔵');
      errSpy.mockRestore();
    });
  });

  // ============================================================
  // showSystemNotification — payload string vs object (source L290)
  // ============================================================

  describe('showSystemNotification payload formatting (L290)', () => {
    test('string payload is emitted verbatim (L290 typeof string arm)', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      service.subscribe(makeListener().listener);
      service.loadFilterRules([makeRule({ notifyUser: true })]);

      await service.notify(makeEvent({ payload: 'a plain string message' }));

      const line = errSpy.mock.calls.map(c => String(c[0])).find(s => s.includes('[NOTIFICATION]'));
      expect(line).toBeDefined();
      // String arm: emitted as-is, NOT JSON.stringify'd (no surrounding quotes).
      expect(line).toContain('a plain string message');
      expect(line).not.toContain('"a plain string message"');
      errSpy.mockRestore();
    });

    test('object payload is JSON.stringified (L290 object arm)', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      service.subscribe(makeListener().listener);
      service.loadFilterRules([makeRule({ notifyUser: true })]);

      await service.notify(makeEvent({ payload: { key: 'value', n: 42 } }));

      const line = errSpy.mock.calls.map(c => String(c[0])).find(s => s.includes('[NOTIFICATION]'));
      expect(line).toBeDefined();
      // Object arm: JSON.stringify → quoted keys, braces.
      expect(line).toContain('{"key":"value","n":42}');
      errSpy.mockRestore();
    });
  });

  // ============================================================
  // rejectPending — out-of-range returns false (source L279-280)
  // ============================================================

  describe('rejectPending out-of-range (L279-280)', () => {
    test('rejectPending returns false for an invalid (high) index on empty queue', () => {
      // Empty queue → any index is out of range.
      expect(service.rejectPending(0)).toBe(false);
      expect(service.getStats().pendingApprovalsCount).toBe(0);
    });

    test('rejectPending returns false for an index beyond queue length', async () => {
      service.subscribe(makeListener().listener);
      service.loadFilterRules([makeRule({ action: 'require_approval' })]);
      await service.notify(makeEvent()); // queue length = 1

      // Index 5 is beyond the single-element queue.
      expect(service.rejectPending(5)).toBe(false);
      // Queue untouched.
      expect(service.getStats().pendingApprovalsCount).toBe(1);
    });

    test('rejectPending returns false for a negative index', () => {
      // L279 `index < 0` guard.
      expect(service.rejectPending(-1)).toBe(false);
    });
  });

  // ============================================================
  // approvePending — negative index (source L265 index < 0)
  // ============================================================

  describe('approvePending negative index (L265)', () => {
    test('approvePending returns false for a negative index', async () => {
      const result = await service.approvePending(-1);
      expect(result).toBe(false);
    });
  });

  // ============================================================
  // checkConditions — empty-array conditions = no restriction (L231/L238/L245)
  // ============================================================

  describe('checkConditions empty-array = no restriction', () => {
    test('empty sourceTool array does not restrict (L231 length>0 guard skips)', async () => {
      const { listener, calls } = makeListener();
      service.subscribe(listener);
      // Empty sourceTool → the `.length > 0` guard is FALSE → condition skipped → match.
      service.loadFilterRules([makeRule({ action: 'allow', condition: { sourceTool: [] } })]);

      await service.notify(makeEvent({ source: 'literally-anything' }));

      expect(calls.length).toBe(1);
    });

    test('empty priority array does not restrict (L238 length>0 guard skips)', async () => {
      const { listener, calls } = makeListener();
      service.subscribe(listener);
      service.loadFilterRules([makeRule({ action: 'allow', condition: { priority: [] } })]);

      await service.notify(makeEvent({ priority: 'LOW' }));

      expect(calls.length).toBe(1);
    });

    test('empty tags array does not restrict (L245 length>0 guard skips)', async () => {
      const { listener, calls } = makeListener();
      service.subscribe(listener);
      service.loadFilterRules([makeRule({ action: 'allow', condition: { tags: [] } })]);

      // payload has NO tags at all — empty-condition must still match.
      await service.notify(makeEvent({ payload: {} }));

      expect(calls.length).toBe(1);
    });
  });

  // ============================================================
  // evaluateFilters — second rule matches after first type-mismatch (L198-199 → L205)
  // ============================================================

  describe('evaluateFilters continue-then-match on next rule (L198-199 → L205)', () => {
    test('first rule skipped on type mismatch, second rule (matching type) decides allow', async () => {
      const { listener, calls } = makeListener();
      service.subscribe(listener);
      service.loadFilterRules([
        // Rule 1: different eventType → L198 `rule.eventType !== event.type` → continue.
        makeRule({ id: 'wrong-type', eventType: 'new_message', action: 'block' }),
        // Rule 2: matching eventType → L205 matchesConditions → allow.
        makeRule({ id: 'right-type', eventType: 'tool_used', action: 'allow' }),
      ]);

      await service.notify(makeEvent({ type: 'tool_used' }));

      // The continue-then-match path lands on rule 2 → allow → listener notified.
      expect(calls.length).toBe(1);
    });
  });

  // ============================================================
  // getStats — pendingApprovals array content (L309/L316)
  // ============================================================

  describe('getStats pendingApprovals content (L309/L316)', () => {
    test('pendingApprovals exposes queued event with ruleId and timestamp', async () => {
      service.subscribe(makeListener().listener);
      service.loadFilterRules([makeRule({ id: 'approval-rule', action: 'require_approval' })]);

      const event = makeEvent({ source: 'write_file', priority: 'HIGH' });
      await service.notify(event);

      const stats = service.getStats();
      expect(stats.pendingApprovalsCount).toBe(1);
      expect(stats.pendingApprovals).toHaveLength(1);
      // L152-156: queued entry carries event + ruleId + timestamp.
      const pending = stats.pendingApprovals[0];
      expect(pending.event).toEqual(event);
      expect(pending.ruleId).toBe('approval-rule');
      expect(pending.timestamp).toBeTruthy();
      // Timestamp must be a valid ISO date (L155 new Date().toISOString()).
      expect(new Date(pending.timestamp).getTime()).not.toBeNaN();
    });
  });
});
