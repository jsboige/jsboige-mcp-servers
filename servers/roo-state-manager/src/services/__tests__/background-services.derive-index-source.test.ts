/**
 * #2191 — `deriveIndexSource` : attribution Qdrant depuis les métadonnées.
 *
 * L'ancienne dérivation (`background-services.ts`, pré-#2191) ne lisait que
 * `metadata.dataSource` — qui pour une tâche Zoo vaut le CHEMIN de la tâche,
 * pas un marqueur de source. Toute tâche Zoo partait donc en `'roo'`, et
 * `VectorIndexer` écrit `payload.source = source` (le paramètre écrase la
 * source du chunk) : le point Qdrant héritait de la mauvaise attribution et
 * `roosync_search` ne pouvait plus la filtrer.
 *
 * Ce test verrouille la table de vérité de la dérivation :
 *   - `metadata.source === 'zoo-code'` → 'zoo-code' (la régression #2191)
 *   - `metadata.source === 'claude-code'` → 'claude-code'
 *   - marqueur legacy `dataSource === 'claude'` → 'claude-code' (préservé)
 *   - `dataSource` = chemin (tâche Roo) → 'roo' (comportement inchangé)
 *   - métadonnées absentes → 'roo' (défaut inchangé)
 */

import { describe, it, expect, vi } from 'vitest';

// --- fs: mocks minimaux, identiques à la suite background-services existante,
// pour que l'import du module lourd passe sans I/O. ---
vi.mock('fs', async () => {
    const actual = await vi.importActual<typeof import('fs')>('fs');
    return {
        ...actual,
        promises: {
            readdir: vi.fn(),
            readFile: vi.fn(),
            writeFile: vi.fn().mockResolvedValue(undefined),
            stat: vi.fn(),
            access: vi.fn(),
            mkdir: vi.fn().mockResolvedValue(undefined),
            unlink: vi.fn().mockResolvedValue(undefined),
            rename: vi.fn().mockResolvedValue(undefined),
        },
    };
});

vi.mock('../task-indexer.js', () => ({
    TaskIndexer: class {
        async indexTask() { return []; }
        async countPointsByHostOs() { return 0; }
    },
    getHostIdentifier: vi.fn().mockReturnValue('test-host'),
}));

vi.mock('../../utils/roo-storage-detector.js', () => ({
    RooStorageDetector: {
        detectStorageLocations: vi.fn(),
        analyzeConversation: vi.fn(),
    },
}));

vi.mock('../../utils/claude-storage-detector.js', () => ({
    ClaudeStorageDetector: {
        detectStorageLocations: vi.fn(),
        analyzeConversation: vi.fn(),
    },
}));

vi.mock('../unified-store/dual-write.js', () => ({
    dualWriteConversationToStore: vi.fn().mockResolvedValue({ ok: true }),
}));

import { deriveIndexSource } from '../background-services.js';

describe('#2191 deriveIndexSource — attribution depuis les métadonnées du squelette', () => {
    it('tâche Zoo : metadata.source="zoo-code" gagne même si dataSource est un chemin (la régression #2191)', () => {
        // Exactement le cas de prod : la découverte pose source='zoo-code'
        // (detectSourceFromPath), dataSource reste le chemin de la tâche.
        // L'ancienne lecture `dataSource === 'claude' ? ... : 'roo'` rendait 'roo'.
        expect(deriveIndexSource({
            source: 'zoo-code',
            dataSource: 'C:\\Users\\test\\AppData\\Roaming\\zoo-code\\tasks\\abc',
        })).toBe('zoo-code');
    });

    it('session Claude Code via metadata.source', () => {
        expect(deriveIndexSource({ source: 'claude-code', dataSource: 'claude' })).toBe('claude-code');
    });

    it('session Claude Code via le marqueur legacy dataSource="claude" seul', () => {
        // Squelettes ancien format sans metadata.source : le marqueur claude
        // de dataSource doit continuer de fonctionner.
        expect(deriveIndexSource({ dataSource: 'claude' })).toBe('claude-code');
    });

    it('tâche Roo : dataSource = chemin, source absent → roo (inchangé)', () => {
        expect(deriveIndexSource({
            dataSource: 'C:\\Users\\test\\AppData\\Roaming\\Code\\User\\globalStorage\\roo-code\\tasks\\xyz',
        })).toBe('roo');
    });

    it('tâche Roo explicite : metadata.source="roo" → roo', () => {
        expect(deriveIndexSource({ source: 'roo', dataSource: 'whatever' })).toBe('roo');
    });

    it('métadonnées absentes → roo (défaut inchangé)', () => {
        expect(deriveIndexSource(undefined)).toBe('roo');
    });
});
