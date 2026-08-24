/**
 * Service de gestion centralisée du cache de squelettes de conversations
 * Permet un accès global au cache pour les outils externalisés
 *
 * Issue #1244 - Couche 1.1: Multi-tier cache
 *  Tier 1 (Roo local)        — toujours actif (existant)
 *  Tier 2 (Claude local)     — opt-in via configure({ enableClaudeTier: true })
 *  Tier 3 (Archives GDrive)  — opt-in via configure({ enableArchiveTier: true })
 *
 * L'opt-in est volontaire pour deux raisons:
 *  1. Eviter de polluer les tests existants qui ne mockent que `RooStorageDetector` + `fs`.
 *     `ClaudeStorageDetector` utilise `fs/promises` (non mocké), `TaskArchiver` necessite
 *     `ROOSYNC_SHARED_PATH` set. Sans opt-in, les tests existants resteraient verts.
 *  2. Permettre au code de production (index.ts startup) d'activer explicitement les tiers
 *     selon la disponibilite des dependances (ex: archives uniquement si GDrive monte).
 *
 * Priorite de merge en cas de collision de taskId: local (Tier 1/2) > archive (Tier 3).
 */

import { ConversationSkeleton } from '../types/conversation.js';
import { RooStorageDetector } from '../utils/roo-storage-detector.js';
import path from 'path';
import { promises as fs } from 'fs';

const SKELETON_CACHE_DIR_NAME = '.skeletons';

/**
 * Configuration optionnelle pour activer les tiers cache supplementaires.
 * Defaut: tous desactives (Tier 1 Roo local uniquement, comportement historique).
 */
export interface SkeletonCacheServiceConfig {
    /** Activer le chargement des sessions Claude Code locales (~/.claude/projects/) */
    enableClaudeTier?: boolean;
    /** Activer le chargement des archives cross-machine depuis GDrive (.shared-state/task-archive/) */
    enableArchiveTier?: boolean;
}

/**
 * Service singleton pour gérer le cache des squelettes de conversations
 */
export class SkeletonCacheService {
    private static instance: SkeletonCacheService | null = null;
    private static config: SkeletonCacheServiceConfig = {};
    private cache: Map<string, ConversationSkeleton> = new Map();
    private lastRefreshTime: number = 0;
    /** Tier 3 cold-start: in-progress full-load promise. Reused by concurrent callers
     *  so a boot pre-warm and a first tool call never launch two full Tier 1/2/3 loads
     *  at once. */
    private loadPromise: Promise<void> | null = null;
    private readonly CACHE_VALIDITY_MS = 30 * 60 * 1000; // 30 minutes (was 5min, increased for stability)

    private constructor() {
        // Constructor privé pour pattern singleton
    }

    /**
     * Configurer les tiers cache optionnels (Claude local, archives GDrive).
     *
     * A appeler depuis index.ts au demarrage du serveur, AVANT toute utilisation
     * du cache. Sans appel, seul le Tier 1 (Roo local) est actif - comportement
     * historique preserve pour la backward compatibility.
     *
     * Idempotent: les appels successifs fusionnent les flags (les anciens flags
     * sont preserves sauf s'ils sont explicitement override).
     */
    public static configure(config: SkeletonCacheServiceConfig): void {
        SkeletonCacheService.config = { ...SkeletonCacheService.config, ...config };
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
     * Add or update a skeleton in both RAM cache and disk.
     *
     * #2426 Phase B: also fires a best-effort dual-write to the unified Postgres
     * store when UNIFIED_STORE_DUAL_WRITE=1 is set. The Postgres write is
     * fire-and-forget (non-blocking) — failure is absorbed by the writer's
     * circuit-breaker and never blocks the local cache path.
     */
    public async addOrUpdate(taskId: string, skeleton: ConversationSkeleton): Promise<void> {
        this.cache.set(taskId, skeleton);
        await this.saveSkeleton(taskId, skeleton);

        // #2426 Phase B — dual-write to Postgres (fire-and-forget, env-gated)
        this.dualWriteToStore(taskId, skeleton).catch(() => {
          // Intentionally swallowed — writer handles its own errors + circuit breaker
        });
    }

    /**
     * #2426 Phase B: best-effort dual-write to the unified Postgres store.
     * Delegates to the shared dual-write helper (#692) so the skeleton→ConversationRow
     * mapping has a single source of truth, shared with the live production call sites.
     * Note: this method is only reachable via addOrUpdate(), which currently has no
     * production callers — see jsboige/jsboige-mcp-servers#692. The live dual-write fires
     * from the production paths that import dualWriteConversationToStore directly.
     */
    private async dualWriteToStore(taskId: string, skeleton: ConversationSkeleton): Promise<void> {
      const { dualWriteConversationToStore } = await import('./unified-store/dual-write.js');
      await dualWriteConversationToStore(taskId, skeleton);
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
            // Tier 3 cold-start: reuse an in-progress load instead of starting a duplicate.
            // Without this, a boot pre-warm (warmCache) racing a first tool call would
            // launch two full Tier 1/2/3 loads concurrently — double GDrive scan and
            // double cold-start latency. Only the first caller starts the load; the
            // rest await the same promise.
            if (this.loadPromise) {
                await this.loadPromise;
                return;
            }
            console.log(`[SkeletonCacheService] Cache obsolète (âge: ${Math.round(cacheAge / 1000)}s), rafraîchissement...`);
            this.loadPromise = this.loadSkeletonsFromDisk().finally(() => {
                this.loadPromise = null;
            });
            await this.loadPromise;
            // Only mark the cache fresh if the load actually populated it.
            // loadSkeletonsFromDisk swallows internal errors (returns on no-storage /
            // no-tasks-dir, catches per-file + top-level) — it resolves even when the
            // cache ends up empty (e.g. GDrive down at boot → Tier 3 empty). Marking an
            // empty cache "fresh" for CACHE_VALIDITY_MS would silently serve no archives
            // for 30 min; instead, leave lastRefreshTime untouched so the next call retries
            // (the cache.size === 0 entry condition above keeps retriggering until it loads).
            if (this.cache.size > 0) {
                this.lastRefreshTime = now;
            }
        }
    }

    /**
     * Tier 3 cold-start: pre-warm the full cache (Tier 1 Roo + Tier 2 Claude + Tier 3
     * GDrive archives) in background at boot. Fire-and-forget from the caller's
     * perspective: the first tool call finds it warmed, or awaits the in-progress load
     * via ensureFreshCache (guarded against duplicates).
     */
    public async warmCache(): Promise<void> {
        await this.ensureFreshCache();
    }

    /**
     * Tier 3 cold-start (Hybride design): await an in-progress (or freshly triggered)
     * cache refresh with a bounded budget. Returns true if the cache is fresh within
     * the budget; false if the budget elapsed (the caller should then degrade
     * gracefully — e.g. return local results + an "archives loading" notice). Never
     * throws.
     *
     * The boot pre-warm (background-services.warmCache) usually completes before any
     * tool call, so this resolves true fast. Under slow GDrive it returns false instead
     * of hanging past the budget — the conversation_browser hard timeout never fires,
     * and the caller's graceful-degradation arm serves local results. This converts the
     * old block-then-reject (visible 30s error / invisible hang) into a non-failing,
     * eventually-consistent response.
     */
    public async awaitFreshnessWithBudget(timeoutMs: number): Promise<boolean> {
        try {
            const now = Date.now();
            if ((now - this.lastRefreshTime) <= this.CACHE_VALIDITY_MS && this.cache.size > 0) {
                return true;
            }
            // ensureFreshCache dedups via loadPromise (boot pre-warm reuse). Race it
            // against the budget; the underlying load keeps running in the background
            // either way, warming the cache for the next call.
            await Promise.race([
                this.ensureFreshCache(),
                new Promise<void>(resolve => setTimeout(resolve, timeoutMs)),
            ]);
            const ageAfter = Date.now() - this.lastRefreshTime;
            return ageAfter <= this.CACHE_VALIDITY_MS && this.cache.size > 0;
        } catch {
            return false;
        }
    }

    /**
     * #3255 — Age of the last completed cache refresh, for tier3_status reporting
     * in conversation_browser list responses. Null when no refresh ever completed
     * (cold boot, before the pre-warm lands).
     */
    public getCacheAgeMs(): number | null {
        return this.lastRefreshTime > 0 ? Date.now() - this.lastRefreshTime : null;
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
                        let content = await fs.readFile(filePath, 'utf-8');
                        // FIX #1123: Strip UTF-8 BOM if present (Windows editors can add it)
                        if (content.charCodeAt(0) === 0xFEFF) {
                            content = content.slice(1);
                        }
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

            // #1244 Couche 1.1 — Tiers optionnels (opt-in via configure())
            // L'opt-in evite de polluer les tests existants qui ne mockent que Tier 1.
            // En production, index.ts active explicitement les tiers selon la dispo
            // des dependances (ROOSYNC_SHARED_PATH pour archives, etc).
            if (SkeletonCacheService.config.enableClaudeTier) {
                await this.loadClaudeSessionsFromDisk();
            }
            if (SkeletonCacheService.config.enableArchiveTier) {
                await this.loadArchivedSkeletonsFromGDrive();
            }
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
     * #1244 Couche 1.1 — Tier 2: Charger les sessions Claude Code locales.
     *
     * Lit `~/.claude/projects/<project>/` via `ClaudeStorageDetector`, construit
     * un squelette par projet (un seul taskId `claude-<basename(projectPath)>`),
     * et l'insere dans le cache. Les collisions de taskId sont resolues en
     * faveur du cache existant (Tier 1 a deja la priorite — local Roo > local Claude).
     *
     * Pattern de reference: `background-services.ts:loadClaudeCodeSessions()`.
     * Marque chaque squelette avec `metadata.source = 'claude-code'` et
     * `metadata.dataSource = 'claude'` pour permettre le filtrage downstream.
     *
     * No-op silencieux si le detecteur Claude echoue (non-bloquant).
     */
    private async loadClaudeSessionsFromDisk(): Promise<void> {
        try {
            const { ClaudeStorageDetector } = await import('../utils/claude-storage-detector.js');
            const locations = await ClaudeStorageDetector.detectStorageLocations();

            if (locations.length === 0) {
                console.log('[SkeletonCacheService] Tier 2 (Claude): aucun repertoire de projets trouve');
                return;
            }

            let loaded = 0;
            for (const location of locations) {
                try {
                    const taskId = `claude-${path.basename(location.projectPath)}`;

                    // Tier 1 (Roo local) a la priorite — ne pas ecraser
                    if (this.cache.has(taskId)) continue;

                    const skeleton = await ClaudeStorageDetector.analyzeConversation(
                        taskId, location.projectPath
                    );
                    if (skeleton && (skeleton.sequence ?? []).length > 0) {
                        if (!skeleton.metadata) skeleton.metadata = {} as any;
                        skeleton.metadata.source = 'claude-code';
                        skeleton.metadata.dataSource = 'claude';
                        this.cache.set(taskId, skeleton);
                        loaded++;
                    }
                } catch (error) {
                    console.warn(`[SkeletonCacheService] Tier 2 (Claude): echec ${location.projectPath}:`, error);
                }
            }

            console.log(`[SkeletonCacheService] Tier 2 (Claude): ${loaded} sessions chargees depuis ${locations.length} projets`);
        } catch (error) {
            console.warn('[SkeletonCacheService] Tier 2 (Claude): chargement non-bloquant a echoue:', error);
        }
    }

    /**
     * #1244 Couche 1.1 — Tier 3: Charger les archives cross-machine depuis GDrive.
     *
     * Lit `.shared-state/task-archive/<machineId>/<taskId>.json.gz` via
     * `TaskArchiver`, convertit chaque archive en `ConversationSkeleton` via
     * `archiveToSkeleton()`, et merge dans le cache. Les collisions sont
     * resolues en faveur des tiers chauds (local Roo/Claude > archive remote).
     *
     * Necessite `ROOSYNC_SHARED_PATH` (sinon `getSharedStatePath()` throw —
     * capture par le try/catch global, no-op silencieux).
     *
     * **Attention scale:** Peut charger des milliers d'archives (flotte typique:
     * 11k+). Activable uniquement en production via `configure({ enableArchiveTier: true })`.
     *
     * #1244 (perf fix): Parallelise les reads avec concurrence bornee (20) et
     * appelle `readArchivedTaskFromPath` directement (plus de probe O(M) par
     * taskId). Reduit le cold-start de 30s+ → ~3-5s pour 11k archives.
     */
    private async loadArchivedSkeletonsFromGDrive(): Promise<void> {
        try {
            const { TaskArchiver } = await import('./task-archiver/index.js');
            const { archiveToSkeleton } = await import('./archive-skeleton-builder.js');

            // Phase 1: Liste tous les fichiers d'archive avec leur chemin direct.
            // Un seul readdir par machine-dir (interne a listArchivedTaskFiles).
            const allFiles = await TaskArchiver.listArchivedTaskFiles();

            if (allFiles.length === 0) {
                console.log('[SkeletonCacheService] Tier 3 (archives): aucune archive trouvee');
                return;
            }

            // Phase 2: Construire la work queue en evitant les collisions connues
            type WorkItem = { taskId: string; filePath: string };
            const workQueue: WorkItem[] = [];
            for (const item of allFiles) {
                if (!this.cache.has(item.taskId)) {
                    workQueue.push({ taskId: item.taskId, filePath: item.filePath });
                }
            }
            const skippedCollision = allFiles.length - workQueue.length;

            // Phase 3: Lire avec concurrence bornee (20 parallel)
            // Batching evite de saturer I/O et le thread pool libuv.
            const CONCURRENCY = 20;
            let loaded = 0;
            let failed = 0;

            const processItem = async (item: WorkItem): Promise<void> => {
                try {
                    const archive = await TaskArchiver.readArchivedTaskFromPath(item.filePath);
                    if (!archive) {
                        failed++;
                        return;
                    }
                    const skeleton = archiveToSkeleton(archive);
                    if (!skeleton.metadata) skeleton.metadata = {} as any;
                    skeleton.metadata.dataSource = 'gdrive-archive';
                    // Re-verifier la collision (race safety avec Tier 1/2 charges en parallele)
                    if (!this.cache.has(skeleton.taskId)) {
                        this.cache.set(skeleton.taskId, skeleton);
                        loaded++;
                    }
                } catch (error) {
                    failed++;
                    if (failed <= 3) {
                        console.warn(`[SkeletonCacheService] Tier 3 (archives): echec lecture ${item.taskId}:`, error);
                    }
                }
            };

            for (let i = 0; i < workQueue.length; i += CONCURRENCY) {
                const batch = workQueue.slice(i, i + CONCURRENCY);
                await Promise.all(batch.map(processItem));
            }

            console.log(
                `[SkeletonCacheService] Tier 3 (archives): ${loaded} chargees, ` +
                `${skippedCollision} collisions ignorees (local prioritaire), ${failed} echecs sur ${allFiles.length} total`
            );
        } catch (error) {
            console.warn('[SkeletonCacheService] Tier 3 (archives): chargement non-bloquant a echoue:', error);
        }
    }

    /**
     * #1747 sub-issue B: Return per-tier skeleton counts for health-check.
     * Classifies cache entries by their metadata.dataSource tag:
     *   - undefined/default → Tier 1 (Roo local)
     *   - 'claude'          → Tier 2 (Claude local)
     *   - 'gdrive-archive'  → Tier 3 (GDrive archives)
     */
    // #2766 S2+ (P2): health is a fast liveness probe — it must NOT trigger a full
    // cache refresh. ensureFreshCache() → loadSkeletonsFromDisk() → buildMissingSkeletons()
    // can take minutes on a host with many conversations, defeating health's purpose
    // and risking MCP-transport timeout. Instead, snapshot the current in-memory cache
    // instantly and expose cacheAgeMs/stale so the consumer knows the freshness.
    // #2434's staleness concern is addressed transparently (consumer sees the age)
    // without blocking. Normal read paths (getCache/getSkeleton/etc.) keep the cache
    // warm via ensureFreshCache(); health only observes.
    //
    // #2963: When lastRefreshTime is 0 (cache never initialized), the previous logic
    // computed `Date.now() - 0` ≈ 1.78e12 ms (~56.6 years), which was then rendered
    // as a plausible "cold cache" duration. This is the systemic "missing data as
    // measured zero" pattern: an absent measurement is rendered as a measurement.
    // Now `cacheAgeMs` is `null` when the cache has never been refreshed, and `stale`
    // is unconditionally true so consumers still treat it as cold.
    public async getCacheTierStats(): Promise<{
        tier1_roo: number;
        tier2_claude: number;
        tier3_archives: number;
        total: number;
        config: { enableClaudeTier: boolean; enableArchiveTier: boolean };
        cacheAgeMs: number | null;
        stale: boolean;
    }> {
        const cacheAgeMs = this.lastRefreshTime === 0 ? null : Date.now() - this.lastRefreshTime;
        const stale = cacheAgeMs === null ? true : cacheAgeMs > this.CACHE_VALIDITY_MS;

        let tier1 = 0;
        let tier2 = 0;
        let tier3 = 0;

        for (const skeleton of this.cache.values()) {
            const source = (skeleton as any).metadata?.dataSource;
            if (source === 'claude') {
                tier2++;
            } else if (source === 'gdrive-archive') {
                tier3++;
            } else {
                tier1++;
            }
        }

        return {
            tier1_roo: tier1,
            tier2_claude: tier2,
            tier3_archives: tier3,
            total: this.cache.size,
            config: {
                enableClaudeTier: !!SkeletonCacheService.config.enableClaudeTier,
                enableArchiveTier: !!SkeletonCacheService.config.enableArchiveTier,
            },
            cacheAgeMs,
            stale,
        };
    }

    /**
     * Réinitialiser le service (pour tests)
     */
    public static reset(): void {
        SkeletonCacheService.instance = null;
        SkeletonCacheService.config = {};
    }
}