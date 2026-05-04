/**
 * Tests unitaires pour ToolUsageInterceptor v2
 *
 * FIX #1356 v2: Inbox check moved to background interval.
 * Tests verify:
 * - interceptToolCall is zero-I/O for inbox (no readInbox call)
 * - Background interval triggers inbox checks
 * - dispose() cleans up interval
 * - updateConfig toggles background check
 * - Notification emission via background path
 * - Cache refresh still works (non-blocking)
 * - Error resilience
 *
 * @module notifications/__tests__/ToolUsageInterceptor.test
 * @version 2.0.0
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// ─────────────────── mocks (vi.hoisted pour éviter TDZ) ───────────────────

const { mockScanDiskForNewTasks } = vi.hoisted(() => ({
  mockScanDiskForNewTasks: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../tools/task/disk-scanner.js', () => ({
  scanDiskForNewTasks: (...args: any[]) => mockScanDiskForNewTasks(...args),
}));

vi.mock('../../utils/message-helpers.js', () => ({
  getLocalWorkspaceId: () => 'test-workspace',
}));

import { ToolUsageInterceptor } from '../ToolUsageInterceptor.js';
import { NotificationService } from '../NotificationService.js';
import type { InterceptorConfig } from '../ToolUsageInterceptor.js';
import type { ConversationSkeleton } from '../../types/conversation.js';

// ─────────────────── helpers ───────────────────

/** Flush microtask queue (needed with vi.useFakeTimers for async chains) */
const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

function makeConfig(overrides: Partial<InterceptorConfig> = {}): InterceptorConfig {
  return {
    machineId: 'test-machine',
    checkInbox: false,
    refreshCache: false,
    minPriority: 'MEDIUM',
    ...overrides,
  };
}

function makeMockMessageManager(
  unreadItems: Array<{ id: string }> = [],
  messageMap: Record<string, any> = {}
) {
  return {
    readInbox: vi.fn().mockResolvedValue(unreadItems),
    getMessage: vi.fn((id: string) => Promise.resolve(messageMap[id] ?? null)),
  };
}

function makeMessage(overrides: any = {}) {
  return {
    id: 'msg-1',
    from: 'myia-ai-01',
    to: 'test-machine',
    subject: 'Test subject',
    body: 'Test body',
    priority: 'MEDIUM' as const,
    status: 'unread' as const,
    timestamp: '2026-01-01T10:00:00.000Z',
    ...overrides,
  };
}

// ─────────────────── setup ───────────────────

let notificationService: NotificationService;
let conversationCache: Map<string, ConversationSkeleton>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  notificationService = new NotificationService();
  conversationCache = new Map();
  mockScanDiskForNewTasks.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

// ─────────────────── tests ───────────────────

describe('ToolUsageInterceptor', () => {

  // ============================================================
  // Constructor / getStats
  // ============================================================

  describe('constructor + getStats', () => {
    test('initialise avec la configuration fournie', () => {
      const config = makeConfig({ machineId: 'my-machine', checkInbox: true });
      const interceptor = new ToolUsageInterceptor(
        notificationService,
        makeMockMessageManager() as any,
        conversationCache,
        config
      );
      interceptor.dispose();

      const stats = interceptor.getStats();
      expect(stats.config.machineId).toBe('my-machine');
      expect(stats.config.checkInbox).toBe(true);
    });

    test('isActive = true si checkInbox=true', () => {
      const interceptor = new ToolUsageInterceptor(
        notificationService,
        makeMockMessageManager() as any,
        conversationCache,
        makeConfig({ checkInbox: true })
      );
      interceptor.dispose();
      expect(interceptor.getStats().isActive).toBe(true);
    });

    test('isActive = true si refreshCache=true', () => {
      const interceptor = new ToolUsageInterceptor(
        notificationService,
        makeMockMessageManager() as any,
        conversationCache,
        makeConfig({ refreshCache: true })
      );
      expect(interceptor.getStats().isActive).toBe(true);
    });

    test('isActive = false si tout est désactivé', () => {
      const interceptor = new ToolUsageInterceptor(
        notificationService,
        makeMockMessageManager() as any,
        conversationCache,
        makeConfig({ checkInbox: false, refreshCache: false })
      );
      expect(interceptor.getStats().isActive).toBe(false);
    });
  });

  // ============================================================
  // updateConfig
  // ============================================================

  describe('updateConfig', () => {
    test('met à jour la configuration partiellement', () => {
      const interceptor = new ToolUsageInterceptor(
        notificationService,
        makeMockMessageManager() as any,
        conversationCache,
        makeConfig({ machineId: 'original' })
      );

      interceptor.updateConfig({ machineId: 'updated' });

      expect(interceptor.getStats().config.machineId).toBe('updated');
    });

    test('préserve les autres propriétés de config', () => {
      const interceptor = new ToolUsageInterceptor(
        notificationService,
        makeMockMessageManager() as any,
        conversationCache,
        makeConfig({ checkInbox: true, refreshCache: true })
      );
      interceptor.dispose();

      interceptor.updateConfig({ machineId: 'new-machine' });

      expect(interceptor.getStats().config.checkInbox).toBe(true);
      expect(interceptor.getStats().config.refreshCache).toBe(true);
      interceptor.dispose();
    });

    test('enables background check when checkInbox toggled on', async () => {
      const msgManager = makeMockMessageManager();
      const interceptor = new ToolUsageInterceptor(
        notificationService,
        msgManager as any,
        conversationCache,
        makeConfig({ checkInbox: false })
      );

      // No inbox check initially
      await interceptor.interceptToolCall('tool', {}, async () => 'ok');
      expect(msgManager.readInbox).not.toHaveBeenCalled();

      // Toggle on
      interceptor.updateConfig({ checkInbox: true });

      // Trigger the initial delay (5s)
      await vi.advanceTimersByTimeAsync(6_000);
      expect(msgManager.readInbox).toHaveBeenCalledTimes(1);

      interceptor.dispose();
    });

    test('disposes background check when checkInbox toggled off', async () => {
      const msgManager = makeMockMessageManager();
      const interceptor = new ToolUsageInterceptor(
        notificationService,
        msgManager as any,
        conversationCache,
        makeConfig({ checkInbox: true })
      );

      // Trigger initial check
      await vi.advanceTimersByTimeAsync(6_000);
      expect(msgManager.readInbox).toHaveBeenCalledTimes(1);

      // Toggle off
      interceptor.updateConfig({ checkInbox: false });

      // Advance past interval — should NOT trigger another check
      await vi.advanceTimersByTimeAsync(70_000);
      expect(msgManager.readInbox).toHaveBeenCalledTimes(1);
    });
  });

  // ============================================================
  // interceptToolCall - basic execution
  // ============================================================

  describe('interceptToolCall - exécution de base', () => {
    test('exécute la fonction et retourne son résultat', async () => {
      const interceptor = new ToolUsageInterceptor(
        notificationService,
        makeMockMessageManager() as any,
        conversationCache,
        makeConfig()
      );

      const result = await interceptor.interceptToolCall('my_tool', {}, async () => 'expected-result');

      expect(result).toBe('expected-result');
    });

    test("propage l'erreur de la fonction execute", async () => {
      const interceptor = new ToolUsageInterceptor(
        notificationService,
        makeMockMessageManager() as any,
        conversationCache,
        makeConfig()
      );

      await expect(
        interceptor.interceptToolCall('bad_tool', {}, async () => {
          throw new Error('Tool execution failed');
        })
      ).rejects.toThrow('Tool execution failed');
    });

    test('fonctionne avec refreshCache=false et checkInbox=false', async () => {
      const interceptor = new ToolUsageInterceptor(
        notificationService,
        makeMockMessageManager() as any,
        conversationCache,
        makeConfig({ refreshCache: false, checkInbox: false })
      );

      const result = await interceptor.interceptToolCall('tool', {}, async () => 42);

      expect(result).toBe(42);
      expect(mockScanDiskForNewTasks).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // FIX #1356 v2: interceptToolCall does NOT call readInbox
  // ============================================================

  describe('interceptToolCall - zero I/O for inbox', () => {
    test('readInbox is NOT called during interceptToolCall', async () => {
      const msgManager = makeMockMessageManager();
      const interceptor = new ToolUsageInterceptor(
        notificationService,
        msgManager as any,
        conversationCache,
        makeConfig({ checkInbox: true })
      );

      await interceptor.interceptToolCall('tool', {}, async () => 'ok');
      await interceptor.interceptToolCall('tool2', {}, async () => 'ok2');
      await interceptor.interceptToolCall('tool3', {}, async () => 'ok3');

      // Tool calls should NOT trigger readInbox
      expect(msgManager.readInbox).not.toHaveBeenCalled();

      interceptor.dispose();
    });
  });

  // ============================================================
  // interceptToolCall - refreshCache=true
  // ============================================================

  describe('interceptToolCall - refreshCache=true', () => {
    test('appelle scanDiskForNewTasks (non-bloquant)', async () => {
      const interceptor = new ToolUsageInterceptor(
        notificationService,
        makeMockMessageManager() as any,
        conversationCache,
        makeConfig({ refreshCache: true })
      );

      await interceptor.interceptToolCall('tool', {}, async () => 'ok');

      await vi.advanceTimersByTimeAsync(10);
      expect(mockScanDiskForNewTasks).toHaveBeenCalled();
    });

    test('ne bloque pas si scanDiskForNewTasks échoue', async () => {
      mockScanDiskForNewTasks.mockRejectedValue(new Error('Scan error'));
      const interceptor = new ToolUsageInterceptor(
        notificationService,
        makeMockMessageManager() as any,
        conversationCache,
        makeConfig({ refreshCache: true })
      );

      const result = await interceptor.interceptToolCall('tool', {}, async () => 'ok');
      expect(result).toBe('ok');
    });
  });

  // ============================================================
  // Background inbox check
  // ============================================================

  describe('background inbox check', () => {
    test('first check fires after initial delay', async () => {
      const msgManager = makeMockMessageManager([]);
      const interceptor = new ToolUsageInterceptor(
        notificationService,
        msgManager as any,
        conversationCache,
        makeConfig({ checkInbox: true })
      );

      // Before delay
      expect(msgManager.readInbox).not.toHaveBeenCalled();

      // After initial delay (5s)
      await vi.advanceTimersByTimeAsync(6_000);
      expect(msgManager.readInbox).toHaveBeenCalledTimes(1);

      interceptor.dispose();
    });

    test('subsequent checks fire at interval', async () => {
      const msgManager = makeMockMessageManager([]);
      const interceptor = new ToolUsageInterceptor(
        notificationService,
        msgManager as any,
        conversationCache,
        makeConfig({ checkInbox: true })
      );

      // Initial delay
      await vi.advanceTimersByTimeAsync(6_000);
      expect(msgManager.readInbox).toHaveBeenCalledTimes(1);

      // First interval
      await vi.advanceTimersByTimeAsync(60_000);
      expect(msgManager.readInbox).toHaveBeenCalledTimes(2);

      // Second interval
      await vi.advanceTimersByTimeAsync(60_000);
      expect(msgManager.readInbox).toHaveBeenCalledTimes(3);

      interceptor.dispose();
    });

    test('avec nouveaux messages : émet une notification', async () => {
      const msg = makeMessage({ id: 'msg-1', priority: 'HIGH' });
      const msgManager = makeMockMessageManager([{ id: 'msg-1' }], { 'msg-1': msg });
      const notifySpy = vi.spyOn(notificationService, 'notify').mockResolvedValue(undefined);

      notificationService.loadFilterRules([{
        id: 'allow-all', eventType: 'new_message', condition: {},
        action: 'allow', notifyUser: false,
      }]);

      const interceptor = new ToolUsageInterceptor(
        notificationService,
        msgManager as any,
        conversationCache,
        makeConfig({ checkInbox: true, minPriority: 'LOW' })
      );

      // Trigger initial delay + let async chain resolve
      await vi.advanceTimersByTimeAsync(6_000);
      // Allow the promise chain (readInbox → getMessage → notifyNewMessages) to settle
      await flushMicrotasks();
      // Flush remaining microtasks
      await vi.advanceTimersByTimeAsync(0);

      expect(notifySpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'new_message' })
      );

      interceptor.dispose();
    });

    test('sans nouveaux messages : ne notifie pas', async () => {
      const msgManager = makeMockMessageManager([]);
      const notifySpy = vi.spyOn(notificationService, 'notify');

      const interceptor = new ToolUsageInterceptor(
        notificationService,
        msgManager as any,
        conversationCache,
        makeConfig({ checkInbox: true })
      );

      await vi.advanceTimersByTimeAsync(6_000);

      expect(notifySpy).not.toHaveBeenCalled();

      interceptor.dispose();
    });

    test('déduit les messages déjà notifiés', async () => {
      const msg = makeMessage({ id: 'msg-1', priority: 'HIGH' });
      const msgManager = makeMockMessageManager([{ id: 'msg-1' }], { 'msg-1': msg });
      const notifySpy = vi.spyOn(notificationService, 'notify').mockResolvedValue(undefined);

      notificationService.loadFilterRules([{
        id: 'allow-all', eventType: 'new_message', condition: {},
        action: 'allow', notifyUser: false,
      }]);

      const interceptor = new ToolUsageInterceptor(
        notificationService,
        msgManager as any,
        conversationCache,
        makeConfig({ checkInbox: true, minPriority: 'LOW' })
      );

      // First check — notifies
      await vi.advanceTimersByTimeAsync(6_000);
      await flushMicrotasks();
      expect(notifySpy).toHaveBeenCalledTimes(1);

      // Second check — same message, should NOT notify again
      notifySpy.mockClear();
      await vi.advanceTimersByTimeAsync(60_000);
      await flushMicrotasks();
      expect(notifySpy).not.toHaveBeenCalled();

      interceptor.dispose();
    });

    test('erreur readInbox ne crash pas le background check', async () => {
      const msgManager = makeMockMessageManager();
      msgManager.readInbox.mockRejectedValue(new Error('GDrive down'));

      const interceptor = new ToolUsageInterceptor(
        notificationService,
        msgManager as any,
        conversationCache,
        makeConfig({ checkInbox: true })
      );

      // Should not throw
      await vi.advanceTimersByTimeAsync(6_000);

      // Subsequent interval should still fire (resilient)
      await vi.advanceTimersByTimeAsync(60_000);
      expect(msgManager.readInbox).toHaveBeenCalledTimes(2);

      interceptor.dispose();
    });
  });

  // ============================================================
  // dispose
  // ============================================================

  describe('dispose', () => {
    test('stops background interval', async () => {
      const msgManager = makeMockMessageManager([]);
      const interceptor = new ToolUsageInterceptor(
        notificationService,
        msgManager as any,
        conversationCache,
        makeConfig({ checkInbox: true })
      );

      // Trigger initial check
      await vi.advanceTimersByTimeAsync(6_000);
      expect(msgManager.readInbox).toHaveBeenCalledTimes(1);

      interceptor.dispose();

      // Advance past interval — should NOT trigger another check
      await vi.advanceTimersByTimeAsync(120_000);
      expect(msgManager.readInbox).toHaveBeenCalledTimes(1);
    });

    test('safe to call dispose when no interval active', () => {
      const interceptor = new ToolUsageInterceptor(
        notificationService,
        makeMockMessageManager() as any,
        conversationCache,
        makeConfig({ checkInbox: false })
      );

      // Should not throw
      interceptor.dispose();
    });
  });

  // ============================================================
  // refreshCache - cache integration
  // ============================================================

  describe('interceptToolCall - refreshCache integrates new tasks into cache', () => {
    test('new tasks from disk scan are added to conversationCache', async () => {
      const newTask = {
        taskId: 'discovered-task-123',
        metadata: {
          title: 'New Task',
          createdAt: '2026-03-05T01:00:00.000Z',
          lastActivity: '2026-03-05T01:00:00.000Z',
          mode: 'code-simple',
          messageCount: 5,
          actionCount: 2,
          totalSize: 512,
          workspace: '/test/workspace',
        },
        parentTaskId: undefined,
        sequence: [],
      };
      mockScanDiskForNewTasks.mockResolvedValue([newTask]);

      const interceptor = new ToolUsageInterceptor(
        notificationService,
        makeMockMessageManager() as any,
        conversationCache,
        makeConfig({ refreshCache: true })
      );

      await interceptor.interceptToolCall('tool', {}, async () => 'ok');
      await vi.advanceTimersByTimeAsync(50);

      expect(conversationCache.has('discovered-task-123')).toBe(true);
      expect(conversationCache.get('discovered-task-123')?.taskId).toBe('discovered-task-123');
    });

    test('empty scan results do not corrupt cache', async () => {
      conversationCache.set('existing-task', {
        taskId: 'existing-task',
        metadata: {
          title: 'Existing',
          createdAt: '2026-01-01T00:00:00.000Z',
          lastActivity: '2026-01-01T00:00:00.000Z',
          mode: 'code-simple',
          messageCount: 1,
          actionCount: 0,
          totalSize: 100,
        },
      } as any);
      mockScanDiskForNewTasks.mockResolvedValue([]);

      const interceptor = new ToolUsageInterceptor(
        notificationService,
        makeMockMessageManager() as any,
        conversationCache,
        makeConfig({ refreshCache: true })
      );

      await interceptor.interceptToolCall('tool', {}, async () => 'ok');
      await vi.advanceTimersByTimeAsync(50);

      expect(conversationCache.has('existing-task')).toBe(true);
      expect(conversationCache.size).toBe(1);
    });
  });

  // ============================================================
  // Priority handling (via background check)
  // ============================================================

  describe('priorité maximale des messages', () => {
    test('URGENT est la priorité maximale', async () => {
      const msgs = [
        makeMessage({ id: 'm1', priority: 'LOW' }),
        makeMessage({ id: 'm2', priority: 'URGENT' }),
        makeMessage({ id: 'm3', priority: 'HIGH' }),
      ];
      const msgManager = makeMockMessageManager(
        [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }],
        { m1: msgs[0], m2: msgs[1], m3: msgs[2] }
      );
      const notifySpy = vi.spyOn(notificationService, 'notify').mockResolvedValue(undefined);
      notificationService.loadFilterRules([{
        id: 'allow-all', eventType: 'new_message', condition: {},
        action: 'allow', notifyUser: false,
      }]);

      const interceptor = new ToolUsageInterceptor(
        notificationService, msgManager as any, conversationCache,
        makeConfig({ checkInbox: true, minPriority: 'LOW' })
      );

      // Trigger background check
      await vi.advanceTimersByTimeAsync(6_000);
      await flushMicrotasks();

      expect(notifySpy).toHaveBeenCalledWith(
        expect.objectContaining({ priority: 'URGENT' })
      );

      interceptor.dispose();
    });

    test('message en dessous du seuil minPriority : pas de notification', async () => {
      const msg = makeMessage({ id: 'msg-low', priority: 'LOW' });
      const msgManager = makeMockMessageManager([{ id: 'msg-low' }], { 'msg-low': msg });
      const notifySpy = vi.spyOn(notificationService, 'notify');

      const interceptor = new ToolUsageInterceptor(
        notificationService,
        msgManager as any,
        conversationCache,
        makeConfig({ checkInbox: true, minPriority: 'HIGH' })
      );

      await vi.advanceTimersByTimeAsync(6_000);
      await flushMicrotasks();

      expect(notifySpy).not.toHaveBeenCalled();

      interceptor.dispose();
    });
  });
});
