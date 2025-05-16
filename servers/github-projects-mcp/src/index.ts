import { MCPServer } from '@modelcontextprotocol/server';
import dotenv from 'dotenv';
import { projectsTools } from './tools';
import { projectsResources } from './resources';
import { setupErrorHandlers } from './utils/errorHandlers';

// Charger les variables d'environnement
dotenv.config();

// Configuration du serveur MCP
const port = process.env.MCP_PORT ? parseInt(process.env.MCP_PORT) : 3000;
const host = process.env.MCP_HOST || 'localhost';

async function startServer() {
  try {
    console.log('Démarrage du serveur MCP Gestionnaire de Projet...');
    
    // Créer une instance du serveur MCP
    const server = new MCPServer({
      name: 'github-projects',
      description: 'MCP Gestionnaire de Projet pour l\'intégration de GitHub Projects avec VSCode Roo',
      version: '0.1.0',
      tools: projectsTools,
      resources: projectsResources
    });

    // Configurer les gestionnaires d'erreurs
    setupErrorHandlers(server);

    // Démarrer le serveur
    await server.listen(port, host);
    console.log(`Serveur MCP Gestionnaire de Projet démarré sur ${host}:${port}`);
  } catch (error) {
    console.error('Erreur lors du démarrage du serveur MCP:', error);
    process.exit(1);
  }
}

// Démarrer le serveur
startServer();