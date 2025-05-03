/**
 * Script pour démarrer le serveur MCP Searxng
 */

const { spawn } = require('child_process');
const path = require('path');

console.log('===== Démarrage du serveur MCP Searxng =====');

// Définir les variables d'environnement
const env = {
  ...process.env,
  SEARXNG_URL: 'https://search.myia.io/'
};

// Démarrer le serveur MCP Searxng
console.log('Démarrage du serveur MCP Searxng...');
const searxngProcess = spawn('mcp-searxng', [], {
  env,
  stdio: 'inherit'
});

searxngProcess.on('error', (err) => {
  console.error(`Erreur lors du démarrage du serveur MCP Searxng: ${err.message}`);
  process.exit(1);
});

console.log('===== Le serveur a été démarré avec succès =====');
console.log('Le serveur MCP Searxng est maintenant disponible pour Roo');

// Gérer la fermeture propre du processus
process.on('SIGINT', () => {
  console.log('Arrêt du serveur MCP Searxng...');
  searxngProcess.kill();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('Arrêt du serveur MCP Searxng...');
  searxngProcess.kill();
  process.exit(0);
});