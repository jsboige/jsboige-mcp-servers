/**
 * RollbackManager - Gestion du rollback automatique pour les opérations de configuration
 *
 * #537 Phase 2: Restauration automatique des backups en cas d'échec
 *
 * Usage:
 * ```typescript
 * const rollback = new RollbackManager(logger);
 * rollback.track('path/to/config.json', 'path/to/backup.json');
 *
 * try {
 *   // ... opération risquée ...
 * } catch (err) {
 *   await rollback.restoreAll();
 *   throw err;
 * }
 * ```
 */

import { copyFile, unlink, access, readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { basename, dirname } from 'path';
import type { Logger } from '../utils/logger.js';

export interface RollbackEntry {
  originalPath: string;
  backupPath: string;
  timestamp: Date;
  restored?: boolean;
}

export interface RollbackResult {
  success: boolean;
  restoredFiles: string[];
  failedFiles: Array<{ path: string; error: string }>;
  message: string;
}

export class RollbackManager {
  private readonly trackedBackups: Map<string, RollbackEntry> = new Map();
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /**
   * Enregistre un backup à restaurer en cas d'échec
   * @param originalPath - Chemin du fichier original (celui qui sera restauré)
   * @param backupPath - Chemin du fichier de backup
   */
  public track(originalPath: string, backupPath: string): void {
    this.trackedBackups.set(originalPath, {
      originalPath,
      backupPath,
      timestamp: new Date()
    });
    this.logger.debug(`Backup tracké: ${backupPath} → ${originalPath}`);
  }

  /**
   * Crée un backup et l'enregistre automatiquement pour rollback
   * @param filePath - Chemin du fichier à backup
   * @returns Chemin du backup créé
   */
  public async createAndTrack(filePath: string): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = `${filePath}.backup_${timestamp}`;

    if (!existsSync(filePath)) {
      throw new Error(`Impossible de créer un backup: fichier non trouvé ${filePath}`);
    }

    await copyFile(filePath, backupPath);
    this.track(filePath, backupPath);
    this.logger.info(`Backup créé et tracké: ${backupPath}`);

    return backupPath;
  }

  /**
   * Restaure tous les backups trackés en cas d'échec
   * @param cleanupBackups - Supprimer les backups après restauration (défaut: true)
   */
  public async restoreAll(cleanupBackups: boolean = true): Promise<RollbackResult> {
    const restoredFiles: string[] = [];
    const failedFiles: Array<{ path: string; error: string }> = [];

    this.logger.info(`Rollback démarré: ${this.trackedBackups.size} fichiers à restaurer`);

    for (const [originalPath, entry] of this.trackedBackups) {
      if (entry.restored) continue;

      try {
        // Vérifier que le backup existe
        if (!existsSync(entry.backupPath)) {
          throw new Error(`Backup non trouvé: ${entry.backupPath}`);
        }

        // Restaurer le fichier original
        await copyFile(entry.backupPath, originalPath);
        restoredFiles.push(originalPath);
        entry.restored = true;

        this.logger.info(`Restauré: ${originalPath} depuis ${entry.backupPath}`);

        // Optionnel: supprimer le backup
        if (cleanupBackups) {
          try {
            await unlink(entry.backupPath);
            this.logger.debug(`Backup supprimé: ${entry.backupPath}`);
          } catch (cleanupErr: any) {
            this.logger.warn(`Impossible de supprimer le backup ${entry.backupPath}: ${cleanupErr.message}`);
          }
        }
      } catch (err: any) {
        const errorMsg = `Échec restauration ${originalPath}: ${err.message}`;
        this.logger.error(errorMsg);
        failedFiles.push({ path: originalPath, error: err.message });
      }
    }

    const success = failedFiles.length === 0;
    const message = success
      ? `Rollback réussi: ${restoredFiles.length} fichiers restaurés`
      : `Rollback partiel: ${restoredFiles.length} restaurés, ${failedFiles.length} échoués`;

    this.logger.info(message);

    return {
      success,
      restoredFiles,
      failedFiles,
      message
    };
  }

  /**
   * Libère les backups trackés sans les restaurer (opération réussie)
   * @param cleanupBackups - Supprimer les backups (défaut: false, on les garde pour historique)
   */
  public async release(cleanupBackups: boolean = false): Promise<void> {
    if (cleanupBackups) {
      for (const entry of this.trackedBackups.values()) {
        try {
          if (existsSync(entry.backupPath)) {
            await unlink(entry.backupPath);
            this.logger.debug(`Backup supprimé: ${entry.backupPath}`);
          }
        } catch (err: any) {
          this.logger.warn(`Impossible de supprimer ${entry.backupPath}: ${err.message}`);
        }
      }
    }

    this.trackedBackups.clear();
    this.logger.debug('RollbackManager libéré');
  }

  /**
   * Retourne le nombre de backups actuellement trackés
   */
  public get size(): number {
    return this.trackedBackups.size;
  }

  /**
   * Retourne true si des backups sont trackés
   */
  public get hasTrackedBackups(): boolean {
    return this.trackedBackups.size > 0;
  }

  /**
   * Liste les backups trackés (pour debug/affichage)
   */
  public listTracked(): RollbackEntry[] {
    return Array.from(this.trackedBackups.values());
  }

  /**
   * Annule le tracking d'un fichier spécifique
   * @param originalPath - Chemin du fichier original
   */
  public untrack(originalPath: string): boolean {
    return this.trackedBackups.delete(originalPath);
  }
}
