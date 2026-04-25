import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  NotificationService,
  NotificationEvent,
  NotificationListener,
  FilterRule
} from '../../../src/notifications/NotificationService.js';

function makeEvent(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    type: 'tool_used',
    source: 'test-tool',
    priority: 'MEDIUM',
    payload: {},
    timestamp: new Date().toISOString(),
    ...overrides
  };
}

function makeListener(): NotificationListener & { events: NotificationEvent[] } {
  const events: NotificationEvent[] = [];
  return {
    events,
    onNotify: vi.fn(async (event) => { events.push(event); })
  };
}

describe('NotificationService', () => {
  let service: NotificationService;

  beforeEach(() => {
    service = new NotificationService();
  });

  describe('subscribe / unsubscribe', () => {
    it('should add and remove listeners', () => {
      const listener = makeListener();
      service.subscribe(listener);
      expect(service.getStats().listenersCount).toBe(1);

      service.unsubscribe(listener);
      expect(service.getStats().listenersCount).toBe(0);
    });

    it('should not fail when unsubscribing unknown listener', () => {
      const listener = makeListener();
      service.unsubscribe(listener);
      expect(service.getStats().listenersCount).toBe(0);
    });

    it('should support multiple listeners', () => {
      const l1 = makeListener();
      const l2 = makeListener();
      service.subscribe(l1);
      service.subscribe(l2);
      expect(service.getStats().listenersCount).toBe(2);
    });
  });

  describe('notify without filter rules', () => {
    it('should emit event to all listeners when no rules loaded', async () => {
      const l1 = makeListener();
      const l2 = makeListener();
      service.subscribe(l1);
      service.subscribe(l2);

      const event = makeEvent();
      await service.notify(event);

      expect(l1.onNotify).toHaveBeenCalledWith(event);
      expect(l2.onNotify).toHaveBeenCalledWith(event);
    });

    it('should handle zero listeners gracefully', async () => {
      const event = makeEvent();
      await expect(service.notify(event)).resolves.toBeUndefined();
    });
  });

  describe('notify with filter rules', () => {
    const allowRule: FilterRule = {
      id: 'allow-all-tools',
      eventType: 'tool_used',
      condition: {},
      action: 'allow',
      notifyUser: false
    };

    const blockRule: FilterRule = {
      id: 'block-urgent',
      eventType: 'tool_used',
      condition: { priority: ['URGENT'] },
      action: 'block',
      notifyUser: false
    };

    const approvalRule: FilterRule = {
      id: 'approval-new-msg',
      eventType: 'new_message',
      condition: {},
      action: 'require_approval',
      notifyUser: false
    };

    it('should allow event matching an allow rule', async () => {
      const listener = makeListener();
      service.subscribe(listener);
      service.loadFilterRules([allowRule]);

      await service.notify(makeEvent());
      expect(listener.onNotify).toHaveBeenCalledTimes(1);
    });

    it('should block event matching a block rule', async () => {
      const listener = makeListener();
      service.subscribe(listener);
      service.loadFilterRules([blockRule]);

      await service.notify(makeEvent({ priority: 'URGENT' }));
      expect(listener.onNotify).not.toHaveBeenCalled();
    });

    it('should block by default when rules exist but none match', async () => {
      const listener = makeListener();
      service.subscribe(listener);
      service.loadFilterRules([blockRule]);

      // Event type 'new_message' doesn't match blockRule (which is for 'tool_used')
      await service.notify(makeEvent({ type: 'new_message' }));
      expect(listener.onNotify).not.toHaveBeenCalled();
    });

    it('should queue event for require_approval action', async () => {
      const listener = makeListener();
      service.subscribe(listener);
      service.loadFilterRules([approvalRule]);

      await service.notify(makeEvent({ type: 'new_message' }));
      expect(listener.onNotify).not.toHaveBeenCalled();
      expect(service.getStats().pendingApprovalsCount).toBe(1);
    });
  });

  describe('filter conditions', () => {
    it('should match by sourceTool condition', async () => {
      const listener = makeListener();
      service.subscribe(listener);

      const rule: FilterRule = {
        id: 'src-filter',
        eventType: 'tool_used',
        condition: { sourceTool: ['allowed-tool'] },
        action: 'allow',
        notifyUser: false
      };
      service.loadFilterRules([rule]);

      // Matching source
      await service.notify(makeEvent({ source: 'allowed-tool' }));
      expect(listener.onNotify).toHaveBeenCalledTimes(1);

      // Non-matching source
      await service.notify(makeEvent({ source: 'other-tool' }));
      expect(listener.onNotify).toHaveBeenCalledTimes(1); // still 1, blocked
    });

    it('should match by priority condition', async () => {
      const listener = makeListener();
      service.subscribe(listener);

      const rule: FilterRule = {
        id: 'prio-filter',
        eventType: 'tool_used',
        condition: { priority: ['HIGH', 'URGENT'] },
        action: 'allow',
        notifyUser: false
      };
      service.loadFilterRules([rule]);

      await service.notify(makeEvent({ priority: 'HIGH' }));
      expect(listener.onNotify).toHaveBeenCalledTimes(1);

      await service.notify(makeEvent({ priority: 'LOW' }));
      expect(listener.onNotify).toHaveBeenCalledTimes(1); // blocked
    });

    it('should match by tags condition', async () => {
      const listener = makeListener();
      service.subscribe(listener);

      const rule: FilterRule = {
        id: 'tag-filter',
        eventType: 'tool_used',
        condition: { tags: ['important'] },
        action: 'allow',
        notifyUser: false
      };
      service.loadFilterRules([rule]);

      await service.notify(makeEvent({ payload: { tags: ['important', 'info'] } }));
      expect(listener.onNotify).toHaveBeenCalledTimes(1);

      await service.notify(makeEvent({ payload: { tags: ['info'] } }));
      expect(listener.onNotify).toHaveBeenCalledTimes(1); // blocked
    });

    it('should use first matching rule (rule priority)', async () => {
      const listener = makeListener();
      service.subscribe(listener);

      const allowAll: FilterRule = {
        id: 'allow-all',
        eventType: 'tool_used',
        condition: {},
        action: 'allow',
        notifyUser: false
      };
      const blockAll: FilterRule = {
        id: 'block-all',
        eventType: 'tool_used',
        condition: {},
        action: 'block',
        notifyUser: false
      };

      // allow first → event emitted
      service.loadFilterRules([allowAll, blockAll]);
      await service.notify(makeEvent());
      expect(listener.onNotify).toHaveBeenCalledTimes(1);
    });
  });

  describe('pending approvals', () => {
    it('should approve pending event and emit to listeners', async () => {
      const listener = makeListener();
      service.subscribe(listener);

      const rule: FilterRule = {
        id: 'approval-rule',
        eventType: 'tool_used',
        condition: {},
        action: 'require_approval',
        notifyUser: false
      };
      service.loadFilterRules([rule]);

      const event = makeEvent();
      await service.notify(event);
      expect(service.getStats().pendingApprovalsCount).toBe(1);

      const approved = await service.approvePending(0);
      expect(approved).toBe(true);
      expect(listener.onNotify).toHaveBeenCalledWith(event);
      expect(service.getStats().pendingApprovalsCount).toBe(0);
    });

    it('should reject pending event without emitting', async () => {
      const listener = makeListener();
      service.subscribe(listener);

      const rule: FilterRule = {
        id: 'approval-rule',
        eventType: 'tool_used',
        condition: {},
        action: 'require_approval',
        notifyUser: false
      };
      service.loadFilterRules([rule]);

      await service.notify(makeEvent());
      expect(service.getStats().pendingApprovalsCount).toBe(1);

      const rejected = service.rejectPending(0);
      expect(rejected).toBe(true);
      expect(listener.onNotify).not.toHaveBeenCalled();
      expect(service.getStats().pendingApprovalsCount).toBe(0);
    });

    it('should return false for out-of-bounds approve/reject', async () => {
      await expect(service.approvePending(0)).resolves.toBe(false);
      expect(service.rejectPending(0)).toBe(false);
      await expect(service.approvePending(-1)).resolves.toBe(false);
    });
  });

  describe('getStats', () => {
    it('should return accurate stats', async () => {
      const listener = makeListener();
      service.subscribe(listener);

      const rule: FilterRule = {
        id: 'approval-rule',
        eventType: 'new_message',
        condition: {},
        action: 'require_approval',
        notifyUser: false
      };
      service.loadFilterRules([rule]);

      await service.notify(makeEvent({ type: 'new_message' }));

      const stats = service.getStats();
      expect(stats.listenersCount).toBe(1);
      expect(stats.rulesCount).toBe(1);
      expect(stats.rules).toHaveLength(1);
      expect(stats.pendingApprovalsCount).toBe(1);
      expect(stats.pendingApprovals).toHaveLength(1);
    });
  });
});
