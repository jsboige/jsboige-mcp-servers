import * as fs from 'fs/promises';
import { EditMultipleFilesArgsSchema } from '../../validation/schemas.js';
import { FileEdit, FileOperationResult } from '../../core/types.js';
import { QuickFilesUtils } from '../../core/utils.js';

/**
 * Outil pour éditer plusieurs fichiers avec des diffs
 */
export class EditMultipleFilesTool {
  private utils: QuickFilesUtils;

  constructor(utils: QuickFilesUtils) {
    this.utils = utils;
  }

  async handle(request: any): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
    // Extraire et valider les arguments
    const args = request.params?.arguments || request;
    
    // Validation Zod explicite
    const validatedArgs = EditMultipleFilesArgsSchema.parse(args);
    
    const { files } = validatedArgs;
    this.utils.debugLog('handleEditMultipleFiles', { filesCount: files.length });
    
    try {
        const results = await Promise.all(
            files.map(async ({ path: rawFilePath, diffs }) => {
                const filePath = this.utils.resolvePath(rawFilePath);
                this.utils.debugLog('editFile', { filePath, diffsCount: diffs.length });
               
                try {
                    let content = await fs.readFile(filePath, 'utf-8');
                    let modificationsCount = 0;
                    const errors: string[] = [];
                   
                    for (const diff of diffs) {
                        const { search, replace, start_line } = diff;
                       
                        // Normaliser les sauts de ligne dans les chaînes
                        const normalizedSearch = this.utils.normalizeLineBreaks(search);
                        const normalizedReplace = this.utils.normalizeLineBreaks(replace);
                        const normalizedContent = this.utils.normalizeLineBreaks(content);
                       
                        let lines = normalizedContent.split('\n');
                        let found = false;
                       
                        if (start_line) {
                           const targetIndex = start_line - 1;
                           if (lines[targetIndex] && lines[targetIndex].includes(normalizedSearch)) {
                               lines[targetIndex] = lines[targetIndex].replace(normalizedSearch, normalizedReplace);
                               content = lines.join('\n');
                               found = true;
                           }
                        } else {
                             // Utiliser escapeRegex pour échapper les caractères spéciaux
                             const escapedSearch = this.utils.escapeRegex(normalizedSearch);
                             this.utils.debugLog('regexReplace', {
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
                            this.utils.debugLog('modificationSuccess', {
                                filePath,
                                search: normalizedSearch,
                                replace: normalizedReplace
                            });
                        } else {
                            errors.push(`Le texte à rechercher "${normalizedSearch}" n'a pas été trouvé.`);
                            this.utils.debugLog('modificationFailed', {
                                filePath,
                                search: normalizedSearch,
                                error: 'Text not found'
                            });
                        }
                    }
                    if (modificationsCount > 0) {
                        await fs.writeFile(filePath, content, 'utf-8');
                        this.utils.debugLog('fileWritten', { filePath, modificationsCount });
                    }
                    return { path: rawFilePath, success: true, modifications: modificationsCount, errors };
                } catch (error) {
                    this.utils.debugLog('fileError', { filePath, error: (error as Error).message });
                    return { path: rawFilePath, success: false, error: (error as Error).message };
                }
            })
        );
        let report = "## Rapport d'édition de fichiers\n\n";
        results.forEach(r => {
            if (r.success) {
                const modifications = r.modifications || 0;
                if (modifications > 0) {
                    report += `Fichier modifié: ${r.path}: ${modifications} modification(s) effectuée(s).`;
                } else {
                    report += `Aucune modification: ${r.path}`;
                }
                if (r.errors && r.errors.length > 0) report += ` Erreurs: ${r.errors.join(', ')}`;
                report += `\n`;
            } else {
                report += `Échec d'édition: ${r.path}: ${r.error}\n`;
            }
        });
        this.utils.debugLog('editComplete', { totalFiles: files.length, results });
        return { content: [{ type: 'text' as const, text: report }] };
    } catch (error) {
        this.utils.debugLog('handleEditMultipleFilesError', { error: (error as Error).message });
        return { content: [{ type: 'text' as const, text: `Erreur lors de l'édition des fichiers: ${(error as Error).message}` }], isError: true };
    }
  }
}