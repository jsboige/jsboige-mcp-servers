/**
 * #4427 PR1 — tests du schéma de payload cascade Claudish.
 *
 * Fixture dorée : le canon LIVE verbatim publié par po-2025 le 29/10
 * (dashboard global, valeurs exactes, aucun secret). Chaque règle dérive de
 * l'issue #4427 (AC) ou de la barre d'acceptation indépendante de po-2027
 * (c.6504913006) — rien d'inventé.
 *
 * @module services/__tests__/cascade-payload
 */

import { describe, test, expect } from 'vitest';
import {
    parseCascadeCanon,
    validateCascadePayload,
    computeCanonicalHash,
    CASCADE_PAYLOAD_SCHEMA_VERSION,
    type CascadePayload,
} from '../cascade-payload.js';

/** Canon live verbatim (po-2025, 29/10 ~19:3xZ) — fixture dorée non-secrète. */
const CANON = [
    'SONNET = mistral@zai-glm-5-3 > kc@k3 > mmc@MiniMax-M3.1-Flash > qwen-token-plan@deepseek-v4.1-flash-1017 > ds@deepseek-flash',
    '   LABEL     = Mistral GLM>Kimi K3>MiniMax M3.1>Qwen prepaid>DeepSeek Flash PAYG',
    '   DIRECTION = degraded>lateral>lateral>lateral>lateral',
    '   NOTE      = pas de thinking, raisonne en clair>>>>',
    '   RESET     = >>>>',
    'OPUS  = cx@gpt-6.1-sol > role:sonnet        (lateral>degraded)',
    'FABLE = cx@gpt-6-astra > role:opus          (lateral>degraded)',
    'HAIKU = vllm-myia@swift-1.5-27b!own > role:sonnet   (degraded>improved)',
    'STEP_EXCLUDE = vllm-myia@swift-1.5-27b:myia-ai-01 myia-po-2028',
    'ACTIVE       = haiku@myia-po-2027,haiku@myia-po-2023,haiku@myia-po-2024,haiku@myia-po-2028',
    'AUTO = 1',
    'ROLE_MODELS  = glm-5.1:sonnet,glm-5.2:sonnet,glm-5.3:sonnet,glm-4.7:sonnet,minimax-m3:haiku,',
    '               gpt-6-sol:opus,gpt-6.1-sol:opus,gpt-5.6-sol:opus,gpt-6-astra:fable',
    'QWEN_THINKING = budget:4096',
].join('\n');

/** Complète provenance + drapeaux pour obtenir un payload validable. */
function withProvenance(payload: CascadePayload, readAt = '2026-10-29T19:35:00.000Z'): CascadePayload {
    return { ...payload, provenance: { source: 'hub-live', readAt, instanceId: '877f42cb-72b5-4a0a-a6ce-a3b08e353268' } };
}

function goldenPayload(): CascadePayload {
    const { payload, errors } = parseCascadeCanon(CANON);
    expect(errors).toEqual([]);
    expect(payload).not.toBeNull();
    return withProvenance(payload!);
}

describe('cascade payload #4427 — parseCascadeCanon (fixture dorée = canon live)', () => {
    test('parse le canon réel complet sans erreur', () => {
        const { payload, errors } = parseCascadeCanon(CANON);
        expect(errors).toEqual([]);
        expect(payload?.schemaVersion).toBe(CASCADE_PAYLOAD_SCHEMA_VERSION);
    });

    test('SONNET : 5 barreaux ordonnés, LABEL/DIRECTION alignés, NOTE partagée, RESET isolé', () => {
        const sonnet = goldenPayload().roles.SONNET;
        expect(sonnet.steps.map(s => s.ref)).toEqual([
            'mistral@zai-glm-5-3', 'kc@k3', 'mmc@MiniMax-M3.1-Flash',
            'qwen-token-plan@deepseek-v4.1-flash-1017', 'ds@deepseek-flash',
        ]);
        // Le `>>>>` collé à la NOTE n'a pas créé de barreaux fantômes (split
        // sur '>' + retrait des fragments vides de queue), et le RESET est
        // séparé.
        expect(sonnet.steps.map(s => s.label)).toEqual([
            'Mistral GLM', 'Kimi K3', 'MiniMax M3.1', 'Qwen prepaid', 'DeepSeek Flash PAYG',
        ]);
        expect(sonnet.steps.map(s => s.direction)).toEqual([
            'degraded', 'lateral', 'lateral', 'lateral', 'lateral',
        ]);
        expect(sonnet.steps.map(s => s.note)).toEqual([
            'pas de thinking, raisonne en clair', 'pas de thinking, raisonne en clair',
            'pas de thinking, raisonne en clair', 'pas de thinking, raisonne en clair',
            'pas de thinking, raisonne en clair',
        ]);
        expect(sonnet.reset).toBe('>>>>');
    });

    test('rôles courts : directions INLINE entre parenthèses, indirection role:, suffixe !own', () => {
        const p = goldenPayload();
        expect(p.roles.OPUS.steps.map(s => s.ref)).toEqual(['cx@gpt-6.1-sol', 'role:sonnet']);
        expect(p.roles.OPUS.steps.map(s => s.direction)).toEqual(['lateral', 'degraded']);
        expect(p.roles.HAIKU.steps[0].ref).toBe('vllm-myia@swift-1.5-27b!own');
        expect(p.roles.HAIKU.steps.map(s => s.direction)).toEqual(['degraded', 'improved']);
    });

    test('scalaires : STEP_EXCLUDE séparé par ESPACE (2 formes), ACTIVE par VIRGULE (4)', () => {
        const p = goldenPayload();
        expect(p.stepExclude).toEqual(['vllm-myia@swift-1.5-27b:myia-ai-01', 'myia-po-2028']);
        expect(p.active).toEqual([
            'haiku@myia-po-2027', 'haiku@myia-po-2023', 'haiku@myia-po-2024', 'haiku@myia-po-2028',
        ]);
        expect(p.auto).toBe(1);
        expect(p.qwenThinking).toBe('budget:4096');
        expect(Object.keys(p.roleModels)).toContain('glm-5.3');
        expect(p.roleModels['glm-5.3']).toBe('sonnet');
        expect(p.roleModels['gpt-6-astra']).toBe('fable');
    });

    test('longueurs parallèles incohérentes : rejet AVANT écriture (AC #4427)', () => {
        const canon = CANON.replace(
            '   DIRECTION = degraded>lateral>lateral>lateral>lateral',
            '   DIRECTION = degraded>lateral',
        );
        const { errors } = parseCascadeCanon(canon);
        expect(errors.some(e => e.includes('DIRECTION') && e.includes('2 entrées'))).toBe(true);
    });

    test('bloc positionnel avant tout rôle : rejet', () => {
        const { errors } = parseCascadeCanon('LABEL = a>b');
        expect(errors.some(e => e.includes('avant toute déclaration'))).toBe(true);
    });

    test('rôle inconnu : rejet', () => {
        const { errors } = parseCascadeCanon('TURBO = a@b');
        expect(errors.some(e => e.includes('rôle inconnu'))).toBe(true);
    });
});

describe('cascade payload #4427 — validateCascadePayload', () => {
    test('le canon réel daté est VALIDE, hash canonique recalculé et rendu', () => {
        const result = validateCascadePayload(goldenPayload());
        expect(result.errors).toEqual([]);
        expect(result.ok).toBe(true);
        expect(result.canonicalHash).toMatch(/^[0-9a-f]{32}$/);
    });

    test('schemaVersion différent : rejet', () => {
        const p = { ...goldenPayload(), schemaVersion: 2 } as unknown as CascadePayload;
        expect(validateCascadePayload(p).errors.some(e => e.includes('schemaVersion'))).toBe(true);
    });

    test('provenance non-live (checkout périmé) : rejet — AC « sourced from fresh hub live values »', () => {
        const p = goldenPayload();
        (p.provenance as any).source = 'stale-checkout';
        expect(validateCascadePayload(p).errors.some(e => e.includes('hub-live'))).toBe(true);
    });

    test('readAt absent : rejet (snapshot invérifiable)', () => {
        const p = goldenPayload();
        delete (p.provenance as any).readAt;
        expect(validateCascadePayload(p).errors.some(e => e.includes('readAt'))).toBe(true);
    });

    test('SECRETS : sk-, ghp_, assignation API_KEY= — rejet où qu\'ils soient (AC « non-secret »)', () => {
        for (const [field, value] of [
            ['note', 'key sk-abcdefghijklmnopqrstuvw'],
            ['label', 'ghp_abcdefghijklmnopqrstuvwxyz'],
        ] as const) {
            const p = goldenPayload();
            p.roles.SONNET.steps[0][field] = value;
            expect(validateCascadePayload(p).errors.some(e => e.includes('secrète') || e.includes('secret')))
                .toBe(true);
        }
        const env = goldenPayload();
        (env as any).envFile = 'API_KEY=sk-abcdefghijklmnopqrstuvw';
        expect(validateCascadePayload(env).errors.some(e => e.includes('hors allow-list'))).toBe(true);
    });

    test('allow-list top-level : une clé inconnue est refusée (jamais de .env complet)', () => {
        const p = goldenPayload() as unknown as Record<string, unknown>;
        p.envFile = 'FOO=bar';
        const result = validateCascadePayload(p);
        expect(result.errors.some(e => e.includes('hors allow-list') && e.includes('envFile'))).toBe(true);
        expect(result.ok).toBe(false);
    });

    test('C2 — STEP_EXCLUDE avec PLUS d\'un « : » : rejet', () => {
        const p = goldenPayload();
        p.stepExclude = ['vllm-myia@swift-1.5-27b:myia-ai-01:extra'];
        expect(validateCascadePayload(p).errors.some(e => e.includes('C2'))).toBe(true);
    });

    test('graphe — STEP_EXCLUDE pointant un barreau inconnu : rejet (AC « reject inconsistent graphs »)', () => {
        const p = goldenPayload();
        p.stepExclude = ['ghost@model:myia-ai-01'];
        expect(validateCascadePayload(p).errors.some(e => e.includes('inconnu des rôles'))).toBe(true);
    });

    test('graphe — barreau dupliqué dans un rôle : rejet', () => {
        const p = goldenPayload();
        p.roles.SONNET.steps = [
            p.roles.SONNET.steps[0],
            { ...p.roles.SONNET.steps[0] },
        ];
        expect(validateCascadePayload(p).errors.some(e => e.includes('dupliqué'))).toBe(true);
    });

    test('graphe — direction inconnue : rejet', () => {
        const p = goldenPayload();
        p.roles.OPUS.steps[0].direction = 'sideways' as any;
        expect(validateCascadePayload(p).errors.some(e => e.includes('direction inconnue'))).toBe(true);
    });

    test('ACTIVE avec rôle inconnu : rejet', () => {
        const p = goldenPayload();
        p.active = ['turbo@myia-po-2024'];
        expect(validateCascadePayload(p).errors.some(e => e.includes('rôle « turbo » inconnu'))).toBe(true);
    });

    test('exceptions par siège : une exception SANS raison est rejetée (documentée ou rien)', () => {
        const p = goldenPayload();
        p.exceptions = [{ machine: 'myia-po-2028', reason: '' }];
        expect(validateCascadePayload(p).errors.some(e => e.includes('raison absente'))).toBe(true);
    });

    test('exception documentée portant un STEP_EXCLUDE canonique : acceptée', () => {
        const p = goldenPayload();
        p.exceptions = [{
            machine: 'myia-po-2028',
            reason: 'haiku armé + swift exclu → tombe sur role:sonnet (décision durable 20/10)',
            stepExclude: ['myia-po-2028'],
        }];
        expect(validateCascadePayload(p).ok).toBe(true);
    });

    test('H1 — un snapshotHash revendiqué ≠ hash recalculé : rejet (un hash revendiqué ne confirme jamais)', () => {
        const p = goldenPayload();
        p.provenance.snapshotHash = 'deadbeefdeadbeefdeadbeefdeadbeef';
        const result = validateCascadePayload(p);
        expect(result.errors.some(e => e.includes('H1'))).toBe(true);
        expect(result.canonicalHash).not.toBe('deadbeefdeadbeefdeadbeefdeadbeef');
    });

    test('hash canonique : stable sous réordonnancement des clés et des exceptions', () => {
        const a = goldenPayload();
        const b = goldenPayload();
        // Réordonne roleModels + exceptions ajoutées (hors hash) + ordre stepExclude/active inversé.
        b.roleModels = Object.fromEntries(Object.entries(b.roleModels).reverse());
        b.stepExclude = [...b.stepExclude].reverse();
        b.active = [...b.active].reverse();
        b.exceptions = [{ machine: 'myia-po-2028', reason: 'x' }];
        expect(computeCanonicalHash(a)).toBe(computeCanonicalHash(b));
    });

    test('hash canonique : change quand une VALEUR change (compare values, not counts)', () => {
        const a = goldenPayload();
        const b = goldenPayload();
        b.roles.SONNET.steps[0].ref = 'mistral@zai-glm-5-4';
        expect(computeCanonicalHash(a)).not.toBe(computeCanonicalHash(b));
    });
});
