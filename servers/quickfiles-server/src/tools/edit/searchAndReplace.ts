import * as fs from 'fs/promises';
import * as path from 'path';
import { glob } from 'glob';
import { SearchAndReplaceBaseSchema } from '../../validation/schemas.js';
import { ReplaceResult, ProcessFilesResult, SearchAndReplaceOptions } from '../../core/types.js';
import { QuickFilesUtils } from '../../core/utils.js';

/**
 * Outil pour rechercher et remplacer du contenu dans les fichiers
 */
export class SearchAndReplaceTool {
  private utils: QuickFilesUtils;

  constructor(utils: QuickFilesUtils) {
    this.utils = utils;
  }

  async handle(request: any): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
    try {
      // Extraire et valider les arguments
      const args = request.params?.arguments || request;
      const validatedArgs = this.validateSearchAndReplaceArgs(args);
      
      const { files, paths, search, replace, use_regex, case_sensitive, file_pattern, recursive, preview } = validatedArgs;
      
      let totalReplacements = 0;
      let diffs = '';
      
      const options: SearchAndReplaceOptions = {
        useRegex: use_regex,
        caseSensitive: case_sensitive,
        file_pattern,
        recursive,
        preview
      };
      
      if (files && Array.isArray(files)) {
        // Gérer le cas avec fichiers spécifiques
        const result = await this.processSpecificFiles(files, options);
        totalReplacements += result.totalReplacements;
        diffs += result.diffs;
      } else if (paths && search && replace) {
        // Gérer le cas avec chemins et recherche/remplacement globaux
        const result = await this.processPaths(paths, search, replace, options);
        totalReplacements += result.totalReplacements;
        diffs += result.diffs;
      }
     
      // Déterminer si nous sommes en mode prévisualisation
      const isPreviewMode = files ?
        files.some((f: any) => f.preview) :
        preview;
        
      let report = isPreviewMode ? `# Prévisualisation des modifications\n\n` : `# Modifications effectuées\n\n`;
      report += `Total de remplacements: ${totalReplacements}\n\n${diffs}`;
      return { content: [{ type: 'text' as const, text: report }] };
    } catch (error) {
      return { content: [{ type: 'text' as const, text: `Erreur lors du remplacement: ${(error as Error).message}` }], isError: true };
    }
  }

  /**
   * Valide les arguments pour l'opération de recherche et remplacement
   */
  private validateSearchAndReplaceArgs(args: any): {
    files?: any[];
    paths?: string[];
    search?: string;
    replace?: string;
    use_regex: boolean;
    case_sensitive: boolean;
    file_pattern?: string;
    recursive: boolean;
    preview: boolean;
  } {
    if (!args.files && !args.paths) {
      throw new Error("Either 'files' or 'paths' must be provided");
    }
    
    if (args.files && (!Array.isArray(args.files) || args.files.length === 0)) {
      throw new Error("'files' must be a non-empty array");
    }
    
    if (args.paths && (!Array.isArray(args.paths) || args.paths.length === 0)) {
      throw new Error("'paths' must be a non-empty array");
    }
    
    if (args.paths && (!args.search || !args.replace)) {
      throw new Error("'search' and 'replace' are required when using 'paths'");
    }
    
    return {
      files: args.files,
      paths: args.paths,
      search: args.search,
      replace: args.replace,
      use_regex: args.use_regex ?? true,
      case_sensitive: args.case_sensitive ?? false,
      file_pattern: args.file_pattern,
      recursive: args.recursive ?? true,
      preview: args.preview ?? false
    };
  }

  /**
   * Traite les fichiers spécifiques avec leurs propres paramètres
   */
  private async processSpecificFiles(files: any[], globalOptions: SearchAndReplaceOptions): Promise<ProcessFilesResult> {
    let totalReplacements = 0;
    let diffs = '';
    
    for (const file of files) {
      if (!file.path || !file.search || !file.replace) {
        continue;
      }
      
      const fileOptions: SearchAndReplaceOptions = {
        useRegex: file.use_regex !== undefined ? file.use_regex : globalOptions.useRegex,
        caseSensitive: file.case_sensitive !== undefined ? file.case_sensitive : globalOptions.caseSensitive,
        preview: file.preview !== undefined ? file.preview : globalOptions.preview
      };
      
      const result = await this.replaceInFile(file.path, file.search, file.replace, fileOptions);
      if (result.modified) {
        totalReplacements++;
        diffs += result.diff;
      }
    }
    
    return { totalReplacements, diffs };
  }

  /**
   * Traite les chemins avec recherche/remplacement globaux
   */
  private async processPaths(
    paths: string[],
    search: string,
    replace: string,
    options: SearchAndReplaceOptions
  ): Promise<ProcessFilesResult> {
    let totalReplacements = 0;
    let diffs = '';
    
    for (const searchPath of paths) {
      const resolvedPath = this.utils.resolvePath(searchPath);
      
      try {
        const stats = await fs.stat(resolvedPath);
        
        if (stats.isFile()) {
          // Fichier unique
          const result = await this.replaceInFile(searchPath, search, replace, options);
          if (result.modified) {
            totalReplacements++;
            diffs += result.diff;
          }
        } else if (stats.isDirectory()) {
          // Répertoire : trouver tous les fichiers correspondants
          const pattern = options.file_pattern || '**/*';
          let globPattern = pattern;
          if (options.file_pattern && !options.file_pattern.includes('**')) {
            globPattern = `**/${options.file_pattern}`;
          }
          
          const matchedFiles = await glob(globPattern, {
            nodir: true,
            absolute: true,
            cwd: resolvedPath
          });
          
          for (const absFile of matchedFiles) {
            const relFile = path.relative(resolvedPath, absFile);
            const displayPath = path.join(searchPath, relFile);
            const result = await this.replaceInFile(displayPath, search, replace, options);
            if (result.modified) {
              totalReplacements++;
              diffs += result.diff;
            }
          }
        }
      } catch (error) {
        // Path doesn't exist or is not accessible, skip it
        continue;
      }
    }
    
    return { totalReplacements, diffs };
  }

  /**
   * Effectue le remplacement dans un fichier avec les paramètres spécifiés
   */
  private async replaceInFile(
    rawFilePath: string,
    searchPattern: string,
    replacement: string,
    options: SearchAndReplaceOptions = {}
  ): Promise<ReplaceResult> {
    const filePath = this.utils.resolvePath(rawFilePath);
    
    // PROTECTION 1 : Validation préventive des patterns identiques
    if (searchPattern === replacement) {
      this.utils.debugLog('identicalPatterns', {
        pattern: searchPattern,
        filePath: rawFilePath
      });
      return {
        modified: false,
        diff: '',
        warning: 'Search and replacement patterns are identical - no changes needed',
        replacements: 0
      };
    }
    
    // PROTECTION 2 : Validation des patterns vides
    if (!searchPattern || searchPattern.trim() === '') {
      throw new Error('Search pattern cannot be empty');
    }
    
    // PROTECTION 3 : Limites de sécurité
    const MAX_REPLACEMENTS = 10000; // Protection anti-boucle infinie
    const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB max
    
    // Vérifier si c'est un répertoire
    try {
      const stats = await fs.stat(filePath);
      if (stats.isDirectory()) {
        return { modified: false, diff: '', replacements: 0 }; // Ignorer les répertoires
      }
      
      // PROTECTION 4 : Taille de fichier maximale
      if (stats.size > MAX_FILE_SIZE) {
        throw new Error(`File too large: ${stats.size} bytes (max: ${MAX_FILE_SIZE})`);
      }
    } catch (error) {
      return { modified: false, diff: '', replacements: 0 }; // Le fichier n'existe pas, ignorer
    }
    
    const useRegex = options.useRegex ?? true;
    const caseSensitive = options.caseSensitive ?? false;
    const preview = options.preview ?? false;
    
    let content = await fs.readFile(filePath, 'utf-8');
    const originalContent = content;
    const preparedPattern = this.utils.prepareSearchPattern(searchPattern, useRegex);
    const searchRegex = new RegExp(preparedPattern, caseSensitive ? 'g' : 'gi');
    
    let totalReplacements = 0;
    let effectiveReplacements = 0; // CORRECTION : Comptage EFFECTIF
    
    // PROTECTION 5 : Remplacement avec comptage correct
    const newContent = content.replace(searchRegex, (match, ...groups) => {
      totalReplacements++;
      
      // CORRECTION : Vérifier si le remplacement change réellement
      const actualReplacement = this.utils.applyCaptureGroups(replacement, groups, useRegex);
      
      if (match !== actualReplacement) {
        effectiveReplacements++;
        
        // PROTECTION 6 : Limite anti-boucle
        if (effectiveReplacements > MAX_REPLACEMENTS) {
          this.utils.debugLog('tooManyReplacements', {
            effectiveReplacements,
            filePath: rawFilePath,
            maxAllowed: MAX_REPLACEMENTS
          });
          throw new Error(`Too many replacements: ${effectiveReplacements} (max: ${MAX_REPLACEMENTS})`);
        }
        
        return actualReplacement;
      } else {
        // Le remplacement est identique - ne pas compter
        return match;
      }
    });
    
    // CORRECTION : Vérification basée sur les remplacements EFFECTIFS
    const wasModified = (originalContent !== newContent) && (effectiveReplacements > 0);
    
    if (wasModified) {
      const diff = this.utils.generateDiff(content, newContent, rawFilePath) + '\n';
      if (!preview) {
        await fs.writeFile(filePath, newContent, 'utf-8');
      }
      
      this.utils.debugLog('fileModified', {
        filePath: rawFilePath,
        effectiveReplacements,
        totalMatches: totalReplacements
      });
      
      return {
        modified: true,
        diff,
        replacements: effectiveReplacements
      };
    }
    
    this.utils.debugLog('noModificationsNeeded', {
      filePath: rawFilePath,
      totalMatches: totalReplacements
    });
    
    return {
      modified: false,
      diff: '',
      replacements: 0
    };
  }
}