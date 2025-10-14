/**
 * Service RooSync pour roo-state-manager
 * 
 * Service Singleton qui gère l'interaction avec les fichiers RooSync,
 * le cache, et fournit une API unifiée pour les outils MCP.
 * 
 * @module RooSyncService
 * @version 2.0.0
 */

import { existsSync, promises as fs } from 'fs';
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
import { PowerShellExecutor, type PowerShellExecutionResult } from './PowerShellExecutor.js';

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
 * Résultat d'exécution de décision
 */
export interface DecisionExecutionResult {
  /** Succès de l'exécution */
  success: boolean;
  
  /** Logs d'exécution */
  logs: string[];
  
  /** Changements appliqués */
  changes: {
    filesModified: string[];
    filesCreated: string[];
    filesDeleted: string[];
  };
  
  /** Temps d'exécution en millisecondes */
  executionTime: number;
  
  /** Message d'erreur si échec */
  error?: string;
}

/**
 * Résultat de restauration rollback
 */
export interface RollbackRestoreResult {
  /** Succès de la restauration */
  success: boolean;
  
  /** Fichiers restaurés */
  restoredFiles: string[];
  
  /** Logs de restauration */
  logs: string[];
  
  /** Message d'erreur si échec */
  error?: string;
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
  private powershellExecutor: PowerShellExecutor;
  
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
    this.powershellExecutor = new PowerShellExecutor({
      roosyncBasePath: join(process.env.ROO_HOME || 'd:/roo-extensions', 'RooSync')
    });
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

  /**
   * Exécute une décision de synchronisation via PowerShell
   * 
   * Workflow :
   * 1. Vérifie que la décision existe
   * 2. Approuve la décision dans sync-roadmap.md (si pas déjà fait)
   * 3. Invoque sync-manager.ps1 -Action Apply-Decisions
   * 4. Parse la sortie pour extraire logs et changements
   * 
   * @param decisionId ID de la décision à exécuter
   * @param options Options d'exécution
   * @returns Résultat de l'exécution
   */
  public async executeDecision(
    decisionId: string,
    options?: { dryRun?: boolean; force?: boolean }
  ): Promise<DecisionExecutionResult> {
    try {
      // 1. Vérifier que la décision existe
      const decision = await this.getDecision(decisionId);
      if (!decision) {
        return {
          success: false,
          logs: [`Décision ${decisionId} introuvable`],
          changes: { filesModified: [], filesCreated: [], filesDeleted: [] },
          executionTime: 0,
          error: `Decision ${decisionId} not found`
        };
      }

      // 2. Approuver la décision dans roadmap si pas déjà fait
      await this.approveDecisionInRoadmap(decisionId);

      // 3. Gestion dryRun : Backup roadmap si dryRun activé
      const roadmapPath = this.getRooSyncFilePath('sync-roadmap.md');
      let roadmapBackup: string | null = null;
      
      if (options?.dryRun) {
        roadmapBackup = await fs.readFile(roadmapPath, 'utf-8');
      }

      // 4. Exécuter Apply-Decisions via PowerShell
      const result = await this.powershellExecutor.executeScript(
        'src/sync-manager.ps1',
        ['-Action', 'Apply-Decisions'],
        { timeout: 60000 } // 60s pour les opérations de fichiers
      );

      // 5. Restaurer roadmap si dryRun
      if (options?.dryRun && roadmapBackup) {
        await fs.writeFile(roadmapPath, roadmapBackup, 'utf-8');
      }

      // 6. Parser la sortie
      if (!result.success) {
        return {
          success: false,
          logs: this.parseLogsFromOutput(result.stderr || result.stdout),
          changes: { filesModified: [], filesCreated: [], filesDeleted: [] },
          executionTime: result.executionTime,
          error: `PowerShell execution failed: ${result.stderr}`
        };
      }

      // Extraire les informations de la sortie console
      const logs = this.parseLogsFromOutput(result.stdout);
      const changes = this.parseChangesFromOutput(result.stdout);

      // Invalider le cache après modification
      this.clearCache();

      return {
        success: true,
        logs,
        changes,
        executionTime: result.executionTime
      };
    } catch (error) {
      return {
        success: false,
        logs: [`Execution error: ${error instanceof Error ? error.message : String(error)}`],
        changes: { filesModified: [], filesCreated: [], filesDeleted: [] },
        executionTime: 0,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * Approuve une décision dans sync-roadmap.md
   * 
   * Remplace `- [ ] **Approuver & Fusionner**` par `- [x] **Approuver & Fusionner**`
   * pour la décision spécifiée.
   * 
   * @param decisionId ID de la décision
   */
  private async approveDecisionInRoadmap(decisionId: string): Promise<void> {
    const roadmapPath = this.getRooSyncFilePath('sync-roadmap.md');
    let content = await fs.readFile(roadmapPath, 'utf-8');

    // Trouver le bloc de décision
    const decisionBlockRegex = new RegExp(
      `(<!-- DECISION_BLOCK_START -->.*?### DECISION ID: ${decisionId}.*?)- \\[ \\] \\*\\*Approuver & Fusionner\\*\\*(.*?<!-- DECISION_BLOCK_END -->)`,
      'gs'
    );

    const match = decisionBlockRegex.exec(content);
    if (!match) {
      throw new RooSyncServiceError(
        `Impossible de trouver la décision ${decisionId} dans sync-roadmap.md`,
        'DECISION_NOT_FOUND_IN_ROADMAP'
      );
    }

    // Remplacer la checkbox
    content = content.replace(
      decisionBlockRegex,
      '$1- [x] **Approuver & Fusionner**$2'
    );

    // Réécrire le fichier
    await fs.writeFile(roadmapPath, content, 'utf-8');
  }

  /**
   * Parse les logs depuis la sortie PowerShell
   */
  private parseLogsFromOutput(output: string): string[] {
    return output
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0);
  }

  /**
   * Parse les changements depuis la sortie PowerShell
   * 
   * Détecte les mentions de fichiers modifiés/créés/supprimés
   * dans la sortie console.
   */
  private parseChangesFromOutput(output: string): {
    filesModified: string[];
    filesCreated: string[];
    filesDeleted: string[];
  } {
    const changes = {
      filesModified: [] as string[],
      filesCreated: [] as string[],
      filesDeleted: [] as string[]
    };

    // Patterns de détection
    const patterns = {
      modified: /Configuration.*mise à jour|updated|modifié|modified/i,
      created: /créé|created|nouveau|new file/i,
      deleted: /supprimé|deleted|removed/i
    };

    const lines = output.split('\n');
    
    // Détection basique : si Apply-Decisions réussit, sync-config.ref.json est modifié
    if (output.includes('Configuration de référence mise à jour avec succès')) {
      changes.filesModified.push('sync-config.ref.json');
    }

    return changes;
  }

  /**
   * Crée un point de rollback pour une décision
   * 
   * Stratégie Phase 1 : Backup manuel dans .rollback/
   * - Sauvegarde sync-config.ref.json
   * - Sauvegarde sync-roadmap.md
   * - Crée metadata.json avec timestamp et decisionId
   * 
   * @param decisionId ID de la décision
   */
  public async createRollbackPoint(decisionId: string): Promise<void> {
    try {
      const sharedPath = this.config.sharedPath;
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const rollbackPath = join(sharedPath, '.rollback', `${decisionId}_${timestamp}`);

      // Créer le répertoire rollback
      await fs.mkdir(rollbackPath, { recursive: true });

      // Backup des fichiers critiques
      const filesToBackup = [
        'sync-config.ref.json',
        'sync-roadmap.md'
      ];

      for (const file of filesToBackup) {
        const sourcePath = this.getRooSyncFilePath(file);
        const targetPath = join(rollbackPath, file);
        
        if (existsSync(sourcePath)) {
          await fs.copyFile(sourcePath, targetPath);
        }
      }

      // Créer metadata
      const metadata = {
        decisionId,
        timestamp,
        machine: this.config.machineId,
        files: filesToBackup
      };

      await fs.writeFile(
        join(rollbackPath, 'metadata.json'),
        JSON.stringify(metadata, null, 2),
        'utf-8'
      );
    } catch (error) {
      throw new RooSyncServiceError(
        `Échec création rollback point: ${error instanceof Error ? error.message : String(error)}`,
        'ROLLBACK_CREATION_FAILED'
      );
    }
  }

  /**
   * Restaure depuis un point de rollback
   * 
   * Stratégie Phase 1 : Restore manuel depuis .rollback/
   * - Trouve le dernier rollback pour decisionId
   * - Restaure sync-config.ref.json
   * - Restaure sync-roadmap.md
   * 
   * @param decisionId ID de la décision
   * @returns Résultat de la restauration
   */
  public async restoreFromRollbackPoint(decisionId: string): Promise<RollbackRestoreResult> {
    try {
      const sharedPath = this.config.sharedPath;
      const rollbackDir = join(sharedPath, '.rollback');

      // Vérifier que le répertoire rollback existe
      if (!existsSync(rollbackDir)) {
        return {
          success: false,
          restoredFiles: [],
          logs: [`Aucun répertoire rollback trouvé dans ${rollbackDir}`],
          error: 'No rollback directory found'
        };
      }

      // Lister les rollbacks pour cette décision
      const allBackups = await fs.readdir(rollbackDir);
      const matchingBackups = allBackups
        .filter(name => name.startsWith(decisionId))
        .sort()
        .reverse(); // Plus récent en premier

      if (matchingBackups.length === 0) {
        return {
          success: false,
          restoredFiles: [],
          logs: [`Aucun rollback trouvé pour la décision ${decisionId}`],
          error: `No rollback found for decision ${decisionId}`
        };
      }

      // Restaurer depuis le plus récent
      const backupPath = join(rollbackDir, matchingBackups[0]);
      const restoredFiles: string[] = [];
      const logs: string[] = [];

      // Lire metadata
      const metadataPath = join(backupPath, 'metadata.json');
      let filesToRestore: string[] = ['sync-config.ref.json', 'sync-roadmap.md'];
      
      if (existsSync(metadataPath)) {
        const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf-8'));
        filesToRestore = metadata.files || filesToRestore;
        logs.push(`Rollback depuis ${metadata.timestamp}`);
      }

      // Restaurer les fichiers
      for (const file of filesToRestore) {
        const sourcePath = join(backupPath, file);
        const targetPath = this.getRooSyncFilePath(file);

        if (existsSync(sourcePath)) {
          await fs.copyFile(sourcePath, targetPath);
          restoredFiles.push(file);
          logs.push(`Restauré: ${file}`);
        }
      }

      // Invalider le cache
      this.clearCache();

      return {
        success: true,
        restoredFiles,
        logs,
      };
    } catch (error) {
      return {
        success: false,
        restoredFiles: [],
        logs: [`Erreur restauration: ${error instanceof Error ? error.message : String(error)}`],
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
}

/**
 * Helper pour obtenir l'instance du service RooSync
 */
export function getRooSyncService(cacheOptions?: CacheOptions): RooSyncService {
  return RooSyncService.getInstance(cacheOptions);
}