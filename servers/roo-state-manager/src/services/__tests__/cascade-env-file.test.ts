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
    /** true : la relecture du `.env` JETTE (verrou antivirus, fichier retiré entre rename et read). */
    failReread: false,
    /** Modes recopiés par chmodSync — l'instrument de l'item 2b (portable, y compris sous Windows). */
    chmodCalls: [] as Array<{ path: string; mode: number }>,
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
            if (mockFsState.failReread && String(args[0]).endsWith('.env')) {
                throw new Error('EBUSY: resource busy or locked');
            }
            if (mockFsState.rereadOverride !== null && String(args[0]).endsWith('.env')) {
                return mockFsState.rereadOverride;
            }
            return (actual.readFileSync as (...a: unknown[]) => unknown)(...args);
        }) as typeof actual.readFileSync,
        chmodSync: ((...args: unknown[]) => {
            mockFsState.chmodCalls.push({ path: String(args[0]), mode: Number(args[1]) });
            return (actual.chmodSync as (...a: unknown[]) => unknown)(...args);
        }) as typeof actual.chmodSync,
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
    mockFsState.failReread = false;
    mockFsState.chmodCalls = [];
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

    test('relecture post-rename en ÉCHEC : applied:false + erreur, l’exception ne sort PAS du module (item 2a)', () => {
        const { dir, envPath } = tempEnvDir();
        // Verrou antivirus / fichier retiré entre le rename et le read : la
        // relecture JETTE. Avant la correction, l'exception sortait du module
        // et l'appelant n'obtenait ni verdict ni erreur — il ne pouvait pas
        // distinguer « écriture non appliquée » d'un crash du pipeline.
        mockFsState.failReread = true;

        const out = writeSeatEnvAtomically(envPath, 'NEW=1\n');

        expect(out.applied).toBe(false);
        expect(out.reread).toBeNull();
        expect(out.error).toContain('EBUSY');
        // L'écriture a bien ATTERRI (le rename a précédé l'échec de relecture) :
        // le verdict pessimiste ne doit pas être lu comme « rien n'a changé ».
        mockFsState.failReread = false;
        expect(fs.readFileSync(envPath, 'utf8')).toBe('NEW=1\n');
        expect(tempResidue(dir)).toEqual([]);
    });

    test('le MODE de la cible est recopié sur le remplaçant — le rename ne dégrade pas les permissions (item 2b)', () => {
        const { dir, envPath } = tempEnvDir();
        // Un .env de siège est souvent en 0600 (il porte des clés) : le
        // temporaire, lui, naît en 0o666 & ~umask, et le rename REMPLACE le
        // mode de la cible par le sien. Sans recopie, le premier apply
        // élargirait les droits du fichier de secrets.
        fs.chmodSync(envPath, 0o600);
        mockFsState.chmodCalls = [];
        // Sous Windows `chmod` ne pose qu'un bit read-only : le mode RELU rend
        // `0o666`, jamais `0o600`. Ce que ce test verrouille n'est donc pas la
        // constante POSIX mais la CONTRACTUALITÉ de la recopie — l'appel doit
        // porter exactement le mode que la cible rapporte au moment du geste.
        const targetMode = fs.statSync(envPath).mode & 0o777;
        if (process.platform !== 'win32') {
            expect(targetMode).toBe(0o600); // le siège de test a bien des modes
        }

        const out = writeSeatEnvAtomically(envPath, 'SECRET=abc\n');

        expect(out.applied).toBe(true);
        expect(mockFsState.chmodCalls.length).toBeGreaterThanOrEqual(1);
        expect(mockFsState.chmodCalls[0].mode).toBe(targetMode);
        expect(mockFsState.chmodCalls[0].path).toMatch(/\.tmp$/);
        // Contrôle réel du disque, là où les modes existent.
        if (process.platform !== 'win32') {
            expect(fs.statSync(envPath).mode & 0o777).toBe(0o600);
        }
        expect(tempResidue(dir)).toEqual([]);
    });
});
