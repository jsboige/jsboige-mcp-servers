/**
 * Gestionnaire de Baseline RooSync
 *
 * Responsable de la gestion des baselines et du dashboard :
 * - Chargement/Calcul du dashboard
 * - Gestion des rollbacks
 * - État de synchronisation
 */

import { promises as fs, existsSync, readFileSync, constants } from 'fs';
import { join } from 'path';
import { RooSyncConfig } from '../../config/roosync-config.js';
import { RooSyncServiceError } from '../RooSyncService.js';

/**
 * Registre central des machines pour éviter les conflits d'identité
 */
interface MachineRegistry {
  /** Map des machineId vers leurs métadonnées */
  machines: Map<string, {
    machineId: string;
    firstSeen: string;
    lastSeen: string;
    source: 'dashboard' | 'presence' | 'baseline' | 'config';
    status: 'online' | 'offline' | 'conflict';
  }>;

  /** Fichier de sauvegarde du registre */
  registryPath: string;
}

/**
 * État de validation d'unicité
 */
interface UniquenessValidationResult {
  isValid: boolean;
  conflictDetected: boolean;
  conflictingMachineId?: string;
  conflictSource?: string;
  warningMessage?: string;
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

// Interface locale pour RooSyncDashboard pour éviter les erreurs de type
export interface RooSyncDashboard {
  version: string;
  lastUpdate: string;
  overallStatus: 'diverged' | 'synced' | 'conflict' | 'unknown';
  lastSync: string;
  status: 'diverged' | 'synced' | 'conflict' | 'unknown';
  machines: Record<string, {
    lastSync: string;
    status: 'diverged' | 'synced' | 'conflict' | 'unknown';
    diffsCount: number;
    pendingDecisions: number;
  }>;
  stats: {
    totalDiffs: number;
    totalDecisions: number;
    appliedDecisions: number;
    pendingDecisions: number;
  };
  machinesArray: Array<{
    id: string;
    status: 'diverged' | 'synced' | 'conflict' | 'unknown';
    lastSync: string;
    diffsCount: number;
    pendingDecisions: number;
  }>;
  summary: {
    totalMachines: number;
    onlineMachines: number;
    totalDiffs: number;
    totalPendingDecisions: number;
  };
}

export class BaselineManager {
  private machineRegistry: MachineRegistry;

  constructor(
    private config: RooSyncConfig,
    private baselineService: any,
    private configComparator: any,
    private nonNominativeService?: any
  ) {
    // Initialiser le registre central des machines
    this.machineRegistry = {
      machines: new Map(),
      registryPath: join(this.config.sharedPath, '.machine-registry.json')
    };

    // Initialiser le service non-nominatif si non fourni
    if (!this.nonNominativeService) {
      // Note: NonNominativeBaselineService n'est pas importé, on laisse undefined
      // Le service sera initialisé ailleurs si nécessaire
      console.warn('[BaselineManager] NonNominativeBaselineService non disponible');
    }

    // Charger le registre existant s'il y en a un
    this.loadMachineRegistry();
  }

  /**
   * Charger le registre des machines depuis le disque
   */
  private loadMachineRegistry(): void {
    try {
      if (existsSync(this.machineRegistry.registryPath)) {
        const registryContent = readFileSync(this.machineRegistry.registryPath, 'utf-8');
        const registryData = JSON.parse(registryContent);

        // Reconstruire la Map depuis les données JSON
        this.machineRegistry.machines = new Map(
          Object.entries(registryData.machines || {})
        );

        console.log(`[BaselineManager] Registre des machines chargé: ${this.machineRegistry.machines.size} machines`);
      }
    } catch (error) {
      console.warn('[BaselineManager] Erreur chargement registre des machines:', error);
      // Continuer avec un registre vide
      this.machineRegistry.machines = new Map();
    }
  }

  /**
   * Sauvegarder le registre des machines sur le disque
   */
  private async saveMachineRegistry(): Promise<void> {
    try {
      const registryData = {
        machines: Object.fromEntries(this.machineRegistry.machines),
        lastUpdated: new Date().toISOString()
      };

      await fs.writeFile(
        this.machineRegistry.registryPath,
        JSON.stringify(registryData, null, 2),
        'utf-8'
      );

      console.log('[BaselineManager] Registre des machines sauvegardé');
    } catch (error) {
      console.error('[BaselineManager] Erreur sauvegarde registre des machines:', error);
    }
  }

  /**
   * Valider l'unicité d'un machineId avant ajout
   */
  private validateMachineUniqueness(machineId: string, source: string): UniquenessValidationResult {
    const existingMachine = this.machineRegistry.machines.get(machineId);

    if (!existingMachine) {
      return {
        isValid: true,
        conflictDetected: false
      };
    }

    // Vérifier si c'est la même source (mise à jour normale)
    if (existingMachine.source === source) {
      return {
        isValid: true,
        conflictDetected: false
      };
    }

    // Conflit détecté : même machineId depuis des sources différentes
    const warningMessage = `⚠️ CONFLIT D'IDENTITÉ DÉTECTÉ: MachineId "${machineId}" déjà utilisé par la source "${existingMachine.source}" (première vue: ${existingMachine.firstSeen}). Tentative d'ajout depuis la source "${source}".`;

    console.warn(warningMessage);

    return {
      isValid: false,
      conflictDetected: true,
      conflictingMachineId: machineId,
      conflictSource: existingMachine.source,
      warningMessage
    };
  }

  /**
   * Ajouter une machine au registre avec validation d'unicité
   */
  private async addMachineToRegistry(
    machineId: string,
    source: 'dashboard' | 'presence' | 'baseline' | 'config',
    status: 'online' | 'offline' | 'conflict' = 'online'
  ): Promise<UniquenessValidationResult> {
    const validation = this.validateMachineUniqueness(machineId, source);

    if (!validation.isValid) {
      // Ne pas ajouter la machine en conflit, mais logger l'avertissement
      console.error(`[BaselineManager] REFUS D'AJOUT: ${validation.warningMessage}`);
      return validation;
    }

    const now = new Date().toISOString();
    const existingMachine = this.machineRegistry.machines.get(machineId);

    if (existingMachine) {
      // Mise à jour d'une machine existante
      existingMachine.lastSeen = now;
      existingMachine.status = status;
      console.log(`[BaselineManager] Machine ${machineId} mise à jour dans le registre`);
    } else {
      // Nouvelle machine
      this.machineRegistry.machines.set(machineId, {
        machineId,
        firstSeen: now,
        lastSeen: now,
        source,
        status
      });
      console.log(`[BaselineManager] Nouvelle machine ${machineId} ajoutée au registre depuis la source ${source}`);
    }

    // Sauvegarder le registre
    await this.saveMachineRegistry();

    return validation;
  }

  /**
   * Vérifier si une machine existe dans le registre
   */
  private machineExistsInRegistry(machineId: string): boolean {
    return this.machineRegistry.machines.has(machineId);
  }

  /**
   * Obtenir les informations d'une machine depuis le registre
   */
  private getMachineFromRegistry(machineId: string) {
    return this.machineRegistry.machines.get(machineId);
  }

  /**
   * Obtenir le chemin complet d'un fichier RooSync
   */
  private getRooSyncFilePath(filename: string): string {
    return join(this.config.sharedPath, filename);
  }

  /**
   * Charger le dashboard RooSync
   */
  public async loadDashboard(
    cacheCallback: (key: string, fetchFn: () => Promise<RooSyncDashboard>) => Promise<RooSyncDashboard>
  ): Promise<RooSyncDashboard> {
    return cacheCallback('dashboard', async () => {
      console.log('[BaselineManager] loadDashboard appelée à', new Date().toISOString());

      // Vérifier d'abord si le dashboard existe déjà
      const dashboardPath = this.getRooSyncFilePath('sync-dashboard.json');
      if (existsSync(dashboardPath)) {
        console.log('[BaselineManager] Dashboard existant trouvé, chargement depuis:', dashboardPath);
        try {
          const dashboardContent = readFileSync(dashboardPath, 'utf-8');
          const dashboard = JSON.parse(dashboardContent);
          console.log('[BaselineManager] Dashboard chargé avec succès depuis le fichier existant');

          // S'assurer que le dashboard a bien la propriété machines
          if (!dashboard.machines) {
            dashboard.machines = {};
          }

          // S'assurer que la machine courante existe dans le dashboard avec validation d'unicité
          if (!dashboard.machines[this.config.machineId]) {
            console.log(`[BaselineManager] Tentative d'ajout de la machine ${this.config.machineId} au dashboard existant`);

            // Valider l'unicité avant d'ajouter
            const validation = await this.addMachineToRegistry(this.config.machineId, 'dashboard');

            if (validation.isValid) {
              dashboard.machines[this.config.machineId] = {
                lastSync: new Date().toISOString(),
                status: 'synced' as 'diverged' | 'synced' | 'conflict' | 'unknown',
                diffsCount: 0,
                pendingDecisions: 0
              };
              console.log(`[BaselineManager] Machine ${this.config.machineId} ajoutée avec succès au dashboard`);
            } else {
              console.error(`[BaselineManager] ÉCHEC AJOUT DASHBOARD: ${validation.warningMessage}`);
              // Ne pas écraser la machine existante, mais logger le conflit
              if (validation.conflictingMachineId && dashboard.machines[validation.conflictingMachineId]) {
                console.warn(`[BaselineManager] Préservation de la machine existante ${validation.conflictingMachineId} dans le dashboard`);
              }
            }
          } else {
            // La machine existe déjà, valider que ce n'est pas un conflit
            const existingMachine = this.getMachineFromRegistry(this.config.machineId);
            if (existingMachine && existingMachine.source !== 'dashboard') {
              console.warn(`[BaselineManager] ATTENTION: Machine ${this.config.machineId} existe dans le dashboard mais provient de la source ${existingMachine.source}`);
            }
          }

          return dashboard as RooSyncDashboard;
        } catch (error) {
          console.warn('[BaselineManager] Erreur lecture dashboard existant, recalcule depuis baseline:', error);
        }
      }

      return this.calculateDashboardFromBaseline();
    });
  }

  /**
   * Calculer le dashboard à partir de la baseline
   */
  private async calculateDashboardFromBaseline(): Promise<RooSyncDashboard> {
    console.log('[BaselineManager] calculateDashboardFromBaseline - début de la méthode');
    const dashboardPath = this.getRooSyncFilePath('sync-dashboard.json');

    // S'assurer que la baseline est chargée
    await this.baselineService.loadBaseline();

    // Utiliser ConfigComparator pour obtenir les diffs
    const diffsResult = await this.configComparator.listDiffs('all');
    const totalDiffs = diffsResult.totalDiffs;

    // Récupérer la baseline pour les machines
    const baseline = await this.baselineService.loadBaseline();
    const allMachines = new Set<string>();

    if (baseline) {
      if (baseline.machineId) {
        allMachines.add(baseline.machineId);
      }
      if (this.config.machineId && !allMachines.has(this.config.machineId)) {
        allMachines.add(this.config.machineId);
      }
    }

    const now = new Date().toISOString();

    // Si un dashboard existe déjà, l'utiliser et s'assurer que la machine courante est présente
    if (existsSync(dashboardPath)) {
      try {
        const dashboardContent = readFileSync(dashboardPath, 'utf-8');
        const existingDashboard = JSON.parse(dashboardContent);
        console.log('[BaselineManager] Dashboard existant trouvé, vérification de la machine courante');

        if (!existingDashboard.machines) {
          existingDashboard.machines = {};
        }

        if (!existingDashboard.machines[this.config.machineId]) {
          console.log(`[BaselineManager] Tentative d'ajout de la machine ${this.config.machineId} au dashboard existant (calculateDashboardFromBaseline)`);

          // Valider l'unicité avant d'ajouter
          const validation = await this.addMachineToRegistry(this.config.machineId, 'dashboard');

          if (validation.isValid) {
            existingDashboard.machines[this.config.machineId] = {
              lastSync: now,
              status: (totalDiffs > 0 ? 'diverged' : 'synced') as 'diverged' | 'synced' | 'conflict' | 'unknown',
              diffsCount: totalDiffs,
              pendingDecisions: 0
            };
            console.log(`[BaselineManager] Machine ${this.config.machineId} ajoutée avec succès au dashboard (calculateDashboardFromBaseline)`);
          } else {
            console.error(`[BaselineManager] ÉCHEC AJOUT DASHBOARD (calculate): ${validation.warningMessage}`);
            // Ne pas écraser la machine existante, mais logger le conflit
            if (validation.conflictingMachineId && existingDashboard.machines[validation.conflictingMachineId]) {
              console.warn(`[BaselineManager] Préservation de la machine existante ${validation.conflictingMachineId} dans le dashboard (calculate)`);
            }
          }
        } else {
          // La machine existe déjà, valider que ce n'est pas un conflit
          const existingMachine = this.getMachineFromRegistry(this.config.machineId);
          if (existingMachine && existingMachine.source !== 'dashboard') {
            console.warn(`[BaselineManager] ATTENTION (calculate): Machine ${this.config.machineId} existe dans le dashboard mais provient de la source ${existingMachine.source}`);
          }
        }
      } catch (error) {
        console.warn('[BaselineManager] Erreur lecture dashboard existant, fallback sur calcul:', error);
      }
    }

    // Créer le résultat basé sur les données réelles
    const machinesArray = Array.from(allMachines).map(machineId => ({
      id: machineId,
      status: (totalDiffs > 0 ? 'diverged' : 'synced') as 'diverged' | 'synced' | 'conflict' | 'unknown',
      lastSync: now,
      pendingDecisions: 0,
      diffsCount: totalDiffs
    }));

    const summary = {
      totalMachines: allMachines.size,
      onlineMachines: allMachines.size,
      totalDiffs: totalDiffs,
      totalPendingDecisions: 0
    };

    const result = {
      version: '2.1.0',
      lastUpdate: now,
      overallStatus: (totalDiffs > 0 ? 'diverged' : 'synced') as 'diverged' | 'synced' | 'conflict' | 'unknown',
      lastSync: now,
      status: (totalDiffs > 0 ? 'diverged' : 'synced') as 'diverged' | 'synced' | 'conflict' | 'unknown',
      machines: machinesArray.reduce((acc, machine) => {
        acc[machine.id] = {
          lastSync: machine.lastSync,
          status: machine.status,
          diffsCount: machine.diffsCount,
          pendingDecisions: machine.pendingDecisions
        };
        return acc;
      }, {} as Record<string, any>),
      stats: {
        totalDiffs: totalDiffs,
        totalDecisions: totalDiffs,
        appliedDecisions: 0,
        pendingDecisions: 0
      },
      machinesArray,
      summary
    };

    if (!result.machines) {
      result.machines = {};
    }

    return result as RooSyncDashboard;
  }

  /**
   * Obtenir l'état de synchronisation global
   */
  public async getStatus(
    dashboardLoader: () => Promise<RooSyncDashboard>
  ): Promise<{
    machineId: string;
    overallStatus: string;
    lastSync: string | null;
    pendingDecisions: number;
    diffsCount: number;
  }> {
    const dashboard = await dashboardLoader();

    if (!dashboard || !dashboard.machines) {
      throw new RooSyncServiceError(
        `Dashboard invalide ou sans propriété machines`,
        'INVALID_DASHBOARD'
      );
    }

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
   * Crée un point de rollback pour une décision
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
   * Restaurer depuis un point de rollback
   *
   * Améliorations:
   * - Validation des fichiers avant restauration
   * - Rollback partiel en cas d'échec
   * - Logs détaillés pour debugging
   * - Gestion d'erreurs spécifiques par fichier
   * - Vérification d'intégrité après restauration
   */
  public async restoreFromRollbackPoint(
    decisionId: string,
    clearCacheCallback: () => void
  ): Promise<RollbackRestoreResult> {
    const logs: string[] = [];
    const restoredFiles: string[] = [];
    const failedFiles: Array<{ file: string; error: string }> = [];
    const startTime = Date.now();

    try {
      const sharedPath = this.config.sharedPath;
      const rollbackDir = join(sharedPath, '.rollback');

      logs.push(`[ROLLBACK] Début de la restauration pour décision ${decisionId}`);
      logs.push(`[ROLLBACK] Répertoire rollback: ${rollbackDir}`);

      // Vérifier que le répertoire rollback existe
      if (!existsSync(rollbackDir)) {
        logs.push(`[ROLLBACK] ❌ Aucun répertoire rollback trouvé dans ${rollbackDir}`);
        return {
          success: false,
          restoredFiles: [],
          logs,
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
        logs.push(`[ROLLBACK] ❌ Aucun rollback trouvé pour la décision ${decisionId}`);
        logs.push(`[ROLLBACK] Rollbacks disponibles: ${allBackups.join(', ') || 'aucun'}`);
        return {
          success: false,
          restoredFiles: [],
          logs,
          error: `No rollback found for decision ${decisionId}`
        };
      }

      logs.push(`[ROLLBACK] ${matchingBackups.length} rollback(s) trouvé(s) pour cette décision`);

      // Restaurer depuis le plus récent
      const backupPath = join(rollbackDir, matchingBackups[0]);
      logs.push(`[ROLLBACK] Utilisation du rollback le plus récent: ${matchingBackups[0]}`);

      // Vérifier que le répertoire de backup existe
      if (!existsSync(backupPath)) {
        logs.push(`[ROLLBACK] ❌ Répertoire de backup introuvable: ${backupPath}`);
        return {
          success: false,
          restoredFiles: [],
          logs,
          error: `Backup directory not found: ${backupPath}`
        };
      }

      // Lire metadata
      const metadataPath = join(backupPath, 'metadata.json');
      let filesToRestore: string[] = ['sync-config.ref.json', 'sync-roadmap.md'];
      let metadata: any = null;

      if (existsSync(metadataPath)) {
        try {
          const metadataContent = await fs.readFile(metadataPath, 'utf-8');
          metadata = JSON.parse(metadataContent);
          filesToRestore = metadata.files || filesToRestore;
          logs.push(`[ROLLBACK] Metadata lue: ${metadata.timestamp}, machine: ${metadata.machine}`);
          logs.push(`[ROLLBACK] Fichiers à restaurer: ${filesToRestore.join(', ')}`);
        } catch (metadataError) {
          logs.push(`[ROLLBACK] ⚠️ Erreur lecture metadata: ${metadataError instanceof Error ? metadataError.message : String(metadataError)}`);
          logs.push(`[ROLLBACK] Utilisation des fichiers par défaut`);
        }
      } else {
        logs.push(`[ROLLBACK] ⚠️ Metadata introuvable, utilisation des fichiers par défaut`);
      }

      // Restaurer les fichiers avec gestion d'erreurs individuelle
      for (const file of filesToRestore) {
        const sourcePath = join(backupPath, file);
        const targetPath = this.getRooSyncFilePath(file);

        try {
          // Vérifier que le fichier source existe
          if (!existsSync(sourcePath)) {
            logs.push(`[ROLLBACK] ⚠️ Fichier source introuvable: ${file}`);
            failedFiles.push({ file, error: 'Source file not found' });
            continue;
          }

          // Vérifier que le fichier source est lisible
          try {
            await fs.access(sourcePath, constants.R_OK);
          } catch (accessError) {
            logs.push(`[ROLLBACK] ❌ Fichier source non lisible: ${file}`);
            failedFiles.push({ file, error: 'Source file not readable' });
            continue;
          }

          // Faire un backup du fichier cible avant restauration (idempotence)
          if (existsSync(targetPath)) {
            const backupTargetPath = `${targetPath}.rollback-backup`;
            await fs.copyFile(targetPath, backupTargetPath);
            logs.push(`[ROLLBACK] Backup du fichier cible: ${file}`);
          }

          // Restaurer le fichier
          await fs.copyFile(sourcePath, targetPath);
          restoredFiles.push(file);
          logs.push(`[ROLLBACK] ✅ Restauré: ${file}`);

          // Vérifier l'intégrité du fichier restauré
          try {
            await fs.access(targetPath, constants.R_OK);
            const stats = await fs.stat(targetPath);
            logs.push(`[ROLLBACK] ✅ Intégrité vérifiée: ${file} (${stats.size} bytes)`);
          } catch (verifyError) {
            logs.push(`[ROLLBACK] ❌ Erreur vérification intégrité: ${file}`);
            failedFiles.push({ file, error: 'Integrity check failed' });

            // Retirer le fichier de restoredFiles et restaurer le backup
            const index = restoredFiles.indexOf(file);
            if (index !== -1) {
              restoredFiles.splice(index, 1);
              const backupTargetPath = `${targetPath}.rollback-backup`;
              if (existsSync(backupTargetPath)) {
                await fs.copyFile(backupTargetPath, targetPath);
                logs.push(`[ROLLBACK] 🔄 Backup restauré: ${file}`);
              }
            }
          }
        } catch (fileError) {
          const errorMsg = fileError instanceof Error ? fileError.message : String(fileError);
          logs.push(`[ROLLBACK] ❌ Erreur restauration ${file}: ${errorMsg}`);
          failedFiles.push({ file, error: errorMsg });
        }
      }

      // Nettoyer les backups temporaires
      for (const file of filesToRestore) {
        const targetPath = this.getRooSyncFilePath(file);
        const backupTargetPath = `${targetPath}.rollback-backup`;
        if (existsSync(backupTargetPath)) {
          try {
            await fs.unlink(backupTargetPath);
            logs.push(`[ROLLBACK] 🗑️ Backup temporaire supprimé: ${backupTargetPath}`);
          } catch (cleanupError) {
            logs.push(`[ROLLBACK] ⚠️ Erreur suppression backup: ${backupTargetPath}`);
          }
        }
      }

      // Invalider le cache
      try {
        clearCacheCallback();
        logs.push(`[ROLLBACK] ✅ Cache invalidé`);
      } catch (cacheError) {
        logs.push(`[ROLLBACK] ⚠️ Erreur invalidation cache: ${cacheError instanceof Error ? cacheError.message : String(cacheError)}`);
      }

      const duration = Date.now() - startTime;
      logs.push(`[ROLLBACK] Durée totale: ${duration}ms`);

      // Déterminer le succès
      // Le rollback est un succès si au moins un fichier a été restauré
      const success = restoredFiles.length > 0;

      if (success && failedFiles.length === 0) {
        logs.push(`[ROLLBACK] ✅ Restauration terminée avec succès (${restoredFiles.length} fichier(s))`);
      } else if (success && failedFiles.length > 0) {
        logs.push(`[ROLLBACK] ⚠️ Restauration partielle réussie (${restoredFiles.length} réussi(s), ${failedFiles.length} échoué(s))`);
      } else {
        logs.push(`[ROLLBACK] ❌ Restauration échouée (${failedFiles.length} erreur(s))`);
      }

      return {
        success,
        restoredFiles,
        logs,
        error: failedFiles.length > 0 ? `Partial failure: ${failedFiles.length} file(s) failed` : undefined
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;

      logs.push(`[ROLLBACK] ❌ Erreur critique: ${errorMsg}`);
      if (errorStack) {
        logs.push(`[ROLLBACK] Stack trace: ${errorStack}`);
      }

      return {
        success: false,
        restoredFiles,
        logs,
        error: errorMsg
      };
    }
  }

  /**
   * Calculer le checksum SHA256 d'un répertoire de rollback
   */
  private async calculateChecksum(dirPath: string): Promise<string> {
    try {
      const crypto = await import('crypto');
      const hash = crypto.createHash('sha256');
      
      const files = await fs.readdir(dirPath);
      
      for (const file of files) {
        if (file === 'metadata.json') continue;
        
        const filePath = join(dirPath, file);
        const content = await fs.readFile(filePath);
        hash.update(content);
      }
      
      return hash.digest('hex').substring(0, 16);
    } catch (error) {
      console.warn('[RollbackManager] Impossible de calculer le checksum:', error);
      return 'unknown';
    }
  }

  /**
   * Lister tous les points de rollback disponibles
   */
  public async listRollbackPoints(): Promise<Array<{
    decisionId: string;
    timestamp: string;
    machine: string;
    files: string[];
  }>> {
    try {
      const sharedPath = this.config.sharedPath;
      const rollbackDir = join(sharedPath, '.rollback');
      
      if (!existsSync(rollbackDir)) {
        return [];
      }
      
      const allBackups = await fs.readdir(rollbackDir);
      const rollbackPoints = [];
      
      for (const backupName of allBackups) {
        const backupPath = join(rollbackDir, backupName);
        const metadataPath = join(backupPath, 'metadata.json');
        
        if (!existsSync(metadataPath)) continue;
        
        const metadataContent = await fs.readFile(metadataPath, 'utf-8');
        const metadata = JSON.parse(metadataContent);
        
        rollbackPoints.push({
          decisionId: metadata.decisionId,
          timestamp: metadata.timestamp,
          machine: metadata.machine,
          files: metadata.files || []
        });
      }
      
      return rollbackPoints.sort((a, b) => {
        const dateA = new Date(a.timestamp);
        const dateB = new Date(b.timestamp);
        return dateB.getTime() - dateA.getTime();
      });
    } catch (error) {
      console.error('[RollbackManager] Erreur listRollbackPoints:', error);
      return [];
    }
  }

  /**
   * Nettoyer les vieux points de rollback
   */
  public async cleanupOldRollbacks(options: {
    olderThanDays?: number;
    keepPerDecision?: number;
    dryRun?: boolean;
  } = {}): Promise<{
    deleted: string[];
    kept: string[];
    errors: string[];
  }> {
    try {
      const sharedPath = this.config.sharedPath;
      const rollbackDir = join(sharedPath, '.rollback');
      
      if (!existsSync(rollbackDir)) {
        return {
          deleted: [],
          kept: [],
          errors: ['Rollback directory not found']
        };
      }
      
      const allBackups = await fs.readdir(rollbackDir);
      const now = Date.now();
      const cutoffTime = options.olderThanDays
        ? now - (options.olderThanDays * 24 * 60 * 60 * 1000)
        : 0;
      
      const deleted: string[] = [];
      const kept: string[] = [];
      const errors: string[] = [];
      
      // Grouper par décision
      const decisionGroups = new Map<string, string[]>();
      for (const backupName of allBackups) {
        const match = backupName.match(/^([^_]+)_/);
        if (match) {
          const decisionId = match[1];
          if (!decisionGroups.has(decisionId)) {
            decisionGroups.set(decisionId, []);
          }
          decisionGroups.get(decisionId)!.push(backupName);
        }
      }
      
      // Nettoyer chaque groupe
      for (const [decisionId, backups] of decisionGroups) {
        // Trier par date (plus récent en premier)
        backups.sort((a, b) => {
          const dateA = new Date(a.match(/_(\d{4})-(\d{2})-(\d{2})T(\d{2})/)[1]);
          const dateB = new Date(b.match(/_(\d{4})-(\d{2})-(\d{2})T(\d{2})/)[1]);
          return dateB.getTime() - dateA.getTime();
        });
        
        // Garder les N plus récents
        const toKeep = backups.slice(0, options.keepPerDecision || 1);
        
        // Supprimer les vieux
        const toDelete = backups.slice(options.keepPerDecision || 1);
        
        for (const backupName of toDelete) {
          const backupPath = join(rollbackDir, backupName);
          
          if (options.dryRun) {
            console.log(`[RollbackManager] [DRY RUN] Supprimer: ${backupName}`);
          } else {
            await fs.rm(backupPath, { recursive: true, force: true });
            console.log(`[RollbackManager] 🗑️ Supprimé: ${backupName}`);
          }
          
          deleted.push(backupName);
        }
        
        kept.push(...toKeep);
      }
      
      return {
        deleted,
        kept,
        errors
      };
    } catch (error) {
      console.error('[RollbackManager] Erreur cleanupOldRollbacks:', error);
      return {
        deleted: [],
        kept: [],
        errors: [`Error: ${error instanceof Error ? error.message : String(error)}`]
      };
    }
  }

  /**
   * Valider un point de rollback
   */
  public async validateRollbackPoint(decisionId: string): Promise<{
    isValid: boolean;
    checksum?: string;
    files: string[];
    errors: string[];
  }> {
    try {
      const sharedPath = this.config.sharedPath;
      const rollbackDir = join(sharedPath, '.rollback');
      
      if (!existsSync(rollbackDir)) {
        return {
          isValid: false,
          checksum: undefined,
          files: [],
          errors: ['Rollback directory not found']
        };
      }
      
      // Trouver le rollback le plus récent pour cette décision
      const allBackups = await fs.readdir(rollbackDir);
      const matchingBackups = allBackups
        .filter(name => name.startsWith(decisionId))
        .sort()
        .reverse();
      
      if (matchingBackups.length === 0) {
        return {
          isValid: false,
          checksum: undefined,
          files: [],
          errors: [`No rollback found for decision ${decisionId}`]
        };
      }
      
      const backupPath = join(rollbackDir, matchingBackups[0]);
      
      if (!existsSync(backupPath)) {
        return {
          isValid: false,
          checksum: undefined,
          files: [],
          errors: [`Backup directory not found: ${backupPath}`]
        };
      }
      
      // Calculer le checksum actuel
      const currentChecksum = await this.calculateChecksum(backupPath);
      
      // Lire metadata
      const metadataPath = join(backupPath, 'metadata.json');
      let metadata: any = null;
      let files: string[] = [];
      
      if (existsSync(metadataPath)) {
        try {
          const metadataContent = await fs.readFile(metadataPath, 'utf-8');
          metadata = JSON.parse(metadataContent);
          files = metadata.files || [];
        } catch (error) {
          console.warn(`[RollbackManager] Erreur lecture metadata: ${error}`);
        }
      } else {
        console.warn(`[RollbackManager] ⚠️ Metadata introuvable, utilisation des fichiers par défaut`);
      }
      
      // Vérifier l'intégrité des fichiers
      const errors: string[] = [];
      const validFiles: string[] = [];
      
      for (const file of files) {
        const filePath = join(backupPath, file);
        
        if (!existsSync(filePath)) {
          errors.push(`File not found: ${file}`);
          continue;
        }
        
        try {
          const stats = await fs.stat(filePath);
          
          if (stats.size === 0) {
            errors.push(`Empty file: ${file}`);
            continue;
          }
          
          validFiles.push(file);
        } catch (error) {
          errors.push(`Error checking file ${file}: ${error}`);
        }
      }
      
      const isValid = errors.length === 0 && validFiles.length > 0;
      
      return {
        isValid,
        checksum: currentChecksum,
        files: validFiles,
        errors
      };
    } catch (error) {
      console.error('[RollbackManager] Erreur validateRollbackPoint:', error);
      return {
        isValid: false,
        checksum: undefined,
        files: [],
        errors: [`Error: ${error instanceof Error ? error.message : String(error)}`]
      };
    }
  }
}
