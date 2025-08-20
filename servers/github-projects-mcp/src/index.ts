import fs from 'fs';
const logFilePath = 'D:/Dev/roo-extensions/mcps/internal/servers/github-projects-mcp/debug.log';
// Delete log file at startup to ensure clean logs for each run
if (fs.existsSync(logFilePath)) {
  fs.unlinkSync(logFilePath);
}
const log = (msg: string) => fs.appendFileSync(logFilePath, `[${new Date().toISOString()}] ${msg}\n`);

log('------------------------------------');
log('MCP Script Started');

import logger from './logger.js';

// Gestionnaires d'erreurs globaux pour intercepter les problèmes non gérés
// qui pourraient autrement faire planter le worker Jest de manière silencieuse.
process.on('unhandledRejection', (reason, promise) => {
  const reasonMessage = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? reason.stack : 'No stack trace';
  log(`CRITICAL: Unhandled Rejection: ${reasonMessage}`);
  console.error('CRITICAL: Unhandled Rejection:', reasonMessage, stack);
  logger.error('Unhandled Rejection caught globally:', { promise, reason: reasonMessage });
});

process.on('uncaughtException', (error) => {
  log(`CRITICAL: Uncaught Exception: ${error.message}`);
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
    log('Entering GitHubProjectsServer constructor');
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
    log('Entering run method');
    try {
      const transportType = 'http'; // Forcer http
      logger.info(`Using ${transportType} transport`);

      if (transportType === 'http') {
        const port = parseInt(process.env.PORT || '8080', 10);
        const app = express();
        app.use(express.json());

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
        });
        log('Attempting to connect to HTTP transport...');
        await this.server.connect(transport);
        log('Successfully connected to HTTP transport.');

        app.post('/mcp', (req, res) => {
          log('Received POST /mcp request');
          transport.handleRequest(req, res, req.body);
        });
        
        app.get('/mcp', (req, res) => {
          log('Received GET /mcp request');
          transport.handleRequest(req, res);
        });

        app.get('/health', (req, res) => {
          log('Received /health check');
          res.status(200).send('OK');
        });

        log(`Attempting to listen on port ${port}...`);
        app.listen(port, '0.0.0.0', () => {
          log(`MCP server is officially listening on 0.0.0.0:${port}`);
          logger.info(`MCP server listening on 0.0.0.0:${port}`);
        });
      } else {
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        log('MCP server connected to stdio');
        logger.info('MCP server connected to stdio');
        // Heartbeat pour signaler que le serveur est prêt
        console.log('MCP_SERVER_READY');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : 'No stack trace';
      log(`CRITICAL: Error starting MCP server: ${errorMessage}`);
      console.error('CRITICAL: Error starting MCP server:', errorMessage, stack);
      logger.error('Error starting MCP server:', { error });
      process.exit(1);
    }
    // Keep the process alive
    // setInterval(() => {}, 1 << 30); // Le transport Stdio gère déjà le cycle de vie.
  }
}

try {
  const server = new GitHubProjectsServer();
  server.run();
  log('GitHubProjectsServer instance created and run called');
} catch (error) {
  log(`Error during server initialization: ${error}`);
  const errorMessage = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : 'No stack trace';
  console.error('CRITICAL: Failed to initialize and run GitHubProjectsServer:', errorMessage, stack);
  logger.error('Failed to initialize and run GitHubProjectsServer:', { error });
  process.exit(1);
}

// Le transport Stdio maintiendra le processus en vie en écoutant stdin.
// Pour le transport HTTP, ou en cas de doute, on garde le processus en vie artificiellement pour le debug.
setInterval(() => {}, 1 << 30);
log('Infinite wait loop started to keep process alive.');