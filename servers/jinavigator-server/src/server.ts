/**
 * @fileoverview Configuration du serveur MCP JinaNavigator
 *
 * Ce module contient la configuration et l'initialisation du serveur MCP
 * JinaNavigator avec ses capacités et gestionnaires.
 *
 * @author JinaNavigator Team
 * @version 1.0.0
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { JINA_TOOLS } from './tools/index.js';

/**
 * Création du serveur MCP JinaNavigator
 *
 * @constant {Server} server
 */
export const server = new Server(
  {
    name: 'jinavigator',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

/**
 * Configuration du gestionnaire de liste d'outils
 * Cette fonction répond aux requêtes de liste des outils disponibles
 * en renvoyant les métadonnées des quatre outils du serveur
 *
 * @function setupListToolsHandler
 */
export function setupListToolsHandler(): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = JINA_TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema
    }));
    
    return { tools };
  });
}

/**
 * Gestionnaire des appels d'outils
 * Cette fonction traite les requêtes d'exécution d'outils,
 * trouve l'outil correspondant, l'exécute et formate la réponse
 * selon les attentes du SDK MCP
 *
 * @function setupCallToolHandler
 */
export function setupCallToolHandler(): void {
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const toolName = request.params.name;
    const args = request.params.arguments || {};
    
    // Trouver l'outil correspondant
    const tool = JINA_TOOLS.find((t) => t.name === toolName);
    
    if (!tool) {
      throw new McpError(
        ErrorCode.MethodNotFound,
        `Outil inconnu: ${toolName}`
      );
    }
    
    try {
      // Exécuter le handler de l'outil
      const result = await tool.execute(args);
      
      // Formater correctement la réponse selon les attentes du SDK MCP
      // Le champ "content" doit être un tableau d'objets avec une structure spécifique
      let formattedContent;
      
      if (toolName === 'convert_web_to_markdown') {
        // Pour l'outil convert_web_to_markdown, on crée un objet avec le contenu Markdown
        formattedContent = [{
          type: 'text',
          text: result.result || '',
          mime: 'text/markdown'
        }];
      } else if (toolName === 'access_jina_resource') {
        // Pour l'outil access_jina_resource, on utilise le contenu et le type de contenu
        formattedContent = [{
          type: 'text',
          text: result.result?.content || '',
          mime: result.result?.contentType || 'text/markdown'
        }];
      } else if (toolName === 'multi_convert') {
        // Pour l'outil multi_convert, on crée un objet JSON formaté
        const resultsText = JSON.stringify(result.result, null, 2);
        formattedContent = [{
          type: 'text',
          text: resultsText,
          mime: 'application/json'
        }];
      } else if (toolName === 'extract_markdown_outline') {
        // Pour l'outil extract_markdown_outline, on crée un objet JSON formaté
        const resultsText = JSON.stringify(result.result, null, 2);
        formattedContent = [{
          type: 'text',
          text: resultsText,
          mime: 'application/json'
        }];
      } else {
        // Par défaut, on crée un tableau avec un élément texte vide
        formattedContent = [{
          type: 'text',
          text: '',
          mime: 'text/plain'
        }];
      }
      
      return {
        result: result.result,
        content: formattedContent
      };
    } catch (error: any) {
      console.error(`Erreur lors de l'exécution de l'outil ${toolName}:`, error);
      throw new McpError(
        ErrorCode.InternalError,
        `Erreur lors de l'exécution de l'outil: ${error.message}`
      );
    }
  });
}

/**
 * Configuration de la gestion des erreurs
 * Enregistre les erreurs dans la console et gère l'arrêt propre du serveur
 *
 * @function setupErrorHandling
 */
export function setupErrorHandling(): void {
  server.onerror = (error) => console.error('[MCP Error]', error);
  process.on('SIGINT', async () => {
    await server.close();
    process.exit(0);
  });
}