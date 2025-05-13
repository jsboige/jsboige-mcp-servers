/**
 * Script de démarrage pour le serveur MCP Jupyter
 * Ce script démarre uniquement le serveur MCP Jupyter
 * Compatible avec Windows, macOS et Linux
 */

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { parseArgs } from 'util';

// Obtenir le chemin du répertoire actuel en ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Analyser les arguments de ligne de commande
const { values } = parseArgs({
  options: {
    offline: { type: 'boolean', default: false }
  }
});

// Configuration
const config = {
  mcpServerPath: path.join(__dirname, '../../servers/jupyter-mcp-server'),
  mcpServerCommand: 'node',
  mcpServerArgs: values.offline ? ['dist/index.js', '--offline'] : ['dist/index.js'],
  offlineMode: values.offline
};

if (config.offlineMode) {
  console.log('Mode hors ligne activé - Le client MCP ne tentera pas de se connecter au serveur Jupyter');
}

// Fonction pour démarrer un processus
function startProcess(command, args, name, options = {}) {
  console.log(`Démarrage de ${name}...`);
  
  const proc = spawn(command, args, {
    ...options,
    stdio: 'pipe',
    shell: true
  });
  
  proc.stdout.on('data', (data) => {
    console.log(`[${name}] ${data.toString().trim()}`);
  });
  
  proc.stderr.on('data', (data) => {
    console.error(`[${name}] ${data.toString().trim()}`);
  });
  
  proc.on('close', (code) => {
    if (code !== 0) {
      console.error(`${name} s'est arrêté avec le code ${code}`);
    } else {
      console.log(`${name} s'est arrêté normalement`);
    }
  });
  
  return proc;
}

// Fonction principale
async function main() {
  console.log('===== Démarrage du serveur MCP Jupyter =====');
  
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
  
  // Démarrer le serveur MCP Jupyter
  const mcpProcess = startProcess(
    config.mcpServerCommand,
    config.mcpServerArgs,
    'MCP Jupyter Server',
    {
      cwd: config.mcpServerPath,
      env: {
        ...process.env,
        JUPYTER_MCP_OFFLINE: config.offlineMode ? 'true' : process.env.JUPYTER_MCP_OFFLINE
      }
    }
  );
  
  console.log('===== Le serveur MCP Jupyter a été démarré avec succès =====');
  console.log('Le serveur MCP Jupyter est maintenant disponible pour Roo');
  
  // Gérer l'arrêt propre des processus
  process.on('SIGINT', () => {
    console.log('Arrêt du serveur...');
    mcpProcess.kill();
    process.exit(0);
  });
}

// Exécuter la fonction principale
main().catch(err => {
  console.error('Erreur lors du démarrage du serveur:', err);
  process.exit(1);
});