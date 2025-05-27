import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import dotenv from 'dotenv';
import path from 'path'; // Ajout de l'import pour path
import { setupTools } from './tools.js';
import { setupResources } from './resources.js';
import { setupErrorHandlers } from './utils/errorHandlers.js';

// Charger les variables d'environnement
const envPath = path.resolve(__dirname, '../.env'); // Chemin corrigé vers .env
console.log('[DEBUG] Avant dotenv.config(). Chemin .env cible:', envPath);
console.log('[DEBUG] process.env.GITHUB_TOKEN avant dotenv.config():', process.env.GITHUB_TOKEN);
const dotenvResult = dotenv.config({ path: envPath, debug: true, override: true });

if (dotenvResult.error) {
  console.error('[DEBUG] Erreur de chargement dotenv:', dotenvResult.error);
}
console.log('[DEBUG] Après dotenv.config(). Variables chargées:', dotenvResult.parsed);
console.log('[DEBUG] process.env.GITHUB_TOKEN après dotenv.config():', process.env.GITHUB_TOKEN);

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
    this.server = new Server(
      {
        name: 'github-projects',
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
      console.log('Démarrage du serveur MCP Gestionnaire de Projet...');
      const transport = new StdioServerTransport();
      await this.server.connect(transport);
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