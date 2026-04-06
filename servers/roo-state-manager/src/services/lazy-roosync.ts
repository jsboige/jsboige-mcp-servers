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
 */
export async function getRooSyncService() {
    const mod = await _ensureLoaded();
    return mod.getRooSyncService();
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
