/**
 * #4427 PR2 — tests de l'instrument de synchronisation de cascade.
 *
 * Ce que ces tests verrouillent (au-delà du « ça marche ») :
 *   - une lecture périmée / vide / illisible n'est PAS harmonisée (`covered:false`) ;
 *   - le rendu en variables d'environnement est FIDÈLE à la grammaire du
 *     runtime (`failover.ts`) : `_RESET` positionnel (les cases vides comptent),
 *     `_LABEL`/`_DIRECTION`/`_NOTE` filtrés (splitSteps), `!own` porté par la cible ;
 *   - la comparaison porte sur des VALEURS : une liste de MÊME cardinalité dont
 *     un élément change est un `modified` à cardinalité constante ;
 *   - le plan n'écrit QUE des clés de cascade : un secret du siège ne peut ni
 *     être écrit, ni être publié (les préservés sont des NOMS, pas des valeurs) ;
 *   - une sauvegarde ne contient que les clés que le plan aurait écrites.
 *
 * @module services/__tests__/cascade-sync
 */

import { describe, test, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
    assessCascadeSource,
    compareCascadeEnv,
    extractCascadeEnv,
    findPreservedKeys,
    parseCascadeEnv,
    planCascadeApply,
    renderCascadeEnv,
    CascadeBackupStore,
    CASCADE_ENV_PREFIX,
    CASCADE_WRITABLE_KEYS,
} from '../cascade-sync.js';

/** Canon compact, conforme à la grammaire du parser (roles sans préfixe). */
const CANON = [
    'SONNET = mistral@zai-glm-5-3 > kc@k3',
    '   LABEL     = Mistral GLM>Kimi K3',
    '   DIRECTION = degraded>lateral',
    '   NOTE      = pas de thinking, raisonne en clair',
    '   RESET     = >2026-08-25T22:28:00Z',
    'HAIKU = vllm-myia@swift-1.5-27b!own > role:sonnet',
    'STEP_EXCLUDE = vllm-myia@swift-1.5-27b:myia-ai-01 myia-po-2028',
    'ACTIVE = haiku@myia-po-2024',
    'AUTO = 1',
    'ROLE_MODELS = glm-5.3:sonnet',
].join('\n');

const READ_AT = '2026-10-30T04:30:00.000Z';

function freshSource(text: string | null = CANON, maxAgeMs = 24 * 3600 * 1000) {
    return assessCascadeSource({
        source: 'hub po-2025',
        text,
        readAt: READ_AT,
        verifiedAt: READ_AT,
        instanceId: '30f10073-ce53-492d-98d1-f8c2c6d6d575',
        maxAgeMs,
        now: READ_AT,
    });
}

/** `.env` de siège fictif — avec des secrets qui ne doivent JAMAIS sortir. */
const SEAT_ENV_TEXT = [
    '# cascade',
    'CLAUDISH_FAILOVER_SONNET = kc@k3 > mmc@MiniMax-M3.1-Flash',
    'CLAUDISH_FAILOVER_AUTO = 0',
    'ANTHROPIC_API_KEY = sk-ant-do-not-leak-0123456789',
    'CLAUDISH_PROXY_KEY = proxy-secret-value',
    'CLAUDISH_CLIENT_LOGIN = seat-login',
    'CLAUDISH_RELAY_PORT = 3914',
    'CLAUDISH_CAPTURE_DIR = G:/captures',
    'UNRELATED_SETTING = keep-me',
].join('\n');

describe('#4427 PR2 — assessCascadeSource (une lecture non fraîche n\'est PAS harmonisée)', () => {
    test('lecture fraîche : couverte, hash canonique et valeurs attendues rendues', () => {
        const snap = freshSource();
        expect(snap.covered).toBe(true);
        expect(snap.coverage).toBe('ok');
        expect(snap.canonicalHash).toMatch(/^[0-9a-f]{32}$/);
        expect(snap.env[`${CASCADE_ENV_PREFIX}SONNET`]).toBe('mistral@zai-glm-5-3>kc@k3');
        expect(snap.provenance.contentHash).toMatch(/^[0-9a-f]{64}$/);
    });

    test('lecture absente (null) : missing, non couverte', () => {
        const snap = freshSource(null);
        expect(snap.covered).toBe(false);
        expect(snap.coverage).toBe('missing');
        expect(snap.env).toEqual({});
    });

    test('lecture vide : empty, non couverte', () => {
        const snap = freshSource('   \n  ');
        expect(snap.covered).toBe(false);
        expect(snap.coverage).toBe('empty');
    });

    test('canon illisible : invalid, non couverte, AUCUNE valeur rendue', () => {
        const snap = freshSource('SONNET = \nGARBAGE');
        expect(snap.covered).toBe(false);
        expect(snap.coverage).toBe('invalid');
        expect(snap.env).toEqual({});
        expect(snap.detail).not.toBe('');
    });

    test('lecture périmée : stale, non couverte — la fraîcheur prime sur tout', () => {
        const snap = assessCascadeSource({
            source: 'hub po-2025',
            text: CANON,
            readAt: '2026-10-20T04:30:00.000Z',
            verifiedAt: '2026-10-20T04:30:00.000Z',
            maxAgeMs: 3600 * 1000,
            now: READ_AT,
        });
        expect(snap.covered).toBe(false);
        expect(snap.coverage).toBe('stale');
        expect(snap.provenance.ageMs).toBeGreaterThan(3600 * 1000);
    });

    test('la fraîcheur se mesure sur le VERIFIED, pas sur l\'instant de la relecture', () => {
        // readAt frais mais VERIFIED vieux : c'est la valeur mesurée qui périme.
        const snap = assessCascadeSource({
            source: 'hub po-2025',
            text: CANON,
            readAt: READ_AT,
            verifiedAt: '2026-10-01T00:00:00.000Z',
            maxAgeMs: 3600 * 1000,
            now: READ_AT,
        });
        expect(snap.coverage).toBe('stale');
    });

    test('MUTANT — un VERIFIED illisible ne passe PAS pour une lecture fraîche', () => {
        // La fraîcheur est fail-closed : un horodatage NON parsable ne vaut pas
        // « frais par défaut ». Le mutant d'origine (`ageMs === null` ⇒ la
        // garde de péremption ne se déclenche pas ⇒ lu frais) meurt ici.
        const snap = assessCascadeSource({
            source: 'hub po-2025',
            text: CANON,
            readAt: READ_AT,
            verifiedAt: 'pas-une-date',
            maxAgeMs: 3600 * 1000,
            now: READ_AT,
        });
        expect(snap.covered).toBe(false);
        expect(snap.coverage).toBe('invalid');
        expect(snap.env).toEqual({});
        expect(snap.provenance.ageMs).toBeNull();
        expect(snap.detail).not.toBe('');
    });

    test('une lecture datée dans le futur, au-delà de la tolérance, est INVALIDE', () => {
        // Une date future ne prouve PAS la fraîcheur : elle la contredit.
        const snap = assessCascadeSource({
            source: 'hub po-2025',
            text: CANON,
            readAt: READ_AT,
            verifiedAt: '2026-10-30T09:30:00.000Z', // 5 h d'avance
            maxAgeMs: 3600 * 1000,
            now: READ_AT,
        });
        expect(snap.covered).toBe(false);
        expect(snap.coverage).toBe('invalid');
        expect(snap.env).toEqual({});
        expect(snap.provenance.ageMs).toBeLessThan(0);
    });

    test('une dérive d\'horloge MINEURE reste tolérée (fraîcheur ≠ horloge parfaite)', () => {
        // 60 s d'avance : NTP, arrondi — ce n'est pas un indice d'incohérence.
        const snap = assessCascadeSource({
            source: 'hub po-2025',
            text: CANON,
            readAt: READ_AT,
            verifiedAt: '2026-10-30T04:31:00.000Z',
            maxAgeMs: 3600 * 1000,
            now: READ_AT,
        });
        expect(snap.covered).toBe(true);
        expect(snap.coverage).toBe('ok');
    });
});

describe('#4427 PR2 — rendu fidèle à la grammaire du runtime (failover.ts)', () => {
    test('le rendu est l\'inverse exact du parseur sur les mêmes valeurs', () => {
        const snap = freshSource();
        const payload = snap.payload!;
        const env = renderCascadeEnv(payload);
        // Les cibles du runtime portent le suffixe de classe.
        expect(env[`${CASCADE_ENV_PREFIX}HAIKU`]).toBe('vllm-myia@swift-1.5-27b!own>role:sonnet');
        // RESET est POSITIONNEL : la case vide du step 0 compte (parseStepResets).
        expect(env[`${CASCADE_ENV_PREFIX}SONNET_RESET`]).toBe(
            `>${snap.payload!.roles.SONNET.steps[1].resetAt}`,
        );
        // STEP_EXCLUDE : une entrée par cible, machines séparées par des espaces.
        expect(env[`${CASCADE_ENV_PREFIX}STEP_EXCLUDE`]).toBe(
            'vllm-myia@swift-1.5-27b:myia-ai-01 myia-po-2028',
        );
        expect(env[`${CASCADE_ENV_PREFIX}ACTIVE`]).toBe('haiku@myia-po-2024');
        expect(env[`${CASCADE_ENV_PREFIX}ROLE_MODELS`]).toBe('glm-5.3:sonnet');
        expect(env[`${CASCADE_ENV_PREFIX}AUTO`]).toBe('1');
    });

    test('une étiquette/direction/note par DÉFAUT ne crée pas de variable (pas de diff fictive)', () => {
        const snap = freshSource();
        const env = snap.env;
        // LABEL porte une information ici (les cibles ne sont pas les labels).
        expect(env[`${CASCADE_ENV_PREFIX}SONNET_LABEL`]).toBe('Mistral GLM>Kimi K3');
        // DIRECTION : la première est le défaut 'degraded', la seconde 'lateral'.
        expect(env[`${CASCADE_ENV_PREFIX}SONNET_DIRECTION`]).toBe('degraded>lateral');
        // NOTE scalaire : un préfixe contigu, comme splitSteps les lit.
        expect(env[`${CASCADE_ENV_PREFIX}SONNET_NOTE`]).toBe('pas de thinking, raisonne en clair');
        // HAIKU n'a ni label déclaré ni direction ≠ défaut, ni note, ni reset.
        expect(env[`${CASCADE_ENV_PREFIX}HAIKU_LABEL`]).toBeUndefined();
        expect(env[`${CASCADE_ENV_PREFIX}HAIKU_DIRECTION`]).toBeUndefined();
        expect(env[`${CASCADE_ENV_PREFIX}HAIKU_NOTE`]).toBeUndefined();
        expect(env[`${CASCADE_ENV_PREFIX}HAIKU_RESET`]).toBeUndefined();
    });

    test('une étiquette ABSENTE retombe sur la cible (jamais la chaîne « undefined »)', () => {
        // Le runtime lit `labels[i] ?? target` : une étiquette manquante ne
        // doit JAMAIS s'écrire « undefined » dans une variable de siège.
        const snap = freshSource();
        const steps = snap.payload!.roles.SONNET.steps;
        (steps[0] as unknown as { label?: string }).label = undefined;
        const env = renderCascadeEnv(snap.payload!);
        const label = env[`${CASCADE_ENV_PREFIX}SONNET_LABEL`];
        expect(label).toContain('mistral@zai-glm-5-3');
        expect(label).not.toContain('undefined');
    });

    test('MUTANT - un rendu qui emet toujours _LABEL/_DIRECTION cree une diff fictive', () => {
        // Un canon SANS bloc LABEL : les etiquettes retombent sur les cibles, donc
        // la variable ne porte AUCUNE information - elle ne doit pas etre rendue
        // (sinon un siege equivalent apparaitrait non harmonise).
        const bare = assessCascadeSource({
            source: 'hub po-2025',
            text: ['SONNET = alpha@one > beta@two', 'AUTO = 1'].join(String.fromCharCode(10)),
            readAt: READ_AT,
            verifiedAt: READ_AT,
            maxAgeMs: 24 * 3600 * 1000,
            now: READ_AT,
        });
        expect(bare.covered).toBe(true);
        expect(bare.env[`${CASCADE_ENV_PREFIX}SONNET_LABEL`]).toBeUndefined();
        expect(bare.env[`${CASCADE_ENV_PREFIX}SONNET_DIRECTION`]).toBeUndefined();

        const seat = {
            [`${CASCADE_ENV_PREFIX}SONNET`]: 'alpha@one>beta@two',
            [`${CASCADE_ENV_PREFIX}AUTO`]: '1',
        };
        const plan = planCascadeApply(bare, seat);
        const written = plan.writes.map((w) => w.key);
        expect(written).not.toContain(`${CASCADE_ENV_PREFIX}SONNET_LABEL`);
        expect(written).not.toContain(`${CASCADE_ENV_PREFIX}SONNET_DIRECTION`);
        expect(plan.applicable).toBe(false);
    });
});

describe('#4427 PR2 — comparaison de VALEURS (pas de comptes)', () => {
    test('changement de MÊME cardinalité : modified, cardinalité constante, élément indexé', () => {
        const comparison = compareCascadeEnv(
            { [`${CASCADE_ENV_PREFIX}SONNET`]: 'alpha>bravo>charlie' },
            { [`${CASCADE_ENV_PREFIX}SONNET`]: 'alpha>delta>charlie' },
        );
        expect(comparison.changes).toHaveLength(1);
        const change = comparison.changes[0];
        expect(change.kind).toBe('modified');
        expect(change.sameCardinality).toBe(true);
        expect(change.elements).toEqual([{ index: 1, before: 'delta', after: 'bravo' }]);
    });

    test('changement de cardinalité : sameCardinality faux', () => {
        const comparison = compareCascadeEnv(
            { [`${CASCADE_ENV_PREFIX}SONNET`]: 'alpha>bravo>charlie' },
            { [`${CASCADE_ENV_PREFIX}SONNET`]: 'alpha>bravo' },
        );
        expect(comparison.changes[0].sameCardinality).toBe(false);
        expect(comparison.changes[0].elements).toEqual([{ index: 2, before: null, after: 'charlie' }]);
    });

    test('clé absente d\'un côté : added / removed', () => {
        const comparison = compareCascadeEnv(
            { [`${CASCADE_ENV_PREFIX}AUTO`]: '1' },
            {},
        );
        expect(comparison.changes[0].kind).toBe('added');
        expect(comparison.changes[0].before).toBeNull();
        expect(comparison.changes[0].after).toBe('1');
    });

    test('identiques : aucun changement, compte des inchangées', () => {
        const env = { [`${CASCADE_ENV_PREFIX}AUTO`]: '1' };
        const comparison = compareCascadeEnv(env, env);
        expect(comparison.changes).toHaveLength(0);
        expect(comparison.unchanged).toBe(1);
    });
});

describe('#4427 PR2 — plan d\'application (borné, non destructif)', () => {
    test('écrit UNIQUEMENT des clés de cascade — jamais un secret du siège', () => {
        const plan = planCascadeApply(freshSource(), parseCascadeEnv(SEAT_ENV_TEXT));
        for (const write of plan.writes) {
            expect(CASCADE_WRITABLE_KEYS).toContain(write.key);
            expect(write.key).not.toMatch(/API_KEY|SECRET|TOKEN|PASSWORD|LOGIN|PORT|CAPTURE/);
        }
        // Le secret du siège est PRÉSERVÉ (rapporté par son nom, sans valeur).
        const preserved = plan.preserved.map((p) => p.key);
        expect(preserved).toContain('ANTHROPIC_API_KEY');
        expect(preserved).toContain('CLAUDISH_PROXY_KEY');
        expect(preserved).toContain('CLAUDISH_CLIENT_LOGIN');
        expect(preserved).toContain('CLAUDISH_RELAY_PORT');
        expect(preserved).toContain('CLAUDISH_CAPTURE_DIR');
    });

    test('les préservés ne portent JAMAIS leur valeur (jamais de .env publié)', () => {
        const plan = planCascadeApply(freshSource(), parseCascadeEnv(SEAT_ENV_TEXT));
        const serialized = JSON.stringify(plan);
        expect(serialized).not.toContain('sk-ant-do-not-leak-0123456789');
        expect(serialized).not.toContain('proxy-secret-value');
        expect(serialized).not.toContain('seat-login');
        for (const preserved of plan.preserved) {
            expect(Object.keys(preserved).sort()).toEqual(['key', 'reason']);
        }
    });

    test('MUTANT — un plan qui écrivait toutes les clés du .env se voit ici', () => {
        const seat = parseCascadeEnv(SEAT_ENV_TEXT);
        const plan = planCascadeApply(freshSource(), seat);
        const touched = new Set(plan.writes.map((w) => w.key));
        for (const key of Object.keys(seat)) {
            if (!CASCADE_WRITABLE_KEYS.includes(key)) {
                expect(touched.has(key)).toBe(false);
            }
        }
    });

    test('une source périmée ne produit AUCUNE écriture', () => {
        const stale = assessCascadeSource({
            source: 'hub po-2025',
            text: CANON,
            readAt: '2026-10-01T00:00:00.000Z',
            verifiedAt: '2026-10-01T00:00:00.000Z',
            maxAgeMs: 1000,
            now: READ_AT,
        });
        const plan = planCascadeApply(stale, parseCascadeEnv(SEAT_ENV_TEXT));
        expect(plan.applicable).toBe(false);
        expect(plan.writes).toHaveLength(0);
        expect(plan.reasons.join(' ')).toContain('stale');
    });

    test('la valeur AVANT est conservée dans le plan (le rollback en a besoin)', () => {
        const seat = parseCascadeEnv(SEAT_ENV_TEXT);
        const plan = planCascadeApply(freshSource(), seat);
        const write = plan.writes.find((w) => w.key === `${CASCADE_ENV_PREFIX}SONNET`);
        expect(write).toBeDefined();
        expect(write!.before).toBe('kc@k3 > mmc@MiniMax-M3.1-Flash');
        expect(write!.value).toBe('mistral@zai-glm-5-3>kc@k3');
    });

    test('MUTANT — une clé retirée par la source est RAPPORTÉE, jamais passée sous silence', () => {
        // Le siège porte une clé de cascade que la source ne veut plus : la
        // divergence est RÉELLE. Ce plan n'écrit que des valeurs, donc la
        // suppression n'est pas planifiable — mais elle doit être NOMMÉE.
        // Le mutant « `continue` silencieux » se lit « applicable:false,
        // aucune raison » = « rien à faire » : ce test le tue.
        const seat = {
            ...parseCascadeEnv(SEAT_ENV_TEXT),
            [`${CASCADE_ENV_PREFIX}HAIKU_NOTE`]: 'note du siège',
        };
        const plan = planCascadeApply(freshSource(), seat);
        const removed = plan.changes.find((c) => c.kind === 'removed');
        expect(removed).toBeDefined();
        expect(removed!.key).toBe(`${CASCADE_ENV_PREFIX}HAIKU_NOTE`);
        expect(plan.reasons.join(' ')).toContain(`${CASCADE_ENV_PREFIX}HAIKU_NOTE`);
        expect(plan.reasons.join(' ')).toContain('non planifiable');
        // La clé retirée ne doit PAS être écrite (une suppression n'est pas une
        // écriture de valeur '') — elle est RAPPORTÉE, rien de plus.
        expect(plan.writes.find((w) => w.key === `${CASCADE_ENV_PREFIX}HAIKU_NOTE`)).toBeUndefined();
    });
});

describe('#4427 PR2 — lecture du .env du siège (lecture seule)', () => {
    test('parse les paires, ignore commentaires et préfixe export', () => {
        const env = parseCascadeEnv(
            ['# c', 'export A=1', 'B="two"', "C='three'", 'D = 4', 'pas-une-paire'].join('\n'),
        );
        expect(env).toEqual({ A: '1', B: 'two', C: 'three', D: '4' });
    });

    test('l\'extraction ne garde que les clés de cascade', () => {
        const cascade = extractCascadeEnv(parseCascadeEnv(SEAT_ENV_TEXT));
        expect(Object.keys(cascade).sort()).toEqual([
            `${CASCADE_ENV_PREFIX}AUTO`,
            `${CASCADE_ENV_PREFIX}SONNET`,
        ]);
    });

    test('les préservés sont classés par motif', () => {
        const preserved = findPreservedKeys(parseCascadeEnv(SEAT_ENV_TEXT));
        const byKey = Object.fromEntries(preserved.map((p) => [p.key, p.reason]));
        expect(byKey.ANTHROPIC_API_KEY).toBe('credential');
        expect(byKey.CLAUDISH_PROXY_KEY).toBe('proxy key or client login');
        expect(byKey.CLAUDISH_RELAY_PORT).toBe('port, bind or endpoint');
        expect(byKey.CLAUDISH_CAPTURE_DIR).toBe('capture location');
        expect(byKey.UNRELATED_SETTING).toBeUndefined();
    });
});

describe('#4427 PR2 — sauvegarde / rétablissement', () => {
    const dirs: string[] = [];
    afterAll(() => {
        for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    });

    test('la sauvegarde ne contient QUE les clés du plan — pas les secrets du siège', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'cascade-sync-'));
        dirs.push(dir);
        const store = new CascadeBackupStore(dir);
        const seat = parseCascadeEnv(SEAT_ENV_TEXT);
        const plan = planCascadeApply(freshSource(), seat);
        const record = await store.backup(plan, 'myia-po-2024', READ_AT);

        const serialized = JSON.stringify(record);
        expect(serialized).not.toContain('sk-ant-do-not-leak-0123456789');
        expect(serialized).not.toContain('proxy-secret-value');
        for (const entry of record.previous) {
            expect(CASCADE_WRITABLE_KEYS).toContain(entry.key);
        }
        expect(store.list()).toContain(record.backupId);
        expect(store.load(record.backupId)?.seat).toBe('myia-po-2024');
    });

    test('le rétablissement rend les valeurs AVANT, clé par clé', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'cascade-sync-'));
        dirs.push(dir);
        const store = new CascadeBackupStore(dir);
        const plan = planCascadeApply(freshSource(), parseCascadeEnv(SEAT_ENV_TEXT));
        const record = await store.backup(plan, 'myia-po-2024', READ_AT);
        const restore = store.restoreMap(record.backupId)!;
        expect(restore[`${CASCADE_ENV_PREFIX}SONNET`]).toBe('kc@k3 > mmc@MiniMax-M3.1-Flash');
        expect(restore[`${CASCADE_ENV_PREFIX}AUTO`]).toBe('0');
        expect(restore.ANTHROPIC_API_KEY).toBeUndefined();
    });

    test('une sauvegarde inconnue rend null (pas d\'invention)', () => {
        const dir = mkdtempSync(join(tmpdir(), 'cascade-sync-'));
        dirs.push(dir);
        const store = new CascadeBackupStore(dir);
        expect(store.restoreMap('cascade-does-not-exist')).toBeNull();
        expect(store.load('cascade-does-not-exist')).toBeNull();
    });
});
