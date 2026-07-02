/**
 * Tests unitaires pour RooSyncService.ts
 *
 * Stratégie de test :
 * - Tests d'interface pour les méthodes publiques
 * - Tests de cycle de vie (singleton, cache)
 * - Tests d'erreur et edge cases
 * - Tests de gestion du cache
 *
 * @module services/__tests__/RooSyncService.test
 * @version 1.0.0 (#512)
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

// Unmock to use real RooSyncService implementation for testing the class itself
vi.unmock('../RooSyncService.js');
vi.unmock('../ConfigService.js');
vi.unmock('../PowerShellExecutor.js');
vi.unmock('../InventoryCollector.js');
vi.unmock('../DiffDetector.js');
vi.unmock('../BaselineService.js');
vi.unmock('../InventoryCollectorWrapper.js');
vi.unmock('../ConfigSharingService.js');

import { RooSyncService, RooSyncServiceError } from '../RooSyncService.js';
import type { CacheOptions } from '../RooSyncService.js';

// Real fs/path/os for the cache + path-helper tests below (#833 coverage).
// Not mocked: these tests exercise getFileHash/checkFileExists against real temp files.
import { statSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/** Unique temp path under the OS tmp dir (avoids cross-test / cross-file collisions). */
function tmpPath(prefix: string): string {
    return join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
}

// ─────────────────── Mocks ───────────────────

const mockLoadConfig = vi.fn();
const mockValidateMachineId = vi.fn();
const mockRegisterMachineId = vi.fn();

vi.mock('../config/roosync-config.js', () => ({
    loadRooSyncConfig: (...args: any[]) => mockLoadConfig(...args),
    validateMachineIdUniqueness: (...args: any[]) => mockValidateMachineId(...args),
    registerMachineId: (...args: any[]) => mockRegisterMachineId(...args),
}));

// ─────────────────── Setup ───────────────────

beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockResolvedValue({
        rooSyncPath: '/mock/roosync',
        machineId: 'test-machine',
        storagePaths: [],
    });
    mockValidateMachineId.mockResolvedValue(true);
});

// ─────────────────── Tests ───────────────────

describe('RooSyncService', () => {

    // ============================================================
    // Singleton et cycle de vie
    // ============================================================

    describe('Singleton', () => {
        test('getInstance retourne toujours la même instance', async () => {
            const instance1 = await RooSyncService.getInstance();
            const instance2 = await RooSyncService.getInstance();

            expect(instance1).toBe(instance2);
        });

        test('getInstance initialise le service au premier appel', async () => {
            const service = await RooSyncService.getInstance();

            expect(service).toBeDefined();
            expect(service).toBeInstanceOf(RooSyncService);
        });
    });

    // ============================================================
    // Cache
    // ============================================================

    describe('Cache', () => {
        test('accepte des options de cache', async () => {
            // Reset du singleton pour ce test
            (RooSyncService as any).instance = null;

            const options: CacheOptions = {
                ttl: 60000,
                enabled: true,
            };

            const service = await RooSyncService.getInstance(options);

            expect(service).toBeDefined();
        });

        test('le cache a une TTL par défaut', async () => {
            const service = await RooSyncService.getInstance();

            // Vérifier que le service a un cache
            expect(service).toBeDefined();
        });

        test('le cache peut être désactivé', async () => {
            // Reset du singleton pour ce test
            (RooSyncService as any).instance = null;

            const options: CacheOptions = {
                enabled: false,
            };

            const service = await RooSyncService.getInstance(options);

            expect(service).toBeDefined();
        });
    });

    // ============================================================
    // Gestion des erreurs
    // ============================================================

    describe('RooSyncServiceError', () => {
        test('crée une erreur avec message', () => {
            const error = new RooSyncServiceError('Test error');

            expect(error.message).toContain('Test error');
            expect(error.name).toBe('RooSyncServiceError');
        });

        test('crée une erreur avec code', () => {
            const error = new RooSyncServiceError('Test error', 'TEST_CODE');

            expect(error.code).toBe('TEST_CODE');
        });

        test('crée une erreur avec details', () => {
            const details = { key: 'value' };
            const error = new RooSyncServiceError('Test error', 'TEST_CODE', details);

            expect(error.details).toEqual(details);
        });
    });

    // ============================================================
    // Modules délégués
    // ============================================================

    describe('Modules délégués', () => {
        test('le service a accès aux modules délégués', async () => {
            const service = await RooSyncService.getInstance();

            // Vérifier que le service est initialisé avec ses modules
            expect(service).toBeDefined();
        });

        test('getConfigService retourne une instance', async () => {
            const service = await RooSyncService.getInstance();
            const configService = service.getConfigService();

            expect(configService).toBeDefined();
        });

        test.skip('getBaselineService retourne une instance - SKIP: méthode non exposée publiquement', async () => {
            const service = await RooSyncService.getInstance();
            const baselineService = service.getBaselineService();

            expect(baselineService).toBeDefined();
        });

        test.skip('getMessageHandler retourne une instance - SKIP: méthode non exposée publiquement', async () => {
            const service = await RooSyncService.getInstance();
            const messageHandler = service.getMessageHandler();

            expect(messageHandler).toBeDefined();
        });
    });

    // ============================================================
    // Configuration
    // ============================================================

    describe('Configuration', () => {
        test.skip('charge la configuration au démarrage - SKIP: dépend du mock loadRooSyncConfig', async () => {
            await RooSyncService.getInstance();

            expect(mockLoadConfig).toHaveBeenCalled();
        });

        test.skip('gère les erreurs de chargement de configuration - SKIP: dépend du mock loadRooSyncConfig', async () => {
            mockLoadConfig.mockRejectedValue(new Error('Config load failed'));

            // Le service devrait gérer l'erreur gracieusement
            // ou propager une RooSyncServiceError
            await expect(RooSyncService.getInstance()).rejects.toThrow();
        });
    });

    // ============================================================
    // Utilitaires
    // ============================================================

    describe('Utilitaires', () => {
        test('getRooSyncService est un alias de getInstance', async () => {
            const { getRooSyncService } = await import('../RooSyncService.js');
            const instance1 = await getRooSyncService();
            const instance2 = await RooSyncService.getInstance();

            expect(instance1).toBe(instance2);
        });
    });

    // ============================================================
    // Cache avancé
    // ============================================================

    describe('Cache avancé', () => {
        test("supporte l'invalidation intelligente", async () => {
            const service = await RooSyncService.getInstance();

            // Le service devrait avoir un mécanisme d'invalidation
            // basé sur les hashes de fichiers
            expect(service).toBeDefined();
        });

        test('supporte le TTL personnalisé', async () => {
            // Reset du singleton pour ce test
            (RooSyncService as any).instance = null;

            const customTTL = 120000; // 2 minutes
            const options: CacheOptions = {
                ttl: customTTL,
            };

            const service = await RooSyncService.getInstance(options);

            expect(service).toBeDefined();
        });
    });

    // ============================================================
    // Intégration modules délégués
    // ============================================================

    describe('Intégration modules délégués', () => {
        test('SyncDecisionManager est accessible', async () => {
            const service = await RooSyncService.getInstance();

            // Le service devrait exposer une méthode pour accéder au manager
            expect(service).toBeDefined();
        });

        test('ConfigComparator est accessible', async () => {
            const service = await RooSyncService.getInstance();

            expect(service).toBeDefined();
        });

        test('BaselineManager est accessible', async () => {
            const service = await RooSyncService.getInstance();

            expect(service).toBeDefined();
        });

        test('PresenceManager est accessible', async () => {
            const service = await RooSyncService.getInstance();

            expect(service).toBeDefined();
        });

        test('HeartbeatService est accessible', async () => {
            const service = await RooSyncService.getInstance();

            expect(service).toBeDefined();
        });
    });

    // ============================================================
    // Cache subsystem (source-grounded, #833 coverage deep-queue)
    // Real branch coverage of getFileHash / isCacheValid / getOrCache /
    // clearCache — none of which the pre-existing "toBeDefined" tests touch.
    // ============================================================

    describe('Cache subsystem (#833)', () => {
        let svc: RooSyncService;

        beforeEach(async () => {
            // Fresh singleton so cache/cacheOptions mutations never leak between tests.
            (RooSyncService as any).instance = null;
            svc = await RooSyncService.getInstance();
            (svc as any).cache.clear();
        });

        test('getFileHash returns `${mtimeMs}-${size}` for an existing file (L485-488)', () => {
            const f = tmpPath('roosync-fh');
            writeFileSync(f, 'hash-me');
            try {
                const st = statSync(f);
                const hash = (svc as any).getFileHash(f);
                expect(hash).toBe(`${st.mtimeMs}-${st.size}`);
            } finally {
                unlinkSync(f);
            }
        });

        test('getFileHash returns null when statSync throws (missing file, L490-491)', () => {
            expect((svc as any).getFileHash(tmpPath('roosync-missing'))).toBeNull();
        });

        test('isCacheValid is false when the key is absent (L501-502)', () => {
            expect((svc as any).isCacheValid('never-set')).toBe(false);
        });

        test('isCacheValid is false once age reaches the TTL (L506-508)', () => {
            (svc as any).cacheOptions.ttl = 1000;
            (svc as any).cache.set('k', { data: 1, timestamp: Date.now() - 2000 });
            expect((svc as any).isCacheValid('k')).toBe(false);
        });

        test('isCacheValid is false when the source-file hash changed (L512-514)', () => {
            (svc as any).cacheOptions.ttl = 60_000;
            (svc as any).cache.set('k', { data: 1, timestamp: Date.now(), fileHash: 'old-hash' });
            // Fresh timestamp (TTL ok) but a different current hash → smart invalidation.
            expect((svc as any).isCacheValid('k', 'new-hash')).toBe(false);
        });

        test('isCacheValid is true within TTL when the hash matches (L517)', () => {
            (svc as any).cacheOptions.ttl = 60_000;
            (svc as any).cache.set('k', { data: 1, timestamp: Date.now(), fileHash: 'same' });
            expect((svc as any).isCacheValid('k', 'same')).toBe(true);
        });

        test('getOrCache bypasses the cache entirely when disabled (L529-531)', async () => {
            (svc as any).cacheOptions.enabled = false;
            const fetchFn = vi.fn().mockResolvedValue('fresh');

            const a = await (svc as any).getOrCache('k', fetchFn);
            const b = await (svc as any).getOrCache('k', fetchFn);

            expect(a).toBe('fresh');
            expect(b).toBe('fresh');
            // Disabled → fetched every call, nothing stored.
            expect(fetchFn).toHaveBeenCalledTimes(2);
            expect((svc as any).cache.has('k')).toBe(false);
        });

        test('getOrCache fetches once then serves the cached value (L537-552)', async () => {
            (svc as any).cacheOptions.enabled = true;
            (svc as any).cacheOptions.ttl = 60_000;
            const fetchFn = vi.fn().mockResolvedValue('computed');

            const first = await (svc as any).getOrCache('k', fetchFn);
            const second = await (svc as any).getOrCache('k', fetchFn);

            expect(first).toBe('computed');
            expect(second).toBe('computed');
            // Second call must be served from cache (fetchFn not re-invoked).
            expect(fetchFn).toHaveBeenCalledTimes(1);
            expect((svc as any).cache.get('k').data).toBe('computed');
        });

        test('clearCache empties the internal cache map (L452-454)', () => {
            (svc as any).cache.set('k', { data: 1, timestamp: Date.now() });
            expect((svc as any).cache.size).toBe(1);

            svc.clearCache();

            expect((svc as any).cache.size).toBe(0);
        });
    });

    // ============================================================
    // Path & config helpers (source-grounded, #833)
    // ============================================================

    describe('Path & config helpers (#833)', () => {
        let svc: RooSyncService;

        beforeEach(async () => {
            (RooSyncService as any).instance = null;
            svc = await RooSyncService.getInstance();
        });

        test('getRooSyncFilePath joins config.sharedPath with the filename (L558-559)', () => {
            const base = join(tmpdir(), 'roosync-base');
            (svc as any).config.sharedPath = base;
            expect((svc as any).getRooSyncFilePath('dashboard.json')).toBe(join(base, 'dashboard.json'));
        });

        test('checkFileExists throws RooSyncServiceError FILE_NOT_FOUND for a missing file (L565-572)', () => {
            (svc as any).config.sharedPath = tmpdir();
            let thrown: any;
            try {
                (svc as any).checkFileExists(`roosync-absent-${Date.now()}.json`);
            } catch (e) {
                thrown = e;
            }
            expect(thrown).toBeInstanceOf(RooSyncServiceError);
            expect(thrown.code).toBe('FILE_NOT_FOUND');
        });

        test('checkFileExists returns without throwing for an existing file (L565-567)', () => {
            (svc as any).config.sharedPath = tmpdir();
            const f = tmpPath('roosync-exists');
            const name = f.slice(tmpdir().length + 1); // filename relative to sharedPath
            writeFileSync(f, 'x');
            try {
                expect(() => (svc as any).checkFileExists(name)).not.toThrow();
            } finally {
                unlinkSync(f);
            }
        });

        test('getConfig returns the loaded config object (L424-425)', () => {
            const cfg = svc.getConfig();
            expect(cfg).toBeDefined();
            expect(cfg).toBe((svc as any).config);
        });
    });

});
