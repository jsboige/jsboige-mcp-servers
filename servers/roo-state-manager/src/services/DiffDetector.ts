/**
 * DiffDetector - Service de détection des différences
 * 
 * Service responsable de comparer les configurations baseline
 * avec les configurations des machines cibles pour identifier
 * les différences et leur sévérité.
 * 
 * @module DiffDetector
 * @version 2.1.0
 */

import {
  IDiffDetector,
  BaselineConfig,
  MachineInventory,
  BaselineDifference,
  BaselineComparisonReport
} from '../types/baseline.js';
import { createLogger, Logger } from '../utils/logger.js';

/**
 * Safe property accessor with default value
 * Prevents "Cannot read properties of undefined" errors
 *
 * @example
 * safeGet(obj, ['hardware', 'cpu', 'cores'], 0) // Returns obj.hardware?.cpu?.cores ?? 0
 */
function safeGet<T>(
  obj: any,
  path: string[],
  defaultValue: T
): T {
  try {
    let current = obj;
    for (const key of path) {
      if (current == null || typeof current !== 'object') {
        return defaultValue;
      }
      current = current[key];
    }
    return current ?? defaultValue;
  } catch {
    return defaultValue;
  }
}

/**
 * Implémentation du service de détection de différences
 */
export class DiffDetector implements IDiffDetector {
  private logger: Logger;
  
  constructor() {
    this.logger = createLogger('DiffDetector');
  }

  /**
   * Compare une configuration baseline avec une machine cible
   */
  public async compareBaselineWithMachine(
    baseline: BaselineConfig,
    machine: MachineInventory
  ): Promise<BaselineDifference[]> {
    const differences: BaselineDifference[] = [];

    try {
      // Vérifier que les configurations existent
      if (!baseline || !baseline.config) {
        throw new Error('Baseline ou baseline.config est null/undefined');
      }
      
      // Ne pas utiliser de fallback pour machine.config - laisser l'erreur se produire si config est null
      if (!machine.config) {
        const error = new Error('Machine config est null - erreur de test simulée');
        this.logger.error('Erreur lors de la comparaison baseline/machine', error);
        throw error;
      }
      
      // Comparer la configuration Roo
      const rooDiffs = this.compareRooConfig(baseline.config.roo, machine.config.roo);
      differences.push(...rooDiffs);
      
      // Comparer la configuration matérielle
      const hardwareDiffs = this.compareHardwareConfig(baseline.config.hardware, machine.config.hardware);
      differences.push(...hardwareDiffs);
      
      // Comparer la configuration logicielle
      const softwareDiffs = this.compareSoftwareConfig(baseline.config.software, machine.config.software);
      differences.push(...softwareDiffs);
      
      // Comparer la configuration système
      const systemDiffs = this.compareSystemConfig(baseline.config.system, machine.config.system);
      differences.push(...systemDiffs);
      
      return differences;
    } catch (error) {
      this.logger.error('Erreur lors de la comparaison baseline/machine', error);
      throw error;
    }
  }

  /**
   * Compare les configurations Roo
   */
  private compareRooConfig(
    baselineRoo: any,
    machineRoo: any
  ): BaselineDifference[] {
    const differences: BaselineDifference[] = [];

    // Vérifier si les objets sont définis
    if (!baselineRoo || !machineRoo) {
      return differences;
    }

    // Comparer paths.rooConfig - seulement si les propriétés existent
    if (baselineRoo?.paths?.rooConfig !== machineRoo?.paths?.rooConfig) {
      differences.push({
        category: 'config',
        severity: 'CRITICAL',
        path: 'paths.rooConfig',
        description: `Chemin de configuration Roo différent entre machines`,
        baselineValue: baselineRoo?.paths?.rooConfig,
        actualValue: machineRoo?.paths?.rooConfig,
        recommendedAction: 'Synchroniser le chemin de configuration Roo'
      });
    }

    // Comparer paths.mcpSettings - seulement si les propriétés existent
    if (baselineRoo?.paths?.mcpSettings !== machineRoo?.paths?.mcpSettings) {
      differences.push({
        category: 'config',
        severity: 'CRITICAL',
        path: 'paths.mcpSettings',
        description: `Chemin des paramètres MCP différent entre machines`,
        baselineValue: baselineRoo?.paths?.mcpSettings,
        actualValue: machineRoo?.paths?.mcpSettings,
        recommendedAction: 'Synchroniser le chemin des paramètres MCP'
      });
    }

    // Comparer le nombre de modes Roo
    const baselineModeCount = baselineRoo.modes?.length || 0;
    const machineModeCount = machineRoo.modes?.length || 0;
    if (baselineModeCount !== machineModeCount) {
      differences.push({
        category: 'config',
        severity: 'IMPORTANT',
        path: 'roo.modes',
        description: `Nombre de modes Roo différent entre machines`,
        baselineValue: `${baselineModeCount} modes`,
        actualValue: `${machineModeCount} modes`,
        recommendedAction: 'Vérifier la configuration des modes Roo'
      });
    }

    // Comparer les modes
    if (JSON.stringify(baselineRoo.modes) !== JSON.stringify(machineRoo.modes)) {
      differences.push({
        category: 'config',
        severity: 'IMPORTANT',
        path: 'roo.modes',
        description: 'Différence dans les modes Roo configurés',
        baselineValue: baselineRoo.modes,
        actualValue: machineRoo.modes,
        recommendedAction: 'Synchroniser les modes avec la baseline'
      });
    }

    // Comparer les paramètres MCP - utiliser compareNestedObjects pour gérer les structures imbriquées
    const mcpDiffs = this.compareNestedObjects(
      baselineRoo.mcpSettings || {},
      machineRoo.mcpSettings || {},
      'roo.mcpSettings'
    );
    differences.push(...mcpDiffs);

    // Comparer les paramètres utilisateur
    const userDiffs = this.compareNestedObjects(
      baselineRoo.userSettings || {},
      machineRoo.userSettings || {},
      'roo.userSettings'
    );
    differences.push(...userDiffs);

    return differences;
  }

  /**
   * Compare les configurations matérielles
   */
  private compareHardwareConfig(
    baselineHardware: any,
    machineHardware: any
  ): BaselineDifference[] {
    const differences: BaselineDifference[] = [];

    // CPU : cores - comparaison spécialisée pour valeurs numériques
    const baselineCores = safeGet(baselineHardware, ['cpu', 'cores'], 0);
    const machineCores = safeGet(machineHardware, ['cpu', 'cores'], 0);
    const coreDiff = Math.abs(baselineCores - machineCores);
    const coreDiffPercent = baselineCores > 0 ? (coreDiff / Math.max(baselineCores, machineCores)) * 100 : 0;
    
    if (coreDiffPercent > 0) {
      const severity = this.determineSeverity('hardware', 'MODIFIED', 'cpu.cores', coreDiffPercent);
      differences.push({
        category: 'hardware',
        severity,
        path: 'hardware.cpu.cores',
        description: `Nombre de cœurs CPU différent : ${baselineCores} vs ${machineCores} (${coreDiffPercent.toFixed(1)}% différence)`,
        baselineValue: baselineCores,
        actualValue: machineCores,
        recommendedAction: severity === 'IMPORTANT'
          ? `Performance CPU significativement différente - tester comportement des tâches intensives`
          : 'Aucune action requise'
      });
    }

    // CPU : threads - comparaison spécialisée pour valeurs numériques
    const baselineThreads = safeGet(baselineHardware, ['cpu', 'threads'], 0);
    const machineThreads = safeGet(machineHardware, ['cpu', 'threads'], 0);
    const threadDiff = Math.abs(baselineThreads - machineThreads);
    const threadDiffPercent = baselineThreads > 0 ? (threadDiff / Math.max(baselineThreads, machineThreads)) * 100 : 0;
    
    if (threadDiffPercent > 0) {
      const severity = this.determineSeverity('hardware', 'MODIFIED', 'cpu.threads', threadDiffPercent);
      differences.push({
        category: 'hardware',
        severity,
        path: 'hardware.cpu.threads',
        description: `Nombre de threads CPU différent : ${baselineThreads} vs ${machineThreads} (${threadDiffPercent.toFixed(1)}% différence)`,
        baselineValue: baselineThreads,
        actualValue: machineThreads,
        recommendedAction: 'Aucune action requise'
      });
    }

    // CPU : model - comparaison de chaînes
    const baselineCpuModel = safeGet(baselineHardware, ['cpu', 'model'], '');
    const machineCpuModel = safeGet(machineHardware, ['cpu', 'model'], '');
    if (baselineCpuModel !== machineCpuModel) {
      differences.push({
        category: 'hardware',
        severity: 'INFO',
        path: 'hardware.cpu.model',
        description: `Modèle CPU différent : ${baselineCpuModel} vs ${machineCpuModel}`,
        baselineValue: baselineCpuModel,
        actualValue: machineCpuModel,
        recommendedAction: 'Vérifier la compatibilité des modèles CPU'
      });
    }

    // RAM : total - comparaison spécialisée pour valeurs numériques
    const baselineMemTotal = safeGet(baselineHardware, ['memory', 'total'], 0);
    const machineMemTotal = safeGet(machineHardware, ['memory', 'total'], 0);
    const ramDiff = Math.abs(baselineMemTotal - machineMemTotal);
    const ramDiffPercent = baselineMemTotal > 0 ? (ramDiff / Math.max(baselineMemTotal, machineMemTotal)) * 100 : 0;
    
    if (ramDiffPercent > 0) {
      const severity = this.determineSeverity('hardware', 'MODIFIED', 'memory.total', ramDiffPercent);
      const baselineGB = (baselineMemTotal / (1024 ** 3)).toFixed(1);
      const machineGB = (machineMemTotal / (1024 ** 3)).toFixed(1);
      
      differences.push({
        category: 'hardware',
        severity,
        path: 'hardware.memory.total',
        description: `RAM totale différente : ${baselineGB} GB vs ${machineGB} GB (${ramDiffPercent.toFixed(1)}% différence)`,
        baselineValue: baselineMemTotal,
        actualValue: machineMemTotal,
        recommendedAction: severity === 'IMPORTANT'
          ? `RAM insuffisante - risque de performance dégradée`
          : 'Aucune action requise'
      });
    }

    // Disques : nombre
    const baselineDisks = safeGet(baselineHardware, ['disks'], []);
    const machineDisks = safeGet(machineHardware, ['disks'], []);
    if (baselineDisks.length !== machineDisks.length) {
      differences.push({
        category: 'hardware',
        severity: 'WARNING',
        path: 'hardware.disks.length',
        description: `Nombre de disques différent : ${baselineDisks.length} vs ${machineDisks.length}`,
        baselineValue: baselineDisks.length,
        actualValue: machineDisks.length,
        recommendedAction: 'Vérifier la configuration des disques'
      });
    }

    // GPU : présence
    const baselineGpu = safeGet(baselineHardware, ['gpu'], '');
    const machineGpu = safeGet(machineHardware, ['gpu'], '');
    if (baselineGpu !== machineGpu) {
      differences.push({
        category: 'hardware',
        severity: 'INFO',
        path: 'hardware.gpu',
        description: baselineGpu
          ? `GPU différent : ${baselineGpu} vs ${machineGpu}`
          : `GPU présent sur machine mais absent sur baseline`,
        baselineValue: baselineGpu || null,
        actualValue: machineGpu || null,
        recommendedAction: 'Vérifier la configuration GPU'
      });
    }

    return differences;
  }

  /**
   * Compare les configurations logicielles
   */
  private compareSoftwareConfig(
    baselineSoftware: any,
    machineSoftware: any
  ): BaselineDifference[] {
    const differences: BaselineDifference[] = [];

    // PowerShell
    const baselinePwsh = safeGet(baselineSoftware, ['powershell'], 'Unknown');
    const machinePwsh = safeGet(machineSoftware, ['powershell'], 'Unknown');
    if (baselinePwsh !== machinePwsh) {
      differences.push({
        category: 'software',
        severity: 'WARNING',
        path: 'software.powershell',
        description: `Version PowerShell différente : ${baselinePwsh} vs ${machinePwsh}`,
        baselineValue: baselinePwsh,
        actualValue: machinePwsh,
        recommendedAction: `Mettre à jour PowerShell vers version ${baselinePwsh}`
      });
    }

    // Node.js
    const baselineNode = safeGet(baselineSoftware, ['node'], null);
    const machineNode = safeGet(machineSoftware, ['node'], null);
    if (baselineNode !== machineNode) {
      // Gérer le cas où Node est absent sur une machine
      if (!baselineNode || !machineNode) {
        differences.push({
          category: 'software',
          severity: 'INFO',
          path: 'software.node',
          description: !machineNode
            ? `Node.js absent sur machine cible`
            : `Node.js absent sur baseline`,
          baselineValue: baselineNode,
          actualValue: machineNode,
          recommendedAction: 'Installer Node.js si nécessaire'
        });
      } else {
        differences.push({
          category: 'software',
          severity: 'INFO',
          path: 'software.node',
          description: `Version Node.js différente : ${baselineNode} vs ${machineNode}`,
          baselineValue: baselineNode,
          actualValue: machineNode,
          recommendedAction: 'Mettre à jour Node.js vers la version de la baseline'
        });
      }
    }

    // Python
    const baselinePython = safeGet(baselineSoftware, ['python'], null);
    const machinePython = safeGet(machineSoftware, ['python'], null);
    if (baselinePython !== machinePython) {
      if (!baselinePython || !machinePython) {
        differences.push({
          category: 'software',
          severity: 'INFO',
          path: 'software.python',
          description: !machinePython
            ? `Python absent sur machine cible`
            : `Python absent sur baseline`,
          baselineValue: baselinePython,
          actualValue: machinePython,
          recommendedAction: 'Installer Python si nécessaire'
        });
      } else {
        differences.push({
          category: 'software',
          severity: 'INFO',
          path: 'software.python',
          description: `Version Python différente : ${baselinePython} vs ${machinePython}`,
          baselineValue: baselinePython,
          actualValue: machinePython,
          recommendedAction: 'Mettre à jour Python vers la version de la baseline'
        });
      }
    }

    return differences;
  }

  /**
   * Compare les configurations système
   */
  private compareSystemConfig(
    baselineSystem: any,
    machineSystem: any
  ): BaselineDifference[] {
    const differences: BaselineDifference[] = [];

    // OS
    const baselineOs = safeGet(baselineSystem, ['os'], 'unknown');
    const machineOs = safeGet(machineSystem, ['os'], 'unknown');
    if (baselineOs !== machineOs) {
      differences.push({
        category: 'system',
        severity: 'CRITICAL',
        path: 'system.os',
        description: `Système d'exploitation différent : ${baselineOs} vs ${machineOs}`,
        baselineValue: baselineOs,
        actualValue: machineOs,
        recommendedAction: 'Revue manuelle requise - différence système critique'
      });
    }

    // Architecture
    const baselineArch = safeGet(baselineSystem, ['architecture'], 'unknown');
    const machineArch = safeGet(machineSystem, ['architecture'], 'unknown');
    if (baselineArch !== machineArch) {
      differences.push({
        category: 'system',
        severity: 'CRITICAL',
        path: 'system.architecture',
        description: `Architecture système différente : ${baselineArch} vs ${machineArch}`,
        baselineValue: baselineArch,
        actualValue: machineArch,
        recommendedAction: 'Attention : architectures incompatibles peuvent nécessiter des builds différents'
      });
    }

    // Hostname
    const baselineHostname = safeGet(baselineSystem, ['hostname'], 'unknown');
    const machineHostname = safeGet(machineSystem, ['hostname'], 'unknown');
    if (baselineHostname !== machineHostname) {
      differences.push({
        category: 'system',
        severity: 'INFO',
        path: 'system.hostname',
        description: `Hostname différent : ${baselineHostname} vs ${machineHostname}`,
        baselineValue: baselineHostname,
        actualValue: machineHostname,
        recommendedAction: 'Aucune action requise'
      });
    }

    return differences;
  }

  /**
   * Compare deux objets et retourne les différences
   */
  private compareObjects(
    baseline: Record<string, any>,
    actual: Record<string, any>,
    basePath: string
  ): BaselineDifference[] {
    const differences: BaselineDifference[] = [];

    // Clés présentes dans la baseline mais pas dans l'actuel
    for (const key in baseline) {
      if (!(key in actual)) {
        differences.push({
          category: 'config',
          severity: 'WARNING',
          path: `${basePath}.${key}`,
          description: `Propriété manquante: ${key}`,
          baselineValue: baseline[key],
          actualValue: undefined,
          recommendedAction: 'Ajouter la propriété manquante'
        });
      } else if (JSON.stringify(baseline[key]) !== JSON.stringify(actual[key])) {
        differences.push({
          category: 'config',
          severity: 'IMPORTANT',
          path: `${basePath}.${key}`,
          description: `Valeur différente pour: ${key}`,
          baselineValue: baseline[key],
          actualValue: actual[key],
          recommendedAction: 'Synchroniser avec la valeur de la baseline'
        });
      }
    }

    // Clés présentes dans l'actuel mais pas dans la baseline
    for (const key in actual) {
      if (!(key in baseline)) {
        differences.push({
          category: 'config',
          severity: 'INFO',
          path: `${basePath}.${key}`,
          description: `Propriété supplémentaire: ${key}`,
          baselineValue: undefined,
          actualValue: actual[key],
          recommendedAction: 'Revoir la nécessité de cette propriété'
        });
      }
    }

    return differences;
  }

  /**
   * Compare deux objets de manière récursive pour gérer les structures imbriquées
   */
  private compareNestedObjects(
    baseline: Record<string, any>,
    actual: Record<string, any>,
    basePath: string
  ): BaselineDifference[] {
    const differences: BaselineDifference[] = [];

    // Fonction récursive pour comparer les objets imbriqués
    const compareRecursive = (baseObj: any, actualObj: any, currentPath: string): void => {
      if (typeof baseObj !== 'object' || baseObj === null ||
          typeof actualObj !== 'object' || actualObj === null) {
        // Comparaison simple pour les types non-objets
        if (baseObj !== actualObj) {
          differences.push({
            category: 'config',
            severity: 'IMPORTANT',
            path: currentPath,
            description: `Valeur différente pour: ${currentPath}`,
            baselineValue: baseObj,
            actualValue: actualObj,
            recommendedAction: 'Synchroniser avec la valeur de la baseline'
          });
        }
        return;
      }

      // Clés présentes dans la baseline mais pas dans l'actuel
      for (const key in baseObj) {
        const newPath = `${currentPath}.${key}`;
        if (!(key in actualObj)) {
          differences.push({
            category: 'config',
            severity: 'WARNING',
            path: newPath,
            description: `Propriété manquante: ${key}`,
            baselineValue: baseObj[key],
            actualValue: undefined,
            recommendedAction: 'Ajouter la propriété manquante'
          });
        } else {
          compareRecursive(baseObj[key], actualObj[key], newPath);
        }
      }

      // Clés présentes dans l'actuel mais pas dans la baseline
      for (const key in actualObj) {
        if (!(key in baseObj)) {
          const newPath = `${currentPath}.${key}`;
          differences.push({
            category: 'config',
            severity: 'INFO',
            path: newPath,
            description: `Propriété supplémentaire: ${key}`,
            baselineValue: undefined,
            actualValue: actualObj[key],
            recommendedAction: 'Revoir la nécessité de cette propriété'
          });
        }
      }
    };

    // Comparer les objets de manière récursive
    const allKeys = new Set([...Object.keys(baseline), ...Object.keys(actual)]);
    
    for (const key of allKeys) {
      const newPath = `${basePath}.${key}`;
      const baseValue = baseline[key];
      const actualValue = actual[key];
      
      // Si les deux sont des objets, comparer récursivement
      if (typeof baseValue === 'object' && baseValue !== null &&
          typeof actualValue === 'object' && actualValue !== null) {
        compareRecursive(baseValue, actualValue, newPath);
      } else {
        // Comparaison simple pour les valeurs non-objets
        if (baseValue !== actualValue) {
          differences.push({
            category: 'config',
            severity: 'IMPORTANT',
            path: newPath,
            description: `Valeur différente pour ${key}`,
            baselineValue: baseValue,
            actualValue: actualValue,
            recommendedAction: 'Synchroniser avec la valeur de la baseline'
          });
        }
      }
    }

    return differences;
  }

  /**
   * Détermine la sévérité d'une différence en fonction du contexte
   */
  private determineSeverity(
    category: string,
    type: string,
    path: string,
    diffPercent: number
  ): 'CRITICAL' | 'IMPORTANT' | 'WARNING' | 'INFO' {
    // Règles de sévérité basées sur la catégorie et le pourcentage de différence
    if (category === 'system') {
      return 'CRITICAL';
    }
    
    if (category === 'config') {
      return 'CRITICAL';
    }
    
    if (category === 'hardware' && path.includes('memory')) {
      return diffPercent > 20 ? 'IMPORTANT' : 'WARNING';
    }
    
    if (category === 'hardware' && path.includes('cpu')) {
      return diffPercent > 30 ? 'IMPORTANT' : 'WARNING';
    }
    
    if (category === 'software') {
      return 'WARNING';
    }
    
    return 'INFO';
  }

  /**
   * Génère une recommandation pour une différence
   */
  private generateRecommendation(diff: BaselineDifference): string {
    switch (diff.category) {
      case 'config':
        return 'Synchroniser la configuration Roo avec la baseline';
      case 'system':
        return 'Revue manuelle requise - différence système critique';
      case 'hardware':
        return 'Vérifier la compatibilité matérielle';
      case 'software':
        return 'Mettre à jour les logiciels vers les versions de la baseline';
      default:
        return 'Synchroniser avec la baseline';
    }
  }

  /**
   * Compare deux inventaires machines (interface RooSync)
   * @param source - Inventaire machine source
   * @param target - Inventaire machine cible
   * @returns Rapport de comparaison avec différences détectées
   */
  public async compareInventories(
    source: MachineInventory,
    target: MachineInventory
  ): Promise<ComparisonReport> {
    const reportId = `comp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const startTime = Date.now();

    // Collecter toutes les différences via les méthodes existantes
    const allDifferences: DetectedDifference[] = [];

    // Comparer via baseline (réutilise la logique existante)
    const baselineConfig: BaselineConfig = {
      machineId: source.machineId || 'source',
      version: '1.0',
      lastUpdated: new Date().toISOString(),
      config: source.config
    };

    const baselineDiffs = await this.compareBaselineWithMachine(baselineConfig, target);

    // Convertir BaselineDifference vers DetectedDifference
    for (const diff of baselineDiffs) {
      allDifferences.push({
        id: `${reportId}-${allDifferences.length}`,
        category: this.mapCategoryToRooSync(diff.category),
        severity: diff.severity as DiffSeverity,
        path: diff.path,
        type: 'modified', // Type simplifié
        description: diff.description,
        source: {
          machineId: source.machineId || 'source',
          value: diff.baselineValue
        },
        target: {
          machineId: target.machineId || 'target',
          value: diff.actualValue
        },
        recommendedAction: diff.recommendedAction
      });
    }

    // Calculer le résumé
    const summary = this.calculateComparisonSummary(allDifferences);
    const executionTime = Date.now() - startTime;

    return {
      reportId,
      sourceMachine: source.machineId || 'source',
      targetMachine: target.machineId || 'target',
      differences: allDifferences,
      summary,
      metadata: {
        comparisonTimestamp: new Date().toISOString(),
        executionTime,
        version: '1.0'
      }
    };
  }

  /**
   * Mappe les catégories baseline vers RooSync
   */
  private mapCategoryToRooSync(category: string): DiffCategory {
    const mapping: Record<string, DiffCategory> = {
      'config': 'roo_config',
      'hardware': 'hardware',
      'software': 'software',
      'system': 'system'
    };
    return mapping[category] || 'roo_config';
  }

  /**
   * Calcule le résumé de comparaison
   */
  private calculateComparisonSummary(differences: DetectedDifference[]): ComparisonSummary {
    const summary: ComparisonSummary = {
      total: differences.length,
      bySeverity: {
        CRITICAL: 0,
        IMPORTANT: 0,
        WARNING: 0,
        INFO: 0
      },
      byCategory: {
        roo_config: 0,
        hardware: 0,
        software: 0,
        system: 0
      }
    };

    for (const diff of differences) {
      summary.bySeverity[diff.severity]++;
      summary.byCategory[diff.category]++;
    }

    return summary;
  }
}

/**
 * Types pour l'interface RooSync
 */
export type DiffSeverity = 'CRITICAL' | 'IMPORTANT' | 'WARNING' | 'INFO';
export type DiffCategory = 'roo_config' | 'hardware' | 'software' | 'system';

export interface DetectedDifference {
  id: string;
  category: DiffCategory;
  severity: DiffSeverity;
  path: string;
  type: 'added' | 'removed' | 'modified';
  description: string;
  source: {
    machineId: string;
    value: any;
  };
  target: {
    machineId: string;
    value: any;
  };
  recommendedAction?: string;
  affectedComponents?: string[];
}

export interface ComparisonSummary {
  total: number;
  bySeverity: {
    CRITICAL: number;
    IMPORTANT: number;
    WARNING: number;
    INFO: number;
  };
  byCategory: {
    roo_config: number;
    hardware: number;
    software: number;
    system: number;
  };
}

export interface ComparisonReport {
  reportId: string;
  sourceMachine: string;
  targetMachine: string;
  differences: DetectedDifference[];
  summary: ComparisonSummary;
  metadata: {
    comparisonTimestamp: string;
    executionTime: number;
    version: string;
  };
}
