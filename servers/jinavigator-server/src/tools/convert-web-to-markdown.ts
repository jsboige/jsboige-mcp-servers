/**
 * @fileoverview Outil de conversion de pages web en Markdown
 *
 * Ce module implémente l'outil convert_web_to_markdown qui permet
 * de convertir n'importe quelle page web en format Markdown
 * en utilisant l'API Jina, avec possibilité de filtrer le contenu par numéros de ligne
 *
 * @author JinaNavigator Team
 * @version 1.0.0
 */

import axios from 'axios';
import { JinaTool, ToolInput, ToolOutput, ConvertWebToMarkdownInput } from '../types/index.js';
import { convertWebToMarkdownSchema } from '../schemas/index.js';
import { convertUrlToMarkdown, handleJinaErrors } from '../utils/index.js';

/**
 * Outil de conversion de pages web en Markdown
 * Cet outil permet de convertir n'importe quelle page web en format Markdown
 * en utilisant l'API Jina, avec possibilité de filtrer le contenu par numéros de ligne
 *
 * @constant {JinaTool} convertWebToMarkdownTool
 */
export const convertWebToMarkdownTool: JinaTool = {
  name: 'convert_web_to_markdown',
  description: 'Convertit une page web en Markdown en utilisant l\'API Jina',
  inputSchema: convertWebToMarkdownSchema,
  execute: async (input: ToolInput): Promise<ToolOutput> => {
    try {
      const { url, start_line, end_line } = input as ConvertWebToMarkdownInput;
      
      // Conversion de l'URL en Markdown
      const markdownContent = await convertUrlToMarkdown(url, start_line, end_line);
      
      // Retourne le contenu Markdown filtré
      return {
        result: markdownContent
      };
    } catch (error) {
      // Gestion des erreurs
      const errorMessage = handleJinaErrors(error);
      return {
        error: {
          message: errorMessage,
          details: axios.isAxiosError(error) ? error.response?.data || 'Pas de détails disponibles' : undefined
        }
      };
    }
  }
};