import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

// Import des outils modulaires
import { ReadMultipleFilesTool } from '../tools/read/readMultipleFiles.js';
import { ListDirectoryContentsTool } from '../tools/read/listDirectoryContents.js';
import { EditMultipleFilesTool } from '../tools/edit/editMultipleFiles.js';
import { SearchAndReplaceTool } from '../tools/edit/searchAndReplace.js';
import { DeleteFilesTool } from '../tools/file-ops/deleteFiles.js';
import { CopyFilesTool } from '../tools/file-ops/copyFiles.js';
import { MoveFilesTool } from '../tools/file-ops/moveFiles.js';
import { ExtractMarkdownStructureTool } from '../tools/analysis/extractMarkdownStructure.js';
import { SearchInFilesTool } from '../tools/analysis/searchInFiles.js';
import { RestartMcpServersTool } from '../tools/admin/restartMcpServers.js';

// Import des utilitaires
import { QuickFilesUtils } from './utils.js';

/**
 * Classe principale du serveur QuickFiles MCP
 * Gère l'initialisation et la coordination de tous les outils
 */
export class QuickFilesServer {
  private server: Server;
  private utils: QuickFilesUtils;
  
  // Instances des outils
  public readMultipleFilesTool!: ReadMultipleFilesTool;
  public listDirectoryContentsTool!: ListDirectoryContentsTool;
  public editMultipleFilesTool!: EditMultipleFilesTool;
  public searchAndReplaceTool!: SearchAndReplaceTool;
  public deleteFilesTool!: DeleteFilesTool;
  public copyFilesTool!: CopyFilesTool;
  public moveFilesTool!: MoveFilesTool;
  public extractMarkdownStructureTool!: ExtractMarkdownStructureTool;
  public searchInFilesTool!: SearchInFilesTool;
  public restartMcpServersTool!: RestartMcpServersTool;

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

    // Initialiser les utilitaires avec le répertoire de travail actuel
    this.utils = new QuickFilesUtils(process.cwd());

    // Initialiser tous les outils
    this.initializeTools();

    // Configurer les handlers
    this.setupHandlers();
  }

  /**
   * Initialise toutes les instances d'outils
   */
  private initializeTools(): void {
    this.readMultipleFilesTool = new ReadMultipleFilesTool(this.utils);
    this.listDirectoryContentsTool = new ListDirectoryContentsTool(this.utils);
    this.editMultipleFilesTool = new EditMultipleFilesTool(this.utils);
    this.searchAndReplaceTool = new SearchAndReplaceTool(this.utils);
    this.deleteFilesTool = new DeleteFilesTool(this.utils);
    this.copyFilesTool = new CopyFilesTool(this.utils);
    this.moveFilesTool = new MoveFilesTool(this.utils);
    this.extractMarkdownStructureTool = new ExtractMarkdownStructureTool(this.utils);
    this.searchInFilesTool = new SearchInFilesTool(this.utils);
    this.restartMcpServersTool = new RestartMcpServersTool(this.utils);
  }

  /**
   * Configure les handlers pour les requêtes MCP
   */
  private setupHandlers(): void {
    // Handler pour lister les outils disponibles
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          // Outils de lecture
          {
            name: 'read_multiple_files',
            description: '📖 Lit le contenu de plusieurs fichiers avec options avancées et numérotation des lignes. Supporte les extraits et limitations professionnelles.',
            inputSchema: {
              type: 'object',
              properties: {
                paths: {
                  type: 'array',
                  items: {
                    anyOf: [
                      { type: 'string' },
                      {
                        type: 'object',
                        properties: {
                          path: { type: 'string' },
                          excerpts: {
                            type: 'array',
                            items: {
                              type: 'object',
                              properties: {
                                start: { type: 'number' },
                                end: { type: 'number' }
                              },
                              required: ['start', 'end']
                            }
                          }
                        },
                        required: ['path']
                      }
                    ]
                  }
                },
                show_line_numbers: { type: 'boolean', default: true },
                max_lines_per_file: { type: 'number', default: 2000 },
                max_chars_per_file: { type: 'number', default: 160000 },
                max_total_lines: { type: 'number', default: 8000 },
                max_total_chars: { type: 'number', default: 400000 }
              },
              required: ['paths']
            }
          },
          {
            name: 'list_directory_contents',
            description: '📁 Liste le contenu des répertoires avec tri, filtrage et options récursives. Affiche les métadonnées et structure hiérarchique.',
            inputSchema: {
              type: 'object',
              properties: {
                paths: {
                  type: 'array',
                  items: {
                    anyOf: [
                      { type: 'string' },
                      {
                        type: 'object',
                        properties: {
                          path: { type: 'string' },
                          recursive: { type: 'boolean' },
                          max_depth: { type: 'number' },
                          file_pattern: { type: 'string' },
                          sort_by: { type: 'string', enum: ['name', 'size', 'modified'] },
                          sort_order: { type: 'string', enum: ['asc', 'desc'] }
                        },
                        required: ['path']
                      }
                    ]
                  }
                },
                max_lines: { type: 'number', default: 1000 },
                recursive: { type: 'boolean', default: false },
                max_depth: { type: 'number' },
                file_pattern: { type: 'string' },
                sort_by: { type: 'string', enum: ['name', 'size', 'modified'], default: 'name' },
                sort_order: { type: 'string', enum: ['asc', 'desc'], default: 'asc' }
              },
              required: ['paths']
            }
          },

          // Outils d'édition
          {
            name: 'edit_multiple_files',
            description: '✏️ Modifie le même pattern dans un ou plusieurs fichiers. Supporte regex, lignes spécifiques, rapport détaillé des modifications.',
            inputSchema: {
              type: 'object',
              properties: {
                files: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      path: { type: 'string' },
                      diffs: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            search: { type: 'string' },
                            replace: { type: 'string' },
                            start_line: { type: 'number' }
                          },
                          required: ['search', 'replace']
                        }
                      }
                    },
                    required: ['path', 'diffs']
                  }
                }
              },
              required: ['files']
            }
          },
          {
            name: 'search_and_replace',
            description: '🔄 Applique modifications regex/littéral sur un ou plusieurs fichiers avec prévisualisation, rapport des changements.',
            inputSchema: {
              type: 'object',
              properties: {
                search: { type: 'string' },
                replace: { type: 'string' },
                use_regex: { type: 'boolean', default: true },
                case_sensitive: { type: 'boolean', default: false },
                preview: { type: 'boolean', default: false },
                paths: {
                  type: 'array',
                  items: { type: 'string' }
                },
                files: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      path: { type: 'string' },
                      search: { type: 'string' },
                      replace: { type: 'string' }
                    },
                    required: ['path', 'search', 'replace']
                  }
                },
                file_pattern: { type: 'string' },
                recursive: { type: 'boolean', default: true }
              },
              required: ['search', 'replace']
            }
          },

          // Outils d'opérations fichiers
          {
            name: 'delete_files',
            description: '🗑️ Supprime un ou plusieurs fichiers avec rapport détaillé et validation de sécurité.',
            inputSchema: {
              type: 'object',
              properties: {
                paths: {
                  type: 'array',
                  items: { type: 'string' }
                }
              },
              required: ['paths']
            }
          },
          {
            name: 'copy_files',
            description: '📋 Copie un ou plusieurs fichiers avec options de transformation, gestion des conflits, patterns de renommage.',
            inputSchema: {
              type: 'object',
              properties: {
                operations: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      source: { type: 'string' },
                      destination: { type: 'string' },
                      transform: {
                        type: 'object',
                        properties: {
                          pattern: { type: 'string' },
                          replacement: { type: 'string' }
                        },
                        required: ['pattern', 'replacement']
                      },
                      conflict_strategy: { type: 'string', enum: ['overwrite', 'ignore', 'rename'], default: 'overwrite' }
                    },
                    required: ['source', 'destination']
                  }
                }
              },
              required: ['operations']
            }
          },
          {
            name: 'move_files',
            description: '📦 Déplace un ou plusieurs fichiers avec transformation, gestion des conflits, patterns de renommage.',
            inputSchema: {
              type: 'object',
              properties: {
                operations: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      source: { type: 'string' },
                      destination: { type: 'string' },
                      transform: {
                        type: 'object',
                        properties: {
                          pattern: { type: 'string' },
                          replacement: { type: 'string' }
                        },
                        required: ['pattern', 'replacement']
                      },
                      conflict_strategy: { type: 'string', enum: ['overwrite', 'ignore', 'rename'], default: 'overwrite' }
                    },
                    required: ['source', 'destination']
                  }
                }
              },
              required: ['operations']
            }
          },

          // Outils d'analyse
          {
            name: 'extract_markdown_structure',
            description: '📋 Génère TOC automatique. Analyse hiérarchie des titres, supporte contexte, numérotation des sections. Idéal pour documentation.',
            inputSchema: {
              type: 'object',
              properties: {
                paths: {
                  type: 'array',
                  items: { type: 'string' }
                },
                max_depth: { type: 'number', default: 6 },
                include_context: { type: 'boolean', default: false },
                context_lines: { type: 'number', default: 2 }
              },
              required: ['paths']
            }
          },
          {
            name: 'search_in_files',
            description: '🔍 Recherche des patterns dans les fichiers avec contexte et options de filtrage. Retourne les résultats avec lignes environnantes.',
            inputSchema: {
              type: 'object',
              properties: {
                paths: {
                  type: 'array',
                  items: { type: 'string' }
                },
                pattern: { type: 'string' },
                use_regex: { type: 'boolean', default: true },
                case_sensitive: { type: 'boolean', default: false },
                file_pattern: { type: 'string' },
                context_lines: { type: 'number', default: 2 },
                max_results_per_file: { type: 'number', default: 100 },
                max_total_results: { type: 'number', default: 1000 },
                recursive: { type: 'boolean', default: true }
              },
              required: ['paths', 'pattern']
            }
          },

          // Outils d'admin
          {
            name: 'restart_mcp_servers',
            description: '🔄 Redémarre les serveurs MCP via modification des paramètres. Supporte multiples serveurs.',
            inputSchema: {
              type: 'object',
              properties: {
                servers: {
                  type: 'array',
                  items: { type: 'string' }
                }
              },
              required: ['servers']
            }
          }
        ]
      };
    });

    // Handler pour exécuter les outils
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name } = request.params;

      try {
        switch (name) {
          // Outils de lecture
          case 'read_multiple_files':
            return await this.readMultipleFilesTool.handle(request);
          
          case 'list_directory_contents':
            return await this.listDirectoryContentsTool.handle(request);

          // Outils d'édition
          case 'edit_multiple_files':
            return await this.editMultipleFilesTool.handle(request);
          
          case 'search_and_replace':
            return await this.searchAndReplaceTool.handle(request);

          // Outils d'opérations fichiers
          case 'delete_files':
            return await this.deleteFilesTool.handle(request);
          
          case 'copy_files':
            return await this.copyFilesTool.handle(request);
          
          case 'move_files':
            return await this.moveFilesTool.handle(request);

          // Outils d'analyse
          case 'extract_markdown_structure':
            return await this.extractMarkdownStructureTool.handle(request);
          
          case 'search_in_files':
            return await this.searchInFilesTool.handle(request);

          // Outils d'admin
          case 'restart_mcp_servers':
            return await this.restartMcpServersTool.handle(request);

          default:
            throw new McpError(
              ErrorCode.MethodNotFound,
              `Unknown tool: ${name}`
            );
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: 'text',
              text: `Error: ${errorMessage}`
            }
          ],
          isError: true
        };
      }
    });
  }

  /**
   * Démarre le serveur MCP
   */
  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('QuickFiles MCP server running on stdio');
  }
}