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

    // 1. Essayer le format indexé (GITHUB_OWNER_1, GITHUB_TOKEN_1, ...)
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

    // 2. Fallback : format simple (GITHUB_OWNER + GITHUB_TOKEN)
    if (accounts.length === 0) {
      const owner = process.env.GITHUB_OWNER || process.env.DEFAULT_USER;
      const token = process.env.GITHUB_TOKEN;

      if (owner && token) {
        accounts.push({ owner, token });
        console.log(`[GP-MCP][ACCOUNTS] Compte unique chargé: ${owner}`);
      }
    }

    // 3. Fallback final : format JSON legacy (GITHUB_ACCOUNTS_JSON)
    if (accounts.length === 0 && process.env.GITHUB_ACCOUNTS_JSON) {
      try {
        const jsonAccounts = JSON.parse(process.env.GITHUB_ACCOUNTS_JSON);
        if (Array.isArray(jsonAccounts)) {
          jsonAccounts.forEach((acc: any, idx: number) => {
            // Support both "user" (legacy .env format) and "owner" (mcp_settings.json format)
            const ownerValue = acc.owner || acc.user;
            if (ownerValue && acc.token) {
              accounts.push({ owner: ownerValue, token: acc.token });
              console.log(`[GP-MCP][ACCOUNTS] Compte ${idx + 1} chargé depuis JSON: ${ownerValue}`);
            }
          });
        }
      } catch (error) {
        console.error('[GP-MCP][ACCOUNTS] Erreur parsing GITHUB_ACCOUNTS_JSON:', error);
      }
    }

    this.accounts = accounts;
    console.log(`[GP-MCP][ACCOUNTS] ${accounts.length} compte(s) chargé(s) au total.`);

    if (accounts.length === 0) {
      console.warn('[GP-MCP][ACCOUNTS] ATTENTION: Aucun compte GitHub configuré !');
    }
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