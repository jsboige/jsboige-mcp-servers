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
      console.log(`[DEBUG] ${new Date().toISOString()} - InventoryCollectorWrapper.collectInventory() DÉBUT pour ${machineId}, forceRefresh=${forceRefresh}`);
      
      // D'abord essayer l'InventoryCollector existant (pour machine locale)
      try {
        const inventory = await this.inventoryCollector.collectInventory(machineId, forceRefresh);
        if (inventory) {
          console.log(`[DEBUG] Inventaire local trouvé pour ${machineId}`);
          return this.convertToBaselineFormat(inventory);
        }
      } catch (localError) {
        console.log(`[DEBUG] Échec collecte locale pour ${machineId}: ${localError instanceof Error ? localError.message : String(localError)}`);
      }
      
      // Si pas d'inventaire local ou erreur, essayer de charger depuis le shared state
      console.log(`[DEBUG] Tentative depuis shared state pour ${machineId}`);
      console.log(`[DEBUG] Appel de loadFromSharedState pour ${machineId}`);
      
      let sharedStateInventory;
      try {
        console.log(`[DEBUG] Juste avant l'appel à loadFromSharedState pour ${machineId}`);
        sharedStateInventory = await this.loadFromSharedState(machineId);
        console.log(`[DEBUG] loadFromSharedState retourné:`, sharedStateInventory ? 'SUCCESS' : 'NULL');
        
        if (sharedStateInventory) {
          console.log(`[DEBUG] Inventaire shared state trouvé pour ${machineId}`);
          return sharedStateInventory;
        }
      } catch (loadError) {
        console.error(`[DEBUG] Erreur lors de loadFromSharedState pour ${machineId}:`, loadError);
        console.error(`[DEBUG] Stack trace:`, loadError instanceof Error ? loadError.stack : 'No stack trace');
      }

      console.log(`[DEBUG] Aucun inventaire trouvé pour ${machineId}`);
      throw new Error(`Échec collecte inventaire pour ${machineId}`);
    } catch (error) {
      console.error('Erreur lors de la collecte de l\'inventaire:', error);
      throw error; // CORRECTION SDDD : Propager l'erreur pour un meilleur diagnostic
    }
  }

  /**
   * CORRECTION SDDD : Charge l'inventaire depuis le shared state pour les machines distantes
   */
  private async loadFromSharedState(machineId: string): Promise<BaselineMachineInventory | null> {
    try {
      // CORRECTION SDDD : Utiliser la variable d'environnement ROOSYNC_SHARED_PATH
      const baseSharedPath = process.env.ROOSYNC_SHARED_PATH || 'g:/Mon Drive/Synchronisation/RooSync/.shared-state';
      const sharedStatePath = join(baseSharedPath, 'inventories');
      
      console.log('[DEBUG] ROOSYNC_SHARED_PATH:', process.env.ROOSYNC_SHARED_PATH);
      console.log('[DEBUG] baseSharedPath:', baseSharedPath);
      
      // Chercher les fichiers d'inventaire pour cette machine
      console.log(`[DEBUG] ${new Date().toISOString()} - Lecture du répertoire: ${sharedStatePath}`);
      
      let inventoryFiles;
      try {
        inventoryFiles = await fs.readdir(sharedStatePath);
        console.log(`[DEBUG] Répertoire lu avec succès: ${inventoryFiles.length} fichiers trouvés`);
      } catch (readdirError) {
        console.log(`[DEBUG] Erreur lecture répertoire ${sharedStatePath}: ${readdirError instanceof Error ? readdirError.message : String(readdirError)}`);
        return null;
      }
      console.log(`[DEBUG] ${new Date().toISOString()} - Fichiers trouvés: ${JSON.stringify(inventoryFiles)}`);
      
      // CORRECTION SDDD : Améliorer la recherche pour inclure les fichiers -fixed
      const machineFiles = inventoryFiles.filter(file =>
        file.startsWith(machineId) && file.endsWith('.json')
      );
      
      console.log(`[DEBUG] Fichiers pour ${machineId}: ${JSON.stringify(machineFiles)}`);
      console.log(`[DEBUG] Vérification nombre de fichiers pour ${machineId}: ${machineFiles.length}`);
      
      if (machineFiles.length === 0) {
        console.log(`[DEBUG] Aucun fichier d'inventaire trouvé pour ${machineId} dans ${sharedStatePath}`);
        return null;
      }

      console.log(`[DEBUG] Fichiers trouvés pour ${machineId}: ${machineFiles.length} fichiers - Poursuite du traitement`);

      // CORRECTION SDDD : Logique de tri améliorée avec priorité aux fichiers -fixed
      console.log(`[DEBUG] Début tri des fichiers pour ${machineId}`);
      let latestFile;
      try {
        console.log(`[DEBUG] Avant tri: machineFiles = ${JSON.stringify(machineFiles)}`);
        
        // Donner la priorité aux fichiers -fixed
        const fixedFiles = machineFiles.filter(file => file.includes('-fixed'));
        const normalFiles = machineFiles.filter(file => !file.includes('-fixed'));
        
        console.log(`[DEBUG] Fichiers -fixed: ${JSON.stringify(fixedFiles)}`);
        console.log(`[DEBUG] Fichiers normaux: ${JSON.stringify(normalFiles)}`);
        
        // Trier chaque groupe par timestamp extrait du nom de fichier
        const sortedFixed = fixedFiles.sort((a, b) => this.compareFileTimestamps(a, b));
        const sortedNormal = normalFiles.sort((a, b) => this.compareFileTimestamps(a, b));
        
        // Prendre le fichier -fixed le plus récent, sinon le fichier normal le plus récent
        const allSorted = [...sortedFixed, ...sortedNormal];
        console.log(`[DEBUG] Fichiers triés avec priorité -fixed: ${JSON.stringify(allSorted)}`);
        
        latestFile = allSorted[0]; // Prendre le premier (le plus récent avec priorité -fixed)
        console.log(`[DEBUG] Fichier sélectionné: ${latestFile}`);
        
        if (!latestFile) {
          console.log(`[DEBUG] ERREUR: latestFile est null après le tri`);
          return null;
        }
      } catch (sortError) {
        console.error(`[DEBUG] Erreur lors du tri des fichiers:`, sortError);
        console.error(`[DEBUG] Stack trace du tri:`, sortError instanceof Error ? sortError.stack : 'No stack trace');
        return null;
      }
      
      const inventoryPath = join(sharedStatePath, latestFile);
      
      console.log(`[DEBUG] Chargement de l'inventaire depuis: ${inventoryPath}`);
      
      let content = await fs.readFile(inventoryPath, 'utf-8');
      console.log(`[DEBUG] Contenu lu avec succès, taille: ${content.length} caractères`);
      
      // CORRECTION SDDD : Gérer le BOM UTF-8 qui cause l'erreur de parsing JSON
      if (content.charCodeAt(0) === 0xFEFF) {
        console.log(`[DEBUG] BOM UTF-8 détecté, suppression avant parsing JSON`);
        content = content.slice(1);
      }
      
      const rawInventory = JSON.parse(content);
      console.log(`[DEBUG] JSON parsé avec succès, machineId: ${rawInventory.machineId}`);
      console.log(`[DEBUG] rawInventory complet:`, JSON.stringify(rawInventory, null, 2));

      // Convertir vers le format BaselineMachineInventory
      const result = this.convertRawToBaselineFormat(rawInventory);
      console.log(`[DEBUG] Conversion réussie, retour de l'inventaire pour ${machineId}`);
      console.log(`[DEBUG] résultat converti:`, JSON.stringify(result, null, 2));
      return result;
    } catch (error) {
      console.error(`[DEBUG] Erreur lors du chargement depuis shared state pour ${machineId}:`, error);
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
      console.log(`[DEBUG] Timestamp extrait de ${filename}: ${timestampStr}`);
      return new Date(timestampStr);
    }
    
    // Fallback : utiliser la date de modification du fichier
    console.log(`[DEBUG] Pas de timestamp trouvé dans ${filename}, utilisation de fallback`);
    return new Date(0); // Date la plus ancienne possible
  }
}