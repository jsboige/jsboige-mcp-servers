import { getQdrantClient } from '../qdrant.js';

const COLLECTION_NAME = process.env.QDRANT_COLLECTION_NAME || 'roo_tasks_semantic_index';

// 📊 MÉTRIQUES DE MONITORING BANDE PASSANTE
export interface NetworkMetrics {
    qdrantCalls: number;
    openaiCalls: number;
    cacheHits: number;
    cacheMisses: number;
    bytesTransferred: number;
    lastReset: number;
}

export const networkMetrics: NetworkMetrics = {
    qdrantCalls: 0,
    openaiCalls: 0,
    cacheHits: 0,
    cacheMisses: 0,
    bytesTransferred: 0,
    lastReset: Date.now()
};

// 📊 FONCTION DE LOGGING DES MÉTRIQUES
export function logNetworkMetrics(): void {
    const now = Date.now();
    const elapsedHours = (now - networkMetrics.lastReset) / (1000 * 60 * 60);

    console.log(`📊 [METRICS] Utilisation réseau (dernières ${elapsedHours.toFixed(1)}h):`);
    console.log(`   - Appels Qdrant: ${networkMetrics.qdrantCalls}`);
    console.log(`   - Appels OpenAI: ${networkMetrics.openaiCalls}`);
    console.log(`   - Cache hits: ${networkMetrics.cacheHits}`);
    console.log(`   - Cache misses: ${networkMetrics.cacheMisses}`);
    console.log(`   - Ratio cache: ${((networkMetrics.cacheHits / (networkMetrics.cacheHits + networkMetrics.cacheMisses || 1)) * 100).toFixed(1)}%`);
    console.log(`   - Bytes approximatifs: ${(networkMetrics.bytesTransferred / 1024 / 1024).toFixed(2)}MB`);
}

export class QdrantHealthMonitor {
    private qdrantClient = getQdrantClient();
    private healthCheckInterval?: NodeJS.Timeout;

    /**
     * Vérifie la santé de la collection et log les métriques
     */
    async checkCollectionHealth(): Promise<{
        status: string;
        points_count: number;
        segments_count: number;
        indexed_vectors_count: number;
        optimizer_status: string;
    }> {
        try {
            const collectionInfo = await this.qdrantClient.getCollection(COLLECTION_NAME);

            const metrics = {
                status: collectionInfo.status || 'unknown',
                points_count: collectionInfo.points_count || 0,
                segments_count: collectionInfo.segments_count || 0,
                indexed_vectors_count: collectionInfo.indexed_vectors_count || 0,
                optimizer_status: typeof collectionInfo.optimizer_status === 'string'
                    ? collectionInfo.optimizer_status
                    : (collectionInfo.optimizer_status as any)?.error || 'ok'
            };

            // Log si status != 'green'
            if (metrics.status !== 'green') {
                console.error('⚠️ Collection Qdrant unhealthy:', {
                    status: metrics.status,
                    points: metrics.points_count,
                    segments: metrics.segments_count,
                    indexed_vectors: metrics.indexed_vectors_count,
                    optimizer: metrics.optimizer_status
                });
            } else {
                console.log('✓ Collection health check OK:', {
                    points: metrics.points_count,
                    segments: metrics.segments_count,
                    indexed_vectors: metrics.indexed_vectors_count
                });
            }

            return metrics;

        } catch (error: any) {
            console.error('✗ Échec health check collection:', error.message);
            throw error;
        }
    }

    /**
     * Initialise le health check périodique
     */
    startHealthCheck(): void {
        if (this.healthCheckInterval) {
            return; // Déjà démarré
        }

        // Health check périodique toutes les 5 minutes
        this.healthCheckInterval = setInterval(async () => {
            try {
                await this.checkCollectionHealth();
            } catch (error) {
                console.error('Erreur health check périodique:', error);
            }
        }, 5 * 60 * 1000);

        console.log('✓ Health check périodique démarré (intervalle: 5 minutes)');
    }

    /**
     * Arrête le health check périodique
     */
    stopHealthCheck(): void {
        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
            this.healthCheckInterval = undefined;
            console.log('✓ Health check périodique arrêté');
        }
    }

    /**
     * Vérifie l'état de la collection Qdrant
     */
    async getCollectionStatus(): Promise<{ exists: boolean; count: number }> {
        try {
            const result = await this.qdrantClient.getCollections();
            const collectionExists = result.collections.some((collection) => collection.name === COLLECTION_NAME);

            if (collectionExists) {
                const info = await this.qdrantClient.getCollection(COLLECTION_NAME);
                return {
                    exists: true,
                    count: info.points_count || 0
                };
            } else {
                return { exists: false, count: 0 };
            }
        } catch (error) {
            console.error('Erreur lors de la vérification de l\'état de la collection:', error);
            throw error;
        }
    }
}