/**
 * #4427 suivi (review ms#1602, follow-up code-owner) — tests HANDLER des
 * consignes de déploiement quand l'écriture du `.env` échoue.
 *
 * Les tests du service (`cascade-env-file.test.ts`) verrouillent
 * `applied`/`replaced` au niveau de `writeSeatEnvAtomically` ; ceux-ci
 * verrouillent ce que l'OPÉRATEUR lit dans la réponse `apply` — sur un chemin
 * de secrets, un wording faux est une consigne fausse :
 *
 *   1. échec AVANT le remplacement → « le .env d'origine est intact » (vrai) ;
 *   2. échec de RELECTURE APRÈS le remplacement → « INDÉTERMINÉ, le nouveau
 *      texte est probablement sur disque, RELIRE » — jamais « origine
 *      intacte » : le nouveau texte EST sur disque, et le prochain recreate le
 *      chargerait ;
 *   3. un tiers réécrit la cible entre write et read (relecture ≠ attendu,
 *      sans erreur) → l'INDÉTERMINÉ historique.
 *
 * Contrôle du `fs` : même passe-partout que `cascade-env-file.test.ts` — un
 * namespace ESM ne se spaie pas, mock pass-through qui échoue ou détourne À LA
 * DEMANDE et SEULEMENT après le `rename` (les lectures du plan, amont, voient
 * le vrai fichier).
 *
 * @module tools/roosync/__tests__/claudish-cascade-apply-failure
 */

import { describe, test, expect, vi, beforeEach, afterAll } from 'vitest';
import * as fs from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { roosyncClaudishCascade } from '../claudish-cascade.js';
import { assessCascadeSource } from '../../../services/cascade-sync.js';

const mockFsState = vi.hoisted(() => ({
    /** Compteur de renameSync réussis — la frontière de phase du mock. */
    renames: 0,
    /** true : writeFileSync jette sur les temporaires `.claude-cascade-apply-*` (échec AVANT remplacement). */
    failTmpWrite: false,
    /** true : après le 1ᵉʳ rename, readFileSync JETTE sur le .env du siège (verrou antivirus). */
    failRereadAfterRename: false,
    /** Non-null : après le 1ᵉʳ rename, readFileSync rend CE texte (un tiers a réécrit la cible). */
    rereadOverrideAfterRename: null as string | null,
    /** Chemin du .env du siège du test courant (posé par beforeEach). */
    envPath: '',
}));

vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs')>();
    return {
        ...actual,
        renameSync: ((...args: unknown[]) => {
            const out = (actual.renameSync as (...a: unknown[]) => unknown)(...args);
            mockFsState.renames += 1;
            return out;
        }) as typeof actual.renameSync,
        writeFileSync: ((...args: unknown[]) => {
            if (mockFsState.failTmpWrite && String(args[0]).includes('.claude-cascade-apply-')) {
                throw new Error('EPERM: operation not permitted, write locked');
            }
            return (actual.writeFileSync as (...a: unknown[]) => unknown)(...args);
        }) as typeof actual.writeFileSync,
        readFileSync: ((...args: unknown[]) => {
            const p = String(args[0]);
            if (mockFsState.renames > 0 && p === mockFsState.envPath) {
                if (mockFsState.failRereadAfterRename) {
                    throw new Error('EBUSY: resource busy or locked');
                }
                if (mockFsState.rereadOverrideAfterRename !== null) {
                    return mockFsState.rereadOverrideAfterRename;
                }
            }
            return (actual.readFileSync as (...a: unknown[]) => unknown)(...args);
        }) as typeof actual.readFileSync,
    };
});

const CANON_TEXT = [
    'SONNET = mistral@zai-glm-5-3 > kc@k3',
    'HAIKU = vllm-myia@swift-1.5-27b!own > role:sonnet',
    'ACTIVE = haiku@myia-po-2024',
    'AUTO = 1',
].join('\n');

const READ_AT = '2026-10-30T04:30:00.000Z';

function payloadFrom(text: string) {
    const snapshot = assessCascadeSource({
        source: 'test',
        text,
        readAt: READ_AT,
        verifiedAt: READ_AT,
        maxAgeMs: 24 * 3600 * 1000,
        now: READ_AT,
    });
    if (snapshot.payload === null) throw new Error(`canon de test invalide : ${snapshot.detail}`);
    return snapshot.payload;
}

const PAYLOAD = payloadFrom(CANON_TEXT);

const SEAT_ENV_TEXT = [
    '# .env du siège — ne pas régénérer',
    'ANTHROPIC_API_KEY = sk-ant-do-not-leak',
    'CLAUDISH_FAILOVER_SONNET = wrong@nowhere > other@place',
    'CLAUDISH_RELAY_PORT = 3914',
    '',
].join('\n');

const roots: string[] = [];
let shared: string;
let envPath: string;

function freshRoot(): string {
    const root = fs.mkdtempSync(join(tmpdir(), 'cascade-apply-fail-'));
    roots.push(root);
    return root;
}

const T0 = '2026-10-30T18:00:00.000Z';

beforeEach(async () => {
    shared = freshRoot();
    process.env.ROOSYNC_SHARED_PATH = shared;
    envPath = join(shared, 'seat.env');
    fs.writeFileSync(envPath, SEAT_ENV_TEXT, 'utf8');
    mockFsState.renames = 0;
    mockFsState.failTmpWrite = false;
    mockFsState.failRereadAfterRename = false;
    mockFsState.rereadOverrideAfterRename = null;
    mockFsState.envPath = envPath;
    const published = await roosyncClaudishCascade({
        action: 'publish',
        payload: PAYLOAD,
        version: 'v1',
        now: T0,
    });
    expect(published.published).toBe(true);
});

afterAll(() => {
    delete process.env.ROOSYNC_SHARED_PATH;
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

async function applyNow(): Promise<Record<string, unknown>> {
    return (await roosyncClaudishCascade({
        action: 'apply',
        env_path: envPath,
        dry_run: false,
        now: T0,
    })) as Record<string, unknown>;
}

describe('apply en échec — la consigne de déploiement suit la PHASE de l’échec', () => {
    test('échec d’écriture AVANT le remplacement → l’original est intact, et le wording le dit', async () => {
        mockFsState.failTmpWrite = true;

        const result = await applyNow();

        expect(result.applied).toBe(false);
        expect(String(result.reason)).toContain('EPERM');
        expect(result.deployment).toBe('aucun — échec AVANT le remplacement, le .env d’origine est intact');
        // La promesse du wording est VRAIE sur disque : octet pour octet.
        expect(fs.readFileSync(envPath, 'utf8')).toBe(SEAT_ENV_TEXT);
        // Aucun temporaire ne survit à l'échec.
        expect(fs.readdirSync(shared).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    });

    test('MUTANT — échec de relecture APRÈS le remplacement → jamais « origine intacte » : le nouveau texte EST sur disque', async () => {
        mockFsState.failRereadAfterRename = true;

        const result = await applyNow();

        expect(result.applied).toBe(false);
        expect(String(result.reason)).toContain('EBUSY');
        expect(result.deployment).toBe(
            'INDÉTERMINÉ — échec de RELECTURE APRÈS le remplacement : le nouveau texte est probablement sur disque, RELIRE avant tout recreate',
        );
        // La raison du wording mensonger si on disait « intact » : le disque
        // porte DÉJÀ la nouvelle cascade — un recreate la chargerait. On lève
        // le verrou simulé pour lire le vrai état final.
        mockFsState.failRereadAfterRename = false;
        const onDisk = fs.readFileSync(envPath, 'utf8');
        expect(onDisk).toContain('CLAUDISH_FAILOVER_SONNET=mistral@zai-glm-5-3>kc@k3');
        expect(onDisk).not.toBe(SEAT_ENV_TEXT);
    });

    test('un tiers réécrit la cible entre write et read → INDÉTERMINÉ historique, sans erreur', async () => {
        mockFsState.rereadOverrideAfterRename = SEAT_ENV_TEXT;

        const result = await applyNow();

        expect(result.applied).toBe(false);
        expect(result.deployment).toBe(
            'INDÉTERMINÉ — le fichier ne relit pas le texte attendu : RELIRE avant tout recreate',
        );
    });
});
