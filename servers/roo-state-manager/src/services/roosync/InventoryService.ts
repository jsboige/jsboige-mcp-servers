import * as os from 'os';
import * as fs from 'fs/promises';
import * as path from 'path';
import { existsSync } from 'fs';
import { FullInventory, InventoryData, McpServerInfo, RooModeInfo, ScriptInfo, ClaudeConfigInfo } from '../../types/inventory';
import { PowerShellExecutor } from '../PowerShellExecutor';
import { readJSONFileWithoutBOM } from '../../utils/encoding-helpers.js';
import { InventoryCollectorError, InventoryCollectorErrorCode } from '../../types/errors.js';
import { getSharedStatePath } from '../../utils/server-helpers.js';

export class InventoryService {
  private static instance: InventoryService;
  private readonly ROO_EXTENSIONS_PATH: string;
  private readonly MCP_SETTINGS_PATH: string;
  private readonly ROO_CONFIG_PATH: string;
  private readonly SCRIPTS_PATH: string;
  private readonly CLAUDE_JSON_PATH: string; // #489: Ajout chemin vers ~/.claude.json

  /**
   * Détecte la racine roo-extensions en remontant l'arborescence depuis process.cwd()
   * Recherche un répertoire contenant CLAUDE.md (fichier caractéristique de roo-extensions)
   */
  private static findRooExtensionsRoot(): string {
    // Si la variable d'environnement est définie, l'utiliser
    if (process.env.ROO_EXTENSIONS_PATH) {
      return process.env.ROO_EXTENSIONS_PATH;
    }

    let currentPath = process.cwd();

    // Remonter jusqu'à 10 niveaux pour trouver la racine
    for (let i = 0; i < 10; i++) {
      // Vérifier si on est à la racine roo-extensions (présence de CLAUDE.md)
      if (existsSync(path.join(currentPath, 'CLAUDE.md'))) {
        return currentPath;
      }
      const parentPath = path.dirname(currentPath);
      if (parentPath === currentPath) break; // Atteint la racine du système
      currentPath = parentPath;
    }

    // Fallback au cwd si CLAUDE.md non trouvé
    return process.cwd();
  }

  private constructor() {
    // Define paths relative to the assumed workspace root or user home
    // In a real scenario, these might be configurable or auto-detected
    const userHome = os.homedir();
    this.ROO_EXTENSIONS_PATH = InventoryService.findRooExtensionsRoot();
    this.MCP_SETTINGS_PATH = path.join(userHome, 'AppData/Roaming/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json');
    this.ROO_CONFIG_PATH = path.join(this.ROO_EXTENSIONS_PATH, 'roo-config');
    this.SCRIPTS_PATH = path.join(this.ROO_EXTENSIONS_PATH, 'scripts');
    this.CLAUDE_JSON_PATH = path.join(userHome, '.claude.json'); // #489: Ajout chemin ~/.claude.json
  }

  public static getInstance(): InventoryService {
    if (!InventoryService.instance) {
      InventoryService.instance = new InventoryService();
    }
    return InventoryService.instance;
  }

  public async getMachineInventory(machineId?: string): Promise<FullInventory> {
  const finalMachineId = machineId || os.hostname();
  const localHostname = os.hostname();

  // Normaliser le machineId en minuscules pour correspondre au nom de fichier
  const normalizedMachineId = finalMachineId.toLowerCase();

  // Si machineId est fourni et différent de l'hôte local, charger l'inventaire distant
  if (machineId && machineId.toLowerCase() !== localHostname.toLowerCase()) {
    return await this.loadRemoteInventory(normalizedMachineId);
  }

  // Pour la machine locale, toujours collecter l'inventaire frais
  // FIX: L'ancien code chargeait le fichier GDrive en cache et ne le rafraîchissait jamais
  // car loadRemoteInventory réussissait si le fichier existait (même périmé)
  // Collecter l'inventaire local
  const inventoryData: InventoryData = {
    mcpServers: await this.collectMcpServers(),
    slashCommands: [], // Not implemented in script
    terminalCommands: { allowed: [], restricted: [] }, // Not implemented in script
    rooModes: await this.collectRooModes(),
    sdddSpecs: await this.collectSdddSpecs(),
    scripts: await this.collectScripts(),
    tools: {}, // Skipped in script
    systemInfo: {
      os: `${os.type()} ${os.release()}`,
      hostname: os.hostname().toLowerCase(),
      username: os.userInfo().username,
      powershellVersion: await this.getPowershellVersion()
    },
    claudeConfig: await this.collectClaudeConfig() // #489: Ajout collecte ~/.claude.json
  };

  const inventory: FullInventory = {
    machineId: normalizedMachineId,
    timestamp: new Date().toISOString(),
    inventory: inventoryData,
    paths: {
      rooExtensions: this.ROO_EXTENSIONS_PATH,
      mcpSettings: this.MCP_SETTINGS_PATH,
      rooConfig: this.ROO_CONFIG_PATH,
      scripts: this.SCRIPTS_PATH,
      claudeJson: this.CLAUDE_JSON_PATH // #489: Ajout chemin ~/.claude.json
    }
  };

  // CORRECTION #322: Sauvegarder l'inventaire dans le shared state pour permettre à compare_config de fonctionner
  await this.saveToSharedState(inventory);

  return inventory;
}

/**
 * Charge l'inventaire d'une machine distante depuis le partage RooSync
 * @param machineId - Identifiant de la machine distante
 * @returns L'inventaire complet de la machine distante
 * @throws Error si l'inventaire n'existe pas ou si le chemin de partage n'est pas configuré
 */
private async loadRemoteInventory(machineId: string): Promise<FullInventory> {
  const sharedPath = process.env.ROOSYNC_SHARED_PATH;

  if (!sharedPath) {
    throw new InventoryCollectorError(
      'ROOSYNC_SHARED_PATH n\'est pas configuré. Impossible de charger l\'inventaire distant.',
      InventoryCollectorErrorCode.SHARED_STATE_NOT_ACCESSIBLE,
      { machineId, method: 'loadRemoteInventory' }
    );
  }

  // CORRECTION #340 : Utiliser le nouveau format {machineId}.json (aligné avec InventoryCollector)
  const inventoryPath = path.join(sharedPath, 'inventories', `${machineId}.json`);

  try {
    const inventory: FullInventory = await readJSONFileWithoutBOM<FullInventory>(inventoryPath);

    // Vérifier que l'inventaire chargé correspond bien au machineId demandé
    if (inventory.machineId !== machineId) {
      throw new InventoryCollectorError(
        `Incohérence dans l'inventaire: machineId du fichier (${inventory.machineId}) ` +
        `diffère du machineId demandé (${machineId})`,
        InventoryCollectorErrorCode.INVENTORY_PARSE_FAILED,
        { requestedMachineId: machineId, actualMachineId: inventory.machineId, inventoryPath }
      );
    }

    return inventory;
  } catch (error: any) {
    // Propager les erreurs typées
    if (error instanceof InventoryCollectorError) {
      throw error;
    }
    if (error.code === 'ENOENT') {
      throw new InventoryCollectorError(
        `L'inventaire pour la machine '${machineId}' n'existe pas dans le partage RooSync. ` +
        `Chemin recherché: ${inventoryPath}`,
        InventoryCollectorErrorCode.REMOTE_MACHINE_NOT_FOUND,
        { machineId, inventoryPath }
      );
    }
    throw new InventoryCollectorError(
      `Erreur lors du chargement de l'inventaire distant pour '${machineId}': ${error.message}`,
      InventoryCollectorErrorCode.INVENTORY_PARSE_FAILED,
      { machineId, inventoryPath },
      error
    );
  }
}

private async collectMcpServers(): Promise<McpServerInfo[]> {
    try {
      if (await this.fileExists(this.MCP_SETTINGS_PATH)) {
        const settings = await readJSONFileWithoutBOM<any>(this.MCP_SETTINGS_PATH);
        const servers: McpServerInfo[] = [];

        if (settings.mcpServers) {
          for (const [name, config] of Object.entries(settings.mcpServers) as [string, any][]) {
            servers.push({
              name,
              enabled: !config.disabled,
              autoStart: config.autoStart,
              description: config.description,
              command: config.command,
              transportType: config.transportType,
              alwaysAllow: config.alwaysAllow
            });
          }
        }
        return servers;
      } else {
        return [{ name: 'mcp_settings.json not found', enabled: false, autoStart: false, status: 'absent' }];
      }
    } catch (error: any) {
      return [{ name: 'Error reading MCP settings', enabled: false, autoStart: false, status: 'error', error: error.message }];
    }
  }

  private async collectRooModes(): Promise<RooModeInfo[]> {
    const modesPath = path.join(this.ROO_CONFIG_PATH, 'settings/modes.json');
    try {
      if (await this.fileExists(modesPath)) {
        const config = await readJSONFileWithoutBOM<any>(modesPath);
        return config.modes || [];
      } else {
        return []; // Return empty if file not found, similar to script handling
      }
    } catch (error: any) {
       console.error(`Error reading modes: ${error.message}`);
       return [];
    }
  }

  /**
   * SIMPLIFICATION "Écuries d'Augias" : Ne plus collecter les specs SDDD
   * Ces fichiers ne sont pas utiles pour la comparaison des configurations
   * et gonflent inutilement l'inventaire.
   */
  private async collectSdddSpecs(): Promise<any[]> {
     // Retourner un tableau vide pour alléger l'inventaire
     return [];
  }

  /**
   * SIMPLIFICATION "Écuries d'Augias" : Ne plus collecter les scripts PowerShell
   * Ces fichiers ne sont pas utiles pour la comparaison des configurations
   * et gonflent l'inventaire de 70+ KB à cause de la récursion.
   */
  private async collectScripts(): Promise<{ categories: { [key: string]: ScriptInfo[] }; all: ScriptInfo[] }> {
      // Retourner un objet vide pour alléger l'inventaire
      return {
          categories: {},
          all: []
      };
  }

  private async getPowershellVersion(): Promise<string> {
      // In a real environment, we might execute 'pwsh -v' or '$PSVersionTable'
      // For now, returning a placeholder or executing a simple command if possible
      // Since we don't have direct command execution easily available in this service context without external dependencies
      // We will try to use the PowerShellExecutor if available or return default.
      try {
           // Placeholder: assuming PWSH 7 for this environment as per system info
           return "7.x";
      } catch {
          return "Unknown";
      }
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * #489: Collecte la configuration Claude Code globale depuis ~/.claude.json
   * Permet de détecter la dette technique entre machines (modèles, env vars, MCPs)
   */
  private async collectClaudeConfig(): Promise<ClaudeConfigInfo | undefined> {
    try {
      if (await this.fileExists(this.CLAUDE_JSON_PATH)) {
        const claudeJson = await readJSONFileWithoutBOM<any>(this.CLAUDE_JSON_PATH);

        // Extraire les champs pertinents pour la comparaison
        const config: ClaudeConfigInfo = {};

        // Modèle par défaut (si défini)
        if (claudeJson.model) {
          config.model = claudeJson.model;
        }

        // Variables d'environnement globales (pour les MCPs)
        // Regrouper les env vars des MCPs (ROOSYNC_*, QDRANT_*, etc.)
        const envVars: Record<string, string> = {};
        if (claudeJson.mcpServers) {
          for (const [mcpName, mcpConfig] of Object.entries(claudeJson.mcpServers) as [string, any][]) {
            if (mcpConfig.env) {
              // Filtrer seulement les vars "système" (ROOSYNC_*, QDRANT_*, OPENAI_*)
              for (const [key, value] of Object.entries(mcpConfig.env)) {
                if (key.startsWith('ROOSYNC_') || key.startsWith('QDRANT_') ||
                    key.startsWith('OPENAI_') || key.startsWith('EMBEDDING_')) {
                  // Éviter les doublons : si plusieurs MCPs utilisent la même var
                  if (!(key in envVars)) {
                    envVars[key] = value as string;
                  }
                }
              }
            }
          }
        }
        if (Object.keys(envVars).length > 0) {
          config.env = envVars;
        }

        // Nombre de MCPs configurés
        if (claudeJson.mcpServers) {
          config.mcpServersCount = Object.keys(claudeJson.mcpServers).length;
        }

        // Skills utilisés (pour détecter l'activité)
        if (claudeJson.skillUsage) {
          config.skillUsage = claudeJson.skillUsage;
        }

        // Migrations complétées (pour détecter la version Claude Code)
        const migrations: string[] = [];
        if (claudeJson.sonnet45MigrationComplete) migrations.push('sonnet45');
        if (claudeJson.opus45MigrationComplete) migrations.push('opus45');
        if (claudeJson.thinkingMigrationComplete) migrations.push('thinking');
        if (claudeJson.opusProMigrationComplete) migrations.push('opusPro');
        if (claudeJson.sonnet1m45MigrationComplete) migrations.push('sonnet1m45');
        if (migrations.length > 0) {
          config.migrationsComplete = migrations;
        }

        return config;
      } else {
        // ~/.claude.json n'existe pas (peut arriver sur certaines machines)
        return undefined;
      }
    } catch (error: any) {
      console.warn(`[InventoryService] ⚠️ Erreur lecture ~/.claude.json: ${error.message}`);
      return undefined;
    }
  }

  /**
   * CORRECTION #322: Sauvegarde l'inventaire dans le shared state pour permettre à compare_config de fonctionner
   * @param inventory - L'inventaire à sauvegarder
   */
  private async saveToSharedState(inventory: FullInventory): Promise<void> {
    try {
      const sharedStatePath = getSharedStatePath();
      const inventoriesDir = path.join(sharedStatePath, 'inventories');

      // Créer le répertoire s'il n'existe pas
      if (!existsSync(inventoriesDir)) {
        console.log(`[InventoryService] 📁 Création du répertoire: ${inventoriesDir}`);
        await fs.mkdir(inventoriesDir, { recursive: true });
      }

      // Sauvegarder avec un nom simple (sans timestamp) pour que loadRemoteInventory puisse le trouver
      // Format: {machineId}.json
      const filename = `${inventory.machineId}.json`;
      const filepath = path.join(inventoriesDir, filename);

      // Sauvegarder le fichier
      await fs.writeFile(filepath, JSON.stringify(inventory, null, 2), 'utf-8');
      console.log(`[InventoryService] 💾 Inventaire sauvegardé: ${filepath}`);

    } catch (error) {
      // Non-bloquant : on log mais on ne throw pas
      console.warn(`[InventoryService] ⚠️ Impossible de sauvegarder dans .shared-state:`, error);
    }
  }
}