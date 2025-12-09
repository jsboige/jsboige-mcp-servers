/**
 * Exportations des outils JinaNavigator
 *
 * Ce fichier centralise toutes les exportations des outils MCP
 * pour faciliter leur importation dans d'autres modules.
 */

import { convertWebToMarkdownTool } from './convert-web-to-markdown.js';
import { accessJinaResourceTool } from './access-jina-resource.js';
import { convertMultipleWebsToMarkdownTool } from './multi-convert.js';
import { extractMarkdownOutlineTool } from './extract-markdown-outline.js';

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