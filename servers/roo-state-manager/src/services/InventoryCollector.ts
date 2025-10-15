/**
 * InventoryCollector - Collecte l'inventaire système via Get-MachineInventory.ps1
 * 
 * Wrapper TypeScript pour orchestrer l'appel au script PowerShell de collecte d'inventaire
 * avec cache TTL pour optimiser les performances.
 * 
 * @module InventoryCollector
 * @version 1.0.0
 */

import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { existsSync } from 'fs';
import { PowerShellExecutor, type PowerShellExecutionResult } from './PowerShellExecutor.js';
import os from 'os';

/**
 * Interface pour l'inventaire d'une machine
 */
export interface MachineInventory {
  machineId: string;
  timestamp: string;
  system: {
    hostname: string;
    os: string;
    architecture: string;
    uptime: number;
  };
  hardware: {
    cpu: { name: string; cores: number; threads: number };
    memory: { total: number; available: number };
    disks: Array<{ drive: string; size: number; free: number }>;
    gpu?: Array<{ name: string; memory: number }>;
  };
  software: {
    powershell: string;
    node?: string;
    python?: string;
  };
  roo: {
    modesPath?: string;
    mcpSettings?: string;
  };
}

/**
 * Interface pour une entrée de cache
 */
interface CachedInventory {
  data: MachineInventory;
  timestamp: number;
}

/**
 * Classe InventoryCollector pour orchestrer la collecte d'inventaire système
 */
export class InventoryCollector {
  private cache: Map<string, CachedInventory>;
  private readonly cacheTTL = 3600000; // 1h en ms (3600 * 1000)
  private readonly workspaceRoot = process.env.ROO_HOME || 'd:/roo-extensions';
  
  /**
   * Constructeur
   * @param executor Instance du PowerShellExecutor
   */
  constructor(private executor: PowerShellExecutor) {
    this.cache = new Map<string, CachedInventory>();
    console.log('[InventoryCollector] Instance créée avec cache TTL de', this.cacheTTL, 'ms');
  }

  /**
   * Collecte l'inventaire d'une machine (avec cache)
   * @param machineId - Identifiant de la machine
   * @param forceRefresh - Forcer la collecte même si cache valide
   * @returns Inventaire structuré ou null en cas d'échec
   */
  async collectInventory(machineId: string, forceRefresh = false): Promise<MachineInventory | null> {
    console.log(`[InventoryCollector] Collecte inventaire pour machine: ${machineId} (forceRefresh: ${forceRefresh})`);
    
    // Vérifier le cache si pas de forceRefresh
    if (!forceRefresh && this.isCacheValid(machineId)) {
      console.log(`[InventoryCollector] Cache valide trouvé pour ${machineId}`);
      return this.cache.get(machineId)!.data;
    }

    try {
      // Chemin relatif du script depuis RooSync/ vers workspace root
      const scriptPathRelative = '../scripts/inventory/Get-MachineInventory.ps1';
      
      // Construire le chemin de sortie temporaire (absolu)
      const outputPath = join(this.workspaceRoot, 'outputs', `machine-inventory-${machineId}.json`);
      
      // Créer le répertoire outputs s'il n'existe pas
      const outputDir = dirname(outputPath);
      if (!existsSync(outputDir)) {
        console.log(`[InventoryCollector] Création du répertoire: ${outputDir}`);
        await fs.mkdir(outputDir, { recursive: true });
      }

      // Exécuter le script PowerShell
      console.log(`[InventoryCollector] Exécution du script: ${scriptPathRelative}`);
      const result: PowerShellExecutionResult = await this.executor.executeScript(
        scriptPathRelative,
        ['-MachineId', machineId, '-OutputPath', outputPath],
        { timeout: 60000 } // 60s timeout pour la collecte complète
      );

      // Vérifier le succès
      if (!result.success) {
        console.error(`[InventoryCollector] Échec de l'exécution PowerShell:`, result.stderr);
        return null;
      }

      console.log(`[InventoryCollector] Script exécuté avec succès en ${result.executionTime}ms`);

      // Parser le fichier JSON généré
      const inventory = await this.parseInventoryJson(outputPath);
      
      if (!inventory) {
        console.error(`[InventoryCollector] Échec du parsing du fichier JSON: ${outputPath}`);
        return null;
      }

      // Mettre à jour le cache
      this.cache.set(machineId, {
        data: inventory,
        timestamp: Date.now()
      });
      console.log(`[InventoryCollector] Cache mis à jour pour ${machineId}`);

      // Sauvegarder dans .shared-state/inventories/
      await this.saveToSharedState(inventory);

      return inventory;

    } catch (error) {
      console.error(`[InventoryCollector] Erreur lors de la collecte:`, error instanceof Error ? error.message : String(error));
      return null; // Graceful degradation
    }
  }

  /**
   * Vérifie si le cache est valide pour une machine
   * @param machineId - Identifiant de la machine
   * @returns true si cache valide et non expiré
   */
  private isCacheValid(machineId: string): boolean {
    const cached = this.cache.get(machineId);
    
    if (!cached) {
      return false;
    }

    const age = Date.now() - cached.timestamp;
    const isValid = age < this.cacheTTL;
    
    if (!isValid) {
      console.log(`[InventoryCollector] Cache expiré pour ${machineId} (âge: ${Math.round(age / 1000)}s)`);
      this.cache.delete(machineId);
    }
    
    return isValid;
  }

  /**
   * Parse le JSON généré par Get-MachineInventory.ps1
   * @param jsonPath - Chemin du fichier JSON
   * @returns Inventaire parsé ou null
   */
  private async parseInventoryJson(jsonPath: string): Promise<MachineInventory | null> {
    try {
      if (!existsSync(jsonPath)) {
        console.error(`[InventoryCollector] Fichier JSON non trouvé: ${jsonPath}`);
        return null;
      }

      const jsonContent = await fs.readFile(jsonPath, 'utf-8');
      const rawInventory = JSON.parse(jsonContent);

      // Le script PS génère un objet avec { machineId, timestamp, inventory }
      // On doit mapper vers notre interface MachineInventory
      const inventory: MachineInventory = {
        machineId: rawInventory.machineId,
        timestamp: rawInventory.timestamp,
        system: {
          hostname: rawInventory.inventory?.systemInfo?.hostname || os.hostname(),
          os: rawInventory.inventory?.systemInfo?.os || os.platform(),
          architecture: rawInventory.inventory?.systemInfo?.architecture || os.arch(),
          uptime: rawInventory.inventory?.systemInfo?.uptime || os.uptime()
        },
        hardware: {
          cpu: {
            name: rawInventory.inventory?.systemInfo?.processor || 'Unknown',
            cores: rawInventory.inventory?.systemInfo?.cpuCores || os.cpus().length,
            threads: rawInventory.inventory?.systemInfo?.cpuThreads || os.cpus().length
          },
          memory: {
            total: rawInventory.inventory?.systemInfo?.totalMemory || os.totalmem(),
            available: rawInventory.inventory?.systemInfo?.availableMemory || os.freemem()
          },
          disks: rawInventory.inventory?.systemInfo?.disks || [],
          gpu: rawInventory.inventory?.systemInfo?.gpu
        },
        software: {
          powershell: rawInventory.inventory?.tools?.powershell?.version || 'Unknown',
          node: rawInventory.inventory?.tools?.node?.version,
          python: rawInventory.inventory?.tools?.python?.version
        },
        roo: {
          modesPath: rawInventory.inventory?.rooConfig?.modesPath,
          mcpSettings: rawInventory.inventory?.rooConfig?.mcpSettingsPath
        }
      };

      console.log(`[InventoryCollector] Inventaire parsé avec succès pour ${inventory.machineId}`);
      return inventory;

    } catch (error) {
      console.error(`[InventoryCollector] Erreur parsing JSON:`, error instanceof Error ? error.message : String(error));
      return null;
    }
  }

  /**
   * Sauvegarde l'inventaire dans .shared-state/inventories/
   * @param inventory - Inventaire à sauvegarder
   */
  private async saveToSharedState(inventory: MachineInventory): Promise<void> {
    try {
      // Construire le chemin .shared-state/inventories/
      const sharedStatePath = process.env.SHARED_STATE_PATH || 
        'G:/Mon Drive/Synchronisation/RooSync/.shared-state';
      const inventoriesDir = join(sharedStatePath, 'inventories');

      // Créer le répertoire s'il n'existe pas
      if (!existsSync(inventoriesDir)) {
        console.log(`[InventoryCollector] Création du répertoire: ${inventoriesDir}`);
        await fs.mkdir(inventoriesDir, { recursive: true });
      }

      // Générer le nom de fichier avec timestamp
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `${inventory.machineId}-${timestamp}.json`;
      const filepath = join(inventoriesDir, filename);

      // Sauvegarder le fichier
      await fs.writeFile(filepath, JSON.stringify(inventory, null, 2), 'utf-8');
      console.log(`[InventoryCollector] Inventaire sauvegardé dans: ${filepath}`);

    } catch (error) {
      // Non-bloquant : on log mais on ne throw pas
      console.warn(`[InventoryCollector] Avertissement: impossible de sauvegarder dans .shared-state:`, 
        error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Vider le cache (utile pour les tests ou forcer rafraîchissement global)
   */
  public clearCache(): void {
    console.log(`[InventoryCollector] Cache vidé (${this.cache.size} entrées)`);
    this.cache.clear();
  }

  /**
   * Obtenir les statistiques du cache
   */
  public getCacheStats(): { size: number; entries: Array<{ machineId: string; age: number }> } {
    const entries = Array.from(this.cache.entries()).map(([machineId, cached]) => ({
      machineId,
      age: Date.now() - cached.timestamp
    }));

    return {
      size: this.cache.size,
      entries
    };
  }
}