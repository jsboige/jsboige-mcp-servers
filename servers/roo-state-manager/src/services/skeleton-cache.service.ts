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
    private readonly CACHE_VALIDITY_MS = 30 * 60 * 1000; // 30 minutes (was 5min, increased for stability)

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
     * Add or update a skeleton in both RAM cache and disk
     */
    public async addOrUpdate(taskId: string, skeleton: ConversationSkeleton): Promise<void> {
        this.cache.set(taskId, skeleton);
        await this.saveSkeleton(taskId, skeleton);
    }

    /**
     * Save a single skeleton to disk with retry
     */
    public async saveSkeleton(taskId: string, skeleton?: ConversationSkeleton): Promise<boolean> {
        const toSave = skeleton || this.cache.get(taskId);
        if (!toSave) return false;

        try {
            const skeletonDir = await this.getSkeletonDir();
            if (!skeletonDir) return false;

            await fs.mkdir(skeletonDir, { recursive: true });
            const filePath = path.join(skeletonDir, `${taskId}.json`);
            const json = JSON.stringify(toSave, null, 2);

            for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                    await fs.writeFile(filePath, json);
                    // Post-write verification
                    const written = await fs.readFile(filePath, 'utf-8');
                    if (written.length === json.length) return true;
                    console.warn(`[SkeletonCacheService] Write verification failed for ${taskId}, attempt ${attempt}`);
                } catch (err) {
                    if (attempt === 3) throw err;
                    await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 100));
                }
            }
            return false;
        } catch (error) {
            console.error(`[SkeletonCacheService] Failed to save skeleton ${taskId}:`, error);
            return false;
        }
    }

    /**
     * Persist all cached skeletons to disk
     */
    public async saveAllToDisk(): Promise<{ saved: number; errors: number }> {
        let saved = 0;
        let errors = 0;
        for (const [taskId, skeleton] of this.cache.entries()) {
            const ok = await this.saveSkeleton(taskId, skeleton);
            if (ok) saved++;
            else errors++;
        }
        console.log(`[SkeletonCacheService] saveAllToDisk: ${saved} saved, ${errors} errors`);
        return { saved, errors };
    }

    /**
     * Get the skeleton cache size
     */
    public getCacheSize(): number {
        return this.cache.size;
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
     * FIX #623: Also creates missing skeletons for existing conversations
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
            // FIX #623: Correct path is storagePath/tasks/.skeletons
            const tasksDir = path.join(storagePath, 'tasks');
            const skeletonDir = path.join(tasksDir, SKELETON_CACHE_DIR_NAME);

            // Check if tasks directory exists
            if (!(await this.directoryExists(tasksDir))) {
                console.warn(`[SkeletonCacheService] Répertoire tasks introuvable: ${tasksDir}`);
                return;
            }

            this.cache.clear();
            let loadedCount = 0;

            // Load existing skeletons if directory exists
            if (await this.directoryExists(skeletonDir)) {
                const files = await fs.readdir(skeletonDir);
                const jsonFiles = files.filter(f => f.endsWith('.json'));

                console.log(`[SkeletonCacheService] Chargement de ${jsonFiles.length} skeletons existants...`);

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
            } else {
                console.log(`[SkeletonCacheService] Répertoire de squelettes inexistant, sera créé automatiquement`);
            }

            // FIX #623: Build missing skeletons for conversations that don't have one yet
            await this.buildMissingSkeletons(tasksDir, skeletonDir);
        } catch (error) {
            console.error('[SkeletonCacheService] Erreur lors du chargement des skeletons:', error);
        }
    }

    /**
     * Resolve the skeleton cache directory path
     * Note: Skeletons are stored in storagePath/tasks/.skeletons
     */
    private async getSkeletonDir(): Promise<string | null> {
        try {
            const storageLocations = await RooStorageDetector.detectStorageLocations();
            if (storageLocations.length === 0) return null;
            // FIX #623: Correct path is storagePath/tasks/.skeletons, not storagePath/.skeletons
            const tasksDir = path.join(storageLocations[0], 'tasks');
            return path.join(tasksDir, SKELETON_CACHE_DIR_NAME);
        } catch {
            return null;
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
     * FIX #623: Build skeletons for conversations that don't have one yet
     * This ensures that when ensureFreshCache() is called, all existing conversations
     * get their skeletons created automatically (not just loaded from disk).
     */
    private async buildMissingSkeletons(tasksDir: string, skeletonDir: string): Promise<void> {
        try {
            // Make sure skeleton directory exists
            await fs.mkdir(skeletonDir, { recursive: true });

            // List all conversations in tasks directory
            const conversationDirs = await fs.readdir(tasksDir, { withFileTypes: true });
            let builtCount = 0;
            let skippedCount = 0;

            for (const convDir of conversationDirs) {
                if (convDir.isDirectory() && convDir.name !== SKELETON_CACHE_DIR_NAME) {
                    const conversationId = convDir.name;
                    const skeletonPath = path.join(skeletonDir, `${conversationId}.json`);

                    // Check if skeleton already exists
                    try {
                        await fs.access(skeletonPath);
                        skippedCount++;
                        continue;
                    } catch {
                        // Skeleton doesn't exist, build it
                    }

                    try {
                        const taskPath = path.join(tasksDir, conversationId);
                        const skeleton = await RooStorageDetector.analyzeConversation(conversationId, taskPath);

                        if (skeleton && skeleton.taskId) {
                            await fs.writeFile(skeletonPath, JSON.stringify(skeleton, null, 2));
                            this.cache.set(skeleton.taskId, skeleton);
                            builtCount++;
                            console.log(`[SkeletonCacheService] Built missing skeleton for ${conversationId}`);
                        }
                    } catch (error) {
                        console.error(`[SkeletonCacheService] Failed to build skeleton for ${conversationId}:`, error);
                    }
                }
            }

            if (builtCount > 0) {
                console.log(`[SkeletonCacheService] Built ${builtCount} missing skeletons (${skippedCount} already existed)`);
            }
        } catch (error) {
            console.error('[SkeletonCacheService] Error building missing skeletons:', error);
        }
    }

    /**
     * Réinitialiser le service (pour tests)
     */
    public static reset(): void {
        SkeletonCacheService.instance = null;
    }
}