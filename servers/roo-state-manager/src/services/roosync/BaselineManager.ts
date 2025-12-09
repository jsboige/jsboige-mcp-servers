/**
 * Gestionnaire de Baseline RooSync
 *
 * Responsable de la gestion des baselines et du dashboard :
 * - Chargement/Calcul du dashboard
 * - Gestion des rollbacks
 * - État de synchronisation
 */

import { promises as fs, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { RooSyncConfig } from '../../config/roosync-config.js';
import { RooSyncServiceError } from '../RooSyncService.js';
import { RooSyncDashboard } from '../../utils/roosync-parsers.js';
import { BaselineService } from '../BaselineService.js';
import { ConfigComparator } from './ConfigComparator.js';

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

export class BaselineManager {
  constructor(
    private config: RooSyncConfig,
    private baselineService: BaselineService,
    private configComparator: ConfigComparator
  ) {}

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
            console.log('[BaselineManager] Dashboard existant sans propriété machines, ajout de la machine courante');
            dashboard.machines = {};
          }

          // S'assurer que la machine courante existe dans le dashboard
          if (!dashboard.machines[this.config.machineId]) {
            console.log(`[BaselineManager] Ajout de la machine ${this.config.machineId} au dashboard existant`);
            dashboard.machines[this.config.machineId] = {
              lastSync: new Date().toISOString(),
              status: 'online',
              diffsCount: 0,
              pendingDecisions: 0
            };
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
   * Calcule le dashboard à partir de la baseline
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
          console.log(`[BaselineManager] Ajout de la machine ${this.config.machineId} au dashboard existant`);
          existingDashboard.machines[this.config.machineId] = {
            lastSync: now,
            status: 'online',
            diffsCount: totalDiffs,
            pendingDecisions: 0
          };
        }

        return existingDashboard as RooSyncDashboard;
      } catch (error) {
        console.warn('[BaselineManager] Erreur lecture dashboard existant, fallback sur calcul:', error);
      }
    }

    // Créer le résultat basé sur les données réelles
    const machinesArray = Array.from(allMachines).map(machineId => ({
      id: machineId,
      status: 'online' as const,
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
   * Restaure depuis un point de rollback
   */
  public async restoreFromRollbackPoint(
    decisionId: string,
    clearCacheCallback: () => void
  ): Promise<RollbackRestoreResult> {
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
      clearCacheCallback();

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