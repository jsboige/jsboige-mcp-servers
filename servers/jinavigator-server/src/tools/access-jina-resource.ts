/**
 * @fileoverview Outil d'accès aux ressources via URI Jina
 *
 * Ce module implémente l'outil access_jina_resource qui permet
 * d'accéder au contenu Markdown d'une page web via un URI
 * standardisé au format jina://{url}
 *
 * @author JinaNavigator Team
 * @version 1.0.0
 */

import { JinaTool, ToolInput, ToolOutput, AccessJinaResourceInput, AccessResourceResult } from '../types/index';
import { accessJinaResourceSchema } from '../schemas/index';
import { convertUrlToMarkdown, handleJinaErrors } from '../utils/index';

/**
 * Outil d'accès aux ressources via URI Jina
 * Cet outil permet d'accéder au contenu Markdown d'une page web
 * via un URI standardisé au format jina://{url}
 *
 * @constant {JinaTool} accessJinaResourceTool
 */
export const accessJinaResourceTool: JinaTool = {
  name: 'access_jina_resource',
  description: 'Accède au contenu Markdown d\'une page web via un URI au format jina://{url}',
  inputSchema: accessJinaResourceSchema,
  execute: async (input: ToolInput): Promise<ToolOutput> => {
    try {
      const { uri, start_line, end_line } = input as AccessJinaResourceInput;
      
      // Extraction de l'URL à partir de l'URI
      const match = uri.match(/^jina:\/\/(.+)$/);
      if (!match) {
        return {
          error: {
            message: 'URI invalide. L\'URI doit être au format jina://{url}'
          }
        };
      }
      
      const url = match[1];
      
      // Conversion de l'URL en Markdown
      const markdownContent = await convertUrlToMarkdown(url, start_line, end_line);
      
      return {
        content: [
          {
            type: 'text',
            text: markdownContent
          }
        ]
      };
    } catch (error) {
      return {
        error: {
          message: `Erreur lors de l'accès à la ressource: ${handleJinaErrors(error)}`
        }
      };
    }
  }
};