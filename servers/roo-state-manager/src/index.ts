
/**
 * Serveur MCP Roo State Manager
 * Gestion unifiée des conversations et configurations Roo
 */

import 'dotenv/config';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import { fileURLToPath } from 'url';
import { resolve } from 'path';

import { RooStorageDetector } from './utils/roo-storage-detector.js';
import { RooStorageDetectionResult, ConversationSummary } from './types/conversation.js';
import { TaskTreeBuilder } from './utils/task-tree-builder.js';
import { SummaryGenerator, TaskTreeSummary } from './utils/summary-generator.js';
import { globalCacheManager } from './utils/cache-manager.js';
import { TaskTree, TaskType, TreeNode } from './types/task-tree.js';
import { indexTask } from './services/task-indexer.js';
import { searchTasks } from './services/task-searcher.js';
import { summarizeTask } from './services/task-summarizer.js';
import { extractTaskDetails } from './services/task-details-extractor.js';
 
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
          {
            name: 'index_task',
            description: 'Déclenche l\'indexation sémantique d\'une tâche spécifique',
            inputSchema: {
              type: 'object',
              properties: {
                taskId: {
                  type: 'string',
                  description: 'ID de la tâche à indexer',
                },
              },
              required: ['taskId'],
            },
          },
          {
            name: 'search_tasks_semantic',
            description: 'Recherche sémantiquement dans les conversations des tâches passées.',
            inputSchema: {
              type: 'object',
              properties: {
                query: {
                  type: 'string',
                  description: 'La requête de recherche en langage naturel.',
                },
                date_range: {
                  type: 'object',
                  properties: {
                    start_date: {
                      type: 'string',
                      format: 'date-time',
                      description: 'Date de début (ISO 8601)',
                    },
                    end_date: {
                      type: 'string',
                      format: 'date-time',
                      description: 'Date de fin (ISO 8601)',
                    },
                  },
                  description: 'Filtre optionnel pour restreindre la recherche à une période.',
                },
                limit: {
                  type: 'number',
                  default: 10,
                  description: 'Nombre maximum de résultats à retourner.',
                },
              },
              required: ['query'],
            },
          },
          {
            name: 'get_task_summary',
            description: 'Génère un résumé concis d\'une tâche spécifique en utilisant l\'IA.',
            inputSchema: {
              type: 'object',
              properties: {
                taskId: {
                  type: 'string',
                  description: 'ID de la tâche à résumer',
                },
              },
              required: ['taskId'],
            },
          },
          {
            name: 'get_task_details',
            description: 'Extrait des détails structurés d\'une tâche à partir de son historique de conversation.',
            inputSchema: {
              type: 'object',
              properties: {
                taskId: {
                  type: 'string',
                  description: 'ID de la tâche pour laquelle extraire les détails',
                },
              },
              required: ['taskId'],
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

          case 'index_task':
            return await this.handleIndexTask(args as { taskId: string });

          case 'search_tasks_semantic':
           return await this.handleSearchTasksSemantic(args as {
             query: string;
             date_range?: { start_date?: string; end_date?: string };
             limit?: number;
           });

        case 'get_task_summary':
          return await this.handleGetTaskSummary(args as { taskId: string });

        case 'get_task_details':
          return await this.handleGetTaskDetails(args as { taskId: string });

         // case 'browse_task_tree':
         //   return await this.handleBrowseTaskTree(args as {
          //     nodeId?: string;
          //     depth?: number;
          //     includeMetrics?: boolean;
          //   });
          //
          // case 'search_conversations':
          //   return await this.handleSearchConversations(args as {
          //     query?: string;
          //     filters?: any;
          //     limit?: number;
          //   });
          //
          // case 'analyze_task_relationships':
          //   return await this.handleAnalyzeTaskRelationships(args as {
          //     nodeId?: string;
          //     relationshipTypes?: string[];
          //     includeWeights?: boolean;
          //   });
          //
          // case 'generate_task_summary':
          //   return await this.handleGenerateTaskSummary(args as {
          //     level?: string;
          //     nodeId?: string;
          //     includeInsights?: boolean;
          //     includeMetrics?: boolean;
          //   });
          //
          // case 'rebuild_task_tree':
          //   return await this.handleRebuildTaskTree(args as {
          //     forceRebuild?: boolean;
          //     clearCache?: boolean;
          //     includeStats?: boolean;
          //   });

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

  private async handleDetectRooStorage() {
    const locations = await RooStorageDetector.detectStorageLocations();
    
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ locations }, null, 2),
        },
      ],
    };
  }

  private async handleGetStorageStats() {
    const locations = await RooStorageDetector.detectStorageLocations();
    let totalConversations = 0;
    let totalSize = 0;

    for (const loc of locations) {
        const stats = await RooStorageDetector.getStatsForPath(loc);
        totalConversations += stats.count;
        totalSize += stats.totalSize;
    }
    
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            totalLocations: locations.length,
            totalConversations,
            totalSize,
          }, null, 2),
        },
      ],
    };
  }

  private async handleFindConversation(args: { taskId: string }) {
    const conversation = await RooStorageDetector.findConversationById(args.taskId);
    
    return {
      content: [
        {
          type: 'text',
          text: conversation ? JSON.stringify(conversation, null, 2) : 'Conversation non trouvée',
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
    const locations = await RooStorageDetector.detectStorageLocations();
    let allConversations: ConversationSummary[] = [];

    const options = {
        limit: args.limit || 50,
        offset: 0, // Gérer la pagination complète serait plus complexe, on se limite à la première page
        sortBy: args.sortBy || 'lastActivity',
        sortOrder: args.sortOrder || 'desc'
    };

    for (const loc of locations) {
        // Note: la pagination est appliquée par emplacement, pas globalement.
        // C'est une simplification pour cette étape.
        const conversations = await RooStorageDetector.scanConversationsMetadata(loc, options);
        allConversations.push(...conversations);
    }

    // Le tri et le filtrage sont déjà appliqués dans scanConversationsMetadata
    // mais on doit re-trier/limiter le résultat global
    
    // Filtrage
    if (args.hasApiHistory !== undefined) {
      allConversations = allConversations.filter(conv => conv.hasApiHistory === args.hasApiHistory);
    }
    if (args.hasUiMessages !== undefined) {
      allConversations = allConversations.filter(conv => conv.hasUiMessages === args.hasUiMessages);
    }

    // Tri global
    allConversations.sort((a, b) => {
       let comparison = 0;
       switch(options.sortBy) {
           case 'lastActivity':
               comparison = new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime();
               break;
            case 'messageCount':
                comparison = b.messageCount - a.messageCount;
                break;
       }
       return options.sortOrder === 'asc' ? -comparison : comparison;
    });
    
    const limitedConversations = allConversations.slice(0, options.limit);


    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            total: allConversations.length, // Ce total est celui après scan, pas le total réel
            filtered: limitedConversations.length,
            conversations: limitedConversations,
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

  private async handleIndexTask(args: { taskId: string }) {
    try {
      const conversation = await RooStorageDetector.findConversationById(args.taskId);
      if (!conversation) {
        throw new Error(`Tâche avec ID ${args.taskId} non trouvée.`);
      }

      await indexTask(args.taskId, conversation.path);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: `Tâche ${args.taskId} indexée avec succès.`,
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new Error(`Erreur lors de l'indexation de la tâche ${args.taskId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async handleSearchTasksSemantic(args: {
   query: string;
   date_range?: { start_date?: string; end_date?: string };
   limit?: number;
  }) {
   try {
     const results = await searchTasks(args.query, {
       startDate: args.date_range?.start_date,
       endDate: args.date_range?.end_date,
       limit: args.limit,
     });

     return {
       content: [
         {
           type: 'text',
           text: JSON.stringify({
             results,
             count: results.length,
           }, null, 2),
         },
       ],
     };
   } catch (error) {
     throw new Error(`Erreur lors de la recherche sémantique: ${error instanceof Error ? error.message : String(error)}`);
   }
  }

 private async handleGetTaskSummary(args: { taskId: string }) {
   try {
     const conversation = await RooStorageDetector.findConversationById(args.taskId);
     if (!conversation) {
       throw new Error(`Tâche avec ID ${args.taskId} non trouvée.`);
     }

     const summary = await summarizeTask(args.taskId, conversation.path);

     return {
       content: [
         {
           type: 'text',
           text: JSON.stringify({ summary }, null, 2),
         },
       ],
     };
   } catch (error) {
     throw new Error(`Erreur lors de la génération du résumé pour la tâche ${args.taskId}: ${error instanceof Error ? error.message : String(error)}`);
   }
 }

 private async handleGetTaskDetails(args: { taskId: string }) {
   try {
     const conversation = await RooStorageDetector.findConversationById(args.taskId);
     if (!conversation) {
       throw new Error(`Tâche avec ID ${args.taskId} non trouvée.`);
     }

     const details = await extractTaskDetails(args.taskId, conversation.path);

     if (!details) {
       throw new Error(`Impossible d'extraire les détails pour la tâche ${args.taskId}.`);
     }

     return {
       content: [
         {
           type: 'text',
           text: JSON.stringify({ details }, null, 2),
         },
       ],
     };
   } catch (error) {
     throw new Error(`Erreur lors de l'extraction des détails pour la tâche ${args.taskId}: ${error instanceof Error ? error.message : String(error)}`);
   }
 }

 // Nouveaux gestionnaires pour les outils de la Phase 2

 private async handleBrowseTaskTree(args: {
   nodeId?: string;
    depth?: number;
    includeMetrics?: boolean;
  }) {
    try {
      const tree = await this.getOrBuildTaskTree();
      const depth = args.depth || 2;
      const includeMetrics = args.includeMetrics !== false;
      
      let targetNode: TreeNode;
      if (args.nodeId) {
        const foundNode = tree.index.byId.get(args.nodeId);
        if (!foundNode) {
          throw new Error(`Nœud avec ID ${args.nodeId} non trouvé`);
        }
        targetNode = foundNode;
      } else {
        targetNode = tree.root;
      }

      const result = this.buildNodeHierarchy(targetNode, depth, includeMetrics);
      
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new Error(`Erreur lors de la navigation: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async handleSearchConversations(args: {
    query?: string;
    filters?: any;
    limit?: number;
  }) {
    try {
      const limit = args.limit || 20;
      
      // Vérifier le cache d'abord
      if (args.query || args.filters) {
        const cachedResults = await globalCacheManager.getCachedSearchResults(
          args.query || '',
          args.filters || {}
        );
        if (cachedResults) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  results: cachedResults.slice(0, limit),
                  total: cachedResults.length,
                  cached: true
                }, null, 2),
              },
            ],
          };
        }
      }

      const tree = await this.getOrBuildTaskTree();
      const conversations = await this.getAllConversations();
      
      let filteredConversations = [...conversations];
      
      // Appliquer les filtres
      if (args.filters) {
        filteredConversations = this.applySearchFilters(filteredConversations, args.filters, tree);
      }
      
      // Appliquer la recherche textuelle
      if (args.query) {
        filteredConversations = this.applyTextSearch(filteredConversations, args.query);
      }
      
      // Mettre en cache les résultats
      if (args.query || args.filters) {
        await globalCacheManager.cacheSearchResults(
          args.query || '',
          args.filters || {},
          filteredConversations
        );
      }
      
      const results = filteredConversations.slice(0, limit);
      
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              results,
              total: filteredConversations.length,
              cached: false
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new Error(`Erreur lors de la recherche: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async handleAnalyzeTaskRelationships(args: {
    nodeId?: string;
    relationshipTypes?: string[];
    includeWeights?: boolean;
  }) {
    try {
      const tree = await this.getOrBuildTaskTree();
      const includeWeights = args.includeWeights !== false;
      
      let relationships = tree.relationships;
      
      // Filtrer par nœud si spécifié
      if (args.nodeId) {
        relationships = relationships.filter(rel =>
          rel.source === args.nodeId || rel.target === args.nodeId
        );
      }
      
      // Filtrer par types de relations si spécifié
      if (args.relationshipTypes && args.relationshipTypes.length > 0) {
        relationships = relationships.filter(rel =>
          args.relationshipTypes!.includes(rel.type)
        );
      }
      
      // Analyser les patterns
      const analysis = this.analyzeRelationshipPatterns(relationships, tree);
      
      const result = {
        relationships: includeWeights ? relationships : relationships.map(rel => ({
          ...rel,
          weight: undefined
        })),
        analysis,
        stats: {
          totalRelationships: relationships.length,
          byType: this.groupRelationshipsByType(relationships),
          averageWeight: relationships.reduce((sum, rel) => sum + rel.weight, 0) / relationships.length
        }
      };
      
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new Error(`Erreur lors de l'analyse des relations: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async handleGenerateTaskSummary(args: {
    level?: string;
    nodeId?: string;
    includeInsights?: boolean;
    includeMetrics?: boolean;
  }) {
    try {
      const tree = await this.getOrBuildTaskTree();
      const conversations = await this.getAllConversations();
      const level = args.level || 'global';
      const includeInsights = args.includeInsights !== false;
      const includeMetrics = args.includeMetrics !== false;
      
      let summary: any;
      
      switch (level) {
        case 'global':
          summary = SummaryGenerator.generateTaskTreeSummary(tree, conversations);
          break;
          
        case 'workspace':
        case 'project':
        case 'cluster':
        case 'conversation':
          if (!args.nodeId) {
            throw new Error(`nodeId requis pour le niveau ${level}`);
          }
          
          const node = tree.index.byId.get(args.nodeId);
          if (!node) {
            throw new Error(`Nœud avec ID ${args.nodeId} non trouvé`);
          }
          
          summary = this.generateNodeSummary(node, conversations, level);
          break;
          
        default:
          throw new Error(`Niveau de résumé non supporté: ${level}`);
      }
      
      // Filtrer selon les options
      if (!includeInsights && summary.insights) {
        delete summary.insights;
      }
      
      if (!includeMetrics) {
        summary = this.removeMetricsFromSummary(summary);
      }
      
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(summary, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new Error(`Erreur lors de la génération du résumé: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async handleRebuildTaskTree(args: {
    forceRebuild?: boolean;
    clearCache?: boolean;
    includeStats?: boolean;
  }) {
    try {
      const startTime = Date.now();
      const includeStats = args.includeStats !== false;
      
      // Vider le cache si demandé
      if (args.clearCache) {
        await globalCacheManager.clear();
      }
      
      // Vérifier si reconstruction nécessaire
      if (!args.forceRebuild) {
        const cachedTree = await globalCacheManager.getCachedTaskTree();
        if (cachedTree) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  message: 'Arbre déjà en cache, utilisez forceRebuild=true pour forcer la reconstruction',
                  cached: true,
                  tree: includeStats ? cachedTree : { metadata: cachedTree.metadata }
                }, null, 2),
              },
            ],
          };
        }
      }
      
      // Reconstruire l'arbre
      const conversations = await this.getAllConversations();
      const builder = new TaskTreeBuilder();
      const tree = await builder.buildCompleteTree(conversations);
      
      // Mettre en cache
      await globalCacheManager.cacheTaskTree(tree, conversations);
      
      const buildTime = Date.now() - startTime;
      
      const result = {
        message: 'Arbre reconstruit avec succès',
        buildTime: `${buildTime}ms`,
        stats: includeStats ? {
          totalNodes: tree.metadata.totalNodes,
          maxDepth: tree.metadata.maxDepth,
          qualityScore: tree.metadata.qualityScore,
          relationships: tree.relationships.length,
          cacheStats: globalCacheManager.getStats()
        } : undefined,
        tree: includeStats ? tree : { metadata: tree.metadata }
      };
      
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new Error(`Erreur lors de la reconstruction: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Méthodes utilitaires pour les nouveaux outils

  private async getOrBuildTaskTree(): Promise<TaskTree> {
    // Vérifier le cache d'abord
    const cachedTree = await globalCacheManager.getCachedTaskTree();
    if (cachedTree) {
      return cachedTree;
    }
    
    // Construire l'arbre
    const conversations = await this.getAllConversations();
    const builder = new TaskTreeBuilder();
    const tree = await builder.buildCompleteTree(conversations);
    
    // Mettre en cache
    await globalCacheManager.cacheTaskTree(tree, conversations);
    
    return tree;
  }

  private async getAllConversations(): Promise<ConversationSummary[]> {
    const detection = await RooStorageDetector.detectRooStorage();
    return detection.conversations;
  }

  private buildNodeHierarchy(node: TreeNode, depth: number, includeMetrics: boolean): any {
    const result: any = {
      id: node.id,
      name: node.name,
      type: node.type,
      path: node.path
    };
    
    if (includeMetrics) {
      result.metadata = node.metadata;
    }
    
    if (depth > 0 && node.children && node.children.length > 0) {
      result.children = node.children.map(child =>
        this.buildNodeHierarchy(child, depth - 1, includeMetrics)
      );
    }
    
    return result;
  }

  private applySearchFilters(conversations: ConversationSummary[], filters: any, tree: TaskTree): ConversationSummary[] {
    let filtered = [...conversations];
    
    if (filters.workspace) {
      filtered = filtered.filter(conv => conv.path?.includes(filters.workspace));
    }
    
    if (filters.technology) {
      filtered = filtered.filter(conv => {
        return conv.metadata?.files_in_context?.some(file =>
          file.path.includes(filters.technology)
        );
      });
    }
    
    if (filters.dateRange) {
      const start = new Date(filters.dateRange.start);
      const end = new Date(filters.dateRange.end);
      filtered = filtered.filter(conv => {
        const convDate = new Date(conv.lastActivity);
        return convDate >= start && convDate <= end;
      });
    }
    
    if (filters.minMessages) {
      filtered = filtered.filter(conv => conv.messageCount >= filters.minMessages);
    }
    
    return filtered;
  }

  private applyTextSearch(conversations: ConversationSummary[], query: string): ConversationSummary[] {
    const lowerQuery = query.toLowerCase();
    return conversations.filter(conv => {
      return (
        conv.taskId.toLowerCase().includes(lowerQuery) ||
        conv.path.toLowerCase().includes(lowerQuery) ||
        conv.metadata?.title?.toLowerCase().includes(lowerQuery) ||
        conv.metadata?.description?.toLowerCase().includes(lowerQuery)
      );
    });
  }

  private analyzeRelationshipPatterns(relationships: any[], tree: TaskTree): any {
    return {
      strongestRelationships: relationships
        .sort((a, b) => b.weight - a.weight)
        .slice(0, 5),
      clusters: [],
      patterns: []
    };
  }

  private groupRelationshipsByType(relationships: any[]): Record<string, number> {
    const groups: Record<string, number> = {};
    relationships.forEach(rel => {
      groups[rel.type] = (groups[rel.type] || 0) + 1;
    });
    return groups;
  }

  private generateNodeSummary(node: TreeNode, conversations: ConversationSummary[], level: string): any {
    return { id: node.id, name: node.name, type: node.type, level };
  }

  private removeMetricsFromSummary(summary: any): any {
    const cleaned = { ...summary };
    if (cleaned.metrics) delete cleaned.metrics;
    if (cleaned.globalMetrics) delete cleaned.globalMetrics;
    return cleaned;
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
    setInterval(() => {}, 1 << 30);
  }
}

// Démarrage du serveur
// La vérification du module principal est retirée pour forcer le démarrage inconditionnel
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

export { RooStateManagerServer };