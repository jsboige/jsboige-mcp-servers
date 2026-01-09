/**
 * Gestionnaire de présence sécurisé pour RooSync
 * 
 * Responsable de la gestion des fichiers de présence avec protection
 * contre l'écrasement d'identités et validation d'unicité.
 * 
 * @module PresenceManager
 * @version 2.0.0
 */

import { promises as fs, existsSync } from 'fs';
import { join } from 'path';
import { RooSyncConfig } from '../../config/roosync-config.js';
import { getFileLockManager, LockOptions } from './FileLockManager.simple.js';

/**
 * Interface pour les données de présence
 */
export interface PresenceData {
  id: string;
  status: 'online' | 'offline' | 'conflict';
  lastSeen: string;
  version: string;
  mode: string;
  source?: string;
  firstSeen?: string;
}

/**
 * Résultat de mise à jour de présence
 */
export interface PresenceUpdateResult {
  success: boolean;
  conflictDetected?: boolean;
  warningMessage?: string;
  existingData?: PresenceData;
}

/**
 * Erreur du gestionnaire de présence
 */
export class PresenceManagerError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(`[PresenceManager] ${message}`);
    this.name = 'PresenceManagerError';
  }
}

/**
 * Gestionnaire de présence avec protection contre l'écrasement
 */
export class PresenceManager {
  constructor(
    private config: RooSyncConfig,
    private lockManager = getFileLockManager()
  ) {}

  /**
   * Obtenir le chemin du fichier de présence pour une machine
   */
  private getPresenceFilePath(machineId: string): string {
    return join(this.config.sharedPath, 'presence', `${machineId}.json`);
  }

  /**
   * Obtenir le répertoire de présence
   */
  private getPresenceDir(): string {
    return join(this.config.sharedPath, 'presence');
  }

  /**
   * S'assurer que le répertoire de présence existe
   */
  private async ensurePresenceDir(): Promise<void> {
    const presenceDir = this.getPresenceDir();
    try {
      await fs.mkdir(presenceDir, { recursive: true });
    } catch (error) {
      throw new PresenceManagerError(
        `Impossible de créer le répertoire de présence: ${presenceDir}`,
        'DIR_CREATION_FAILED'
      );
    }
  }

  /**
   * Lire les données de présence d'une machine
   */
  public async readPresence(machineId: string): Promise<PresenceData | null> {
    try {
      const presenceFile = this.getPresenceFilePath(machineId);
      
      if (!existsSync(presenceFile)) {
        return null;
      }

      const content = await fs.readFile(presenceFile, 'utf-8');
      const data = JSON.parse(content);
      
      return data as PresenceData;
    } catch (error) {
      console.warn(`[PresenceManager] Erreur lecture présence pour ${machineId}:`, error);
      return null;
    }
  }

  /**
   * Mettre à jour les données de présence avec protection contre l'écrasement
   */
  public async updatePresence(
    machineId: string,
    updates: Partial<PresenceData>,
    force: boolean = false
  ): Promise<PresenceUpdateResult> {
    try {
      await this.ensurePresenceDir();
      
      const presenceFile = this.getPresenceFilePath(machineId);
      const now = new Date().toISOString();
      
      // Options de verrouillage avec retries
      const lockOptions: LockOptions = {
        retries: 10,
        minTimeout: 100,
        maxTimeout: 1000,
        stale: 30000
      };
      
      // Utiliser le verrouillage pour la mise à jour
      const result = await this.lockManager.updateJsonWithLock<PresenceData>(
        presenceFile,
        (existingData) => {
          // Vérifier l'incohérence d'identité
          if (existingData && existingData.id !== machineId) {
            const warningMessage = `⚠️ INCOHÉRENCE D'IDENTITÉ: Le fichier ${presenceFile} contient l'ID ${existingData.id} mais on tente de mettre à jour ${machineId}`;
            console.error(`[PresenceManager] ${warningMessage}`);
            throw new PresenceManagerError(warningMessage, 'IDENTITY_MISMATCH');
          }
          
          // Vérifier le conflit de source
          if (existingData && updates.source && existingData.source && updates.source !== existingData.source && !force) {
            const warningMessage = `⚠️ CONFLIT DE SOURCE: MachineId ${machineId} déjà utilisé par la source ${existingData.source}. Tentative de mise à jour depuis ${updates.source}`;
            console.error(`[PresenceManager] ${warningMessage}`);
            throw new PresenceManagerError(warningMessage, 'SOURCE_CONFLICT');
          }
          
          // Créer ou mettre à jour les données de présence
          const presenceData: PresenceData = {
            ...existingData,
            ...updates,
            id: machineId,
            status: updates.status || existingData?.status || 'online',
            lastSeen: now,
            version: updates.version || existingData?.version || '1.0.0',
            mode: updates.mode || existingData?.mode || 'code',
            firstSeen: existingData?.firstSeen || now
          };
          
          return presenceData;
        },
        lockOptions
      );
      
      if (!result.success) {
        return {
          success: false,
          warningMessage: result.error?.message || 'Erreur inconnue lors de la mise à jour de présence'
        };
      }
      
      console.log(`[PresenceManager] Présence mise à jour pour ${machineId} (source: ${updates.source || 'inconnue'})`);
      
      return {
        success: true,
        conflictDetected: false
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[PresenceManager] Erreur mise à jour présence pour ${machineId}:`, errorMessage);
      
      return {
        success: false,
        warningMessage: `Erreur mise à jour présence: ${errorMessage}`
      };
    }
  }

  /**
   * Mettre à jour la présence de la machine courante
   */
  public async updateCurrentPresence(
    status: 'online' | 'offline' | 'conflict' = 'online',
    mode: string = 'code'
  ): Promise<PresenceUpdateResult> {
    return this.updatePresence(
      this.config.machineId,
      {
        status,
        mode,
        source: 'service'
      }
    );
  }

  /**
   * Supprimer un fichier de présence
   */
  public async removePresence(machineId: string): Promise<boolean> {
    try {
      const presenceFile = this.getPresenceFilePath(machineId);
      
      if (existsSync(presenceFile)) {
        // Utiliser le verrouillage pour la suppression
        const result = await this.lockManager.withLock<void>(
          presenceFile,
          async () => {
            await fs.unlink(presenceFile);
            console.log(`[PresenceManager] Fichier de présence supprimé pour ${machineId}`);
          }
        );
        
        return result.success;
      }
      
      return false;
    } catch (error) {
      console.error(`[PresenceManager] Erreur suppression présence pour ${machineId}:`, error);
      return false;
    }
  }

  /**
   * Lister toutes les machines présentes
   */
  public async listAllPresence(): Promise<PresenceData[]> {
    try {
      await this.ensurePresenceDir();
      
      const presenceDir = this.getPresenceDir();
      const files = await fs.readdir(presenceDir);
      
      const presenceFiles = files.filter(file => file.endsWith('.json'));
      const allPresence: PresenceData[] = [];
      
      for (const file of presenceFiles) {
        try {
          const machineId = file.replace('.json', '');
          const presence = await this.readPresence(machineId);
          if (presence) {
            allPresence.push(presence);
          }
        } catch (error) {
          console.warn(`[PresenceManager] Erreur lecture fichier ${file}:`, error);
        }
      }
      
      return allPresence;
    } catch (error) {
      console.error('[PresenceManager] Erreur listing présence:', error);
      return [];
    }
  }

  /**
   * Valider l'unicité des machineIds dans les fichiers de présence
   */
  public async validatePresenceUniqueness(): Promise<{
    isValid: boolean;
    conflicts: Array<{
      machineId: string;
      duplicateFiles: string[];
      warningMessage: string;
    }>;
  }> {
    try {
      const allPresence = await this.listAllPresence();
      const machineIdMap = new Map<string, string[]>();
      
      // Grouper les fichiers par machineId
      for (const presence of allPresence) {
        const files = machineIdMap.get(presence.id) || [];
        files.push(`${presence.id}.json`);
        machineIdMap.set(presence.id, files);
      }
      
      // Détecter les conflits
      const conflicts: Array<{
        machineId: string;
        duplicateFiles: string[];
        warningMessage: string;
      }> = [];
      
      for (const [machineId, files] of machineIdMap) {
        if (files.length > 1) {
          const warningMessage = `⚠️ CONFLIT DE PRÉSENCE: MachineId ${machineId} trouvé dans ${files.length} fichiers: ${files.join(', ')}`;
          console.error(`[PresenceManager] ${warningMessage}`);
          
          conflicts.push({
            machineId,
            duplicateFiles: files,
            warningMessage
          });
        }
      }
      
      return {
        isValid: conflicts.length === 0,
        conflicts
      };
      
    } catch (error) {
      console.error('[PresenceManager] Erreur validation unicité présence:', error);
      return {
        isValid: false,
        conflicts: []
      };
    }
  }
}
