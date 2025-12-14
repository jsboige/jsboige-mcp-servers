/**
 * Gestionnaire central d'identité pour RooSync
 * 
 * Responsable d'unifier toutes les sources d'identité en une seule
 * source de vérité et de prévenir les conflits d'écrasement.
 * 
 * @module IdentityManager
 * @version 1.0.0
 */

import { promises as fs, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { RooSyncConfig } from '../../config/roosync-config.js';
import { PresenceManager } from './PresenceManager.js';

/**
 * Sources d'identité possibles
 */
export type IdentitySource = 'config' | 'presence' | 'baseline' | 'dashboard' | 'registry';

/**
 * Informations d'identité complètes
 */
export interface IdentityInfo {
  machineId: string;
  source: IdentitySource;
  firstSeen: string;
  lastSeen: string;
  status: 'valid' | 'conflict' | 'orphaned';
  metadata?: {
    configPath?: string;
    presencePath?: string;
    baselinePath?: string;
    dashboardPath?: string;
    registryPath?: string;
  };
}

/**
 * Résultat de validation d'identité
 */
export interface IdentityValidationResult {
  isValid: boolean;
  conflicts: Array<{
    machineId: string;
    sources: IdentitySource[];
    warningMessage: string;
  }>;
  orphaned: IdentityInfo[];
  recommendations: string[];
}

/**
 * Erreur du gestionnaire d'identité
 */
export class IdentityManagerError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(`[IdentityManager] ${message}`);
    this.name = 'IdentityManagerError';
  }
}

/**
 * Gestionnaire central d'identité
 */
export class IdentityManager {
  constructor(
    private config: RooSyncConfig,
    private presenceManager: PresenceManager
  ) {}

  /**
   * Obtenir le chemin du registre d'identité
   */
  private getIdentityRegistryPath(): string {
    return join(this.config.sharedPath, '.identity-registry.json');
  }

  /**
   * Charger le registre d'identité depuis le disque
   */
  private async loadIdentityRegistry(): Promise<Map<string, IdentityInfo>> {
    try {
      const registryPath = this.getIdentityRegistryPath();
      
      if (existsSync(registryPath)) {
        const content = await fs.readFile(registryPath, 'utf-8');
        const data = JSON.parse(content);
        
        const registry = new Map<string, IdentityInfo>();
        for (const [machineId, info] of Object.entries(data.identities || {})) {
          registry.set(machineId, info as IdentityInfo);
        }
        
        console.log(`[IdentityManager] Registre d'identité chargé: ${registry.size} identités`);
        return registry;
      }
    } catch (error) {
      console.warn('[IdentityManager] Erreur chargement registre d\'identité:', error);
    }
    
    return new Map<string, IdentityInfo>();
  }

  /**
   * Sauvegarder le registre d'identité sur le disque
   */
  private async saveIdentityRegistry(registry: Map<string, IdentityInfo>): Promise<void> {
    try {
      const registryPath = this.getIdentityRegistryPath();
      const data = {
        identities: Object.fromEntries(registry),
        lastUpdated: new Date().toISOString(),
        version: '1.0.0'
      };
      
      await fs.writeFile(
        registryPath,
        JSON.stringify(data, null, 2),
        'utf-8'
      );
      
      console.log(`[IdentityManager] Registre d'identité sauvegardé: ${registry.size} identités`);
    } catch (error) {
      console.error('[IdentityManager] Erreur sauvegarde registre d\'identité:', error);
      throw new IdentityManagerError(
        `Impossible de sauvegarder le registre d\'identité: ${error instanceof Error ? error.message : String(error)}`,
        'REGISTRY_SAVE_FAILED'
      );
    }
  }

  /**
   * Collecter les identités depuis toutes les sources
   */
  public async collectAllIdentities(): Promise<Map<string, IdentityInfo>> {
    const identities = new Map<string, IdentityInfo>();
    const now = new Date().toISOString();

    try {
      // 1. Identité depuis la configuration
      const configIdentity: IdentityInfo = {
        machineId: this.config.machineId,
        source: 'config',
        firstSeen: now,
        lastSeen: now,
        status: 'valid',
        metadata: {
          configPath: process.env.ROOSYNC_CONFIG_PATH || 'environment'
        }
      };
      identities.set(this.config.machineId, configIdentity);

      // 2. Identités depuis les fichiers de présence
      const allPresence = await this.presenceManager.listAllPresence();
      for (const presence of allPresence) {
        const presenceIdentity: IdentityInfo = {
          machineId: presence.id,
          source: 'presence',
          firstSeen: presence.firstSeen || presence.lastSeen,
          lastSeen: presence.lastSeen,
          status: 'valid',
          metadata: {
            presencePath: join(this.config.sharedPath, 'presence', `${presence.id}.json`)
          }
        };
        
        // Fusionner avec l'identité existante si déjà présente
        const existing = identities.get(presence.id);
        if (existing) {
          // Conserver la première date d'apparition
          presenceIdentity.firstSeen = existing.firstSeen;
          presenceIdentity.status = 'conflict'; // Marquer comme conflit
        }
        
        identities.set(presence.id, presenceIdentity);
      }

      // 3. Identité depuis la baseline
      const baselinePath = join(this.config.sharedPath, 'sync-config.ref.json');
      if (existsSync(baselinePath)) {
        try {
          const baselineContent = readFileSync(baselinePath, 'utf-8');
          const baselineData = JSON.parse(baselineContent);
          
          if (baselineData.machineId) {
            const baselineIdentity: IdentityInfo = {
              machineId: baselineData.machineId,
              source: 'baseline',
              firstSeen: baselineData.timestamp || now,
              lastSeen: now,
              status: 'valid',
              metadata: {
                baselinePath
              }
            };
            
            // Fusionner avec l'identité existante si déjà présente
            const existing = identities.get(baselineData.machineId);
            if (existing) {
              baselineIdentity.firstSeen = existing.firstSeen;
              baselineIdentity.status = 'conflict'; // Marquer comme conflit
            }
            
            identities.set(baselineData.machineId, baselineIdentity);
          }
        } catch (error) {
          console.warn('[IdentityManager] Erreur lecture baseline:', error);
        }
      }

      // 4. Identité depuis le dashboard
      const dashboardPath = join(this.config.sharedPath, 'sync-dashboard.json');
      if (existsSync(dashboardPath)) {
        try {
          const dashboardContent = readFileSync(dashboardPath, 'utf-8');
          const dashboardData = JSON.parse(dashboardContent);
          
          if (dashboardData.machines) {
            for (const [machineId, machineInfo] of Object.entries(dashboardData.machines)) {
              const dashboardIdentity: IdentityInfo = {
                machineId,
                source: 'dashboard',
                firstSeen: now,
                lastSeen: now,
                status: 'valid',
                metadata: {
                  dashboardPath
                }
              };
              
              // Fusionner avec l'identité existante si déjà présente
              const existing = identities.get(machineId);
              if (existing) {
                dashboardIdentity.firstSeen = existing.firstSeen;
                dashboardIdentity.status = 'conflict'; // Marquer comme conflit
              }
              
              identities.set(machineId, dashboardIdentity);
            }
          }
        } catch (error) {
          console.warn('[IdentityManager] Erreur lecture dashboard:', error);
        }
      }

      console.log(`[IdentityManager] Collecte terminée: ${identities.size} identités trouvées`);
      return identities;
      
    } catch (error) {
      console.error('[IdentityManager] Erreur collecte identités:', error);
      throw new IdentityManagerError(
        `Erreur lors de la collecte des identités: ${error instanceof Error ? error.message : String(error)}`,
        'COLLECTION_FAILED'
      );
    }
  }

  /**
   * Valider toutes les identités et détecter les conflits
   */
  public async validateIdentities(): Promise<IdentityValidationResult> {
    try {
      const identities = await this.collectAllIdentities();
      const conflicts: Array<{
        machineId: string;
        sources: IdentitySource[];
        warningMessage: string;
      }> = [];
      
      const machineIdMap = new Map<string, IdentitySource[]>();
      
      // Grouper les identités par machineId
      for (const identity of identities.values()) {
        const sources = machineIdMap.get(identity.machineId) || [];
        sources.push(identity.source);
        machineIdMap.set(identity.machineId, sources);
      }
      
      // Détecter les conflits
      for (const [machineId, sources] of machineIdMap) {
        if (sources.length > 1) {
          const warningMessage = `⚠️ CONFLIT D'IDENTITÉ: MachineId "${machineId}" trouvé dans ${sources.length} sources: ${sources.join(', ')}`;
          console.error(`[IdentityManager] ${warningMessage}`);
          
          conflicts.push({
            machineId,
            sources,
            warningMessage
          });
        }
      }
      
      // Identifier les identités orphelines
      const orphaned: IdentityInfo[] = [];
      for (const identity of identities.values()) {
        if (identity.status === 'orphaned') {
          orphaned.push(identity);
        }
      }
      
      // Générer des recommandations
      const recommendations: string[] = [];
      if (conflicts.length > 0) {
        recommendations.push(`Résoudre les ${conflicts.length} conflits d'identité détectés`);
        recommendations.push('Utiliser des machineId uniques pour chaque machine');
        recommendations.push('Nettoyer les fichiers de présence obsolètes');
      }
      
      if (orphaned.length > 0) {
        recommendations.push(`Nettoyer les ${orphaned.length} identités orphelines`);
      }
      
      if (recommendations.length === 0) {
        recommendations.push('✅ Aucun problème d\'identité détecté');
      }
      
      return {
        isValid: conflicts.length === 0 && orphaned.length === 0,
        conflicts,
        orphaned,
        recommendations
      };
      
    } catch (error) {
      console.error('[IdentityManager] Erreur validation identités:', error);
      return {
        isValid: false,
        conflicts: [],
        orphaned: [],
        recommendations: ['Erreur lors de la validation des identités']
      };
    }
  }

  /**
   * Obtenir l'identité principale (celle de la configuration courante)
   */
  public getPrimaryIdentity(): IdentityInfo {
    return {
      machineId: this.config.machineId,
      source: 'config',
      firstSeen: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      status: 'valid',
      metadata: {
        configPath: process.env.ROOSYNC_CONFIG_PATH || 'environment'
      }
    };
  }

  /**
   * Synchroniser le registre d'identité avec l'état actuel
   */
  public async syncIdentityRegistry(): Promise<void> {
    try {
      console.log('[IdentityManager] Synchronisation du registre d\'identité');
      
      const currentIdentities = await this.collectAllIdentities();
      await this.saveIdentityRegistry(currentIdentities);
      
      // Valider après synchronisation
      const validation = await this.validateIdentities();
      
      if (!validation.isValid) {
        console.warn('[IdentityManager] ⚠️ Problèmes d\'identité détectés après synchronisation:');
        for (const conflict of validation.conflicts) {
          console.warn(`[IdentityManager] ${conflict.warningMessage}`);
        }
        for (const recommendation of validation.recommendations) {
          console.info(`[IdentityManager] 💡 ${recommendation}`);
        }
      } else {
        console.log('[IdentityManager] ✅ Registre d\'identité synchronisé sans conflits');
      }
      
    } catch (error) {
      console.error('[IdentityManager] Erreur synchronisation registre:', error);
      throw error;
    }
  }

  /**
   * Nettoyer les identités orphelines ou en conflit
   */
  public async cleanupIdentities(options: {
    removeOrphaned?: boolean;
    resolveConflicts?: boolean;
    dryRun?: boolean;
  } = {}): Promise<{
    removed: string[];
    resolved: string[];
    errors: string[];
  }> {
    const { removeOrphaned = false, resolveConflicts = false, dryRun = false } = options;
    
    const result = {
      removed: [] as string[],
      resolved: [] as string[],
      errors: [] as string[]
    };
    
    try {
      const validation = await this.validateIdentities();
      
      // Nettoyer les identités orphelines
      if (removeOrphaned) {
        for (const orphan of validation.orphaned) {
          try {
            if (!dryRun) {
              if (orphan.source === 'presence') {
                await this.presenceManager.removePresence(orphan.machineId);
              }
              // TODO: Ajouter le nettoyage pour les autres sources
            }
            result.removed.push(orphan.machineId);
            console.log(`[IdentityManager] ${dryRun ? '[DRY RUN] ' : ''}Identité orpheline supprimée: ${orphan.machineId} (${orphan.source})`);
          } catch (error) {
            result.errors.push(`Erreur suppression ${orphan.machineId}: ${error}`);
          }
        }
      }
      
      // Résoudre les conflits
      if (resolveConflicts) {
        for (const conflict of validation.conflicts) {
          try {
            // Stratégie: conserver l'identité de la configuration courante
            if (conflict.machineId === this.config.machineId) {
              if (!dryRun) {
                // TODO: Implémenter la résolution de conflits
              }
              result.resolved.push(conflict.machineId);
              console.log(`[IdentityManager] ${dryRun ? '[DRY RUN] ' : ''}Conflit résolu pour: ${conflict.machineId} (identité principale conservée)`);
            }
          } catch (error) {
            result.errors.push(`Erreur résolution ${conflict.machineId}: ${error}`);
          }
        }
      }
      
      return result;
      
    } catch (error) {
      result.errors.push(`Erreur nettoyage identités: ${error}`);
      return result;
    }
  }
}