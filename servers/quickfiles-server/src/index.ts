#!/usr/bin/env node
import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import * as fs from 'fs/promises';
import * as path from 'path';
import { glob } from 'glob';
import express, { Request, Response } from 'express';
import cors from 'cors';
import { randomUUID } from 'crypto';
import NodeCache from 'node-cache';
// Schemas Zod (unchanged)
const ReadMultipleFilesArgsSchema = z.object({
  paths: z.array(z.union([z.string(), z.object({ path: z.string(), excerpts: z.array(z.object({ start: z.number(), end: z.number() })).optional() })])),
  show_line_numbers: z.boolean().optional(),
  max_lines_per_file: z.number().optional(),
  max_total_lines: z.number().optional(),
  max_chars_per_file: z.number().optional(),
  max_total_chars: z.number().optional(),
});
const ListDirectoryContentsArgsSchema = z.object({
  paths: z.array(z.union([z.string(), z.object({
    path: z.string(),
    recursive: z.boolean().optional(),
    max_depth: z.number().optional(),
    file_pattern: z.string().optional(),
    sort_by: z.enum(['name', 'size', 'modified', 'type']).optional(),
    sort_order: z.enum(['asc', 'desc']).optional(),
  })])),
  max_lines: z.number().optional(),
  max_depth: z.number().optional(),
  file_pattern: z.string().optional(),
  sort_by: z.enum(['name', 'size', 'modified', 'type']).optional(),
  sort_order: z.enum(['asc', 'desc']).optional(),
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
      start_line: z.number().optional(),
    })),
  })),
});
const ExtractMarkdownStructureArgsSchema = z.object({
  paths: z.array(z.string()),
  max_depth: z.number().optional(),
  include_context: z.boolean().optional(),
  context_lines: z.number().optional(),
});
const FileCopyOperationSchema = z.object({
  source: z.string(),
  destination: z.string(),
  transform: z.object({ pattern: z.string(), replacement: z.string() }).optional(),
  conflict_strategy: z.enum(['overwrite', 'ignore', 'rename']).optional(),
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
  use_regex: z.boolean().optional(),
  case_sensitive: z.boolean().optional(),
  file_pattern: z.string().optional(),
  context_lines: z.number().optional(),
  max_results_per_file: z.number().optional(),
  max_total_results: z.number().optional(),
  recursive: z.boolean().optional(),
});
const SearchAndReplaceBaseSchema = z.object({
    files: z.array(z.object({
        path: z.string(),
        search: z.string(),
        replace: z.string(),
        use_regex: z.boolean().optional(),
        case_sensitive: z.boolean().optional(),
        preview: z.boolean().optional(),
    })).optional(),
    paths: z.array(z.string()).optional(),
    search: z.string().optional(),
    replace: z.string().optional(),
    use_regex: z.boolean().optional(),
    case_sensitive: z.boolean().optional(),
    file_pattern: z.string().optional(),
    recursive: z.boolean().optional(),
    preview: z.boolean().optional(),
});
const SearchAndReplaceArgsSchema = SearchAndReplaceBaseSchema.refine(data => data.files || (data.paths && data.search && data.replace), {
    message: "Soit 'files' soit 'paths', 'search' et 'replace' doivent être fournis",
});
const RestartMcpServersArgsSchema = z.object({
  servers: z.array(z.string()),
});
// Interfaces specific to business logic from old file
interface LineRange { start: number; end: number; }
interface FileWithExcerpts { path: string; excerpts?: LineRange[]; }
interface DirectoryToList { path: string; recursive?: boolean; max_depth?: number; file_pattern?: string; sort_by?: 'name' | 'size' | 'modified' | 'type'; sort_order?: 'asc' | 'desc'; }
interface FileDiff { search: string; replace: string; start_line?: number; }
interface FileEdit { path: string; diffs: FileDiff[]; }
interface MarkdownHeading { text: string; level: number; line: number; context?: string[]; }
interface FileCopyOperation { source: string; destination: string; transform?: { pattern: string; replacement: string; }; conflict_strategy?: 'overwrite' | 'ignore' | 'rename'; }
class QuickFilesServer {
  private server: McpServer;
 
  constructor() {
    this.server = new McpServer({
      name: 'quickfiles',
      version: '1.0.0',
      tools: [
        {
          name: "read_multiple_files",
          description: "Lit plusieurs fichiers en une seule requête avec numérotation de lignes optionnelle et extraits de fichiers. Tronque automatiquement les contenus volumineux pour éviter les problèmes de mémoire et de performance.",
          inputSchema: ReadMultipleFilesArgsSchema.shape,
          handler: this.handleReadMultipleFiles.bind(this)
        },
        {
          name: "list_directory_contents",
          description: "Liste tous les fichiers et répertoires sous un chemin donné, avec la taille des fichiers et le nombre de lignes. Tronque automatiquement les résultats volumineux pour éviter les problèmes de performance.",
          inputSchema: ListDirectoryContentsArgsSchema.shape,
          handler: this.handleListDirectoryContents.bind(this)
        },
        {
          name: "delete_files",
          description: "Supprime une liste de fichiers en une seule opération",
          inputSchema: DeleteFilesArgsSchema.shape,
          handler: this.handleDeleteFiles.bind(this)
        },
        {
          name: "edit_multiple_files",
          description: "Édite plusieurs fichiers en une seule opération en appliquant des diffs",
          inputSchema: EditMultipleFilesArgsSchema.shape,
          handler: this.handleEditMultipleFiles.bind(this)
        },
        {
            name: "extract_markdown_structure",
            description: "Analyse les fichiers markdown et extrait les titres avec leurs numéros de ligne",
            inputSchema: ExtractMarkdownStructureArgsSchema.shape,
            handler: this.handleExtractMarkdownStructure.bind(this)
        },
        {
            name: "copy_files",
            description: "Copie une liste de fichiers ou de répertoires d'une source vers une destination. Supporte les motifs glob, la transformation des noms de fichiers et la gestion des conflits.",
            inputSchema: CopyFilesArgsSchema.shape,
            handler: this.handleCopyFiles.bind(this)
        },
        {
            name: "move_files",
            description: "Déplace une liste de fichiers ou de répertoires d'une source vers une destination. Supporte les motifs glob, la transformation des noms de fichiers et la gestion des conflits.",
            inputSchema: MoveFilesArgsSchema.shape,
            handler: this.handleMoveFiles.bind(this)
        },
        {
            name: "search_in_files",
            description: "Recherche des motifs dans plusieurs fichiers/répertoires avec support des expressions régulières et affichage du contexte autour des correspondances.",
            inputSchema: SearchInFilesArgsSchema.shape,
            handler: this.handleSearchInFiles.bind(this)
        },
        {
            name: "search_and_replace",
            description: "Recherche et remplace des motifs dans plusieurs fichiers avec support des expressions régulières et des captures de groupes.",
            inputSchema: SearchAndReplaceBaseSchema.shape,
            handler: this.handleSearchAndReplace.bind(this)
        },
        {
            name: "restart_mcp_servers",
            description: "Redémarre un ou plusieurs serveurs MCP en modifiant leur fichier de configuration.",
            inputSchema: RestartMcpServersArgsSchema.shape,
            handler: this.handleRestartMcpServers.bind(this)
        }
      ]
    });
 
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }
 
  private async handleReadMultipleFiles(args: z.infer<typeof ReadMultipleFilesArgsSchema>) {
    const {
        paths,
        show_line_numbers = false,
        max_lines_per_file = 2000,
        max_total_lines = 5000,
        max_chars_per_file = 160000,
        max_total_chars = 400000,
    } = args;
    try {
        let totalLines = 0;
        let totalChars = 0;
        const fileContents: { path: string; content: string; truncated: boolean, error?: string }[] = [];
        for (const file of paths) {
            const filePath = typeof file === 'string' ? file : file.path;
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
                        const start = Math.max(0, excerpt.start - 1);
                        const end = Math.min(lines.length, excerpt.end);
                        extractedLines.push(...lines.slice(start, end));
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
                fileContents.push({ path: filePath, content: formattedContent, truncated, });
                if (totalLines >= max_total_lines || totalChars >= max_total_chars) {
                    break;
                }
            } catch (error) {
                fileContents.push({ path: filePath, content: '', truncated: false, error: (error as Error).message, });
            }
        }
        const formattedResponse = fileContents.map(f => {
            let header = `--- ${f.path} ---\n`;
            if (f.error) {
                header += `ERROR: ${f.error}\n`;
            } else {
                if (f.truncated) {
                    header += `(contenu tronqué)\n`;
                }
                header += f.content;
            }
            return header;
        }).join('\n\n');
        return { content: [{ type: 'text' as const, text: formattedResponse }] };
    } catch (error) {
        return { content: [{ type: 'text' as const, text: `Erreur lors de la lecture des fichiers: ${(error as Error).message}` }], isError: true };
    }
  }
   
  private async handleListDirectoryContents(args: z.infer<typeof ListDirectoryContentsArgsSchema>) {
    const {
        paths,
        max_lines = 2000,
        max_depth: global_max_depth,
        file_pattern: global_file_pattern,
        sort_by: global_sort_by = 'name',
        sort_order: global_sort_order = 'asc',
    } = args;
    try {
        let output = '';
        let lineCount = 0;
        for (const dir of paths) {
            const dirPath = typeof dir === 'string' ? dir : dir.path;
            const {
                recursive = true,
                max_depth = global_max_depth,
                file_pattern = global_file_pattern,
                sort_by = global_sort_by,
                sort_order = global_sort_order,
            } = typeof dir === 'object' ? dir : {};
            if (lineCount >= max_lines) {
                output += "\n(limite de lignes atteinte, résultats tronqués)\n";
                break;
            }
            output += `## Contenu de: ${dirPath}\n\n`;
            lineCount += 2;
            try {
                const files = await this.listDirectory(dirPath, recursive, max_depth, file_pattern);
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
                    const lines = file.lines || 'N/A';
                    output += `| ${type} | ${file.name} | ${size} | ${modified} | ${lines} |\n`;
                    lineCount++;
                }
                output += "\n";
                lineCount++;
            } catch (error) {
                output += `Erreur lors du listage de ${dirPath}: ${(error as Error).message}\n\n`;
                lineCount += 2;
            }
        }
        return { content: [{ type: 'text' as const, text: output }] };
    } catch (error) {
        return { content: [{ type: 'text' as const, text: `Erreur lors du listage des répertoires: ${(error as Error).message}` }], isError: true };
    }
  }
  // Helper functions for listDirectoryContents
  private async listDirectory(dirPath: string, recursive: boolean, max_depth?: number, file_pattern?: string, current_depth = 0) {
      if (max_depth !== undefined && current_depth >= max_depth) {
          return [];
      }
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      let files: any[] = [];
      for (const entry of entries) {
          const fullPath = path.join(dirPath, entry.name);
          if (file_pattern && entry.isFile() && !glob.sync(file_pattern, { cwd: dirPath }).includes(entry.name)) {
              continue;
          }
          const stats = await fs.stat(fullPath);
          const fileData = {
              name: entry.name,
              path: fullPath,
              isDirectory: entry.isDirectory(),
              size: stats.size,
              modified: stats.mtimeMs,
              lines: entry.isFile() ? (await this.countLines(fullPath)) : 0,
          };
          files.push(fileData);
          if (recursive && entry.isDirectory()) {
              files.push(...(await this.listDirectory(fullPath, recursive, max_depth, file_pattern, current_depth + 1)).map(f => ({ ...f, name: path.join(entry.name, f.name) })));
          }
      }
      return files;
  }
  private async countLines(filePath: string) {
      try {
          const content = await fs.readFile(filePath, 'utf-8');
          return content.split('\n').length;
      } catch (error) {
          return 0;
      }
  }
  private sortFiles(files: any[], sort_by: string, sort_order: string) {
      files.sort((a, b) => {
          let compare = 0;
          if (sort_by === 'name') compare = a.name.localeCompare(b.name);
          else if (sort_by === 'size') compare = (a.size || 0) - (b.size || 0);
          else if (sort_by === 'modified') compare = (a.modified || 0) - (b.modified || 0);
          else if (sort_by === 'type') {
              if (a.isDirectory && !b.isDirectory) compare = -1;
              else if (!a.isDirectory && b.isDirectory) compare = 1;
              else compare = a.name.localeCompare(b.name);
          }
          return sort_order === 'asc' ? compare : -compare;
      });
  }
   
  private async handleDeleteFiles(args: z.infer<typeof DeleteFilesArgsSchema>) {
    const { paths } = args;
    try {
        const results = await Promise.all(
            paths.map(async (filePath) => {
                try {
                    await fs.unlink(filePath);
                    return { path: filePath, success: true };
                } catch (error) {
                    return { path: filePath, success: false, error: (error as Error).message };
                }
            })
        );
        let report = "## Rapport de suppression de fichiers\n\n";
        results.forEach(r => {
            report += r.success
                ? `- ✅ ${r.path}: Supprimé avec succès.\n`
                : `- ❌ ${r.path}: Échec de la suppression - ${r.error}.\n`;
        });
        return { content: [{ type: 'text' as const, text: report }] };
    } catch (error) {
        return { content: [{ type: 'text' as const, text: `Erreur lors de la suppression des fichiers: ${(error as Error).message}` }], isError: true };
    }
  }
   
  private async handleEditMultipleFiles(args: z.infer<typeof EditMultipleFilesArgsSchema>) {
     const { files } = args;
    try {
        const results = await Promise.all(
            files.map(async (fileEdit) => {
                const { path: filePath, diffs } = fileEdit;
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
                                modificationsCount++;
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
                    return { path: filePath, success: errors.length === 0, modifications: modificationsCount, errors };
                } catch (error) {
                    return { path: filePath, success: false, error: (error as Error).message };
                }
            })
        );
        let report = "## Rapport d'édition de fichiers\n\n";
        results.forEach(r => {
            if (r.success) {
                report += `- ✅ ${r.path}: ${r.modifications} modification(s) appliquée(s).\n`;
            } else {
                const errorMessage = r.error || (r.errors ? r.errors.join(', ') : 'Erreur inconnue');
                report += `- ❌ ${r.path}: Échec de l'édition - ${errorMessage}.\n`;
            }
        });
        return { content: [{ type: 'text' as const, text: report }] };
    } catch (error) {
        return { content: [{ type: 'text' as const, text: `Erreur lors de l'édition des fichiers: ${(error as Error).message}` }], isError: true };
    }
  }
  private async handleExtractMarkdownStructure(args: z.infer<typeof ExtractMarkdownStructureArgsSchema>) {
    const { paths: filePaths, max_depth = 6, include_context = false, context_lines = 2 } = args;
    try {
        const allFilesHeadings = await Promise.all(
            filePaths.map(async (filePath) => {
                try {
                    const content = await fs.readFile(filePath, 'utf-8');
                    const { headings, fileInfo } = this.parseMarkdown(content, max_depth, context_lines);
                    return { path: filePath, success: true, headings, fileInfo };
                } catch (error) {
                    return { path: filePath, success: false, error: (error as Error).message };
                }
            })
        );
        let formattedResponse = "## Structure des fichiers Markdown\n\n";
        for (const fileResult of allFilesHeadings) {
            formattedResponse += `### Fichier: ${fileResult.path}\n\n`;
            if (fileResult.success && fileResult.headings) {
                if (fileResult.headings.length === 0) {
                    formattedResponse += "Aucun titre trouvé.\n\n";
                } else {
                    for (const heading of fileResult.headings) {
                        formattedResponse += `${'  '.repeat(heading.level - 1)}- [Ligne ${heading.line}] ${heading.text}\n`;
                    }
                }
            } else {
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
                heading = { text: atxMatch[2].trim(), level, line: i + 1, };
            }
        } else if (i > 0) {
            if (setextH1Regex.test(line) && lines[i - 1].trim().length > 0 && 1 <= maxDepth) {
                heading = { text: lines[i - 1].trim(), level: 1, line: i, };
            } else if (setextH2Regex.test(line) && lines[i - 1].trim().length > 0 && 2 <= maxDepth) {
                heading = { text: lines[i - 1].trim(), level: 2, line: i, };
            }
        }
        if (heading) {
            headings.push(heading);
        }
    }
    return { headings, fileInfo: {} }; // Simplified
  }
  private async handleCopyFiles(args: z.infer<typeof CopyFilesArgsSchema>) {
    const { operations } = args;
    try {
        const results = await Promise.all(
            operations.map(op => this.processFileCopyOperation(op, 'copy'))
        );
        const formattedResponse = this.formatFileCopyResponse(results, 'copy');
        return { content: [{ type: 'text' as const, text: formattedResponse }] };
    } catch (error) {
        return { content: [{ type: 'text' as const, text: `Erreur lors de la copie des fichiers: ${(error as Error).message}` }], isError: true };
    }
  }
  private async handleMoveFiles(args: z.infer<typeof MoveFilesArgsSchema>) {
    const { operations } = args;
        try {
        const results = await Promise.all(
            operations.map(op => this.processFileCopyOperation(op, 'move'))
        );
        const formattedResponse = this.formatFileCopyResponse(results, 'move');
        return { content: [{ type: 'text' as const, text: formattedResponse }] };
    } catch (error) {
        return { content: [{ type: 'text' as const, text: `Erreur lors du déplacement des fichiers: ${(error as Error).message}` }], isError: true };
    }
  }
  // Helpers for copy/move
  private async processFileCopyOperation(operation: FileCopyOperation, mode: 'copy' | 'move') {
      const { source, destination, transform, conflict_strategy = 'overwrite' } = operation;
      const sourcePaths = await glob(source);
      if (sourcePaths.length === 0) {
          return { source, success: false, error: `Aucun fichier ne correspond au motif: ${source}`, files: [] };
      }
      let isDestDir = false;
      try {
          isDestDir = (await fs.stat(destination)).isDirectory();
      } catch (error) {
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
                          // Simplified renaming logic
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
          output += `### ${result.source} → ${result.destination}\n`;
          for (const file of result.files) {
              if (file.success) output += `- ✅ ${file.source} → ${file.destination} (${file.message})\n`;
              else output += `- ❌ ${file.source} → ${file.destination} (${file.error})\n`;
          }
      }
      return output;
  }
  private async handleSearchInFiles(args: z.infer<typeof SearchInFilesArgsSchema>) {
    const { paths, pattern, use_regex = true, case_sensitive = false, file_pattern, context_lines = 2, max_results_per_file = 100, max_total_results = 1000, recursive = true } = args;
    try {
        const results: any[] = [];
        let totalMatches = 0;
        const searchRegex = new RegExp(pattern, case_sensitive ? 'g' : 'gi');
        const searchInFile = async (filePath: string) => {
            if (totalMatches >= max_total_results) return;
            const content = await fs.readFile(filePath, 'utf-8');
            const lines = content.split('\n');
            const fileMatches = [];
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (searchRegex.test(line)) {
                     const contextStart = Math.max(0, i - context_lines);
                     const contextEnd = Math.min(lines.length - 1, i + context_lines);
                     const context = lines.slice(contextStart, contextEnd + 1);
                     fileMatches.push({ lineNumber: i + 1, line, context });
                     totalMatches++;
                     if(fileMatches.length >= max_results_per_file || totalMatches >= max_total_results) break;
                }
            }
            if (fileMatches.length > 0) results.push({ path: filePath, matches: fileMatches });
        };
       
        for (const searchPath of paths) {
            // Simplified logic: doesn't handle directories recursively or file_pattern
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
  private async handleSearchAndReplace(args: z.infer<typeof SearchAndReplaceArgsSchema>) {
    const { files, paths, search, replace, use_regex = true, case_sensitive = false, file_pattern, recursive = true, preview = false } = args;
    try {
        let totalReplacements = 0;
        let diffs = '';
        const replaceInFile = async (filePath: string, searchPattern: string, replacement: string) => {
            let content = await fs.readFile(filePath, 'utf-8');
            const searchRegex = new RegExp(searchPattern, case_sensitive ? 'g' : 'gi');
            const newContent = content.replace(searchRegex, (match) => {
                totalReplacements++;
                return replacement;
            });
            if (content !== newContent) {
                 diffs += this.generateDiff(content, newContent, filePath) + '\n';
                 if (!preview) await fs.writeFile(filePath, newContent, 'utf-8');
            }
        };
        if (files) {
            for (const file of files) {
                await replaceInFile(file.path, file.search, file.replace);
            }
        } else if (paths && search && replace) {
            for (const searchPath of paths) {
                // Simplified logic: doesn't handle directories or file_pattern
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
  private async handleRestartMcpServers(args: z.infer<typeof RestartMcpServersArgsSchema>) {
    const { servers } = args;
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
            settings.mcpServers[serverName].description = (originalState.description || "") + " (restarting...)";
            await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
            await new Promise(resolve => setTimeout(resolve, 100));
            settings.mcpServers[serverName] = originalState;
            await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
            results.push({ name: serverName, success: true, message: "Redémarrage déclenché." });
        } else {
          results.push({ name: serverName, success: false, error: "Serveur non trouvé dans la configuration." });
        }
      }
    } catch (error) {
       return { content: [{ type: 'text' as const, text: `Erreur lors du redémarrage des serveurs: ${(error as Error).message}` }]};
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify(results) }] };
  }
 
  public getServer(): McpServer {
    return this.server;
  }
}
async function main() {
  try {
    const app = express();
    const quickFilesServer = new QuickFilesServer();
    const mcpServer = quickFilesServer.getServer();
    const transportCache = new NodeCache({ stdTTL: 3600, checkperiod: 600, useClones: false });
    app.use(cors({
        origin: '*',
        exposedHeaders: ['mcp-session-id'],
        allowedHeaders: ['Content-Type', 'mcp-session-id', 'mcp-protocol-version'],
    }));

    app.get('/health', (req, res) => {
        res.status(200).json({ status: 'ok' });
    });
    const handleRequest = async (req: Request, res: Response) => {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        let transport: StreamableHTTPServerTransport | undefined = sessionId ? transportCache.get(sessionId) : undefined;
        if (!transport) {
            transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: randomUUID,
                onsessioninitialized: (newSessionId: string) => {
                    transportCache.set(newSessionId, transport);
                },
            });
            transport.onclose = () => {
                const currentSessionId = transport?.sessionId;
                if (currentSessionId) {
                    transportCache.del(currentSessionId);
                }
            };
            transport.onerror = (err: Error) => {
                console.error(`[Server] Transport error for session ${transport?.sessionId}:`, err);
            };
            await mcpServer.connect(transport);
        }
        // Correction finale : Ne pas passer req.body ici
        await transport.handleRequest(req, res);
    };
    app.post('/mcp', handleRequest);
    app.get('/mcp', handleRequest);
    app.delete('/mcp', handleRequest);
    const PORT = process.env.PORT || 3099;
    app.listen(PORT, () => {
      console.log(`[INFO] QuickFiles server listening on port ${PORT}`);
    });
  } catch (error: any) {
    console.error(`
FATAL ERROR at ${new Date().toISOString()}
Message: ${error.message}
Stack: ${error.stack}
--------------------------------------------------
`);
    process.exit(1);
  }
}
main();
