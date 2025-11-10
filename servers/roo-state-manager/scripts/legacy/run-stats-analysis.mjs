#!/usr/bin/env node
/**
 * 🚀 RUNNER - Exécution forcée analyse statistique tous workspaces
 * 
 * Script simple qui force l'exécution de l'analyse et sauvegarde le rapport.
 * Contourne les problèmes potentiels de détection d'exécution directe.
 * 
 * Usage: node scripts/run-stats-analysis.mjs
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { AllWorkspacesStatsAnalyzer } from './analyze-all-workspaces-stats.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function executeAnalysis() {
  console.log('🚀 EXÉCUTION ANALYSE STATISTIQUE TOUS WORKSPACES');
  console.log('📊 Mission: Validation efficacité système hiérarchique corrigé');
  console.log('');
  
  try {
    // Créer l'analyzeur
    console.log('🔧 Initialisation analyzer...');
    const analyzer = new AllWorkspacesStatsAnalyzer();
    
    // Exécuter l'analyse
    console.log('📈 Analyse en cours...');
    const report = await analyzer.analyzeAllWorkspaces();
    
    if (!report) {
      console.log('❌ ERREUR: Aucun rapport généré');
      return false;
    }
    
    console.log('✅ Analyse terminée avec succès!');
    console.log(`📊 Taille rapport: ${report.length} caractères`);
    
    // Créer le répertoire de destination
    const archiveDir = path.join(__dirname, '../docs/archives/2025-10');
    await fs.mkdir(archiveDir, { recursive: true });
    
    // Sauvegarder le rapport
    const reportPath = path.join(archiveDir, '2025-10-05-05-RAPPORT-stats-parentid-tous-workspaces.md');
    await fs.writeFile(reportPath, report, 'utf8');
    
    console.log('');
    console.log(`💾 Rapport sauvegardé: ${reportPath}`);
    
    // Afficher le résumé
    const totalTasks = analyzer.globalStats.totalTasks;
    const totalWithChildren = analyzer.globalStats.hierarchyStats.totalWithChildren;
    const hierarchyRate = totalTasks > 0 ? ((totalWithChildren / totalTasks) * 100).toFixed(1) : 0;
    
    console.log('');
    console.log('='.repeat(80));
    console.log('🎯 RÉSUMÉ ANALYSE TOUS WORKSPACES');
    console.log(`📊 ${totalTasks} tâches analysées`);
    console.log(`🏗️ ${hierarchyRate}% avec hiérarchie identifiée`);
    console.log(`🌐 ${analyzer.globalStats.totalWorkspaces} workspaces traités`);
    console.log(`✅ Status: ${hierarchyRate >= 50 || totalTasks <= 10 ? 'VALIDATION RÉUSSIE' : 'À AMÉLIORER'}`);
    console.log('='.repeat(80));
    
    // Afficher extrait du rapport
    console.log('');
    console.log('📋 EXTRAIT RAPPORT (début):');
    console.log('-'.repeat(60));
    console.log(report.substring(0, 800));
    if (report.length > 800) {
      console.log('...');
      console.log('[RAPPORT COMPLET SAUVEGARDÉ DANS LE FICHIER]');
    }
    console.log('-'.repeat(60));
    
    return true;
    
  } catch (error) {
    console.error('❌ ERREUR EXÉCUTION:', error.message);
    console.error('Stack:', error.stack);
    return false;
  }
}

async function main() {
  const success = await executeAnalysis();
  
  if (success) {
    console.log('');
    console.log('🏁 MISSION ACCOMPLIE - Rapport statistique généré avec succès!');
    process.exit(0);
  } else {
    console.log('');
    console.log('💥 MISSION ÉCHOUÉE - Voir erreurs ci-dessus');
    process.exit(1);
  }
}

main().catch(console.error);