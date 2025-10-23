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

    // Comparer paths.rooConfig
    if (baselineRoo.paths?.rooConfig !== machineRoo.paths?.rooConfig) {
      differences.push({
        category: 'config',
        severity: 'CRITICAL',
        path: 'paths.rooConfig',
        description: `Chemin de configuration Roo différent entre machines`,
        baselineValue: baselineRoo.paths?.rooConfig,
        actualValue: machineRoo.paths?.rooConfig,
        recommendedAction: 'Synchroniser le chemin de configuration Roo'
      });
    }

    // Comparer paths.mcpSettings
    if (baselineRoo.paths?.mcpSettings !== machineRoo.paths?.mcpSettings) {
      differences.push({
        category: 'config',
        severity: 'CRITICAL',
        path: 'paths.mcpSettings',
        description: `Chemin des paramètres MCP différent entre machines`,
        baselineValue: baselineRoo.paths?.mcpSettings,
        actualValue: machineRoo.paths?.mcpSettings,
        recommendedAction: 'Synchroniser le chemin des paramètres MCP'
      });
    }

    // Comparer le nombre de serveurs MCP
    const baselineMcpCount = baselineRoo.mcpServers?.length || 0;
    const machineMcpCount = machineRoo.mcpServers?.length || 0;
    if (baselineMcpCount !== machineMcpCount) {
      differences.push({
        category: 'config',
        severity: 'IMPORTANT',
        path: 'roo.mcpServers',
        description: `Nombre de serveurs MCP différent entre machines`,
        baselineValue: `${baselineMcpCount} serveurs`,
        actualValue: `${machineMcpCount} serveurs`,
        recommendedAction: 'Vérifier la configuration des serveurs MCP'
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

    // Comparer les paramètres MCP
    const mcpDiffs = this.compareObjects(
      baselineRoo.mcpSettings || {},
      machineRoo.mcpSettings || {},
      'roo.mcpSettings'
    );
    differences.push(...mcpDiffs);

    // Comparer les paramètres utilisateur
    const userDiffs = this.compareObjects(
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

    // CPU : cores
    const baselineCores = safeGet(baselineHardware, ['cpu', 'cores'], 0);
    const machineCores = safeGet(machineHardware, ['cpu', 'cores'], 0);
    const coreDiff = Math.abs(baselineCores - machineCores);
    const coreDiffPercent = (coreDiff / Math.max(baselineCores, machineCores)) * 100;
    
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

    // CPU : threads
    const baselineThreads = safeGet(baselineHardware, ['cpu', 'threads'], 0);
    const machineThreads = safeGet(machineHardware, ['cpu', 'threads'], 0);
    const threadDiff = Math.abs(baselineThreads - machineThreads);
    const threadDiffPercent = (threadDiff / Math.max(baselineThreads, machineThreads)) * 100;
    
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

    // RAM : total
    const baselineMemTotal = safeGet(baselineHardware, ['memory', 'total'], 0);
    const machineMemTotal = safeGet(machineHardware, ['memory', 'total'], 0);
    const ramDiff = Math.abs(baselineMemTotal - machineMemTotal);
    const ramDiffPercent = (ramDiff / Math.max(baselineMemTotal, machineMemTotal)) * 100;
    
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
    const baselineGpu = safeGet(baselineHardware, ['gpu'], []);
    const machineGpu = safeGet(machineHardware, ['gpu'], []);
    const baselineHasGpu = baselineGpu && baselineGpu.length > 0;
    const machineHasGpu = machineGpu && machineGpu.length > 0;
    
    if (baselineHasGpu !== machineHasGpu) {
      differences.push({
        category: 'hardware',
        severity: 'INFO',
        path: 'hardware.gpu',
        description: baselineHasGpu
          ? `GPU présent sur baseline mais absent sur machine`
          : `GPU présent sur machine mais absent sur baseline`,
        baselineValue: baselineHasGpu ? baselineGpu : null,
        actualValue: machineHasGpu ? machineGpu : null,
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
}