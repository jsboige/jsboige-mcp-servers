#!/usr/bin/env node

/**
 * 📊 DIAGNOSTIC CACHE SKELETON
 * Script de vérification état et contenu du cache skeleton
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const colors = {
    yellow: '\x1b[33m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    cyan: '\x1b[36m',
    gray: '\x1b[90m',
    reset: '\x1b[0m'
};

function colorLog(text, color = 'reset') {
    console.log(`${colors[color]}${text}${colors.reset}`);
}

async function diagnoseSkeleton() {
    colorLog('📊 DIAGNOSTIC CACHE SKELETON', 'yellow');
    colorLog('=============================', 'yellow');
    console.log('');

    const cachePath = path.join(__dirname, '../.roo-state-manager/skeleton-cache.json');
    colorLog(`Chemin cache: ${cachePath}`, 'cyan');

    try {
        const stats = await fs.stat(cachePath);
        const sizeMB = Math.round(stats.size / (1024 * 1024) * 100) / 100;
        const sizeKB = Math.round(stats.size / 1024);

        colorLog('✅ Cache trouvé', 'green');
        colorLog(`   Taille: ${sizeMB} MB (${sizeKB} KB)`, 'cyan');
        colorLog(`   Modifié: ${stats.mtime.toISOString()}`, 'gray');

    } catch (error) {
        if (error.code === 'ENOENT') {
            colorLog('❌ CACHE SKELETON MANQUANT!', 'red');
            colorLog('   → Exécuter: build_skeleton_cache', 'yellow');
            process.exit(1);
        }
        throw error;
    }

    try {
        console.log('');
        colorLog('🔍 Analyse contenu...', 'yellow');

        const content = await fs.readFile(cachePath, 'utf8');
        const cache = JSON.parse(content);
        const taskIds = Object.keys(cache);
        const taskCount = taskIds.length;

        colorLog('📈 STATISTIQUES GÉNÉRALES', 'green');
        colorLog(`   Total tâches: ${taskCount.toLocaleString()}`, 'cyan');

        if (taskCount === 0) {
            colorLog('❌ CACHE VIDE!', 'red');
            process.exit(1);
        }

        // Analyser workspaces
        const workspaces = {};
        const hierarchyStats = {
            withChildren: 0,
            withParents: 0,
            orphans: 0,
            roots: 0
        };

        for (const taskId of taskIds) {
            const task = cache[taskId];

            // Comptage workspace
            const ws = task.workspace || 'UNKNOWN';
            workspaces[ws] = (workspaces[ws] || 0) + 1;

            // Stats hiérarchie
            const childCount = task.childTaskInstructionPrefixes?.length || 0;

            if (childCount > 0) {
                hierarchyStats.withChildren++;
            }

            if (task.parentTaskId) {
                hierarchyStats.withParents++;
            } else if (childCount === 0) {
                hierarchyStats.orphans++;
            } else {
                hierarchyStats.roots++;
            }
        }

        console.log('');
        colorLog(`🏢 WORKSPACES (${Object.keys(workspaces).length})`, 'green');

        const sortedWorkspaces = Object.entries(workspaces)
            .sort(([,a], [,b]) => b - a)
            .slice(0, 10);

        for (const [ws, count] of sortedWorkspaces) {
            const percent = Math.round((count / taskCount) * 1000) / 10;
            colorLog(`   ${ws}: ${count.toLocaleString()} tâches (${percent}%)`, 'cyan');
        }

        if (Object.keys(workspaces).length > 10) {
            const remaining = Object.keys(workspaces).length - 10;
            colorLog(`   ... et ${remaining} autres workspaces`, 'gray');
        }

        console.log('');
        colorLog('🔗 HIÉRARCHIE', 'green');

        const hierarchyRate = Math.round((hierarchyStats.withChildren / taskCount) * 1000) / 10;
        const parentRate = Math.round((hierarchyStats.withParents / taskCount) * 1000) / 10;
        const rootRate = Math.round((hierarchyStats.roots / taskCount) * 1000) / 10;
        const orphanRate = Math.round((hierarchyStats.orphans / taskCount) * 1000) / 10;

        colorLog(`   Avec enfants: ${hierarchyStats.withChildren.toLocaleString()} (${hierarchyRate}%)`, 'cyan');
        colorLog(`   Avec parents: ${hierarchyStats.withParents.toLocaleString()} (${parentRate}%)`, 'cyan');
        colorLog(`   Racines: ${hierarchyStats.roots.toLocaleString()} (${rootRate}%)`, 'cyan');
        colorLog(`   Orphelines: ${hierarchyStats.orphans.toLocaleString()} (${orphanRate}%)`, 'cyan');

        // Évaluation système
        console.log('');
        colorLog('📊 ÉVALUATION SYSTÈME', 'yellow');

        if (hierarchyRate >= 70) {
            colorLog('✅ EXCELLENT: Système hiérarchique très performant', 'green');
        } else if (hierarchyRate >= 50) {
            colorLog('✅ BON: Performance hiérarchique satisfaisante', 'green');
        } else if (hierarchyRate >= 30) {
            colorLog('⚠️ MOYEN: Amélioration possible', 'yellow');
        } else {
            colorLog('❌ FAIBLE: Investigation requise', 'red');
        }

        // Échantillon tâches
        if (process.argv.includes('--sample') && taskCount > 0) {
            console.log('');
            colorLog('🔍 ÉCHANTILLON TÂCHES (Top 5)', 'yellow');

            const sampleTasks = taskIds.slice(0, 5);
            for (const taskId of sampleTasks) {
                const task = cache[taskId];
                const shortId = taskId.substring(0, 8);
                let instruction = task.instruction || '';
                if (instruction.length > 80) {
                    instruction = instruction.substring(0, 77) + '...';
                }
                const childCount = task.childTaskInstructionPrefixes?.length || 0;

                colorLog(`   ${shortId} (${task.workspace || 'UNKNOWN'}): ${childCount} enfants`, 'cyan');
                if (instruction) {
                    colorLog(`      → ${instruction}`, 'gray');
                }
            }
        }

        console.log('');
        colorLog('✅ Diagnostic terminé - Cache opérationnel', 'green');

        // Summary pour script
        console.log('');
        console.log(`SUMMARY: ${taskCount} tasks, ${hierarchyRate}% hierarchy, ${Object.keys(workspaces).length} workspaces`);

    } catch (error) {
        colorLog('❌ ERREUR: Impossible d\'analyser le cache', 'red');
        colorLog(`   ${error.message}`, 'gray');
        process.exit(1);
    }
}

diagnoseSkeleton().catch(console.error);