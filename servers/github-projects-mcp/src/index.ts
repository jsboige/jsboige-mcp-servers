import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Définition de __dirname en ES Module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import { setupTools } from './tools.js';
import { setupResources } from './resources.js';
import { setupErrorHandlers } from './utils/errorHandlers.js';

// Charger les variables d'environnement
const envPath = path.resolve(__dirname, '../.env');
console.log('[DEBUG] Avant dotenv.config(). Chemin .env cible:', envPath);
dotenv.config({ path: envPath });

import logger from './logger.js';

// Définition de la structure pour un compte GitHub
interface GitHubAccount {
    owner: string;
    token: string;
}
class GitHubProjectsServer {
  private server: Server;
  private accounts: GitHubAccount[] = [];

  constructor() {
    console.log('[GP-MCP][INDEX] Entrée dans le constructeur de GitHubProjectsServer.');

    // Charger les comptes GitHub
    this.loadAccounts();

    this.server = new Server(
      {
        name: 'github-projects-mcp',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
          resources: {},
        },
      }
    );

    // Configurer les outils et les ressources, en passant les comptes
    setupTools(this.server, this.accounts);
    setupResources(this.server, this.accounts);
    setupErrorHandlers(this.server);
    
    this.server.onerror = (error) => logger.error('[MCP Error]', { error });
    process.on('SIGINT', async () => {
      logger.info('SIGINT received, closing server.');
      await this.server.close();
      process.exit(0);
    });
  }

  private loadAccounts() {
    // Nouvelle méthode : lire une variable d'environnement contenant le JSON des comptes
    const accountsJson = process.env.GITHUB_ACCOUNTS_JSON;
    if (accountsJson) {
      logger.info(`[GP-MCP][INDEX] Contenu brut de GITHUB_ACCOUNTS_JSON: ${accountsJson}`);
      try {
        this.accounts = JSON.parse(accountsJson);
        logger.info(`[GP-MCP][INDEX] ${this.accounts.length} compte(s) GitHub chargé(s) depuis GITHUB_ACCOUNTS_JSON.`);
      } catch (e) {
        logger.error('[GP-MCP][INDEX] Erreur de parsing de GITHUB_ACCOUNTS_JSON', {error: e});
      }
    } else if (process.env.GITHUB_TOKEN) {
      // Rétrocompatibilité
      logger.info('[GP-MCP][INDEX] Utilisation du GITHUB_TOKEN legacy.');
      this.accounts.push({ owner: 'default', token: process.env.GITHUB_TOKEN });
    } else {
      logger.warn('[GP-MCP][INDEX] Aucun compte GitHub configuré. Le MCP fonctionnera en mode non authentifié.');
    }
  }

  async run() {
    try {
      const transport = new StdioServerTransport();
      await this.server.connect(transport);
      logger.info('MCP server connected to stdio');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : 'No stack trace';
      console.error('CRITICAL: Error starting MCP server:', errorMessage, stack);
      logger.error('Error starting MCP server:', { error });
      process.exit(1);
    }
  }
}

try {
  const server = new GitHubProjectsServer();
  server.run();
} catch (error) {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : 'No stack trace';
  console.error('CRITICAL: Failed to initialize and run GitHubProjectsServer:', errorMessage, stack);
  logger.error('Failed to initialize and run GitHubProjectsServer:', { error });
  process.exit(1);
}

// Le transport Stdio maintiendra le processus en vie en écoutant stdin.