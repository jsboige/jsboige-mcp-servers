import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import axios from 'axios';

// Interface pour les entrées et sorties d'outils
interface ToolInput {
  [key: string]: any;
}

interface ToolOutput {
  result?: any;
  error?: {
    message: string;
    details?: any;
  };
}

// Interface pour nos outils
interface JinaTool extends Tool {
  execute: (input: ToolInput) => Promise<ToolOutput>;
}

/**
 * Serveur MCP Jinavigator
 *
 * Ce serveur MCP utilise l'API Jina pour convertir des pages web en Markdown.
 * L'API Jina fonctionne en ajoutant l'URL cible comme suffixe à l'URL de base "https://r.jina.ai/".
 */

// Définition du schéma d'entrée pour l'outil de conversion
const convertWebToMarkdownSchema = {
  type: "object" as const,
  properties: {
    url: {
      type: "string",
      description: 'URL de la page web à convertir en Markdown'
    },
    start_line: {
      type: "number",
      description: 'Ligne de début pour extraire une partie spécifique du contenu (optionnel)'
    },
    end_line: {
      type: "number",
      description: 'Ligne de fin pour extraire une partie spécifique du contenu (optionnel)'
    }
  },
  required: ['url']
};

// Création du serveur MCP
const server = new Server(
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

// Définition de l'outil de conversion
const convertWebToMarkdownTool: JinaTool = {
  name: 'convert_web_to_markdown',
  description: 'Convertit une page web en Markdown en utilisant l\'API Jina',
  inputSchema: convertWebToMarkdownSchema,
  execute: async (input: ToolInput): Promise<ToolOutput> => {
    try {
      const { url, start_line, end_line } = input as {
        url: string;
        start_line?: number;
        end_line?: number;
      };
      
      // Construction de l'URL Jina
      const jinaUrl = `https://r.jina.ai/${url}`;
      
      // Appel à l'API Jina
      const response = await axios.get(jinaUrl);
      
      // Récupération du contenu Markdown
      let markdownContent = response.data;
      
      // Filtrage du contenu si des bornes sont spécifiées
      if (start_line !== undefined || end_line !== undefined) {
        const lines = markdownContent.split('\n');
        const startIndex = start_line !== undefined ? Math.max(0, start_line - 1) : 0;
        const endIndex = end_line !== undefined ? Math.min(lines.length, end_line) : lines.length;
        
        markdownContent = lines.slice(startIndex, endIndex).join('\n');
      }
      
      // Retourne le contenu Markdown filtré
      return {
        result: markdownContent
      };
    } catch (error) {
      // Gestion des erreurs
      if (axios.isAxiosError(error)) {
        return {
          error: {
            message: `Erreur lors de la conversion: ${error.message}`,
            details: error.response?.data || 'Pas de détails disponibles'
          }
        };
      }
      
      return {
        error: {
          message: `Erreur inattendue: ${(error as Error).message}`
        }
      };
    }
  }
};

// Fonction utilitaire pour convertir une URL en Markdown via Jina
async function convertUrlToMarkdown(url: string, startLine?: number, endLine?: number): Promise<string> {
  try {
    // Construction de l'URL Jina
    const jinaUrl = `https://r.jina.ai/${url}`;
    
    // Appel à l'API Jina
    const response = await axios.get(jinaUrl);
    
    // Récupération du contenu Markdown
    let markdownContent = response.data;
    
    // Filtrage du contenu si des bornes sont spécifiées
    if (startLine !== undefined || endLine !== undefined) {
      const lines = markdownContent.split('\n');
      const startIndex = startLine !== undefined ? Math.max(0, startLine - 1) : 0;
      const endIndex = endLine !== undefined ? Math.min(lines.length, endLine) : lines.length;
      
      markdownContent = lines.slice(startIndex, endIndex).join('\n');
    }
    
    return markdownContent;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      throw new Error(`Erreur lors de la conversion: ${error.message}`);
    }
    throw new Error(`Erreur inattendue: ${(error as Error).message}`);
  }
}

// Définition du schéma d'entrée pour l'outil d'accès aux ressources Jina
const accessJinaResourceSchema = {
  type: "object" as const,
  properties: {
    uri: {
      type: "string",
      description: 'URI au format jina://{url} pour accéder au contenu Markdown d\'une page web'
    },
    start_line: {
      type: "number",
      description: 'Ligne de début pour extraire une partie spécifique du contenu (optionnel)'
    },
    end_line: {
      type: "number",
      description: 'Ligne de fin pour extraire une partie spécifique du contenu (optionnel)'
    }
  },
  required: ['uri']
};

// Définition de l'outil d'accès aux ressources Jina
const accessJinaResourceTool: JinaTool = {
  name: 'access_jina_resource',
  description: 'Accède au contenu Markdown d\'une page web via un URI au format jina://{url}',
  inputSchema: accessJinaResourceSchema,
  execute: async (input: ToolInput): Promise<ToolOutput> => {
    try {
      const { uri, start_line, end_line } = input as {
        uri: string;
        start_line?: number;
        end_line?: number;
      };
      
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
        result: {
          content: markdownContent,
          contentType: 'text/markdown'
        }
      };
    } catch (error) {
      return {
        error: {
          message: `Erreur lors de l'accès à la ressource: ${(error as Error).message}`
        }
      };
    }
  }
};

// Configuration du serveur
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools = [
    {
      name: convertWebToMarkdownTool.name,
      description: convertWebToMarkdownTool.description,
      inputSchema: convertWebToMarkdownTool.inputSchema
    },
    {
      name: accessJinaResourceTool.name,
      description: accessJinaResourceTool.description,
      inputSchema: accessJinaResourceTool.inputSchema
    }
  ];
  
  return { tools };
});

// Gestion des appels d'outils
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const toolName = request.params.name;
  const args = request.params.arguments || {};
  
  // Trouver l'outil correspondant
  const allTools = [convertWebToMarkdownTool, accessJinaResourceTool];
  const tool = allTools.find(t => t.name === toolName) as JinaTool;
  
  if (!tool) {
    throw new McpError(
      ErrorCode.MethodNotFound,
      `Outil inconnu: ${toolName}`
    );
  }
  
  try {
    // Exécuter le handler de l'outil
    const result = await tool.execute(args as ToolInput);
    
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

// Gestion des erreurs
server.onerror = (error) => console.error('[MCP Error]', error);
process.on('SIGINT', async () => {
  await server.close();
  process.exit(0);
});

// Démarrage du serveur
async function run() {
  try {
    console.log('Initialisation du serveur MCP Jinavigator...');
    
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.log('Serveur MCP Jinavigator démarré avec succès sur stdio');
  } catch (error) {
    console.error('Erreur lors du démarrage du serveur MCP Jinavigator:', error);
    process.exit(1);
  }
}

run().catch(console.error);