/**
 * Script pour commiter et pousser les modifications vers GitHub
 * 
 * Usage: node temp-commit-push.js "Message de commit"
 */

import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

// Vérifier si un message de commit a été fourni
if (process.argv.length < 3) {
  console.error('Erreur: Veuillez fournir un message de commit');
  console.error('Usage: node temp-commit-push.js "Message de commit"');
  process.exit(1);
}

// Récupérer le message de commit
const commitMessage = process.argv[2] || "Mise à jour du serveur MCP quickfiles";

try {
  // Afficher le statut Git actuel
  console.log('Statut Git actuel:');
  execSync('git status', { stdio: 'inherit' });
  
  // Ajouter tous les fichiers modifiés
  console.log('\nAjout des fichiers modifiés...');
  execSync('git add .', { stdio: 'inherit' });
  
  // Commiter les modifications
  console.log(`\nCommit des modifications avec le message: "${commitMessage}"...`);
  execSync(`git commit -m "${commitMessage}"`, { stdio: 'inherit' });
  
  // Pousser les modifications vers GitHub
  console.log('\nPoussée des modifications vers GitHub...');
  execSync('git push', { stdio: 'inherit' });
  
  console.log('\nOpération terminée avec succès!');
  console.log('Les modifications ont été commitées et poussées vers GitHub.');
} catch (error) {
  console.error('\nUne erreur est survenue:');
  console.error(error.message);
  process.exit(1);
}