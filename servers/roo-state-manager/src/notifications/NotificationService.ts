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
  
  /**
   * Abonner un listener aux notifications
   * @param listener Listener à ajouter
   */
  subscribe(listener: NotificationListener): void {
    console.error('🔔 [NotificationService] Subscribing new listener');
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
      console.error('🔕 [NotificationService] Listener unsubscribed');
    }
  }
  
  /**
   * Charger les règles de filtrage depuis une configuration
   * @param rules Tableau de règles à appliquer
   */
  loadFilterRules(rules: FilterRule[]): void {
    this.filterRules = rules;
    console.error(`⚙️ [NotificationService] Loaded ${rules.length} filter rules`);
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
    console.error('📬 [NotificationService] Processing notification:', {
      type: event.type,
      source: event.source,
      priority: event.priority
    });
    
    // Évaluer les règles de filtrage
    const decision = this.evaluateFilters(event);
    
    if (decision.action === 'block') {
      console.error('🚫 [NotificationService] Notification blocked by rule:', decision.ruleId);
      return;
    }
    
    if (decision.action === 'require_approval') {
      console.error('⚠️ [NotificationService] Notification requires approval (not implemented)');
      // TODO: Implémenter système d'approbation si nécessaire
    }
    
    // Notifier tous les listeners
    console.error(`📢 [NotificationService] Emitting to ${this.listeners.length} listeners`);
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
        console.error(`✅ [NotificationService] Matched rule: ${rule.id}`);
        return {
          action: rule.action,
          ruleId: rule.id,
          notifyUser: rule.notifyUser
        };
      }
    }
    
    // Si aucune règle ne matche, bloquer par défaut (whitelist behavior)
    console.error('⚠️ [NotificationService] No matching rule, blocking by default');
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
  private showSystemNotification(event: NotificationEvent): void {
    console.error('🔔 [NotificationService] Showing system notification');
    
    // Pour Phase 1, on log seulement
    // TODO: Implémenter avec node-notifier ou équivalent
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.error(`🔔 NOTIFICATION: ${event.type.toUpperCase()}`);
    console.error(`   Source: ${event.source}`);
    console.error(`   Priority: ${event.priority}`);
    console.error(`   Payload: ${JSON.stringify(event.payload, null, 2)}`);
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  }
  
  /**
   * Obtenir les statistiques du service
   * @returns Statistiques du service
   */
  getStats(): {
    listenersCount: number;
    rulesCount: number;
    rules: FilterRule[];
  } {
    return {
      listenersCount: this.listeners.length,
      rulesCount: this.filterRules.length,
      rules: this.filterRules
    };
  }
}