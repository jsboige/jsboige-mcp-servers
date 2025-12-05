import * as fs from 'fs/promises';
import * as path from 'path';
import { RestartMcpServersArgsSchema } from '../../validation/schemas.js';
import { QuickFilesUtils } from '../../core/utils.js';

/**
 * Outil pour redémarrer les serveurs MCP via modification des paramètres
 */
export class RestartMcpServersTool {
  private utils: QuickFilesUtils;

  constructor(utils: QuickFilesUtils) {
    this.utils = utils;
  }

  async handle(request: any): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
    try {
      // Extraire et valider les arguments
      const args = request.params?.arguments || request;
      const validatedArgs = RestartMcpServersArgsSchema.parse(args);
      
      const { servers } = validatedArgs;
      
      // Chemin vers le fichier de paramètres MCP
      const mcpSettingsPath = path.join(process.cwd(), 'mcp_settings.json');
      
      try {
        // Lire le fichier de paramètres actuel
        const settingsContent = await fs.readFile(mcpSettingsPath, 'utf-8');
        const settings = JSON.parse(settingsContent);
        
        if (!settings.mcpServers) {
          return {
            content: [{ type: 'text' as const, text: 'Aucun serveur MCP trouvé dans les paramètres' }],
            isError: true
          };
        }
        
        let modifiedServers = [];
        let notFoundServers = [];
        
        // Pour chaque serveur à redémarrer, modifier sa configuration
        for (const serverName of servers) {
          if (settings.mcpServers[serverName]) {
            // Ajouter un timestamp pour forcer le rechargement
            const serverConfig = settings.mcpServers[serverName];
            
            // Si le serveur a des watchPaths, toucher le premier fichier
            if (serverConfig.watchPaths && Array.isArray(serverConfig.watchPaths) && serverConfig.watchPaths.length > 0) {
              const watchPath = serverConfig.watchPaths[0];
              const fullPath = path.resolve(process.cwd(), watchPath);
              
              try {
                // Créer le répertoire s'il n'existe pas
                const dir = path.dirname(fullPath);
                await fs.mkdir(dir, { recursive: true });
                
                // Toucher le fichier pour forcer le rechargement
                const timestamp = new Date().toISOString();
                await fs.writeFile(fullPath, `// MCP restart trigger - ${timestamp}\n`, 'utf-8');
                modifiedServers.push(serverName);
              } catch (error) {
                notFoundServers.push(serverName);
              }
            } else {
              // Alternative: modifier le fichier de paramètres directement
              if (!serverConfig.args) {
                serverConfig.args = [];
              }
              
              // Ajouter un paramètre de restart
              const restartIndex = serverConfig.args.findIndex((arg: string) => arg.startsWith('--restart-timestamp='));
              if (restartIndex >= 0) {
                serverConfig.args[restartIndex] = `--restart-timestamp=${Date.now()}`;
              } else {
                serverConfig.args.push(`--restart-timestamp=${Date.now()}`);
              }
              
              modifiedServers.push(serverName);
            }
          } else {
            notFoundServers.push(serverName);
          }
        }
        
        // Si des modifications ont été faites, écrire le fichier
        if (modifiedServers.length > 0) {
          await fs.writeFile(mcpSettingsPath, JSON.stringify(settings, null, 2), 'utf-8');
        }
        
        // Générer le rapport
        let report = '# Redémarrage des serveurs MCP\n\n';
        
        if (modifiedServers.length > 0) {
          report += `## Serveurs redémarrés avec succès:\n`;
          for (const server of modifiedServers) {
            report += `- ✅ ${server}\n`;
          }
          report += '\n';
        }
        
        if (notFoundServers.length > 0) {
          report += `## Serveurs non trouvés:\n`;
          for (const server of notFoundServers) {
            report += `- ❌ ${server}\n`;
          }
          report += '\n';
        }
        
        report += `**Note:** Les serveurs MCP devraient se redémarrer automatiquement lors de la prochaine détection de changement de configuration.\n`;
        
        return { content: [{ type: 'text' as const, text: report }] };
        
      } catch (error) {
        if ((error as any).code === 'ENOENT') {
          return {
            content: [{ type: 'text' as const, text: 'Fichier mcp_settings.json non trouvé' }],
            isError: true
          };
        }
        throw error;
      }
      
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `Erreur lors du redémarrage des serveurs MCP: ${(error as Error).message}` }],
        isError: true
      };
    }
  }
}