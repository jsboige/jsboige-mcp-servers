#!/usr/bin/env node
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

// Nouvelle interface pour les extraits de fichiers
interface LineRange {
  start: number;
  end: number;
}

interface FileWithExcerpts {
  path: string;
  excerpts?: LineRange[];
}

// Interface modifiée pour prendre en charge les extraits
interface ReadMultipleFilesArgs {
  paths: string[] | FileWithExcerpts[];
  show_line_numbers?: boolean;
  max_lines_per_file?: number;
}

// Interface pour le listage de répertoire
interface DirectoryToList {
  path: string;
  recursive?: boolean;
}

interface ListDirectoryContentsArgs {
  paths: string[] | DirectoryToList[];
}

// Fonction de validation mise à jour pour les arguments de read_multiple_files
const isValidReadMultipleFilesArgs = (args: any): args is ReadMultipleFilesArgs => {
  if (typeof args !== 'object' || args === null) return false;
  
  // Vérification du tableau paths
  if (!Array.isArray(args.paths)) return false;
  
  // Vérification de chaque élément du tableau paths
  for (const item of args.paths) {
    if (typeof item === 'string') {
      // Format simple: chemin de fichier
      continue;
    } else if (typeof item === 'object' && item !== null) {
      // Format avancé: objet avec path et excerpts
      if (typeof item.path !== 'string') return false;
      
      // Vérification des excerpts si présents
      if (item.excerpts !== undefined) {
        if (!Array.isArray(item.excerpts)) return false;
        
        for (const excerpt of item.excerpts) {
          if (typeof excerpt !== 'object' || excerpt === null) return false;
          if (typeof excerpt.start !== 'number' || typeof excerpt.end !== 'number') return false;
          if (excerpt.start < 1 || excerpt.end < excerpt.start) return false;
        }
      }
    } else {
      return false;
    }
  }
  
  // Vérification des autres paramètres
  if (args.show_line_numbers !== undefined && typeof args.show_line_numbers !== 'boolean') return false;
  if (args.max_lines_per_file !== undefined && typeof args.max_lines_per_file !== 'number') return false;
  
  return true;
};

// Fonction de validation pour les arguments de list_directory_contents
const isValidListDirectoryContentsArgs = (args: any): args is ListDirectoryContentsArgs => {
  if (typeof args !== 'object' || args === null) return false;
  
  // Vérification du tableau paths
  if (!Array.isArray(args.paths)) return false;
  
  // Vérification de chaque élément du tableau paths
  for (const item of args.paths) {
    if (typeof item === 'string') {
      // Format simple: chemin de répertoire
      continue;
    } else if (typeof item === 'object' && item !== null) {
      // Format avancé: objet avec path et recursive
      if (typeof item.path !== 'string') return false;
      if (item.recursive !== undefined && typeof item.recursive !== 'boolean') return false;
    } else {
      return false;
    }
  }
  
  return true;
};

class QuickFilesServer {
  private server: Server;

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

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'read_multiple_files',
          description: 'Lit plusieurs fichiers en une seule requête avec numérotation de lignes optionnelle et extraits de fichiers',
          inputSchema: {
            type: 'object',
            properties: {
              paths: {
                oneOf: [
                  {
                    type: 'array',
                    items: {
                      type: 'string'
                    },
                    description: 'Tableau des chemins de fichiers à lire',
                  },
                  {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        path: {
                          type: 'string',
                          description: 'Chemin du fichier à lire',
                        },
                        excerpts: {
                          type: 'array',
                          items: {
                            type: 'object',
                            properties: {
                              start: {
                                type: 'number',
                                description: 'Numéro de la première ligne de l\'extrait (commençant à 1)',
                              },
                              end: {
                                type: 'number',
                                description: 'Numéro de la dernière ligne de l\'extrait (incluse)',
                              },
                            },
                            required: ['start', 'end'],
                          },
                          description: 'Liste des extraits à lire dans le fichier',
                        },
                      },
                      required: ['path'],
                    },
                    description: 'Tableau des fichiers avec extraits à lire',
                  },
                ],
                description: 'Chemins des fichiers à lire (format simple ou avec extraits)',
              },
              show_line_numbers: {
                type: 'boolean',
                description: 'Afficher les numéros de ligne',
                default: false,
              },
              max_lines_per_file: {
                type: 'number',
                description: 'Nombre maximum de lignes à afficher par fichier (optionnel)',
              },
            },
            required: ['paths'],
          },
        },
        {
          name: 'list_directory_contents',
          description: 'Liste tous les fichiers et répertoires sous un chemin donné, avec la taille des fichiers',
          inputSchema: {
            type: 'object',
            properties: {
              paths: {
                oneOf: [
                  {
                    type: 'array',
                    items: {
                      type: 'string'
                    },
                    description: 'Tableau des chemins de répertoires à lister',
                  },
                  {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        path: {
                          type: 'string',
                          description: 'Chemin du répertoire à lister',
                        },
                        recursive: {
                          type: 'boolean',
                          description: 'Lister récursivement les sous-répertoires',
                          default: true,
                        },
                      },
                      required: ['path'],
                    },
                    description: 'Tableau des répertoires à lister avec options',
                  },
                ],
                description: 'Chemins des répertoires à lister (format simple ou avec options)',
              },
            },
            required: ['paths'],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name === 'read_multiple_files') {
        return this.handleReadMultipleFiles(request);
      } else if (request.params.name === 'list_directory_contents') {
        return this.handleListDirectoryContents(request);
      } else {
        throw new McpError(
          ErrorCode.MethodNotFound,
          `Outil inconnu: ${request.params.name}`
        );
      }
    });
  }

  private async handleReadMultipleFiles(request: any) {
    if (!isValidReadMultipleFilesArgs(request.params.arguments)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Paramètres invalides pour read_multiple_files'
      );
    }

    const { paths, show_line_numbers = false, max_lines_per_file } = request.params.arguments;

    try {
      const results = await Promise.all(
        paths.map(async (item: string | FileWithExcerpts) => {
          // Déterminer le chemin du fichier et les extraits
          const filePath = typeof item === 'string' ? item : item.path;
          const excerpts = typeof item === 'object' && item.excerpts ? item.excerpts : undefined;
          
          try {
            const content = await fs.readFile(filePath, 'utf-8');
            let lines = content.split('\n');
            
            // Appliquer les extraits si spécifiés
            if (excerpts && excerpts.length > 0) {
              const extractedLines: string[] = [];
              
              for (const excerpt of excerpts) {
                // Ajuster les indices pour correspondre au tableau 0-indexé
                const startIdx = Math.max(0, excerpt.start - 1);
                const endIdx = Math.min(lines.length - 1, excerpt.end - 1);
                
                if (extractedLines.length > 0) {
                  extractedLines.push('...');
                }
                
                extractedLines.push(
                  ...lines.slice(startIdx, endIdx + 1).map((line, idx) => {
                    return show_line_numbers ? `${startIdx + idx + 1} | ${line}` : line;
                  })
                );
              }
              
              lines = extractedLines;
            } else {
              // Appliquer la limite de lignes si spécifiée
              if (max_lines_per_file && lines.length > max_lines_per_file) {
                lines = lines.slice(0, max_lines_per_file);
                lines.push(`... (${lines.length - max_lines_per_file} lignes supplémentaires non affichées)`);
              }
              
              // Appliquer la numérotation de lignes si demandée
              if (show_line_numbers) {
                lines = lines.map((line, idx) => `${idx + 1} | ${line}`);
              }
            }
            
            return {
              path: filePath,
              exists: true,
              content: lines.join('\n'),
              error: null,
            };
          } catch (error) {
            return {
              path: filePath,
              exists: false,
              content: null,
              error: `Erreur lors de la lecture du fichier: ${(error as Error).message}`,
            };
          }
        })
      );

      // Formatage de la réponse pour une meilleure lisibilité
      const formattedResponse = results.map(result => {
        if (result.exists) {
          return `## Fichier: ${result.path}\n\`\`\`\n${result.content}\n\`\`\`\n`;
        } else {
          return `## Fichier: ${result.path}\n**ERREUR**: ${result.error}\n`;
        }
      }).join('\n');

      return {
        content: [
          {
            type: 'text',
            text: formattedResponse,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Erreur lors de la lecture des fichiers: ${(error as Error).message}`,
          },
        ],
        isError: true,
      };
    }
  }

  private async handleListDirectoryContents(request: any) {
    if (!isValidListDirectoryContentsArgs(request.params.arguments)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Paramètres invalides pour list_directory_contents'
      );
    }

    const { paths } = request.params.arguments;

    try {
      const results = await Promise.all(
        paths.map(async (item: string | DirectoryToList) => {
          // Déterminer le chemin du répertoire et l'option recursive
          const dirPath = typeof item === 'string' ? item : item.path;
          const recursive = typeof item === 'object' && item.recursive !== undefined ? item.recursive : true;
          
          try {
            // Vérifier que le chemin existe et est un répertoire
            const stats = await fs.stat(dirPath);
            if (!stats.isDirectory()) {
              return {
                path: dirPath,
                exists: false,
                error: `Le chemin spécifié n'est pas un répertoire: ${dirPath}`,
              };
            }

            // Lister le contenu du répertoire
            const contents = await this.listDirectoryContentsRecursive(dirPath, recursive);
            
            return {
              path: dirPath,
              exists: true,
              contents,
              error: null,
            };
          } catch (error) {
            return {
              path: dirPath,
              exists: false,
              contents: null,
              error: `Erreur lors du listage du répertoire: ${(error as Error).message}`,
            };
          }
        })
      );

      // Formatage de la réponse pour une meilleure lisibilité
      const formattedResponse = results.map(result => {
        if (result.exists) {
          return this.formatDirectoryContents(result.path, result.contents);
        } else {
          return `## Répertoire: ${result.path}\n**ERREUR**: ${result.error}\n`;
        }
      }).join('\n');

      return {
        content: [
          {
            type: 'text',
            text: formattedResponse,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Erreur lors du listage des répertoires: ${(error as Error).message}`,
          },
        ],
        isError: true,
      };
    }
  }

  private formatDirectoryContents(dirPath: string, contents: any[]): string {
    let result = `## Répertoire: ${dirPath}\n`;
    
    // Fonction récursive pour formater le contenu
    const formatContents = (items: any[], indent: string = ''): string => {
      let output = '';
      
      for (const item of items) {
        if (item.type === 'directory') {
          output += `${indent}📁 ${item.name}/\n`;
          
          if (item.children && item.children.length > 0) {
            output += formatContents(item.children, indent + '  ');
          }
        } else {
          const sizeStr = this.formatFileSize(item.size);
          const lineCountStr = item.lineCount ? ` (${item.lineCount} lignes)` : '';
          output += `${indent}📄 ${item.name} - ${sizeStr}${lineCountStr}\n`;
        }
      }
      
      return output;
    };
    
    result += formatContents(contents);
    return result;
  }

  private formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }

  private async listDirectoryContentsRecursive(dirPath: string, recursive: boolean): Promise<any> {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const result: any[] = [];

    for (const entry of entries) {
      const entryPath = path.join(dirPath, entry.name);
      const stats = await fs.stat(entryPath);
      
      if (entry.isDirectory()) {
        const item = {
          name: entry.name,
          path: entryPath,
          type: 'directory' as const,
          size: stats.size,
          modified: stats.mtime.toISOString(),
          children: recursive ? await this.listDirectoryContentsRecursive(entryPath, recursive) : [],
        };
        result.push(item);
      } else {
        // Compter le nombre de lignes pour les fichiers texte
        let lineCount: number | undefined = undefined;
        
        try {
          // Vérifier si c'est probablement un fichier texte par l'extension
          const textFileExtensions = ['.txt', '.md', '.js', '.ts', '.html', '.css', '.json', '.xml', '.yaml', '.yml', '.py', '.java', '.c', '.cpp', '.h', '.cs', '.php', '.rb', '.go', '.rs', '.swift', '.kt', '.sh', '.bat', '.ps1'];
          const ext = path.extname(entry.name).toLowerCase();
          
          if (textFileExtensions.includes(ext) && stats.size < 10 * 1024 * 1024) { // Limiter à 10 Mo
            const content = await fs.readFile(entryPath, 'utf-8');
            lineCount = content.split('\n').length;
          }
        } catch (error) {
          // Ignorer les erreurs de lecture de fichier
        }
        
        const item = {
          name: entry.name,
          path: entryPath,
          type: 'file' as const,
          size: stats.size,
          modified: stats.mtime.toISOString(),
          lineCount,
        };
        result.push(item);
      }
    }

    return result;
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('QuickFiles MCP server running on stdio');
  }
}

const server = new QuickFilesServer();
server.run().catch(console.error);
