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
 * @version 3.0.0 — #2192 push notification footer on tool response
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
/** Max unread count displayed in footer before capping */
const DEFAULT_MAX_COUNT = 5;

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
  /** Pre-built footer string from background check, annexed to next tool response */
  private pendingFooter: string | null = null;
  /** Total unread count from last background check */
  private lastUnreadCount = 0;

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
    const result = await execute();

    // 4. Annex notification footer if pending (#2192)
    if (this.pendingFooter) {
      const footer = this.pendingFooter;
      this.pendingFooter = null;
      return this.appendFooter(result, footer);
    }

    return result;
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

      // Build footer for all unread messages (not just new ones) — #2192
      this.updatePendingFooter(messages);
    } catch (error) {
      console.error('⚠️ [ToolUsageInterceptor] Background inbox check failed:', error);
    } finally {
      this.inboxCheckInFlight = false;
    }
  }

  /**
   * Build the notification footer string from unread messages.
   * Called from background check — never on hot path.
   * @private
   */
  private updatePendingFooter(messages: Message[]): void {
    const footerEnabled = process.env.NOTIFICATIONS_FOOTER_ENABLED !== 'false';
    if (!footerEnabled || messages.length === 0) {
      this.pendingFooter = null;
      this.lastUnreadCount = 0;
      return;
    }

    const maxCount = parseInt(process.env.NOTIFICATIONS_MAX_COUNT || String(DEFAULT_MAX_COUNT), 10);
    const workspace = getLocalWorkspaceId();
    const machineId = this.config.machineId;
    const count = messages.length;
    this.lastUnreadCount = count;

    const urgentCount = messages.filter(m => m.priority === 'URGENT').length;
    const highCount = messages.filter(m => m.priority === 'HIGH').length;
    const displayCount = count > maxCount ? `${maxCount}+` : String(count);

    let footer = `\n[NOTIF] ${displayCount} message(s) non lu(s) en inbox`;
    if (urgentCount > 0) {
      footer += ` (${urgentCount} URGENT)`;
    } else if (highCount > 0) {
      footer += ` (${highCount} HIGH)`;
    }
    footer += `. ${machineId}:${workspace}. Use roosync_messages action:"inbox".`;

    this.pendingFooter = footer;
  }

  /**
   * Append footer string to tool result.
   * Handles string, array (text content), and object results.
   * @private
   */
  private appendFooter<T>(result: T, footer: string): T {
    if (typeof result === 'string') {
      return (result + footer) as T;
    }

    if (Array.isArray(result)) {
      // MCP text content array: [{type: "text", text: "..."}]
      if (result.length > 0 && typeof result[0] === 'object' && result[0].type === 'text' && typeof result[0].text === 'string') {
        const copy = [...result] as any[];
        copy[copy.length - 1] = { ...copy[copy.length - 1], text: copy[copy.length - 1].text + footer };
        return copy as T;
      }
      // Generic array — append footer element
      return [...result, { type: 'text' as const, text: footer }] as T;
    }

    if (typeof result === 'object' && result !== null) {
      // Object result — append footer to content field if it exists
      const obj = result as Record<string, any>;
      if (typeof obj.content === 'string') {
        return { ...obj, content: obj.content + footer } as T;
      }
      if (Array.isArray(obj.content)) {
        const contentCopy = [...obj.content];
        if (contentCopy.length > 0 && typeof contentCopy[contentCopy.length - 1]?.text === 'string') {
          contentCopy[contentCopy.length - 1] = { ...contentCopy[contentCopy.length - 1], text: contentCopy[contentCopy.length - 1].text + footer };
        } else {
          contentCopy.push({ type: 'text', text: footer });
        }
        return { ...obj, content: contentCopy } as T;
      }
    }

    // Fallback: can't append, skip footer
    return result;
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
    this.pendingFooter = null;
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