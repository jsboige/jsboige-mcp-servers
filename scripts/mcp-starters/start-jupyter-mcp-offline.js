/**
 * Script de démarrage pour le serveur MCP Jupyter en mode hors ligne
 * Ce script démarre uniquement le serveur MCP Jupyter en mode hors ligne
 * Compatible avec Windows, macOS et Linux
 */

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// Obtenir le chemin du répertoire actuel en ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Configuration
const config = {
  mcpServerPath: path.join(__dirname, '../../servers/jupyter-mcp-server'),
  mcpServerCommand: 'node',
  mcpServerArgs: ['dist/index.js', '--offline', '--skip-connection-check'],
  offlineMode: true,
  skipConnectionCheck: true
};

console.log('Mode hors ligne activé - Le client MCP ne tentera pas de se connecter au serveur Jupyter');

// Fonction pour démarrer un processus détaché
function startDetachedProcess(command, args, name, options = {}) {
  console.log(`Démarrage de ${name} en mode détaché...`);
  
  // Utiliser windowsHide: true pour masquer la fenêtre sur Windows
  const proc = spawn(command, args, {
    ...options,
    stdio: 'ignore',
    detached: true,
    shell: true,
    windowsHide: true
  });
  
  // Détacher le processus pour qu'il continue à s'exécuter indépendamment
  proc.unref();
  
  return proc;
}

// Fonction principale
async function main() {
  console.log('===== Démarrage du serveur MCP Jupyter en mode hors ligne =====');
  
  // Vérifier si le serveur MCP Jupyter est compilé
  const mcpServerJsPath = path.join(config.mcpServerPath, 'dist', 'index.js');
  if (!fs.existsSync(mcpServerJsPath)) {
    console.log('Compilation du serveur MCP Jupyter...');
    try {
      const { execSync } = await import('child_process');
      execSync('npm run build', {
        cwd: config.mcpServerPath,
        stdio: 'inherit'
      });
    } catch (e) {
      console.error('Échec de la compilation du serveur MCP Jupyter.');
      process.exit(1);
    }
  }
  
  // Démarrer le serveur MCP Jupyter en mode détaché
  startDetachedProcess(
    config.mcpServerCommand,
    config.mcpServerArgs,
    'MCP Jupyter Server',
    {
      cwd: config.mcpServerPath,
      env: {
        ...process.env,
        JUPYTER_MCP_OFFLINE: 'true',
        JUPYTER_SKIP_CONNECTION_CHECK: 'true'
      }
    }
  );
  
  console.log('===== Le serveur MCP Jupyter a été démarré avec succès en mode hors ligne =====');
  console.log('Le serveur MCP Jupyter est maintenant disponible pour Roo');
  console.log('NOTE: Le client est en mode hors ligne et ne tentera pas de se connecter à un serveur Jupyter.');
  
  // Terminer le script immédiatement
  console.log('Le script de démarrage se termine maintenant, mais le serveur MCP continue de s\'exécuter en arrière-plan.');
  process.exit(0);
}

// Exécuter la fonction principale
main().catch(err => {
  console.error('Erreur lors du démarrage du serveur:', err);
  process.exit(1);
});