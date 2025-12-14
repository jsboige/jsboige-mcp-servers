/**
 * Exportations des outils JinaNavigator
 *
 * Ce fichier centralise toutes les exportations des outils MCP
 * pour faciliter leur importation dans d'autres modules.
 */

import { convertWebToMarkdownTool } from './convert-web-to-markdown';
import { accessJinaResourceTool } from './access-jina-resource';
import { convertMultipleWebsToMarkdownTool } from './multi-convert';
import { extractMarkdownOutlineTool } from './extract-markdown-outline';

/**
 * Liste des outils JinaNavigator disponibles
 */
export const JINA_TOOLS = [
  convertWebToMarkdownTool,
  accessJinaResourceTool,
  convertMultipleWebsToMarkdownTool,
  extractMarkdownOutlineTool,
];

// Exportations individuelles
export {
  convertWebToMarkdownTool,
  accessJinaResourceTool,
  convertMultipleWebsToMarkdownTool,
  extractMarkdownOutlineTool,
};