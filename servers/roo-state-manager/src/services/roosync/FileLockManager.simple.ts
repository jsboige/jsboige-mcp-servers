/**
 * FileLockManager - Implémentation simple de verrouillage de fichiers
 *
 * Cette implémentation utilise un système de verrouillage basé sur des fichiers .lock
 * qui fonctionne avec le mock fs existant dans les tests.
 *
 * @module FileLockManager.simple
 * @version 2.0.0
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { StateManagerError } from '../../types/errors.js';

/**
 * Options de verrouillage
 */
export interface LockOptions {
  /** Nombre de tentatives d'acquisition du verrou */
  retries?: number;
  /** Délai minimum entre les tentatives (ms) */
  minTimeout?: number;
  /** Délai maximum entre les tentatives (ms) */
  maxTimeout?: number;
  /** Durée de validité du verrou (ms) */
  stale?: number;
}

/**
 * Résultat d'une opération avec verrou
 */
export interface LockOperationResult<T = any> {
  /** Succès de l'opération */
  success: boolean;
  /** Données retournées par l'opération */
  data?: T;
  /** Erreur survenue */
  error?: Error;
}

/**
 * Gestionnaire de verrouillage de fichiers
 *
 * Utilise des fichiers .lock pour prévenir les accès concurrents.
 */
export class FileLockManager {
  private static instance: FileLockManager;
  private locks: Map<string, NodeJS.Timeout> = new Map();
  private defaultOptions: LockOptions = {
    retries: 10,
    minTimeout: 100,
    maxTimeout: 500,
    stale: 10000
  };

  private constructor() {
    // Constructeur privé pour le singleton
  }

  /**
   * Obtenir l'instance singleton
   */
  static getInstance(): FileLockManager {
    if (!FileLockManager.instance) {
      FileLockManager.instance = new FileLockManager();
    }
    return FileLockManager.instance;
  }

  /**
   * Acquérir un verrou sur un fichier
   *
   * @param filePath - Chemin du fichier à verrouiller
   * @param options - Options de verrouillage
   * @returns Fonction de libération du verrou
   */
  async acquireLock(filePath: string, options?: LockOptions): Promise<() => Promise<void>> {
    const lockFilePath = this.getLockFilePath(filePath);
    const opts = { ...this.defaultOptions, ...options };

    // Attendre que le verrou soit disponible
    for (let attempt = 0; attempt < opts.retries!; attempt++) {
      try {
        // Créer le fichier de verrou
        await fs.writeFile(lockFilePath, JSON.stringify({
          pid: process.pid,
          timestamp: Date.now()
        }), { flag: 'wx' }); // 'wx' = échoue si le fichier existe

        // Verrou acquis avec succès
        return async () => {
          await this.releaseLock(filePath);
        };
      } catch (error: any) {
        if (error.code === 'EEXIST') {
          // Le verrou existe déjà, vérifier s'il est stale
          try {
            const lockContent = await fs.readFile(lockFilePath, 'utf-8');
            const lockData = JSON.parse(lockContent);
            const age = Date.now() - lockData.timestamp;

            if (age > opts.stale!) {
              // Le verrou est stale, le supprimer
              await fs.unlink(lockFilePath);
              continue; // Réessayer
            }
          } catch {
            // Impossible de lire le verrou, le supprimer
            try {
              await fs.unlink(lockFilePath);
            } catch {
              // Ignorer
            }
            continue; // Réessayer
          }

          // Attendre avant de réessayer
          const delay = opts.minTimeout! + Math.random() * (opts.maxTimeout! - opts.minTimeout!);
          await new Promise(resolve => setTimeout(resolve, delay));
        } else {
          // Autre erreur, propager
          throw error;
        }
      }
    }

    throw new StateManagerError(
      `Impossible d'acquérir le verrou sur ${filePath} après ${opts.retries} tentatives`,
      'LOCK_ACQUISITION_FAILED',
      'FileLockManager',
      { filePath, retries: opts.retries }
    );
  }

  /**
   * Libérer un verrou
   *
   * @param filePath - Chemin du fichier verrouillé
   */
  async releaseLock(filePath: string): Promise<void> {
    const lockFilePath = this.getLockFilePath(filePath);

    try {
      await fs.unlink(lockFilePath);
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        // Ignorer si le fichier n'existe pas déjà
        throw error;
      }
    }
  }

  /**
   * Vérifier si un fichier est verrouillé
   *
   * @param filePath - Chemin du fichier à vérifier
   * @returns true si le fichier est verrouillé
   */
  async isLocked(filePath: string): Promise<boolean> {
    const lockFilePath = this.getLockFilePath(filePath);

    try {
      await fs.access(lockFilePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Exécuter une opération avec verrou
   *
   * @param filePath - Chemin du fichier
   * @param operation - Opération à exécuter
   * @param options - Options de verrouillage
   * @returns Résultat de l'opération
   */
  async withLock<T>(
    filePath: string,
    operation: () => Promise<T>,
    options?: LockOptions
  ): Promise<LockOperationResult<T>> {
    const release = await this.acquireLock(filePath, options);

    try {
      const data = await operation();
      return { success: true, data };
    } catch (error: any) {
      return { success: false, error };
    } finally {
      await release();
    }
  }

  /**
   * Lire un fichier avec verrou
   *
   * @param filePath - Chemin du fichier
   * @returns Contenu du fichier
   */
  async readWithLock(filePath: string): Promise<LockOperationResult<string>> {
    return this.withLock(filePath, async () => {
      return await fs.readFile(filePath, 'utf-8');
    });
  }

  /**
   * Écrire dans un fichier avec verrou
   *
   * @param filePath - Chemin du fichier
   * @param data - Données à écrire
   * @returns Résultat de l'opération
   */
  async writeWithLock(filePath: string, data: string): Promise<LockOperationResult<void>> {
    return this.withLock(filePath, async () => {
      await fs.writeFile(filePath, data, 'utf-8');
    });
  }

  /**
   * Mettre à jour un fichier JSON avec verrou
   *
   * @param filePath - Chemin du fichier
   * @param updater - Fonction de mise à jour (reçoit undefined si fichier n'existe pas)
   * @param options - Options de verrouillage
   * @returns Résultat de l'opération
   */
  async updateJsonWithLock<T>(
    filePath: string,
    updater: (data: T | undefined) => T,
    options?: LockOptions
  ): Promise<LockOperationResult<T>> {
    return this.withLock(filePath, async () => {
      let data: T | undefined;
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        data = JSON.parse(content) as T;
      } catch (error: any) {
        if (error.code !== 'ENOENT') {
          throw error;
        }
        // Fichier n'existe pas - data reste undefined
      }
      const updated = updater(data);
      await fs.writeFile(filePath, JSON.stringify(updated, null, 2), 'utf-8');
      return updated;
    }, options);
  }

  /**
   * Obtenir le chemin du fichier de verrou
   *
   * @param filePath - Chemin du fichier original
   * @returns Chemin du fichier de verrou
   */
  private getLockFilePath(filePath: string): string {
    return `${filePath}.lock`;
  }
}

/**
 * Obtenir l'instance singleton de FileLockManager
 *
 * @returns Instance de FileLockManager
 */
export function getFileLockManager(): FileLockManager {
  return FileLockManager.getInstance();
}

/**
 * Export par défaut
 */
export default FileLockManager;
