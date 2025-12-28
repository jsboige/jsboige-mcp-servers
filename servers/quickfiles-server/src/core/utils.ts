import * as fs from 'fs/promises';
import * as path from 'path';
import { DirectoryEntry, SearchMatch, ReplaceResult } from './types.js';

/**
 * Classe utilitaire pour les opérations communes du QuickFiles Server
 */
export class QuickFilesUtils {
  private workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  /**
   * Résout un chemin relatif par rapport au workspace
   */
  resolvePath(filePath: string): string {
    return path.resolve(this.workspaceRoot, filePath);
  }

  /**
   * Échappe tous les caractères spéciaux dans une chaîne pour une utilisation sécurisée dans les expressions régulières
   */
  escapeRegex(pattern: string): string {
    return pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Normalise les sauts de ligne dans une chaîne de recherche
   */
  normalizeLineBreaks(text: string): string {
    return text.replace(/\r\n/g, '\n')  // Windows CRLF
            .replace(/\r/g, '\n')     // Mac CR
            .replace(/\n+/g, '\n');    // Multiples \n en un seul
  }

  /**
   * Ajoute des logs de debug pour tracer les opérations
   */
  debugLog(operation: string, details: any): void {
    if (process.env.DEBUG_QUICKFILES === 'true') {
      console.error(`[QUICKFILES DEBUG] ${operation}:`, details);
    }
  }

  /**
   * Compte le nombre de lignes dans un fichier
   */
  async countLines(filePath: string): Promise<number> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return content.split('\n').length;
    } catch (e) {
      return 0;
    }
  }

  /**
   * Liste le contenu d'un répertoire de manière récursive
   */
  async listDirectory(
    absolutePath: string, 
    originalPath: string, 
    recursive: boolean, 
    max_depth?: number, 
    file_pattern?: string, 
    current_depth = 0
  ): Promise<DirectoryEntry[]> {
    if (max_depth !== undefined && current_depth >= max_depth) {
      return [];
    }

    const entries = await fs.readdir(absolutePath, { withFileTypes: true });
    let files: DirectoryEntry[] = [];

    for (const entry of entries) {
      const fullPath = path.join(absolutePath, entry.name);
      const relativeName = path.join(originalPath, entry.name);

      if (file_pattern && entry.isFile() && !this.matchesFilePattern(entry.name, file_pattern)) {
        continue;
      }

      const stats = await fs.stat(fullPath);
      const fileData: DirectoryEntry = {
        name: relativeName,
        isDirectory: entry.isDirectory(),
        size: stats.size,
        modified: stats.mtimeMs,
        lines: entry.isFile() ? await this.countLines(fullPath) : 0,
      };

      files.push(fileData);

      if (recursive && entry.isDirectory()) {
        files.push(...(await this.listDirectory(fullPath, relativeName, recursive, max_depth, file_pattern, current_depth + 1)));
      }
    }

    return files;
  }

  /**
   * Vérifie si un fichier correspond à un pattern (simple glob)
   */
  private matchesFilePattern(fileName: string, pattern: string): boolean {
    // Simple implémentation de pattern matching pour les cas courants
    if (pattern === '*') return true;
    if (pattern.includes('*')) {
      const regexPattern = pattern.replace(/\*/g, '.*');
      const regex = new RegExp('^' + regexPattern + '$');
      return regex.test(fileName);
    }
    return fileName === pattern;
  }

  /**
   * Trie les fichiers selon différents critères
   */
  sortFiles(files: DirectoryEntry[], sortBy: string, sortOrder: string): void {
    files.sort((a, b) => {
      let compare = 0;
      if (sortBy === 'name') compare = a.name.localeCompare(b.name);
      else if (sortBy === 'size') compare = (a.size || 0) - (b.size || 0);
      else if (sortBy === 'modified') compare = (a.modified || 0) - (b.modified || 0);
      return sortOrder === 'asc' ? compare : -compare;
    });
  }

  /**
   * Crée une expression régulière pour la recherche
   */
  createSearchRegex(pattern: string, useRegex: boolean, caseSensitive: boolean): RegExp {
    return useRegex
      ? new RegExp(pattern, caseSensitive ? 'g' : 'gi')
      : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? 'g' : 'gi');
  }

  /**
   * Recherche des correspondances dans un fichier spécifique
   */
  async searchInFile(
    absoluteFilePath: string,
    relativePath: string,
    searchRegex: RegExp,
    options: {
      contextLines: number;
      maxResultsPerFile: number;
      maxTotalResults: number;
    },
    currentTotalMatches: number
  ): Promise<{ matches: SearchMatch[]; totalMatches: number }> {
    if (currentTotalMatches >= options.maxTotalResults) {
      return { matches: [], totalMatches: currentTotalMatches };
    }

    try {
      const content = await fs.readFile(absoluteFilePath, 'utf-8');
      const lines = content.split('\n');
      const fileMatches: SearchMatch[] = [];
      let totalMatches = currentTotalMatches;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        searchRegex.lastIndex = 0; // Reset regex lastIndex
        
        if (searchRegex.test(line)) {
          if (fileMatches.length >= options.maxResultsPerFile || totalMatches >= options.maxTotalResults) {
            break;
          }
          
          const start = Math.max(0, i - options.contextLines);
          const end = Math.min(lines.length, i + options.contextLines + 1);
          const context = lines.slice(start, end);
          fileMatches.push({ lineNumber: i + 1, line, context });
          totalMatches++;
        }
      }

      return { matches: fileMatches, totalMatches };
    } catch (error) {
      return { matches: [], totalMatches: currentTotalMatches };
    }
  }

  /**
   * Génère un diff simple entre deux contenus
   */
  generateDiff(oldContent: string, newContent: string, filePath: string): string {
    return `--- a/${filePath}\n+++ b/${filePath}\n...diff content...`;
  }

  /**
   * Prépare le pattern de recherche en échappant les caractères si nécessaire
   */
  prepareSearchPattern(pattern: string, useRegex: boolean): string {
    if (!useRegex) {
      return pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    return pattern;
  }

  /**
   * Applique les groupes de capture regex dans le texte de remplacement
   */
  applyCaptureGroups(replacement: string, groups: string[], useRegex: boolean): string {
    if (!useRegex || groups.length === 0) {
      return replacement;
    }
    
    let result = replacement;
    for (let i = 0; i < groups.length - 2; i++) { // -2 car les 2 derniers éléments sont l'offset et la chaîne complète
      result = result.replace(new RegExp(`\\$${i + 1}`, 'g'), groups[i] || '');
    }
    return result;
  }
}