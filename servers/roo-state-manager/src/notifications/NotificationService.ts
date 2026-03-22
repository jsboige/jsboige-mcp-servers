/**
 * Service de notifications push générique pour le MCP roo-state-manager
 *
 * Pattern: Observer + Firewall
 * Responsabilités:
 * - Gérer les abonnés (listeners) aux notifications
 * - Filtrer les événements via règles configurables
 * - Émettre des notifications système si pertinent
 *
 * @module NotificationService
 * @version 1.0.0
 */
import { createLogger } from '../utils/logger.js';

const logger = createLogger('notification-service');

/**
 * Interface d'un événement de notification
 */
export interface NotificationEvent {
  /** Type d'événement déclencheur */
  type: 'tool_used' | 'new_message' | 'decision_pending';

  /** Source de l'événement (nom de l'outil ou machine ID) */
  source: string;

  /** Priorité de la notification */
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';

  /** Données associées à l'événement */
  payload: any;

  /** Timestamp ISO-8601 de l'événement */
  timestamp: string;
}

/**
 * Interface d'une règle de filtrage
 */
export interface FilterRule {
  /** ID unique de la règle */
  id: string;

  /** Type d'événement concerné */
  eventType: NotificationEvent['type'];

  /** Conditions de filtrage */
  condition: {
    /** Outils sources autorisés (undefined = tous) */
    sourceTool?: string[];

    /** Priorités autorisées (undefined = toutes) */
    priority?: string[];

    /** Tags requis (undefined = aucun) */
    tags?: string[];
  };

  /** Action à effectuer si la condition est remplie */
  action: 'allow' | 'block' | 'require_approval';

  /** Notifier l'utilisateur via notification système */
  notifyUser: boolean;
}

/**
 * Interface d'un listener de notifications
 */
export interface NotificationListener {
  /**
   * Callback appelé lors d'une nouvelle notification
   * @param event Événement de notification
   */
  onNotify(event: NotificationEvent): Promise<void>;
}

/**
 * Service de gestion des notifications push
 *
 * Implémente le pattern Observer pour permettre à des listeners
 * de s'abonner aux événements de notification. Fournit un système
 * de filtrage configurable via règles JSON.
 */
export class NotificationService {
  /** Liste des listeners abonnés */
  private listeners: NotificationListener[] = [];

  /** Règles de filtrage actives */
  private filterRules: FilterRule[] = [];

  /** Events pending approval (queued when action is 'require_approval') */
  private pendingApprovals: Array<{ event: NotificationEvent; ruleId: string; timestamp: string }> = [];

  /**
   * Abonner un listener aux notifications
   * @param listener Listener à ajouter
   */
  subscribe(listener: NotificationListener): void {
    logger.debug('Subscribing new listener');
    this.listeners.push(listener);
  }

  /**
   * Désabonner un listener
   * @param listener Listener à retirer
   */
  unsubscribe(listener: NotificationListener): void {
    const index = this.listeners.indexOf(listener);
    if (index > -1) {
      this.listeners.splice(index, 1);
      logger.debug('Listener unsubscribed');
    }
  }

  /**
   * Charger les règles de filtrage depuis une configuration
   * @param rules Tableau de règles à appliquer
   */
  loadFilterRules(rules: FilterRule[]): void {
    this.filterRules = rules;
    logger.info(`Loaded ${rules.length} filter rules`);
  }

  /**
   * Déclencher une notification après filtrage
   *
   * Process:
   * 1. Évaluer les règles de filtrage
   * 2. Si `action: 'block'` → abandonner
   * 3. Si `action: 'allow'` → émettre vers listeners
   * 4. Si `notifyUser: true` → afficher notification système
   *
   * @param event Événement à notifier
   */
  async notify(event: NotificationEvent): Promise<void> {
    logger.debug('Processing notification', {
      type: event.type,
      source: event.source,
      priority: event.priority
    });

    // Évaluer les règles de filtrage
    const decision = this.evaluateFilters(event);

    if (decision.action === 'block') {
      logger.warn('Notification blocked by rule', { ruleId: decision.ruleId });
      return;
    }

    if (decision.action === 'require_approval') {
      // Queue the event for later approval review
      this.pendingApprovals.push({
        event,
        ruleId: decision.ruleId || 'unknown',
        timestamp: new Date().toISOString()
      });
      logger.warn('Notification queued for approval', {
        type: event.type,
        source: event.source,
        priority: event.priority,
        ruleId: decision.ruleId,
        pendingCount: this.pendingApprovals.length
      });
      // Don't emit to listeners until approved — return early
      return;
    }

    // Notifier tous les listeners
    logger.debug(`Emitting to ${this.listeners.length} listeners`);
    await Promise.all(
      this.listeners.map(listener => listener.onNotify(event))
    );

    // Notification système si demandée
    if (decision.notifyUser) {
      this.showSystemNotification(event);
    }
  }

  /**
   * Évaluer les règles de filtrage pour un événement
   * @param event Événement à évaluer
   * @returns Décision de filtrage
   */
  private evaluateFilters(event: NotificationEvent): {
    action: 'allow' | 'block' | 'require_approval';
    ruleId?: string;
    notifyUser: boolean;
  } {
    // Si aucune règle, autoriser par défaut sans notification
    if (this.filterRules.length === 0) {
      return { action: 'allow', notifyUser: false };
    }

    // Trouver la première règle qui matche
    for (const rule of this.filterRules) {
      // Vérifier le type d'événement
      if (rule.eventType !== event.type) {
        continue;
      }

      // Vérifier les conditions
      const matchesConditions = this.checkConditions(event, rule.condition);

      if (matchesConditions) {
        logger.debug(`Matched rule: ${rule.id}`);
        return {
          action: rule.action,
          ruleId: rule.id,
          notifyUser: rule.notifyUser
        };
      }
    }

    // Si aucune règle ne matche, bloquer par défaut (whitelist behavior)
    logger.warn('No matching rule, blocking by default');
    return { action: 'block', notifyUser: false };
  }

  /**
   * Vérifier si un événement satisfait les conditions d'une règle
   * @param event Événement à vérifier
   * @param condition Conditions de la règle
   * @returns True si toutes les conditions sont remplies
   */
  private checkConditions(
    event: NotificationEvent,
    condition: FilterRule['condition']
  ): boolean {
    // Vérifier sourceTool (si défini)
    if (condition.sourceTool && condition.sourceTool.length > 0) {
      if (!condition.sourceTool.includes(event.source)) {
        return false;
      }
    }

    // Vérifier priority (si définie)
    if (condition.priority && condition.priority.length > 0) {
      if (!condition.priority.includes(event.priority)) {
        return false;
      }
    }

    // Vérifier tags (si définis)
    if (condition.tags && condition.tags.length > 0) {
      const eventTags = (event.payload?.tags || []) as string[];
      const hasRequiredTag = condition.tags.some(tag => eventTags.includes(tag));
      if (!hasRequiredTag) {
        return false;
      }
    }

    return true;
  }

  /**
   * Afficher une notification système (Windows/macOS)
   * @param event Événement à notifier
   */
  /**
   * Approve a pending notification by index, emitting it to listeners
   * @param index Index in pendingApprovals array (0-based)
   */
  async approvePending(index: number): Promise<boolean> {
    if (index < 0 || index >= this.pendingApprovals.length) {
      return false;
    }
    const { event } = this.pendingApprovals.splice(index, 1)[0];
    logger.info('Pending notification approved', { type: event.type, source: event.source });
    await Promise.all(this.listeners.map(listener => listener.onNotify(event)));
    return true;
  }

  /**
   * Reject a pending notification, removing it from the queue
   * @param index Index in pendingApprovals array (0-based)
   */
  rejectPending(index: number): boolean {
    if (index < 0 || index >= this.pendingApprovals.length) {
      return false;
    }
    const { event } = this.pendingApprovals.splice(index, 1)[0];
    logger.info('Pending notification rejected', { type: event.type, source: event.source });
    return true;
  }

  private showSystemNotification(event: NotificationEvent): void {
    // Write to stderr (captured by VS Code output channel for MCP servers)
    const prefix = event.priority === 'URGENT' ? '🔴' : event.priority === 'HIGH' ? '🟠' : '🔵';
    const message = `${prefix} [${event.type.toUpperCase()}] ${event.source}: ${typeof event.payload === 'string' ? event.payload : JSON.stringify(event.payload)}`;
    // Use console.error for stderr visibility (MCP protocol reserves stdout for JSON-RPC)
    console.error(`[NOTIFICATION] ${message}`);
    logger.info('System notification emitted to stderr', {
      type: event.type,
      source: event.source,
      priority: event.priority
    });
  }

  /**
   * Obtenir les statistiques du service
   * @returns Statistiques du service
   */
  getStats(): {
    listenersCount: number;
    rulesCount: number;
    rules: FilterRule[];
    pendingApprovalsCount: number;
    pendingApprovals: Array<{ event: NotificationEvent; ruleId: string; timestamp: string }>;
  } {
    return {
      listenersCount: this.listeners.length,
      rulesCount: this.filterRules.length,
      rules: this.filterRules,
      pendingApprovalsCount: this.pendingApprovals.length,
      pendingApprovals: this.pendingApprovals
    };
  }
}