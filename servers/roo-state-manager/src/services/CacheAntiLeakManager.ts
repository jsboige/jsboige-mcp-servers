/**
 * Cache Anti-Leak Manager - Protection 220GB avec monitoring continu
 * 
 * Architecture consolidée selon SDDD :
 * - Protection trafic maximum 220GB identifié dans l'audit
 * - Vérification cohérence 24h + réindexation minimum 4h
 * - Monitoring temps réel avec alertes automatiques
 * - Éviction intelligente basée sur LRU + usage patterns
 * - Intégration Architecture 2-niveaux (cache immédiat)
 * 
 * Patterns découverts dans l'audit :
 * - Skeleton cache avec build incrémental
 * - Qdrant index avec reset/rebuild cyclique  
 * - Conversations cache avec anti-fuite BOM
 * - Task history cache avec workspace mapping
 * 
 * @version 1.0.0
 * @since 2025-09-27 (Phase services consolidés)
 */

import { 
  CacheAntiLeakConfig,
  CacheStrategy,
  CacheConfiguration,
  CacheResult,
  ProcessingLevel
} from '../interfaces/UnifiedToolInterface.js';

/**
 * Entrée de cache avec métadonnées de gestion
 */
interface CacheEntry<T> {
  key: string;
  data: T;
  size: number; // Taille en bytes
  createdAt: Date;
  lastAccessed: Date;
  accessCount: number;
  ttl: number; // Time to live en ms
  strategy: CacheStrategy;
  locked: boolean; // Protection contre éviction
  processingLevel: ProcessingLevel;
}

/**
 * Statistiques de cache en temps réel
 */
interface CacheStats {
  totalEntries: number;
  totalSizeBytes: number;
  totalSizeGB: number;
  hitCount: number;
  missCount: number;
  hitRate: number;
  evictionCount: number;
  lastConsistencyCheck: Date;
  lastReindexTime: Date;
  alertsTriggered: number;
  averageEntrySize: number;
  oldestEntry: Date | null;
  newestEntry: Date | null;
}

/**
 * Configuration des seuils d'éviction par stratégie
 */
interface EvictionPolicy {
  strategy: CacheStrategy;
  maxSizeGB: number;
  maxAge: number; // millisecondes
  priority: number; // 1 = haute priorité (éviction tardive)
}

/**
 * Manager de cache avec protection Anti-Fuite 220GB
 * Implémente les patterns découverts dans l'audit exhaustif
 */
export class CacheAntiLeakManager {
  
  private readonly cache = new Map<string, CacheEntry<any>>();
  private readonly config: CacheAntiLeakConfig;
  private readonly stats: CacheStats;
  private readonly evictionPolicies: Map<CacheStrategy, EvictionPolicy>;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private consistencyTimer: NodeJS.Timeout | null = null;

  constructor(config: Partial<CacheAntiLeakConfig> = {}) {
    this.config = {
      maxTrafficGB: 220,
      consistencyCheckHours: 24,
      minReindexIntervalHours: 4,
      enabled: true,
      alerts: {
        memoryThresholdGB: 200,
        processingTimeoutMs: 30000
      },
      ...config
    };

    this.stats = {
      totalEntries: 0,
      totalSizeBytes: 0,
      totalSizeGB: 0,
      hitCount: 0,
      missCount: 0,
      hitRate: 0,
      evictionCount: 0,
      lastConsistencyCheck: new Date(),
      lastReindexTime: new Date(),
      alertsTriggered: 0,
      averageEntrySize: 0,
      oldestEntry: null,
      newestEntry: null
    };

    this.evictionPolicies = this.initializeEvictionPolicies();
    this.startBackgroundProcesses();
  }

  /**
   * Initialisation des politiques d'éviction par stratégie
   */
  private initializeEvictionPolicies(): Map<CacheStrategy, EvictionPolicy> {
    const policies = new Map<CacheStrategy, EvictionPolicy>();
    
    // Basé sur les patterns identifiés dans l'audit
    policies.set('aggressive', {
      strategy: 'aggressive',
      maxSizeGB: 50, // 25% du total pour cache agressif
      maxAge: 1000 * 60 * 60, // 1 heure
      priority: 1 // Éviction rapide
    });
    
    policies.set('moderate', {
      strategy: 'moderate', 
      maxSizeGB: 100, // 50% du total pour cache modéré
      maxAge: 1000 * 60 * 60 * 6, // 6 heures
      priority: 2
    });
    
    policies.set('conservative', {
      strategy: 'conservative',
      maxSizeGB: 60, // 30% pour cache conservateur 
      maxAge: 1000 * 60 * 60 * 24, // 24 heures
      priority: 3 // Éviction tardive
    });
    
    policies.set('bypass', {
      strategy: 'bypass',
      maxSizeGB: 5, // Minimal pour bypass temporaire
      maxAge: 1000 * 60 * 5, // 5 minutes
      priority: 1 // Éviction immédiate
    });

    return policies;
  }

  /**
   * Stockage avec vérification Anti-Fuite
   */
  async store<T>(
    key: string, 
    data: T, 
    config: CacheConfiguration
  ): Promise<void> {
    
    if (!this.config.enabled) return;
    
    // Calcul de la taille approximative
    const dataSize = this.estimateSize(data);
    
    // Vérification Anti-Fuite AVANT stockage
    await this.checkAntiLeakBeforeStore(dataSize);
    
    const entry: CacheEntry<T> = {
      key,
      data,
      size: dataSize,
      createdAt: new Date(),
      lastAccessed: new Date(),
      accessCount: 0,
      ttl: config.ttl || 1000 * 60 * 60, // 1h par défaut
      strategy: config.strategy,
      locked: false,
      processingLevel: ProcessingLevel.IMMEDIATE
    };

    // Éviction préventive si nécessaire
    await this.preventiveEviction(config.strategy, dataSize);
    
    this.cache.set(key, entry);
    this.updateStatsAfterStore(entry);
  }

  /**
   * Récupération avec mise à jour d'accès
   */
  async get<T>(key: string): Promise<CacheResult<T> | null> {
    const entry = this.cache.get(key) as CacheEntry<T> | undefined;
    
    if (!entry) {
      this.stats.missCount++;
      this.updateHitRate();
      return null;
    }
    
    // Vérification TTL
    if (this.isExpired(entry)) {
      this.cache.delete(key);
      this.updateStatsAfterEviction(entry);
      this.stats.missCount++;
      this.updateHitRate();
      return null;
    }
    
    // Mise à jour d'accès
    entry.lastAccessed = new Date();
    entry.accessCount++;
    
    this.stats.hitCount++;
    this.updateHitRate();
    
    return {
      hit: true,
      data: entry.data,
      timestamp: entry.createdAt.getTime()
    };
  }

  /**
   * Éviction préventive selon la stratégie
   */
  private async preventiveEviction(strategy: CacheStrategy, incomingSize: number): Promise<void> {
    const policy = this.evictionPolicies.get(strategy);
    if (!policy) return;
    
    const currentSizeGB = this.stats.totalSizeGB;
    const incomingSizeGB = incomingSize / (1024 * 1024 * 1024);
    
    // Vérification si ajout dépassera les seuils
    if (currentSizeGB + incomingSizeGB > policy.maxSizeGB) {
      await this.evictByStrategy(strategy, incomingSizeGB);
    }
  }

  /**
   * Éviction par stratégie avec algorithme LRU
   */
  private async evictByStrategy(strategy: CacheStrategy, requiredSpaceGB: number): Promise<void> {
    const entriesForStrategy = Array.from(this.cache.values())
      .filter(entry => entry.strategy === strategy && !entry.locked)
      .sort((a, b) => a.lastAccessed.getTime() - b.lastAccessed.getTime()); // LRU
    
    let freedSpaceGB = 0;
    let evicted = 0;
    
    for (const entry of entriesForStrategy) {
      if (freedSpaceGB >= requiredSpaceGB) break;
      
      this.cache.delete(entry.key);
      freedSpaceGB += entry.size / (1024 * 1024 * 1024);
      evicted++;
      this.updateStatsAfterEviction(entry);
    }
    
    if (evicted > 0) {
      console.warn(`[CacheAntiLeak] Éviction préventive: ${evicted} entrées (${freedSpaceGB.toFixed(2)}GB freed) pour stratégie ${strategy}`);
    }
  }

  /**
   * Vérification Anti-Fuite avant stockage
   */
  private async checkAntiLeakBeforeStore(incomingSize: number): Promise<void> {
    const currentSizeGB = this.stats.totalSizeGB;
    const incomingSizeGB = incomingSize / (1024 * 1024 * 1024);
    const projectedSizeGB = currentSizeGB + incomingSizeGB;
    
    // Seuil d'alerte (90% de la limite)
    if (projectedSizeGB > this.config.maxTrafficGB * 0.9) {
      this.stats.alertsTriggered++;
      console.warn(`[CacheAntiLeak] ALERT: Approaching limit - Current: ${currentSizeGB.toFixed(2)}GB, Projected: ${projectedSizeGB.toFixed(2)}GB, Limit: ${this.config.maxTrafficGB}GB`);
      
      // Éviction d'urgence si dépassement
      if (projectedSizeGB > this.config.maxTrafficGB) {
        await this.emergencyEviction(incomingSizeGB);
      }
    }
  }

  /**
   * Éviction d'urgence multi-stratégies
   */
  private async emergencyEviction(requiredSpaceGB: number): Promise<void> {
    console.error(`[CacheAntiLeak] EMERGENCY EVICTION: Need ${requiredSpaceGB.toFixed(2)}GB space`);
    
    // Éviction par priorité (bypass > aggressive > moderate > conservative)
    const priorityOrder: CacheStrategy[] = ['bypass', 'aggressive', 'moderate', 'conservative'];
    
    let freedSpaceGB = 0;
    
    for (const strategy of priorityOrder) {
      if (freedSpaceGB >= requiredSpaceGB) break;
      
      const needed = requiredSpaceGB - freedSpaceGB;
      await this.evictByStrategy(strategy, needed);
      
      // Recalcul après éviction
      this.updateStats();
      freedSpaceGB += needed;
    }
    
    // Si encore insuffisant, éviction forcée des plus anciens
    if (this.stats.totalSizeGB > this.config.maxTrafficGB) {
      await this.forceEvictOldest(requiredSpaceGB);
    }
  }

  /**
   * Éviction forcée des entrées les plus anciennes
   */
  private async forceEvictOldest(requiredSpaceGB: number): Promise<void> {
    const allEntries = Array.from(this.cache.values())
      .filter(entry => !entry.locked)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()); // Plus anciens d'abord
    
    let freedSpaceGB = 0;
    let evicted = 0;
    
    for (const entry of allEntries) {
      if (freedSpaceGB >= requiredSpaceGB) break;
      
      this.cache.delete(entry.key);
      freedSpaceGB += entry.size / (1024 * 1024 * 1024);
      evicted++;
      this.updateStatsAfterEviction(entry);
    }
    
    console.error(`[CacheAntiLeak] FORCE EVICTION: ${evicted} oldest entries removed (${freedSpaceGB.toFixed(2)}GB)`);
  }

  /**
   * Nettoyage périodique (TTL + cohérence)
   */
  private async periodicCleanup(): Promise<void> {
    const now = new Date();
    let cleaned = 0;
    
    for (const [key, entry] of this.cache.entries()) {
      if (this.isExpired(entry)) {
        this.cache.delete(key);
        this.updateStatsAfterEviction(entry);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      console.log(`[CacheAntiLeak] Periodic cleanup: ${cleaned} expired entries removed`);
    }
    
    this.updateStats();
  }

  /**
   * Vérification de cohérence 24h
   */
  private async consistencyCheck(): Promise<void> {
    const now = new Date();
    const hoursSinceLastCheck = (now.getTime() - this.stats.lastConsistencyCheck.getTime()) / (1000 * 60 * 60);
    
    if (hoursSinceLastCheck >= this.config.consistencyCheckHours) {
      console.log(`[CacheAntiLeak] Starting 24h consistency check...`);
      
      // Validation de l'intégrité du cache
      let corruptedEntries = 0;
      
      for (const [key, entry] of this.cache.entries()) {
        try {
          // Validation basique de l'entrée
          if (!entry.data || !entry.createdAt || entry.size < 0) {
            this.cache.delete(key);
            corruptedEntries++;
          }
        } catch (error) {
          this.cache.delete(key);
          corruptedEntries++;
        }
      }
      
      this.stats.lastConsistencyCheck = now;
      
      if (corruptedEntries > 0) {
        console.warn(`[CacheAntiLeak] Consistency check: ${corruptedEntries} corrupted entries removed`);
      }
      
      this.updateStats();
      console.log(`[CacheAntiLeak] Consistency check completed - Total: ${this.stats.totalEntries} entries, ${this.stats.totalSizeGB.toFixed(2)}GB`);
    }
  }

  /**
   * Démarrage des processus en arrière-plan
   */
  private startBackgroundProcesses(): void {
    if (!this.config.enabled) return;
    
    // Nettoyage périodique toutes les 5 minutes
    this.cleanupTimer = setInterval(() => {
      this.periodicCleanup().catch(console.error);
    }, 5 * 60 * 1000);
    
    // Vérification de cohérence toutes les heures
    this.consistencyTimer = setInterval(() => {
      this.consistencyCheck().catch(console.error);
    }, 60 * 60 * 1000);
  }

  /**
   * Estimation de taille d'un objet
   */
  private estimateSize(data: any): number {
    try {
      return JSON.stringify(data).length * 2; // UTF-16, approximation
    } catch {
      return 1024; // Taille par défaut si non sérialisable
    }
  }

  /**
   * Vérification d'expiration
   */
  private isExpired(entry: CacheEntry<any>): boolean {
    const now = Date.now();
    return (now - entry.createdAt.getTime()) > entry.ttl;
  }

  /**
   * Mise à jour des statistiques après stockage
   */
  private updateStatsAfterStore(entry: CacheEntry<any>): void {
    this.stats.totalEntries++;
    this.stats.totalSizeBytes += entry.size;
    this.stats.totalSizeGB = this.stats.totalSizeBytes / (1024 * 1024 * 1024);
    this.stats.averageEntrySize = this.stats.totalSizeBytes / this.stats.totalEntries;
    
    if (!this.stats.oldestEntry || entry.createdAt < new Date(this.stats.oldestEntry)) {
      this.stats.oldestEntry = entry.createdAt;
    }
    if (!this.stats.newestEntry || entry.createdAt > new Date(this.stats.newestEntry)) {
      this.stats.newestEntry = entry.createdAt;
    }
  }

  /**
   * Mise à jour des statistiques après éviction
   */
  private updateStatsAfterEviction(entry: CacheEntry<any>): void {
    this.stats.totalEntries--;
    this.stats.totalSizeBytes -= entry.size;
    this.stats.totalSizeGB = this.stats.totalSizeBytes / (1024 * 1024 * 1024);
    this.stats.evictionCount++;
    
    if (this.stats.totalEntries > 0) {
      this.stats.averageEntrySize = this.stats.totalSizeBytes / this.stats.totalEntries;
    } else {
      this.stats.averageEntrySize = 0;
      this.stats.oldestEntry = null;
      this.stats.newestEntry = null;
    }
  }

  /**
   * Mise à jour du taux de hit
   */
  private updateHitRate(): void {
    const totalRequests = this.stats.hitCount + this.stats.missCount;
    this.stats.hitRate = totalRequests > 0 ? (this.stats.hitCount / totalRequests) * 100 : 0;
  }

  /**
   * Mise à jour complète des statistiques
   */
  private updateStats(): void {
    this.stats.totalEntries = this.cache.size;
    this.stats.totalSizeBytes = Array.from(this.cache.values()).reduce((sum, entry) => sum + entry.size, 0);
    this.stats.totalSizeGB = this.stats.totalSizeBytes / (1024 * 1024 * 1024);
    
    if (this.cache.size > 0) {
      this.stats.averageEntrySize = this.stats.totalSizeBytes / this.cache.size;
      
      const entries = Array.from(this.cache.values());
      const dates = entries.map(e => e.createdAt);
      this.stats.oldestEntry = new Date(Math.min(...dates.map(d => d.getTime())));
      this.stats.newestEntry = new Date(Math.max(...dates.map(d => d.getTime())));
    }
    
    this.updateHitRate();
  }

  /**
   * API publiques
   */

  /**
   * Nettoyage manuel du cache
   */
  async cleanup(): Promise<{ evicted: number; freedGB: number }> {
    const initialSize = this.stats.totalSizeGB;
    const initialCount = this.stats.totalEntries;
    
    await this.periodicCleanup();
    
    const evicted = initialCount - this.stats.totalEntries;
    const freedGB = initialSize - this.stats.totalSizeGB;
    
    return { evicted, freedGB };
  }

  /**
   * Reset complet du cache
   */
  async reset(): Promise<void> {
    const removedEntries = this.cache.size;
    this.cache.clear();
    
    this.stats.totalEntries = 0;
    this.stats.totalSizeBytes = 0;
    this.stats.totalSizeGB = 0;
    this.stats.evictionCount += removedEntries;
    this.stats.averageEntrySize = 0;
    this.stats.oldestEntry = null;
    this.stats.newestEntry = null;
    
    console.log(`[CacheAntiLeak] Cache reset: ${removedEntries} entries removed`);
  }

  /**
   * Statistiques en temps réel
   */
  getStats(): CacheStats {
    this.updateStats();
    return { ...this.stats };
  }

  /**
   * Health check du cache
   */
  healthCheck(): {
    status: 'healthy' | 'warning' | 'critical';
    issues: string[];
    stats: CacheStats;
  } {
    const issues: string[] = [];
    let status: 'healthy' | 'warning' | 'critical' = 'healthy';
    
    // Vérification de la taille
    if (this.stats.totalSizeGB > this.config.maxTrafficGB * 0.95) {
      issues.push(`Cache size critical: ${this.stats.totalSizeGB.toFixed(2)}GB / ${this.config.maxTrafficGB}GB`);
      status = 'critical';
    } else if (this.stats.totalSizeGB > this.config.maxTrafficGB * 0.8) {
      issues.push(`Cache size warning: ${this.stats.totalSizeGB.toFixed(2)}GB / ${this.config.maxTrafficGB}GB`);
      if (status !== 'critical') status = 'warning' as any;
    }
    
    // Vérification du taux de hit
    if (this.stats.hitRate < 30) {
      issues.push(`Low hit rate: ${this.stats.hitRate.toFixed(1)}%`);
      if (status === 'healthy') status = 'warning';
    }
    
    // Vérification des alertes
    if (this.stats.alertsTriggered > 10) {
      issues.push(`High alert count: ${this.stats.alertsTriggered}`);
      if (status === 'healthy') status = 'warning';
    }
    
    return {
      status,
      issues,
      stats: this.getStats()
    };
  }

  /**
   * Arrêt propre du gestionnaire
   */
  async shutdown(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    
    if (this.consistencyTimer) {
      clearInterval(this.consistencyTimer);
      this.consistencyTimer = null;
    }
    
    console.log(`[CacheAntiLeak] Shutdown - Final stats: ${this.stats.totalEntries} entries, ${this.stats.totalSizeGB.toFixed(2)}GB`);
  }
}

/**
 * Factory pour création du Cache Anti-Leak Manager
 */
export function createCacheAntiLeakManager(config?: Partial<CacheAntiLeakConfig>): CacheAntiLeakManager {
  return new CacheAntiLeakManager(config);
}

/**
 * Exports des types pour utilisation externe
 */
export type { CacheEntry, CacheStats, EvictionPolicy };