#!/usr/bin/env node

import { QuickFilesServer } from './core/QuickFilesServer.js';

/**
 * Point d'entrée principal pour le serveur QuickFiles MCP
 * Utilise l'architecture modulaire refactorisée
 */
async function main() {
  const server = new QuickFilesServer();
  await server.run();
}

// Gestion des erreurs non capturées
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Démarrer le serveur
main().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
