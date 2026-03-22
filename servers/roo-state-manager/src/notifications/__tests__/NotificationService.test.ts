/**
 * Tests unitaires pour NotificationService
 *
 * Couvre :
 * - subscribe / unsubscribe
 * - loadFilterRules
 * - notify : bloc / allow / require_approval
 * - evaluateFilters : no rules, first match, no match (block)
 * - checkConditions : sourceTool, priority, tags
 * - showSystemNotification (via logger.debug spy)
 * - getStats
 *
 * @module notifications/__tests__/NotificationService.test
 * @version 1.0.0 (#492)
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

// ─────────────────── tests ───────────────────

describe('NotificationService', () => {

  // ============================================================
  // subscribe / unsubscribe
  // ============================================================

  describe('subscribe / unsubscribe', () => {
    test('subscribe ajoute un listener', () => {
      const { listener } = makeListener();
      service.subscribe(listener);
      expect(service.getStats().listenersCount).toBe(1);
    });

    test('unsubscribe retire un listener', () => {
      const { listener } = makeListener();
      service.subscribe(listener);
      service.unsubscribe(listener);
      expect(service.getStats().listenersCount).toBe(0);
    });

    test('unsubscribe listener non présent est sans effet', () => {
      const { listener } = makeListener();
      // Not subscribed - should not throw
      expect(() => service.unsubscribe(listener)).not.toThrow();
    });

    test('plusieurs listeners peuvent être ajoutés', () => {
      const { listener: l1 } = makeListener();
      const { listener: l2 } = makeListener();
      service.subscribe(l1);
      service.subscribe(l2);
      expect(service.getStats().listenersCount).toBe(2);
    });
  });

  // ============================================================
  // loadFilterRules
  // ============================================================

  describe('loadFilterRules', () => {
    test('charge les règles et les expose dans getStats', () => {
      const rules = [makeRule({ id: 'r1' }), makeRule({ id: 'r2' })];
      service.loadFilterRules(rules);
      expect(service.getStats().rulesCount).toBe(2);
      expect(service.getStats().rules).toEqual(rules);
    });

    test('remplace les règles précédentes', () => {
      service.loadFilterRules([makeRule({ id: 'old' })]);
      service.loadFilterRules([makeRule({ id: 'new-1' }), makeRule({ id: 'new-2' })]);
      expect(service.getStats().rulesCount).toBe(2);
    });
  });

  // ============================================================
  // notify - no filter rules
  // ============================================================

  describe('notify - sans règles', () => {
    test('notifie tous les listeners par défaut', async () => {
      const { listener, calls } = makeListener();
      service.subscribe(listener);
      const event = makeEvent();

      await service.notify(event);

      expect(calls.length).toBe(1);
      expect(calls[0]).toEqual(event);
    });

    test('plusieurs listeners reçoivent tous l\'événement', async () => {
      const { listener: l1, calls: c1 } = makeListener();
      const { listener: l2, calls: c2 } = makeListener();
      service.subscribe(l1);
      service.subscribe(l2);

      await service.notify(makeEvent());

      expect(c1.length).toBe(1);
      expect(c2.length).toBe(1);
    });
  });

  // ============================================================
  // notify - with filter rules (block)
  // ============================================================

  describe('notify - règle block', () => {
    test('ne notifie pas les listeners quand action=block', async () => {
      const { listener } = makeListener();
      service.subscribe(listener);
      service.loadFilterRules([makeRule({ action: 'block' })]);

      await service.notify(makeEvent());

      expect(listener.onNotify).not.toHaveBeenCalled();
    });

    test('bloque par défaut quand aucune règle ne matche (whitelist)', async () => {
      const { listener } = makeListener();
      service.subscribe(listener);
      service.loadFilterRules([makeRule({ eventType: 'new_message' })]); // Different type

      await service.notify(makeEvent({ type: 'tool_used' }));

      expect(listener.onNotify).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // notify - with filter rules (allow)
  // ============================================================

  describe('notify - règle allow', () => {
    test('notifie les listeners quand action=allow', async () => {
      const { listener, calls } = makeListener();
      service.subscribe(listener);
      service.loadFilterRules([makeRule({ action: 'allow' })]);

      await service.notify(makeEvent());

      expect(calls.length).toBe(1);
    });

    test('utilise la première règle qui matche', async () => {
      const { listener } = makeListener();
      service.subscribe(listener);
      service.loadFilterRules([
        makeRule({ id: 'first', action: 'block' }),
        makeRule({ id: 'second', action: 'allow' }),
      ]);

      await service.notify(makeEvent());

      // First matching rule is 'block'
      expect(listener.onNotify).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // notify - require_approval
  // ============================================================

  describe('notify - require_approval', () => {
    test('queues event for approval instead of immediate notification', async () => {
      const { listener, calls } = makeListener();
      service.subscribe(listener);
      service.loadFilterRules([makeRule({ action: 'require_approval' })]);

      await service.notify(makeEvent());

      // require_approval queues — does NOT notify listeners yet
      expect(calls.length).toBe(0);
      expect(service.getStats().pendingApprovalsCount).toBe(1);

      // Approve the pending notification — now it should notify
      await service.approvePending(0);
      expect(calls.length).toBe(1);
      expect(service.getStats().pendingApprovalsCount).toBe(0);
    });

    test('rejectPending removes without notifying', async () => {
      const { listener, calls } = makeListener();
      service.subscribe(listener);
      service.loadFilterRules([makeRule({ action: 'require_approval' })]);

      await service.notify(makeEvent());
      expect(service.getStats().pendingApprovalsCount).toBe(1);

      service.rejectPending(0);
      expect(calls.length).toBe(0);
      expect(service.getStats().pendingApprovalsCount).toBe(0);
    });

    test('approvePending returns false for invalid index', async () => {
      const result = await service.approvePending(99);
      expect(result).toBe(false);
    });
  });

  // ============================================================
  // checkConditions - sourceTool
  // ============================================================

  describe('checkConditions - sourceTool', () => {
    test('sourceTool défini : accepte si source matche', async () => {
      const { listener, calls } = makeListener();
      service.subscribe(listener);
      service.loadFilterRules([
        makeRule({
          action: 'allow',
          condition: { sourceTool: ['read_file', 'write_file'] },
        }),
      ]);

      await service.notify(makeEvent({ source: 'read_file' }));

      expect(calls.length).toBe(1);
    });

    test('sourceTool défini : bloque si source ne matche pas', async () => {
      const { listener } = makeListener();
      service.subscribe(listener);
      service.loadFilterRules([
        makeRule({
          action: 'allow',
          condition: { sourceTool: ['write_file'] },
        }),
      ]);

      await service.notify(makeEvent({ source: 'read_file' }));

      expect(listener.onNotify).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // checkConditions - priority
  // ============================================================

  describe('checkConditions - priority', () => {
    test('priority définie : accepte si priorité matche', async () => {
      const { listener, calls } = makeListener();
      service.subscribe(listener);
      service.loadFilterRules([
        makeRule({
          action: 'allow',
          condition: { priority: ['HIGH', 'URGENT'] },
        }),
      ]);

      await service.notify(makeEvent({ priority: 'HIGH' }));

      expect(calls.length).toBe(1);
    });

    test('priority définie : bloque si priorité ne matche pas', async () => {
      const { listener } = makeListener();
      service.subscribe(listener);
      service.loadFilterRules([
        makeRule({
          action: 'allow',
          condition: { priority: ['HIGH', 'URGENT'] },
        }),
      ]);

      await service.notify(makeEvent({ priority: 'LOW' }));

      expect(listener.onNotify).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // checkConditions - tags
  // ============================================================

  describe('checkConditions - tags', () => {
    test('tags définis : accepte si payload contient le tag requis', async () => {
      const { listener, calls } = makeListener();
      service.subscribe(listener);
      service.loadFilterRules([
        makeRule({
          action: 'allow',
          condition: { tags: ['important'] },
        }),
      ]);

      await service.notify(makeEvent({ payload: { tags: ['important', 'other'] } }));

      expect(calls.length).toBe(1);
    });

    test('tags définis : bloque si payload ne contient pas le tag', async () => {
      const { listener } = makeListener();
      service.subscribe(listener);
      service.loadFilterRules([
        makeRule({
          action: 'allow',
          condition: { tags: ['important'] },
        }),
      ]);

      await service.notify(makeEvent({ payload: { tags: ['other'] } }));

      expect(listener.onNotify).not.toHaveBeenCalled();
    });

    test('tags définis : bloque si payload.tags absent', async () => {
      const { listener } = makeListener();
      service.subscribe(listener);
      service.loadFilterRules([
        makeRule({
          action: 'allow',
          condition: { tags: ['important'] },
        }),
      ]);

      await service.notify(makeEvent({ payload: {} }));

      expect(listener.onNotify).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // notifyUser : showSystemNotification
  // ============================================================

  describe('notifyUser - showSystemNotification', () => {
    test('notifyUser=true déclenche la notification système (sans erreur)', async () => {
      service.subscribe(makeListener().listener);
      service.loadFilterRules([makeRule({ notifyUser: true })]);

      // Should not throw
      await expect(service.notify(makeEvent())).resolves.toBeUndefined();
    });
  });

  // ============================================================
  // getStats
  // ============================================================

  describe('getStats', () => {
    test('retourne listenersCount correct', () => {
      const { listener } = makeListener();
      service.subscribe(listener);
      expect(service.getStats().listenersCount).toBe(1);
    });

    test('retourne rulesCount correct', () => {
      service.loadFilterRules([makeRule(), makeRule({ id: 'r2' })]);
      expect(service.getStats().rulesCount).toBe(2);
    });

    test('retourne les règles complètes', () => {
      const rules = [makeRule({ id: 'r1' })];
      service.loadFilterRules(rules);
      expect(service.getStats().rules).toBe(rules);
    });

    test('stats vides par défaut', () => {
      const stats = service.getStats();
      expect(stats.listenersCount).toBe(0);
      expect(stats.rulesCount).toBe(0);
      expect(stats.rules).toEqual([]);
    });
  });
});
