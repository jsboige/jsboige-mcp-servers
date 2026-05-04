/**
 * Intercepteur pour capturer l'usage de tous les outils MCP
 *
 * Pattern: Middleware/Decorator
 * Responsabilités:
 * 1. Refresher le cache de conversations (via scanDiskForNewTasks)
 * 2. Vérifier la boîte de réception RooSync (background interval, never on hot path)
 * 3. Émettre un événement de notification si pertinent
 * 4. Exécuter l'outil original sans blocage
 *
 * FIX #1356: Inbox check moved entirely to background interval (60s).
 * Previous fire-and-forget still saturated GDrive FUSE I/O on the event loop.
 *
 * @module ToolUsageInterceptor
 * @version 2.0.0
 */

import { NotificationService, NotificationEvent } from './NotificationService.js';
import { MessageManager, Message } from '../services/MessageManager.js';
import { scanDiskForNewTasks } from '../tools/task/disk-scanner.js';
import { SkeletonHeader } from '../types/conversation.js';
import { getLocalWorkspaceId } from '../utils/message-helpers.js';

/** Background inbox check interval (ms) */
const BACKGROUND_CHECK_INTERVAL_MS = 60_000;
/** Initial delay before first background check (ms) */
const BACKGROUND_CHECK_INITIAL_DELAY_MS = 5_000;

/**
 * Configuration de l'intercepteur
 */
export interface InterceptorConfig {
  /** Activer le système d'interception */
  enabled?: boolean;

  /** ID de la machine courante (pour filtrer les messages inbox) */
  machineId: string;

  /** Activer la vérification de l'inbox RooSync */
  checkInbox: boolean;

  /** Activer le refresh du cache de conversations */
  refreshCache: boolean;

  /** Priorité minimale pour déclencher une notification */
  minPriority?: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
}

/**
 * Intercepteur d'usage d'outils MCP
 *
 * FIX #1356 v2: Inbox check runs on a background interval (every 60s).
 * interceptToolCall is completely I/O-free for inbox — no GDrive reads on the hot path.
 */
export class ToolUsageInterceptor {
  private notificationService: NotificationService;
  private messageManager: MessageManager;
  private conversationCache: Map<string, SkeletonHeader>;
  private config: InterceptorConfig;

  private backgroundCheckInterval: ReturnType<typeof setInterval> | null = null;
  private inboxCheckInFlight = false;
  private notifiedMessageIds: Set<string> = new Set();

  constructor(
    notificationService: NotificationService,
    messageManager: MessageManager,
    conversationCache: Map<string, SkeletonHeader>,
    config: InterceptorConfig
  ) {
    this.notificationService = notificationService;
    this.messageManager = messageManager;
    this.conversationCache = conversationCache;
    this.config = config;

    console.error('🔧 [ToolUsageInterceptor] Initialized with config:', {
      machineId: config.machineId,
      checkInbox: config.checkInbox,
      refreshCache: config.refreshCache,
      minPriority: config.minPriority
    });

    if (config.checkInbox) {
      this.startBackgroundCheck();
    }
  }

  /**
   * Intercepter l'exécution d'un outil MCP
   *
   * Zero I/O for inbox check — the background interval handles it.
   */
  async interceptToolCall<T>(
    toolName: string,
    args: any,
    execute: () => Promise<T>
  ): Promise<T> {
    console.error(`🔍 [ToolUsageInterceptor] Intercepting tool: ${toolName}`);

    // 1. Refresh conversation cache (non-blocking, fire-and-forget)
    if (this.config.refreshCache) {
      this.refreshConversationCache().catch(error => {
        console.error('⚠️ [ToolUsageInterceptor] Error refreshing cache:', error);
      });
    }

    // 2. Inbox check is done by background interval — zero I/O on hot path.

    // 3. Execute the tool
    console.error(`▶️ [ToolUsageInterceptor] Executing tool: ${toolName}`);
    return await execute();
  }
  
  /**
   * Refresher le cache de conversations
   * @private
   */
  private async refreshConversationCache(): Promise<void> {
    try {
      // FIX: Actually integrate discovered tasks into the cache
      // Previously, scanDiskForNewTasks return value was discarded
      const newTasks = await scanDiskForNewTasks(this.conversationCache as any);
      if (newTasks.length > 0) {
        for (const task of newTasks) {
          this.conversationCache.set(task.taskId, task);
        }
        console.error(`✅ [ToolUsageInterceptor] Cache refresh: added ${newTasks.length} new tasks`);
      }
    } catch (error) {
      console.error('❌ [ToolUsageInterceptor] Cache refresh failed:', error);
      throw error;
    }
  }
  
  /**
   * Start the background inbox check interval.
   * FIX #1356 v2: Completely removes inbox I/O from the tool execution hot path.
   * @private
   */
  private startBackgroundCheck(): void {
    // First check after a short delay (let MCP initialize first)
    setTimeout(() => this.backgroundInboxCheck(), BACKGROUND_CHECK_INITIAL_DELAY_MS);

    this.backgroundCheckInterval = setInterval(
      () => this.backgroundInboxCheck(),
      BACKGROUND_CHECK_INTERVAL_MS
    );

    console.error(`📬 [ToolUsageInterceptor] Background inbox check started (interval: ${BACKGROUND_CHECK_INTERVAL_MS}ms)`);
  }

  /**
   * Background inbox check — runs on interval, never blocks tool execution.
   * @private
   */
  private async backgroundInboxCheck(): Promise<void> {
    if (this.inboxCheckInFlight) return;
    this.inboxCheckInFlight = true;

    try {
      const unreadItems = await this.messageManager.readInbox(
        this.config.machineId,
        'unread',
        undefined,
        getLocalWorkspaceId()
      );

      const messages: Message[] = [];
      for (const item of unreadItems) {
        const msg = await this.messageManager.getMessage(item.id);
        if (msg) {
          messages.push(msg);
        }
      }

      // Only notify about messages we haven't already notified about
      const newToNotify = messages.filter(m => !this.notifiedMessageIds.has(m.id));

      if (newToNotify.length > 0) {
        for (const m of newToNotify) {
          this.notifiedMessageIds.add(m.id);
        }
        console.error(`📬 [ToolUsageInterceptor] Background check: ${newToNotify.length} new unread messages`);
        await this.notifyNewMessages(newToNotify, 'background-check');
      }
    } catch (error) {
      console.error('⚠️ [ToolUsageInterceptor] Background inbox check failed:', error);
    } finally {
      this.inboxCheckInFlight = false;
    }
  }

  /**
   * Stop the background interval and clean up.
   */
  dispose(): void {
    if (this.backgroundCheckInterval) {
      clearInterval(this.backgroundCheckInterval);
      this.backgroundCheckInterval = null;
    }
    this.notifiedMessageIds.clear();
  }
  
  /**
   * Émettre une notification pour les nouveaux messages
   * @param messages Liste des nouveaux messages
   * @param toolName Nom de l'outil en cours d'exécution
   * @private
   */
  private async notifyNewMessages(messages: Message[], toolName: string): Promise<void> {
    // Calculer la priorité maximale des messages
    const highestPriority = this.calculateHighestPriority(messages);
    
    // Vérifier si la priorité atteint le seuil minimum
    if (!this.meetsPriorityThreshold(highestPriority)) {
      console.error(`🔕 [ToolUsageInterceptor] Priority ${highestPriority} below threshold ${this.config.minPriority}`);
      return;
    }
    
    // Créer l'événement de notification
    const event: NotificationEvent = {
      type: 'new_message',
      source: 'roosync_inbox',
      priority: highestPriority,
      payload: {
        count: messages.length,
        messages: messages.map(m => ({
          id: m.id,
          from: m.from,
          subject: m.subject,
          priority: m.priority,
          timestamp: m.timestamp
        })),
        triggeredBy: toolName
      },
      timestamp: new Date().toISOString()
    };
    
    // Émettre via le service de notifications
    await this.notificationService.notify(event);
  }
  
  /**
   * Calculer la priorité maximale d'une liste de messages
   * @param messages Liste de messages
   * @returns Priorité la plus élevée
   * @private
   */
  private calculateHighestPriority(messages: Message[]): 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT' {
    const priorities: Array<'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT'> = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];
    const priorityValues = { LOW: 0, MEDIUM: 1, HIGH: 2, URGENT: 3 };
    
    let maxValue = 0;
    for (const msg of messages) {
      const value = priorityValues[msg.priority];
      if (value > maxValue) {
        maxValue = value;
      }
    }
    
    return priorities[maxValue];
  }
  
  /**
   * Vérifier si une priorité atteint le seuil minimum
   * @param priority Priorité à vérifier
   * @returns True si la priorité est suffisante
   * @private
   */
  private meetsPriorityThreshold(priority: string): boolean {
    const priorityValues = { LOW: 0, MEDIUM: 1, HIGH: 2, URGENT: 3 };
    const currentValue = priorityValues[priority as keyof typeof priorityValues];
    const minPriority = this.config.minPriority || 'MEDIUM';
    const thresholdValue = priorityValues[minPriority];
    
    return currentValue >= thresholdValue;
  }
  
  /**
   * Mettre à jour la configuration de l'intercepteur
   * @param config Nouvelle configuration (partielle)
   */
  updateConfig(config: Partial<InterceptorConfig>): void {
    const wasChecking = this.config.checkInbox;
    this.config = { ...this.config, ...config };
    console.error('⚙️ [ToolUsageInterceptor] Config updated:', this.config);

    if (!wasChecking && this.config.checkInbox) {
      this.startBackgroundCheck();
    } else if (wasChecking && !this.config.checkInbox) {
      this.dispose();
    }
  }
  
  /**
   * Obtenir les statistiques de l'intercepteur
   * @returns Statistiques et configuration actuelle
   */
  getStats(): {
    config: InterceptorConfig;
    isActive: boolean;
  } {
    return {
      config: this.config,
      isActive: this.config.checkInbox || this.config.refreshCache
    };
  }
}