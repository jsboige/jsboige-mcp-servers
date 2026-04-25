/**
 * Gestionnaire de verrouillage de fichiers pour RooSync
 * 
 * Responsable de la gestion des verrous sur les fichiers pour prévenir
 * les problèmes de concurrence lors des écritures simultanées.
 * 
 * @module FileLockManager
 * @version 1.0.0
 */

import lockfile from 'proper-lockfile';
import { promises as fs } from 'fs';
import * as fsSync from 'fs';
import { join, dirname } from 'path';

/** Maximum number of backup files to keep (.bak-1, .bak-2, .bak-3) */
const MAX_BACKUPS = 3;

/**
 * Options de verrouillage
 */
export interface LockOptions {
  /**
   * Nombre de tentatives avant d'abandonner
   */
  retries?: number;
  
  /**
   * Délai minimum entre les tentatives (ms)
   */
  minTimeout?: number;
  
  /**
   * Délai maximum entre les tentatives (ms)
   */
  maxTimeout?: number;
  
  /**
   * Délai d'expiration du verrou (ms)
   */
  stale?: number;
}

/**
 * Options par défaut pour le verrouillage
 */
const DEFAULT_LOCK_OPTIONS: LockOptions = {
  retries: 3,
  minTimeout: 50,
  maxTimeout: 200,
  stale: 30000 // 30 secondes
};

/**
 * Erreur du gestionnaire de verrouillage
 */
export class FileLockManagerError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(`[FileLockManager] ${message}`);
    this.name = 'FileLockManagerError';
  }
}

/**
 * Résultat d'une opération avec verrou
 */
export interface LockOperationResult<T> {
  success: boolean;
  data?: T;
  error?: Error;
}

/**
 * Gestionnaire de verrouillage de fichiers
 */
export class FileLockManager {
  private locks: Map<string, () => Promise<void>> = new Map();
  
  /**
   * Acquérir un verrou sur un fichier
   */
  async acquireLock(filePath: string, options: LockOptions = {}): Promise<() => Promise<void>> {
    const lockOptions = { ...DEFAULT_LOCK_OPTIONS, ...options };
    
    try {
      // S'assurer que le répertoire parent existe
      const parentDir = dirname(filePath);
      await fs.mkdir(parentDir, { recursive: true });
      
      // S'assurer que le fichier cible existe (proper-lockfile a besoin d'un fichier)
      try {
        await fs.access(filePath);
      } catch {
        // Le fichier n'existe pas, le créer avec un contenu vide
        await fs.writeFile(filePath, '{}');
        // Petit délai pour s'assurer que le fichier est bien créé sur le système de fichiers
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      
      // Utiliser fs explicitement pour éviter les problèmes sur Windows
      const release = await lockfile.lock(filePath, {
        ...lockOptions,
        realpath: false,
        fs: fsSync
      });
      
      // Stocker la fonction de release
      this.locks.set(filePath, release);
      
      console.log(`[FileLockManager] Verrou acquis sur: ${filePath}`);
      return release;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new FileLockManagerError(
        `Impossible d'acquérir le verrou sur ${filePath}: ${errorMessage}`,
        'LOCK_ACQUISITION_FAILED'
      );
    }
  }
  
  /**
   * Libérer un verrou sur un fichier
   */
  async releaseLock(filePath: string): Promise<void> {
    const release = this.locks.get(filePath);
    
    if (release) {
      try {
        await release();
        this.locks.delete(filePath);
        console.log(`[FileLockManager] Verrou libéré sur: ${filePath}`);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.warn(`[FileLockManager] Erreur lors de la libération du verrou sur ${filePath}: ${errorMessage}`);
      }
    }
  }
  
  /**
   * Exécuter une opération avec verrouillage automatique
   */
  async withLock<T>(
    filePath: string,
    operation: () => Promise<T>,
    options: LockOptions = {}
  ): Promise<LockOperationResult<T>> {
    let release: (() => Promise<void>) | null = null;
    
    try {
      // Acquérir le verrou
      release = await this.acquireLock(filePath, options);
      
      // Exécuter l'opération
      const data = await operation();
      
      return {
        success: true,
        data
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[FileLockManager] Erreur lors de l'opération sur ${filePath}: ${errorMessage}`);
      
      return {
        success: false,
        error: error instanceof Error ? error : new Error(errorMessage)
      };
    } finally {
      // Libérer le verrou
      if (release) {
        await release();
      }
    }
  }
  
  /**
   /**
    * Écrire un fichier avec verrouillage atomique
    */
   async writeWithLock(
     filePath: string,
     content: string,
     options: LockOptions = {}
   ): Promise<LockOperationResult<void>> {
     return this.withLock<void>(filePath, async () => {
       // Écrire le fichier
       await fs.writeFile(filePath, content, 'utf-8');
       
       console.log(`[FileLockManager] Fichier écrit avec succès: ${filePath}`);
     }, options);
   }
  /**
   * Lire un fichier avec verrouillage
   */
  async readWithLock<T>(
    filePath: string,
    options: LockOptions = {}
  ): Promise<LockOperationResult<string>> {
    return this.withLock<string>(filePath, async () => {
      // Lire le fichier
      const content = await fs.readFile(filePath, 'utf-8');
      
      console.log(`[FileLockManager] Fichier lu avec succès: ${filePath}`);
      return content;
    }, options);
  }
  
  /**
   * Mettre à jour un fichier JSON avec verrouillage
   */
  async updateJsonWithLock<T>(
    filePath: string,
    updateFn: (data: T | undefined) => T,
    options: LockOptions = {}
  ): Promise<LockOperationResult<T>> {
    return this.withLock<T>(filePath, async () => {
      const data = await this.readJsonWithFallback<T>(filePath);

      // Appliquer la mise à jour
      const updatedData = updateFn(data);

      // Rotation des backups avant écriture
      await this.rotateBackups(filePath);

      // Écrire le fichier mis à jour
      await fs.writeFile(filePath, JSON.stringify(updatedData, null, 2), 'utf-8');

      console.log(`[FileLockManager] Fichier JSON mis à jour avec succès: ${filePath}`);
      return updatedData;
    }, options);
  }
  
  /**
   * Rotate backup files before a write (.bak-3 <- .bak-2 <- .bak-1 <- current)
   */
  private async rotateBackups(filePath: string): Promise<void> {
    // Delete oldest backup if it exists
    const oldestBackup = `${filePath}.bak-${MAX_BACKUPS}`;
    try {
      await fs.unlink(oldestBackup);
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        console.warn(`[FileLockManager] Failed to remove old backup ${oldestBackup}: ${error.message}`);
      }
    }

    // Shift backups: .bak-(N-1) -> .bak-N, ..., .bak-1 -> .bak-2
    for (let i = MAX_BACKUPS - 1; i >= 1; i--) {
      const src = `${filePath}.bak-${i}`;
      const dest = `${filePath}.bak-${i + 1}`;
      try {
        await fs.rename(src, dest);
      } catch (error: any) {
        if (error.code !== 'ENOENT') {
          console.warn(`[FileLockManager] Failed to rotate backup ${src} -> ${dest}: ${error.message}`);
        }
      }
    }

    // Copy current file to .bak-1
    try {
      await fs.copyFile(filePath, `${filePath}.bak-1`);
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        console.warn(`[FileLockManager] Failed to create backup of ${filePath}: ${error.message}`);
      }
    }
  }

  /**
   * Try to read and parse a JSON file, falling back to backup files on failure
   */
  private async readJsonWithFallback<T>(filePath: string): Promise<T | undefined> {
    // Try the main file first
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(content) as T;
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return undefined;
      }
      // Corrupt/empty — log and try backups
      console.warn(`[FileLockManager] Corrupt JSON in ${filePath}: ${error.message}, trying backups`);
    }

    // Try backups in order: .bak-1, .bak-2, .bak-3
    for (let i = 1; i <= MAX_BACKUPS; i++) {
      const backupPath = `${filePath}.bak-${i}`;
      try {
        const content = await fs.readFile(backupPath, 'utf-8');
        const data = JSON.parse(content) as T;
        console.warn(`[FileLockManager] Recovered data from backup ${backupPath}`);
        return data;
      } catch {
        // Continue to next backup
      }
    }

    console.warn(`[FileLockManager] No valid data found in ${filePath} or any backup`);
    return undefined;
  }

  /**
   * Nettoyer tous les verrous (en cas d'arrêt d'urgence)
   */
  async cleanupAllLocks(): Promise<void> {
    console.log(`[FileLockManager] Nettoyage de ${this.locks.size} verrous...`);
    
    const releasePromises = Array.from(this.locks.entries()).map(
      async ([filePath, release]) => {
        try {
          await release();
          console.log(`[FileLockManager] Verrou nettoyé: ${filePath}`);
        } catch (error) {
          console.warn(`[FileLockManager] Erreur lors du nettoyage du verrou ${filePath}:`, error);
        }
      }
    );
    
    await Promise.all(releasePromises);
    this.locks.clear();
  }
  
  /**
   * Vérifier si un fichier est verrouillé
   */
  async isLocked(filePath: string): Promise<boolean> {
    try {
      const lockStatus = await lockfile.check(filePath);
      return lockStatus !== null;
    } catch (error) {
      console.warn(`[FileLockManager] Erreur lors de la vérification du verrou sur ${filePath}:`, error);
      return false;
    }
  }
  
  /**
   * Forcer la libération d'un verrou (en cas de verrou orphelin)
   */
  async forceRelease(filePath: string): Promise<void> {
    try {
      await lockfile.unlock(filePath);
      this.locks.delete(filePath);
      console.log(`[FileLockManager] Verrou forcé libéré: ${filePath}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new FileLockManagerError(
        `Impossible de forcer la libération du verrou sur ${filePath}: ${errorMessage}`,
        'FORCE_RELEASE_FAILED'
      );
    }
  }
}

/**
 * Instance singleton du gestionnaire de verrouillage
 */
let fileLockManagerInstance: FileLockManager | null = null;

/**
 * Obtenir l'instance singleton du gestionnaire de verrouillage
 */
export function getFileLockManager(): FileLockManager {
  if (!fileLockManagerInstance) {
    fileLockManagerInstance = new FileLockManager();
  }
  return fileLockManagerInstance;
}
