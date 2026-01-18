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
import { createLogger, Logger } from '../utils/logger.js';
import { getGitHelpers, type GitHelpers } from '../utils/git-helpers.js';
import { getSharedStatePath } from '../utils/server-helpers.js';

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
    mcpServers: Array<{
      name: string;
      enabled: boolean;
      command?: string;
      transportType?: string;
      alwaysAllow?: any[];
      description?: string;
    }>;
    modes: Array<{
      slug: string;
      name: string;
      defaultModel?: string;
      tools?: any[];
      allowedFilePatterns?: string[];
    }>;
    sdddSpecs?: any[];
    scripts?: any;
  };
  paths: {
    rooExtensions?: string;
    mcpSettings?: string;
    rooConfig?: string;
    scripts?: string;
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
  private logger: Logger;
  private gitHelpers: GitHelpers;
  
  /**
   * Constructeur
   */
  constructor() {
    this.cache = new Map<string, CachedInventory>();
    this.logger = createLogger('InventoryCollector');
    this.gitHelpers = getGitHelpers();
    this.logger.info(`Instance créée avec cache TTL de ${this.cacheTTL}ms`);
    
    // Vérifier Git au démarrage
    this.verifyGitOnStartup();
  }
  
  /**
   * Vérifier la disponibilité de Git au démarrage
   */
  private async verifyGitOnStartup(): Promise<void> {
    try {
      const gitCheck = await this.gitHelpers.verifyGitAvailable();
      if (!gitCheck.available) {
        this.logger.warn('Git NOT available - inventory collection may be limited', { error: gitCheck.error });
      } else {
        this.logger.info(`Git verified: ${gitCheck.version}`);
      }
    } catch (error) {
      this.logger.error('Failed to verify Git', error);
    }
  }

  /**
   * Collecte l'inventaire d'une machine (avec cache)
   *
   * Stratégie optimisée :
   * 1. Vérifier cache en mémoire (TTL 1h)
   * 2. Charger depuis .shared-state/inventories/ (synchronisé Google Drive)
   * 3. Si pas trouvé ET machine locale : exécuter script PowerShell
   *
   * @param machineId - Identifiant de la machine
   * @param forceRefresh - Forcer la collecte même si cache valide
   * @returns Inventaire structuré ou null en cas d'échec
   */
  async collectInventory(machineId: string, forceRefresh = false): Promise<MachineInventory | null> {
    this.logger.info(`🔍 Collecte inventaire pour machine: ${machineId}`, { forceRefresh });
    
    // Vérifier le cache si pas de forceRefresh
    if (!forceRefresh && this.isCacheValid(machineId)) {
      this.logger.info(`✅ Cache valide trouvé pour ${machineId}`);
      return this.cache.get(machineId)!.data;
    }

    // CORRECTION SDDD : Si forceRefresh, sauter le chargement depuis .shared-state pour forcer l'exécution du script
    if (!forceRefresh) {
      // STRATÉGIE 1 : Charger depuis .shared-state/inventories/ (prioritaire)
      this.logger.info(`📂 Tentative de chargement depuis .shared-state/inventories/`);
      const sharedInventory = await this.loadFromSharedState(machineId);
      
      if (sharedInventory) {
        this.logger.info(`✅ Inventaire chargé depuis .shared-state pour ${machineId}`);
        return sharedInventory;
      }
    } else {
      this.logger.info(`🔄 ForceRefresh activé : bypass du chargement .shared-state pour forcer l'exécution du script`);
    }

    // STRATÉGIE 2 : Si pas trouvé, vérifier si machine locale et exécuter script PowerShell
    const localHostname = os.hostname().toLowerCase();
    const isLocalMachine = machineId.toLowerCase() === localHostname ||
                          machineId.toLowerCase().includes('myia-ai-01');
    
    if (!isLocalMachine) {
      this.logger.error(`❌ Machine distante ${machineId} sans inventaire dans .shared-state`);
      return null;
    }

    this.logger.info(`🔧 Machine locale détectée, exécution du script PowerShell en fallback`);
    
    try {
      // Calculer projectRoot comme dans init.ts (remonter 7 niveaux depuis build/src/services/)
      // __dirname en production = .../roo-state-manager/build/src/services/
      const projectRoot = join(__dirname, '..', '..', '..', '..', '..', '..', '..');
      this.logger.debug(`📂 Project root calculé: ${projectRoot}`);
      this.logger.debug(`📂 __dirname actuel: ${__dirname}`);
      
      // Construire chemin absolu du script PowerShell
      const inventoryScriptPath = join(projectRoot, 'scripts', 'inventory', 'Get-MachineInventory.ps1');
      this.logger.debug(`📄 Script path: ${inventoryScriptPath}`);
      
      // Vérifier que le script existe
      if (!existsSync(inventoryScriptPath)) {
        this.logger.error(`❌ Script NON TROUVÉ: ${inventoryScriptPath}`);
        return null;
      }
      this.logger.info(`✅ Script trouvé`);

      // Commande PowerShell directe (comme init.ts) - PAS de -OutputPath
      const inventoryCmd = `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${inventoryScriptPath}" -MachineId "${machineId}"`;
      this.logger.debug(`🔧 Commande: ${inventoryCmd}`);
      this.logger.debug(`📂 Working directory: ${projectRoot}`);

      // Exécuter avec execAsync (comme init.ts)
      this.logger.info('⏳ Exécution du script PowerShell...');
      const { stdout, stderr } = await execAsync(inventoryCmd, {
        timeout: 30000, // 30s timeout
        cwd: projectRoot
      });

      this.logger.debug(`📊 stdout length: ${stdout.length} bytes`);
      if (stderr && stderr.trim()) {
        this.logger.warn(`⚠️ stderr: ${stderr}`);
      }

      // Le script retourne le chemin du fichier JSON en dernière ligne de stdout
      const lines = stdout.trim().split('\n').filter(l => l.trim());
      const inventoryFilePathRaw = lines[lines.length - 1]?.trim();
      this.logger.debug(`📄 Dernière ligne stdout: ${inventoryFilePathRaw}`);
      this.logger.debug(`📝 Total lignes stdout: ${lines.length}`);

      // Résoudre chemin relatif en absolu si nécessaire
      const inventoryFilePath = inventoryFilePathRaw.includes(':')
        ? inventoryFilePathRaw
        : join(projectRoot, inventoryFilePathRaw);
      this.logger.debug(`📁 Chemin absolu calculé: ${inventoryFilePath}`);

      if (!inventoryFilePath || !existsSync(inventoryFilePath)) {
        this.logger.error(`❌ Fichier JSON non trouvé: '${inventoryFilePath}'`);
        return null;
      }

      this.logger.info(`✅ Fichier JSON trouvé`);

      // Lire et parser avec strip BOM UTF-8 (comme init.ts)
      let inventoryContent = readFileSync(inventoryFilePath, 'utf-8');
      if (inventoryContent.charCodeAt(0) === 0xFEFF) {
        inventoryContent = inventoryContent.slice(1);
        this.logger.debug('🔧 BOM UTF-8 détecté et supprimé');
      }

      const rawInventory = JSON.parse(inventoryContent);
      this.logger.info(`📦 JSON parsé avec succès`);

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
          mcpServers: (rawInventory.inventory?.mcpServers || []).map((mcp: any) => ({
            name: mcp.name,
            enabled: mcp.enabled,
            command: mcp.command,
            transportType: mcp.transportType,
            alwaysAllow: mcp.alwaysAllow,
            description: mcp.description
          })),
          modes: (rawInventory.inventory?.rooModes || []).map((mode: any) => ({
            slug: mode.slug,
            name: mode.name,
            defaultModel: mode.defaultModel,
            tools: mode.tools,
            allowedFilePatterns: mode.allowedFilePatterns
          })),
          sdddSpecs: rawInventory.inventory?.sdddSpecs,
          scripts: rawInventory.inventory?.scripts
        },
        paths: rawInventory.paths
      };

      this.logger.info(`✅ Inventaire structuré pour ${inventory.machineId}`);

      // Mettre à jour le cache
      this.cache.set(machineId, {
        data: inventory,
        timestamp: Date.now()
      });
      this.logger.info(`💾 Cache mis à jour pour ${machineId}`);

      // Sauvegarder dans .shared-state/inventories/
      await this.saveToSharedState(inventory);

      return inventory;

    } catch (error) {
      this.logger.error(`❌ ERREUR collecte inventaire`, error);
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
      this.logger.debug(`⏰ Cache expiré pour ${machineId}`, { age: Math.round(age / 1000) });
      this.cache.delete(machineId);
    }
    
    return isValid;
  }

  /**
   * Charge l'inventaire d'une machine distante depuis .shared-state/inventories/
   * @param machineId - Identifiant de la machine
   * @returns Inventaire ou null si non trouvé
   */
  private async loadFromSharedState(machineId: string): Promise<MachineInventory | null> {
    try {
      const sharedStatePath = getSharedStatePath();
      const inventoriesDir = join(sharedStatePath, 'inventories');

      if (!existsSync(inventoriesDir)) {
        this.logger.debug(`❌ Répertoire inventories non trouvé: ${inventoriesDir}`);
        return null;
      }

      // CORRECTION Bug #322 : D'abord essayer le fichier exact {machineId}.json
      // (format utilisé par InventoryService.loadRemoteInventory)
      const exactFilePath = join(inventoriesDir, `${machineId}.json`);
      if (existsSync(exactFilePath)) {
        this.logger.info(`📂 Fichier exact trouvé: ${exactFilePath}`);
        return await this.loadInventoryFile(exactFilePath, machineId);
      }

      // Ensuite chercher les fichiers avec timestamp (format {machineId}-*.json)
      const files = await fs.readdir(inventoriesDir);
      const machineFiles = files
        .filter(f => f.toLowerCase().startsWith(machineId.toLowerCase()) && f.endsWith('.json'))
        .sort()
        .reverse(); // Plus récent en premier

      if (machineFiles.length === 0) {
        this.logger.debug(`❌ Aucun inventaire trouvé pour ${machineId}`);
        return null;
      }

      // Charger le fichier le plus récent (format timestamp)
      const latestFile = machineFiles[0];
      const filepath = join(inventoriesDir, latestFile);
      return await this.loadInventoryFile(filepath, machineId);

    } catch (error) {
      this.logger.error(`❌ Erreur chargement depuis .shared-state`, error);
      return null;
    }
  }

  /**
   * Charge un fichier d'inventaire spécifique
   * @param filepath - Chemin complet du fichier
   * @param machineId - Identifiant de la machine (pour le cache)
   * @returns Inventaire ou null en cas d'erreur
   */
  private async loadInventoryFile(filepath: string, machineId: string): Promise<MachineInventory | null> {
    try {
      this.logger.info(`📂 Chargement depuis: ${filepath}`);

      let content = await fs.readFile(filepath, 'utf-8');

      // Strip BOM UTF-8 si présent
      if (content.charCodeAt(0) === 0xFEFF) {
        content = content.slice(1);
        this.logger.debug('🔧 BOM UTF-8 détecté et supprimé');
      }

      const inventory: MachineInventory = JSON.parse(content);
      this.logger.info(`✅ Inventaire chargé pour ${inventory.machineId}`);

      // Mettre à jour le cache
      this.cache.set(machineId, {
        data: inventory,
        timestamp: Date.now()
      });

      return inventory;
    } catch (error) {
      this.logger.error(`❌ Erreur lecture fichier inventaire: ${filepath}`, error);
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
      const sharedStatePath = getSharedStatePath();
      const inventoriesDir = join(sharedStatePath, 'inventories');

      // Créer le répertoire s'il n'existe pas
      if (!existsSync(inventoriesDir)) {
        this.logger.info(`📁 Création du répertoire: ${inventoriesDir}`);
        await fs.mkdir(inventoriesDir, { recursive: true });
      }

      // Générer le nom de fichier avec timestamp
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `${inventory.machineId}-${timestamp}.json`;
      const filepath = join(inventoriesDir, filename);

      // Sauvegarder le fichier
      await fs.writeFile(filepath, JSON.stringify(inventory, null, 2), 'utf-8');
      this.logger.info(`💾 Inventaire sauvegardé: ${filepath}`);

    } catch (error) {
      // Non-bloquant : on log mais on ne throw pas
      this.logger.warn(`⚠️ Impossible de sauvegarder dans .shared-state`, { error });
    }
  }

  /**
   * Vider le cache (utile pour les tests ou forcer rafraîchissement global)
   */
  public clearCache(): void {
    this.logger.info(`🗑️ Cache vidé (${this.cache.size} entrées)`);
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