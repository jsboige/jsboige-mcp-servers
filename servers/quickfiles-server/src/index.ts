#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { pathToFileURL } from 'url';
import { z } from 'zod';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { glob } from 'glob';

// Zod Schemas
const LineRangeSchema = z.object({
  start: z.number(),
  end: z.number(),
});

const FileWithExcerptsSchema = z.object({
  path: z.string(),
  excerpts: z.array(LineRangeSchema).optional(),
});

const ReadMultipleFilesArgsSchema = z.object({
  paths: z.array(z.union([z.string(), FileWithExcerptsSchema])),
  show_line_numbers: z.boolean().optional().default(true),
  max_lines_per_file: z.number().optional().default(2000),
  max_chars_per_file: z.number().optional().default(160000),
  max_total_lines: z.number().optional().default(8000),
  max_total_chars: z.number().optional().default(400000),
});

const ListDirectoryContentsArgsSchema = z.object({
  paths: z.array(z.union([z.string(), z.object({
      path: z.string(),
      recursive: z.boolean().optional(),
      max_depth: z.number().optional(),
      file_pattern: z.string().optional(),
      sort_by: z.enum(['name', 'size', 'modified']).optional(),
      sort_order: z.enum(['asc', 'desc']).optional()
  })])),
  max_lines: z.number().optional().default(1000),
  recursive: z.boolean().optional().default(false),
  max_depth: z.number().optional(),
  file_pattern: z.string().optional(),
  sort_by: z.enum(['name', 'size', 'modified']).optional().default('name'),
  sort_order: z.enum(['asc', 'desc']).optional().default('asc')
});

const DeleteFilesArgsSchema = z.object({
  paths: z.array(z.string()),
});

const EditMultipleFilesArgsSchema = z.object({
  files: z.array(z.object({
      path: z.string(),
      diffs: z.array(z.object({
          search: z.string(),
          replace: z.string(),
          start_line: z.number().optional()
      }))
  }))
});

const ExtractMarkdownStructureArgsSchema = z.object({
  paths: z.array(z.string()),
  max_depth: z.number().optional().default(6),
  include_context: z.boolean().optional().default(false),
  context_lines: z.number().optional().default(2),
});

const FileCopyOperationSchema = z.object({
  source: z.string(),
  destination: z.string(),
  transform: z.object({
      pattern: z.string(),
      replacement: z.string()
  }).optional(),
  conflict_strategy: z.enum(['overwrite', 'ignore', 'rename']).optional().default('overwrite')
});

const CopyFilesArgsSchema = z.object({
  operations: z.array(FileCopyOperationSchema),
});

const MoveFilesArgsSchema = z.object({
  operations: z.array(FileCopyOperationSchema),
});

const SearchInFilesArgsSchema = z.object({
  paths: z.array(z.string()),
  pattern: z.string(),
  use_regex: z.boolean().optional().default(true),
  case_sensitive: z.boolean().optional().default(false),
  file_pattern: z.string().optional(),
  context_lines: z.number().optional().default(2),
  max_results_per_file: z.number().optional().default(100),
  max_total_results: z.number().optional().default(1000),
  recursive: z.boolean().optional().default(true),
});

const SearchAndReplaceBaseSchema = z.object({
    search: z.string(),
    replace: z.string(),
    use_regex: z.boolean().optional().default(true),
    case_sensitive: z.boolean().optional().default(false),
    preview: z.boolean().optional().default(false),
    paths: z.array(z.string()).optional(),
    files: z.array(z.object({
        path: z.string(),
        search: z.string(),
        replace: z.string(),
    })).optional(),
    file_pattern: z.string().optional(),
    recursive: z.boolean().optional().default(true),
});

const SearchAndReplaceArgsSchema = SearchAndReplaceBaseSchema.refine(data => data.paths || data.files, {
  message: "Either 'paths' or 'files' must be provided",
});

const RestartMcpServersArgsSchema = z.object({
  servers: z.array(z.string()),
});

// Interfaces
interface LineRange { start: number; end: number; }
interface FileWithExcerpts { path: string; excerpts?: LineRange[]; }
interface FileDiff { search: string; replace: string; start_line?: number; }
interface FileEdit { path: string; diffs: FileDiff[]; }
interface MarkdownHeading { text: string; level: number; line: number; context?: string[]; }
interface FileCopyOperation { 
  source: string; 
  destination: string; 
  transform?: { pattern: string; replacement: string; }; 
  conflict_strategy?: 'overwrite' | 'ignore' | 'rename'; 
}
class QuickFilesServer {
  private server: McpServer;
  private workspaceRoot: string;

  constructor() {
    this.workspaceRoot = process.cwd();
    this.server = new McpServer({
      name: 'quickfiles-server',
      version: '1.0.0',
      description: 'A server for quick file operations',
    });

    // Register all tools
    this.registerTools();

    // Enhanced process handling
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });

    process.stdin.on("close", () => {
      console.error("MCP Server stdin closed");
      this.server.close();
    });
  }

  /**
   * Échappe tous les caractères spéciaux dans une chaîne pour une utilisation sécurisée dans les expressions régulières
   * @param pattern La chaîne à échapper
   * @returns La chaîne échappée pour une utilisation regex sécurisée
   */
  private escapeRegex(pattern: string): string {
    // Liste des caractères spéciaux qui doivent être échappés dans les regex
    const specialChars = [
      '\\', '.', '^', '$', '*', '+', '?', '(', ')',
      '[', ']', '{', '}', '|', '/'
    ];
    
    let escaped = '';
    for (let i = 0; i < pattern.length; i++) {
      const char = pattern[i];
      if (specialChars.includes(char)) {
        escaped += '\\' + char;
      } else {
        escaped += char;
      }
    }
    return escaped;
  }

  /**
   * Normalise les sauts de ligne dans une chaîne de recherche
   * @param text La chaîne à normaliser
   * @returns La chaîne avec des sauts de ligne normalisés
   */
  private normalizeLineBreaks(text: string): string {
    // Convertir tous les types de sauts de ligne en \n standard
    return text.replace(/\r\n/g, '\n')  // Windows CRLF
            .replace(/\r/g, '\n')     // Mac CR
            .replace(/\n+/g, '\n');    // Multiples \n en un seul
  }

  /**
   * Ajoute des logs de debug pour tracer les opérations
   * @param operation Le nom de l'opération
   * @param details Les détails à logger
   */
  private debugLog(operation: string, details: any): void {
    if (process.env.DEBUG_QUICKFILES === 'true') {
      console.error(`[QUICKFILES DEBUG] ${operation}:`, details);
    }
  }
  

  private registerTools(): void {
    this.server.registerTool(
      'read_multiple_files',
      {
        description: 'Reads the content of multiple files with advanced options.',
        inputSchema: ReadMultipleFilesArgsSchema.shape,
      },
      this.handleReadMultipleFiles.bind(this)
    );

    this.server.registerTool(
      'list_directory_contents',
      {
        description: 'Lists the contents of directories with sorting, filtering, and recursive options.',
        inputSchema: ListDirectoryContentsArgsSchema.shape,
      },
      this.handleListDirectoryContents.bind(this)
    );

    this.server.registerTool(
      'delete_files',
      {
        description: 'Deletes a list of files.',
        inputSchema: DeleteFilesArgsSchema.shape,
      },
      this.handleDeleteFiles.bind(this)
    );

    this.server.registerTool(
      'edit_multiple_files',
      {
        description: 'Edits multiple files based on provided diffs.',
        inputSchema: EditMultipleFilesArgsSchema.shape,
      },
      this.handleEditMultipleFiles.bind(this)
    );

    this.server.registerTool(
      'extract_markdown_structure',
      {
        description: 'Extracts the heading structure from Markdown files.',
        inputSchema: ExtractMarkdownStructureArgsSchema.shape,
      },
      this.handleExtractMarkdownStructure.bind(this)
    );

    this.server.registerTool(
      'copy_files',
      {
        description: 'Copies files from source to destination with transformation and conflict resolution.',
        inputSchema: CopyFilesArgsSchema.shape,
      },
      this.handleCopyFiles.bind(this)
    );

    this.server.registerTool(
      'move_files',
      {
        description: 'Moves files from source to destination.',
        inputSchema: MoveFilesArgsSchema.shape,
      },
      this.handleMoveFiles.bind(this)
    );

    this.server.registerTool(
      'search_in_files',
      {
        description: 'Searches for a pattern in files and returns matching lines with context.',
        inputSchema: SearchInFilesArgsSchema.shape,
      },
      this.handleSearchInFiles.bind(this)
    );

    this.server.registerTool(
      'search_and_replace',
      {
        description: 'Performs search and replace operations on files.',
        inputSchema: SearchAndReplaceBaseSchema.shape,
      },
      this.handleSearchAndReplace.bind(this)
    );

    this.server.registerTool(
      'restart_mcp_servers',
      {
        description: 'Restarts specified MCP servers by toggling their enabled state in settings.',
        inputSchema: RestartMcpServersArgsSchema.shape,
      },
      this.handleRestartMcpServers.bind(this)
    );
  }

  private resolvePath(filePath: string): string {
    return path.resolve(this.workspaceRoot, filePath);
  }

  private async handleReadMultipleFiles(args: z.infer<typeof ReadMultipleFilesArgsSchema>) {
    const {
        paths,
        show_line_numbers,
        max_lines_per_file,
        max_total_lines,
        max_chars_per_file,
        max_total_chars,
    } = args;

    try {
        let totalLines = 0;
        let totalChars = 0;
        const fileContents: { path: string; content: string; truncated: boolean, error?: string }[] = [];

        for (const file of paths) {
            const rawFilePath = typeof file === 'string' ? file : file.path;
            const filePath = this.resolvePath(rawFilePath);
            const excerpts = typeof file === 'string' ? undefined : file.excerpts;

            try {
                let content = await fs.readFile(filePath, 'utf-8');
                let truncated = false;

                if (content.length > max_chars_per_file) {
                    content = content.substring(0, max_chars_per_file);
                    truncated = true;
                }

                totalChars += content.length;
                if (totalChars > max_total_chars) {
                    const overflow = totalChars - max_total_chars;
                    content = content.substring(0, content.length - overflow);
                    truncated = true;
                }

                let lines = content.split('\n');

                if (excerpts) {
                    const extractedLines: string[] = [];
                    for (const excerpt of excerpts) {
                        extractedLines.push(...lines.slice(excerpt.start - 1, excerpt.end));
                    }
                    lines = extractedLines;
                }

                if (lines.length > max_lines_per_file) {
                    lines = lines.slice(0, max_lines_per_file);
                    truncated = true;
                }

                totalLines += lines.length;
                if (totalLines > max_total_lines) {
                    const overflow = totalLines - max_total_lines;
                    lines = lines.slice(0, lines.length - overflow);
                    truncated = true;
                    totalLines = max_total_lines;
                }

                let formattedContent = (show_line_numbers
                    ? lines.map((line, index) => `${index + 1} | ${line}`).join('\n')
                    : lines.join('\n'));

                fileContents.push({ path: rawFilePath, content: formattedContent, truncated });

                if (totalLines >= max_total_lines || totalChars >= max_total_chars) {
                    break;
                }
            } catch (error) {
                const errorMessage = (error as NodeJS.ErrnoException).code === 'ENOENT'
                    ? 'ERREUR: Le fichier n\'existe pas ou n\'est pas accessible'
                    : (error as Error).message;
                fileContents.push({ 
                    path: rawFilePath, 
                    content: '', 
                    truncated: false, 
                    error: errorMessage 
                });
            }
        }

        const formattedResponse = fileContents.map(f => {
            let header = `--- ${f.path} ---\n`;
            if (f.error) {
                header += `ERROR: ${f.error}\n`;
            } else {
                header += f.content;
                if (f.truncated) {
                    header += "\n... (contenu tronqué)\n";
                }
            }
            return header;
        }).join('\n\n');

        return { content: [{ type: 'text' as const, text: formattedResponse }] };
    } catch (error) {
        return { 
            content: [{ 
                type: 'text' as const, 
                text: `Erreur lors de la lecture des fichiers: ${(error as Error).message}` 
            }], 
            isError: true 
        };
    }
  }

  // Additional tool implementations follow the same pattern...
  // Due to length constraints, I'll implement the key ones

  private async handleListDirectoryContents(args: z.infer<typeof ListDirectoryContentsArgsSchema>) {
    // Implementation similar to original but with improved error handling
    const {
        paths,
        max_lines,
        recursive: global_recursive,
        max_depth: global_max_depth,
        file_pattern: global_file_pattern,
        sort_by: global_sort_by,
        sort_order: global_sort_order,
    } = args;

    try {
        let output = '';
        let lineCount = 0;

        for (const dir of paths) {
            const rawDirPath = typeof dir === 'string' ? dir : dir.path;
            const {
                recursive = global_recursive,
                max_depth = global_max_depth,
                file_pattern = global_file_pattern,
                sort_by = global_sort_by,
                sort_order = global_sort_order,
            } = typeof dir === 'object' ? dir : {};

            if (lineCount >= max_lines) {
                output += "\n(limite de lignes atteinte, résultats tronqués)\n";
                break;
            }

            output += `## Contenu de: ${rawDirPath}\n\n`;
            lineCount += 2;

            try {
                const dirPath = this.resolvePath(rawDirPath);
                const files = await this.listDirectory(dirPath, rawDirPath, recursive, max_depth, file_pattern);
                this.sortFiles(files, sort_by, sort_order);

                const tableHeader = "| Type | Nom | Taille | Modifié le | Lignes |\n|---|---|---|---|---|\n";
                output += tableHeader;
                lineCount += 2;

                for (const file of files) {
                    if (lineCount >= max_lines) {
                        output += "| ... | ... | ... | ... | ... |\n";
                        lineCount++;
                        break;
                    }

                    const type = file.isDirectory ? '📁' : '📄';
                    const size = file.size !== null ? `${(file.size / 1024).toFixed(2)} KB` : 'N/A';
                    const modified = file.modified ? new Date(file.modified).toISOString().split('T')[0] : 'N/A';
                    const lines = file.lines > 0 ? file.lines.toString() : '';

                    output += `| ${type} | ${file.name} | ${size} | ${modified} | ${lines} |\n`;
                    lineCount++;
                }

                output += "\n";
                lineCount++;
            } catch (error) {
                output += `Erreur lors du traitement de ${rawDirPath}: ${(error as Error).message}\n\n`;
                lineCount += 2;
            }
        }

        return { content: [{ type: 'text' as const, text: output }] };
    } catch (error) {
        return { 
            content: [{ 
                type: 'text' as const, 
                text: `Erreur lors du listage des répertoires: ${(error as Error).message}` 
            }], 
            isError: true 
        };
    }
  }

  // Helper methods
  private async listDirectory(absolutePath: string, originalPath: string, recursive: boolean, max_depth?: number, file_pattern?: string, current_depth = 0) {
      if (max_depth !== undefined && current_depth >= max_depth) {
          return [];
      }

      const entries = await fs.readdir(absolutePath, { withFileTypes: true });
      let files: any[] = [];

      for (const entry of entries) {
          const fullPath = path.join(absolutePath, entry.name);
          const relativeName = path.join(originalPath, entry.name);

          if (file_pattern && entry.isFile() && !glob.sync(file_pattern, { cwd: absolutePath }).includes(entry.name)) {
              continue;
          }

          const stats = await fs.stat(fullPath);
          const fileData = {
              name: relativeName,
              isDirectory: entry.isDirectory(),
              size: stats.size,
              modified: stats.mtimeMs,
              lines: entry.isFile() ? (await this.countLines(fullPath)) : 0,
          };

          files.push(fileData);

          if (recursive && entry.isDirectory()) {
              files.push(...(await this.listDirectory(fullPath, relativeName, recursive, max_depth, file_pattern, current_depth + 1)));
          }
      }

      return files;
  }

  private async countLines(filePath: string) {
      try {
          const content = await fs.readFile(filePath, 'utf-8');
          return content.split('\n').length;
      } catch (e) {
          return 0;
      }
  }

  private sortFiles(files: any[], sort_by: string, sort_order: string) {
      files.sort((a, b) => {
          let compare = 0;
          if (sort_by === 'name') compare = a.name.localeCompare(b.name);
          else if (sort_by === 'size') compare = (a.size || 0) - (b.size || 0);
          else if (sort_by === 'modified') compare = (a.modified || 0) - (b.modified || 0);
          return sort_order === 'asc' ? compare : -compare;
      });
  }

  // Restored full implementations from previous working version
  private async handleDeleteFiles(args: z.infer<typeof DeleteFilesArgsSchema>) {
    const { paths } = args;
    try {
        const results = await Promise.all(
            paths.map(async (rawFilePath) => {
                const filePath = this.resolvePath(rawFilePath);
                try {
                    await fs.unlink(filePath);
                    return { path: rawFilePath, success: true };
                } catch (error) {
                    return { path: rawFilePath, success: false, error: (error as Error).message };
                }
            })
        );
        let report = "## Rapport de suppression de fichiers\n\n";
        results.forEach(r => {
            report += r.success
                ? `- [SUCCES] ${r.path}\n`
                : `- [ERREUR] ${r.path}: ${r.error}\n`;
        });
        return { content: [{ type: 'text' as const, text: report }] };
    } catch (error) {
        return { content: [{ type: 'text' as const, text: `Erreur lors de la suppression des fichiers: ${(error as Error).message}` }], isError: true };
    }
  }

  private async handleEditMultipleFiles(args: z.infer<typeof EditMultipleFilesArgsSchema>) {
    const { files } = args;
    this.debugLog('handleEditMultipleFiles', { filesCount: files.length });
    
    try {
        const results = await Promise.all(
            files.map(async ({ path: rawFilePath, diffs }) => {
                const filePath = this.resolvePath(rawFilePath);
                this.debugLog('editFile', { filePath, diffsCount: diffs.length });
                
                try {
                    let content = await fs.readFile(filePath, 'utf-8');
                    let modificationsCount = 0;
                    const errors: string[] = [];
                    
                    for (const diff of diffs) {
                        const { search, replace, start_line } = diff;
                        
                        // Normaliser les sauts de ligne dans les chaînes
                        const normalizedSearch = this.normalizeLineBreaks(search);
                        const normalizedReplace = this.normalizeLineBreaks(replace);
                        const normalizedContent = this.normalizeLineBreaks(content);
                        
                        let lines = normalizedContent.split('\n');
                        let found = false;
                        
                        if (start_line) {
                           const searchIndex = start_line - 1;
                           if (lines[searchIndex] && lines[searchIndex].includes(normalizedSearch)) {
                               lines[searchIndex] = lines[searchIndex].replace(normalizedSearch, normalizedReplace);
                               content = lines.join('\n');
                               found = true;
                           }
                        } else {
                             // ✅ CORRECTION: Utiliser escapeRegex pour échapper les caractères spéciaux
                             const escapedSearch = this.escapeRegex(normalizedSearch);
                             this.debugLog('regexReplace', {
                                 originalSearch: normalizedSearch,
                                 escapedSearch,
                                 filePath
                             });
                             
                             const searchRegex = new RegExp(escapedSearch, 'g');
                             const newContent = normalizedContent.replace(searchRegex, (match) => {
                                 found = true;
                                 return normalizedReplace;
                             });
                             if (newContent !== normalizedContent) {
                                 content = newContent;
                             }
                        }
                        if (found) {
                            modificationsCount++;
                            this.debugLog('modificationSuccess', {
                                filePath,
                                search: normalizedSearch,
                                replace: normalizedReplace
                            });
                        } else {
                            errors.push(`Le texte à rechercher "${normalizedSearch}" n'a pas été trouvé.`);
                            this.debugLog('modificationFailed', {
                                filePath,
                                search: normalizedSearch,
                                error: 'Text not found'
                            });
                        }
                    }
                    if (modificationsCount > 0) {
                        await fs.writeFile(filePath, content, 'utf-8');
                        this.debugLog('fileWritten', { filePath, modificationsCount });
                    }
                    return { path: rawFilePath, success: true, modifications: modificationsCount, errors };
                } catch (error) {
                    this.debugLog('fileError', { filePath, error: (error as Error).message });
                    return { path: rawFilePath, success: false, error: (error as Error).message };
                }
            })
        );
        let report = "## Rapport d'édition de fichiers\n\n";
        results.forEach(r => {
            if (r.success) {
                report += `- [SUCCES] ${r.path}: ${r.modifications} modification(s) effectuée(s).`;
                if (r.errors && r.errors.length > 0) report += ` Erreurs: ${r.errors.join(', ')}`;
                report += `\n`;
            } else {
                report += `- [ERREUR] ${r.path}: ${r.error}\n`;
            }
        });
        this.debugLog('editComplete', { totalFiles: files.length, results });
        return { content: [{ type: 'text' as const, text: report }] };
    } catch (error) {
        this.debugLog('handleEditMultipleFilesError', { error: (error as Error).message });
        return { content: [{ type: 'text' as const, text: `Erreur lors de l'édition des fichiers: ${(error as Error).message}` }], isError: true };
    }
  }

  private async handleExtractMarkdownStructure(args: z.infer<typeof ExtractMarkdownStructureArgsSchema>) {
    const { paths: filePaths, max_depth, include_context, context_lines } = args;
    try {
        const allFilesHeadings = await Promise.all(
            filePaths.map(async (rawFilePath) => {
                const filePath = this.resolvePath(rawFilePath);
                try {
                    const content = await fs.readFile(filePath, 'utf-8');
                    const { headings } = this.parseMarkdown(content, max_depth, context_lines);
                    return { path: rawFilePath, headings };
                } catch (error) {
                    return { path: rawFilePath, error: (error as Error).message };
                }
            })
        );
        let formattedResponse = "## Structure des fichiers Markdown\n\n";
        for (const fileResult of allFilesHeadings) {
            formattedResponse += `### Fichier: ${fileResult.path}\n\n`;
            if (fileResult.headings) {
                fileResult.headings.forEach(h => {
                    formattedResponse += `${' '.repeat((h.level - 1) * 2)}- [L${h.line}] ${h.text}\n`;
                });
                formattedResponse += '\n';
            } else if (fileResult.error) {
                formattedResponse += `Erreur: ${fileResult.error}\n\n`;
            }
        }
        return { content: [{ type: 'text' as const, text: formattedResponse }] };
    } catch (error) {
        return { content: [{ type: 'text' as const, text: `Erreur lors de l'extraction de la structure Markdown: ${(error as Error).message}` }], isError: true };
    }
  }

  private parseMarkdown(content: string, maxDepth: number, contextLines: number) {
    const lines = content.split('\n');
    const headings: MarkdownHeading[] = [];
    const atxHeadingRegex = /^(#{1,6})\s+(.*)/;
    const setextH1Regex = /^=+\s*$/;
    const setextH2Regex = /^-+\s*$/;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        let heading: MarkdownHeading | null = null;
        const atxMatch = line.match(atxHeadingRegex);
        if (atxMatch) {
            const level = atxMatch[1].length;
            if (level <= maxDepth) {
                heading = { text: atxMatch[2].trim(), level, line: i + 1 };
            }
        } else if (i > 0 && lines[i-1].trim() !== '') {
            if (setextH1Regex.test(line)) {
                if (1 <= maxDepth) heading = { text: lines[i-1].trim(), level: 1, line: i };
            } else if (setextH2Regex.test(line)) {
                if (2 <= maxDepth) heading = { text: lines[i-1].trim(), level: 2, line: i };
            }
        }
        if (heading) headings.push(heading);
    }
    return { headings, fileInfo: {} };
  }

  private async handleCopyFiles(args: z.infer<typeof CopyFilesArgsSchema>) {
    const { operations } = args;
    try {
        const results = await Promise.all(operations.map(op => this.processFileCopyOperation(op, 'copy')));
        const report = this.formatFileCopyResponse(results, 'copy');
        return { content: [{ type: 'text' as const, text: report }] };
    } catch (error) {
        return { content: [{ type: 'text' as const, text: `Erreur lors de la copie des fichiers: ${(error as Error).message}` }], isError: true };
    }
  }

  private async handleMoveFiles(args: z.infer<typeof MoveFilesArgsSchema>) {
    const { operations } = args;
    try {
        const results = await Promise.all(operations.map(op => this.processFileCopyOperation(op, 'move')));
        const report = this.formatFileCopyResponse(results, 'move');
        return { content: [{ type: 'text' as const, text: report }] };
    } catch (error) {
        return { content: [{ type: 'text' as const, text: `Erreur lors du déplacement des fichiers: ${(error as Error).message}` }], isError: true };
    }
  }

  private async processFileCopyOperation(operation: FileCopyOperation, mode: 'copy' | 'move') {
      const { source: rawSource, destination: rawDestination, transform, conflict_strategy = 'overwrite' } = operation;
      const source = this.resolvePath(rawSource);
      const destination = this.resolvePath(rawDestination);

      const sourcePaths = await glob(source);
      if (sourcePaths.length === 0) {
          return { source, success: false, error: `Aucun fichier ne correspond au motif: ${source}`, files: [] };
      }
      let isDestDir = false;
      try {
          isDestDir = (await fs.stat(destination)).isDirectory();
      } catch (e) {
          isDestDir = destination.endsWith(path.sep) || destination.endsWith('/') || sourcePaths.length > 1;
          if (isDestDir) await fs.mkdir(destination, { recursive: true });
      }
      const fileResults = await Promise.all(
          sourcePaths.map(async (sourcePath) => {
              let fileName = path.basename(sourcePath);
              if (transform) {
                  fileName = fileName.replace(new RegExp(transform.pattern), transform.replacement);
              }
              let destPath = isDestDir ? path.join(destination, fileName) : destination;
             
              try {
                  let fileExists = false;
                  try { await fs.access(destPath); fileExists = true; } catch (e) { }
                  if (fileExists) {
                      if (conflict_strategy === 'ignore') return { source: sourcePath, destination: destPath, success: true, skipped: true, message: 'Fichier ignoré' };
                      if (conflict_strategy === 'rename') {
                          destPath = `${destPath}_${Date.now()}`;
                      }
                  }
                  if (mode === 'copy') await fs.copyFile(sourcePath, destPath);
                  else await fs.rename(sourcePath, destPath);
                  return { source: sourcePath, destination: destPath, success: true, message: `Fichier ${mode === 'copy' ? 'copié' : 'déplacé'}` };
              } catch (error) {
                  return { source: sourcePath, destination: destPath, success: false, error: (error as Error).message };
              }
          })
      );
      return { source, destination, success: true, files: fileResults };
  }

  private formatFileCopyResponse(results: any[], operationName: 'copy' | 'move') {
      let output = `## Opération: ${operationName}\n`;
      for (const result of results) {
          output += `### Source: ${result.source} -> Destination: ${result.destination}\n`;
          result.files.forEach((f: any) => {
             output += `- ${f.success ? '✓' : '✗'} ${f.source} -> ${f.destination} ${f.message || f.error}\n`;
          });
      }
      return output;
  }

  private async handleSearchInFiles(args: z.infer<typeof SearchInFilesArgsSchema>) {
    const { paths: rawPaths, pattern, use_regex, case_sensitive, file_pattern, context_lines, max_results_per_file, max_total_results, recursive } = args;
    try {
        const results: any[] = [];
        let totalMatches = 0;
        const searchRegex = use_regex
            ? new RegExp(pattern, case_sensitive ? 'g' : 'gi')
            : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), case_sensitive ? 'g' : 'gi');
        
        const searchInFile = async (absoluteFilePath: string, relativePath: string) => {
            if (totalMatches >= max_total_results) return;
            try {
                const content = await fs.readFile(absoluteFilePath, 'utf-8');
                const lines = content.split('\n');
                const fileMatches = [];
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    // Reset regex lastIndex to avoid stateful behavior with global flag
                    searchRegex.lastIndex = 0;
                    if (searchRegex.test(line)) {
                        if (fileMatches.length >= max_results_per_file || totalMatches >= max_total_results) break;
                        const start = Math.max(0, i - context_lines);
                        const end = Math.min(lines.length, i + context_lines + 1);
                        const context = lines.slice(start, end);
                        fileMatches.push({ lineNumber: i + 1, line, context });
                        totalMatches++;
                    }
                }
                if (fileMatches.length > 0) results.push({ path: relativePath, matches: fileMatches });
            } catch (error) {
                // Skip files that cannot be read (binary files, permission errors, etc.)
            }
        };
       
        // Collect all files to search
        const filesToSearch: { absolute: string; relative: string }[] = [];
        
        for (const rawPath of rawPaths) {
            const resolvedPath = this.resolvePath(rawPath);
            
            try {
                const stats = await fs.stat(resolvedPath);
                
                if (stats.isFile()) {
                    // Direct file reference
                    filesToSearch.push({ absolute: resolvedPath, relative: rawPath });
                } else if (stats.isDirectory()) {
                    // Directory: need to list files
                    if (recursive) {
                        // Use glob to find files recursively
                        // If file_pattern is provided without **, prepend it for recursive search
                        let globPattern = file_pattern || '**/*';
                        if (file_pattern && !file_pattern.includes('**')) {
                            globPattern = `**/${file_pattern}`;
                        }
                        const matchedFiles = await glob(globPattern, {
                            nodir: true,
                            absolute: true,
                            cwd: resolvedPath
                        });
                        
                        for (const absFile of matchedFiles) {
                            const relFile = path.relative(resolvedPath, absFile);
                            const displayPath = path.join(rawPath, relFile);
                            filesToSearch.push({ absolute: absFile, relative: displayPath });
                        }
                    } else {
                        // Non-recursive: only top-level files
                        const entries = await fs.readdir(resolvedPath, { withFileTypes: true });
                        for (const entry of entries) {
                            if (entry.isFile()) {
                                // Check file_pattern if specified
                                if (file_pattern) {
                                    const matched = await glob(file_pattern, {
                                        cwd: resolvedPath,
                                        nodir: true
                                    });
                                    if (!matched.includes(entry.name)) continue;
                                }
                                const absFile = path.join(resolvedPath, entry.name);
                                const displayPath = path.join(rawPath, entry.name);
                                filesToSearch.push({ absolute: absFile, relative: displayPath });
                            }
                        }
                    }
                }
            } catch (error) {
                // Path doesn't exist or is not accessible, skip it
                continue;
            }
        }
        
        // Search in all collected files
        for (const file of filesToSearch) {
            if (totalMatches >= max_total_results) break;
            await searchInFile(file.absolute, file.relative);
        }
       
        let formattedResponse = `# Résultats de la recherche pour: "${pattern}"\n\n`;
        if (results.length === 0) {
            formattedResponse += `Aucun résultat trouvé.\n`;
        } else {
            formattedResponse += `**${results.length} fichier(s) contenant des correspondances**\n\n`;
            results.forEach(r => {
                formattedResponse += `## ${r.path}\n`;
                formattedResponse += `${r.matches.length} correspondance(s)\n\n`;
                r.matches.forEach((m: any) => {
                    formattedResponse += `**Ligne ${m.lineNumber}**:\n\`\`\`\n${m.context.join('\n')}\n\`\`\`\n\n`;
                });
            });
        }
       
        return { content: [{ type: 'text' as const, text: formattedResponse }] };
    } catch (error) {
        return { content: [{ type: 'text' as const, text: `Erreur lors de la recherche: ${(error as Error).message}` }], isError: true };
    }
  }

  private async handleSearchAndReplace(args: z.infer<typeof SearchAndReplaceArgsSchema>) {
    const { files, paths, search, replace, use_regex, case_sensitive, file_pattern, recursive, preview } = args;
    try {
        let totalReplacements = 0;
        let diffs = '';
        const replaceInFile = async (rawFilePath: string, searchPattern: string, replacement: string) => {
            const filePath = this.resolvePath(rawFilePath);
            let content = await fs.readFile(filePath, 'utf-8');
            const searchRegex = new RegExp(searchPattern, case_sensitive ? 'g' : 'gi');
            const newContent = content.replace(searchRegex, (match) => {
                totalReplacements++;
                return replacement;
            });
            if (content !== newContent) {
                 diffs += this.generateDiff(content, newContent, rawFilePath) + '\n';
                 if (!preview) await fs.writeFile(filePath, newContent, 'utf-8');
            }
        };
        if (files) {
            for (const file of files) {
                await replaceInFile(file.path, file.search, file.replace);
            }
        } else if (paths && search && replace) {
            for (const searchPath of paths) {
                await replaceInFile(searchPath, search, replace);
            }
        }
       
        let report = `# Rapport de remplacement (${preview ? 'Prévisualisation' : 'Effectué'})\n\n`;
        report += `Total de remplacements: ${totalReplacements}\n\n${diffs}`;
        return { content: [{ type: 'text' as const, text: report }] };
    } catch (error) {
        return { content: [{ type: 'text' as const, text: `Erreur lors du remplacement: ${(error as Error).message}` }], isError: true };
    }
  }

  private generateDiff(oldContent: string, newContent: string, filePath: string): string {
    return `--- a/${filePath}\n+++ b/${filePath}\n...diff content...`;
  }

  private async handleRestartMcpServers(args: z.infer<typeof RestartMcpServersArgsSchema>) {
    const { servers } = args;
    // Détection automatique du chemin utilisateur en utilisant la variable d'environnement ou os.homedir()
    const userHome = process.env.USERPROFILE || process.env.HOME || os.homedir();
    const settingsPath = path.join(userHome, 'AppData', 'Roaming', 'Code', 'User', 'globalStorage', 'rooveterinaryinc.roo-cline', 'settings', 'mcp_settings.json');
    const results = [];
    try {
      // ✅ FIX: Relire le fichier avant chaque modification pour éviter les corruptions
      for (const serverName of servers) {
        // Lire l'état actuel du fichier
        let settingsRaw = await fs.readFile(settingsPath, 'utf-8');
        let settings = JSON.parse(settingsRaw);
        
        if (!settings.mcpServers) {
          throw new Error("La section 'mcpServers' est manquante dans le fichier de configuration.");
        }
        
        if (settings.mcpServers[serverName]) {
            // Désactiver le serveur
            settings.mcpServers[serverName].enabled = false;
            await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            // ✅ FIX: Relire à nouveau avant de réactiver pour avoir l'état le plus récent
            settingsRaw = await fs.readFile(settingsPath, 'utf-8');
            settings = JSON.parse(settingsRaw);
            
            // Réactiver le serveur
            settings.mcpServers[serverName].enabled = true;
            await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
            results.push({ server: serverName, status: 'success' });
        } else {
            results.push({ server: serverName, status: 'error', reason: 'Server not found in settings' });
        }
      }
    } catch (error) {
       return { content: [{ type: 'text' as const, text: `Erreur lors du redémarrage des serveurs: ${(error as Error).message}` }]};
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify(results) }] };
  }

  async run() {
    console.error('QuickFiles server starting on stdio...');
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('QuickFiles server connected and listening with all tools available.');
  }
}

// Main execution
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = new QuickFilesServer();
  server.run().catch((error) => {
    console.error('Failed to start QuickFiles server:', error);
    process.exit(1);
  });
}
