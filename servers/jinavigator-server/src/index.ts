/**
 * @fileoverview Point d'entrée principal du serveur MCP JinaNavigator
 *
 * Ce fichier est le point d'entrée principal qui initialise et démarre
 * le serveur MCP JinaNavigator en utilisant l'architecture modulaire.
 *
 * @author JinaNavigator Team
 * @version 1.0.0
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { server, setupListToolsHandler, setupCallToolHandler, setupErrorHandling } from './server.js';

/**
 * Fonction de démarrage du serveur
 * Initialise le transport stdio et connecte le serveur
 *
 * @async
 * @function run
 * @returns {Promise<void>}
 */
async function run(): Promise<void> {
  try {
    console.log('Initialisation du serveur MCP Jinavigator...');
    
    // Configuration des gestionnaires
    setupListToolsHandler();
    setupCallToolHandler();
    setupErrorHandling();
    
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.log('Serveur MCP Jinavigator démarré avec succès sur stdio');
    // Keep the process alive
    setInterval(() => {}, 1 << 30);
  } catch (error) {
    console.error('Erreur lors du démarrage du serveur MCP Jinavigator:', error);
    process.exit(1);
  }
}

run().catch(console.error);

// Keep the process alive