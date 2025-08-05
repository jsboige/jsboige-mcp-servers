import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { setupTools } from './tools.js';
import { setupResources } from './resources.js';
import { setupErrorHandlers } from './utils/errorHandlers.js';

// Le GITHUB_TOKEN est maintenant injecté par la configuration du MCP.
console.log('[GP-MCP][INDEX] Début du script index.ts');
console.log('[INFO] Le serveur utilisera le GITHUB_TOKEN fourni par l\'environnement du processus.');

/**
 * Classe principale du serveur GitHub Projects MCP
 */
class GitHubProjectsServer {
  /** Instance du serveur MCP */
  private server: Server;

  /**
   * Crée une instance du serveur GitHub Projects MCP
   */
  constructor() {
    console.log('[GP-MCP][INDEX] Entrée dans le constructeur de GitHubProjectsServer.');
    this.server = new Server(
      {
        name: 'github-projects-mcp-v2',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
          resources: {},
        },
      }
    );

    // Configurer les outils et les ressources
    setupTools(this.server);
    setupResources(this.server);
    
    // Configurer les gestionnaires d'erreurs
    setupErrorHandlers(this.server);
    
    // Gestion des erreurs
    this.server.onerror = (error) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  /**
   * Démarre le serveur
   */
  async run() {
    try {
      console.log('[GP-MCP][INDEX] Exécution de la méthode run().');
      console.log('Démarrage du serveur MCP Gestionnaire de Projet...');
      const transport = new StdioServerTransport();
      console.log('[GP-MCP][INDEX] Avant server.connect().');
      await this.server.connect(transport);
      console.log('[GP-MCP][INDEX] Après server.connect() - Le serveur devrait être connecté.');
      console.log('Serveur MCP Gestionnaire de Projet démarré sur stdio');
    } catch (error) {
      console.error('Erreur lors du démarrage du serveur MCP:', error);
      process.exit(1);
    }
  }
}

// Créer et démarrer le serveur
const server = new GitHubProjectsServer();
server.run();