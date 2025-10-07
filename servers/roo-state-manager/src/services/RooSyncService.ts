/**
 * Service RooSync pour roo-state-manager
 * 
 * Service Singleton qui gère l'interaction avec les fichiers RooSync,
 * le cache, et fournit une API unifiée pour les outils MCP.
 * 
 * @module RooSyncService
 * @version 2.0.0
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { loadRooSyncConfig, RooSyncConfig } from '../config/roosync-config.js';
import {
  parseRoadmapMarkdown,
  parseDashboardJson,
  parseConfigJson,
  filterDecisionsByStatus,
  filterDecisionsByMachine,
  findDecisionById,
  type RooSyncDecision,
  type RooSyncDashboard
} from '../utils/roosync-parsers.js';

/**
 * Options de cache pour RooSyncService
 */
export interface CacheOptions {
  /** Durée de vie du cache en millisecondes (défaut: 30000 = 30s) */
  ttl?: number;
  
  /** Activer/désactiver le cache */
  enabled?: boolean;
}

/**
 * Entrée de cache
 */
interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

/**
 * Erreur du service RooSync
 */
export class RooSyncServiceError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(`[RooSync Service] ${message}`);
    this.name = 'RooSyncServiceError';
  }
}

/**
 * Service Singleton pour gérer RooSync
 */
export class RooSyncService {
  private static instance: RooSyncService | null = null;
  
  private config: RooSyncConfig;
  private cache: Map<string, CacheEntry<any>>;
  private cacheOptions: Required<CacheOptions>;
  
  /**
   * Constructeur privé (Singleton)
   */
  private constructor(cacheOptions?: CacheOptions) {
    this.config = loadRooSyncConfig();
    this.cache = new Map();
    this.cacheOptions = {
      ttl: cacheOptions?.ttl ?? 30000, // 30 secondes par défaut
      enabled: cacheOptions?.enabled ?? true
    };
  }
  
  /**
   * Obtenir l'instance du service (Singleton)
   * 
   * @param cacheOptions Options de cache (utilisées seulement à la première création)
   * @returns Instance du service
   */
  public static getInstance(cacheOptions?: CacheOptions): RooSyncService {
    if (!RooSyncService.instance) {
      RooSyncService.instance = new RooSyncService(cacheOptions);
    }
    return RooSyncService.instance;
  }
  
  /**
   * Réinitialiser l'instance (utile pour les tests)
   */
  public static resetInstance(): void {
    RooSyncService.instance = null;
  }
  
  /**
   * Obtenir la configuration RooSync
   */
  public getConfig(): RooSyncConfig {
    return this.config;
  }
  
  /**
   * Vider le cache
   */
  public clearCache(): void {
    this.cache.clear();
  }
  
  /**
   * Récupérer depuis le cache ou exécuter la fonction
   */
  private async getOrCache<T>(
    key: string,
    fetchFn: () => T | Promise<T>
  ): Promise<T> {
    if (!this.cacheOptions.enabled) {
      return fetchFn();
    }
    
    // Vérifier le cache
    const cached = this.cache.get(key);
    if (cached) {
      const age = Date.now() - cached.timestamp;
      if (age < this.cacheOptions.ttl) {
        return cached.data as T;
      }
      // Cache expiré
      this.cache.delete(key);
    }
    
    // Fetch et mise en cache
    const data = await fetchFn();
    this.cache.set(key, {
      data,
      timestamp: Date.now()
    });
    
    return data;
  }
  
  /**
   * Obtenir le chemin complet d'un fichier RooSync
   */
  private getRooSyncFilePath(filename: string): string {
    return join(this.config.sharedPath, filename);
  }
  
  /**
   * Vérifier si un fichier RooSync existe
   */
  private checkFileExists(filename: string): void {
    const filePath = this.getRooSyncFilePath(filename);
    if (!existsSync(filePath)) {
      throw new RooSyncServiceError(
        `Fichier RooSync introuvable: ${filename}`,
        'FILE_NOT_FOUND'
      );
    }
  }
  
  /**
   * Charger le dashboard RooSync
   */
  public async loadDashboard(): Promise<RooSyncDashboard> {
    return this.getOrCache('dashboard', () => {
      this.checkFileExists('sync-dashboard.json');
      return parseDashboardJson(this.getRooSyncFilePath('sync-dashboard.json'));
    });
  }
  
  /**
   * Charger toutes les décisions de la roadmap
   */
  public async loadDecisions(): Promise<RooSyncDecision[]> {
    return this.getOrCache('decisions', () => {
      this.checkFileExists('sync-roadmap.md');
      return parseRoadmapMarkdown(this.getRooSyncFilePath('sync-roadmap.md'));
    });
  }
  
  /**
   * Charger les décisions en attente pour cette machine
   */
  public async loadPendingDecisions(): Promise<RooSyncDecision[]> {
    const allDecisions = await this.loadDecisions();
    const pending = filterDecisionsByStatus(allDecisions, 'pending');
    return filterDecisionsByMachine(pending, this.config.machineId);
  }
  
  /**
   * Obtenir une décision par ID
   */
  public async getDecision(id: string): Promise<RooSyncDecision | null> {
    const decisions = await this.loadDecisions();
    return findDecisionById(decisions, id) || null;
  }
  
  /**
   * Obtenir l'état de synchronisation global
   */
  public async getStatus(): Promise<{
    machineId: string;
    overallStatus: string;
    lastSync: string | null;
    pendingDecisions: number;
    diffsCount: number;
  }> {
    const dashboard = await this.loadDashboard();
    const machineInfo = dashboard.machines[this.config.machineId];
    
    if (!machineInfo) {
      throw new RooSyncServiceError(
        `Machine ${this.config.machineId} non trouvée dans le dashboard`,
        'MACHINE_NOT_FOUND'
      );
    }
    
    return {
      machineId: this.config.machineId,
      overallStatus: dashboard.overallStatus,
      lastSync: machineInfo.lastSync,
      pendingDecisions: machineInfo.pendingDecisions,
      diffsCount: machineInfo.diffsCount
    };
  }
  
  /**
   * Comparer la configuration avec une autre machine
   */
  public async compareConfig(targetMachineId?: string): Promise<{
    localMachine: string;
    targetMachine: string;
    differences: {
      field: string;
      localValue: any;
      targetValue: any;
    }[];
  }> {
    this.checkFileExists('sync-config.json');
    
    const localConfigPath = this.getRooSyncFilePath('sync-config.json');
    const localConfig = parseConfigJson(localConfigPath);
    
    // Si pas de machine cible spécifiée, comparer avec toutes
    if (!targetMachineId) {
      const dashboard = await this.loadDashboard();
      const machines = Object.keys(dashboard.machines).filter(
        m => m !== this.config.machineId
      );
      
      if (machines.length === 0) {
        throw new RooSyncServiceError(
          'Aucune autre machine trouvée pour la comparaison',
          'NO_TARGET_MACHINE'
        );
      }
      
      // Prendre la première machine par défaut
      targetMachineId = machines[0];
    }
    
    // Pour l'instant, retourne une structure de base
    // L'implémentation complète viendra avec les outils MCP
    return {
      localMachine: this.config.machineId,
      targetMachine: targetMachineId,
      differences: []
    };
  }
  
  /**
   * Lister les différences détectées
   */
  public async listDiffs(filterByType?: 'all' | 'config' | 'files' | 'settings'): Promise<{
    totalDiffs: number;
    diffs: {
      type: string;
      path: string;
      description: string;
      machines: string[];
    }[];
  }> {
    const dashboard = await this.loadDashboard();
    const decisions = await this.loadDecisions();
    
    // Filtrer les décisions qui représentent des diffs
    const pendingDecisions = filterDecisionsByStatus(decisions, 'pending');
    
    let filteredDiffs = pendingDecisions;
    if (filterByType && filterByType !== 'all') {
      const typeMap: Record<string, RooSyncDecision['type']> = {
        'config': 'config',
        'files': 'file',
        'settings': 'setting'
      };
      const targetType = typeMap[filterByType];
      if (targetType) {
        filteredDiffs = pendingDecisions.filter((d: RooSyncDecision) => d.type === targetType);
      }
    }
    
    return {
      totalDiffs: filteredDiffs.length,
      diffs: filteredDiffs.map((d: RooSyncDecision) => ({
        type: d.type,
        path: d.path || '',
        description: d.title,
        machines: d.targetMachines
      }))
    };
  }
}

/**
 * Helper pour obtenir l'instance du service RooSync
 */
export function getRooSyncService(cacheOptions?: CacheOptions): RooSyncService {
  return RooSyncService.getInstance(cacheOptions);
}