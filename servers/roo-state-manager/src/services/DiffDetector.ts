/**
 * DiffDetector - Détection intelligente de différences entre inventaires machines
 * 
 * Compare 2 inventaires machines et génère un rapport structuré de différences
 * avec scoring de sévérité et recommandations d'actions.
 * 
 * @module DiffDetector
 * @version 1.0.0
 */

import { randomUUID } from 'crypto';
import type { MachineInventory } from './InventoryCollector.js';

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
 * Catégories de différences
 */
export type DiffCategory = 'roo_config' | 'hardware' | 'software' | 'system' | 'files';

/**
 * Niveaux de sévérité
 */
export type DiffSeverity = 'CRITICAL' | 'IMPORTANT' | 'WARNING' | 'INFO';

/**
 * Types de différences
 */
export type DiffType = 'MISSING' | 'ADDED' | 'MODIFIED' | 'VERSION_MISMATCH';

/**
 * Interface pour une différence détectée
 */
export interface DetectedDifference {
  id: string; // UUID unique
  category: DiffCategory;
  severity: DiffSeverity;
  path: string; // Chemin de la différence (ex: "hardware.cpu.cores")
  source: {
    value: any;
    machineId: string;
  };
  target: {
    value: any;
    machineId: string;
  };
  type: DiffType;
  description: string;
  recommendedAction?: string;
  affectedComponents?: string[];
}

/**
 * Interface pour le rapport de comparaison
 */
export interface ComparisonReport {
  reportId: string;
  timestamp: string;
  sourceMachine: string;
  targetMachine: string;
  summary: {
    total: number;
    critical: number;
    important: number;
    warning: number;
    info: number;
  };
  differences: DetectedDifference[];
  metadata: {
    comparisonDuration: number; // ms
    sourceInventoryAge: number; // ms
    targetInventoryAge: number; // ms
  };
}

/**
 * Classe DiffDetector pour comparer intelligemment 2 inventaires machines
 */
export class DiffDetector {
  /**
   * Compare 2 inventaires et génère un rapport de différences
   * @param sourceInventory - Inventaire machine source
   * @param targetInventory - Inventaire machine cible
   * @returns Rapport de comparaison structuré
   */
  async compareInventories(
    sourceInventory: MachineInventory,
    targetInventory: MachineInventory
  ): Promise<ComparisonReport> {
    const startTime = Date.now();
    console.log(`[DiffDetector] Comparaison ${sourceInventory.machineId} vs ${targetInventory.machineId}`);

    const differences: DetectedDifference[] = [];

    // Niveau 1 : Configuration Roo (CRITICAL)
    differences.push(...this.compareRooConfig(sourceInventory, targetInventory));

    // Niveau 2 : Hardware (IMPORTANT)
    differences.push(...this.compareHardware(sourceInventory, targetInventory));

    // Niveau 3 : Software (WARNING)
    differences.push(...this.compareSoftware(sourceInventory, targetInventory));

    // Niveau 4 : System (INFO)
    differences.push(...this.compareSystem(sourceInventory, targetInventory));

    // Calcul des statistiques
    const summary = {
      total: differences.length,
      critical: differences.filter(d => d.severity === 'CRITICAL').length,
      important: differences.filter(d => d.severity === 'IMPORTANT').length,
      warning: differences.filter(d => d.severity === 'WARNING').length,
      info: differences.filter(d => d.severity === 'INFO').length
    };

    const comparisonDuration = Date.now() - startTime;

    // Calculer l'âge des inventaires
    const sourceAge = Date.now() - new Date(sourceInventory.timestamp).getTime();
    const targetAge = Date.now() - new Date(targetInventory.timestamp).getTime();

    console.log(`[DiffDetector] Comparaison terminée en ${comparisonDuration}ms : ${differences.length} différences détectées`);
    console.log(`[DiffDetector] Résumé : ${summary.critical} CRITICAL, ${summary.important} IMPORTANT, ${summary.warning} WARNING, ${summary.info} INFO`);

    return {
      reportId: randomUUID(),
      timestamp: new Date().toISOString(),
      sourceMachine: sourceInventory.machineId,
      targetMachine: targetInventory.machineId,
      summary,
      differences: differences.sort((a, b) => {
        // Tri par sévérité (CRITICAL > IMPORTANT > WARNING > INFO)
        const severityOrder = { CRITICAL: 0, IMPORTANT: 1, WARNING: 2, INFO: 3 };
        return severityOrder[a.severity] - severityOrder[b.severity];
      }),
      metadata: {
        comparisonDuration,
        sourceInventoryAge: sourceAge,
        targetInventoryAge: targetAge
      }
    };
  }

  /**
   * Compare configurations Roo (MCPs, Modes, Settings)
   * @returns Liste de différences détectées
   */
  private compareRooConfig(
    source: MachineInventory,
    target: MachineInventory
  ): DetectedDifference[] {
    const diffs: DetectedDifference[] = [];

    // Comparer paths.rooConfig
    if (source.paths?.rooConfig !== target.paths?.rooConfig) {
      diffs.push({
        id: randomUUID(),
        category: 'roo_config',
        severity: 'CRITICAL',
        path: 'paths.rooConfig',
        source: { value: source.paths?.rooConfig, machineId: source.machineId },
        target: { value: target.paths?.rooConfig, machineId: target.machineId },
        type: 'MODIFIED',
        description: `Chemin de configuration Roo différent entre machines`,
        recommendedAction: this.generateRecommendation({
          id: '',
          category: 'roo_config',
          severity: 'CRITICAL',
          path: 'paths.rooConfig',
          source: { value: source.paths?.rooConfig, machineId: source.machineId },
          target: { value: target.paths?.rooConfig, machineId: target.machineId },
          type: 'MODIFIED',
          description: ''
        }),
        affectedComponents: ['Roo Config']
      });
    }

    // Comparer paths.mcpSettings
    if (source.paths?.mcpSettings !== target.paths?.mcpSettings) {
      diffs.push({
        id: randomUUID(),
        category: 'roo_config',
        severity: 'CRITICAL',
        path: 'paths.mcpSettings',
        source: { value: source.paths?.mcpSettings, machineId: source.machineId },
        target: { value: target.paths?.mcpSettings, machineId: target.machineId },
        type: 'MODIFIED',
        description: `Chemin des paramètres MCP différent entre machines`,
        recommendedAction: this.generateRecommendation({
          id: '',
          category: 'roo_config',
          severity: 'CRITICAL',
          path: 'paths.mcpSettings',
          source: { value: source.paths?.mcpSettings, machineId: source.machineId },
          target: { value: target.paths?.mcpSettings, machineId: target.machineId },
          type: 'MODIFIED',
          description: ''
        }),
        affectedComponents: ['MCP Servers']
      });
    }

    // Comparer le nombre de serveurs MCP
    const sourceMcpCount = source.roo?.mcpServers?.length || 0;
    const targetMcpCount = target.roo?.mcpServers?.length || 0;
    if (sourceMcpCount !== targetMcpCount) {
      diffs.push({
        id: randomUUID(),
        category: 'roo_config',
        severity: 'IMPORTANT',
        path: 'roo.mcpServers',
        source: { value: `${sourceMcpCount} serveurs`, machineId: source.machineId },
        target: { value: `${targetMcpCount} serveurs`, machineId: target.machineId },
        type: 'MODIFIED',
        description: `Nombre de serveurs MCP différent entre machines`,
        recommendedAction: this.generateRecommendation({
          id: '',
          category: 'roo_config',
          severity: 'IMPORTANT',
          path: 'roo.mcpServers',
          source: { value: sourceMcpCount, machineId: source.machineId },
          target: { value: targetMcpCount, machineId: target.machineId },
          type: 'MODIFIED',
          description: ''
        }),
        affectedComponents: ['MCP Servers']
      });
    }

    // Comparer le nombre de modes Roo
    const sourceModeCount = source.roo?.modes?.length || 0;
    const targetModeCount = target.roo?.modes?.length || 0;
    if (sourceModeCount !== targetModeCount) {
      diffs.push({
        id: randomUUID(),
        category: 'roo_config',
        severity: 'IMPORTANT',
        path: 'roo.modes',
        source: { value: `${sourceModeCount} modes`, machineId: source.machineId },
        target: { value: `${targetModeCount} modes`, machineId: target.machineId },
        type: 'MODIFIED',
        description: `Nombre de modes Roo différent entre machines`,
        recommendedAction: this.generateRecommendation({
          id: '',
          category: 'roo_config',
          severity: 'IMPORTANT',
          path: 'roo.modes',
          source: { value: sourceModeCount, machineId: source.machineId },
          target: { value: targetModeCount, machineId: target.machineId },
          type: 'MODIFIED',
          description: ''
        }),
        affectedComponents: ['Roo Modes']
      });
    }

    // TODO Phase 3 : Parser contenu réel des fichiers MCP et Modes

    return diffs;
  }

  /**
   * Compare hardware (CPU, RAM, GPU, Disques)
   * @returns Liste de différences détectées
   */
  private compareHardware(
    source: MachineInventory,
    target: MachineInventory
  ): DetectedDifference[] {
    const diffs: DetectedDifference[] = [];

    // CPU : cores
    const sourceCores = safeGet(source, ['hardware', 'cpu', 'cores'], 0);
    const targetCores = safeGet(target, ['hardware', 'cpu', 'cores'], 0);
    const coreDiff = Math.abs(sourceCores - targetCores);
    const coreDiffPercent = (coreDiff / Math.max(sourceCores, targetCores)) * 100;
    
    if (coreDiffPercent > 0) {
      const severity = this.determineSeverity('hardware', 'MODIFIED', 'cpu.cores', coreDiffPercent);
      diffs.push({
        id: randomUUID(),
        category: 'hardware',
        severity,
        path: 'hardware.cpu.cores',
        source: { value: sourceCores, machineId: source.machineId },
        target: { value: targetCores, machineId: target.machineId },
        type: 'MODIFIED',
        description: `Nombre de cœurs CPU différent : ${sourceCores} vs ${targetCores} (${coreDiffPercent.toFixed(1)}% différence)`,
        recommendedAction: severity === 'IMPORTANT'
          ? `Performance CPU significativement différente - tester comportement des tâches intensives`
          : undefined,
        affectedComponents: ['CPU', 'Performance']
      });
    }

    // CPU : threads
    const sourceThreads = safeGet(source, ['hardware', 'cpu', 'threads'], 0);
    const targetThreads = safeGet(target, ['hardware', 'cpu', 'threads'], 0);
    const threadDiff = Math.abs(sourceThreads - targetThreads);
    const threadDiffPercent = (threadDiff / Math.max(sourceThreads, targetThreads)) * 100;
    
    if (threadDiffPercent > 0) {
      const severity = this.determineSeverity('hardware', 'MODIFIED', 'cpu.threads', threadDiffPercent);
      diffs.push({
        id: randomUUID(),
        category: 'hardware',
        severity,
        path: 'hardware.cpu.threads',
        source: { value: sourceThreads, machineId: source.machineId },
        target: { value: targetThreads, machineId: target.machineId },
        type: 'MODIFIED',
        description: `Nombre de threads CPU différent : ${sourceThreads} vs ${targetThreads} (${threadDiffPercent.toFixed(1)}% différence)`,
        affectedComponents: ['CPU', 'Performance']
      });
    }

    // RAM : total
    const sourceMemTotal = safeGet(source, ['hardware', 'memory', 'total'], 0);
    const targetMemTotal = safeGet(target, ['hardware', 'memory', 'total'], 0);
    const ramDiff = Math.abs(sourceMemTotal - targetMemTotal);
    const ramDiffPercent = (ramDiff / Math.max(sourceMemTotal, targetMemTotal)) * 100;
    
    if (ramDiffPercent > 0) {
      const severity = this.determineSeverity('hardware', 'MODIFIED', 'memory.total', ramDiffPercent);
      const sourceGB = (sourceMemTotal / (1024 ** 3)).toFixed(1);
      const targetGB = (targetMemTotal / (1024 ** 3)).toFixed(1);
      
      diffs.push({
        id: randomUUID(),
        category: 'hardware',
        severity,
        path: 'hardware.memory.total',
        source: { value: sourceMemTotal, machineId: source.machineId },
        target: { value: targetMemTotal, machineId: target.machineId },
        type: 'MODIFIED',
        description: `RAM totale différente : ${sourceGB} GB vs ${targetGB} GB (${ramDiffPercent.toFixed(1)}% différence)`,
        recommendedAction: severity === 'IMPORTANT'
          ? `RAM insuffisante sur ${target.machineId} - risque de performance dégradée`
          : undefined,
        affectedComponents: ['RAM', 'Performance']
      });
    }

    // Disques : nombre
    const sourceDisks = safeGet(source, ['hardware', 'disks'], []);
    const targetDisks = safeGet(target, ['hardware', 'disks'], []);
    if (sourceDisks.length !== targetDisks.length) {
      diffs.push({
        id: randomUUID(),
        category: 'hardware',
        severity: 'WARNING',
        path: 'hardware.disks.length',
        source: { value: sourceDisks.length, machineId: source.machineId },
        target: { value: targetDisks.length, machineId: target.machineId },
        type: 'MODIFIED',
        description: `Nombre de disques différent : ${sourceDisks.length} vs ${targetDisks.length}`,
        affectedComponents: ['Storage']
      });
    }

    // GPU : présence
    const sourceGpu = safeGet(source, ['hardware', 'gpu'], []);
    const targetGpu = safeGet(target, ['hardware', 'gpu'], []);
    const sourceHasGpu = sourceGpu && sourceGpu.length > 0;
    const targetHasGpu = targetGpu && targetGpu.length > 0;
    
    if (sourceHasGpu !== targetHasGpu) {
      diffs.push({
        id: randomUUID(),
        category: 'hardware',
        severity: 'INFO',
        path: 'hardware.gpu',
        source: { value: sourceHasGpu ? sourceGpu : null, machineId: source.machineId },
        target: { value: targetHasGpu ? targetGpu : null, machineId: target.machineId },
        type: sourceHasGpu ? 'MISSING' : 'ADDED',
        description: sourceHasGpu
          ? `GPU présent sur ${source.machineId} mais absent sur ${target.machineId}`
          : `GPU présent sur ${target.machineId} mais absent sur ${source.machineId}`,
        affectedComponents: ['GPU', 'Graphics']
      });
    }

    return diffs;
  }

  /**
   * Compare versions logicielles (Node, Python, PowerShell)
   * @returns Liste de différences détectées
   */
  private compareSoftware(
    source: MachineInventory,
    target: MachineInventory
  ): DetectedDifference[] {
    const diffs: DetectedDifference[] = [];

    // PowerShell
    const sourcePwsh = safeGet(source, ['software', 'powershell'], 'Unknown');
    const targetPwsh = safeGet(target, ['software', 'powershell'], 'Unknown');
    if (sourcePwsh !== targetPwsh) {
      diffs.push({
        id: randomUUID(),
        category: 'software',
        severity: 'WARNING',
        path: 'software.powershell',
        source: { value: sourcePwsh, machineId: source.machineId },
        target: { value: targetPwsh, machineId: target.machineId },
        type: 'VERSION_MISMATCH',
        description: `Version PowerShell différente : ${sourcePwsh} vs ${targetPwsh}`,
        recommendedAction: `Mettre à jour PowerShell sur ${target.machineId} vers version ${sourcePwsh}`,
        affectedComponents: ['PowerShell', 'Scripts']
      });
    }

    // Node.js
    const sourceNode = safeGet(source, ['software', 'node'], null);
    const targetNode = safeGet(target, ['software', 'node'], null);
    if (sourceNode !== targetNode) {
      // Gérer le cas où Node est absent sur une machine
      if (!sourceNode || !targetNode) {
        diffs.push({
          id: randomUUID(),
          category: 'software',
          severity: 'INFO',
          path: 'software.node',
          source: { value: sourceNode, machineId: source.machineId },
          target: { value: targetNode, machineId: target.machineId },
          type: sourceNode ? 'MISSING' : 'ADDED',
          description: !targetNode
            ? `Node.js absent sur ${target.machineId}`
            : `Node.js absent sur ${source.machineId}`,
          affectedComponents: ['Node.js']
        });
      } else {
        diffs.push({
          id: randomUUID(),
          category: 'software',
          severity: 'INFO',
          path: 'software.node',
          source: { value: sourceNode, machineId: source.machineId },
          target: { value: targetNode, machineId: target.machineId },
          type: 'VERSION_MISMATCH',
          description: `Version Node.js différente : ${sourceNode} vs ${targetNode}`,
          affectedComponents: ['Node.js', 'NPM']
        });
      }
    }

    // Python
    const sourcePython = safeGet(source, ['software', 'python'], null);
    const targetPython = safeGet(target, ['software', 'python'], null);
    if (sourcePython !== targetPython) {
      if (!sourcePython || !targetPython) {
        diffs.push({
          id: randomUUID(),
          category: 'software',
          severity: 'INFO',
          path: 'software.python',
          source: { value: sourcePython, machineId: source.machineId },
          target: { value: targetPython, machineId: target.machineId },
          type: sourcePython ? 'MISSING' : 'ADDED',
          description: !targetPython
            ? `Python absent sur ${target.machineId}`
            : `Python absent sur ${source.machineId}`,
          affectedComponents: ['Python']
        });
      } else {
        diffs.push({
          id: randomUUID(),
          category: 'software',
          severity: 'INFO',
          path: 'software.python',
          source: { value: sourcePython, machineId: source.machineId },
          target: { value: targetPython, machineId: target.machineId },
          type: 'VERSION_MISMATCH',
          description: `Version Python différente : ${sourcePython} vs ${targetPython}`,
          affectedComponents: ['Python', 'Pip']
        });
      }
    }

    return diffs;
  }

  /**
   * Compare informations système (OS, architecture, uptime)
   * @returns Liste de différences détectées
   */
  private compareSystem(
    source: MachineInventory,
    target: MachineInventory
  ): DetectedDifference[] {
    const diffs: DetectedDifference[] = [];

    // OS
    const sourceOs = safeGet(source, ['system', 'os'], 'unknown');
    const targetOs = safeGet(target, ['system', 'os'], 'unknown');
    if (sourceOs !== targetOs) {
      diffs.push({
        id: randomUUID(),
        category: 'system',
        severity: 'INFO',
        path: 'system.os',
        source: { value: sourceOs, machineId: source.machineId },
        target: { value: targetOs, machineId: target.machineId },
        type: 'MODIFIED',
        description: `Système d'exploitation différent : ${sourceOs} vs ${targetOs}`,
        affectedComponents: ['OS']
      });
    }

    // Architecture
    const sourceArch = safeGet(source, ['system', 'architecture'], 'unknown');
    const targetArch = safeGet(target, ['system', 'architecture'], 'unknown');
    if (sourceArch !== targetArch) {
      diffs.push({
        id: randomUUID(),
        category: 'system',
        severity: 'IMPORTANT',
        path: 'system.architecture',
        source: { value: sourceArch, machineId: source.machineId },
        target: { value: targetArch, machineId: target.machineId },
        type: 'MODIFIED',
        description: `Architecture système différente : ${sourceArch} vs ${targetArch}`,
        recommendedAction: `Attention : architectures incompatibles peuvent nécessiter des builds différents`,
        affectedComponents: ['Architecture', 'Binaries']
      });
    }

    // Hostname
    const sourceHostname = safeGet(source, ['system', 'hostname'], 'unknown');
    const targetHostname = safeGet(target, ['system', 'hostname'], 'unknown');
    if (sourceHostname !== targetHostname) {
      diffs.push({
        id: randomUUID(),
        category: 'system',
        severity: 'INFO',
        path: 'system.hostname',
        source: { value: sourceHostname, machineId: source.machineId },
        target: { value: targetHostname, machineId: target.machineId },
        type: 'MODIFIED',
        description: `Hostname différent : ${sourceHostname} vs ${targetHostname}`,
        affectedComponents: ['Network']
      });
    }

    // Note : uptime n'est pas comparé (normal qu'il diffère)

    return diffs;
  }

  /**
   * Détermine la sévérité d'une différence selon catégorie et type
   * @param category - Catégorie de la différence
   * @param type - Type de la différence
   * @param path - Chemin de la différence
   * @param diffPercent - Pourcentage de différence (optionnel, pour hardware)
   * @returns Niveau de sévérité
   */
  private determineSeverity(
    category: DiffCategory,
    type: DiffType,
    path: string,
    diffPercent?: number
  ): DiffSeverity {
    // Matrice de sévérité selon le design
    
    if (category === 'roo_config') {
      // Configuration Roo = toujours CRITICAL
      return 'CRITICAL';
    }

    if (category === 'hardware') {
      // Hardware : sévérité selon le pourcentage de différence
      if (path.includes('cpu.cores') || path.includes('cpu.threads')) {
        return diffPercent && diffPercent > 25 ? 'IMPORTANT' : 'INFO';
      }
      if (path.includes('memory.total')) {
        return diffPercent && diffPercent > 20 ? 'IMPORTANT' : 'WARNING';
      }
      if (path.includes('disks')) {
        return 'WARNING';
      }
      if (path.includes('gpu')) {
        return 'INFO';
      }
    }

    if (category === 'software') {
      // Software : WARNING pour PowerShell, INFO pour le reste
      if (path.includes('powershell')) {
        return 'WARNING';
      }
      return 'INFO';
    }

    if (category === 'system') {
      // System : IMPORTANT pour architecture, INFO pour le reste
      if (path.includes('architecture')) {
        return 'IMPORTANT';
      }
      return 'INFO';
    }

    // Par défaut
    return 'INFO';
  }

  /**
   * Génère une action recommandée pour une différence
   * @param diff - La différence détectée
   * @returns Action recommandée (optionnel)
   */
  private generateRecommendation(diff: Partial<DetectedDifference>): string | undefined {
    const { category, path, type, source, target } = diff;

    if (!category || !path || !type || !source || !target) {
      return undefined;
    }

    // Recommandations pour configuration Roo
    if (category === 'roo_config') {
      if (path.includes('modesPath')) {
        return `Synchroniser le chemin des modes Roo : copier la configuration de ${source.machineId} vers ${target.machineId}`;
      }
      if (path.includes('mcpSettings')) {
        return `Synchroniser les paramètres MCP : vérifier et aligner les fichiers mcp_settings.json`;
      }
    }

    // Recommandations pour hardware
    if (category === 'hardware') {
      if (path.includes('cpu')) {
        return `Performance CPU différente - tester le comportement des tâches intensives`;
      }
      if (path.includes('memory')) {
        return `Différence de RAM - surveiller la consommation mémoire sur ${target.machineId}`;
      }
      if (path.includes('gpu') && type === 'MISSING') {
        return `GPU manquant sur ${target.machineId} - certaines opérations graphiques peuvent être plus lentes`;
      }
    }

    // Recommandations pour software
    if (category === 'software') {
      if (path.includes('powershell')) {
        return `Mettre à jour PowerShell sur ${target.machineId} vers version ${source.value}`;
      }
      if (path.includes('node') && type === 'MISSING') {
        return `Installer Node.js sur ${target.machineId}`;
      }
      if (path.includes('python') && type === 'MISSING') {
        return `Installer Python sur ${target.machineId} si nécessaire`;
      }
    }

    // Recommandations pour system
    if (category === 'system') {
      if (path.includes('architecture')) {
        return `Architectures incompatibles - compiler séparément pour chaque plateforme`;
      }
    }

    return undefined;
  }
}