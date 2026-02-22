/**
 * Tests unitaires pour ToolUsageInterceptor
 *
 * Couvre :
 * - interceptToolCall : exécution de l'outil sans bloquer
 * - interceptToolCall : avec refreshCache=true (non-bloquant)
 * - interceptToolCall : avec checkInbox=true + messages non lus → notification
 * - interceptToolCall : avec checkInbox=true + aucun message
 * - interceptToolCall : erreur dans execute → propagée
 * - calculateHighestPriority (via notifyNewMessages)
 * - meetsPriorityThreshold (via notifyNewMessages)
 * - updateConfig
 * - getStats
 *
 * @module notifications/__tests__/ToolUsageInterceptor.test
 * @version 1.0.0 (#492)
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// ─────────────────── mocks (vi.hoisted pour éviter TDZ) ───────────────────

const { mockScanDiskForNewTasks } = vi.hoisted(() => ({
  mockScanDiskForNewTasks: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../tools/task/disk-scanner.js', () => ({
  scanDiskForNewTasks: (...args: any[]) => mockScanDiskForNewTasks(...args),
}));

import { ToolUsageInterceptor } from '../ToolUsageInterceptor.js';
import { NotificationService } from '../NotificationService.js';
import type { InterceptorConfig } from '../ToolUsageInterceptor.js';
import type { ConversationSkeleton } from '../../types/conversation.js';

// ─────────────────── helpers ───────────────────

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
  notificationService = new NotificationService();
  conversationCache = new Map();
  mockScanDiskForNewTasks.mockResolvedValue(undefined);
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

      interceptor.updateConfig({ machineId: 'new-machine' });

      expect(interceptor.getStats().config.checkInbox).toBe(true);
      expect(interceptor.getStats().config.refreshCache).toBe(true);
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

    test('propage l\'erreur de la fonction execute', async () => {
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

      // Attendre micro-tick pour que la promesse non-bloquante s'exécute
      await new Promise(r => setTimeout(r, 10));
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

      // Should not throw
      const result = await interceptor.interceptToolCall('tool', {}, async () => 'ok');
      expect(result).toBe('ok');
    });
  });

  // ============================================================
  // interceptToolCall - checkInbox=true
  // ============================================================

  describe('interceptToolCall - checkInbox=true', () => {
    test('lit la boîte de réception', async () => {
      const msgManager = makeMockMessageManager([]);
      const interceptor = new ToolUsageInterceptor(
        notificationService,
        msgManager as any,
        conversationCache,
        makeConfig({ checkInbox: true })
      );

      await interceptor.interceptToolCall('tool', {}, async () => 'ok');

      expect(msgManager.readInbox).toHaveBeenCalled();
    });

    test('sans nouveaux messages : ne notifie pas', async () => {
      const notifySpy = vi.spyOn(notificationService, 'notify');
      const interceptor = new ToolUsageInterceptor(
        notificationService,
        makeMockMessageManager([]) as any,
        conversationCache,
        makeConfig({ checkInbox: true })
      );

      await interceptor.interceptToolCall('tool', {}, async () => 'ok');

      expect(notifySpy).not.toHaveBeenCalled();
    });

    test('avec nouveaux messages : émet une notification', async () => {
      const msg = makeMessage({ id: 'msg-1', priority: 'HIGH' });
      const msgManager = makeMockMessageManager([{ id: 'msg-1' }], { 'msg-1': msg });
      const notifySpy = vi.spyOn(notificationService, 'notify').mockResolvedValue(undefined);

      const interceptor = new ToolUsageInterceptor(
        notificationService,
        msgManager as any,
        conversationCache,
        makeConfig({ checkInbox: true, minPriority: 'LOW' })
      );

      // Load a permissive filter rule
      notificationService.loadFilterRules([{
        id: 'allow-all',
        eventType: 'new_message',
        condition: {},
        action: 'allow',
        notifyUser: false,
      }]);

      await interceptor.interceptToolCall('tool', {}, async () => 'ok');

      expect(notifySpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'new_message' })
      );
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

      await interceptor.interceptToolCall('tool', {}, async () => 'ok');

      expect(notifySpy).not.toHaveBeenCalled();
    });

    test('erreur readInbox ne bloque pas l\'outil', async () => {
      const msgManager = makeMockMessageManager();
      msgManager.readInbox.mockRejectedValue(new Error('Inbox unavailable'));

      const interceptor = new ToolUsageInterceptor(
        notificationService,
        msgManager as any,
        conversationCache,
        makeConfig({ checkInbox: true })
      );

      const result = await interceptor.interceptToolCall('tool', {}, async () => 'safe');

      expect(result).toBe('safe');
    });
  });

  // ============================================================
  // calculateHighestPriority (indirect via notifyNewMessages)
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

      await interceptor.interceptToolCall('tool', {}, async () => 'ok');

      expect(notifySpy).toHaveBeenCalledWith(
        expect.objectContaining({ priority: 'URGENT' })
      );
    });
  });
});
