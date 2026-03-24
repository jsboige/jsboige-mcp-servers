/**
 * Comparateur de configurations RooSync
 *
 * Responsable de la comparaison entre machines et baseline :
 * - Comparaison de configurations
 * - Liste des différences
 * - Comparaison réelle (inventaire vs baseline)
 */

import { promises as fs, existsSync } from 'fs';
import { join } from 'path';
import { parseConfigJson } from '../../utils/roosync-parsers.js';
import { BaselineService } from '../BaselineService.js';
import { RooSyncConfig } from '../../config/roosync-config.js';
import { RooSyncServiceError } from '../../types/errors.js';
import { RooSyncDashboard } from '../../utils/roosync-parsers.js';
import { ConfigurationProfile } from '../../types/non-nominative-baseline.js';

export class ConfigComparator {
  constructor(
    private config: RooSyncConfig,
    private baselineService: BaselineService
  ) {}

  /**
   * Compare un inventaire machine avec des profils de configuration
   */
  public compareWithProfiles(
    machineInventory: any,
    profiles: ConfigurationProfile[]
  ): Array<{
    category: string;
    expectedValue: any;
    actualValue: any;
    severity: string;
  }> {
    const deviations: Array<{
      category: string;
      expectedValue: any;
      actualValue: any;
      severity: string;
    }> = [];

    for (const profile of profiles) {
      // Extraction de la valeur actuelle selon la catégorie du profil
      const actualValue = this.extractValueForCategory(machineInventory, profile.category);
      
      if (actualValue === undefined) continue;

      // Comparaison basique (à améliorer pour objets complexes)
      if (JSON.stringify(actualValue) !== JSON.stringify(profile.configuration)) {
        deviations.push({
          category: profile.category,
          expectedValue: profile.configuration,
          actualValue: actualValue,
          severity: 'WARNING' // Par défaut
        });
      }
    }

    return deviations;
  }

  private extractValueForCategory(inventory: any, category: string): any {
    // Logique d'extraction similaire à NonNominativeBaselineService
    // Adaptation pour accéder aux propriétés de l'inventaire
    // TODO: Centraliser cette logique d'extraction
    switch (category) {
      case 'roo-core':
        return {
          modes: inventory.config?.roo?.modes,
          mcpSettings: inventory.config?.roo?.mcpSettings
        };
      case 'hardware-cpu':
        return inventory.config?.hardware?.cpu;
      // Ajouter les autres cas...
      default:
        return undefined;
    }
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
   * Comparer la configuration avec une autre machine
   */
  public async compareConfig(
    dashboardLoader: () => Promise<RooSyncDashboard>,
    targetMachineId?: string
  ): Promise<{
    localMachine: string;
    targetMachine: string;
    differences: {
      field: string;
      localValue: any;
      targetValue: any;
    }[];
  }> {
    this.checkFileExists('sync-config.json');

    // Si pas de machine cible spécifiée, comparer avec toutes
    if (!targetMachineId) {
      const dashboard = await dashboardLoader();
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
   * @param filterByType Type de différences à filtrer
   * @param forceRefresh Force le rafraîchissement du cache d'inventaire
   */
  public async listDiffs(
    filterByType?: 'all' | 'config' | 'files' | 'settings',
    forceRefresh = false
  ): Promise<{
    totalDiffs: number;
    diffs: {
      type: string;
      path: string;
      description: string;
      machines: string[];
    }[];
  }> {
    const startTime = Date.now();

    try {
      // Récupérer la configuration pour obtenir la liste de toutes les machines
      const baseline = await this.baselineService.loadBaseline();
      if (!baseline) {
        return {
          totalDiffs: 0,
          diffs: []
        };
      }

      // Identifier toutes les machines connues (baseline + machines enregistrées)
      const allMachines = new Set<string>();

      // Pour l'ancienne structure BaselineConfig, on n'a pas de tableau de machines
      // On ajoute juste la machine baseline
      allMachines.add(baseline.machineId);

      // Ajouter la machine baseline si elle n'est pas déjà incluse
      if (baseline.machineId && !allMachines.has(baseline.machineId)) {
        allMachines.add(baseline.machineId);
      }

      // Ajouter les machines de la configuration locale
      if (this.config.machineId && !allMachines.has(this.config.machineId)) {
        allMachines.add(this.config.machineId);
      }

      console.log('[DEBUG] listDiffs - allMachines trouvées:', Array.from(allMachines));

      const allDiffs: Array<{
        type: string;
        path: string;
        description: string;
        machines: string[];
      }> = [];

      // Comparer chaque machine avec la baseline
      for (const machineId of Array.from(allMachines)) {
        try {
          const comparisonReport = await this.baselineService.compareWithBaseline(
            machineId,
            forceRefresh
          );

          if (comparisonReport && comparisonReport.differences.length > 0) {
            // Filtrer les différences selon le type
            let filteredDiffs = comparisonReport.differences;

            // Filtrer par type si nécessaire
            if (filterByType && filterByType !== 'all') {
              const typeMap: Record<string, string> = {
                'config': 'config',
                'files': 'hardware',
                'settings': 'software'
              };
              const targetCategory = typeMap[filterByType];
              if (targetCategory) {
                filteredDiffs = comparisonReport.differences.filter(d => d.category === targetCategory);
              }
            }

            // Ajouter les différences de cette machine
            filteredDiffs.forEach(d => {
              // Vérifier si cette différence existe déjà (même chemin sur plusieurs machines)
              const existingDiff = allDiffs.find(existing =>
                existing.type === d.category && existing.path === d.path
              );

              if (existingDiff) {
                // Ajouter cette machine à la différence existante
                if (!existingDiff.machines.includes(machineId)) {
                  existingDiff.machines.push(machineId);
                }
              } else {
                // Créer une nouvelle différence
                allDiffs.push({
                  type: d.category,
                  path: d.path,
                  description: d.description,
                  machines: [machineId]
                });
              }
            });
          }
        } catch (error) {
          console.warn(`[ConfigComparator] Impossible de comparer la machine ${machineId} avec la baseline`, error);
          // Continuer avec les autres machines
        }
      }

      const duration = Date.now() - startTime;
      console.log(`[ConfigComparator] Liste des différences système générée en ${duration}ms`, {
        totalMachines: allMachines.size,
        totalDiffs: allDiffs.length,
        filterType: filterByType || 'all',
        forceRefresh
      });

      return {
        totalDiffs: allDiffs.length,
        diffs: allDiffs
      };
    } catch (error) {
      console.error('[ConfigComparator] Erreur lors de la liste des différences système', error);
      throw new RooSyncServiceError(
        `Erreur liste différences: ${(error as Error).message}`,
        'DIFF_LISTING_FAILED'
      );
    }
  }

  /**
   * Compare 2 machines et génère un rapport de différences réelles
   */
  public async compareRealConfigurations(
    sourceMachineId: string,
    targetMachineId: string,
    forceRefresh = false
  ): Promise<any | null> {
    console.log(`[ConfigComparator] 🔍 Comparaison réelle : ${sourceMachineId} vs ${targetMachineId}`);

    try {
      // CORRECTION SDDD: Utiliser la logique baseline-driven cohérente
      // Charger la baseline une seule fois pour éviter les incohérences
      await this.baselineService.loadBaseline();

      // Comparer chaque machine avec la baseline (comme listDiffs et loadDashboard)
      const sourceComparison = await this.baselineService.compareWithBaseline(sourceMachineId);
      const targetComparison = await this.baselineService.compareWithBaseline(targetMachineId);

      if (!sourceComparison || !targetComparison) {
        console.error('[ConfigComparator] ❌ Échec comparaison avec baseline');
        return null;
      }

      // Combiner les différences des deux machines
      const allDifferences = [
        ...sourceComparison.differences.map(d => ({
          ...d,
          machineId: sourceMachineId
        })),
        ...targetComparison.differences.map(d => ({
          ...d,
          machineId: targetMachineId
        }))
      ];

      // Créer le rapport de comparaison
      const report = {
        sourceMachine: sourceMachineId,
        targetMachine: targetMachineId,
        hostId: this.config.machineId || 'unknown',
        differences: allDifferences,
        summary: {
          total: allDifferences.length,
          critical: allDifferences.filter(d => d.severity === 'CRITICAL').length,
          important: allDifferences.filter(d => d.severity === 'IMPORTANT').length,
          warning: allDifferences.filter(d => d.severity === 'WARNING').length,
          info: allDifferences.filter(d => d.severity === 'INFO').length
        }
      };

      console.log(`[ConfigComparator] ✅ Comparaison terminée : ${allDifferences.length} différences`);
      return report;
    } catch (error) {
      // CORRECTION SDDD: Capturer l'erreur détaillée du BaselineService
      const originalError = error as Error;
      console.error('[DEBUG] Erreur originale dans compareRealConfigurations:', originalError);
      console.error('[DEBUG] Stack trace:', originalError.stack);

      throw new RooSyncServiceError(
        `Erreur lors de la comparaison réelle: ${originalError.message}`,
        'ROOSYNC_COMPARE_REAL_ERROR'
      );
    }
  }
}