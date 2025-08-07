import logger from './logger.js';

// Gestionnaires d'erreurs globaux pour intercepter les problèmes non gérés
// qui pourraient autrement faire planter le worker Jest de manière silencieuse.
process.on('unhandledRejection', (reason, promise) => {
  const reasonMessage = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? reason.stack : 'No stack trace';
  console.error('CRITICAL: Unhandled Rejection:', reasonMessage, stack);
  logger.error('Unhandled Rejection caught globally:', { promise, reason: reasonMessage });
});

process.on('uncaughtException', (error) => {
  console.error('CRITICAL: Uncaught Exception:', error.message, error.stack);
  logger.error('Uncaught Exception caught globally:', { message: error.message, stack: error.stack });
  // Il est généralement recommandé de quitter après une exception non gérée pour éviter un état imprévisible.
  process.exit(1);
});

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import express from 'express';
import { randomUUID } from 'node:crypto';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { setupTools } from './tools.js';
import { setupResources } from './resources.js';
import { setupErrorHandlers } from './utils/errorHandlers.js';

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
      const transportType = process.env.MCP_TRANSPORT || 'http';
      logger.info(`Using ${transportType} transport`);

      if (transportType === 'http') {
        const port = process.env.PORT || 3000;
        const app = express();
        app.use(express.json());

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
        });
        await this.server.connect(transport);

        app.post('/mcp', (req, res) => {
          transport.handleRequest(req, res, req.body);
        });
        
        app.get('/mcp', (req, res) => {
          transport.handleRequest(req, res);
        });

        app.listen(port, () => {
          logger.info(`MCP server listening on port ${port}`);
        });
      } else {
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        logger.info('MCP server connected to stdio');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : 'No stack trace';
      console.error('CRITICAL: Error starting MCP server:', errorMessage, stack);
      logger.error('Error starting MCP server:', { error });
      process.exit(1);
    }
    // Keep the process alive
    setInterval(() => {}, 1 << 30);
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