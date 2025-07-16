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

class GitHubProjectsServer {
  private server: Server;

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

    setupTools(this.server);
    setupResources(this.server);
    setupErrorHandlers(this.server);
    
    this.server.onerror = (error) => logger.error('[MCP Error]', { error });
    process.on('SIGINT', async () => {
      logger.info('SIGINT received, closing server.');
      await this.server.close();
      process.exit(0);
    });
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
  }
}

const server = new GitHubProjectsServer();
server.run();