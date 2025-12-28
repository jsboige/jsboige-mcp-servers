/**
 * Services de background pour l'architecture à 2 niveaux
 * Niveau 1: Reconstruction temps réel des squelettes
 * Niveau 2: Indexation Qdrant asynchrone non-bloquante
 */

import { promises as fs } from 'fs';
import path from 'path';
import { ConversationSkeleton } from '../types/conversation.js';
import { RooStorageDetector } from '../utils/roo-storage-detector.js';
import { ServerState } from './state-manager.service.js';
import { ANTI_LEAK_CONFIG } from '../config/server-config.js';
import { TaskIndexer, getHostIdentifier } from './task-indexer.js';
import * as toolExports from '../tools/index.js';

/**
 * Charge les squelettes existants depuis le disque au démarrage
 */
export async function loadSkeletonsFromDisk(conversationCache: Map<string, ConversationSkeleton>): Promise<void> {
    try {
        console.log('Loading existing skeletons from disk...');
        const storageLocations = await RooStorageDetector.detectStorageLocations();

        if (storageLocations.length === 0) {
            console.warn('Aucun emplacement de stockage Roo trouvé');
            return;
        }

        // ✅ FIX CRITIQUE: Utiliser tasks/.skeletons comme build-skeleton-cache.tool.ts
        const tasksDir = path.join(storageLocations[0], 'tasks');
        const skeletonsCacheDir = path.join(tasksDir, '.skeletons');

        try {
            const skeletonFiles = await fs.readdir(skeletonsCacheDir);
            const jsonFiles = skeletonFiles.filter(file => file.endsWith('.json'));

            console.log(`Found ${jsonFiles.length} skeleton files to load`);

            for (const file of jsonFiles) {
                try {
                    const filePath = path.join(skeletonsCacheDir, file);
                    const content = await fs.readFile(filePath, 'utf8');
                    const skeleton: ConversationSkeleton = JSON.parse(content);
                    conversationCache.set(skeleton.taskId, skeleton);
                } catch (error) {
                    console.warn(`Failed to load skeleton ${file}:`, error);
                }
            }

            console.log(`Loaded ${conversationCache.size} skeletons from disk`);
        } catch (error) {
            console.warn('Skeleton cache directory not found, will be created when needed');
        }
    } catch (error) {
        console.error('Failed to load skeletons from disk:', error);
    }
}

/**
 * Auto-réparation proactive des métadonnées manquantes au démarrage
 */
export async function startProactiveMetadataRepair(): Promise<void> {
    console.log('[Auto-Repair] 🔧 Démarrage du scan proactif de réparation des métadonnées...');

    try {
        const locations = await RooStorageDetector.detectStorageLocations();
        if (locations.length === 0) {
            console.log('[Auto-Repair] ℹ️ Aucun emplacement de stockage trouvé. Scan terminé.');
            return;
        }

        let repairedCount = 0;
        const tasksToRepair: { taskId: string, taskPath: string }[] = [];

        // 1. Détecter toutes les tâches nécessitant une réparation
        for (const loc of locations) {
            const tasksPath = path.join(loc, 'tasks');
            try {
                const taskIds = await fs.readdir(tasksPath);

                for (const taskId of taskIds) {
                    if (taskId === '.skeletons') continue;

                    const taskPath = path.join(tasksPath, taskId);
                    const metadataPath = path.join(taskPath, 'task_metadata.json');

                    try {
                        const stats = await fs.stat(taskPath);
                        if (!stats.isDirectory()) continue;

                        const files = await fs.readdir(taskPath);
                        if (files.length === 0) continue;

                        try {
                            await fs.access(metadataPath);
                        } catch {
                            tasksToRepair.push({ taskId, taskPath });
                        }
                    } catch (error) {
                        console.debug(`[Auto-Repair] Erreur lors de l'analyse de ${taskId}:`, error);
                    }
                }
            } catch (error) {
                console.warn(`[Auto-Repair] ⚠️ Erreur lors de la lecture de ${tasksPath}:`, error);
            }
        }

        if (tasksToRepair.length === 0) {
            console.log('[Auto-Repair] ✅ Tous les squelettes sont cohérents. Scan terminé.');
            return;
        }

        console.log(`[Auto-Repair] 📋 Trouvé ${tasksToRepair.length} tâches nécessitant une réparation de métadonnées.`);

        // 2. Traiter la réparation en parallèle (avec une limite)
        const concurrencyLimit = 5;
        for (let i = 0; i < tasksToRepair.length; i += concurrencyLimit) {
            const batch = tasksToRepair.slice(i, i + concurrencyLimit);
            await Promise.all(batch.map(async (task) => {
                try {
                    const skeleton = await RooStorageDetector.analyzeConversation(task.taskId, task.taskPath);
                    if (skeleton && skeleton.metadata) {
                        const metadataFilePath = path.join(task.taskPath, 'task_metadata.json');
                        await fs.writeFile(metadataFilePath, JSON.stringify(skeleton.metadata, null, 2), 'utf-8');
                        repairedCount++;
                    } else {
                        console.debug(`[Auto-Repair] ⚠️ Impossible de générer le squelette pour ${task.taskId}`);
                    }
                } catch (e) {
                     console.debug(`[Auto-Repair] ❌ Échec de réparation pour ${task.taskId}:`, e);
                }
            }));
            console.log(`[Auto-Repair] 📊 Lot traité, ${repairedCount}/${tasksToRepair.length} réparées jusqu'à présent...`);
        }

        console.log(`[Auto-Repair] ✅ Scan terminé. ${repairedCount} métadonnées réparées avec succès.`);

    } catch (error) {
        console.error('[Auto-Repair] ❌ Erreur critique lors du scan:', error);
    }
}

/**
 * Initialise les services background
 */
export async function initializeBackgroundServices(state: ServerState): Promise<void> {
    try {
        console.log('🚀 Initialisation des services background à 2 niveaux...');

        // Niveau 1: Chargement initial des squelettes depuis le disque
        await loadSkeletonsFromDisk(state.conversationCache);

        // Auto-réparation proactive: Génération des métadonnées manquantes
        await startProactiveMetadataRepair();

        // Niveau 2: Initialisation du service d'indexation Qdrant asynchrone
        await initializeQdrantIndexingService(state);

        console.log('✅ Services background initialisés avec succès');
    } catch (error: any) {
        console.error('❌ Erreur lors de l\'initialisation des services background:', error);
        throw error;
    }
}

/**
 * Initialise le service d'indexation Qdrant asynchrone
 */
async function initializeQdrantIndexingService(state: ServerState): Promise<void> {
    try {
        console.log('🔍 Initialisation du service d\'indexation Qdrant...');

        // Vérifier la cohérence entre squelettes et index Qdrant
        await verifyQdrantConsistency(state);

        // Vérifier les squelettes qui nécessitent une réindexation
        await scanForOutdatedQdrantIndex(state);

        // Démarrer le service d'indexation en arrière-plan
        startQdrantIndexingBackgroundProcess(state);

        console.log('✅ Service d\'indexation Qdrant initialisé');
    } catch (error: any) {
        console.error('⚠️  Erreur lors de l\'initialisation de l\'indexation Qdrant (non-bloquant):', error);
        state.isQdrantIndexingEnabled = false;
    }
}

/**
 * Scanner pour identifier les squelettes ayant besoin d'une réindexation
 */
async function scanForOutdatedQdrantIndex(state: ServerState): Promise<void> {
    let indexCount = 0;
    let skipCount = 0;
    let retryCount = 0;
    let failedCount = 0;
    let migratedCount = 0;

    console.log(`🔍 Début du scan d'indexation avec mécanisme d'idempotence...`);

    for (const [taskId, skeleton] of state.conversationCache.entries()) {
        state.indexingMetrics.totalTasks++;

        // Migration automatique des anciens formats
        if (state.indexingDecisionService.migrateLegacyIndexingState(skeleton)) {
            migratedCount++;
            await saveSkeletonToDisk(skeleton);
        }

        // Décision d'indexation avec nouvelle logique
        const decision = state.indexingDecisionService.shouldIndex(skeleton);

        // Sauvegarder si une migration legacy a eu lieu durant shouldIndex
        if (decision.requiresSave) {
            await saveSkeletonToDisk(skeleton);
            migratedCount++;
        }

        if (decision.shouldIndex) {
            state.qdrantIndexQueue.add(taskId);
            if (decision.action === 'retry') {
                retryCount++;
                state.indexingMetrics.retryTasks++;
            } else {
                indexCount++;
            }
        } else {
            skipCount++;
            state.indexingMetrics.skippedTasks++;
            console.log(`[SKIP] ${taskId}: ${decision.reason}`);

            if (skeleton.metadata.indexingState?.indexStatus === 'failed') {
                failedCount++;
                state.indexingMetrics.failedTasks++;
            }
        }
    }

    // Rapport de scan détaillé
    console.log(`📊 Scan terminé avec mécanisme d'idempotence:`);
    console.log(`   ✅ À indexer: ${indexCount} tâches`);
    console.log(`   🔄 À retenter: ${retryCount} tâches`);
    console.log(`   ⏭️  Skippées: ${skipCount} tâches (anti-fuite)`);
    console.log(`   ❌ Échecs permanents: ${failedCount} tâches`);
    console.log(`   🔄 Migrations legacy: ${migratedCount} tâches`);

    const totalToProcess = indexCount + retryCount;
    if (totalToProcess > 1000) {
        console.log(`⚠️  Queue importante détectée: ${totalToProcess} tâches à traiter`);
        console.log(`💡 Traitement progressif avec rate limiting intelligent (100 ops/min)`);
        console.log(`⏱️  Temps estimé: ${Math.ceil(totalToProcess / 100)} minutes`);
    }

    // Estimation de la bande passante économisée
    const estimatedSavings = skipCount * 50000;
    state.indexingMetrics.bandwidthSaved += estimatedSavings;
    console.log(`💰 Bande passante économisée: ~${Math.round(estimatedSavings / 1024 / 1024)}MB grâce aux skips`);
}

/**
 * Vérifie la cohérence entre les squelettes locaux et l'index Qdrant
 */
async function verifyQdrantConsistency(state: ServerState): Promise<void> {
    try {
        const now = Date.now();
        if (now - state.lastQdrantConsistencyCheck < ANTI_LEAK_CONFIG.CONSISTENCY_CHECK_INTERVAL) {
            console.log('⏳ Vérification Qdrant ignorée (dernière < 24h) - Protection anti-fuite');
            return;
        }

        console.log('🔍 Vérification de la cohérence Qdrant vs Squelettes...');

        const taskIndexer = new TaskIndexer();
        const currentHostId = getHostIdentifier();
        console.log(`🖥️  Machine actuelle: ${currentHostId}`);

        let localIndexedCount = 0;
        for (const [taskId, skeleton] of state.conversationCache.entries()) {
            if (skeleton.metadata?.qdrantIndexedAt) {
                localIndexedCount++;
            }
        }

        const qdrantCount = await taskIndexer.countPointsByHostOs(currentHostId);
        state.lastQdrantConsistencyCheck = now;

        console.log(`📊 Cohérence Qdrant:`);
        console.log(`   - Squelettes locaux indexés: ${localIndexedCount}`);
        console.log(`   - Points Qdrant (machine ${currentHostId}): ${qdrantCount}`);

        const discrepancy = Math.abs(localIndexedCount - qdrantCount);
        const threshold = Math.max(50, Math.floor(localIndexedCount * 0.25));

        if (discrepancy > threshold) {
            console.warn(`⚠️  Incohérence détectée: écart de ${discrepancy} entre squelettes et Qdrant`);
            console.log(`📊 Seuil de tolérance: ${threshold} (25% de ${localIndexedCount})`);
            console.log(`✨ Pas d'inquiétude: les tâches manquantes seront indexées par le scan automatique`);
        } else {
            console.log(`✅ Cohérence Qdrant-Squelettes validée (écart acceptable: ${discrepancy})`);
        }

    } catch (error) {
        console.error('❌ Erreur lors de la vérification de cohérence Qdrant:', error);
    }
}

/**
 * Démarre le processus d'indexation Qdrant en arrière-plan
 */
function startQdrantIndexingBackgroundProcess(state: ServerState): void {
    if (state.qdrantIndexInterval) {
        clearInterval(state.qdrantIndexInterval);
    }

    state.qdrantIndexInterval = setInterval(async () => {
        if (!state.isQdrantIndexingEnabled || state.qdrantIndexQueue.size === 0) {
            return;
        }

        const taskId = state.qdrantIndexQueue.values().next().value;
        if (taskId) {
            state.qdrantIndexQueue.delete(taskId);
            await indexTaskInQdrant(taskId, state);
        }
    }, ANTI_LEAK_CONFIG.MAX_BACKGROUND_INTERVAL);

    console.log('🔄 Service d\'indexation Qdrant en arrière-plan démarré');
}

/**
 * Indexe une tâche spécifique dans Qdrant
 */
async function indexTaskInQdrant(taskId: string, state: ServerState): Promise<void> {
    try {
        const skeleton = state.conversationCache.get(taskId);
        if (!skeleton) {
            console.warn(`[WARN] Skeleton for task ${taskId} not found in cache. Skipping indexing.`);
            return;
        }

        const decision = state.indexingDecisionService.shouldIndex(skeleton);

        if (decision.requiresSave) {
            await saveSkeletonToDisk(skeleton);
            console.log(`[MIGRATION] Task ${taskId}: Migration legacy sauvegardée`);
        }

        if (!decision.shouldIndex) {
            console.log(`[SKIP] Task ${taskId}: ${decision.reason} - Protection anti-fuite`);
            return;
        }

        console.log(`[INDEX] Task ${taskId}: ${decision.reason}`);

        const taskIndexer = new TaskIndexer();
        await taskIndexer.indexTask(taskId);

        state.indexingDecisionService.markIndexingSuccess(skeleton);
        await saveSkeletonToDisk(skeleton);

        state.qdrantIndexCache.set(taskId, Date.now());
        state.indexingMetrics.indexedTasks++;

        console.log(`[SUCCESS] Task ${taskId} successfully indexed in Qdrant.`);

    } catch (error: any) {
        if (error.message && error.message.includes('not found in any storage location')) {
            console.warn(`[WARN] Task ${taskId} is in cache but not on disk. Skipping indexing.`);
        } else {
            const skeleton = state.conversationCache.get(taskId);
            if (skeleton) {
                const isPermanentError = classifyIndexingError(error);
                state.indexingDecisionService.markIndexingFailure(skeleton, error.message, isPermanentError);
                await saveSkeletonToDisk(skeleton);

                state.indexingMetrics.failedTasks++;

                if (isPermanentError) {
                    console.error(`[PERMANENT_FAIL] Task ${taskId}: ${error.message} - Marqué pour skip définitif`);
                } else {
                    console.error(`[RETRY_FAIL] Task ${taskId}: ${error.message} - Programmé pour retry avec backoff`);
                }
            }

            console.error(`[ERROR] Failed to index task ${taskId} in Qdrant:`, error);
        }
    }
}

/**
 * Classifie les erreurs d'indexation
 */
function classifyIndexingError(error: any): boolean {
    const errorMessage = error.message ? error.message.toLowerCase() : '';

    const permanentErrors = [
        'file not found',
        'access denied',
        'permission denied',
        'invalid format',
        'corrupted data',
        'authentication failed',
        'quota exceeded permanently'
    ];

    const temporaryErrors = [
        'network error',
        'connection timeout',
        'rate limit',
        'service unavailable',
        'timeout',
        'econnreset',
        'enotfound'
    ];

    if (permanentErrors.some(perm => errorMessage.includes(perm))) {
        return true;
    }

    if (temporaryErrors.some(temp => errorMessage.includes(temp))) {
        return false;
    }

    return false;
}

/**
 * Sauvegarde un squelette sur le disque
 */
export async function saveSkeletonToDisk(skeleton: ConversationSkeleton): Promise<void> {
    try {
        const storageLocations = await RooStorageDetector.detectStorageLocations();
        if (storageLocations.length === 0) {
            throw new Error('Aucun emplacement de stockage Roo trouvé');
        }

        // ✅ FIX CRITIQUE: Utiliser tasks/.skeletons comme build-skeleton-cache.tool.ts
        const tasksDir = path.join(storageLocations[0], 'tasks');
        const skeletonsCacheDir = path.join(tasksDir, '.skeletons');
        await fs.mkdir(skeletonsCacheDir, { recursive: true });

        const filePath = path.join(skeletonsCacheDir, `${skeleton.taskId}.json`);
        await fs.writeFile(filePath, JSON.stringify(skeleton, null, 2), 'utf8');

        console.log(`[BACKGROUND-SAVE-DEBUG] ✅ Skeleton sauvegardé: ${filePath}`);
        console.log(`[BACKGROUND-SAVE-DEBUG] 🏷️ parentTaskId: ${skeleton.parentTaskId || 'undefined'}`);
    } catch (error: any) {
        console.error(`Erreur lors de la sauvegarde du squelette ${skeleton.taskId}:`, error);
    }
}