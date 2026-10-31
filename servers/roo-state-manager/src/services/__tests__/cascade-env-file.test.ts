/**
 * #4427 suivi (ms#1591) — tests de l'écriture ATOMIQUE du `.env` d'un siège.
 *
 * Ce que ces tests VERROUILLENT : le fichier que le conteneur relit au
 * prochain recreate ne passe JAMAIS par un état tronqué. L'écriture passe par
 * un temporaire voisin + rename (atomique sur le volume), et `applied: true`
 * n'existe qu'après une relecture qui rend le texte attendu octet pour octet.
 * En cas d'échec avant le rename, la cible est intacte et le temporaire ne
 * traîne pas dans le répertoire du siège.
 *
 * Contrôle du `fs` : un namespace ESM ne se spaie pas (`vi.spyOn(fs, …)` jette
 * « module namespace is not configurable ») — même passe-partout que
 * `chat-key-refresh.test.ts` : mock pass-through qui échoue ou détourne À LA
 * DEMANDE, tout le reste voit le vrai `fs`.
 *
 * @module services/__tests__/cascade-env-file
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeSeatEnvAtomically } from '../cascade-env-file.js';

const mockFsState = vi.hoisted(() => ({
    failRename: false,
    /** Non-null : la prochaine relecture du `.env` rend CE texte (un tiers a réécrit la cible). */
    rereadOverride: null as string | null,
}));

vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs')>();
    return {
        ...actual,
        renameSync: ((...args: unknown[]) => {
            if (mockFsState.failRename) {
                throw new Error('EPERM: rename locked by another process');
            }
            return (actual.renameSync as (...a: unknown[]) => unknown)(...args);
        }) as typeof actual.renameSync,
        readFileSync: ((...args: unknown[]) => {
            if (mockFsState.rereadOverride !== null && String(args[0]).endsWith('.env')) {
                return mockFsState.rereadOverride;
            }
            return (actual.readFileSync as (...a: unknown[]) => unknown)(...args);
        }) as typeof actual.readFileSync,
    };
});

function tempEnvDir(): { dir: string; envPath: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-env-file-'));
    const envPath = path.join(dir, '.env');
    fs.writeFileSync(envPath, 'OLD=0\n', 'utf8');
    return { dir, envPath };
}

function tempResidue(dir: string): string[] {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
}

beforeEach(() => {
    mockFsState.failRename = false;
    mockFsState.rereadOverride = null;
});

describe('writeSeatEnvAtomically — le .env ne passe jamais par un état tronqué', () => {
    test('succès : replace la cible, relit EXACTEMENT le texte, ne laisse aucun temporaire', () => {
        const { dir, envPath } = tempEnvDir();
        const text = 'OLD=1\nNEW=k=v\n';
        const out = writeSeatEnvAtomically(envPath, text);

        expect(out.applied).toBe(true);
        expect(out.error).toBeNull();
        expect(out.reread).toBe(text);
        // Le disque porte bien le nouveau texte, et le répertoire du siège
        // n'hérite pas d'un voisin .tmp.
        expect(fs.readFileSync(envPath, 'utf8')).toBe(text);
        expect(tempResidue(dir)).toEqual([]);
    });

    test('échec AVANT le rename : cible INTACTE, aucun temporaire, applied:false + erreur', () => {
        const { dir, envPath } = tempEnvDir();
        const original = fs.readFileSync(envPath, 'utf8');
        // Le rename échoue : handle ouvert / antivirus qui verrouille le
        // remplacement — l'échec arrive APRÈS l'écriture du temporaire.
        mockFsState.failRename = true;

        const out = writeSeatEnvAtomically(envPath, 'TRUNCATED=partial');

        expect(out.applied).toBe(false);
        expect(out.error).toContain('EPERM');
        // Le .env d'origine n'a pas bougé — c'est la garantie que le conteneur
        // ne relira jamais un fichier à moitié écrit.
        mockFsState.failRename = false;
        expect(fs.readFileSync(envPath, 'utf8')).toBe(original);
        expect(tempResidue(dir)).toEqual([]);
    });

    test('relecture ≠ texte attendu : applied:false, le verdict ne ment pas', () => {
        const { dir, envPath } = tempEnvDir();
        // Un tiers réécrit la cible ENTRE le rename et la relecture : la
        // relecture rend un autre texte, et `applied` doit le DIRE au lieu de
        // rendre un succès de façade.
        mockFsState.rereadOverride = 'OLD=overwritten-by-someone-else\n';

        const out = writeSeatEnvAtomically(envPath, 'NEW=1\n');

        expect(out.applied).toBe(false);
        expect(out.error).toBeNull();
        expect(out.reread).toBe('OLD=overwritten-by-someone-else\n');
        mockFsState.rereadOverride = null;
        expect(tempResidue(dir)).toEqual([]);
    });
});
