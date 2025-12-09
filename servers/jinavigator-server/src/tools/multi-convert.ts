/**
 * @fileoverview Outil de conversion multiple de pages web en Markdown
 *
 * Ce module implémente l'outil multi_convert qui permet
 * de convertir plusieurs pages web en Markdown en une seule requête,
 * avec traitement parallèle des URLs
 *
 * @author JinaNavigator Team
 * @version 1.0.0
 */

import { JinaTool, ToolInput, ToolOutput, ConvertMultipleWebsToMarkdownInput, MultiConvertResult } from '../types/index.js';
import { convertMultipleWebsToMarkdownSchema } from '../schemas/index.js';
import { convertUrlToMarkdown, handleJinaErrors } from '../utils/index.js';

/**
 * Outil de conversion multiple de pages web en Markdown
 * Cet outil permet de convertir plusieurs pages web en Markdown
 * en une seule requête, avec traitement parallèle des URLs
 *
 * @constant {JinaTool} convertMultipleWebsToMarkdownTool
 */
export const convertMultipleWebsToMarkdownTool: JinaTool = {
  name: 'multi_convert',
  description: 'Convertit plusieurs pages web en Markdown en une seule requête',
  inputSchema: convertMultipleWebsToMarkdownSchema,
  execute: async (input: ToolInput): Promise<ToolOutput> => {
    try {
      const { urls } = input as ConvertMultipleWebsToMarkdownInput;
      
      // Traitement de chaque URL en parallèle
      const results = await Promise.all(
        urls.map(async ({ url, start_line, end_line }) => {
          try {
            const markdown = await convertUrlToMarkdown(url, start_line, end_line);
            const result: MultiConvertResult = {
              url,
              success: true,
              content: markdown
            };
            return result;
          } catch (error) {
            const result: MultiConvertResult = {
              url,
              success: false,
              error: handleJinaErrors(error)
            };
            return result;
          }
        })
      );
      
      return {
        result: results
      };
    } catch (error) {
      return {
        error: {
          message: `Erreur lors de la conversion multiple: ${handleJinaErrors(error)}`
        }
      };
    }
  }
};