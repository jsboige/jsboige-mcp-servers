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
import { existsSync, readFileSync } from 'fs';
import { promisify } from 'util';
import { exec } from 'child_process';
import { fileURLToPath } from 'url';
import os from 'os';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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
  
  /**
   * Constructeur
   */
  constructor() {
    this.cache = new Map<string, CachedInventory>();
    console.error('[InventoryCollector] Instance créée avec cache TTL de', this.cacheTTL, 'ms');
  }

  /**
   * Collecte l'inventaire d'une machine (avec cache)
   * @param machineId - Identifiant de la machine
   * @param forceRefresh - Forcer la collecte même si cache valide
   * @returns Inventaire structuré ou null en cas d'échec
   */
  async collectInventory(machineId: string, forceRefresh = false): Promise<MachineInventory | null> {
    console.error(`[InventoryCollector] 🔍 Collecte inventaire pour machine: ${machineId} (forceRefresh: ${forceRefresh})`);
    
    // Vérifier le cache si pas de forceRefresh
    if (!forceRefresh && this.isCacheValid(machineId)) {
      console.error(`[InventoryCollector] ✅ Cache valide trouvé pour ${machineId}`);
      return this.cache.get(machineId)!.data;
    }

    try {
      // Calculer projectRoot comme dans init.ts (remonter 7 niveaux depuis build/src/services/)
      // __dirname en production = .../roo-state-manager/build/src/services/
      const projectRoot = join(__dirname, '..', '..', '..', '..', '..', '..', '..');
      console.error(`[InventoryCollector] 📂 Project root calculé: ${projectRoot}`);
      console.error(`[InventoryCollector] 📂 __dirname actuel: ${__dirname}`);
      
      // Construire chemin absolu du script PowerShell
      const inventoryScriptPath = join(projectRoot, 'scripts', 'inventory', 'Get-MachineInventory.ps1');
      console.error(`[InventoryCollector] 📄 Script path: ${inventoryScriptPath}`);
      
      // Vérifier que le script existe
      if (!existsSync(inventoryScriptPath)) {
        console.error(`[InventoryCollector] ❌ Script NON TROUVÉ: ${inventoryScriptPath}`);
        return null;
      }
      console.error(`[InventoryCollector] ✅ Script trouvé`);

      // Commande PowerShell directe (comme init.ts) - PAS de -OutputPath
      const inventoryCmd = `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${inventoryScriptPath}" -MachineId "${machineId}"`;
      console.error(`[InventoryCollector] 🔧 Commande: ${inventoryCmd}`);
      console.error(`[InventoryCollector] 📂 Working directory: ${projectRoot}`);

      // Exécuter avec execAsync (comme init.ts)
      console.error('[InventoryCollector] ⏳ Exécution du script PowerShell...');
      const { stdout, stderr } = await execAsync(inventoryCmd, {
        timeout: 30000, // 30s timeout
        cwd: projectRoot
      });

      console.error(`[InventoryCollector] 📊 stdout length: ${stdout.length} bytes`);
      if (stderr && stderr.trim()) {
        console.warn(`[InventoryCollector] ⚠️ stderr: ${stderr}`);
      }

      // Le script retourne le chemin du fichier JSON en dernière ligne de stdout
      const lines = stdout.trim().split('\n').filter(l => l.trim());
      const inventoryFilePathRaw = lines[lines.length - 1]?.trim();
      console.error(`[InventoryCollector] 📄 Dernière ligne stdout: ${inventoryFilePathRaw}`);
      console.error(`[InventoryCollector] 📝 Total lignes stdout: ${lines.length}`);

      // Résoudre chemin relatif en absolu si nécessaire
      const inventoryFilePath = inventoryFilePathRaw.includes(':')
        ? inventoryFilePathRaw
        : join(projectRoot, inventoryFilePathRaw);
      console.error(`[InventoryCollector] 📁 Chemin absolu calculé: ${inventoryFilePath}`);

      if (!inventoryFilePath || !existsSync(inventoryFilePath)) {
        console.error(`[InventoryCollector] ❌ Fichier JSON non trouvé: '${inventoryFilePath}'`);
        return null;
      }

      console.error(`[InventoryCollector] ✅ Fichier JSON trouvé`);

      // Lire et parser avec strip BOM UTF-8 (comme init.ts)
      let inventoryContent = readFileSync(inventoryFilePath, 'utf-8');
      if (inventoryContent.charCodeAt(0) === 0xFEFF) {
        inventoryContent = inventoryContent.slice(1);
        console.error('[InventoryCollector] 🔧 BOM UTF-8 détecté et supprimé');
      }

      const rawInventory = JSON.parse(inventoryContent);
      console.error(`[InventoryCollector] 📦 JSON parsé avec succès`);

      // Mapper vers notre interface MachineInventory
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

      console.error(`[InventoryCollector] ✅ Inventaire structuré pour ${inventory.machineId}`);

      // Mettre à jour le cache
      this.cache.set(machineId, {
        data: inventory,
        timestamp: Date.now()
      });
      console.error(`[InventoryCollector] 💾 Cache mis à jour pour ${machineId}`);

      // Sauvegarder dans .shared-state/inventories/
      await this.saveToSharedState(inventory);

      return inventory;

    } catch (error) {
      console.error(`[InventoryCollector] ❌ ERREUR:`, error instanceof Error ? error.message : String(error));
      if (error instanceof Error && error.stack) {
        console.error(`[InventoryCollector] Stack:`, error.stack);
      }
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
      console.error(`[InventoryCollector] ⏰ Cache expiré pour ${machineId} (âge: ${Math.round(age / 1000)}s)`);
      this.cache.delete(machineId);
    }
    
    return isValid;
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
        console.error(`[InventoryCollector] 📁 Création du répertoire: ${inventoriesDir}`);
        await fs.mkdir(inventoriesDir, { recursive: true });
      }

      // Générer le nom de fichier avec timestamp
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `${inventory.machineId}-${timestamp}.json`;
      const filepath = join(inventoriesDir, filename);

      // Sauvegarder le fichier
      await fs.writeFile(filepath, JSON.stringify(inventory, null, 2), 'utf-8');
      console.error(`[InventoryCollector] 💾 Inventaire sauvegardé: ${filepath}`);

    } catch (error) {
      // Non-bloquant : on log mais on ne throw pas
      console.warn(`[InventoryCollector] ⚠️ Impossible de sauvegarder dans .shared-state:`,
        error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Vider le cache (utile pour les tests ou forcer rafraîchissement global)
   */
  public clearCache(): void {
    console.error(`[InventoryCollector] 🗑️ Cache vidé (${this.cache.size} entrées)`);
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