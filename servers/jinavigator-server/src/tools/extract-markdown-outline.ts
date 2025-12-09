/**
 * @fileoverview Outil d'extraction du plan des titres Markdown
 *
 * Ce module implémente l'outil extract_markdown_outline qui permet
 * d'extraire le plan des titres (headings) d'une ou plusieurs pages web
 * avec leurs numéros de ligne, en utilisant l'API Jina pour la conversion en Markdown
 *
 * @author JinaNavigator Team
 * @version 1.0.0
 */

import { JinaTool, ToolInput, ToolOutput, ExtractMarkdownOutlineInput, OutlineResult } from '../types/index';
import { extractMarkdownOutlineSchema } from '../schemas/index';
import { convertUrlToMarkdown, handleJinaErrors } from '../utils/index';

/**
 * Outil d'extraction du plan des titres Markdown
 * Cet outil permet d'extraire le plan des titres (headings) d'une ou plusieurs pages web
 * avec leurs numéros de ligne, en utilisant l'API Jina pour la conversion en Markdown.
 *
 * L'outil retourne une structure hiérarchique des titres, où chaque titre peut contenir
 * des sous-titres (enfants) de niveau inférieur, permettant ainsi de visualiser la structure
 * complète du document.
 *
 * @constant {JinaTool} extractMarkdownOutlineTool
 */
export const extractMarkdownOutlineTool: JinaTool = {
  name: 'extract_markdown_outline',
  description: 'Extrait le plan hiérarchique des titres markdown avec numéros de ligne à partir d\'une liste d\'URLs',
  inputSchema: extractMarkdownOutlineSchema,
  execute: async (input: ToolInput): Promise<ToolOutput> => {
    try {
      const { urls, max_depth = 3 } = input as ExtractMarkdownOutlineInput;
      
      if (!urls) {
        throw new Error('urls is required');
      }

      if (!Array.isArray(urls)) {
        throw new Error('urls must be an array');
      }

      // Validation de la profondeur maximale
      const validatedMaxDepth = Math.min(Math.max(1, max_depth), 6); // Entre 1 et 6
      
      // Traitement de chaque URL en parallèle
      const results = await Promise.all(
        urls.map(async ({ url }) => {
          if (!url) {
             throw new Error('url is required');
          }
          if (typeof url !== 'string' || url.trim() === '') {
             throw new Error('url must be a non-empty string');
          }
          try {
            // Conversion de l'URL en Markdown
            const markdown = await convertUrlToMarkdown(url);
             
            // Extraction du plan hiérarchique des titres
            const outline = extractMarkdownOutline(markdown, validatedMaxDepth);
             
            const result: OutlineResult = {
              url,
              success: true,
              max_depth: validatedMaxDepth,
              outline
            };
            return result;
          } catch (error) {
            const result: OutlineResult = {
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
          message: `Erreur lors de l'extraction du plan des titres: ${handleJinaErrors(error)}`
        }
      };
    }
  }
};

/**
 * Import de la fonction extractMarkdownOutline depuis les utilitaires
 * Note: Cette fonction est importée depuis utils/index.js mais nous devons
 * la réexporter ici pour éviter les dépendances circulaires
 */
import { extractMarkdownOutline as extractMarkdownOutlineUtil } from '../utils/markdown-parser';

/**
 * Alias local pour la fonction d'extraction de plan
 */
const extractMarkdownOutline = extractMarkdownOutlineUtil;