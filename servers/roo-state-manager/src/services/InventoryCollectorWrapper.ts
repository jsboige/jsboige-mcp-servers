/**
 * InventoryCollectorWrapper - Wrapper pour l'InventoryCollector existant
 * 
 * Ce wrapper adapte l'InventoryCollector existant pour qu'il implémente
 * l'interface IInventoryCollector requise par le BaselineService.
 * 
 * @module InventoryCollectorWrapper
 * @version 2.1.0
 */

import { InventoryCollector, MachineInventory } from './InventoryCollector.js';
import { IInventoryCollector, MachineInventory as BaselineMachineInventory } from '../types/baseline.js';
import { promises as fs } from 'fs';
import { join } from 'path';
import { existsSync } from 'fs';
import { getSharedStatePath } from '../utils/server-helpers.js';
import { createLogger } from '../utils/logger.js';
import { InventoryCollectorError, InventoryCollectorErrorCode } from '../types/errors.js';

const logger = createLogger('InventoryCollectorWrapper');

/**
 * Wrapper implémentant IInventoryCollector
 */
export class InventoryCollectorWrapper implements IInventoryCollector {
  
  constructor(private inventoryCollector: InventoryCollector) {
    // Le wrapper utilise l'instance existante d'InventoryCollector
  }

  /**
   * Collecte l'inventaire d'une machine
   */
  public async collectInventory(
    machineId: string,
    forceRefresh = false
  ): Promise<BaselineMachineInventory | null> {
    try {
      // CORRECTION SDDD : Gérer les machines distantes via shared state
      logger.debug(`InventoryCollectorWrapper.collectInventory() DÉBUT pour ${machineId}, forceRefresh=${forceRefresh}`);
      
      // D'abord essayer l'InventoryCollector existant (pour machine locale)
      try {
        const inventory = await this.inventoryCollector.collectInventory(machineId, forceRefresh);
        if (inventory) {
          logger.debug(`Inventaire local trouvé pour ${machineId}`);
          return this.convertToBaselineFormat(inventory);
        }
      } catch (localError) {
        logger.debug(`Échec collecte locale pour ${machineId}: ${localError instanceof Error ? localError.message : String(localError)}`);
      }
      
      // Si pas d'inventaire local ou erreur, essayer de charger depuis le shared state
      logger.debug(`Tentative depuis shared state pour ${machineId}`);
      logger.debug(`Appel de loadFromSharedState pour ${machineId}`);
      
      let sharedStateInventory;
      try {
        logger.debug(`Juste avant l'appel à loadFromSharedState pour ${machineId}`);
        sharedStateInventory = await this.loadFromSharedState(machineId);
        logger.debug(`loadFromSharedState retourné: ${sharedStateInventory ? 'SUCCESS' : 'NULL'}`);
        
        if (sharedStateInventory) {
          logger.debug(`Inventaire shared state trouvé pour ${machineId}`);
          return sharedStateInventory;
        }
      } catch (loadError) {
        logger.error(`Erreur lors de loadFromSharedState pour ${machineId}`, loadError);
      }

      logger.debug(`Aucun inventaire trouvé pour ${machineId}`);
      throw new InventoryCollectorError(
        `Échec collecte inventaire pour ${machineId}`,
        InventoryCollectorErrorCode.SCRIPT_EXECUTION_FAILED,
        { machineId, sources: ['local', 'sharedState'] }
      );
    } catch (error) {
      logger.error('Erreur lors de la collecte de l\'inventaire', error);
      throw error; // CORRECTION SDDD : Propager l'erreur pour un meilleur diagnostic
    }
  }

  /**
   * CORRECTION SDDD : Charge l'inventaire depuis le shared state pour les machines distantes
   */
  private async loadFromSharedState(machineId: string): Promise<BaselineMachineInventory | null> {
      try {
        // CORRECTION SDDD : Utiliser la variable d'environnement ROOSYNC_SHARED_PATH via helper centralisé
        const baseSharedPath = getSharedStatePath();
        const sharedStatePath = join(baseSharedPath, 'inventories');

        logger.debug(`ROOSYNC_SHARED_PATH: ${process.env.ROOSYNC_SHARED_PATH}`);
        logger.debug(`baseSharedPath: ${baseSharedPath}`);

        // CORRECTION Bug #322 : D'abord essayer le fichier exact {machineId}.json
        // (format utilisé par InventoryService.loadRemoteInventory)
        const exactFilePath = join(sharedStatePath, `${machineId}.json`);
        if (existsSync(exactFilePath)) {
          logger.info(`📂 Fichier exact trouvé: ${exactFilePath}`);
          try {
            let content = await fs.readFile(exactFilePath, 'utf-8');
            if (content.charCodeAt(0) === 0xFEFF) {
              content = content.slice(1);
            }
            const rawInventory = JSON.parse(content);
            return this.convertRawToBaselineFormat(rawInventory);
          } catch (exactError) {
            logger.debug(`Erreur lecture fichier exact: ${exactError instanceof Error ? exactError.message : String(exactError)}`);
          }
        }

        // Chercher les fichiers d'inventaire pour cette machine (format timestamp)
        logger.debug(`Lecture du répertoire: ${sharedStatePath}`);

        let inventoryFiles;
        try {
          inventoryFiles = await fs.readdir(sharedStatePath);
          logger.debug(`Répertoire lu avec succès: ${inventoryFiles.length} fichiers trouvés`);
        } catch (readdirError) {
          logger.debug(`Erreur lecture répertoire ${sharedStatePath}: ${readdirError instanceof Error ? readdirError.message : String(readdirError)}`);
          return null;
        }
        logger.debug(`Fichiers trouvés: ${JSON.stringify(inventoryFiles)}`);

        // CORRECTION SDDD : Améliorer la recherche pour inclure les fichiers -fixed
        const machineFiles = inventoryFiles.filter(file =>
          file.startsWith(machineId) && file.endsWith('.json') && file !== `${machineId}.json`
        );
        
        logger.debug(`Fichiers pour ${machineId}: ${JSON.stringify(machineFiles)}`);
        logger.debug(`Vérification nombre de fichiers pour ${machineId}: ${machineFiles.length}`);
        
        if (machineFiles.length === 0) {
          logger.debug(`Aucun fichier d'inventaire trouvé pour ${machineId} dans ${sharedStatePath}`);
          return null;
        }
  
        logger.debug(`Fichiers trouvés pour ${machineId}: ${machineFiles.length} fichiers - Poursuite du traitement`);
  
        // CORRECTION SDDD : Logique de tri améliorée avec priorité aux fichiers -fixed
        logger.debug(`Début tri des fichiers pour ${machineId}`);
        let latestFile;
        try {
          logger.debug(`Avant tri: machineFiles = ${JSON.stringify(machineFiles)}`);
          
          // Donner la priorité aux fichiers -fixed
          const fixedFiles = machineFiles.filter(file => file.includes('-fixed'));
          const normalFiles = machineFiles.filter(file => !file.includes('-fixed'));
          
          logger.debug(`Fichiers -fixed: ${JSON.stringify(fixedFiles)}`);
          logger.debug(`Fichiers normaux: ${JSON.stringify(normalFiles)}`);
          
          // Trier chaque groupe par timestamp extrait du nom de fichier
          const sortedFixed = fixedFiles.sort((a, b) => this.compareFileTimestamps(a, b));
          const sortedNormal = normalFiles.sort((a, b) => this.compareFileTimestamps(a, b));
          
          // Prendre le fichier -fixed le plus récent, sinon le fichier normal le plus récent
          const allSorted = [...sortedFixed, ...sortedNormal];
          logger.debug(`Fichiers triés avec priorité -fixed: ${JSON.stringify(allSorted)}`);
          
          latestFile = allSorted[0]; // Prendre le premier (le plus récent avec priorité -fixed)
          logger.debug(`Fichier sélectionné: ${latestFile}`);
          
          if (!latestFile) {
            logger.debug(`ERREUR: latestFile est null après le tri`);
            return null;
          }
        } catch (sortError) {
          logger.error(`Erreur lors du tri des fichiers`, sortError);
          return null;
        }
        
        const inventoryPath = join(sharedStatePath, latestFile);
        
        logger.debug(`Chargement de l'inventaire depuis: ${inventoryPath}`);
        
        let content = await fs.readFile(inventoryPath, 'utf-8');
        logger.debug(`Contenu lu avec succès, taille: ${content.length} caractères`);
        
        // CORRECTION SDDD : Gérer le BOM UTF-8 qui cause l'erreur de parsing JSON
        if (content.charCodeAt(0) === 0xFEFF) {
          logger.debug(`BOM UTF-8 détecté, suppression avant parsing JSON`);
          content = content.slice(1);
        }
        
        const rawInventory = JSON.parse(content);
        logger.debug(`JSON parsé avec succès, machineId: ${rawInventory.machineId}`);
        logger.debug(`rawInventory complet: ${JSON.stringify(rawInventory, null, 2)}`);
  
        // Convertir vers le format BaselineMachineInventory
        const result = this.convertRawToBaselineFormat(rawInventory);
        logger.debug(`Conversion réussie, retour de l'inventaire pour ${machineId}`);
        logger.debug(`résultat converti: ${JSON.stringify(result, null, 2)}`);
        return result;
      } catch (error) {
        logger.error(`Erreur lors du chargement depuis shared state pour ${machineId}`, error);
        return null;
      }
    }
  /**
   * CORRECTION SDDD : Convertit l'inventaire brut du shared state vers BaselineMachineInventory
   */
  private convertRawToBaselineFormat(rawInventory: any): BaselineMachineInventory {
    return {
      machineId: rawInventory.machineId,
      timestamp: rawInventory.timestamp,
      config: {
        roo: {
          modes: rawInventory.roo?.modes || [],
          mcpSettings: rawInventory.roo?.mcpServers || {}, // CORRECTION SDDD : Accès correct via roo.mcpServers
          userSettings: {}
        },
        hardware: {
          cpu: {
            model: 'Unknown CPU', // Pas de model dans la structure réelle
            cores: rawInventory.hardware?.cpu?.cores || 0,
            threads: rawInventory.hardware?.cpu?.threads || 0
          },
          memory: {
            total: rawInventory.hardware?.memory?.total || 0
          },
          disks: (rawInventory.hardware?.disks || []).map((d: any) => ({
            name: d.drive || 'Unknown',
            size: d.size ? `${Math.round(d.size / 1024 / 1024 / 1024)}GB` : 'Unknown'
          })),
          gpu: rawInventory.hardware?.gpu ?
            (Array.isArray(rawInventory.hardware.gpu) ?
              rawInventory.hardware.gpu.map((g: any) => g.name).join(', ') :
              rawInventory.hardware.gpu.name || 'Unknown') : 'None'
        },
        software: {
          powershell: rawInventory.software?.powershell || 'Unknown',
          node: rawInventory.software?.node || 'N/A',
          python: rawInventory.software?.python || 'N/A'
        },
        system: {
          os: rawInventory.system?.os || 'Unknown',
          architecture: rawInventory.system?.architecture || 'Unknown'
        }
      },
      metadata: {
        collectionDuration: 0,
        source: 'remote' as any, // CORRECTION SDDD : forcer le type pour compatibilité
        collectorVersion: '2.1.0'
      }
    };
  }

  /**
   * Convertit l'inventaire existant vers le format BaselineMachineInventory
   */
  private convertToBaselineFormat(
    inventory: MachineInventory
  ): BaselineMachineInventory {
    return {
      machineId: inventory.machineId,
      timestamp: inventory.timestamp,
      config: {
        roo: {
          modes: [], // À extraire depuis les données réelles
          mcpSettings: {},
          userSettings: {}
        },
        hardware: {
          cpu: {
            model: 'Unknown CPU', // Pas de model dans la structure réelle
            cores: inventory.hardware.cpu?.cores || 0,
            threads: inventory.hardware.cpu?.threads || 0
          },
          memory: {
            total: inventory.hardware.memory?.total || 0
          },
          disks: (inventory.hardware.disks || []).map(d => ({
            name: d.drive || 'Unknown',
            size: `${Math.round((d.size || 0) / 1024 / 1024 / 1024)}GB`
          })),
          gpu: (inventory.hardware.gpu || []).map(g => g.name).join(', ') || 'None'
        },
        software: {
          powershell: inventory.software.powershell || 'Unknown',
          node: inventory.software.node || 'N/A',
          python: inventory.software.python || 'N/A'
        },
        system: {
          os: inventory.system.os || 'Unknown',
          architecture: inventory.system.architecture || 'Unknown'
        }
      },
      metadata: {
        collectionDuration: 0, // À calculer
        source: 'local',
        collectorVersion: '1.0.0'
      }
    };
  }

  /**
   * CORRECTION SDDD : Compare deux fichiers d'inventaire par timestamp
   */
  private compareFileTimestamps(a: string, b: string): number {
    const aTimestamp = this.extractTimestampFromFilename(a);
    const bTimestamp = this.extractTimestampFromFilename(b);
    
    // Tri par ordre décroissant (plus récent d'abord)
    return bTimestamp.getTime() - aTimestamp.getTime();
  }

  /**
   * CORRECTION SDDD : Extrait le timestamp ISO d'un nom de fichier d'inventaire
   */
  private extractTimestampFromFilename(filename: string): Date {
    // Patterns possibles :
    // - myia-po-2024-2025-10-18T11-36-21-070Z-fixed.json
    // - myia-po-2024-2025-10-17T14-20-00-000Z.json
    // - myia-po-2024-fixed-2025-10-17.json
    
    const isoPattern = /(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)/;
    const match = filename.match(isoPattern);
    
    if (match) {
      const timestampStr = match[1];
      logger.debug(`Timestamp extrait de ${filename}: ${timestampStr}`);
      return new Date(timestampStr);
    }
    
    // Fallback : utiliser la date de modification du fichier
    logger.debug(`Pas de timestamp trouvé dans ${filename}, utilisation de fallback`);
    return new Date(0); // Date la plus ancienne possible
  }
}