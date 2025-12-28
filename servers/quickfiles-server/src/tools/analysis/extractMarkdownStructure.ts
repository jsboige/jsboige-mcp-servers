import * as fs from 'fs/promises';
import { ExtractMarkdownStructureArgsSchema } from '../../validation/schemas.js';
import { MarkdownHeading, MarkdownStructureResult } from '../../core/types.js';
import { QuickFilesUtils } from '../../core/utils.js';

/**
 * Outil pour extraire la structure des fichiers Markdown
 */
export class ExtractMarkdownStructureTool {
  private utils: QuickFilesUtils;

  constructor(utils: QuickFilesUtils) {
    this.utils = utils;
  }

  async handle(request: any): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
    try {
        // Extraire et valider les arguments
        const args = request.params?.arguments || request;
        
        // Validation Zod explicite
        const validatedArgs = ExtractMarkdownStructureArgsSchema.parse(args);
        
        const { paths: filePaths, max_depth, include_context, context_lines } = validatedArgs;

        const allFilesHeadings = await Promise.all(
            filePaths.map(async (rawFilePath) => {
                const filePath = this.utils.resolvePath(rawFilePath);
                
                // Check file extension
                if (!rawFilePath.toLowerCase().endsWith('.md')) {
                    return { path: rawFilePath, error: "n'est pas un fichier markdown" };
                }
    
                try {
                    const content = await fs.readFile(filePath, 'utf-8');
                    if (!content.trim()) {
                         return { path: rawFilePath, error: "aucune structure trouvée" };
                    }
                    const { headings } = this.parseMarkdown(content, max_depth, context_lines);
                    if (headings.length === 0) {
                        return { path: rawFilePath, error: "aucune structure trouvée" };
                    }
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
                    if (h.context && h.context.length > 0) {
                        h.context.forEach(ctxLine => {
                            formattedResponse += `${' '.repeat((h.level - 1) * 2 + 2)}  ${ctxLine}\n`;
                        });
                    }
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
        
        if (heading) {
            if (contextLines > 0) {
                const context: string[] = [];
                // Start looking for context after the current line (or after the setext underline)
                let startContextLine = i + 1;
                
                for (let j = 0; j < contextLines; j++) {
                    const contextLineIndex = startContextLine + j;
                    if (contextLineIndex < lines.length) {
                        const ctxLine = lines[contextLineIndex].trim();
                        // Stop if we hit another heading or empty line?
                        // The requirement is just "context lines", usually following text.
                        // We should probably skip empty lines but include text.
                        if (ctxLine && !ctxLine.match(atxHeadingRegex) && !ctxLine.match(setextH1Regex) && !ctxLine.match(setextH2Regex)) {
                            context.push(ctxLine);
                        }
                    }
                }
                if (context.length > 0) {
                    heading.context = context;
                }
            }
            headings.push(heading);
        }
    }
    return { headings, fileInfo: {} };
  }
}