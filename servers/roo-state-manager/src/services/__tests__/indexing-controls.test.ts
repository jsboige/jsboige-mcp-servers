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
        async resetCollection() { return undefined; }
    },
    getHostIdentifier: vi.fn().mockReturnValue('test-host'),
}));

// Spies STABLES entre appels : `getInstance()` renvoyait un objet neuf a chaque
// appel, donc le `warmCache` observe n'etait jamais celui qui avait ete appele.
const skeletonCache = vi.hoisted(() => ({
    configure: vi.fn(),
    warmCache: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../skeleton-cache.service.js', () => ({
    SkeletonCacheService: {
        configure: skeletonCache.configure,
        getInstance: () => ({
            warmCache: skeletonCache.warmCache,
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
import { indexTaskSemanticTool } from '../../tools/indexing/index-task.tool.js';

const ENV_VAR = 'ROO_INDEXING_ENABLED';

// `mockReset: true` (vitest.config.unit.ts, herite par la config CI) efface
// l'IMPLEMENTATION des spies apres chaque test, pas seulement leurs appels : une
// valeur posee a la creation du spy ne survit qu'au premier test du fichier. Comme
// `warmCache` est desormais un spy PARTAGE (voir le mock plus haut), sa valeur de
// retour se repose ici pour TOUS les tests -- y compris ceux qui appellent
// initializeBackgroundServices sans s'interesser au prechauffage.
beforeEach(() => {
    skeletonCache.warmCache.mockResolvedValue(undefined);
});

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

    it("ROO_INDEXING_ENABLED='false' : l'outil index_task_semantic REFUSE avant tout travail (gate explicite)", async () => {
        // #985 review finding 1 : sans gate, un appel explicite `index` contourne
        // le kill-switch machine. La gate doit jeter AVANT ensureCacheFreshCallback.
        process.env[ENV_VAR] = 'false';
        const ensureCacheFresh = vi.fn().mockResolvedValue(true);

        const result = await indexTaskSemanticTool.handler(
            { task_id: 'whatever' },
            new Map(),
            ensureCacheFresh
        );

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain('ROO_INDEXING_ENABLED');
        expect(ensureCacheFresh).not.toHaveBeenCalled();
    });

    it("ROO_INDEXING_ENABLED='false' : reset_qdrant_collection ne re-flippe PAS le flag à true", async () => {
        // #985 review finding 2 : sans clamp, reset appelait
        // setQdrantIndexingEnabled(true) même sur une machine kill-switchée.
        process.env[ENV_VAR] = 'false';
        const { resetQdrantCollectionTool } = await import('../../tools/indexing/reset-collection.tool.js');
        const setIndexingEnabled = vi.fn();

        // TaskIndexer est mocké (resetCollection no-op) — pas de vraie connexion Qdrant.
        await resetQdrantCollectionTool.handler(
            { confirm: true },
            new Map(),
            vi.fn().mockResolvedValue(undefined),
            new Set<string>(),
            setIndexingEnabled
        );

        expect(setIndexingEnabled).not.toHaveBeenCalled();
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

describe('SKELETON_PREWARM — le prechauffage est optionnel, les tiers ne le sont pas', () => {
    // Le prechauffage est une optimisation de LATENCE dont le cout est paye PAR HOTE :
    // chaque hote MCP hydrate sa copie privee du meme corpus (mesure ai-01 : Tier 3 =
    // 2125 Mo/hote, Tier 2 = 950 Mo/hote, serveur seul = 142 Mo). Sur une machine a
    // 30 hotes, 2,1 Go resident partout pour economiser ~30 s une fois.
    //
    // Le piege que ces tests gardent : eteindre le prechauffage en eteignant un TIER.
    // #1747 a precisement ALLUME les tiers 2 et 3 pour rendre visibles les sessions
    // Claude et les archives cross-machine ; les eteindre serait le coup de pendule
    // inverse. D'ou l'assertion sur `configure` dans CHAQUE cas.
    const PREWARM = 'SKELETON_PREWARM';
    const originalPrewarm = process.env[PREWARM];
    const originalIndexing = process.env[ENV_VAR];

    beforeEach(() => {
        // Hermetisme : sans ca, initializeBackgroundServices arme de vrais setInterval
        // qui survivent au test. Le bloc prechauffage s'execute AVANT ce kill-switch,
        // il n'est donc pas masque par lui.
        process.env[ENV_VAR] = 'false';
    });

    afterEach(() => {
        if (originalPrewarm === undefined) delete process.env[PREWARM];
        else process.env[PREWARM] = originalPrewarm;
        if (originalIndexing === undefined) delete process.env[ENV_VAR];
        else process.env[ENV_VAR] = originalIndexing;
    });

    it('defaut (variable absente) : le prechauffage a lieu — la flotte est inchangee', async () => {
        delete process.env[PREWARM];

        await initializeBackgroundServices(new StateManager().getState());

        expect(skeletonCache.warmCache).toHaveBeenCalledTimes(1);
    });

    it("SKELETON_PREWARM='false' : AUCUN prechauffage", async () => {
        // Falsification : avant le patch, warmCache() etait appele inconditionnellement —
        // ce test rougit si la garde disparait.
        process.env[PREWARM] = 'false';

        await initializeBackgroundServices(new StateManager().getState());

        expect(skeletonCache.warmCache).not.toHaveBeenCalled();
    });

    it("SKELETON_PREWARM='false' : les tiers 2 et 3 restent ALLUMES (#1747 preserve)", async () => {
        process.env[PREWARM] = 'false';

        await initializeBackgroundServices(new StateManager().getState());

        expect(skeletonCache.configure).toHaveBeenCalledWith({
            enableClaudeTier: true,
            enableArchiveTier: true,
        });
    });

    it("seule la chaine exacte 'false' desactive le prechauffage", async () => {
        // Meme convention que SKELETON_*_TIER et ROO_INDEXING_ENABLED : une valeur
        // inattendue ne doit pas eteindre silencieusement une optimisation.
        process.env[PREWARM] = '0';

        await initializeBackgroundServices(new StateManager().getState());

        expect(skeletonCache.warmCache).toHaveBeenCalledTimes(1);
    });
});
