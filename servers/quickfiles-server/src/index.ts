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
import { glob } from 'glob';
import { pathToFileURL } from 'url';

// #region Interfaces
interface LineRange {
  start: number;
  end: number;
}

interface FileWithExcerpts {
  path: string;
  excerpts?: LineRange[];
}

interface ReadMultipleFilesArgs {
  paths: string[] | FileWithExcerpts[];
  show_line_numbers?: boolean;
  max_lines_per_file?: number;
  max_total_lines?: number;
  max_chars_per_file?: number;
  max_total_chars?: number;
}

interface DirectoryToList {
  path: string;
  recursive?: boolean;
  max_depth?: number;
  file_pattern?: string;
  sort_by?: 'name' | 'size' | 'modified' | 'type';
  sort_order?: 'asc' | 'desc';
}

interface ListDirectoryContentsArgs {
  paths: string[] | DirectoryToList[];
  max_lines?: number;
  max_depth?: number;
  file_pattern?: string;
  sort_by?: 'name' | 'size' | 'modified' | 'type';
  sort_order?: 'asc' | 'desc';
}

interface DeleteFilesArgs {
  paths: string[];
}

interface FileDiff {
  search: string;
  replace: string;
  start_line?: number;
}

interface FileEdit {
  path: string;
  diffs: FileDiff[];
}

interface EditMultipleFilesArgs {
  files: FileEdit[];
}

interface ExtractMarkdownStructureArgs {
  paths: string[];
  max_depth?: number;
  include_context?: boolean;
  context_lines?: number;
}

interface FileNameTransformation {
  pattern: string;
  replacement: string;
}

interface FileCopyOperation {
  source: string;
  destination: string;
  transform?: FileNameTransformation;
  conflict_strategy?: 'overwrite' | 'ignore' | 'rename';
}

interface CopyFilesArgs {
  operations: FileCopyOperation[];
}

interface MoveFilesArgs {
  operations: FileCopyOperation[];
}

interface MarkdownHeading {
  text: string;
  level: number;
  line: number;
  context?: string[];
}

interface SearchInFilesArgs {
  paths: string[];
  pattern: string;
  use_regex?: boolean;
  case_sensitive?: boolean;
  file_pattern?: string;
  context_lines?: number;
  max_results_per_file?: number;
  max_total_results?: number;
  recursive?: boolean;
}

interface FileSearchReplace {
  path: string;
  search: string;
  replace: string;
  use_regex?: boolean;
  case_sensitive?: boolean;
  preview?: boolean;
}

interface SearchAndReplaceArgs {
  files?: FileSearchReplace[];
  paths?: string[];
  search?: string;
  replace?: string;
  use_regex?: boolean;
  case_sensitive?: boolean;
  file_pattern?: string;
  recursive?: boolean;
  preview?: boolean;
}

interface CreateDirectoryArgs {
  path: string;
}

interface WriteFileArgs {
  path: string;
  content: string;
}

interface DirectoryTreeArgs {
  path: string;
}

interface GetFileInfoArgs {
  path: string;
}
// #endregion

// #region Type Guards
const isValidCreateDirectoryArgs = (args: any): args is CreateDirectoryArgs => {
  return typeof args === 'object' && args !== null && typeof args.path === 'string';
};

const isValidWriteFileArgs = (args: any): args is WriteFileArgs => {
  return typeof args === 'object' && args !== null && typeof args.path === 'string' && typeof args.content === 'string';
};

const isValidDirectoryTreeArgs = (args: any): args is DirectoryTreeArgs => {
    return typeof args === 'object' && args !== null && typeof args.path === 'string';
};

const isValidGetFileInfoArgs = (args: any): args is GetFileInfoArgs => {
    return typeof args === 'object' && args !== null && typeof args.path === 'string';
};

const isValidReadMultipleFilesArgs = (args: any): args is ReadMultipleFilesArgs => {
  if (typeof args !== 'object' || args === null) return false;
  if (!Array.isArray(args.paths)) return false;
  for (const item of args.paths) {
    if (typeof item === 'string') {
      continue;
    } else if (typeof item === 'object' && item !== null) {
      if (typeof item.path !== 'string') return false;
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
  if (args.show_line_numbers !== undefined && typeof args.show_line_numbers !== 'boolean') return false;
  if (args.max_lines_per_file !== undefined && typeof args.max_lines_per_file !== 'number') return false;
  if (args.max_total_lines !== undefined && typeof args.max_total_lines !== 'number') return false;
  if (args.max_chars_per_file !== undefined && typeof args.max_chars_per_file !== 'number') return false;
  if (args.max_total_chars !== undefined && typeof args.max_total_chars !== 'number') return false;
  return true;
};

const isValidListDirectoryContentsArgs = (args: any): args is ListDirectoryContentsArgs => {
  if (typeof args !== 'object' || args === null) return false;
  if (!Array.isArray(args.paths)) return false;
  for (const item of args.paths) {
    if (typeof item === 'string') {
      continue;
    } else if (typeof item === 'object' && item !== null) {
      if (typeof item.path !== 'string') return false;
      if (item.recursive !== undefined && typeof item.recursive !== 'boolean') return false;
      if (item.max_depth !== undefined && (typeof item.max_depth !== 'number' || item.max_depth < 1)) return false;
      if (item.file_pattern !== undefined && typeof item.file_pattern !== 'string') return false;
      if (item.sort_by !== undefined && !['name', 'size', 'modified', 'type'].includes(item.sort_by)) return false;
      if (item.sort_order !== undefined && !['asc', 'desc'].includes(item.sort_order)) return false;
    } else {
      return false;
    }
  }
  if (args.max_lines !== undefined && typeof args.max_lines !== 'number') return false;
  if (args.max_depth !== undefined && (typeof args.max_depth !== 'number' || args.max_depth < 1)) return false;
  if (args.file_pattern !== undefined && typeof args.file_pattern !== 'string') return false;
  if (args.sort_by !== undefined && !['name', 'size', 'modified', 'type'].includes(args.sort_by)) return false;
  if (args.sort_order !== undefined && !['asc', 'desc'].includes(args.sort_order)) return false;
  return true;
};

const isValidDeleteFilesArgs = (args: any): args is DeleteFilesArgs => {
  if (typeof args !== 'object' || args === null) return false;
  if (!Array.isArray(args.paths)) return false;
  for (const path of args.paths) {
    if (typeof path !== 'string') return false;
  }
  return true;
};

const isValidEditMultipleFilesArgs = (args: any): args is EditMultipleFilesArgs => {
  if (typeof args !== 'object' || args === null) return false;
  if (!Array.isArray(args.files)) return false;
  for (const file of args.files) {
    if (typeof file !== 'object' || file === null) return false;
    if (typeof file.path !== 'string') return false;
    if (!Array.isArray(file.diffs)) return false;
    for (const diff of file.diffs) {
      if (typeof diff !== 'object' || diff === null) return false;
      if (typeof diff.search !== 'string') return false;
      if (typeof diff.replace !== 'string') return false;
      if (diff.start_line !== undefined && typeof diff.start_line !== 'number') return false;
    }
  }
  return true;
};

const isValidExtractMarkdownStructureArgs = (args: any): args is ExtractMarkdownStructureArgs => {
  if (typeof args !== 'object' || args === null) return false;
  if (!Array.isArray(args.paths)) return false;
  for (const path of args.paths) {
    if (typeof path !== 'string') return false;
  }
  if (args.max_depth !== undefined && typeof args.max_depth !== 'number') return false;
  if (args.include_context !== undefined && typeof args.include_context !== 'boolean') return false;
  if (args.context_lines !== undefined && typeof args.context_lines !== 'number') return false;
  return true;
};

const isValidCopyFilesArgs = (args: any): args is CopyFilesArgs => {
  if (typeof args !== 'object' || args === null) return false;
  if (!Array.isArray(args.operations)) return false;
  for (const operation of args.operations) {
    if (typeof operation !== 'object' || operation === null) return false;
    if (typeof operation.source !== 'string') return false;
    if (typeof operation.destination !== 'string') return false;
    if (operation.transform !== undefined) {
      if (typeof operation.transform !== 'object' || operation.transform === null) return false;
      if (typeof operation.transform.pattern !== 'string') return false;
      if (typeof operation.transform.replacement !== 'string') return false;
    }
    if (operation.conflict_strategy !== undefined &&
        !['overwrite', 'ignore', 'rename'].includes(operation.conflict_strategy)) {
      return false;
    }
  }
  return true;
};

const isValidMoveFilesArgs = (args: any): args is MoveFilesArgs => {
  return isValidCopyFilesArgs(args);
};

const isValidSearchInFilesArgs = (args: any): args is SearchInFilesArgs => {
  if (typeof args !== 'object' || args === null) return false;
  if (!Array.isArray(args.paths)) return false;
  if (typeof args.pattern !== 'string') return false;
  for (const path of args.paths) {
    if (typeof path !== 'string') return false;
  }
  if (args.use_regex !== undefined && typeof args.use_regex !== 'boolean') return false;
  if (args.case_sensitive !== undefined && typeof args.case_sensitive !== 'boolean') return false;
  if (args.file_pattern !== undefined && typeof args.file_pattern !== 'string') return false;
  if (args.context_lines !== undefined && typeof args.context_lines !== 'number') return false;
  if (args.max_results_per_file !== undefined && typeof args.max_results_per_file !== 'number') return false;
  if (args.max_total_results !== undefined && typeof args.max_total_results !== 'number') return false;
  if (args.recursive !== undefined && typeof args.recursive !== 'boolean') return false;
  return true;
};

const isValidSearchAndReplaceArgs = (args: any): args is SearchAndReplaceArgs => {
  if (typeof args !== 'object' || args === null) return false;
  if (!args.files && !(args.paths && args.search && args.replace)) return false;
  if (args.files !== undefined) {
    if (!Array.isArray(args.files)) return false;
    for (const file of args.files) {
      if (typeof file !== 'object' || file === null) return false;
      if (typeof file.path !== 'string') return false;
      if (typeof file.search !== 'string') return false;
      if (typeof file.replace !== 'string') return false;
      if (file.use_regex !== undefined && typeof file.use_regex !== 'boolean') return false;
      if (file.case_sensitive !== undefined && typeof file.case_sensitive !== 'boolean') return false;
      if (file.preview !== undefined && typeof file.preview !== 'boolean') return false;
    }
  }
  if (args.paths !== undefined) {
    if (!Array.isArray(args.paths)) return false;
    for (const path of args.paths) {
      if (typeof path !== 'string') return false;
    }
    if (typeof args.search !== 'string') return false;
    if (typeof args.replace !== 'string') return false;
  }
  if (args.use_regex !== undefined && typeof args.use_regex !== 'boolean') return false;
  if (args.case_sensitive !== undefined && typeof args.case_sensitive !== 'boolean') return false;
  if (args.file_pattern !== undefined && typeof args.file_pattern !== 'string') return false;
  if (args.recursive !== undefined && typeof args.recursive !== 'boolean') return false;
  if (args.preview !== undefined && typeof args.preview !== 'boolean') return false;
  return true;
};
// #endregion

export class QuickFilesServer {
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
          description: 'Lit plusieurs fichiers en une seule requête avec numérotation de lignes optionnelle et extraits de fichiers. Tronque automatiquement les contenus volumineux pour éviter les problèmes de mémoire et de performance.',
          inputSchema: { /* ... */ }
        },
        {
          name: 'list_directory_contents',
          description: 'Liste tous les fichiers et répertoires sous un chemin donné, avec la taille des fichiers et le nombre de lignes. Tronque automatiquement les résultats volumineux pour éviter les problèmes de performance.',
          inputSchema: { /* ... */ }
        },
        {
          name: 'delete_files',
          description: 'Supprime une liste de fichiers en une seule opération',
          inputSchema: { /* ... */ }
        },
        {
          name: 'create_directory',
          description: 'Crée un nouveau répertoire (et les répertoires parents si nécessaire)',
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Chemin du répertoire à créer' },
            },
            required: ['path'],
          },
        },
        {
          name: 'write_file',
          description: 'Écrit du contenu dans un fichier, le créant si nécessaire.',
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Chemin du fichier à écrire.' },
              content: { type: 'string', description: 'Contenu à écrire dans le fichier.' },
            },
            required: ['path', 'content'],
          },
        },
        {
          name: 'directory_tree',
          description: 'Affiche une arborescence de répertoires en JSON.',
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Chemin du répertoire racine.' },
            },
            required: ['path'],
          },
        },
        {
          name: 'get_file_info',
          description: 'Récupère les informations détaillées sur un fichier ou un répertoire.',
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Chemin du fichier ou du répertoire.' },
            },
            required: ['path'],
          },
        },
        {
            name: 'list_allowed_directories',
            description: 'Liste les répertoires autorisés pour ce serveur.',
            inputSchema: {
              type: 'object',
              properties: {},
              required: [],
            },
        },
        {
          name: 'extract_markdown_structure',
          description: 'Analyse les fichiers markdown et extrait les titres avec leurs numéros de ligne',
          inputSchema: { /* ... */ }
        },
        {
          name: 'edit_multiple_files',
          description: 'Édite plusieurs fichiers en une seule opération en appliquant des diffs',
          inputSchema: { /* ... */ }
        },
        {
          name: 'search_in_files',
          description: 'Recherche des motifs dans plusieurs fichiers/répertoires avec support des expressions régulières et affichage du contexte autour des correspondances.',
          inputSchema: { /* ... */ }
        },
        {
          name: 'search_and_replace',
          description: 'Recherche et remplace des motifs dans plusieurs fichiers avec support des expressions régulières et des captures de groupes.',
          inputSchema: { /* ... */ }
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name === 'read_multiple_files') {
        return this.handleReadMultipleFiles(request);
      } else if (request.params.name === 'list_directory_contents') {
        return this.handleListDirectoryContents(request);
      } else if (request.params.name === 'create_directory') {
        return this.handleCreateDirectory(request);
      } else if (request.params.name === 'write_file') {
        return this.handleWriteFile(request);
      } else if (request.params.name === 'directory_tree') {
        return this.handleDirectoryTree(request);
      } else if (request.params.name === 'get_file_info') {
        return this.handleGetFileInfo(request);
      } else if (request.params.name === 'list_allowed_directories') {
        return this.handleListAllowedDirectories(request);
      } else if (request.params.name === 'edit_multiple_files') {
        return this.handleEditMultipleFiles(request);
      } else if (request.params.name === 'delete_files') {
        return this.handleDeleteFiles(request);
      } else if (request.params.name === 'delete_directory') {
        return this.handleDeleteDirectory(request);
      } else {
        throw new McpError(
          ErrorCode.MethodNotFound,
          `Outil inconnu: ${request.params.name}`
        );
      }
    });
  }

  // #region Handlers
  private async handleReadMultipleFiles(request: any): Promise<any> { /* ... implementation ... */ return { content: [] }; }
  private async handleListDirectoryContents(request: any): Promise<any> {
    if (!isValidListDirectoryContentsArgs(request.params.arguments)) {
      throw new McpError(ErrorCode.InvalidParams, 'Paramètres invalides pour list_directory_contents');
    }
    const { paths } = request.params.arguments;
    const results = [];
    for(const p of paths) {
        if(typeof p === 'string') {
            results.push(...await this.listDirectoryContentsRecursive(p, true));
        } else {
            results.push(...await this.listDirectoryContentsRecursive(p.path, p.recursive, p.file_pattern, p.sort_by, p.sort_order, p.max_depth));
        }
    }
    return { content: [{type: 'text', text: JSON.stringify(results)}]};
 }

  private async handleCreateDirectory(request: any): Promise<any> {
    if (!isValidCreateDirectoryArgs(request.params.arguments)) {
      throw new McpError(ErrorCode.InvalidParams, 'Paramètres invalides pour create_directory');
    }
    const { path: dirPath } = request.params.arguments;
    try {
      await fs.mkdir(dirPath, { recursive: true });
      return { content: [{ type: 'text', text: `Répertoire '${dirPath}' créé avec succès.` }] };
    } catch (error) {
      throw new McpError(ErrorCode.InternalError, `Erreur lors de la création du répertoire: ${(error as Error).message}`);
    }
  }

  private async handleWriteFile(request: any): Promise<any> {
    if (!isValidWriteFileArgs(request.params.arguments)) {
      throw new McpError(ErrorCode.InvalidParams, 'Paramètres invalides pour write_file');
    }
    const { path: filePath, content } = request.params.arguments;
    try {
      await fs.writeFile(filePath, content, 'utf-8');
      return { content: [{ type: 'text', text: `Fichier '${filePath}' écrit avec succès.` }] };
    } catch (error) {
      throw new McpError(ErrorCode.InternalError, `Erreur lors de l'écriture du fichier: ${(error as Error).message}`);
    }
  }

  private async handleDirectoryTree(request: any): Promise<any> {
    if (!isValidDirectoryTreeArgs(request.params.arguments)) {
      throw new McpError(ErrorCode.InvalidParams, 'Paramètres invalides pour directory_tree');
    }
    const { path: rootPath } = request.params.arguments;
    try {
      const tree = await this.get_file_tree({ path: rootPath });
      return { content: [{ type: 'text', text: JSON.stringify(tree, null, 2) }] };
    } catch (error) {
      throw new McpError(ErrorCode.InternalError, `Erreur lors de la création de l'arborescence: ${(error as Error).message}`);
    }
  }

  private async handleGetFileInfo(request: any): Promise<any> {
    if (!isValidGetFileInfoArgs(request.params.arguments)) {
      throw new McpError(ErrorCode.InvalidParams, 'Paramètres invalides pour get_file_info');
    }
    const { path: filePath } = request.params.arguments;
    try {
      const stats = await fs.stat(filePath);
      const info = {
        path: filePath,
        type: stats.isDirectory() ? 'directory' : 'file',
        size: stats.size,
        createdAt: stats.birthtime,
        modifiedAt: stats.mtime,
        accessedAt: stats.atime,
        permissions: `0${(stats.mode & 0o777).toString(8)}`,
      };
      return { content: [{ type: 'text', text: JSON.stringify(info, null, 2) }] };
    } catch (error) {
      throw new McpError(ErrorCode.InternalError, `Erreur lors de la récupération des informations: ${(error as Error).message}`);
    }
  }

  private async handleListAllowedDirectories(request: any): Promise<any> {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify([], null, 2),
        },
      ],
    };
  }

  private async handleEditMultipleFiles(request: any): Promise<any> {
    if (!isValidEditMultipleFilesArgs(request.params.arguments)) {
      throw new McpError(ErrorCode.InvalidParams, 'Paramètres invalides pour edit_multiple_files');
    }

    const { files } = request.params.arguments;
    const results = [];

    for (const fileEdit of files) {
      try {
        let content: string;
        try {
          content = await fs.readFile(fileEdit.path, 'utf-8');
        } catch (error) {
          // Si le fichier n'existe pas, on le crée
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            content = '';
          } else {
            throw error;
          }
        }

        for (const diff of fileEdit.diffs) {
          if (content.includes(diff.search)) {
            content = content.replace(diff.search, diff.replace);
          } else if (content === '') {
            // Si le fichier vient d'être créé, on insère le premier remplacement
            content = diff.replace;
          }
        }

        await fs.writeFile(fileEdit.path, content, 'utf-8');
        results.push({ path: fileEdit.path, success: true });
      } catch (error) {
        results.push({ path: fileEdit.path, success: false, error: (error as Error).message });
      }
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(results, null, 2),
        },
      ],
    };
  }

  private async handleDeleteFiles(request: any): Promise<any> {
    if (!isValidDeleteFilesArgs(request.params.arguments)) {
      throw new McpError(ErrorCode.InvalidParams, 'Paramètres invalides pour delete_files');
    }
    const { paths } = request.params.arguments;
    const results = [];
    for (const p of paths) {
      try {
        await fs.unlink(p);
        results.push({ path: p, success: true });
      } catch (error) {
        results.push({ path: p, success: false, error: (error as Error).message });
      }
    }
    return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
  }

  private async handleDeleteDirectory(request: any): Promise<any> {
    // Note: This is a simplified implementation for the test.
    // A robust implementation would check for recursive options etc.
    const { path } = request.params.arguments;
    try {
      await fs.rm(path, { recursive: true, force: true });
      return { content: [{ type: 'text', text: `Répertoire '${path}' supprimé.` }] };
    } catch (error) {
      throw new McpError(ErrorCode.InternalError, `Erreur lors de la suppression du répertoire: ${(error as Error).message}`);
    }
  }
  // #endregion

  // #region Utility Methods
  private async listDirectoryContentsRecursive(dirPath: string, recursive: boolean, filePattern?: string, sortBy: 'name' | 'size' | 'modified' | 'type' = 'name', sortOrder: 'asc' | 'desc' = 'asc', maxDepth: number = 5, currentDepth: number = 1): Promise<any> {
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      let items = await Promise.all(
        entries.map(async (entry) => {
          const fullPath = path.join(dirPath, entry.name);
          if (entry.isDirectory()) {
            let children = [];
            if (recursive && (!maxDepth || currentDepth < maxDepth)) {
              children = await this.listDirectoryContentsRecursive(fullPath, recursive, filePattern, sortBy, sortOrder, maxDepth, currentDepth + 1);
            }
            return { name: entry.name, type: 'directory', children };
          } else if (entry.isFile()) {
            if (filePattern && !glob.sync(filePattern, { cwd: path.join(dirPath, entry.name) }).length) {
              return null;
            }
            const stats = await fs.stat(fullPath);
            const lineCount = await this.countLines(fullPath);
            return { name: entry.name, type: 'file', size: stats.size, modified: stats.mtimeMs, lineCount };
          }
          return null;
        })
      );
      const filteredItems = items.filter((item): item is NonNullable<typeof item> => item !== null);
      filteredItems.sort((a, b) => {
        const order = sortOrder === 'asc' ? 1 : -1;
        if (sortBy === 'type') {
          if (a.type === b.type) return a.name.localeCompare(b.name) * order;
          return (a.type === 'directory' ? -1 : 1) * order;
        }
        if (sortBy === 'name') return a.name.localeCompare(b.name) * order;
        if (sortBy === 'size') return ((a.size ?? 0) - (b.size ?? 0)) * order;
        if (sortBy === 'modified') return ((a.modified ?? 0) - (b.modified ?? 0)) * order;
        return 0;
      });
      return filteredItems;
    } catch (error) {
      console.error(`[ERROR] Impossible de lire le répertoire ${dirPath}: ${(error as Error).message}`);
      return [];
    }
  }

  private async countLines(filePath: string): Promise<number> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return content.split('\n').length;
    } catch (error) {
      return 0;
    }
  }

  private formatFileSize(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  private formatDirectoryContents(dirPath: string, contents: any[]): string {
    let result = `## 🌳 Arborescence de : ${dirPath}\n`;
    const dirCount = contents.filter(item => item.type === 'directory').length;
    const fileCount = contents.filter(item => item.type === 'file').length;
    result += `> **Synthèse**: ${dirCount} répertoires, ${fileCount} fichiers.\n\n`;

    const formatContents = (items: any[], indent: string = ''): string => {
      let output = '';
      items.forEach((item, index) => {
        const isLast = index === items.length - 1;
        const prefix = isLast ? '└── ' : '├── ';
        const childIndent = isLast ? '    ' : '│   ';

        if (item.type === 'directory') {
          output += `${indent}${prefix}📁 **${item.name}/**\n`;
          if (item.children && item.children.length > 0) {
            output += formatContents(item.children, indent + childIndent);
          }
        } else {
          const sizeStr = this.formatFileSize(item.size);
          const modifiedStr = new Date(item.modified).toLocaleDateString();
          const lineCountStr = item.lineCount ? `(${item.lineCount} lignes)` : '';
          output += `${indent}${prefix}📄 ${item.name}  *(${sizeStr}, ${lineCountStr}, modif. ${modifiedStr})*\n`;
        }
      });
      return output;
    };
    result += "```\n" + formatContents(contents) + "```";
    return result;
  }

  public async get_file_tree(args: { path: string }): Promise<any> {
    const stats = await fs.stat(args.path);
    if (!stats.isDirectory()) {
      throw new Error("Le chemin fourni n'est pas un répertoire.");
    }

    const entries = await fs.readdir(args.path, { withFileTypes: true });
    const items = await Promise.all(
      entries.map(async (entry) => {
        const fullPath = path.join(args.path, entry.name);
        const entryStats = await fs.stat(fullPath);
        if (entry.isDirectory()) {
          return {
            name: entry.name,
            type: 'directory',
            size: entryStats.size,
            children: await this.get_file_tree({ path: fullPath }), // Appel récursif
          };
        } else {
          return {
            name: entry.name,
            type: 'file',
            size: entryStats.size,
            children: [],
          };
        }
      })
    );
     // tri pour la comparaison
    return items.sort((a,b) => a.name.localeCompare(b.name));
  }
  public async read_file_content(args: { path: string }): Promise<string> {
    return fs.readFile(args.path, 'utf-8');
  }

  public async get_file_metadata(args: { path: string }): Promise<any> {
    const stats = await fs.stat(args.path);
    return {
      name: path.basename(args.path),
      type: stats.isDirectory() ? 'directory' : 'file',
      size: stats.size,
    };
  }
  // #endregion

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('QuickFiles server started');
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = new QuickFilesServer();
  server.run().catch((error) => {
    console.error('Erreur fatale:', error);
    process.exit(1);
  });
}
