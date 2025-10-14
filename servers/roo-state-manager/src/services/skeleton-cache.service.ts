/**
 * Service de gestion centralisée du cache de squelettes de conversations
 * Permet un accès global au cache pour les outils externalisés
 */

import { ConversationSkeleton } from '../types/conversation.js';
import { RooStorageDetector } from '../utils/roo-storage-detector.js';
import path from 'path';
import { promises as fs } from 'fs';

const SKELETON_CACHE_DIR_NAME = '.skeletons';

/**
 * Service singleton pour gérer le cache des squelettes de conversations
 */
export class SkeletonCacheService {
    private static instance: SkeletonCacheService | null = null;
    private cache: Map<string, ConversationSkeleton> = new Map();
    private lastRefreshTime: number = 0;
    private readonly CACHE_VALIDITY_MS = 5 * 60 * 1000; // 5 minutes

    private constructor() {
        // Constructor privé pour pattern singleton
    }

    /**
     * Obtenir l'instance unique du service
     */
    public static getInstance(): SkeletonCacheService {
        if (!SkeletonCacheService.instance) {
            SkeletonCacheService.instance = new SkeletonCacheService();
        }
        return SkeletonCacheService.instance;
    }

    /**
     * Obtenir le cache de conversations
     * Garantit que le cache est frais avant de le retourner
     */
    public async getCache(): Promise<Map<string, ConversationSkeleton>> {
        await this.ensureFreshCache();
        return this.cache;
    }

    /**
     * Obtenir un skeleton spécifique par taskId
     */
    public async getSkeleton(taskId: string): Promise<ConversationSkeleton | undefined> {
        await this.ensureFreshCache();
        return this.cache.get(taskId);
    }

    /**
     * Vérifier si le cache contient une tâche
     */
    public async has(taskId: string): Promise<boolean> {
        await this.ensureFreshCache();
        return this.cache.has(taskId);
    }

    /**
     * Obtenir tous les skeletons sous forme de tableau
     */
    public async getAllSkeletons(): Promise<ConversationSkeleton[]> {
        await this.ensureFreshCache();
        return Array.from(this.cache.values());
    }

    /**
     * Forcer le rechargement complet du cache
     */
    public async forceRefresh(): Promise<void> {
        console.log('[SkeletonCacheService] Force refresh demandé...');
        await this.loadSkeletonsFromDisk();
        this.lastRefreshTime = Date.now();
    }

    /**
     * S'assurer que le cache est frais (rafraîchir si nécessaire)
     */
    private async ensureFreshCache(): Promise<void> {
        const now = Date.now();
        const cacheAge = now - this.lastRefreshTime;

        if (cacheAge > this.CACHE_VALIDITY_MS || this.cache.size === 0) {
            console.log(`[SkeletonCacheService] Cache obsolète (âge: ${Math.round(cacheAge / 1000)}s), rafraîchissement...`);
            await this.loadSkeletonsFromDisk();
            this.lastRefreshTime = now;
        }
    }

    /**
     * Charger les skeletons depuis le disque
     */
    private async loadSkeletonsFromDisk(): Promise<void> {
        try {
            const storageLocations = await RooStorageDetector.detectStorageLocations();
            
            if (storageLocations.length === 0) {
                console.warn('[SkeletonCacheService] Aucun storage Roo détecté');
                return;
            }

            // Utiliser le premier emplacement de stockage détecté
            const storagePath = storageLocations[0];
            const skeletonDir = path.join(storagePath, SKELETON_CACHE_DIR_NAME);
            
            if (!(await this.directoryExists(skeletonDir))) {
                console.warn(`[SkeletonCacheService] Répertoire de cache introuvable: ${skeletonDir}`);
                return;
            }

            const files = await fs.readdir(skeletonDir);
            const jsonFiles = files.filter(f => f.endsWith('.json'));

            console.log(`[SkeletonCacheService] Chargement de ${jsonFiles.length} skeletons...`);

            this.cache.clear();
            let loadedCount = 0;

            for (const file of jsonFiles) {
                try {
                    const filePath = path.join(skeletonDir, file);
                    const content = await fs.readFile(filePath, 'utf-8');
                    const skeleton: ConversationSkeleton = JSON.parse(content);
                    
                    if (skeleton.taskId) {
                        this.cache.set(skeleton.taskId, skeleton);
                        loadedCount++;
                    }
                } catch (err) {
                    console.error(`[SkeletonCacheService] Erreur lors du chargement de ${file}:`, err);
                }
            }

            console.log(`[SkeletonCacheService] ${loadedCount}/${jsonFiles.length} skeletons chargés avec succès`);
        } catch (error) {
            console.error('[SkeletonCacheService] Erreur lors du chargement des skeletons:', error);
        }
    }

    /**
     * Vérifier si un répertoire existe
     */
    private async directoryExists(dirPath: string): Promise<boolean> {
        try {
            const stats = await fs.stat(dirPath);
            return stats.isDirectory();
        } catch {
            return false;
        }
    }

    /**
     * Réinitialiser le service (pour tests)
     */
    public static reset(): void {
        SkeletonCacheService.instance = null;
    }
}