/**
 * #4427 PR3 — tests du magasin du canon de cascade.
 *
 * Ce que ces tests VERROUILLENT (au-delà du « ça marche ») :
 *   - une version publiée est IMMUABLE : le même label avec un contenu
 *     différent est REFUSÉ, jamais écrasé — sinon le canon dépendrait de
 *     l'ordre d'arrivée des sièges ;
 *   - republier le MÊME contenu est idempotent (aucun répertoire en plus) ;
 *   - un payload invalide n'est jamais écrit ;
 *   - une racine de magasin absente est un REFUS (fail-closed #3459), pas un
 *     demi-succès ;
 *   - la rétention borne à 5 versions SANS jamais toucher `latest.json` ;
 *   - `verifiedAt` d'une lecture de tête est la date de PUBLICATION — la date
 *     du jour ferait passer n'importe quel canon pour frais.
 *
 * @module services/__tests__/cascade-store
 */

import { describe, test, expect, beforeEach, afterAll } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
    CASCADE_STORE_RETENTION,
    cascadeStoreRoot,
    listCascadeVersions,
    publishCascadeCanon,
    readLatestCascade,
    readLatestCascadePointer,
} from '../cascade-store.js';
import { assessCascadeSource } from '../cascade-sync.js';

const READ_AT = '2026-10-30T04:30:00.000Z';

/**
 * Un payload VALIDE se construit par la source, jamais à la main : le
 * validateur exige une provenance `hub-live` datée (`readAt`), que le parseur
 * de texte ne fabrique pas — c'est `assessCascadeSource` qui la scelle.
 */
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

/** Canon compact, conforme à la grammaire du parser (même forme que PR2). */
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

const PAYLOAD = payloadFrom(CANON);

/** Variante de contenu (une étape de plus) — pour prouver l'immutabilité. */
const OTHER_PAYLOAD = payloadFrom(
    [
        'SONNET = mistral@zai-glm-5-3 > kc@k3 > ds@deepseek-flash',
        'HAIKU = vllm-myia@swift-1.5-27b!own > role:sonnet',
        'ACTIVE = haiku@myia-po-2024',
        'AUTO = 1',
    ].join('\n'),
);

const roots: string[] = [];

/** Racine de magasin neuve — elle EXISTE : `ensureStoreSubdir` est fail-closed. */
function freshStore(): string {
    const root = mkdtempSync(join(tmpdir(), 'cascade-store-'));
    roots.push(root);
    return root;
}

afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('publishCascadeCanon — écriture versionnée', () => {
    let store: string;
    beforeEach(() => {
        store = freshStore();
    });

    test('publie un canon valide, et le pointeur de tête le désigne', () => {
        const outcome = publishCascadeCanon({ sharedStatePath: store, payload: PAYLOAD, version: '1', now: '2026-10-30T18:00:00.000Z' });
        expect(outcome.published).toBe(true);
        expect(outcome.version?.version).toBe('1');
        expect(outcome.errors).toEqual([]);

        const pointer = readLatestCascadePointer(store);
        expect(pointer?.version).toBe('1');
        expect(pointer?.publishedAt).toBe('2026-10-30T18:00:00.000Z');
        expect(pointer?.canonicalHash).toBe(outcome.version?.canonicalHash);

        const payloadPath = join(cascadeStoreRoot(store), pointer!.payloadPath);
        expect(existsSync(payloadPath)).toBe(true);
        expect(JSON.parse(readFileSync(payloadPath, 'utf8'))).toMatchObject({ schemaVersion: 1 });
        expect(existsSync(join(cascadeStoreRoot(store), 'latest.json'))).toBe(true);
    });

    test('un payload INVALIDE est refusé et n’écrit rien', () => {
        const outcome = publishCascadeCanon({
            sharedStatePath: store,
            payload: { schemaVersion: 99, roles: {} },
            version: '1',
            now: '2026-10-30T18:00:00.000Z',
        });
        expect(outcome.published).toBe(false);
        expect(outcome.errors.length).toBeGreaterThan(0);
        expect(readLatestCascadePointer(store)).toBeNull();
        expect(existsSync(join(cascadeStoreRoot(store), 'versions'))).toBe(false);
    });

    test('MUTANT — republier le même label avec un contenu DIFFÉRENT est REFUSÉ (version immuable)', () => {
        const first = publishCascadeCanon({ sharedStatePath: store, payload: PAYLOAD, version: 'v7', now: '2026-10-30T18:00:00.000Z' });
        expect(first.published).toBe(true);

        const second = publishCascadeCanon({ sharedStatePath: store, payload: OTHER_PAYLOAD, version: 'v7', now: '2026-10-30T19:00:00.000Z' });
        expect(second.published).toBe(false);
        expect(second.reason).toMatch(/immuable/i);
        // Le canon de tête est RESTÉ celui d'origine : rien n'a été écrasé.
        expect(readLatestCascadePointer(store)?.canonicalHash).toBe(first.version?.canonicalHash);
        expect(listCascadeVersions(store)).toHaveLength(1);
    });

    test('republier le MÊME contenu avec le même label est idempotent (aucune version en plus)', () => {
        const first = publishCascadeCanon({ sharedStatePath: store, payload: PAYLOAD, version: 'v7', now: '2026-10-30T18:00:00.000Z' });
        const again = publishCascadeCanon({ sharedStatePath: store, payload: PAYLOAD, version: 'v7', now: '2026-10-30T20:00:00.000Z' });
        expect(first.published).toBe(true);
        expect(again.published).toBe(true);
        expect(again.idempotent).toBe(true);
        expect(listCascadeVersions(store)).toHaveLength(1);
        // La tête garde sa date d'origine : republier à l'identique ne rajeunit pas le canon.
        expect(readLatestCascadePointer(store)?.publishedAt).toBe('2026-10-30T18:00:00.000Z');
    });

    test('sans version explicite, la version est ADRESSÉE PAR CONTENU', () => {
        const outcome = publishCascadeCanon({ sharedStatePath: store, payload: PAYLOAD, now: '2026-10-30T18:00:00.000Z' });
        expect(outcome.published).toBe(true);
        expect(outcome.version?.version).toBe(`h${outcome.version?.canonicalHash.slice(0, 8)}`);
    });

    test('un label de version qui sort du vocabulaire est refusé (jamais un nom de chemin)', () => {
        const outcome = publishCascadeCanon({
            sharedStatePath: store,
            payload: PAYLOAD,
            version: '../evil',
            now: '2026-10-30T18:00:00.000Z',
        });
        expect(outcome.published).toBe(false);
        expect(outcome.reason).toMatch(/version invalide/i);
    });

    test('MUTANT — racine absente = REFUS (fail-closed), jamais un demi-succès', () => {
        const absent = join(store, 'does-not-exist');
        const outcome = publishCascadeCanon({ sharedStatePath: absent, payload: PAYLOAD, version: '1', now: '2026-10-30T18:00:00.000Z' });
        expect(outcome.published).toBe(false);
        expect(outcome.reason).toMatch(/absent|fail-closed/i);
        // Et surtout : le helper n'a pas RECRÉÉ la racine.
        expect(existsSync(absent)).toBe(false);
    });
});

describe('rétention', () => {
    test('garde les 5 versions les plus récentes et ne touche jamais latest.json', () => {
        const store = freshStore();
        const n = CASCADE_STORE_RETENTION + 2;
        for (let i = 1; i <= n; i++) {
            const outcome = publishCascadeCanon({
                sharedStatePath: store,
                payload: PAYLOAD,
                version: `v${i}`,
                now: `2026-10-30T1${i}:00:00.000Z`,
            });
            expect(outcome.published, `version v${i}`).toBe(true);
        }
        const versions = listCascadeVersions(store);
        expect(versions).toHaveLength(CASCADE_STORE_RETENTION);
        // Les DEUX plus anciennes sont parties, la plus récente est là.
        expect(versions.some((v) => v.version === 'v1')).toBe(false);
        expect(versions.some((v) => v.version === 'v2')).toBe(false);
        expect(versions[0].version).toBe(`v${n}`);
        // latest.json vit à la racine du magasin — jamais un candidat à la purge.
        expect(existsSync(join(cascadeStoreRoot(store), 'latest.json'))).toBe(true);
    });

    test('listCascadeVersions trie de la plus récente à la plus ancienne', () => {
        const store = freshStore();
        publishCascadeCanon({ sharedStatePath: store, payload: PAYLOAD, version: 'a', now: '2026-10-30T10:00:00.000Z' });
        publishCascadeCanon({ sharedStatePath: store, payload: PAYLOAD, version: 'b', now: '2026-10-30T12:00:00.000Z' });
        const versions = listCascadeVersions(store);
        expect(versions.map((v) => v.version)).toEqual(['b', 'a']);
    });
});

describe('readLatestCascade — la fraîcheur se date à la PUBLICATION', () => {
    test('verifiedAt = date de publication, pas la date du jour', () => {
        const store = freshStore();
        publishCascadeCanon({ sharedStatePath: store, payload: PAYLOAD, version: '1', now: '2026-10-01T00:00:00.000Z' });
        const latest = readLatestCascade(store);
        expect(latest).not.toBeNull();
        expect(latest!.verifiedAt).toBe('2026-10-01T00:00:00.000Z');
        expect(latest!.readAt).toBe('2026-10-01T00:00:00.000Z');
        expect(latest!.text.length).toBeGreaterThan(0);
        expect(latest!.canonicalHash).toBe(readLatestCascadePointer(store)?.canonicalHash);
    });

    test('magasin vide → null (jamais un canon reconstitué depuis versions/)', () => {
        const store = freshStore();
        expect(readLatestCascade(store)).toBeNull();
        expect(readLatestCascadePointer(store)).toBeNull();
    });

    test('un latest.json corrompu rend null plutôt que de deviner', () => {
        const store = freshStore();
        publishCascadeCanon({ sharedStatePath: store, payload: PAYLOAD, version: '1', now: '2026-10-30T18:00:00.000Z' });
        writeFileSync(join(cascadeStoreRoot(store), 'latest.json'), '{ not json', 'utf8');
        expect(readLatestCascadePointer(store)).toBeNull();
        expect(readLatestCascade(store)).toBeNull();
        // La version reste lisible dans versions/ : rien n'a été détruit.
        expect(listCascadeVersions(store)).toHaveLength(1);
        expect(readdirSync(join(cascadeStoreRoot(store), 'versions')).length).toBe(1);
    });
});
