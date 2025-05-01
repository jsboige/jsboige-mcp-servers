import { createServer, ServerOptions, Tool, ToolSchema } from '@modelcontextprotocol/sdk';
import { notebookTools } from './tools/notebook';
import { kernelTools } from './tools/kernel';
import { executionTools } from './tools/execution';
import { initializeJupyterServices } from './services/jupyter';

// Configuration du serveur MCP
const serverOptions: ServerOptions = {
  name: 'jupyter-server',
  description: 'Serveur MCP pour interagir avec des notebooks Jupyter',
  version: '0.1.0',
};

async function main() {
  try {
    console.log('Initialisation du serveur MCP Jupyter...');
    
    // Initialiser les services Jupyter
    await initializeJupyterServices();
    
    // Créer le serveur MCP
    const server = createServer(serverOptions);
    
    // Enregistrer les outils
    const tools: Tool[] = [
      ...notebookTools,
      ...kernelTools,
      ...executionTools
    ];
    
    tools.forEach(tool => {
      server.registerTool(tool);
      console.log(`Outil enregistré: ${tool.name}`);
    });
    
    // Démarrer le serveur
    await server.start();
    console.log('Serveur MCP Jupyter démarré avec succès');
    
  } catch (error) {
    console.error('Erreur lors du démarrage du serveur MCP Jupyter:', error);
    process.exit(1);
  }
}

main();