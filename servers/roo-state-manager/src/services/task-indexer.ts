import { promises as fs } from 'fs';
import * as path from 'path';
import { Schemas } from '@qdrant/js-client-rest';
import { getQdrantClient } from './qdrant.js';

// Import des nouveaux modules
import { validateVectorGlobal } from './task-indexer/EmbeddingValidator.js';
import { getHostIdentifier } from './task-indexer/ChunkExtractor.js';
import { QdrantHealthMonitor, logNetworkMetrics } from './task-indexer/QdrantHealthMonitor.js';
import {
    indexTask as indexTaskVector,
    resetCollection as resetCollectionVector,
    countPointsByHostOs as countPointsByHostOsVector,
    updateSkeletonIndexTimestamp,
    upsertPointsBatch,
    qdrantRateLimiter
} from './task-indexer/VectorIndexer.js';

type PointStruct = Schemas['PointStruct'];

// Réexport des fonctions pour compatibilité
export { getHostIdentifier };

/**
 * Indexe une seule tâche en créant des chunks granulaires, en générant des embeddings
 * sélectivement et en les stockant dans Qdrant.
 * @param taskId L'ID de la tâche à indexer.
 * @param taskPath Le chemin complet vers le répertoire de la tâche.
 */
export async function indexTask(taskId: string, taskPath: string): Promise<PointStruct[]> {
    return indexTaskVector(taskId, taskPath);
}

/**
 * Classe TaskIndexer pour l'architecture à 2 niveaux
 * Agit maintenant comme une façade vers les modules spécialisés
 */
export class TaskIndexer {
    private qdrantClient = getQdrantClient();
    private healthMonitor = new QdrantHealthMonitor();

    /**
     * Valide qu'un vecteur a la bonne dimension et ne contient pas de NaN/Infinity
     */
    private validateVector(vector: number[], expectedDim: number = 1536): void {
        validateVectorGlobal(vector, expectedDim);
    }

    /**
     * Vérifie la santé de la collection et log les métriques
     */
    private async checkCollectionHealth(): Promise<{
        status: string;
        points_count: number;
        segments_count: number;
        indexed_vectors_count: number;
        optimizer_status: string;
    }> {
        return this.healthMonitor.checkCollectionHealth();
    }

    /**
     * Insère des points avec batching intelligent et monitoring
     * @param points - Points à insérer
     * @param options - Options d'insertion
     */
    private async upsertPointsBatch(
        points: Array<{ id: string; vector: number[]; payload: any }>,
        options?: {
            batchSize?: number;
            waitOnLast?: boolean;
            maxRetries?: number;
        }
    ): Promise<void> {
        return upsertPointsBatch(points, options);
    }

    /**
     * Initialise le health check périodique
     */
    startHealthCheck(): void {
        this.healthMonitor.startHealthCheck();
    }

    /**
     * Arrête le health check périodique
     */
    stopHealthCheck(): void {
        this.healthMonitor.stopHealthCheck();
    }

    /**
     * Indexe une tâche à partir de son ID (trouve automatiquement le chemin)
     */
    async indexTask(taskId: string): Promise<PointStruct[]> {
        try {
            const { RooStorageDetector } = await import('../utils/roo-storage-detector.js');
            const locations = await RooStorageDetector.detectStorageLocations();

            for (const location of locations) {
                const taskPath = path.join(location, 'tasks', taskId);
                try {
                    await fs.access(taskPath);
                    const points = await indexTask(taskId, taskPath);

                    // FIX ARCHITECTURAL: Mettre à jour le squelette ICI, pas dans index.ts
                    await this.updateSkeletonIndexTimestamp(taskId, location);

                    return points;
                } catch {
                    // Tâche pas dans ce location, on continue
                }
            }

            throw new Error(`Task ${taskId} not found in any storage location`);
        } catch (error) {
            console.error(`Error indexing task ${taskId}:`, error);
            throw error;
        }
    }

    /**
     * FIX ARCHITECTURAL: Met à jour le timestamp d'indexation dans le squelette
     * Cette responsabilité devrait être ICI, pas dans index.ts
     */
    async updateSkeletonIndexTimestamp(taskId: string, storageLocation: string): Promise<void> {
        return updateSkeletonIndexTimestamp(taskId, storageLocation);
    }

    /**
     * Réinitialise complètement la collection Qdrant
     */
    async resetCollection(): Promise<void> {
        return resetCollectionVector();
    }

    /**
     * Vérifie l'état de la collection Qdrant
     */
    async getCollectionStatus(): Promise<{ exists: boolean; count: number }> {
        return this.healthMonitor.getCollectionStatus();
    }

    /**
     * Compte les points dans Qdrant pour un host_os spécifique
     */
    async countPointsByHostOs(hostOs: string): Promise<number> {
        return countPointsByHostOsVector(hostOs);
    }
}
