#!/usr/bin/env node
/**
 * 🐛 DEBUG SCRIPT - Test d'exécution analyze-all-workspaces-stats.mjs
 * 
 * Script de diagnostic pour identifier pourquoi le script d'analyse
 * ne produit pas de sortie visible lors de l'exécution.
 * 
 * Usage: node scripts/debug-analyze-stats.mjs
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('🐛 === DEBUG SCRIPT ANALYSE STATISTIQUE ===');
console.log('');

async function debugAnalysisScript() {
    try {
        console.log('1. Test existence cache skeleton...');
        const cachePath = path.join(__dirname, '../.roo-state-manager/skeleton-cache.json');
        
        if (await fs.access(cachePath).then(() => true).catch(() => false)) {
            const stats = await fs.stat(cachePath);
            console.log(`   ✅ Cache trouvé: ${cachePath}`);
            console.log(`   📊 Taille: ${stats.size} bytes`);
            console.log(`   📅 Dernière modification: ${stats.mtime}`);
        } else {
            console.log(`   ❌ Cache introuvable: ${cachePath}`);
            return;
        }
        
        console.log('');
        console.log('2. Test contenu cache...');
        const cacheContent = await fs.readFile(cachePath, 'utf8');
        const cache = JSON.parse(cacheContent);
        const taskIds = Object.keys(cache);
        console.log(`   📈 Nombre de tâches: ${taskIds.length}`);
        for (const taskId of taskIds) {
            const task = cache[taskId];
            console.log(`   - ${taskId}: "${task.instruction?.substring(0, 50)}..."`);
        }
        
        console.log('');
        console.log('3. Test import module analyse...');
        const { AllWorkspacesStatsAnalyzer } = await import('./analyze-all-workspaces-stats.mjs');
        console.log('   ✅ Module importé avec succès');
        
        console.log('');
        console.log('4. Test création analyzer...');
        const analyzer = new AllWorkspacesStatsAnalyzer();
        console.log('   ✅ Analyzer créé avec succès');
        
        console.log('');
        console.log('5. Test exécution analyse...');
        const report = await analyzer.analyzeAllWorkspaces();
        
        if (report) {
            console.log('   ✅ Rapport généré avec succès!');
            console.log(`   📊 Taille rapport: ${report.length} caractères`);
            console.log('');
            console.log('=== DÉBUT RAPPORT (500 premiers caractères) ===');
            console.log(report.substring(0, 500));
            console.log('=== FIN EXTRAIT RAPPORT ===');
            
            // Vérifier si le rapport a été sauvegardé
            const reportPath = path.join(__dirname, '../docs/archives/2025-10/2025-10-05-05-RAPPORT-stats-parentid-tous-workspaces.md');
            if (await fs.access(reportPath).then(() => true).catch(() => false)) {
                console.log(`✅ Rapport sauvegardé: ${reportPath}`);
            } else {
                console.log(`⚠️ Rapport non sauvegardé automatiquement`);
            }
        } else {
            console.log('   ❌ Aucun rapport généré');
        }
        
    } catch (error) {
        console.error('❌ ERREUR DEBUG:', error.message);
        console.error('Stack trace:');
        console.error(error.stack);
    }
}

async function main() {
    console.log(`📍 Répertoire de travail: ${process.cwd()}`);
    console.log(`📍 Répertoire script: ${__dirname}`);
    console.log('');
    
    await debugAnalysisScript();
    
    console.log('');
    console.log('🏁 DEBUG TERMINÉ');
}

main().catch(console.error);