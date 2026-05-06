/**
 * #1110 FIX: Lazy facade for RooSyncService
 *
 * RooSyncService.ts imports 16+ service modules statically.
 * When 30+ roosync tool modules each statically import RooSyncService,
 * Node v24's ESM module evaluator hits a cross-module evaluation deadlock:
 * it tries to evaluate all 16 services multiple times from parallel import paths.
 *
 * This facade uses dynamic import() to defer RooSyncService loading until
 * the first tool call actually needs it. Module evaluation happens lazily,
 * breaking the deadlock.
 *
 * Usage: Replace `import { getRooSyncService } from '../../services/RooSyncService.js'`
 *        with `import { getRooSyncService } from '../../services/lazy-roosync.js'`
 */

// Re-export RooSyncServiceError synchronously (it's from types/errors.ts, lightweight)
export { RooSyncServiceError } from '../types/errors.js';

// Lazy-loaded module cache
let _loadedModule: typeof import('./RooSyncService.js') | null = null;
let _loadPromise: Promise<typeof import('./RooSyncService.js')> | null = null;

async function _ensureLoaded(): Promise<NonNullable<typeof import('./RooSyncService.js')>> {
    if (_loadedModule) return _loadedModule;
    if (!_loadPromise) {
        _loadPromise = import('./RooSyncService.js').then(mod => {
            _loadedModule = mod;
            return mod;
        });
    }
    return _loadPromise;
}

/**
 * Get the RooSyncService singleton (lazy-loaded).
 * First call triggers dynamic import of RooSyncService.ts and all its dependencies.
 * Subsequent calls return the cached instance.
 *
 * #2017: If the singleton init failed (e.g. GDrive not mounted), retries on each call.
 * This means RooSync recovers automatically once the shared path becomes available.
 */
export async function getRooSyncService() {
    const mod = await _ensureLoaded();
    try {
        return mod.getRooSyncService();
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        // Enhance with actionable guidance for the most common failure
        if (msg.includes('ROOSYNC_SHARED_PATH') || msg.includes("n'existe pas")) {
            throw new Error(
                `RooSync unavailable: shared path not accessible. ` +
                `If GDrive is still syncing, retry in a few seconds. ` +
                `Original error: ${msg}`
            );
        }
        throw error;
    }
}

/**
 * Lazy proxy interface matching RooSyncService static methods.
 * All methods are async because they trigger lazy module loading.
 *
 * Usage: `await RooSyncService.resetInstance()` / `await RooSyncService.getInstance()`
 */
export interface LazyRooSyncServiceStatic {
    resetInstance(): Promise<void>;
    getInstance(options?: { enabled?: boolean }): Promise<import('./RooSyncService.js').RooSyncService>;
}

export const RooSyncService: LazyRooSyncServiceStatic = {
    async resetInstance(): Promise<void> {
        const mod = await _ensureLoaded();
        mod.RooSyncService.resetInstance();
    },
    async getInstance(options?: { enabled?: boolean }) {
        const mod = await _ensureLoaded();
        return mod.RooSyncService.getInstance(options);
    },
};
