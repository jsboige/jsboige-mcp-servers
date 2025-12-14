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

import { JinaTool, ToolInput, ToolOutput, ConvertMultipleWebsToMarkdownInput, MultiConvertResult } from '../types/index';
import { convertMultipleWebsToMarkdownSchema } from '../schemas/index';
import { convertUrlToMarkdown, handleJinaErrors } from '../utils/index';

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
      
      if (!urls) {
        throw new Error('urls is required');
      }

      if (!Array.isArray(urls)) {
        throw new Error('urls must be an array');
      }

      // Traitement de chaque URL en parallèle
      const results = await Promise.all(
        urls.map(async ({ url, start_line, end_line }) => {
          if (!url) {
             throw new Error('url is required');
          }
          if (typeof url !== 'string' || url.trim() === '') {
             throw new Error('url must be a non-empty string');
          }
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