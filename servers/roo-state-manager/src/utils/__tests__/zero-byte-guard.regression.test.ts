/**
 * #3661 — garde « 0 octet » sur analyzeConversation (analyzeWithOldSystem,
 * route par défaut quand USE_NEW_PARSING est absent) et sur la file de
 * réparation proactive (background-services.ts).
 *
 * Réel filesystem (mkdtemp), pas de mock fs — la classe de défaut est
 * précisément une interaction fs (stat.size) que les mocks masquent.
 * Reproduit la mesure du 26/09 : un ui_messages.json de 0 octet rendait un
 * squelette NON-NULL (messageCount 0, metadata présente) que l'auto-repair
 * rendait permanent via task_metadata.json.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

vi.mock('../cache-manager.js', () => ({
    globalCacheManager: {
        get: vi.fn(() => Promise.resolve(null)),
        set: vi.fn(() => Promise.resolve(undefined)),
        delete: vi.fn(() => Promise.resolve(undefined)),
    },
}));

// Modules lourds de background-services (Qdrant/PG) — hors de propos ici,
// on teste la boucle de repair avec FS et RooStorageDetector RÉELS.
vi.mock('../../services/task-indexer.js', () => ({
    TaskIndexer: class { },
    getHostIdentifier: vi.fn(() => 'test-host'),
}));
vi.mock('../../services/task-indexer/VectorIndexer.js', () => ({
    getCircuitBreakerState: vi.fn(() => ({})),
    isCircuitBreakerBlocking: vi.fn(() => false),
    getEmbeddingMetrics: vi.fn(() => ({})),
}));
vi.mock('../../services/unified-store/dual-write.js', () => ({
    dualWriteConversationToStore: vi.fn(() => Promise.resolve()),
}));

import { RooStorageDetector } from '../roo-storage-detector.js';
import { startProactiveMetadataRepair } from '../../services/background-services.js';

const tmpDirs: string[] = [];

async function makeTaskDir(files: Record<string, string>): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zerobyte-guard-'));
    tmpDirs.push(dir);
    for (const [name, content] of Object.entries(files)) {
        await fs.writeFile(path.join(dir, name), content, 'utf8');
    }
    return dir;
}

afterEach(async () => {
    for (const d of tmpDirs.splice(0)) {
        await fs.rm(d, { recursive: true, force: true }).catch(() => { });
    }
    vi.restoreAllMocks();
});

describe('#3661 — analyzeConversation : un fichier de 0 octet n\'est pas une conversation', () => {
    it('rend null pour un dossier réduit à un ui_messages.json de 0 octet (route ancien système par défaut)', async () => {
        expect(process.env.USE_NEW_PARSING).toBeUndefined();
        const dir = await makeTaskDir({ 'ui_messages.json': '' });
        const skeleton = await RooStorageDetector.analyzeConversation('zerobyte-ui-only', dir, false);
        expect(skeleton).toBeNull();
    });

    it('rend null quand TOUS les fichiers de conversation font 0 octet (ui + api history + metadata)', async () => {
        const dir = await makeTaskDir({
            'ui_messages.json': '',
            'api_conversation_history.json': '',
            'task_metadata.json': '',
        });
        const skeleton = await RooStorageDetector.analyzeConversation('zerobyte-all', dir, false);
        expect(skeleton).toBeNull();
    });

    it('rend un squelette exploitable pour un ui_messages.json sain (non-régression)', async () => {
        const dir = await makeTaskDir({
            'ui_messages.json': JSON.stringify([
                { ts: 1, type: 'message', role: 'user', say: 'user', message: 'bonjour' },
            ]),
        });
        const skeleton = await RooStorageDetector.analyzeConversation('healthy-ui', dir, false);
        expect(skeleton).not.toBeNull();
        expect(skeleton!.sequence.length).toBeGreaterThan(0);
        expect(skeleton!.metadata.messageCount).toBeGreaterThan(0);
    });

    it('ui_messages.json 0 octet + task_metadata.json VALIDE : squelette non-null (métadonnées réelles), séquence vide', async () => {
        // Frontière : la métadonnée est exploitable (2 octets, JSON valide) — la tâche
        // existe et est décrite par ses métadonnées ; seule sa conversation est vide.
        // Le chemin readJsonFile direct (sans contenu préchargé) doit rendre [] sans
        // log « Parsed 0 items » — l'invariant : 0 octet n'est jamais une séquence.
        const dir = await makeTaskDir({ 'ui_messages.json': '', 'task_metadata.json': '{}' });
        const skeleton = await RooStorageDetector.analyzeConversation('zerobyte-ui-valid-meta', dir, false);
        expect(skeleton).not.toBeNull();
        expect(skeleton!.metadata).toBeTruthy();
        expect(skeleton!.sequence).toHaveLength(0);
    });
});

describe('#3661 — réparation proactive : pas de task_metadata.json né d\'une conversation vide', () => {
    it('ignore un dossier 0 octet (pas de queue, pas d\'écriture) mais répare un dossier sain sans metadata', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zerobyte-repair-'));
        tmpDirs.push(root);
        const tasksRoot = path.join(root, 'tasks');
        const emptyDir = path.join(tasksRoot, 'aaa-empty');
        const healthyDir = path.join(tasksRoot, 'bbb-healthy');
        await fs.mkdir(emptyDir, { recursive: true });
        await fs.mkdir(healthyDir, { recursive: true });
        await fs.writeFile(path.join(emptyDir, 'ui_messages.json'), '', 'utf8');
        await fs.writeFile(path.join(healthyDir, 'ui_messages.json'), JSON.stringify([
            { ts: 1, type: 'message', role: 'user', say: 'user', message: 'répare-moi' },
        ]), 'utf8');

        vi.spyOn(RooStorageDetector, 'detectStorageLocations').mockResolvedValue([root]);

        await startProactiveMetadataRepair();

        const emptyMeta = path.join(emptyDir, 'task_metadata.json');
        const healthyMeta = path.join(healthyDir, 'task_metadata.json');
        await expect(fs.access(emptyMeta)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(fs.access(healthyMeta)).resolves.toBeUndefined();
    });
});
