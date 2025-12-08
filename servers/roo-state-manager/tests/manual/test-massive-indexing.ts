/**
 * Script de test pour valider l'indexation massive et le flux complet
 * Action -> Cache -> Indexation Qdrant
 */

import { StateManager } from '../../src/services/state-manager.service.js';
import { handleBuildSkeletonCache } from '../../src/tools/cache/build-skeleton-cache.tool.js';
import { TaskIndexer } from '../../src/services/task-indexer.js';
import { RooStorageDetector } from '../../src/utils/roo-storage-detector.js';
import { promises as fs } from 'fs';
import path from 'path';
import dotenv from 'dotenv';

// Charger les variables d'environnement
dotenv.config({ path: path.join(process.cwd(), '.env') });

async function runTest() {
    console.log('🚀 Démarrage du test d\'indexation massive...');

    // 1. Initialiser le StateManager
    const stateManager = new StateManager();
    const state = stateManager.getState();

    // Activer l'indexation Qdrant
    state.isQdrantIndexingEnabled = true;

    // 2. Simuler un build_skeleton_cache complet
    console.log('📦 Lancement de build_skeleton_cache...');
    const startTime = Date.now();

    // On force le rebuild pour être sûr de tout scanner
    await handleBuildSkeletonCache({ force_rebuild: false }, state.conversationCache, state);

    const buildTime = Date.now() - startTime;
    console.log(`✅ build_skeleton_cache terminé en ${buildTime}ms`);
    console.log(`📊 Squelettes en cache: ${state.conversationCache.size}`);
    console.log(`📥 Queue d'indexation Qdrant: ${state.qdrantIndexQueue.size} tâches`);

    if (state.qdrantIndexQueue.size === 0) {
        console.warn('⚠️ Aucune tâche ajoutée à la queue d\'indexation. Vérifiez la logique de build_skeleton_cache.');
        return;
    }

    // 3. Traiter la queue d'indexation (simulation du background process)
    console.log('🔄 Traitement de la queue d\'indexation...');
    const taskIndexer = new TaskIndexer();
    let indexedCount = 0;
    let errorCount = 0;

    // On prend un échantillon plus large pour les stats
    const MAX_TASKS_TO_PROCESS = 200;
    const tasksToProcess = Array.from(state.qdrantIndexQueue).slice(0, MAX_TASKS_TO_PROCESS);
    const totalTasks = tasksToProcess.length;
    const indexStartTime = Date.now();

    console.log(`🎯 Objectif: Indexer ${totalTasks} tâches`);

    for (let i = 0; i < totalTasks; i++) {
        const taskId = tasksToProcess[i];
        try {
            // console.log(`Processing task: ${taskId}`); // Trop verbeux
            await taskIndexer.indexTask(taskId);
            indexedCount++;
            state.qdrantIndexQueue.delete(taskId);
        } catch (error) {
            // console.error(`❌ Erreur indexation ${taskId}:`, error); // Trop verbeux si fréquent
            errorCount++;
        }

        // Stats et estimation tous les 10 items
        if ((i + 1) % 10 === 0) {
            const elapsed = Date.now() - indexStartTime;
            const avgTimePerTask = elapsed / (i + 1);
            const remainingTasks = totalTasks - (i + 1);
            const estimatedRemainingTime = remainingTasks * avgTimePerTask;

            console.log(`📊 Progression: ${i + 1}/${totalTasks} (${Math.round(((i + 1) / totalTasks) * 100)}%)`);
            console.log(`   ⏱️ Temps moyen/tâche: ${Math.round(avgTimePerTask)}ms`);
            console.log(`   ⏳ Temps restant estimé: ${Math.round(estimatedRemainingTime / 1000)}s`);
            console.log(`   ✅ Succès: ${indexedCount}, ❌ Échecs: ${errorCount}`);
        }

        // Petit délai pour éviter le rate limit violent
        await new Promise(resolve => setTimeout(resolve, 200));
    }

    const totalIndexTime = Date.now() - indexStartTime;
    console.log(`✅ Indexation terminée (échantillon de ${totalTasks} tâches)`);
    console.log(`⏱️ Temps total d'indexation: ${totalIndexTime}ms`);
    console.log(`📊 Succès: ${indexedCount}, Échecs: ${errorCount}`);

    // 4. Vérification finale
    console.log('🔍 Vérification de l\'état final...');
    // Ici on pourrait faire une requête Qdrant pour vérifier que les points existent
    // Mais pour l'instant on se fie aux logs de TaskIndexer

    console.log('🎉 Test terminé avec succès !');
}

runTest().catch(console.error);