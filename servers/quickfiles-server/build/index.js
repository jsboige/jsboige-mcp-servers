#!/usr/bin/env node

// Minimal MCP server implementation
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import * as fs from 'fs/promises';
import * as path from 'path';

class QuickFilesServer {
  constructor() {
    this.server = new Server(
      {
        name: 'quickfiles-server',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();
    
    // Gestion des erreurs
    this.server.onerror = (error) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'read_multiple_files',
          description: 'Lit plusieurs fichiers en une seule requête',
          inputSchema: {
            type: 'object',
            properties: {
              paths: {
                type: 'array',
                items: {
                  type: 'string'
                },
                description: 'Tableau des chemins de fichiers à lire',
              },
            },
            required: ['paths'],
          },
        },
        {
          name: 'list_directory_contents',
          description: 'Liste tous les fichiers et répertoires sous un chemin donné',
          inputSchema: {
            type: 'object',
            properties: {
              paths: {
                type: 'array',
                items: {
                  type: 'string'
                },
                description: 'Tableau des chemins de répertoires à lister',
              },
            },
            required: ['paths'],
          },
        },
        {
          name: 'delete_files',
          description: 'Supprime une liste de fichiers',
          inputSchema: {
            type: 'object',
            properties: {
              paths: {
                type: 'array',
                items: {
                  type: 'string'
                },
                description: 'Tableau des chemins de fichiers à supprimer',
              },
            },
            required: ['paths'],
          },
        },
        {
          name: 'edit_multiple_files',
          description: 'Édite plusieurs fichiers',
          inputSchema: {
            type: 'object',
            properties: {
              files: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    path: {
                      type: 'string',
                      description: 'Chemin du fichier à éditer',
                    },
                    diffs: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          search: {
                            type: 'string',
                            description: 'Texte à rechercher',
                          },
                          replace: {
                            type: 'string',
                            description: 'Texte de remplacement',
                          },
                        },
                        required: ['search', 'replace'],
                      },
                      description: 'Liste des diffs à appliquer au fichier',
                    },
                  },
                  required: ['path', 'diffs'],
                },
                description: 'Tableau des fichiers à éditer avec leurs diffs',
              },
            },
            required: ['files'],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      return {
        content: [
          {
            type: 'text',
            text: `Le serveur MCP quickfiles est en cours d'exécution, mais la fonctionnalité ${request.params.name} n'est pas encore implémentée. Veuillez compiler le serveur avec TypeScript pour accéder à toutes les fonctionnalités.`,
          },
        ],
      };
    });
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('QuickFiles MCP server running on stdio');
  }
}

const server = new QuickFilesServer();
server.run().catch(console.error);