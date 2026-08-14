/**
 * Fuite bande passante po-2025 (handover Maintenance 2026-08-14) — contrôles P0 :
 *
 *  1. Kill-switch ROO_INDEXING_ENABLED=false (défaut ON)
 *     - init d'état (state-manager.service.ts)
 *     - gate de démarrage des deux workers (initializeBackgroundServices)
 *  2. Persistance disque du curseur lastSkeletonRefreshAt
 *     - round-trip persist → load (fs réel + sandbox tmp)
 *     - défauts sûrs : fichier absent / corrompu → 0
 *
 * Falsification : sans le patch, isQdrantIndexingEnabled est codé en dur à true
 * (l'env est ignorée) et initializeBackgroundServices démarre le worker A quoi
 * qu'il arrive — ces deux tests deviennent rouges.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

// --- Sandbox storage : le détecteur pointe vers un tmp dir (aucun vrai globalStorage) ---
vi.mock('../../utils/roo-storage-detector.js', () => ({
    RooStorageDetector: {
        detectStorageLocations: vi.fn(),
        analyzeConversation: vi.fn(),
    },
}));

// --- Imports transitifs lourds : mockés comme les suites existantes ---
vi.mock('../task-indexer.js', () => ({
    TaskIndexer: class {
        async indexTask() { return []; }
        async countPointsByHostOs() { return 0; }
    },
    getHostIdentifier: vi.fn().mockReturnValue('test-host'),
}));

vi.mock('../skeleton-cache.service.js', () => ({
    SkeletonCacheService: {
        configure: vi.fn(),
        getInstance: () => ({
            warmCache: vi.fn().mockResolvedValue(undefined),
            getCacheTierStats: vi.fn().mockResolvedValue({
                tier1_roo: 0,
                tier2_claude: 0,
                tier3_archives: 0,
                total: 0,
                config: { enableClaudeTier: true, enableArchiveTier: true },
            }),
        }),
    },
}));

vi.mock('../../utils/claude-storage-detector.js', () => ({
    ClaudeStorageDetector: {
        detectStorageLocations: vi.fn().mockResolvedValue([]),
        analyzeConversation: vi.fn(),
    },
}));

vi.mock('../../tools/index.js', () => ({}));

vi.mock('../task-archiver/index.js', () => ({
    TaskArchiver: {
        archiveTask: vi.fn().mockResolvedValue(undefined),
    },
}));

import {
    persistIndexerCursor,
    loadPersistedIndexerCursor,
    initializeBackgroundServices,
} from '../background-services.js';
import { RooStorageDetector } from '../../utils/roo-storage-detector.js';
import { StateManager } from '../state-manager.service.js';

const ENV_VAR = 'ROO_INDEXING_ENABLED';

describe('P0 kill-switch ROO_INDEXING_ENABLED', () => {
    const originalValue = process.env[ENV_VAR];

    afterEach(() => {
        if (originalValue === undefined) {
            delete process.env[ENV_VAR];
        } else {
            process.env[ENV_VAR] = originalValue;
        }
    });

    it('défaut (variable absente) : indexation ACTIVE', () => {
        delete process.env[ENV_VAR];
        expect(new StateManager().getState().isQdrantIndexingEnabled).toBe(true);
    });

    it("ROO_INDEXING_ENABLED='true' : indexation ACTIVE", () => {
        process.env[ENV_VAR] = 'true';
        expect(new StateManager().getState().isQdrantIndexingEnabled).toBe(true);
    });

    it("ROO_INDEXING_ENABLED='false' : isQdrantIndexingEnabled=false dès l'init d'état", () => {
        // Falsification : avant le patch, la valeur était codée en dur à true.
        process.env[ENV_VAR] = 'false';
        expect(new StateManager().getState().isQdrantIndexingEnabled).toBe(false);
    });

    it("ROO_INDEXING_ENABLED='false' : initializeBackgroundServices NE démarre NI le worker skeleton NI le worker Qdrant", async () => {
        // Falsification : avant le patch, startSkeletonRefreshWorker était appelé
        // inconditionnellement — skeletonRefreshInterval était non-null.
        process.env[ENV_VAR] = 'false';
        const state = new StateManager().getState();

        await initializeBackgroundServices(state);

        expect(state.skeletonRefreshInterval).toBeNull();
        expect(state.qdrantIndexInterval).toBeNull();
    });
});

describe('P0 persistance du curseur lastSkeletonRefreshAt', () => {
    let sandbox: string;

    beforeEach(async () => {
        sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'rsm-indexer-state-'));
        (RooStorageDetector.detectStorageLocations as ReturnType<typeof vi.fn>).mockResolvedValue([sandbox]);
    });

    afterEach(async () => {
        await fs.rm(sandbox, { recursive: true, force: true });
    });

    it('round-trip : persist puis load renvoie la même valeur', async () => {
        const cursor = 1755180000000;
        await persistIndexerCursor(cursor);
        expect(await loadPersistedIndexerCursor()).toBe(cursor);
    });

    it('le dernier write gagne (timestamp monotone, instances concurrentes)', async () => {
        await persistIndexerCursor(1000);
        await persistIndexerCursor(2000);
        expect(await loadPersistedIndexerCursor()).toBe(2000);
    });

    it('fichier absent : load renvoie 0 (full scan = défaut sûr)', async () => {
        expect(await loadPersistedIndexerCursor()).toBe(0);
    });

    it('fichier corrompu : load renvoie 0 sans rejeter', async () => {
        const skeletonsDir = path.join(sandbox, 'tasks', '.skeletons');
        await fs.mkdir(skeletonsDir, { recursive: true });
        await fs.writeFile(path.join(skeletonsDir, 'indexer-state.json'), '{not json', 'utf8');
        await expect(loadPersistedIndexerCursor()).resolves.toBe(0);
    });
});
