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
    // Extraire et valider les arguments
    const args = request.params?.arguments || request;
    
    // Validation Zod explicite
    const validatedArgs = ExtractMarkdownStructureArgsSchema.parse(args);
    
    const { paths: filePaths, max_depth, include_context, context_lines } = validatedArgs;
    try {
        const allFilesHeadings = await Promise.all(
            filePaths.map(async (rawFilePath) => {
                const filePath = this.utils.resolvePath(rawFilePath);
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
}