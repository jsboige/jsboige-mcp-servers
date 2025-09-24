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

    this.server = new Server({
      name: 'github-projects-mcp',
      version: '0.1.0',
    }, {
      capabilities: {
        tools: {},
        resources: {},
      },
    });
    setupErrorHandlers(this.server);
    setupTools(this.server, this.accounts);
    setupResources(this.server, this.accounts);

    console.log('[GP-MCP][INDEX] Serveur configuré avec succès.');
  }

  private loadAccounts() {
    const accounts: GitHubAccount[] = [];
    let index = 1;

    while (true) {
      const owner = process.env[`GITHUB_OWNER_${index}`];
      const token = process.env[`GITHUB_TOKEN_${index}`];

      if (!owner || !token) {
        break;
      }

      accounts.push({ owner, token });
      console.log(`[GP-MCP][ACCOUNTS] Compte ${index} chargé: ${owner}`);
      index++;
    }

    if (accounts.length === 0) {
      // Fallback: essayer sans index
      const owner = process.env.GITHUB_OWNER;
      const token = process.env.GITHUB_TOKEN;

      if (owner && token) {
        accounts.push({ owner, token });
        console.log(`[GP-MCP][ACCOUNTS] Compte unique chargé: ${owner}`);
      }
    }

    this.accounts = accounts;
    console.log(`[GP-MCP][ACCOUNTS] ${accounts.length} compte(s) chargé(s).`);
  }

  async run() {
    console.log('[GP-MCP][INDEX] Démarrage du serveur...');
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.log('[GP-MCP][INDEX] Serveur démarré et connecté.');
  }
}

const server = new GitHubProjectsServer();
server.run().catch((error) => {
  console.error('[GP-MCP][INDEX] Erreur fatale:', error);
  process.exit(1);
});