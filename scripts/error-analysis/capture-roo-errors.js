/**
 * Script de capture des erreurs pour le serveur MCP Jupyter
 * Ce script démarre le serveur Jupyter Notebook et le serveur MCP Jupyter
 * et capture toutes les erreurs dans un fichier log pour faciliter le débogage
 * Compatible avec Windows, macOS et Linux
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Configuration
const config = {
  jupyterCommand: 'jupyter',
  jupyterArgs: ['notebook', '--no-browser'],
  mcpServerPath: path.join(__dirname, 'servers', 'jupyter-mcp-server'),
  mcpServerCommand: 'node',
  mcpServerArgs: ['dist/index.js'],
  startupDelay: 5000, // Délai en ms pour attendre que Jupyter démarre
  logFile: path.join(__dirname, 'roo-errors.log'),
  errorPatterns: [
    {
      pattern: /Erreur lors de l'initialisation des services Jupyter/i,
      solution: "Vérifiez que le serveur Jupyter est bien démarré et accessible à l'URL configurée."
    },
    {
      pattern: /ECONNREFUSED/i,
      solution: "Impossible de se connecter au serveur Jupyter. Vérifiez qu'il est bien démarré sur le port 8888."
    },
    {
      pattern: /token.*invalid/i,
      solution: "Le token d'authentification Jupyter est invalide. Vérifiez la configuration dans servers/jupyter-mcp-server/config.json."
    },
    {
      pattern: /Kernel non trouvé/i,
      solution: "Le kernel demandé n'existe pas ou a été arrêté. Vérifiez l'ID du kernel utilisé."
    },
    {
      pattern: /Outil inconnu/i,
      solution: "L'outil MCP demandé n'existe pas. Vérifiez le nom de l'outil dans votre requête."
    },
    {
      pattern: /Error: spawn .* ENOENT/i,
      solution: "La commande jupyter n'est pas trouvée. Vérifiez que Jupyter est installé et dans votre PATH."
    }
  ]
};

// Initialiser le fichier de log
function initLogFile() {
  const timestamp = new Date().toISOString().replace(/:/g, '-');
  fs.writeFileSync(config.logFile, `=== Session de capture d'erreurs démarrée le ${timestamp} ===\n\n`);
  console.log(`Les erreurs seront enregistrées dans: ${config.logFile}`);
}

// Fonction pour ajouter un message au fichier de log
function logMessage(source, message, isError = false) {
  const timestamp = new Date().toISOString();
  const prefix = isError ? '[ERREUR]' : '[INFO]';
  const formattedMessage = `${timestamp} ${prefix} [${source}] ${message}\n`;
  
  // Écrire dans le fichier
  fs.appendFileSync(config.logFile, formattedMessage);
  
  // Afficher dans la console avec couleur
  if (isError) {
    console.error(`\x1b[31m${prefix} [${source}] ${message}\x1b[0m`);
    
    // Analyser l'erreur et suggérer des solutions
    const solutions = analyzeError(message);
    if (solutions.length > 0) {
      const solutionText = `\n=== SOLUTIONS POSSIBLES ===\n${solutions.join('\n')}\n=========================\n`;
      fs.appendFileSync(config.logFile, solutionText);
      console.log(`\x1b[33m${solutionText}\x1b[0m`);
    }
  } else {
    console.log(`\x1b[36m${prefix} [${source}] ${message}\x1b[0m`);
  }
}

// Fonction pour analyser une erreur et suggérer des solutions
function analyzeError(errorMessage) {
  const solutions = [];
  
  for (const { pattern, solution } of config.errorPatterns) {
    if (pattern.test(errorMessage)) {
      solutions.push(`- ${solution}`);
    }
  }
  
  return solutions;
}

// Fonction pour vérifier si une commande est disponible
function commandExists(command) {
  try {
    const isWindows = process.platform === 'win32';
    const checkCommand = isWindows ? 'where' : 'which';
    require('child_process').execSync(`${checkCommand} ${command}`, { stdio: 'ignore' });
    return true;
  } catch (e) {
    return false;
  }
}

// Fonction pour démarrer un processus avec capture des erreurs
function startProcess(command, args, name, options = {}) {
  logMessage('Système', `Démarrage de ${name}...`);
  
  const proc = spawn(command, args, {
    ...options,
    stdio: 'pipe',
    shell: true
  });
  
  proc.stdout.on('data', (data) => {
    const message = data.toString().trim();
    logMessage(name, message);
  });
  
  proc.stderr.on('data', (data) => {
    const message = data.toString().trim();
    logMessage(name, message, true);
  });
  
  proc.on('close', (code) => {
    if (code !== 0) {
      logMessage('Système', `${name} s'est arrêté avec le code ${code}`, true);
    } else {
      logMessage('Système', `${name} s'est arrêté normalement`);
    }
  });
  
  return proc;
}

// Fonction pour capturer les erreurs de Roo (simulation)
function setupRooErrorCapture() {
  logMessage('Système', 'Configuration de la capture des erreurs de Roo...');
  
  // Cette fonction est une simulation car nous ne pouvons pas directement
  // capturer les erreurs de Roo. Nous fournissons des instructions à l'utilisateur.
  const instructions = `
=== INSTRUCTIONS POUR CAPTURER LES ERREURS DE ROO ===

1. Utilisez ce script pour démarrer les serveurs Jupyter et MCP Jupyter
2. Lorsque vous utilisez Roo, si une erreur se produit:
   - Notez l'action exacte qui a provoqué l'erreur
   - Consultez le fichier ${config.logFile} pour voir les erreurs détaillées
   - Cherchez les solutions suggérées dans le fichier de log

Pour les erreurs courantes:
- Si Roo ne peut pas se connecter au serveur MCP, vérifiez que ce script est en cours d'exécution
- Si Roo renvoie une erreur lors de l'utilisation d'un outil, vérifiez les paramètres fournis
- Si le serveur Jupyter n'est pas accessible, vérifiez qu'il est bien démarré sur le port 8888

=== FIN DES INSTRUCTIONS ===
`;

  console.log('\x1b[32m%s\x1b[0m', instructions);
  fs.appendFileSync(config.logFile, `\n${instructions}\n`);
}

// Fonction principale
async function main() {
  // Initialiser le fichier de log
  initLogFile();
  
  logMessage('Système', '===== Démarrage de la capture d\'erreurs pour les serveurs Jupyter et MCP Jupyter =====');
  
  // Vérifier si Jupyter est installé
  if (!commandExists(config.jupyterCommand)) {
    logMessage('Système', `${config.jupyterCommand} n'est pas installé ou n'est pas dans le PATH.`, true);
    logMessage('Système', 'Veuillez installer Jupyter avec: pip install jupyter', true);
    process.exit(1);
  }
  
  // Vérifier si le serveur MCP Jupyter est compilé
  const mcpServerJsPath = path.join(config.mcpServerPath, 'dist', 'index.js');
  if (!fs.existsSync(mcpServerJsPath)) {
    logMessage('Système', 'Compilation du serveur MCP Jupyter...');
    try {
      require('child_process').execSync('npm run build', {
        cwd: config.mcpServerPath,
        stdio: 'inherit'
      });
    } catch (e) {
      logMessage('Système', 'Échec de la compilation du serveur MCP Jupyter.', true);
      process.exit(1);
    }
  }
  
  // Démarrer Jupyter Notebook
  const jupyterProcess = startProcess(
    config.jupyterCommand,
    config.jupyterArgs,
    'Jupyter Notebook'
  );
  
  // Attendre que Jupyter Notebook soit prêt
  logMessage('Système', `Attente du démarrage de Jupyter Notebook (${config.startupDelay / 1000} secondes)...`);
  await new Promise(resolve => setTimeout(resolve, config.startupDelay));
  
  // Démarrer le serveur MCP Jupyter
  const mcpProcess = startProcess(
    config.mcpServerCommand,
    config.mcpServerArgs,
    'MCP Jupyter Server',
    { cwd: config.mcpServerPath }
  );
  
  logMessage('Système', '===== Les deux serveurs ont été démarrés avec succès =====');
  logMessage('Système', 'Jupyter Notebook est accessible à l\'adresse: http://localhost:8888');
  logMessage('Système', 'Le serveur MCP Jupyter est maintenant disponible pour Roo');
  
  // Configurer la capture des erreurs de Roo
  setupRooErrorCapture();
  
  // Gérer l'arrêt propre des processus
  process.on('SIGINT', () => {
    logMessage('Système', 'Arrêt des serveurs...');
    jupyterProcess.kill();
    mcpProcess.kill();
    logMessage('Système', 'Session de capture d\'erreurs terminée.');
    process.exit(0);
  });
}

// Exécuter la fonction principale
main().catch(err => {
  logMessage('Système', `Erreur lors du démarrage des serveurs: ${err.message}`, true);
  process.exit(1);
});