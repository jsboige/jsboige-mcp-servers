import * as fs from 'fs/promises';
import * as path from 'path';
import { glob } from 'glob';
import { SearchInFilesArgsSchema } from '../../validation/schemas.js';
import { SearchResult, SearchMatch } from '../../core/types.js';
import { QuickFilesUtils } from '../../core/utils.js';

/**
 * Outil pour rechercher des patterns dans les fichiers
 */
export class SearchInFilesTool {
  private utils: QuickFilesUtils;

  constructor(utils: QuickFilesUtils) {
    this.utils = utils;
  }

  async handle(request: any): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
    try {
      // Extraire et valider les arguments
      const args = request.params?.arguments || request;
      const validatedArgs = SearchInFilesArgsSchema.parse(args);
      
      const {
        paths: rawPaths,
        pattern,
        use_regex,
        case_sensitive,
        file_pattern,
        context_lines,
        max_results_per_file,
        max_total_results,
        recursive
      } = validatedArgs;

      // Créer le regex de recherche
      const searchRegex = this.utils.createSearchRegex(pattern, use_regex, case_sensitive);
      
      // Collecter tous les fichiers à rechercher
      const filesToSearch = await this.collectFilesToSearch(rawPaths, {
        recursive,
        filePattern: file_pattern
      });

      // Rechercher dans tous les fichiers collectés
      const results: SearchResult[] = [];
      let totalMatches = 0;

      for (const file of filesToSearch) {
        if (totalMatches >= max_total_results) break;
        
        const searchResult = await this.utils.searchInFile(
          file.absolute,
          file.relative,
          searchRegex,
          {
            contextLines: context_lines,
            maxResultsPerFile: max_results_per_file,
            maxTotalResults: max_total_results
          },
          totalMatches
        );
        
        // Ajouter les résultats seulement s'il y a des correspondances
        results.push({ path: file.relative, matches: searchResult.matches });
        totalMatches = searchResult.totalMatches;
      }
      
      // Filtrer les fichiers avec des correspondances
      const filteredResults = results.filter(result => result.matches.length > 0);

      // Formater les résultats
      const formattedResponse = this.formatSearchResults(
        filteredResults,
        pattern,
        totalMatches,
        max_total_results
      );

      return { content: [{ type: 'text' as const, text: formattedResponse }] };
    } catch (error) {
      return {
        content: [{
          type: 'text' as const,
          text: `Erreur lors de la recherche: ${(error as Error).message}`
        }],
        isError: true
      };
    }
  }

  /**
   * Collecte tous les fichiers à rechercher
   */
  private async collectFilesToSearch(
    rawPaths: string[],
    options: {
      recursive: boolean;
      filePattern?: string;
    }
  ): Promise<{ absolute: string; relative: string }[]> {
    const filesToSearch: { absolute: string; relative: string }[] = [];

    for (const rawPath of rawPaths) {
      const resolvedPath = this.utils.resolvePath(rawPath);

      try {
        const stats = await fs.stat(resolvedPath);

        if (stats.isFile()) {
          // Direct file reference
          filesToSearch.push({ absolute: resolvedPath, relative: rawPath });
        } else if (stats.isDirectory()) {
          // Directory: need to list files
          if (options.recursive) {
            // Use glob to find files recursively
            let globPattern = options.filePattern || '**/*';
            if (options.filePattern && !options.filePattern.includes('**')) {
              globPattern = `**/${options.filePattern}`;
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
                if (options.filePattern) {
                  const matched = await glob(options.filePattern, {
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

    return filesToSearch;
  }

  /**
   * Formate les résultats de recherche
   */
  private formatSearchResults(
    results: SearchResult[],
    pattern: string,
    totalMatches: number,
    maxTotalResults: number
  ): string {
    let formattedResponse = `# Résultats de recherche pour: "${pattern}"\n\n`;
    
    if (results.length === 0) {
      formattedResponse += `Aucun résultat trouvé.\n`;
    } else {
      formattedResponse += `**${results.length} fichier(s) contenant des correspondances**\n\n`;
      results.forEach(r => {
        formattedResponse += `## ${r.path}\n`;
        formattedResponse += `${r.matches.length} correspondance(s)\n\n`;
        r.matches.forEach((m: SearchMatch) => {
          formattedResponse += `**Ligne ${m.lineNumber}**:\n\`\`\`\n${m.context.join('\n')}\n\`\`\`\n\n`;
        });
      });

      // Ajouter le message de limite si nécessaire
      if (totalMatches >= maxTotalResults) {
        formattedResponse += "\n(limite de résultats atteinte)\n";
      }
    }

    return formattedResponse;
  }
}