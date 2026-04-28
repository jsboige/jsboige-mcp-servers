import * as fs from 'fs/promises';
import * as path from 'path';
import { ConversationSkeleton } from '../types/conversation.js';
import { deleteTaskVectors } from '../services/task-indexer/VectorIndexer.js';
import { RooStorageDetector } from '../utils/roo-storage-detector.js';
import { GenericError, GenericErrorCode } from '../types/errors.js';

/**
 * Service pour gérer la suppression des tâches garbage du cache et de l'index
 * #1786: Tâches polluées par les exploded tasks - cleanup nécessaire
 */
export class GarbageCollector {
    /**
     * Supprime les tâches garbage détectées du cache et de Qdrant
     * @param taskIds Liste des IDs de tâches à supprimer
     * @param dryRun Mode simulation — ne supprime que du cache
     * @param workspaceFilter Filtre optionnel par workspace
     */
    static async cleanupGarbageTasks(
        taskIds: string[],
        dryRun: boolean = false,
        workspaceFilter?: string
    ): Promise<{
        deletedFromCache: number;
        deletedFromQdrant: number;
        errors: Array<{ taskId: string; error: string }>;
        preserved: string[]; // Tâches qui n'ont pas été supprimées (sanctuaire #1621)
    }> {
        const results = {
            deletedFromCache: 0,
            deletedFromQdrant: 0,
            errors: [],
            preserved: []
        };

        // Vérifier que le workspace est valide si un filtre est fourni
        if (workspaceFilter) {
            const storage = await RooStorageDetector.detectWorkspace(workspaceFilter);
            if (!storage) {
                throw new GenericError(
                    `Workspace "${workspaceFilter}" non trouvé`,
                    GenericErrorCode.NOT_FOUND,
                    { workspace: workspaceFilter }
                );
            }
        }

        // Filtrer les tâches par workspace si nécessaire
        let filteredTaskIds = taskIds;
        if (workspaceFilter) {
            const skeletons = await this.loadSkeletonsForTasks(taskIds, workspaceFilter);
            filteredTaskIds = skeletons.map(s => s.taskId);
            if (filteredTaskIds.length < taskIds.length) {
                console.warn(`⚠️ ${taskIds.length - filteredTaskIds.length} tâches trouvées dans un autre workspace`);
            }
        }

        // Traiter chaque tâche
        for (const taskId of filteredTaskIds) {
            try {
                // Vérifier si la tâche est sanctuarisée (sessions Claude Code)
                const isClaudeCodeSession = taskId.startsWith('session_') ||
                    taskId.includes('claude-code') ||
                    taskId.includes('claude_session');

                if (isClaudeCodeSession) {
                    console.log(`🛡️ Tâche sanctuarisée #1621: ${taskId} — PAS de suppression`);
                    results.preserved.push(taskId);
                    continue;
                }

                console.log(`🧹 Traitement tâche garbage: ${taskId} (dryRun=${dryRun})`);

                // 1. Supprimer du cache des squelettes
                const cacheDeleted = await this.deleteFromSkeletonCache(taskId, workspaceFilter);
                if (cacheDeleted) {
                    results.deletedFromCache++;
                }

                // 2. Supprimer de Qdrant (sauf en dry run)
                if (!dryRun) {
                    const qdrantResult = await deleteTaskVectors([taskId], false);
                    results.deletedFromQdrant += qdrantResult.deletedCount;
                }

                console.log(`✅ Tâche ${taskId} nettoyée (cache: ${cacheDeleted ? 'oui' : 'non'}, Qdrant: ${!dryRun ? 'oui' : 'simulation'})`);

            } catch (error) {
                console.error(`❌ Erreur lors du cleanup de ${taskId}:`, error);
                results.errors.push({
                    taskId,
                    error: error instanceof Error ? error.message : String(error)
                });
            }
        }

        return results;
    }

    /**
     * Supprime un squelette du cache local
     */
    private static async deleteFromSkeletonCache(taskId: string, workspaceFilter?: string): Promise<boolean> {
        try {
            // Trouver le chemin du squelette
            let skeletonPath: string;

            if (workspaceFilter) {
                const storage = await RooStorageDetector.detectWorkspace(workspaceFilter);
                if (!storage) {
                    throw new Error(`Workspace "${workspaceFilter}" non trouvé`);
                }
                skeletonPath = path.join(storage.skeletonsPath, `${taskId}.json`);
            } else {
                // Chercher dans tous les workspaces
                const allSkeletons = await RooStorageDetector.findAllSkeletons();
                const skeleton = allSkeletons.find(s => s.taskId === taskId);
                if (!skeleton) {
                    console.log(`⚠️ Squelette non trouvé pour ${taskId}`);
                    return false;
                }
                skeletonPath = skeleton.path;
            }

            // Vérifier si le fichier existe
            try {
                await fs.access(skeletonPath);
            } catch {
                console.log(`⚠️ Squelette non trouvé: ${skeletonPath}`);
                return false;
            }

            // Supprimer le fichier
            await fs.unlink(skeletonPath);
            console.log(`🗑️ Squelette supprimé: ${skeletonPath}`);
            return true;

        } catch (error) {
            console.error(`❌ Erreur suppression squelette ${taskId}:`, error);
            return false;
        }
    }

    /**
     * Charge les squelettes pour des tâches spécifiques dans un workspace
     */
    private static async loadSkeletonsForTasks(
        taskIds: string[],
        workspace: string
    ): Promise<{ taskId:; path: string }[]> {
        const skeletons: { taskId: string; path: string }[] = [];

        try {
            const storage = await RooStorageDetector.detectWorkspace(workspace);
            if (!storage) {
                throw new Error(`Workspace "${workspace}" non trouvé`);
            }

            const skeletonsDir = storage.skeletonsPath;

            // Lister tous les squelettes dans le workspace
            const files = await fs.readdir(skeletonsDir);

            for (const file of files) {
                if (file.endsWith('.json')) {
                    const taskId = file.slice(0, -5); // Enlever .json
                    if (taskIds.includes(taskId)) {
                        const skeletonPath = path.join(skeletonsDir, file);
                        skeletons.push({ taskId, path: skeletonPath });
                    }
                }
            }
        } catch (error) {
            console.error(`❌ Erreur chargement squelettes pour workspace ${workspace}:`, error);
        }

        return skeletons;
    }

    /**
     * Valide que les tâches candidates sont bien des tâches garbage
     * (verification supplémentaire avant suppression)
     */
    static async validateGarbageTasks(
        taskIds: string[],
        conversationCache: Map<string, ConversationSkeleton>,
        options: {
            min_size_kb?: number;
            error_threshold_percent?: number;
            assistant_output_threshold_percent?: number;
        } = {}
    ): Promise<{
        valid: string[];
        invalid: Array<{ taskId: string; reason: string }>;
    }> {
        const valid: string[] = [];
        const invalid: Array<{ taskId: string; reason: string }> = [];

        const {
            min_size_kb = 100,
            error_threshold_percent = 80,
            assistant_output_threshold_percent = 5
        } = options;

        for (const taskId of taskIds) {
            const skeleton = conversationCache.get(taskId);
            if (!skeleton) {
                invalid.push({
                    taskId,
                    reason: 'Squelette non trouvé dans le cache'
                });
                continue;
            }

            // Vérifier la taille
            const sizeKB = skeleton.metadata?.totalSize ?
                Number(skeleton.metadata.totalSize) / 1024 : 0;
            if (sizeKB < min_size_kb) {
                invalid.push({
                    taskId,
                    reason: `Taille insuffisante: ${sizeKB.toFixed(2)}KB < ${min_size_kb}KB`
                });
                continue;
            }

            // Analyser le contenu
            let errorCount = 0;
            let assistantOutputCount = 0;
            let totalMessages = 0;

            const scanMessages = (messages: any[]) => {
                for (const msg of messages) {
                    totalMessages++;

                    if (msg.role === 'user' && msg.content && Array.isArray(msg.content)) {
                        for (const content of msg.content) {
                            if (content.type === 'text') {
                                const errorPatterns = [
                                    /502\s+Bad\s+Gateway/i,
                                    /timeout/i,
                                    /context\s+overflow/i,
                                    /retry/i,
                                    /MCP\s+error/i,
                                    /too_many_tools_warning/i
                                ];

                                for (const pattern of errorPatterns) {
                                    if (pattern.test(content.text)) {
                                        errorCount++;
                                        break;
                                    }
                                }
                            }
                        }
                    }

                    if (msg.role === 'assistant' && msg.content && Array.isArray(msg.content)) {
                        for (const content of msg.content) {
                            if (content.type === 'text' && content.text?.trim().length > 0) {
                                assistantOutputCount++;
                            }
                        }
                    }

                    if (msg.messages) {
                        scanMessages(msg.messages);
                    }
                }
            };

            scanMessages(skeleton.messages || []);

            const errorRatio = totalMessages > 0 ? (errorCount / totalMessages) * 100 : 0;
            const assistantOutputRatio = totalMessages > 0 ?
                (assistantOutputCount / totalMessages) * 100 : 0;

            // Vérifier les critères garbage
            if (errorRatio >= error_threshold_percent &&
                assistantOutputRatio < assistant_output_threshold_percent) {
                valid.push(taskId);
            } else {
                invalid.push({
                    taskId,
                    reason: `Critères non remplis: ${errorRatio.toFixed(1)}% erreurs (${error_threshold_percent}% requis), ${assistantOutputRatio.toFixed(1)}% assistant (${assistant_output_threshold_percent}% min)`
                });
            }
        }

        return { valid, invalid };
    }
}