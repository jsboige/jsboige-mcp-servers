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
import { join, resolve } from 'path';
import { existsSync, copyFileSync } from 'fs';
import {
  BaselineConfig,
  BaselineFileConfig,
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

// Import des nouveaux modules
import { BaselineLoader } from './baseline/BaselineLoader.js';
import { DifferenceDetector } from './baseline/DifferenceDetector.js';
import { ChangeApplier } from './baseline/ChangeApplier.js';
import { ConfigValidator } from './baseline/ConfigValidator.js';

/**
 * Service BaselineService - Cœur de l'architecture baseline-driven
 */
export class BaselineService {
  private baselinePath: string;
  private roadmapPath: string;
  private config: BaselineServiceConfig;
  private state: BaselineServiceState;
  private cache: Map<string, any> = new Map();

  // Modules délégués
  private baselineLoader: BaselineLoader;
  private differenceDetector: DifferenceDetector;
  private changeApplier: ChangeApplier;
  private configValidator: ConfigValidator;

  constructor(
    private configService: IConfigService,
    private inventoryCollector: IInventoryCollector,
    private diffDetector: IDiffDetector
  ) {
    console.log('[DEBUG] BaselineService.constructor() appelé');

    this.config = configService.getBaselineServiceConfig();
    // CORRECTION SDDD : Utiliser la variable d'environnement ROOSYNC_SHARED_PATH (prioritaire) ou SHARED_STATE_PATH (legacy)
    const sharedStatePath = process.env.ROOSYNC_SHARED_PATH || process.env.SHARED_STATE_PATH || configService.getSharedStatePath();
    console.log('[DEBUG] sharedStatePath:', sharedStatePath);

    // PRIORITÉ ABSOLUE : Forcer l'utilisation du chemin mocké en environnement de test
    if (process.env.SHARED_STATE_PATH) {
      this.baselinePath = join(process.env.SHARED_STATE_PATH, 'sync-config.ref.json');
      this.roadmapPath = join(process.env.SHARED_STATE_PATH, 'sync-roadmap.md');
    } else {
      // Utiliser le chemin de la baseline depuis la configuration du service
      this.baselinePath = this.config.baselinePath || join(sharedStatePath, 'sync-config.ref.json');
      this.roadmapPath = this.config.roadmapPath || join(sharedStatePath, 'sync-roadmap.md');
    }

    console.log('[DEBUG] this.baselinePath forcé:', this.baselinePath);
    console.log('[DEBUG] this.roadmapPath:', this.roadmapPath);

    this.state = {
      isBaselineLoaded: false,
      pendingDecisions: 0,
      approvedDecisions: 0,
      appliedDecisions: 0
    };

    // Initialisation des modules délégués
    this.configValidator = new ConfigValidator();
    this.baselineLoader = new BaselineLoader(this.configValidator);
    this.differenceDetector = new DifferenceDetector();
    this.changeApplier = new ChangeApplier();

    console.log('[DEBUG] Vérification existence du fichier baseline...');
    const fileExists = existsSync(this.baselinePath);
    console.log('[DEBUG] Fichier baseline existe:', fileExists);
    console.log('[DEBUG] Chemin résolu:', resolve(this.baselinePath));
    console.log('[DEBUG] Working directory:', process.cwd());

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
      
      const baseline = await this.baselineLoader.loadBaseline(this.baselinePath);

      if (baseline) {
        this.state.isBaselineLoaded = true;
        this.state.baselineMachine = baseline.machineId;
        this.state.baselineVersion = baseline.version;

        this.logInfo('Baseline chargée avec succès', {
          machineId: baseline.machineId,
          version: baseline.version,
          lastUpdated: baseline.lastUpdated
        });
      } else {
        this.logWarn('Fichier baseline non trouvé', { path: this.baselinePath });
      }

      return baseline;
    } catch (error) {
      this.logError('Erreur lors du chargement de la baseline', error);
      throw error;
    }
  }

  /**
   * Lit le fichier baseline de configuration (format BaselineFileConfig)
   */
  public async readBaselineFile(): Promise<BaselineFileConfig | null> {
    try {
      const baselineFile = await this.baselineLoader.readBaselineFile(this.baselinePath);
      
      if (baselineFile) {
        this.logInfo('Fichier baseline lu avec succès', {
          machineId: baselineFile.machineId,
          version: baselineFile.version,
          timestamp: baselineFile.timestamp
        });
      }

      return baselineFile;
    } catch (error) {
      this.logError('Erreur lors de la lecture du fichier baseline', error);
      throw error;
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

      // Charger la baseline depuis le fichier
      const baselineFile = await this.readBaselineFile();

      if (!baselineFile) {
        const debugDetails = {
          targetMachineId,
          baselinePath: this.baselinePath,
          fileExists: existsSync(this.baselinePath),
          workingDirectory: process.cwd(),
          resolvedPath: resolve(this.baselinePath)
        };

        throw new BaselineServiceError(
          `Configuration baseline non disponible: ${JSON.stringify(debugDetails)}`,
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

      // Transformer la baseline pour le DiffDetector
      const transformedBaseline = this.baselineLoader.transformBaselineForDiffDetector(baselineFile);

      // Comparer baseline avec machine cible
      const differences = await this.diffDetector.compareBaselineWithMachine(
        transformedBaseline,
        targetInventory
      );

      const report: BaselineComparisonReport = {
        baselineMachine: baselineFile.machineId,
        targetMachine: targetMachineId,
        baselineVersion: baselineFile.version,
        differences,
        summary: this.differenceDetector.calculateSummary(differences),
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

      const decisions = this.differenceDetector.createSyncDecisions(report, severityThreshold);

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
      throw error;
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

      // Déléguer l'application au ChangeApplier
      const result = await this.changeApplier.applyDecision(decision);

      if (result.success) {
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
      }

      return result;
    } catch (error) {
      this.logError('Erreur lors de l\'application de la décision', error);
      throw error;
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
      this.configValidator.ensureValidBaselineConfig(newBaseline);

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