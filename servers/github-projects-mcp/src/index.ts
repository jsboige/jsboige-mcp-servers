import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
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
import logger from './logger.js';

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
      const port = process.env.PORT || 3000;
      const app = express();
      app.use(express.json());

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });
      await this.server.connect(transport);

      app.get('/', (req, res) => {
        res.status(200).json({ status: 'ok' });
      });

      app.post('/mcp', (req, res) => {
        logger.info('Received POST request on /mcp');
        logger.info('Headers:', req.headers);
        logger.info('Body:', req.body);
        transport.handleRequest(req, res, req.body);
      });
      
      app.get('/mcp', (req, res) => {
        transport.handleRequest(req, res);
      });

      app.listen(port, () => {
        logger.info(`MCP server listening on port ${port}`);
      });
    } catch (error) {
      logger.error('Error starting MCP server:', { error });
      process.exit(1);
    }
  }
}

const server = new GitHubProjectsServer();
server.run();