import * as os from 'os';
import * as fs from 'fs/promises';
import * as path from 'path';
import { FullInventory, InventoryData, McpServerInfo, RooModeInfo, ScriptInfo } from '../../types/inventory';
import { PowerShellExecutor } from '../PowerShellExecutor';
import { readJSONFileWithoutBOM } from '../../utils/encoding-helpers.js';
import { InventoryCollectorError, InventoryCollectorErrorCode } from '../../types/errors.js';

export class InventoryService {
  private static instance: InventoryService;
  private readonly ROO_EXTENSIONS_PATH: string;
  private readonly MCP_SETTINGS_PATH: string;
  private readonly ROO_CONFIG_PATH: string;
  private readonly SCRIPTS_PATH: string;

  private constructor() {
    // Define paths relative to the assumed workspace root or user home
    // In a real scenario, these might be configurable or auto-detected
    const userHome = os.homedir();
    this.ROO_EXTENSIONS_PATH = process.env.ROO_EXTENSIONS_PATH || process.cwd();
    this.MCP_SETTINGS_PATH = path.join(userHome, 'AppData/Roaming/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json');
    this.ROO_CONFIG_PATH = path.join(this.ROO_EXTENSIONS_PATH, 'roo-config');
    this.SCRIPTS_PATH = path.join(this.ROO_EXTENSIONS_PATH, 'scripts');
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

  // Si machineId est fourni et différent de l'hôte local, charger l'inventaire distant
  if (machineId && machineId !== localHostname) {
    return await this.loadRemoteInventory(machineId);
  }

  // Sinon, collecter l'inventaire local
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
      hostname: os.hostname(),
      username: os.userInfo().username,
      powershellVersion: await this.getPowershellVersion()
    }
  };

  return {
    machineId: finalMachineId,
    timestamp: new Date().toISOString(),
    inventory: inventoryData,
    paths: {
      rooExtensions: this.ROO_EXTENSIONS_PATH,
      mcpSettings: this.MCP_SETTINGS_PATH,
      rooConfig: this.ROO_CONFIG_PATH,
      scripts: this.SCRIPTS_PATH
    }
  };
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

  private async collectSdddSpecs(): Promise<any[]> {
     const specsPath = path.join(this.ROO_CONFIG_PATH, 'specifications');
     const specs: any[] = [];
     try {
        if (await this.fileExists(specsPath)) {
            const files = await fs.readdir(specsPath);
            for (const file of files) {
                if (file.endsWith('.md') && file !== 'README.md') {
                    const filePath = path.join(specsPath, file);
                    const stats = await fs.stat(filePath);
                    specs.push({
                        name: file,
                        path: path.relative(this.ROO_EXTENSIONS_PATH, filePath),
                        size: stats.size,
                        lastModified: stats.mtime.toISOString().split('T')[0]
                    });
                }
            }
        }
     } catch (error: any) {
         console.error(`Error reading specs: ${error.message}`);
     }
     return specs;
  }

  private async collectScripts(): Promise<{ categories: { [key: string]: ScriptInfo[] }; all: ScriptInfo[] }> {
      const result = {
          categories: {} as { [key: string]: ScriptInfo[] },
          all: [] as ScriptInfo[]
      };

      try {
          if (await this.fileExists(this.SCRIPTS_PATH)) {
              // Get directories (categories)
              const items = await fs.readdir(this.SCRIPTS_PATH, { withFileTypes: true });

              for (const item of items) {
                  if (item.isDirectory()) {
                      const category = item.name;
                      result.categories[category] = [];
                      const dirPath = path.join(this.SCRIPTS_PATH, category);
                      const files = await this.getFilesRecursively(dirPath, '.ps1');

                      for (const file of files) {
                          const scriptInfo: ScriptInfo = {
                              name: path.basename(file),
                              path: path.relative(this.ROO_EXTENSIONS_PATH, file),
                              category: category
                          };
                          result.categories[category].push(scriptInfo);
                          result.all.push(scriptInfo);
                      }
                  } else if (item.isFile() && item.name.endsWith('.ps1')) {
                      // Root scripts
                      if (!result.categories['root']) {
                          result.categories['root'] = [];
                      }
                       const scriptInfo: ScriptInfo = {
                              name: item.name,
                              path: path.relative(this.ROO_EXTENSIONS_PATH, path.join(this.SCRIPTS_PATH, item.name)),
                              category: 'root'
                          };
                      result.categories['root'].push(scriptInfo);
                      result.all.push(scriptInfo);
                  }
              }
          }
      } catch (error: any) {
          console.error(`Error collecting scripts: ${error.message}`);
      }

      return result;
  }

  private async getFilesRecursively(dir: string, extension: string): Promise<string[]> {
      let results: string[] = [];
      const list = await fs.readdir(dir, { withFileTypes: true });
      for (const item of list) {
          const fullPath = path.join(dir, item.name);
          if (item.isDirectory()) {
              results = results.concat(await this.getFilesRecursively(fullPath, extension));
          } else if (item.name.endsWith(extension)) {
              results.push(fullPath);
          }
      }
      return results;
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

  private async fileExists(path: string): Promise<boolean> {
    try {
      await fs.access(path);
      return true;
    } catch {
      return false;
    }
  }
}