#!/usr-bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as fs from 'fs/promises';
import * as path from 'path';
import { glob } from 'glob';
import { fileURLToPath } from 'url';

// Schemas Zod (unchanged)
const ReadMultipleFilesArgsSchema = {
  paths: z.array(z.union([z.string(), z.object({ path: z.string(), excerpts: z.array(z.object({ start: z.number(), end: z.number() })).optional() })])),
  show_line_numbers: z.boolean().optional().default(true),
  max_lines_per_file: z.number().optional().default(2000),
  max_chars_per_file: z.number().optional().default(160000),
  max_total_lines: z.number().optional().default(8000),
  max_total_chars: z.number().optional().default(400000),
};
const ListDirectoryContentsArgsSchema = {
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
};
const DeleteFilesArgsSchema = {
  paths: z.array(z.string()),
};
const EditMultipleFilesArgsSchema = {
  files: z.array(z.object({
      path: z.string(),
      diffs: z.array(z.object({
          search: z.string(),
          replace: z.string(),
          start_line: z.number().optional()
      }))
  }))
};
const ExtractMarkdownStructureArgsSchema = {
  paths: z.array(z.string()),
  max_depth: z.number().optional().default(6),
  include_context: z.boolean().optional().default(false),
  context_lines: z.number().optional().default(2),
};
const FileCopyOperationSchema = {
  source: z.string(),
  destination: z.string(),
  transform: z.object({
      pattern: z.string(),
      replacement: z.string()
  }).optional(),
  conflict_strategy: z.enum(['overwrite', 'ignore', 'rename']).optional().default('overwrite')
};
const CopyFilesArgsSchema = {
  operations: z.array(z.object(FileCopyOperationSchema)),
};
const MoveFilesArgsSchema = {
  operations: z.array(z.object(FileCopyOperationSchema)),
};
const SearchInFilesArgsSchema = {
  paths: z.array(z.string()),
  pattern: z.string(),
  use_regex: z.boolean().optional().default(true),
  case_sensitive: z.boolean().optional().default(false),
  file_pattern: z.string().optional(),
  context_lines: z.number().optional().default(2),
  max_results_per_file: z.number().optional().default(100),
  max_total_results: z.number().optional().default(1000),
  recursive: z.boolean().optional().default(true),
};
const SearchAndReplaceArgsSchema = {
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
};
const RestartMcpServersArgsSchema = {
  servers: z.array(z.string()),
};
// Interfaces specific to business logic from old file
interface LineRange { start: number; end: number; }
interface FileWithExcerpts { path: string; excerpts?: LineRange[]; }
interface FileReadRequest { path: string; excerpts?: LineRange[]; content?: string; }
interface FileDiff { search: string; replace: string; start_line?: number; }
interface FileEdit { path: string; diffs: FileDiff[]; }
interface MarkdownHeading { text: string; level: number; line: number; context?: string[]; }
interface FileCopyOperation { source: string; destination: string; transform?: { pattern: string; replacement: string; }; conflict_strategy?: 'overwrite' | 'ignore' | 'rename'; }
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

    this.server.registerTool(
      'read_multiple_files',
      {
        description: 'Reads the content of multiple files with advanced options.',
        inputSchema: ReadMultipleFilesArgsSchema,
      },
      this.handleReadMultipleFiles.bind(this)
    );

    this.server.registerTool(
      'list_directory_contents',
      {
        description: 'Lists the contents of directories with sorting, filtering, and recursive options.',
        inputSchema: ListDirectoryContentsArgsSchema,
      },
      this.handleListDirectoryContents.bind(this)
    );

    this.server.registerTool(
      'delete_files',
      {
        description: 'Deletes a list of files.',
        inputSchema: DeleteFilesArgsSchema,
      },
      this.handleDeleteFiles.bind(this)
    );

    this.server.registerTool(
      'edit_multiple_files',
      {
        description: 'Edits multiple files based on provided diffs.',
        inputSchema: EditMultipleFilesArgsSchema,
      },
      this.handleEditMultipleFiles.bind(this)
    );

    this.server.registerTool(
      'extract_markdown_structure',
      {
        description: 'Extracts the heading structure from Markdown files.',
        inputSchema: ExtractMarkdownStructureArgsSchema,
      },
      this.handleExtractMarkdownStructure.bind(this)
    );

    this.server.registerTool(
      'copy_files',
      {
        description: 'Copies files from source to destination with transformation and conflict resolution.',
        inputSchema: CopyFilesArgsSchema,
      },
      this.handleCopyFiles.bind(this)
    );

    this.server.registerTool(
      'move_files',
      {
        description: 'Moves files from source to destination.',
        inputSchema: MoveFilesArgsSchema,
      },
      this.handleMoveFiles.bind(this)
    );

    this.server.registerTool(
      'search_in_files',
      {
        description: 'Searches for a pattern in files and returns matching lines with context.',
        inputSchema: SearchInFilesArgsSchema,
      },
      this.handleSearchInFiles.bind(this)
    );

    this.server.registerTool(
      'search_and_replace',
      {
        description: 'Performs search and replace operations on files.',
        inputSchema: SearchAndReplaceArgsSchema,
      },
      this.handleSearchAndReplace.bind(this)
    );

    this.server.registerTool(
      'restart_mcp_servers',
      {
        description: 'Restarts specified MCP servers by toggling their enabled state in settings.',
        inputSchema: RestartMcpServersArgsSchema,
      },
      this.handleRestartMcpServers.bind(this)
    );
  }

  private resolvePath(filePath: string): string {
    return path.resolve(this.workspaceRoot, filePath);
  }
  private async handleReadMultipleFiles(args: unknown) {
    const schema = z.object(ReadMultipleFilesArgsSchema);
    const {
        paths,
        show_line_numbers,
        max_lines_per_file,
        max_total_lines,
        max_chars_per_file,
        max_total_chars,
    } = schema.parse(args);
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
                    // Truncate the last added content to fit the total limit
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
                fileContents.push({ path: rawFilePath, content: formattedContent, truncated, });
                if (totalLines >= max_total_lines || totalChars >= max_total_chars) {
                    break;
                }
            } catch (error) {
                fileContents.push({ path: rawFilePath, content: '', truncated: false, error: (error as Error).message, });
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
        return { content: [{ type: 'text' as const, text: `Erreur lors de la lecture des fichiers: ${(error as Error).message}` }], isError: true };
    }
  }
   
  private async handleListDirectoryContents(args: unknown) {
    const schema = z.object(ListDirectoryContentsArgsSchema);
    const {
        paths,
        max_lines,
        recursive: global_recursive,
        max_depth: global_max_depth,
        file_pattern: global_file_pattern,
        sort_by: global_sort_by,
        sort_order: global_sort_order,
    } = schema.parse(args);
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
        return { content: [{ type: 'text' as const, text: `Erreur lors du listage des répertoires: ${(error as Error).message}` }], isError: true };
    }
  }
  // Helper functions for listDirectoryContents
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
   
  private async handleDeleteFiles(args: unknown) {
    const schema = z.object(DeleteFilesArgsSchema);
    const { paths } = schema.parse(args);
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
   
  private async handleEditMultipleFiles(args: unknown) {
    const schema = z.object(EditMultipleFilesArgsSchema);
    const { files } = schema.parse(args);
    try {
        const results = await Promise.all(
            files.map(async ({ path: rawFilePath, diffs }) => {
                const filePath = this.resolvePath(rawFilePath);
                try {
                    let content = await fs.readFile(filePath, 'utf-8');
                    let modificationsCount = 0;
                    const errors: string[] = [];
                    for (const diff of diffs) {
                        const { search, replace, start_line } = diff;
                        let lines = content.split('\n');
                        let searchIndex = start_line ? start_line - 1 : 0;
                        let found = false;
                        // TODO: Implement a more robust search-and-replace logic
                        if (start_line) {
                           if (lines[searchIndex].includes(search)) {
                               lines[searchIndex] = lines[searchIndex].replace(search, replace);
                               found = true;
                           }
                        } else {
                            content = content.replace(new RegExp(search, 'g'), (match) => {
                                found = true;
                                return replace;
                            });
                        }
                        if (found) modificationsCount++;
                        else errors.push(`Le texte à rechercher "${search}" n'a pas été trouvé.`);
                    }
                    if (modificationsCount > 0) {
                        await fs.writeFile(filePath, content, 'utf-8');
                    }
                    return { path: rawFilePath, success: true, modifications: modificationsCount, errors };
                } catch (error) {
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
        return { content: [{ type: 'text' as const, text: report }] };
    } catch (error) {
        return { content: [{ type: 'text' as const, text: `Erreur lors de l'édition des fichiers: ${(error as Error).message}` }], isError: true };
    }
  }
  private async handleExtractMarkdownStructure(args: unknown) {
    const schema = z.object(ExtractMarkdownStructureArgsSchema);
    const { paths: filePaths, max_depth, include_context, context_lines } = schema.parse(args);
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
  // Helper for handleExtractMarkdownStructure
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
    return { headings, fileInfo: {} }; // Simplified
  }
  private async handleCopyFiles(args: unknown) {
    const schema = z.object(CopyFilesArgsSchema);
    const { operations } = schema.parse(args);
    try {
        const results = await Promise.all(operations.map(op => this.processFileCopyOperation(op, 'copy')));
        const report = this.formatFileCopyResponse(results, 'copy');
        return { content: [{ type: 'text' as const, text: report }] };
    } catch (error) {
        return { content: [{ type: 'text' as const, text: `Erreur lors de la copie des fichiers: ${(error as Error).message}` }], isError: true };
    }
  }
  private async handleMoveFiles(args: unknown) {
    const schema = z.object(MoveFilesArgsSchema);
    const { operations } = schema.parse(args);
        try {
            const results = await Promise.all(operations.map(op => this.processFileCopyOperation(op, 'move')));
            const report = this.formatFileCopyResponse(results, 'move');
            return { content: [{ type: 'text' as const, text: report }] };
        } catch (error) {
            return { content: [{ type: 'text' as const, text: `Erreur lors du déplacement des fichiers: ${(error as Error).message}` }], isError: true };
        }
  }
  // Helpers for copy/move
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
  private async handleSearchInFiles(args: unknown) {
    const schema = z.object(SearchInFilesArgsSchema);
    const { paths: rawPaths, pattern, use_regex, case_sensitive, file_pattern, context_lines, max_results_per_file, max_total_results, recursive } = schema.parse(args);
    try {
        const results: any[] = [];
        let totalMatches = 0;
        const searchRegex = new RegExp(pattern, case_sensitive ? 'g' : 'gi');
        const searchInFile = async (rawFilePath: string) => {
            if (totalMatches >= max_total_results) return;
            const filePath = this.resolvePath(rawFilePath);
            const content = await fs.readFile(filePath, 'utf-8');
            const lines = content.split('\n');
            const fileMatches = [];
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (searchRegex.test(line)) {
                    if (fileMatches.length >= max_results_per_file || totalMatches >= max_total_results) break;
                    const start = Math.max(0, i - context_lines);
                    const end = Math.min(lines.length, i + context_lines + 1);
                    const context = lines.slice(start, end);
                    fileMatches.push({ lineNumber: i + 1, line, context });
                    totalMatches++;
                }
            }
            if (fileMatches.length > 0) results.push({ path: rawFilePath, matches: fileMatches });
        };
       
        for (const searchPath of rawPaths) {
            // Simplified logic: currently doesn't handle directory recursion or glob patterns
             // It will treat directory paths as files, leading to errors.
             // This needs to be expanded to properly walk directories if recursive is true.
            await searchInFile(searchPath);
        }
       
        let formattedResponse = `# Résultats de la recherche pour: "${pattern}"\n`;
        results.forEach(r => {
            formattedResponse += `### ${r.path}\n`;
            r.matches.forEach((m: any) => {
                formattedResponse += `**Ligne ${m.lineNumber}**: ${m.line}\n\`\`\`\n${m.context.join('\n')}\n\`\`\`\n`;
            });
        });
       
        return { content: [{ type: 'text' as const, text: formattedResponse }] };
    } catch (error) {
        return { content: [{ type: 'text' as const, text: `Erreur lors de la recherche: ${(error as Error).message}` }], isError: true };
    }
  }
  private async handleSearchAndReplace(args: unknown) {
    const schema = z.object(SearchAndReplaceArgsSchema).refine(data => data.paths || data.files, {
      message: "Either 'paths' or 'files' must be provided",
    });
    const { files, paths, search, replace, use_regex, case_sensitive, file_pattern, recursive, preview } = schema.parse(args);
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
                // Simplified logic
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
  // Helper for search_and_replace
  private generateDiff(oldContent: string, newContent: string, filePath: string): string {
    // Simplified diff generation
    return `--- a/${filePath}\n+++ b/${filePath}\n...diff content...`;
  }
  private async handleRestartMcpServers(args: unknown) {
    const schema = z.object(RestartMcpServersArgsSchema);
    const { servers } = schema.parse(args);
    const settingsPath = 'C:/Users/MYIA/AppData/Roaming/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json';
    const results = [];
    try {
      const settingsRaw = await fs.readFile(settingsPath, 'utf-8');
      const settings = JSON.parse(settingsRaw);
      if (!settings.mcpServers) {
        throw new Error("La section 'mcpServers' est manquante dans le fichier de configuration.");
      }
      for (const serverName of servers) {
        if (settings.mcpServers[serverName]) {
            const originalState = { ...settings.mcpServers[serverName] };
            settings.mcpServers[serverName].enabled = false;
            await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));
            await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1s
            settings.mcpServers[serverName].enabled = true;
            await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));
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
 
  public async run(): Promise<void> {
    console.error('QuickFiles server starting on stdio...');
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('QuickFiles server connected and listening.');

    process.stdin.on("close", () => {
      console.error("MCP Server stdin closed");
      this.server.close();
    });
  }
}

async function main() {
  try {
    const server = new QuickFilesServer();
    await server.run();
  } catch (error) {
    console.error('Failed to start QuickFiles server:', error);
    process.exit(1);
  }
}

main();
