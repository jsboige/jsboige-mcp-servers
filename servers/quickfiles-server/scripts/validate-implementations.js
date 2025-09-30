#!/usr/bin/env node

/**
 * Script de validation des implémentations
 * 
 * Ce script détecte automatiquement les stubs et les implémentations manquantes
 * dans le code source. Il doit être exécuté avant chaque commit.
 * 
 * Usage: node scripts/validate-implementations.js
 * Exit code: 0 si OK, 1 si des stubs sont détectés
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Patterns de stubs à détecter
const STUB_PATTERNS = [
  /Not implemented/i,
  /TODO:\s*implement/i,
  /stub/i,
  /return\s*{\s*content:\s*\[\s*{\s*type:\s*['"]text['"]\s*,\s*text:\s*['"]Not implemented['"]/,
  /throw new Error\(['"]Not implemented['"]\)/,
  /console\.log\(['"]stub['"]\)/
];

// Liste des fichiers source à vérifier
const SOURCE_FILES = [
  path.join(__dirname, '..', 'src', 'index.ts')
];

// Couleurs pour la sortie console
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m'
};

/**
 * Affiche un message avec couleur
 */
function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

/**
 * Vérifie un fichier pour détecter les stubs
 */
async function checkFile(filePath) {
  const issues = [];
  
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.split('\n');
    
    lines.forEach((line, index) => {
      STUB_PATTERNS.forEach(pattern => {
        if (pattern.test(line)) {
          issues.push({
            file: path.basename(filePath),
            line: index + 1,
            content: line.trim(),
            pattern: pattern.toString()
          });
        }
      });
    });
    
  } catch (error) {
    log(`⚠️  Impossible de lire ${filePath}: ${error.message}`, 'yellow');
  }
  
  return issues;
}

/**
 * Vérifie la longueur minimale des méthodes critiques
 */
async function checkMethodLength(filePath) {
  const issues = [];
  
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    
    // Liste des méthodes critiques à vérifier
    const criticalMethods = [
      'handleDeleteFiles',
      'handleEditMultipleFiles',
      'handleExtractMarkdownStructure',
      'handleCopyFiles',
      'handleMoveFiles',
      'handleSearchInFiles',
      'handleSearchAndReplace',
      'handleRestartMcpServers'
    ];
    
    criticalMethods.forEach(methodName => {
      // Regex pour capturer la méthode complète
      const methodRegex = new RegExp(
        `async\\s+${methodName}\\s*\\([^)]*\\)\\s*[:{]([^}]*(?:{[^}]*}[^}]*)*)`,
        'gs'
      );
      
      const match = methodRegex.exec(content);
      if (match) {
        const methodBody = match[0];
        const lineCount = methodBody.split('\n').length;
        
        // Une méthode stub est typiquement < 10 lignes
        // Une vraie implémentation devrait avoir > 15 lignes
        if (lineCount < 15) {
          issues.push({
            method: methodName,
            lines: lineCount,
            reason: 'Méthode trop courte, possiblement un stub'
          });
        }
      } else {
        issues.push({
          method: methodName,
          lines: 0,
          reason: 'Méthode non trouvée'
        });
      }
    });
    
  } catch (error) {
    log(`⚠️  Erreur lors de la vérification de ${filePath}: ${error.message}`, 'yellow');
  }
  
  return issues;
}

/**
 * Affiche un rapport détaillé
 */
function displayReport(stubIssues, methodIssues) {
  console.log('\n' + '='.repeat(70));
  log('📊 RAPPORT DE VALIDATION DES IMPLÉMENTATIONS', 'blue');
  console.log('='.repeat(70) + '\n');
  
  // Afficher les stubs détectés
  if (stubIssues.length > 0) {
    log(`❌ ${stubIssues.length} stub(s) détecté(s):`, 'red');
    console.log('');
    
    stubIssues.forEach(issue => {
      log(`  📄 ${issue.file}:${issue.line}`, 'yellow');
      log(`     ${issue.content}`, 'reset');
      console.log('');
    });
  } else {
    log('✅ Aucun stub détecté dans les patterns de recherche', 'green');
  }
  
  console.log('');
  
  // Afficher les problèmes de longueur de méthode
  if (methodIssues.length > 0) {
    log(`⚠️  ${methodIssues.length} méthode(s) suspecte(s):`, 'yellow');
    console.log('');
    
    methodIssues.forEach(issue => {
      log(`  🔍 ${issue.method}`, 'yellow');
      log(`     Lignes: ${issue.lines} (attendu: > 15)`, 'reset');
      log(`     Raison: ${issue.reason}`, 'reset');
      console.log('');
    });
  } else {
    log('✅ Toutes les méthodes critiques ont une longueur acceptable', 'green');
  }
  
  console.log('='.repeat(70));
}

/**
 * Fonction principale
 */
async function main() {
  log('\n🔍 Démarrage de la validation des implémentations...', 'blue');
  console.log('');
  
  let allStubIssues = [];
  let allMethodIssues = [];
  
  // Vérifier chaque fichier source
  for (const filePath of SOURCE_FILES) {
    log(`Vérification de ${path.basename(filePath)}...`, 'blue');
    
    const stubIssues = await checkFile(filePath);
    const methodIssues = await checkMethodLength(filePath);
    
    allStubIssues = allStubIssues.concat(stubIssues);
    allMethodIssues = allMethodIssues.concat(methodIssues);
  }
  
  // Afficher le rapport
  displayReport(allStubIssues, allMethodIssues);
  
  // Déterminer le code de sortie
  const hasCriticalIssues = allStubIssues.length > 0;
  const hasWarnings = allMethodIssues.length > 0;
  
  if (hasCriticalIssues) {
    log('\n❌ VALIDATION ÉCHOUÉE: Des stubs ont été détectés!', 'red');
    log('Veuillez implémenter ces méthodes avant de committer.', 'red');
    process.exit(1);
  }
  
  if (hasWarnings) {
    log('\n⚠️  AVERTISSEMENT: Certaines méthodes semblent suspectes.', 'yellow');
    log('Veuillez vérifier qu\'elles ont des implémentations complètes.', 'yellow');
    // On ne bloque pas sur les avertissements, mais on les affiche
  }
  
  log('\n✅ VALIDATION RÉUSSIE: Aucun stub détecté!', 'green');
  log('Tous les outils ont des implémentations valides.', 'green');
  console.log('');
  
  process.exit(0);
}

// Exécuter le script
main().catch(error => {
  log(`\n💥 Erreur fatale: ${error.message}`, 'red');
  console.error(error.stack);
  process.exit(1);
});