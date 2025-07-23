
/**
 * Serveur MCP Roo State Manager
 * Gestion unifiée des conversations et configurations Roo
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode
} from '@modelcontextprotocol/sdk/types.js';
import { fileURLToPath } from 'url';
import { resolve } from 'path';

import { RooStorageDetector } from './utils/roo-storage-detector.js';
import { RooStorageDetectionResult, ConversationSummary } from './types/conversation.js';

class RooStateManagerServer {
  private server: Server;

  constructor() {
    this.server = new Server(
      {
        name: 'roo-state-manager',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();
    this.setupErrorHandling();
  }

  private setupToolHandlers(): void {
    // Liste des outils disponibles
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: 'detect_roo_storage',
            description: 'Détecte automatiquement les emplacements de stockage Roo et scanne les conversations existantes',
            inputSchema: {
              type: 'object',
              properties: {},
              required: [],
            },
          },
          {
            name: 'get_storage_stats',
            description: 'Obtient les statistiques globales du stockage Roo (nombre de conversations, taille, etc.)',
            inputSchema: {
              type: 'object',
              properties: {},
              required: [],
            },
          },
          {
            name: 'find_conversation',
            description: 'Recherche une conversation spécifique par son ID de tâche',
            inputSchema: {
              type: 'object',
              properties: {
                taskId: {
                  type: 'string',
                  description: 'ID de la tâche/conversation à rechercher',
                },
              },
              required: ['taskId'],
            },
          },
          {
            name: 'list_conversations',
            description: 'Liste toutes les conversations détectées avec filtres optionnels',
            inputSchema: {
              type: 'object',
              properties: {
                limit: {
                  type: 'number',
                  description: 'Nombre maximum de conversations à retourner',
                  default: 50,
                },
                sortBy: {
                  type: 'string',
                  enum: ['lastActivity', 'messageCount', 'size'],
                  description: 'Critère de tri',
                  default: 'lastActivity',
                },
                sortOrder: {
                  type: 'string',
                  enum: ['asc', 'desc'],
                  description: 'Ordre de tri',
                  default: 'desc',
                },
                hasApiHistory: {
                  type: 'boolean',
                  description: 'Filtrer par présence d\'historique API',
                },
                hasUiMessages: {
                  type: 'boolean',
                  description: 'Filtrer par présence de messages UI',
                },
              },
              required: [],
            },
          },
          {
            name: 'validate_custom_path',
            description: 'Valide un chemin de stockage Roo personnalisé',
            inputSchema: {
              type: 'object',
              properties: {
                path: {
                  type: 'string',
                  description: 'Chemin à valider',
                },
              },
              required: ['path'],
            },
          },
          // {
          //   name: 'browse_task_tree',
          //   description: 'Navigation hiérarchique dans l\'arborescence de tâches construite',
          //   inputSchema: {
          //     type: 'object',
          //     properties: {
          //       nodeId: {
          //         type: 'string',
          //         description: 'ID du nœud à explorer (optionnel, racine par défaut)',
          //       },
          //       depth: {
          //         type: 'number',
          //         description: 'Profondeur d\'exploration (défaut: 2)',
          //         default: 2,
          //       },
          //       includeMetrics: {
          //         type: 'boolean',
          //         description: 'Inclure les métriques détaillées',
          //         default: true,
          //       },
          //     },
          //     required: [],
          //   },
          // },
          // {
          //   name: 'search_conversations',
          //   description: 'Recherche contextuelle avec filtres avancés dans l\'arborescence',
          //   inputSchema: {
          //     type: 'object',
          //     properties: {
          //       query: {
          //         type: 'string',
          //         description: 'Terme de recherche',
          //       },
          //       filters: {
          //         type: 'object',
          //         properties: {
          //           workspace: {
          //             type: 'string',
          //             description: 'Filtrer par workspace',
          //           },
          //           project: {
          //             type: 'string',
          //             description: 'Filtrer par projet',
          //           },
          //           technology: {
          //             type: 'string',
          //             description: 'Filtrer par technologie',
          //           },
          //           dateRange: {
          //             type: 'object',
          //             properties: {
          //               start: { type: 'string' },
          //               end: { type: 'string' },
          //             },
          //           },
          //           minMessages: {
          //             type: 'number',
          //             description: 'Nombre minimum de messages',
          //           },
          //         },
          //       },
          //       limit: {
          //         type: 'number',
          //         description: 'Nombre maximum de résultats',
          //         default: 20,
          //       },
          //     },
          //     required: [],
          //   },
          // },
          // {
          //   name: 'analyze_task_relationships',
          //   description: 'Analyse des relations entre tâches et détection de patterns',
          //   inputSchema: {
          //     type: 'object',
          //     properties: {
          //       nodeId: {
          //         type: 'string',
          //         description: 'ID du nœud à analyser (optionnel)',
          //       },
          //       relationshipTypes: {
          //         type: 'array',
          //         items: {
          //           type: 'string',
          //           enum: ['parent_child', 'file_dependency', 'temporal', 'semantic', 'technology'],
          //         },
          //         description: 'Types de relations à analyser',
          //       },
          //       includeWeights: {
          //         type: 'boolean',
          //         description: 'Inclure les poids des relations',
          //         default: true,
          //       },
          //     },
          //     required: [],
          //   },
          // },
          // {
          //   name: 'generate_task_summary',
          //   description: 'Génération de résumés automatiques par niveau',
          //   inputSchema: {
          //     type: 'object',
          //     properties: {
          //       level: {
          //         type: 'string',
          //         enum: ['workspace', 'project', 'cluster', 'conversation', 'global'],
          //         description: 'Niveau de résumé à générer',
          //         default: 'global',
          //       },
          //       nodeId: {
          //         type: 'string',
          //         description: 'ID du nœud spécifique (optionnel)',
          //       },
          //       includeInsights: {
          //         type: 'boolean',
          //         description: 'Inclure les insights et recommandations',
          //         default: true,
          //       },
          //       includeMetrics: {
          //         type: 'boolean',
          //         description: 'Inclure les métriques détaillées',
          //         default: true,
          //       },
          //     },
          //     required: [],
          //   },
          // },
          // {
          //   name: 'rebuild_task_tree',
          //   description: 'Reconstruction de l\'arbre avec gestion du cache',
          //   inputSchema: {
          //     type: 'object',
          //     properties: {
          //       forceRebuild: {
          //         type: 'boolean',
          //         description: 'Forcer la reconstruction même si le cache est valide',
          //         default: false,
          //       },
  
          //       clearCache: {
          //         type: 'boolean',
          //         description: 'Vider le cache avant reconstruction',
          //         default: false,
          //       },
          //       includeStats: {
          //         type: 'boolean',
          //         description: 'Inclure les statistiques de construction',
          //         default: true,
          //       },
          //     },
          //     required: [],
          //   },
          // },
        ] as any[],
      };
    });

    // Gestionnaire d'exécution des outils
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      // Basic input validation
      if (args === undefined || typeof args !== 'object' || args === null) {
        // Envoie une erreur si `arguments` est manquant ou n'est pas un objet
        throw new McpError(ErrorCode.InvalidRequest, 'The "arguments" parameter must be a valid JSON object.');
      }

      try {
        switch (name) {
          case 'detect_roo_storage':
            return await this.handleDetectRooStorage();

          case 'get_storage_stats':
            return await this.handleGetStorageStats();

          case 'find_conversation':
            return await this.handleFindConversation(args as { taskId: string });

          case 'list_conversations':
            return await this.handleListConversations(args as {
              limit?: number;
              sortBy?: 'lastActivity' | 'messageCount' | 'size';
              sortOrder?: 'asc' | 'desc';
              hasApiHistory?: boolean;
              hasUiMessages?: boolean;
            });

          case 'validate_custom_path':
            return await this.handleValidateCustomPath(args as { path: string });


          default:
            throw new Error(`Outil inconnu: ${name}`);
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: 'text',
              text: `Erreur lors de l'exécution de ${name}: ${errorMessage}`,
            },
          ],
          isError: true,
        };
      }
    });
  }

  public async handleDetectRooStorage() {
    const result = await RooStorageDetector.detectRooStorage();
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }

  private async handleGetStorageStats() {
    const stats = await RooStorageDetector.getStorageStats();
    
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(stats, null, 2),
        },
      ],
    };
  }

  private async handleFindConversation(args: { taskId: string }) {
    const conversationSummary = await RooStorageDetector.findConversation(args.taskId);
    return {
      content: [
        {
          type: 'text',
          text: conversationSummary ? JSON.stringify(conversationSummary, null, 2) : JSON.stringify({ error: 'Conversation non trouvée' }, null, 2),
        },
      ],
    };
  }

  private async handleListConversations(args: {
    limit?: number;
    sortBy?: 'lastActivity' | 'messageCount' | 'size';
    sortOrder?: 'asc' | 'desc';
    hasApiHistory?: boolean;
    hasUiMessages?: boolean;
  }) {
    const { conversations, totalConversations } = await RooStorageDetector.detectRooStorage();
    
    let filteredConversations = conversations;

    // Filtrage
    if (args.hasApiHistory !== undefined) {
      filteredConversations = filteredConversations.filter(c => c.hasApiHistory === args.hasApiHistory);
    }
    if (args.hasUiMessages !== undefined) {
      filteredConversations = filteredConversations.filter(c => c.hasUiMessages === args.hasUiMessages);
    }

    // Tri
    const sortBy = args.sortBy || 'lastActivity';
    const sortOrder = args.sortOrder || 'desc';
    filteredConversations.sort((a, b) => {
      let valA, valB;
      switch (sortBy) {
        case 'messageCount':
          valA = a.messageCount;
          valB = b.messageCount;
          break;
        case 'size':
          valA = a.size;
          valB = b.size;
          break;
        case 'lastActivity':
        default:
          valA = new Date(a.lastActivity).getTime();
          valB = new Date(b.lastActivity).getTime();
          break;
      }
      return sortOrder === 'asc' ? valA - valB : valB - valA;
    });

    // Pagination
    const limit = args.limit || 50;
    const paginatedConversations = filteredConversations.slice(0, limit);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            total: totalConversations,
            filtered: paginatedConversations.length,
            conversations: paginatedConversations,
          }, null, 2),
        },
      ],
    };
  }

  private async handleValidateCustomPath(args: { path: string }) {
    const isValid = await RooStorageDetector.validateCustomPath(args.path);
    
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            path: args.path,
            isValid,
            message: isValid ? 'Chemin valide' : 'Chemin invalide ou répertoire tasks non trouvé',
          }, null, 2),
        },
      ],
    };
  }


  private setupErrorHandling(): void {
    this.server.onerror = (error) => {
      console.error('[MCP Error]', error);
    };

    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Serveur MCP Roo State Manager démarré');
    // Keep the process alive
    setInterval(() => {}, 1000 * 60 * 60); // Keep alive for 1 hour
  }

  public async close(): Promise<void> {
    await this.server.close();
  }
}

// Démarrage du serveur uniquement si le script est exécuté directement
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const server = new RooStateManagerServer();
    server.run().catch((error) => {
      console.error('Erreur fatale pendant l\'exécution:', error);
      process.exit(1);
    });
  } catch (error) {
    console.error('Erreur fatale à l\'initialisation:', error);
    process.exit(1);
  }
}

export { RooStateManagerServer };