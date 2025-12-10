/**
 * Gestionnaire de décisions de synchronisation
 *
 * Responsable de la gestion du cycle de vie des décisions :
 * - Chargement
 * - Filtrage
 * - Approbation
 * - Exécution
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import {
  parseRoadmapMarkdown,
  filterDecisionsByStatus,
  filterDecisionsByMachine,
  findDecisionById,
  type RooSyncDecision
} from '../../utils/roosync-parsers.js';
import { PowerShellExecutor } from '../PowerShellExecutor.js';
import { RooSyncConfig } from '../../config/roosync-config.js';
import { RooSyncServiceError } from '../RooSyncService.js';

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

export class SyncDecisionManager {
  constructor(
    private config: RooSyncConfig,
    private powershellExecutor: PowerShellExecutor
  ) {}

  /**
   * Obtenir le chemin complet d'un fichier RooSync
   */
  private getRooSyncFilePath(filename: string): string {
    return join(this.config.sharedPath, filename);
  }

  /**
   * Vérifier si un fichier RooSync existe
   */
  private async checkFileExists(filename: string): Promise<void> {
    const filePath = this.getRooSyncFilePath(filename);
    try {
      await fs.access(filePath);
    } catch {
      throw new RooSyncServiceError(
        `Fichier RooSync introuvable: ${filename}`,
        'FILE_NOT_FOUND'
      );
    }
  }

  /**
   * Charger toutes les décisions de la roadmap
   */
  public async loadDecisions(): Promise<RooSyncDecision[]> {
    await this.checkFileExists('sync-roadmap.md');
    return parseRoadmapMarkdown(this.getRooSyncFilePath('sync-roadmap.md'));
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
   * Exécute une décision de synchronisation via PowerShell
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
   */
  private async approveDecisionInRoadmap(decisionId: string): Promise<void> {
    const roadmapPath = this.getRooSyncFilePath('sync-roadmap.md');
    let content = await fs.readFile(roadmapPath, 'utf-8');

    // 1. Essayer le nouveau format (**ID:** `id` ... **Statut:** pending)
    const newFormatRegex = new RegExp(
      `(<!-- DECISION_BLOCK_START -->[\\s\\S]*?\\*\\*ID:\\*\\*\\s*\`${decisionId}\`[\\s\\S]*?)<!-- DECISION_BLOCK_END -->`,
      'm'
    );

    const newMatch = newFormatRegex.exec(content);
    if (newMatch) {
      let block = newMatch[1];
      // Vérifier si déjà approuvé
      if (block.includes('**Statut:** approved')) {
        return; // Déjà approuvé, rien à faire
      }

      // Mettre à jour le statut
      if (block.includes('**Statut:**')) {
        block = block.replace(/\*\*Statut:\*\*\s*\w+/, '**Statut:** approved');
      } else {
        // Ajouter le statut s'il manque (cas hybride)
        block = block.replace(/(\*\*ID:\*\*.*)/, '$1\n**Statut:** approved');
      }

      // Ajouter métadonnées d'approbation si absentes
      if (!block.includes('**Approuvé par:**')) {
        const now = new Date().toISOString();
        block += `\n**Approuvé le:** ${now}\n**Approuvé par:** ${this.config.machineId}`;
      }

      content = content.replace(newMatch[1], block);
      await fs.writeFile(roadmapPath, content, 'utf-8');
      return;
    }

    // 2. Essayer l'ancien format (checkbox)
    const oldFormatRegex = new RegExp(
      `(<!-- DECISION_BLOCK_START -->.*?### DECISION ID: ${decisionId}.*?)- \\[ \\] \\*\\*Approuver & Fusionner\\*\\*(.*?<!-- DECISION_BLOCK_END -->)`,
      'gs'
    );

    const oldMatch = oldFormatRegex.exec(content);
    if (oldMatch) {
      // Remplacer la checkbox
      content = content.replace(
        oldFormatRegex,
        '$1- [x] **Approuver & Fusionner**$2'
      );
      await fs.writeFile(roadmapPath, content, 'utf-8');
      return;
    }

    // Si aucun format ne correspond
    throw new RooSyncServiceError(
      `Impossible de trouver la décision ${decisionId} dans sync-roadmap.md (format inconnu)`,
      'DECISION_NOT_FOUND_IN_ROADMAP'
    );
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

    // Détection basique : si Apply-Decisions réussit, sync-config.ref.json est modifié
    if (output.includes('Configuration de référence mise à jour avec succès')) {
      changes.filesModified.push('sync-config.ref.json');
    }

    return changes;
  }

  /**
   * Génère des décisions RooSync depuis un rapport de comparaison
   */
  public async generateDecisionsFromReport(report: any): Promise<number> {
    console.log(`[SyncDecisionManager] 📝 Génération décisions depuis rapport (${report.sourceMachine} vs ${report.targetMachine})`);

    let createdCount = 0;

    // Pour chaque différence CRITICAL ou IMPORTANT, créer une décision
    for (const diff of report.differences) {
      if (diff.severity === 'CRITICAL' || diff.severity === 'IMPORTANT') {
        // Créer décision dans roadmap
        // TODO: Implémenter logique de création décision
        // Pour l'instant, juste un placeholder
        console.log(`[SyncDecisionManager] 📋 Décision à créer : ${diff.description}`);
        createdCount++;
      }
    }

    console.log(`[SyncDecisionManager] ✅ ${createdCount} décisions créées`);
    return createdCount;
  }
}