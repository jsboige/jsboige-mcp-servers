/**
 * #4427 PR1 — tests du schéma de payload cascade Claudish.
 *
 * Fixture dorée : le canon LIVE verbatim publié par po-2025 le 29/10
 * (dashboard global, valeurs exactes, aucun secret). Chaque règle dérive de
 * l'issue #4427 (AC) ou de la barre d'acceptation indépendante de po-2027
 * (c.6504913006) — rien d'inventé.
 *
 * RÉFÉRENCE DE GRAMMAIRE : le parser RUNTIME (`packages/cli/src/fork/failover.ts`)
 * fait foi, pas le fixture. Les tests ci-dessous encodent sa sémantique :
 * `splitSteps` filtre les vides (un scalaire n'atteint que le step 0),
 * `parseStepResets` est positionnel, STEP_EXCLUDE groupe par entrée,
 * ACTIVE separe sur `/[,\s]+/`.
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

    test('SONNET : 5 barreaux ordonnés, LABEL/DIRECTION alignés', () => {
        const sonnet = goldenPayload().roles.SONNET;
        expect(sonnet.steps.map(s => s.ref)).toEqual([
            'mistral@zai-glm-5-3', 'kc@k3', 'mmc@MiniMax-M3.1-Flash',
            'qwen-token-plan@deepseek-v4.1-flash-1017', 'ds@deepseek-flash',
        ]);
        expect(sonnet.steps.map(s => s.label)).toEqual([
            'Mistral GLM', 'Kimi K3', 'MiniMax M3.1', 'Qwen prepaid', 'DeepSeek Flash PAYG',
        ]);
        expect(sonnet.steps.map(s => s.direction)).toEqual([
            'degraded', 'lateral', 'lateral', 'lateral', 'lateral',
        ]);
    });

    test('un scalaire n\'atteint QUE le step 0 (splitSteps filtre les vides) — pas de diffusion', () => {
        // La NOTE du canon live est un scalaire : le runtime l'applique au step 0
        // seulement. La diffusion à tous les barreaux était une invention.
        const sonnet = goldenPayload().roles.SONNET;
        expect(sonnet.steps.map(s => s.note)).toEqual([
            'pas de thinking, raisonne en clair', undefined, undefined, undefined, undefined,
        ]);
    });

    test('le marqueur `>>>>` collé ne crée pas de barreaux fantômes, et RESET vide ne pose aucune date', () => {
        const sonnet = goldenPayload().roles.SONNET;
        expect(sonnet.steps).toHaveLength(5);
        expect(sonnet.steps.every(s => s.resetAt === undefined)).toBe(true);
    });

    test('rôles courts : directions INLINE, indirection role:, suffixe !own (classe)', () => {
        const p = goldenPayload();
        expect(p.roles.OPUS.steps.map(s => s.ref)).toEqual(['cx@gpt-6.1-sol', 'role:sonnet']);
        expect(p.roles.OPUS.steps.map(s => s.direction)).toEqual(['lateral', 'degraded']);
        expect(p.roles.FABLE.steps.map(s => s.ref)).toEqual(['cx@gpt-6-astra', 'role:opus']);
        // La classe `!own` est une CLASSE (failover.ts: splitStepClass), pas
        // une partie du nom de la cible.
        expect(p.roles.HAIKU.steps[0]).toMatchObject({ ref: 'vllm-myia@swift-1.5-27b', class: 'own' });
        expect(p.roles.HAIKU.steps.map(s => s.direction)).toEqual(['degraded', 'improved']);
    });

    test('sans bloc LABEL, l\'étiquette effective est la CIBLE (labels[i] ?? target)', () => {
        const p = goldenPayload();
        expect(p.roles.OPUS.steps.map(s => s.label)).toEqual(['cx@gpt-6.1-sol', 'role:sonnet']);
    });

    test('STEP_EXCLUDE : UNE entrée, deux machines (grammaire du runtime)', () => {
        const p = goldenPayload();
        expect(p.stepExclude).toEqual([
            { stepTarget: 'vllm-myia@swift-1.5-27b', machines: ['myia-ai-01', 'myia-po-2028'] },
        ]);
    });

    test('ACTIVE : quatre pièces, séparateur virgule ou espace (le runtime lit /[,\s]+/)', () => {
        const p = goldenPayload();
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

    test('B5 — un RESET dont la longueur diffère du nombre de barreaux : rejet', () => {
        // Le RESET est positionnel comme les autres blocs : une longueur qui ne
        // correspond pas est une INTENTION PERDUE, pas un détail.
        const ok = ['SONNET = a@b > c@d', 'RESET = >2026-08-25T22:28:00Z'].join('\n');
        expect(parseCascadeCanon(ok).errors).toEqual([]);

        const bad = ['SONNET = a@b > c@d', 'RESET = >2026-08-25T22:28:00Z>2026-09-01T00:00:00Z'].join('\n');
        const { errors } = parseCascadeCanon(bad);
        expect(errors.some(e => e.includes('RESET') && e.includes('3 entrées'))).toBe(true);
    });

    test('B8 — un reset ILLISIBLE est un verdict, pas un reset absent', () => {
        const canon = ['SONNET = a@b', 'RESET = pas-une-date'].join('\n');
        const { payload, errors } = parseCascadeCanon(canon);
        expect(payload).toBeNull();
        expect(errors.some(e => e.includes('reset illisible'))).toBe(true);
    });

    test('DIRECTION en ligne ET bloc DIRECTION : refus (la seconde écraserait la première)', () => {
        const canon = ['SONNET = a@b (lateral>lateral)', 'DIRECTION = degraded>degraded'].join('\n');
        const { payload, errors } = parseCascadeCanon(canon);
        expect(payload).toBeNull();
        expect(errors.some(e => e.includes('DIRECTION en ligne'))).toBe(true);
    });

    test('bloc positionnel avant tout rôle : rejet', () => {
        const { errors } = parseCascadeCanon('LABEL = a>b');
        expect(errors.some(e => e.includes('avant toute déclaration'))).toBe(true);
    });

    test('rôle inconnu : rejet', () => {
        const { errors } = parseCascadeCanon('TURBO = a@b');
        expect(errors.some(e => e.includes('rôle inconnu'))).toBe(true);
    });

    test('bloc positionnel rattaché au DERNIER rôle DÉCLARÉ DANS LE TEXTE (pas à l\'ordre canonique)', () => {
        // Ordre de déclaration INVERSE de CASCADE_ROLE_NAMES : le LABEL qui suit
        // OPUS lui appartient, le LABEL qui suit SONNET lui appartient.
        const canon = [
            'OPUS = a@b > c@d',
            'LABEL = OL1>OL2',
            'SONNET = e@f',
            'LABEL = SL1',
        ].join('\n');
        const { payload, errors } = parseCascadeCanon(canon);
        expect(errors).toEqual([]);
        expect(payload!.roles.OPUS.steps.map(s => s.label)).toEqual(['OL1', 'OL2']);
        expect(payload!.roles.SONNET.steps.map(s => s.label)).toEqual(['SL1']);
    });

    test('RESET positionnel : une case vide compte, la date tombe sur le bon step', () => {
        const canon = [
            'SONNET = a@b > c@d',
            'RESET = >2026-08-25T22:28:00Z',
        ].join('\n');
        const { payload, errors } = parseCascadeCanon(canon);
        expect(errors).toEqual([]);
        expect(payload!.roles.SONNET.steps[0].resetAt).toBeUndefined();
        expect(payload!.roles.SONNET.steps[1].resetAt).toBe('2026-08-25T22:28:00.000Z');
    });
});

describe('cascade payload #4427 — validateCascadePayload', () => {
    test('le canon réel daté est VALIDE, hash canonique recalculé et rendu', () => {
        const result = validateCascadePayload(goldenPayload());
        expect(result.errors).toEqual([]);
        expect(result.ok).toBe(true);
        expect(result.canonicalHash).toMatch(/^[0-9a-f]{32}$/);
    });

    test('le validateur ne LANCE JAMAIS (payloads malformés → verdict, pas exception)', () => {
        const base = goldenPayload() as unknown as Record<string, unknown>;
        for (const broken of [
            null,
            undefined,
            [],
            'a string',
            42,
            { ...base, stepExclude: null },
            { ...base, active: null },
            { ...base, roles: null },
            { ...base, exceptions: null },
            { ...base, roleModels: null },
            { ...base, provenance: null },
            { ...base, roles: { SONNET: null } },
            { ...base, roles: { SONNET: { steps: null } } },
            { ...base, roles: { SONNET: { steps: [null] } } },
            { ...base, stepExclude: [null] },
            { ...base, exceptions: [null] },
        ]) {
            const result = validateCascadePayload(broken);
            expect(result.ok).toBe(false);
            expect(Array.isArray(result.errors)).toBe(true);
            expect(result.errors.length).toBeGreaterThan(0);
        }
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

    test('SECRETS : sk-, sk-ant-, ghp_, et noms PRÉFIXÉS (API_KEY=, PASSWORD=, _TOKEN=) : rejet', () => {
        const cases = [
            'key sk-abcdefghijklmnopqrstuvw',
            'ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnop',
            'DB_PASSWORD=hunter2hunter2hunter2',
            'MY_API_KEY=abcdefghijklmnopqrst',
            'AWS_SECRET_ACCESS_KEY=abcdefghijklmnopqrstuvwxyz',
            'HF_TOKEN=abcdefghijklmnopqrstuvwxyz',
        ];
        for (const value of cases) {
            const p = goldenPayload();
            p.roles.SONNET.steps[0].note = value;
            expect(validateCascadePayload(p).errors.some(e => e.includes('secrète') || e.includes('secret')))
                .toBe(true);
        }
    });

    test('un .env COMPLET glissé dans un champ string autorisé : rejet', () => {
        const p = goldenPayload();
        p.roles.SONNET.steps[0].note = [
            'ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnop',
            'DB_PASSWORD=hunter2hunter2',
            'HF_TOKEN=abcdefghijklmnopqrstuvwxyz',
        ].join('\n');
        const result = validateCascadePayload(p);
        expect(result.ok).toBe(false);
        // Un motif = une erreur par chaîne : le champ visé est nommé, et les
        // deux familles (clé sk-, assignation de secret) sont détectées.
        const secretErrors = result.errors.filter(e => e.includes('secrète'));
        expect(secretErrors.length).toBeGreaterThanOrEqual(2);
        expect(secretErrors.some(e => e.includes('steps[0].note'))).toBe(true);
    });

    test('allow-list DESCENDANTE : une clé inconnue imbriquée est refusée', () => {
        const p = goldenPayload() as unknown as Record<string, any>;
        p.roles.TURBO = { steps: [] };
        p.roles.SONNET.steps[0].envFile = 'FOO=bar';
        p.provenance.extraEnv = 'FOO=bar';
        const result = validateCascadePayload(p);
        expect(result.ok).toBe(false);
        expect(result.errors.some(e => e.includes('hors allow-list') && e.includes('roles.TURBO'))).toBe(true);
        expect(result.errors.some(e => e.includes('steps[0].envFile'))).toBe(true);
        expect(result.errors.some(e => e.includes('provenance.extraEnv'))).toBe(true);
    });

    test('allow-list top-level : une clé inconnue est refusée (jamais de .env complet)', () => {
        const p = goldenPayload() as unknown as Record<string, unknown>;
        p.envFile = 'FOO=bar';
        const result = validateCascadePayload(p);
        expect(result.errors.some(e => e.includes('hors allow-list') && e.includes('envFile'))).toBe(true);
        expect(result.ok).toBe(false);
    });

    test('STEP_EXCLUDE : machines invalides : rejet ; cible inconnue : rejet', () => {
        const p = goldenPayload();
        p.stepExclude = [{ stepTarget: 'vllm-myia@swift-1.5-27b', machines: ['not_a_machine!!'] }];
        expect(validateCascadePayload(p).errors.some(e => e.includes('machine'))).toBe(true);

        const q = goldenPayload();
        q.stepExclude = [{ stepTarget: 'ghost@model', machines: ['myia-ai-01'] }];
        expect(validateCascadePayload(q).errors.some(e => e.includes('inconnu des rôles'))).toBe(true);
    });

    test('STEP_EXCLUDE : une cible `role:<rôle>` est acceptée (le runtime indexe les deux formes)', () => {
        const p = goldenPayload();
        p.stepExclude = [{ stepTarget: 'role:sonnet', machines: ['myia-po-2027'] }];
        expect(validateCascadePayload(p).errors.some(e => e.includes('inconnu des rôles'))).toBe(false);
    });

    test('B11 — une exclusion qui couvre TOUS les barreaux d\'un rôle : refus (il serait désactivé)', () => {
        // Exclure tous les barreaux d'un rôle pour une machine = DÉSACTIVER ce
        // rôle sur cette machine, en silence. Un rôle à moitié exclu reste
        // accepté — la règle ne vise que la perte TOTALE de capacité.
        const p = goldenPayload();
        p.stepExclude = [
            { stepTarget: 'vllm-myia@swift-1.5-27b', machines: ['myia-po-2027'] },
            { stepTarget: 'role:sonnet', machines: ['myia-po-2027'] },
        ];
        expect(validateCascadePayload(p).errors.some(e => e.includes('INTÉGRALEMENT'))).toBe(true);

        const q = goldenPayload();
        q.stepExclude = [{ stepTarget: 'vllm-myia@swift-1.5-27b', machines: ['myia-po-2027'] }];
        expect(validateCascadePayload(q).errors.some(e => e.includes('INTÉGRALEMENT'))).toBe(false);
    });

    test('B11 — la CASSE de la machine ne permet pas d\'échapper au refus (MACHINE_RE est /i)', () => {
        // La même machine écrite dans deux casses, chaque entrée couvrant une
        // partie des barreaux : sans normalisation de la clé, deux ensembles
        // distincts, chacun incomplet, aucun refus — et le rôle désactivé en
        // silence. `MyIA-PO-2027` est un payload VALIDE (MACHINE_RE = /i).
        const p = goldenPayload();
        p.stepExclude = [
            { stepTarget: 'vllm-myia@swift-1.5-27b', machines: ['MyIA-PO-2027'] },
            { stepTarget: 'role:sonnet', machines: ['myia-po-2027'] },
        ];
        expect(validateCascadePayload(p).errors.some(e => e.includes('INTÉGRALEMENT'))).toBe(true);

        // Contrôle négatif : une casse homogène et une couverture PARTIELLE
        // restent acceptées — la normalisation ne doit pas élargir le refus.
        const q = goldenPayload();
        q.stepExclude = [
            { stepTarget: 'vllm-myia@swift-1.5-27b', machines: ['MyIA-PO-2027'] },
        ];
        expect(validateCascadePayload(q).errors.some(e => e.includes('INTÉGRALEMENT'))).toBe(false);
    });

    test('ACTIVE : la machine est validée, et le rôle doit exister', () => {
        const p = goldenPayload();
        p.active = ['haiku@not_a_machine!!'];
        expect(validateCascadePayload(p).errors.some(e => e.includes('machine'))).toBe(true);

        const q = goldenPayload();
        q.active = ['turbo@myia-po-2024'];
        expect(validateCascadePayload(q).errors.some(e => e.includes('rôle'))).toBe(true);
    });

    test('ACTIVE séparé par des ESPACES : accepté (le runtime lit /[,\s]+/)', () => {
        const { payload, errors } = parseCascadeCanon([
            'SONNET = a@b',
            'ACTIVE = haiku@myia-po-2027 haiku@myia-po-2023',
        ].join('\n'));
        expect(errors).toEqual([]);
        expect(payload!.active).toEqual(['haiku@myia-po-2027', 'haiku@myia-po-2023']);
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

    test('graphe — délégation `role:` vers un rôle INCONNU : rejet', () => {
        const p = goldenPayload();
        p.roles.OPUS.steps[1].ref = 'role:turbo';
        expect(validateCascadePayload(p).errors.some(e => e.includes('rôle inconnu'))).toBe(true);
    });

    test('graphe — délégation `role:` CYCLIQUE : rejet (le runtime refuse un cycle au LOAD)', () => {
        const p = goldenPayload();
        p.roles.SONNET.steps.push({ ref: 'role:opus', label: 'role:opus', direction: 'degraded' });
        p.roles.OPUS.steps.push({ ref: 'role:sonnet', label: 'role:sonnet', direction: 'degraded' });
        expect(validateCascadePayload(p).errors.some(e => e.includes('cycle'))).toBe(true);
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
            stepExclude: ['vllm-myia@swift-1.5-27b'],
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

    test('le hash canonique est PRÉSENT même quand le payload est invalide', () => {
        const p = { ...goldenPayload(), schemaVersion: 9 } as unknown as CascadePayload;
        const result = validateCascadePayload(p);
        expect(result.ok).toBe(false);
        expect(result.canonicalHash).toMatch(/^[0-9a-f]{32}$/);
    });

    test('hash canonique : stable sous réordonnancement des clés et des listes', () => {
        const a = goldenPayload();
        const b = goldenPayload();
        b.roleModels = Object.fromEntries(Object.entries(b.roleModels).reverse());
        b.active = [...b.active].reverse();
        expect(computeCanonicalHash(a)).toBe(computeCanonicalHash(b));
    });

    test('hash canonique : sensible aux exceptions par siège (F1 — une exception non documentée fausserait la comparaison)', () => {
        const a = goldenPayload();
        const b = goldenPayload();
        a.exceptions = [{ machine: 'myia-po-2028', reason: 'x' }];
        b.exceptions = [{ machine: 'myia-po-2028', reason: 'y' }];
        expect(computeCanonicalHash(a)).not.toBe(computeCanonicalHash(b));
    });

    test('hash canonique : change quand une VALEUR change (compare values, not counts)', () => {
        const a = goldenPayload();
        const b = goldenPayload();
        b.roles.SONNET.steps[0].ref = 'mistral@zai-glm-5-4';
        expect(computeCanonicalHash(a)).not.toBe(computeCanonicalHash(b));
    });
});
