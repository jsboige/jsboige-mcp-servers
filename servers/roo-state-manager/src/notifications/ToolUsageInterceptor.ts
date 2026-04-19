/**
 * Intercepteur pour capturer l'usage de tous les outils MCP
 * 
 * Pattern: Middleware/Decorator
 * Responsabilités:
 * 1. Refresher le cache de conversations (via scanDiskForNewTasks)
 * 2. Vérifier la boîte de réception RooSync pour nouveaux messages
 * 3. Émettre un événement de notification si pertinent
 * 4. Exécuter l'outil original sans blocage
 * 
 * @module ToolUsageInterceptor
 * @version 1.0.0
 */

import { NotificationService, NotificationEvent } from './NotificationService.js';
import { MessageManager, Message } from '../services/MessageManager.js';
import { scanDiskForNewTasks } from '../tools/task/disk-scanner.js';
import { SkeletonHeader } from '../types/conversation.js';
import { getLocalWorkspaceId } from '../utils/message-helpers.js';

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
 * Wrapper autour de l'exécution de tous les outils MCP pour déclencher
 * des actions automatiques (indexation, vérification inbox) et émettre
 * des notifications si pertinent.
 */
export class ToolUsageInterceptor {
  private notificationService: NotificationService;
  private messageManager: MessageManager;
  private conversationCache: Map<string, SkeletonHeader>;
  private config: InterceptorConfig;

  // FIX #1356: prevent pile-up of background inbox scans when tool calls
  // arrive faster than the GDrive scan completes. One at a time is enough.
  private inboxCheckInFlight = false;
  
  /**
   * Constructeur de l'intercepteur
   * @param notificationService Service de notifications
   * @param messageManager Gestionnaire de messagerie RooSync
   * @param config Configuration de l'intercepteur
   */
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
  }
  
  /**
   * Intercepter l'exécution d'un outil MCP
   * 
   * Process:
   * 1. Logger l'usage de l'outil
   * 2. Refresher le cache de conversations (asynchrone, non-bloquant)
   * 3. Vérifier la boîte de réception RooSync
   * 4. Émettre notification si nouveaux messages pertinents
   * 5. Exécuter l'outil original
   * 
   * ⚠️ IMPORTANT: Ne JAMAIS bloquer l'exécution de l'outil si une erreur survient
   * 
   * @param toolName Nom de l'outil appelé
   * @param args Arguments passés à l'outil
   * @param execute Fonction d'exécution de l'outil original
   * @returns Résultat de l'exécution de l'outil
   */
  async interceptToolCall<T>(
    toolName: string,
    args: any,
    execute: () => Promise<T>
  ): Promise<T> {
    console.error(`🔍 [ToolUsageInterceptor] Intercepting tool: ${toolName}`);
    
    // 1. Refresher le cache de conversations (non-bloquant)
    if (this.config.refreshCache) {
      this.refreshConversationCache().catch(error => {
        console.error('⚠️ [ToolUsageInterceptor] Error refreshing cache:', error);
        // Ne pas bloquer l'exécution de l'outil
      });
    }
    
    // 2. Vérifier la boîte de réception RooSync (FIRE-AND-FORGET)
    // FIX #1356: The previous `Promise.race(3s)` did NOT fire under heavy GDrive I/O
    // because the event-loop timer was starved by libuv threadpool saturation
    // (1345+ sequential fs.readFile calls on FUSE-mounted GDrive).
    // Solution: never await the inbox check. Let it run in the background.
    // Any notifications will still be emitted, just asynchronously after the tool returns.
    if (this.config.checkInbox && !this.inboxCheckInFlight) {
      this.inboxCheckInFlight = true;
      this.checkForNewMessages()
        .then(async (newMessages) => {
          if (newMessages.length > 0) {
            console.error(`📬 [ToolUsageInterceptor] Found ${newMessages.length} new messages`);
            await this.notifyNewMessages(newMessages, toolName);
          }
        })
        .catch(error => {
          console.error('⚠️ [ToolUsageInterceptor] Error checking inbox:', error);
        })
        .finally(() => {
          this.inboxCheckInFlight = false;
        });
    }
    
    // 4. Exécuter l'outil original
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
   * Vérifier la présence de nouveaux messages dans l'inbox
   * @returns Liste des nouveaux messages (status: unread)
   * @private
   */
  private async checkForNewMessages(): Promise<Message[]> {
    console.error(`📬 [ToolUsageInterceptor] Checking inbox for: ${this.config.machineId}`);
    
    try {
      // Utiliser readInbox avec filtre 'unread'
      const unreadItems = await this.messageManager.readInbox(
        this.config.machineId,
        'unread',
        undefined,
        getLocalWorkspaceId()
      );
      
      // Récupérer les messages complets
      const messages: Message[] = [];
      for (const item of unreadItems) {
        const msg = await this.messageManager.getMessage(item.id);
        if (msg) {
          messages.push(msg);
        }
      }
      
      return messages;
    } catch (error) {
      console.error('❌ [ToolUsageInterceptor] Error checking messages:', error);
      return [];
    }
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
    this.config = { ...this.config, ...config };
    console.error('⚙️ [ToolUsageInterceptor] Config updated:', this.config);
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