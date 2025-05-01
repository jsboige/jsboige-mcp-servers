import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';

// Définir notre propre interface Tool pour le serveur
interface JupyterTool {
  name: string;
  description: string;
  schema?: any;
  handler?: (args: any) => Promise<any>;
  inputSchema?: any;
}
import { initializeJupyterServices } from './services/jupyter.js';
import { notebookTools } from './tools/notebook.js';
import { kernelTools } from './tools/kernel.js';
import { executionTools } from './tools/execution.js';

// Conversion des types
type AllTools = JupyterTool[];

class JupyterMcpServer {
  private server: Server;

  constructor() {
    this.server = new Server(
      {
        name: 'jupyter-mcp-server',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();
    
    // Gestion des erreurs
    this.server.onerror = (error) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private setupToolHandlers() {
    // Définir les outils disponibles
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools = [
        ...notebookTools.map(tool => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.schema
        })),
        ...kernelTools.map(tool => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.schema
        })),
        ...executionTools.map(tool => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.schema
        }))
      ];
      
      return { tools };
    });

    // Gérer les appels d'outils
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const toolName = request.params.name;
      const args = request.params.arguments;
      
      // Trouver l'outil correspondant
      const allTools = [...notebookTools, ...kernelTools, ...executionTools] as JupyterTool[];
      const tool = allTools.find(t => t.name === toolName) as JupyterTool;
      
      if (!tool) {
        throw new McpError(
          ErrorCode.MethodNotFound,
          `Outil inconnu: ${toolName}`
        );
      }
      
      try {
        // Exécuter le handler de l'outil
        if (!tool.handler) {
          throw new Error(`L'outil ${toolName} n'a pas de handler défini`);
        }
        const result = await tool.handler(args);
        return result;
      } catch (error: any) {
        console.error(`Erreur lors de l'exécution de l'outil ${toolName}:`, error);
        throw new McpError(
          ErrorCode.InternalError,
          `Erreur lors de l'exécution de l'outil: ${error.message}`
        );
      }
    });
  }

  async run() {
    try {
      console.log('Initialisation du serveur MCP Jupyter...');
      
      // En mode test, ne pas initialiser les services Jupyter
      // await initializeJupyterServices();
      console.log('Mode test: services Jupyter non initialisés');
      
      const transport = new StdioServerTransport();
      await this.server.connect(transport);
      console.log('Serveur MCP Jupyter démarré avec succès sur stdio');
    } catch (error) {
      console.error('Erreur lors du démarrage du serveur MCP Jupyter:', error);
      process.exit(1);
    }
  }
}

const server = new JupyterMcpServer();
server.run().catch(console.error);

