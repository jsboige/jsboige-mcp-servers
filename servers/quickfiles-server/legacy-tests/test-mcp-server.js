#!/usr/bin/env node
import { McpServer } from './node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js';
import { StdioServerTransport } from './node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js';
import { z } from 'zod';

async function main() {
  const server = new McpServer({
    name: 'test-server',
    version: '1.0.0',
  });

  server.registerTool('echo', {
    description: 'Echoes back the input',
    inputSchema: {
      message: z.string(),
    },
    handler: async ({ message }) => {
      return {
        content: [{
          type: 'text',
          text: message,
        }],
      };
    },
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Test server started successfully.');
}

main();