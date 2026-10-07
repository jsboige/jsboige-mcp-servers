/**
 * #2428 — override explicite de la garde 10 Mo de analyzeConversation
 * (analyzeWithOldSystem, route par défaut quand USE_NEW_PARSING est absent).
 *
 * Réel filesystem (mkdtemp), pas de mock fs — la classe de défaut est une
 * interaction fs (stat.size vs ROOSYNC_OVERSIZED_TASK_IDS). Reproduit la
 * mesure du 04/10 : une conversation > 10 Mo (corrompue, à diagnostiquer)
 * était skippée sans possibilité de lecture, même sur demande explicite.
 *
 * Invariants :
 *  - env absent OU task non listé → garde INCHANGÉE (skip + oversizedFiles) ;
 *  - task listé dans ROOSYNC_OVERSIZED_TASK_IDS (CSV) → fichier lu et
 *    préchargé malgré la taille, pas d'entrée oversizedFiles ;
 *  - le parsing CSV tolère espaces et entrées vides.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

import { RooStorageDetector } from '../roo-storage-detector.js';

const tmpDirs: string[] = [];
const TEN_MB = 10 * 1024 * 1024;
// Padding au-delà de la garde : 10,7 Mo de texte dans un message valide.
const PAD = Math.floor(10.7 * 1024 * 1024);

let savedOverrideEnv: string | undefined;

async function makeTaskDir(files: Record<string, string>): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oversized-override-'));
    tmpDirs.push(dir);
    for (const [name, content] of Object.entries(files)) {
        await fs.writeFile(path.join(dir, name), content, 'utf8');
    }
    return dir;
}

function oversizedUiJson(): string {
    return JSON.stringify([
        { ts: 1, type: 'message', role: 'user', say: 'user', message: 'x'.repeat(PAD) },
    ]);
}

function oversizedApiJson(): string {
    return JSON.stringify([
        { ts: 1, role: 'user', content: [{ type: 'text', text: 'x'.repeat(PAD) }] },
    ]);
}

function smallValidUiJson(): string {
    return JSON.stringify([
        { ts: 1, type: 'message', role: 'user', say: 'user', message: 'bonjour' },
    ]);
}

beforeEach(() => {
    savedOverrideEnv = process.env.ROOSYNC_OVERSIZED_TASK_IDS;
    delete process.env.ROOSYNC_OVERSIZED_TASK_IDS;
    expect(process.env.USE_NEW_PARSING).toBeUndefined();
});

afterEach(async () => {
    if (savedOverrideEnv === undefined) {
        delete process.env.ROOSYNC_OVERSIZED_TASK_IDS;
    } else {
        process.env.ROOSYNC_OVERSIZED_TASK_IDS = savedOverrideEnv;
    }
    for (const d of tmpDirs.splice(0)) {
        await fs.rm(d, { recursive: true, force: true }).catch(() => { });
    }
    vi.restoreAllMocks();
});

describe('#2428 — garde 10 Mo : ROOSYNC_OVERSIZED_TASK_IDS override', () => {
    it('env ABSENT : garde inchangée — ui_messages.json > 10 Mo skippé et signalé (non-régression)', async () => {
        const dir = await makeTaskDir({
            'ui_messages.json': oversizedUiJson(),
            'api_conversation_history.json': JSON.stringify([
                { ts: 1, role: 'user', content: [{ type: 'text', text: 'api sain' }] },
            ]),
        });
        const skeleton = await RooStorageDetector.analyzeConversation('task-unlisted', dir, false);
        expect(skeleton).not.toBeNull();
        expect(skeleton!.metadata.oversizedFiles).toBeDefined();
        expect(skeleton!.metadata.oversizedFiles!.join(',')).toContain('ui_messages.json');
        expect(skeleton!.metadata.oversizedFiles!.join(',')).not.toContain('api_conversation_history.json');
    });

    it('task LISTÉ (CSV avec espaces et entrées vides) : ui_messages.json > 10 Mo lu malgré la taille', async () => {
        process.env.ROOSYNC_OVERSIZED_TASK_IDS = '  other-task , , task-override-1  ,';
        const dir = await makeTaskDir({ 'ui_messages.json': oversizedUiJson() });
        const skeleton = await RooStorageDetector.analyzeConversation('task-override-1', dir, false);
        // Fichier LUI-MÊME lu : ui-only dir rend une séquence — un skip rendrait messageCount 0.
        expect(skeleton).not.toBeNull();
        expect(skeleton!.sequence.length).toBeGreaterThan(0);
        expect(skeleton!.metadata.messageCount).toBeGreaterThan(0);
        expect(skeleton!.metadata.oversizedFiles).toBeUndefined();
    });

    it('task LISTÉ : api_conversation_history.json > 10 Mo lu malgré la taille', async () => {
        process.env.ROOSYNC_OVERSIZED_TASK_IDS = 'task-override-2';
        const dir = await makeTaskDir({
            'ui_messages.json': smallValidUiJson(),
            'api_conversation_history.json': oversizedApiJson(),
        });
        const skeleton = await RooStorageDetector.analyzeConversation('task-override-2', dir, false);
        expect(skeleton).not.toBeNull();
        expect(skeleton!.metadata.messageCount).toBeGreaterThan(0);
        expect(skeleton!.metadata.oversizedFiles).toBeUndefined();
    });

    it('env PRÉSENT mais task NON listée : garde inchangée pour tout le monde', async () => {
        process.env.ROOSYNC_OVERSIZED_TASK_IDS = 'someone-else';
        const dir = await makeTaskDir({
            'ui_messages.json': oversizedUiJson(),
            'api_conversation_history.json': smallValidUiJson(),
        });
        const skeleton = await RooStorageDetector.analyzeConversation('task-not-mine', dir, false);
        expect(skeleton).not.toBeNull();
        expect(skeleton!.metadata.oversizedFiles).toBeDefined();
        expect(skeleton!.metadata.oversizedFiles!.join(',')).toContain('ui_messages.json');
    });

    it('env VIDE : équivalent absent — personne ne contourne la garde', async () => {
        process.env.ROOSYNC_OVERSIZED_TASK_IDS = ' , ,';
        const dir = await makeTaskDir({
            'ui_messages.json': oversizedUiJson(),
            'api_conversation_history.json': smallValidUiJson(),
        });
        const skeleton = await RooStorageDetector.analyzeConversation('task-any', dir, false);
        expect(skeleton).not.toBeNull();
        expect(skeleton!.metadata.oversizedFiles).toBeDefined();
        expect(skeleton!.metadata.oversizedFiles!.join(',')).toContain('ui_messages.json');
    });
});
