/**
 * BaselineService - Service central pour l'architecture baseline-driven de RooSync v2.1
 * 
 * Ce service orchestre toutes les opérations de comparaison avec la baseline,
 * créant les décisions de synchronisation et gérant leur application.
 * 
 * @module BaselineService
 * @version 2.1.0
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { existsSync, copyFileSync } from 'fs';
import {
  BaselineConfig,
  BaselineDifference,
  BaselineComparisonReport,
  SyncDecision,
  CompareWithBaselineOptions,
  DecisionApplicationResult,
  BaselineServiceState,
  BaselineServiceConfig,
  BaselineServiceError,
  BaselineServiceErrorCode,
  IInventoryCollector,
  IDiffDetector,
  IConfigService,
  MachineInventory
} from '../types/baseline.js';

/**
 * Service BaselineService - Cœur de l'architecture baseline-driven
 */
export class BaselineService {
  private baselinePath: string;
  private roadmapPath: string;
  private config: BaselineServiceConfig;
  private state: BaselineServiceState;
  private cache: Map<string, any> = new Map();

  constructor(
    private configService: IConfigService,
    private inventoryCollector: IInventoryCollector,
    private diffDetector: IDiffDetector
  ) {
    this.config = configService.getBaselineServiceConfig();
    const sharedStatePath = configService.getSharedStatePath();
    
    this.baselinePath = join(sharedStatePath, 'sync-config.ref.json');
    this.roadmapPath = join(sharedStatePath, 'sync-roadmap.md');
    
    this.state = {
      isBaselineLoaded: false,
      pendingDecisions: 0,
      approvedDecisions: 0,
      appliedDecisions: 0
    };

    this.logInfo('BaselineService initialisé', {
      baselinePath: this.baselinePath,
      roadmapPath: this.roadmapPath
    });
  }

  /**
   * Charge la configuration baseline depuis sync-config.ref.json
   */
  public async loadBaseline(): Promise<BaselineConfig | null> {
    try {
      this.logInfo('Chargement de la baseline', { path: this.baselinePath });
      
      if (!existsSync(this.baselinePath)) {
        this.logWarn('Fichier baseline non trouvé', { path: this.baselinePath });
        return null;
      }
      
      const content = await fs.readFile(this.baselinePath, 'utf-8');
      const baseline = JSON.parse(content) as BaselineConfig;
      
      // Validation de la baseline
      if (!this.validateBaselineConfig(baseline)) {
        throw new BaselineServiceError(
          'Configuration baseline invalide',
          BaselineServiceErrorCode.BASELINE_INVALID
        );
      }
      
      this.state.isBaselineLoaded = true;
      this.state.baselineMachine = baseline.machineId;
      this.state.baselineVersion = baseline.version;
      
      this.logInfo('Baseline chargée avec succès', {
        machineId: baseline.machineId,
        version: baseline.version,
        lastUpdated: baseline.lastUpdated
      });
      
      return baseline;
    } catch (error) {
      this.logError('Erreur lors du chargement de la baseline', error);
      
      if (error instanceof BaselineServiceError) {
        throw error;
      }
      
      throw new BaselineServiceError(
        `Erreur chargement baseline: ${(error as Error).message}`,
        BaselineServiceErrorCode.BASELINE_NOT_FOUND,
        error
      );
    }
  }

  /**
   * Compare une machine avec la configuration baseline
   */
  public async compareWithBaseline(
    targetMachineId: string,
    forceRefresh = false
  ): Promise<BaselineComparisonReport | null> {
    const startTime = Date.now();
    
    try {
      this.logInfo('Début de la comparaison avec la baseline', {
        targetMachineId,
        forceRefresh
      });
      
      // Charger la baseline
      const baseline = await this.loadBaseline();
      if (!baseline) {
        throw new BaselineServiceError(
          'Configuration baseline non disponible',
          BaselineServiceErrorCode.BASELINE_NOT_FOUND
        );
      }
      
      // Collecter inventaire de la machine cible
      const targetInventory = await this.inventoryCollector.collectInventory(
        targetMachineId, 
        forceRefresh
      );
      
      if (!targetInventory) {
        throw new BaselineServiceError(
          `Échec collecte inventaire pour ${targetMachineId}`,
          BaselineServiceErrorCode.INVENTORY_COLLECTION_FAILED
        );
      }
      
      // Comparer baseline avec machine cible
      const differences = await this.diffDetector.compareBaselineWithMachine(
        baseline,
        targetInventory
      );
      
      const report: BaselineComparisonReport = {
        baselineMachine: baseline.machineId,
        targetMachine: targetMachineId,
        baselineVersion: baseline.version,
        differences,
        summary: this.calculateSummary(differences),
        generatedAt: new Date().toISOString()
      };
      
      this.state.lastComparison = report.generatedAt;
      
      const duration = Date.now() - startTime;
      this.logInfo('Comparaison terminée avec succès', {
        targetMachineId,
        differencesCount: report.summary.total,
        duration: `${duration}ms`
      });
      
      return report;
    } catch (error) {
      this.logError('Erreur lors de la comparaison avec la baseline', error);
      
      if (error instanceof BaselineServiceError) {
        throw error;
      }
      
      throw new BaselineServiceError(
        `Erreur comparaison baseline: ${(error as Error).message}`,
        BaselineServiceErrorCode.COMPARISON_FAILED,
        error
      );
    }
  }

  /**
   * Crée des décisions de synchronisation à partir des différences détectées
   */
  public async createSyncDecisions(
    report: BaselineComparisonReport,
    severityThreshold: 'CRITICAL' | 'IMPORTANT' | 'WARNING' | 'INFO' = 'IMPORTANT'
  ): Promise<SyncDecision[]> {
    try {
      this.logInfo('Création des décisions de synchronisation', {
        targetMachine: report.targetMachine,
        severityThreshold,
        totalDifferences: report.differences.length
      });
      
      // Filtrer les différences selon le seuil de sévérité
      const filteredDifferences = report.differences.filter(diff => 
        this.isSeverityAtLeast(diff.severity, severityThreshold)
      );
      
      const decisions: SyncDecision[] = filteredDifferences.map((diff, index) => ({
        id: `decision-${Date.now()}-${index}`,
        machineId: report.targetMachine,
        differenceId: `${diff.category}-${diff.path}`,
        category: diff.category,
        description: diff.description,
        baselineValue: diff.baselineValue,
        targetValue: diff.actualValue,
        action: this.recommendAction(diff),
        severity: diff.severity,
        status: 'pending',
        createdAt: new Date().toISOString()
      }));
      
      // Ajouter les décisions au roadmap
      await this.addDecisionsToRoadmap(decisions);
      
      // Mettre à jour l'état
      this.state.pendingDecisions += decisions.length;
      
      this.logInfo('Décisions créées avec succès', {
        count: decisions.length,
        pendingDecisions: this.state.pendingDecisions
      });
      
      return decisions;
    } catch (error) {
      this.logError('Erreur lors de la création des décisions', error);
      
      throw new BaselineServiceError(
        `Erreur création décisions: ${(error as Error).message}`,
        BaselineServiceErrorCode.COMPARISON_FAILED,
        error
      );
    }
  }

  /**
   * Applique une décision de synchronisation approuvée
   */
  public async applyDecision(decisionId: string): Promise<DecisionApplicationResult> {
    const startTime = Date.now();
    
    try {
      this.logInfo('Application de la décision', { decisionId });
      
      // Charger les décisions depuis le roadmap
      const decisions = await this.loadDecisionsFromRoadmap();
      const decision = decisions.find(d => d.id === decisionId);
      
      if (!decision) {
        throw new BaselineServiceError(
          `Décision ${decisionId} non trouvée`,
          BaselineServiceErrorCode.DECISION_NOT_FOUND
        );
      }
      
      if (decision.status !== 'approved') {
        throw new BaselineServiceError(
          `Décision ${decisionId} n'est pas approuvée (statut: ${decision.status})`,
          BaselineServiceErrorCode.DECISION_INVALID_STATUS
        );
      }
      
      // Appliquer les changements sur la machine cible
      const success = await this.applyChangesToMachine(decision);
      
      const result: DecisionApplicationResult = {
        success,
        decisionId,
        appliedAt: new Date().toISOString(),
        message: success ? 'Décision appliquée avec succès' : 'Échec de l\'application'
      };
      
      if (success) {
        // Mettre à jour le statut de la décision
        decision.status = 'applied';
        decision.appliedAt = result.appliedAt;
        await this.updateDecisionInRoadmap(decision);
        
        // Mettre à jour l'état
        this.state.approvedDecisions--;
        this.state.appliedDecisions++;
        
        this.logInfo('Décision appliquée avec succès', {
          decisionId,
          duration: `${Date.now() - startTime}ms`
        });
      } else {
        this.logError('Échec de l\'application de la décision', { decisionId });
        result.error = 'Échec lors de l\'application des changements';
      }
      
      return result;
    } catch (error) {
      this.logError('Erreur lors de l\'application de la décision', error);
      
      if (error instanceof BaselineServiceError) {
        throw error;
      }
      
      throw new BaselineServiceError(
        `Erreur application décision: ${(error as Error).message}`,
        BaselineServiceErrorCode.APPLICATION_FAILED,
        error
      );
    }
  }

  /**
   * Retourne l'état actuel du service
   */
  public getState(): BaselineServiceState {
    return { ...this.state };
  }

  /**
   * Met à jour la configuration baseline (pour maintenance)
   */
  public async updateBaseline(
    newBaseline: BaselineConfig, 
    options: { createBackup?: boolean; updateReason?: string; updatedBy?: string } = {}
  ): Promise<boolean> {
    try {
      this.logInfo('Mise à jour de la baseline', {
        machineId: newBaseline.machineId,
        version: newBaseline.version,
        createBackup: options.createBackup
      });
      
      // Validation de la nouvelle baseline
      if (!this.validateBaselineConfig(newBaseline)) {
        throw new BaselineServiceError(
          'Configuration baseline invalide',
          BaselineServiceErrorCode.BASELINE_INVALID
        );
      }
      
      // Sauvegarder l'ancienne baseline si demandé
      if (options.createBackup && existsSync(this.baselinePath)) {
        const backupPath = `${this.baselinePath}.backup.${Date.now()}`;
        copyFileSync(this.baselinePath, backupPath);
        this.logInfo('Ancienne baseline sauvegardée', { backupPath });
      }
      
      // Écrire la nouvelle baseline
      await fs.writeFile(this.baselinePath, JSON.stringify(newBaseline, null, 2));
      
      // Mettre à jour l'état
      this.state.baselineMachine = newBaseline.machineId;
      this.state.baselineVersion = newBaseline.version;
      this.state.isBaselineLoaded = true;
      
      this.logInfo('Baseline mise à jour avec succès', {
        machineId: newBaseline.machineId,
        version: newBaseline.version
      });
      
      return true;
    } catch (error) {
      this.logError('Erreur lors de la mise à jour de la baseline', error);
      
      if (error instanceof BaselineServiceError) {
        throw error;
      }
      
      throw new BaselineServiceError(
        `Erreur mise à jour baseline: ${(error as Error).message}`,
        BaselineServiceErrorCode.BASELINE_INVALID,
        error
      );
    }
  }

  // Méthodes privées

  /**
   * Calcule le résumé des différences
   */
  private calculateSummary(differences: BaselineDifference[]) {
    return differences.reduce((acc, diff) => {
      acc.total++;
      const severity = diff.severity.toLowerCase() as keyof typeof acc;
      if (severity in acc) {
        acc[severity]++;
      }
      return acc;
    }, { total: 0, critical: 0, important: 0, warning: 0, info: 0 });
  }

  /**
   * Vérifie si la sévérité est au moins au niveau requis
   */
  private isSeverityAtLeast(
    severity: string,
    threshold: string
  ): boolean {
    const levels: Record<string, number> = { 'CRITICAL': 4, 'IMPORTANT': 3, 'WARNING': 2, 'INFO': 1 };
    return (levels[severity] || 0) >= (levels[threshold] || 0);
  }

  /**
   * Recommande une action basée sur la différence
   */
  private recommendAction(
    diff: BaselineDifference
  ): 'sync_to_baseline' | 'keep_target' | 'manual_review' {
    if (diff.severity === 'CRITICAL') return 'sync_to_baseline';
    if (diff.category === 'config') return 'sync_to_baseline';
    if (diff.category === 'hardware') return 'keep_target';
    return 'manual_review';
  }

  /**
   * Convertit l'inventaire vers le format BaselineConfig
   */
  private convertInventoryToBaselineConfig(inventory: MachineInventory): BaselineConfig {
    return {
      machineId: inventory.machineId,
      version: '1.0.0',
      lastUpdated: inventory.timestamp,
      config: {
        roo: {
          modes: inventory.config.roo?.modes || [],
          mcpSettings: inventory.config.roo?.mcpSettings || {},
          userSettings: inventory.config.roo?.userSettings || {}
        },
        hardware: {
          cpu: inventory.config.hardware?.cpu || 'Unknown',
          ram: inventory.config.hardware?.ram || 'Unknown',
          disks: inventory.config.hardware?.disks || []
        },
        software: {
          powershell: inventory.config.software?.powershell || 'Unknown',
          node: inventory.config.software?.node || 'N/A',
          python: inventory.config.software?.python || 'N/A'
        },
        system: {
          os: inventory.config.system?.os || 'Unknown',
          architecture: inventory.config.system?.architecture || 'Unknown'
        }
      }
    };
  }

  /**
   * Ajoute les décisions au fichier roadmap
   */
  private async addDecisionsToRoadmap(decisions: SyncDecision[]): Promise<void> {
    try {
      this.logInfo('Ajout des décisions au roadmap', { count: decisions.length });
      
      // Vérifier si le fichier roadmap existe
      let roadmapContent = '';
      if (existsSync(this.roadmapPath)) {
        roadmapContent = await fs.readFile(this.roadmapPath, 'utf-8');
      } else {
        // Créer l'en-tête du fichier roadmap
        roadmapContent = `# RooSync Roadmap\n\n## Décisions de Synchronisation\n\n`;
      }
      
      // Ajouter chaque décision au roadmap
      const timestamp = new Date().toISOString();
      for (const decision of decisions) {
        const decisionMarkdown = this.formatDecisionToMarkdown(decision, timestamp);
        roadmapContent += `\n${decisionMarkdown}\n`;
      }
      
      // Écrire le fichier roadmap mis à jour
      await fs.writeFile(this.roadmapPath, roadmapContent, 'utf-8');
      
      this.logInfo('Décisions ajoutées au roadmap avec succès', {
        count: decisions.length,
        roadmapPath: this.roadmapPath
      });
    } catch (error) {
      this.logError('Erreur lors de l\'ajout des décisions au roadmap', error);
      throw new BaselineServiceError(
        `Erreur ajout décisions roadmap: ${(error as Error).message}`,
        BaselineServiceErrorCode.ROADMAP_UPDATE_FAILED,
        error
      );
    }
  }

  /**
   * Charge les décisions depuis le roadmap
   */
  private async loadDecisionsFromRoadmap(): Promise<SyncDecision[]> {
    try {
      this.logInfo('Chargement des décisions depuis le roadmap');
      
      if (!existsSync(this.roadmapPath)) {
        this.logWarn('Fichier roadmap non trouvé', { path: this.roadmapPath });
        return [];
      }
      
      const content = await fs.readFile(this.roadmapPath, 'utf-8');
      const decisions = this.parseDecisionsFromMarkdown(content);
      
      this.logInfo('Décisions chargées depuis le roadmap', {
        count: decisions.length,
        roadmapPath: this.roadmapPath
      });
      
      return decisions;
    } catch (error) {
      this.logError('Erreur lors du chargement des décisions depuis le roadmap', error);
      return [];
    }
  }

  /**
   * Met à jour une décision dans le roadmap
   */
  private async updateDecisionInRoadmap(decision: SyncDecision): Promise<void> {
    try {
      this.logInfo('Mise à jour de la décision dans le roadmap', { decisionId: decision.id });
      
      if (!existsSync(this.roadmapPath)) {
        throw new BaselineServiceError(
          'Fichier roadmap non trouvé',
          BaselineServiceErrorCode.ROADMAP_UPDATE_FAILED
        );
      }
      
      let content = await fs.readFile(this.roadmapPath, 'utf-8');
      
      // Remplacer la section de la décision dans le contenu
      const decisionSection = this.formatDecisionToMarkdown(decision, decision.updatedAt || decision.createdAt);
      const decisionRegex = new RegExp(`## Décision ${decision.id}[^#]*(?=##|$)`, 'gs');
      
      if (decisionRegex.test(content)) {
        content = content.replace(decisionRegex, decisionSection);
      } else {
        // Si la décision n'existe pas, l'ajouter à la fin
        content += `\n${decisionSection}\n`;
      }
      
      await fs.writeFile(this.roadmapPath, content, 'utf-8');
      
      this.logInfo('Décision mise à jour dans le roadmap avec succès', {
        decisionId: decision.id,
        status: decision.status
      });
    } catch (error) {
      this.logError('Erreur lors de la mise à jour de la décision dans le roadmap', error);
      throw new BaselineServiceError(
        `Erreur mise à jour décision roadmap: ${(error as Error).message}`,
        BaselineServiceErrorCode.ROADMAP_UPDATE_FAILED,
        error
      );
    }
  }

  /**
   * Applique les changements sur la machine cible
   */
  private async applyChangesToMachine(decision: SyncDecision): Promise<boolean> {
    try {
      this.logInfo('Application des changements sur la machine', {
        machineId: decision.machineId,
        category: decision.category,
        action: decision.action
      });
      
      // Implémentation de l'application des changements selon la catégorie
      switch (decision.category) {
        case 'config':
          return this.applyConfigChanges(decision);
        case 'software':
          return this.applySoftwareChanges(decision);
        case 'system':
          return this.applySystemChanges(decision);
        case 'hardware':
          this.logWarn('Les changements hardware ne peuvent être appliqués automatiquement');
          return false;
        default:
          this.logWarn('Catégorie de changement non gérée', { category: decision.category });
          return false;
      }
    } catch (error) {
      this.logError('Erreur lors de l\'application des changements', error);
      return false;
    }
  }

  /**
   * Applique les changements de configuration
   */
  private async applyConfigChanges(decision: SyncDecision): Promise<boolean> {
    try {
      this.logInfo('Application des changements de configuration', {
        decisionId: decision.id,
        path: decision.differenceId
      });
      
      // Pour l'instant, nous simulons l'application des changements
      // Dans une implémentation réelle, cela modifierait les fichiers de configuration
      
      // Simulation de l'application selon le chemin de configuration
      if (decision.differenceId.startsWith('roo.modes')) {
        this.logInfo('Application des changements de modes', {
          baselineValue: decision.baselineValue,
          targetValue: decision.targetValue
        });
      } else if (decision.differenceId.startsWith('roo.mcpSettings')) {
        this.logInfo('Application des changements MCP', {
          baselineValue: decision.baselineValue,
          targetValue: decision.targetValue
        });
      } else if (decision.differenceId.startsWith('roo.userSettings')) {
        this.logInfo('Application des changements utilisateur', {
          baselineValue: decision.baselineValue,
          targetValue: decision.targetValue
        });
      }
      
      return true;
    } catch (error) {
      this.logError('Erreur lors de l\'application des changements de configuration', error);
      return false;
    }
  }

  /**
   * Applique les changements logiciels
   */
  private async applySoftwareChanges(decision: SyncDecision): Promise<boolean> {
    try {
      this.logInfo('Application des changements logiciels', {
        decisionId: decision.id,
        path: decision.differenceId
      });
      
      // Simulation de l'application des changements logiciels
      // Dans une implémentation réelle, cela pourrait installer/mettre à jour des logiciels
      
      if (decision.differenceId.includes('powershell')) {
        this.logInfo('Mise à jour PowerShell détectée', {
          baselineValue: decision.baselineValue,
          targetValue: decision.targetValue
        });
      } else if (decision.differenceId.includes('node')) {
        this.logInfo('Mise à jour Node.js détectée', {
          baselineValue: decision.baselineValue,
          targetValue: decision.targetValue
        });
      } else if (decision.differenceId.includes('python')) {
        this.logInfo('Mise à jour Python détectée', {
          baselineValue: decision.baselineValue,
          targetValue: decision.targetValue
        });
      }
      
      return true;
    } catch (error) {
      this.logError('Erreur lors de l\'application des changements logiciels', error);
      return false;
    }
  }

  /**
   * Applique les changements système
   */
  private async applySystemChanges(decision: SyncDecision): Promise<boolean> {
    try {
      this.logInfo('Application des changements système', {
        decisionId: decision.id,
        path: decision.differenceId
      });
      
      // Simulation de l'application des changements système
      // Dans une implémentation réelle, cela pourrait modifier des paramètres système
      
      if (decision.differenceId.includes('os')) {
        this.logInfo('Changement OS détecté (lecture seule)', {
          baselineValue: decision.baselineValue,
          targetValue: decision.targetValue
        });
        return false; // Les changements OS ne sont généralement pas applicables
      } else if (decision.differenceId.includes('architecture')) {
        this.logInfo('Changement architecture détecté (lecture seule)', {
          baselineValue: decision.baselineValue,
          targetValue: decision.targetValue
        });
        return false; // L'architecture n'est pas modifiable
      }
      
      return true;
    } catch (error) {
      this.logError('Erreur lors de l\'application des changements système', error);
      return false;
    }
  }

  /**
   * Valide la configuration de la baseline
   */
  private validateBaselineConfig(baseline: BaselineConfig): boolean {
    try {
      return !!(
        baseline.machineId && 
        baseline.config && 
        baseline.version &&
        baseline.config.roo &&
        baseline.config.hardware &&
        baseline.config.software &&
        baseline.config.system
      );
    } catch (error) {
      this.logError('Erreur lors de la validation de la baseline', error);
      return false;
    }
  }

  /**
   * Formate une décision en Markdown pour le roadmap
   */
  private formatDecisionToMarkdown(decision: SyncDecision, timestamp: string): string {
    const statusEmoji = this.getStatusEmoji(decision.status);
    const severityEmoji = this.getSeverityEmoji(decision.severity);
    
    return `
## ${statusEmoji} Décision ${decision.id}

**Machine:** ${decision.machineId}
**Catégorie:** ${decision.category}
**Différence:** ${decision.differenceId}
**Sévérité:** ${severityEmoji} ${decision.severity}
**Statut:** ${decision.status}
**Créée le:** ${decision.createdAt}
**Mise à jour le:** ${timestamp}

### Description
${decision.description}

### Différence
- **Valeur baseline:** \`${JSON.stringify(decision.baselineValue)}\`
- **Valeur cible:** \`${JSON.stringify(decision.targetValue)}\`

### Action requise
**Type:** ${decision.action}

${decision.notes ? `### Notes\n${decision.notes}` : ''}

---
`;
  }

  /**
   * Parse les décisions depuis le contenu Markdown du roadmap
   */
  private parseDecisionsFromMarkdown(content: string): SyncDecision[] {
    const decisions: SyncDecision[] = [];
    const sections = content.split(/## (⏳|✅|❌|🎯) Décision /).filter(section => section.trim());

    for (const section of sections) {
      try {
        const lines = section.split('\n').filter(line => line.trim());
        const idLine = lines.find(line => line.match(/^[a-zA-Z0-9-]+/));
        if (!idLine) continue;

        const id = idLine.trim();
        const machineId = this.extractField(lines, 'Machine:');
        const category = this.extractField(lines, 'Catégorie:');
        const severity = this.extractField(lines, 'Sévérité:').split(' ').pop() || '';
        const status = this.extractField(lines, 'Statut:');
        const createdAt = this.extractField(lines, 'Créée le:');
        const updatedAt = this.extractField(lines, 'Mise à jour le:');
        const differenceId = this.extractField(lines, 'Différence:') || `${category}.${id}`;
        
        const descriptionMatch = section.match(/### Description\n(.*?)(?=\n###|\n---|$)/s);
        const description = descriptionMatch ? descriptionMatch[1].trim() : '';
        
        const baselineMatch = section.match(/- \*\*Valeur baseline:\*\* `([^`]+)`/);
        const baselineValue = baselineMatch ? JSON.parse(baselineMatch[1]) : null;
        
        const targetMatch = section.match(/- \*\*Valeur cible:\*\* `([^`]+)`/);
        const targetValue = targetMatch ? JSON.parse(targetMatch[1]) : null;
        
        const actionMatch = section.match(/\*\*Type:\*\* (.+)/);
        const action = actionMatch ? actionMatch[1].trim() as SyncDecision['action'] : 'manual_review';
        
        const notesMatch = section.match(/### Notes\n(.*?)(?=\n---|$)/s);
        const notes = notesMatch ? notesMatch[1].trim() : undefined;

        if (id && machineId && category && description) {
          decisions.push({
            id,
            machineId,
            differenceId,
            category,
            description,
            baselineValue,
            targetValue,
            action,
            severity,
            status: status as SyncDecision['status'],
            createdAt,
            updatedAt,
            notes
          });
        }
      } catch (error) {
        this.logWarn(`Erreur lors du parsing de la décision:`, error);
      }
    }

    return decisions;
  }

  /**
   * Extrait un champ depuis les lignes de texte
   */
  private extractField(lines: string[], fieldName: string): string {
    const line = lines.find(line => line.includes(fieldName));
    if (!line) return '';
    
    // Format: **Machine:** machine-1
    const match = line.match(new RegExp(`\\*\\*${fieldName}\\*\\*\\s*(.+)`));
    if (match) return match[1].trim();
    
    // Fallback pour les champs sans formatage gras
    const fallbackMatch = line.match(new RegExp(`${fieldName}\\s*(.+)`));
    return fallbackMatch ? fallbackMatch[1].trim() : '';
  }

  /**
   * Retourne l'emoji correspondant au statut
   */
  private getStatusEmoji(status: string): string {
    const emojis = {
      pending: '⏳',
      approved: '✅',
      rejected: '❌',
      applied: '🎯'
    };
    return emojis[status as keyof typeof emojis] || '❓';
  }

  /**
   * Retourne l'emoji correspondant à la sévérité
   */
  private getSeverityEmoji(severity: string): string {
    const emojis = {
      CRITICAL: '🚨',
      IMPORTANT: '⚠️',
      WARNING: '🟡',
      INFO: 'ℹ️'
    };
    return emojis[severity as keyof typeof emojis] || 'ℹ️';
  }

  // Méthodes de logging

  private logInfo(message: string, data?: any): void {
    const logEntry = {
      timestamp: new Date().toISOString(),
      level: 'INFO',
      service: 'BaselineService',
      message,
      data
    };
    
    if (this.config.logLevel === 'DEBUG' || this.config.logLevel === 'INFO') {
      console.log(JSON.stringify(logEntry));
    }
  }

  private logWarn(message: string, data?: any): void {
    const logEntry = {
      timestamp: new Date().toISOString(),
      level: 'WARN',
      service: 'BaselineService',
      message,
      data
    };
    
    if (this.config.logLevel !== 'ERROR') {
      console.warn(JSON.stringify(logEntry));
    }
  }

  private logError(message: string, error?: any): void {
    const logEntry = {
      timestamp: new Date().toISOString(),
      level: 'ERROR',
      service: 'BaselineService',
      message,
      error: error?.message || error
    };
    
    console.error(JSON.stringify(logEntry));
  }
}