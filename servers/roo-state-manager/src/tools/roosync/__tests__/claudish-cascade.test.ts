/**
 * #4427 PR3 — tests de l'outil `roosync_claudish_cascade`.
 *
 * L'outil est l'INSTRUMENT, pas le décideur. Ces tests verrouillent les deux
 * gardes qui font qu'il ne peut pas abîmer un siège :
 *
 *   1. **`apply` est en `dry_run` PAR DÉFAUT** — écrire le `.env` d'un siège
 *      engage un déploiement ; un oubli de paramètre ne doit rien écrire ;
 *   2. **un hash revendiqué ne confirme RIEN** — `confirm` ne statue que sur
 *      une relecture live, et un consommateur muet est « non couvert », jamais
 *      « aligned ».
 *
 * Plus un canon PÉRIMÉ : une politique de cascade âgée de plusieurs mois ne
 * doit pas réécrire un `.env`. C'est le mode d'échec le plus coûteux du
 * dispositif — un canon mort qui pilote une flotte vivante.
 *
 * @module tools/roosync/__tests__/claudish-cascade
 */

import { describe, test, expect, beforeEach, afterAll } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { decideConfirmVerdict, roosyncClaudishCascade } from '../claudish-cascade.js';
import { cascadeStoreRoot, readLatestCascade } from '../../../services/cascade-store.js';
import { assessCascadeSource } from '../../../services/cascade-sync.js';

const CANON_TEXT = [
    'SONNET = mistral@zai-glm-5-3 > kc@k3',
    'HAIKU = vllm-myia@swift-1.5-27b!own > role:sonnet',
    'ACTIVE = haiku@myia-po-2024',
    'AUTO = 1',
].join('\n');

const READ_AT = '2026-10-30T04:30:00.000Z';

/** Un payload valide est scellé par la source (provenance `hub-live` datée). */
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
    const root = mkdtempSync(join(tmpdir(), 'cascade-tool-'));
    roots.push(root);
    return root;
}

const T0 = '2026-10-30T18:00:00.000Z';

beforeEach(async () => {
    shared = freshRoot();
    process.env.ROOSYNC_SHARED_PATH = shared;
    envPath = join(shared, 'seat.env');
    writeFileSync(envPath, SEAT_ENV_TEXT, 'utf8');
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
    for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('apply — le dry_run par défaut protège le siège', () => {
    test('MUTANT — sans `dry_run:false`, RIEN n’est écrit sur disque', async () => {
        const result = (await roosyncClaudishCascade({
            action: 'apply',
            env_path: envPath,
            now: T0,
        })) as Record<string, unknown>;

        expect(result.applied).toBe(false);
        expect(result.dry_run).toBe(true);
        expect((result.would_write as unknown[]).length).toBeGreaterThan(0);
        // Le fichier est intact, octet pour octet.
        expect(readFileSync(envPath, 'utf8')).toBe(SEAT_ENV_TEXT);
        // Et aucune sauvegarde n'a été créée pour une écriture qui n'a pas eu lieu.
        const backups = join(cascadeStoreRoot(shared), 'backups');
        expect(existsSync(backups) ? readdirSync(backups).length : 0).toBe(0);
    });

    test('`dry_run:false` écrit le .env, préserve le reste, et sauvegarde', async () => {
        const result = (await roosyncClaudishCascade({
            action: 'apply',
            env_path: envPath,
            dry_run: false,
            now: T0,
        })) as Record<string, unknown>;

        expect(result.applied).toBe(true);
        expect(result.backup_id).toBeTruthy();

        const after = readFileSync(envPath, 'utf8');
        // La clé visée a changé…
        expect(after).toContain('CLAUDISH_FAILOVER_SONNET=mistral@zai-glm-5-3>kc@k3');
        // …et tout le reste est là, dans le même ordre.
        expect(after).toContain('# .env du siège — ne pas régénérer');
        expect(after).toContain('ANTHROPIC_API_KEY = sk-ant-do-not-leak');
        expect(after).toContain('CLAUDISH_RELAY_PORT = 3914');
        // Les lignes du siège gardent leur POSITION : seule la clé visée a bougé.
        const before = SEAT_ENV_TEXT.split('\n');
        const afterLines = after.split('\n');
        expect(afterLines[0]).toBe(before[0]);
        expect(afterLines[1]).toBe(before[1]);
        expect(afterLines[3]).toBe(before[3]);
        expect(afterLines[2]).toBe('CLAUDISH_FAILOVER_SONNET=mistral@zai-glm-5-3>kc@k3');
        // Le canon déclare 4 rôles/valeurs : les 3 clés absentes du siège sont
        // AJOUTÉES (et rapportées comme telles, jamais glissées en silence).
        expect((result.appended as string[]).length).toBe(3);
        expect(after.split('\n').length).toBe(SEAT_ENV_TEXT.split('\n').length + 3);

        const backups = join(cascadeStoreRoot(shared), 'backups');
        expect(readdirSync(backups).length).toBe(1);
    });

    test('`backup:false` écrit quand même, sans sauvegarde', async () => {
        const result = (await roosyncClaudishCascade({
            action: 'apply',
            env_path: envPath,
            dry_run: false,
            backup: false,
            now: T0,
        })) as Record<string, unknown>;
        expect(result.applied).toBe(true);
        expect(result.backup_id).toBeNull();
        expect(existsSync(join(cascadeStoreRoot(shared), 'backups'))).toBe(false);
    });

    test('un `.env` absent n’est pas créé par l’instrument', async () => {
        const missing = join(shared, 'nope.env');
        const result = (await roosyncClaudishCascade({
            action: 'apply',
            env_path: missing,
            dry_run: false,
            now: T0,
        })) as Record<string, unknown>;
        expect(result.applied).toBe(false);
        expect(existsSync(missing)).toBe(false);
    });

    test('MUTANT — un canon PÉRIMÉ ne réécrit rien, même en `dry_run:false`', async () => {
        const stale = freshRoot();
        process.env.ROOSYNC_SHARED_PATH = stale;
        const env = join(stale, 'seat.env');
        writeFileSync(env, SEAT_ENV_TEXT, 'utf8');
        await roosyncClaudishCascade({ action: 'publish', payload: PAYLOAD, version: 'v1', now: '2026-01-01T00:00:00.000Z' });

        const result = (await roosyncClaudishCascade({
            action: 'apply',
            env_path: env,
            dry_run: false,
            now: T0,
        })) as Record<string, unknown>;

        expect(result.applied).toBe(false);
        expect(readFileSync(env, 'utf8')).toBe(SEAT_ENV_TEXT);
    });

    test('un siège déjà aligné n’écrit rien (aucune écriture vide)', async () => {
        // Après application, une seconde application est un no-op.
        await roosyncClaudishCascade({ action: 'apply', env_path: envPath, dry_run: false, now: T0 });
        const settled = readFileSync(envPath, 'utf8');
        const again = (await roosyncClaudishCascade({
            action: 'apply',
            env_path: envPath,
            dry_run: false,
            now: T0,
        })) as Record<string, unknown>;
        expect(again.applied).toBe(false);
        expect(readFileSync(envPath, 'utf8')).toBe(settled);
    });
});

describe('publish / list — le canon est un objet versionné', () => {
    test('list rend la version de tête après publication', async () => {
        const listed = (await roosyncClaudishCascade({ action: 'list' })) as Record<string, unknown>;
        expect(listed.store_present).toBe(true);
        expect((listed.latest as { version: string }).version).toBe('v1');
        expect((listed.versions as unknown[]).length).toBe(1);
    });

    test('publish sans payload est refusé, pas silencieusement vide', async () => {
        const result = (await roosyncClaudishCascade({ action: 'publish' })) as Record<string, unknown>;
        expect(result.published).toBe(false);
        expect(String(result.reason)).toMatch(/payload requis/);
    });
});

describe('confirm — la relecture live, et rien d’autre', () => {
    test('MUTANT — un `claimed_hash` est IGNORÉ et ne confirme rien', async () => {
        const result = (await roosyncClaudishCascade({
            action: 'confirm',
            claimed_hash: 'deadbeefdeadbeefdeadbeefdeadbeef',
        })) as Record<string, unknown>;
        expect(result.claimed_hash_ignored).toBe(true);
        expect(result.verdict).toBe('not-covered');
    });

    const base = {
        detail: 'lu',
        aligned: true as boolean | null,
        changes: 0,
        startedAt: T0,
        consumerExpected: 2,
        consumerMatches: true as boolean | null,
    };

    test('table des verdicts — du plus grave au plus favorable', () => {
        expect(decideConfirmVerdict({ ...base, coverage: 'missing', consumer: null })).toBe('not-covered');
        expect(decideConfirmVerdict({ ...base, coverage: 'unreadable', consumer: null })).toBe('not-covered');
        expect(
            decideConfirmVerdict({
                ...base,
                coverage: 'ok',
                consumer: null,
                consumerMatches: null,
            }),
        ).toBe('consumer-muted');
        expect(
            decideConfirmVerdict({
                ...base,
                coverage: 'ok',
                aligned: false,
                consumer: { configured: 2, armed: ['SONNET', 'HAIKU'], auto: '1', raw: '' },
            }),
        ).toBe('divergent');
        expect(
            decideConfirmVerdict({
                ...base,
                coverage: 'ok',
                consumer: { configured: 1, armed: ['SONNET'], auto: '1', raw: '' },
                consumerMatches: false,
            }),
        ).toBe('needs-recreate');
        expect(
            decideConfirmVerdict({
                ...base,
                coverage: 'ok',
                consumer: { configured: 2, armed: ['SONNET', 'HAIKU'], auto: '1', raw: '' },
            }),
        ).toBe('confirmed');
    });

    test('un verdict de confirmation favorable ne relâche jamais la comparaison d’env', () => {
        // env divergent + consommateur muet : le verdict reste « non couvert »,
        // jamais « confirmed » — un parseur muet ne vaut pas un accord.
        expect(decideConfirmVerdict({ ...base, coverage: 'ok', aligned: false, consumer: null, consumerMatches: null })).toBe(
            'consumer-muted',
        );
    });
});

describe('compare / status — trois surfaces, jamais fusionnées', () => {
    test('compare rend les trois surfaces et un verdict', async () => {
        const result = (await roosyncClaudishCascade({
            action: 'compare',
            env_path: envPath,
            now: T0,
        })) as Record<string, unknown>;

        // Le `.env` diverge → needs-apply ; RUNNING n'est pas lu (aucun conteneur).
        expect(result.verdict).toBe('needs-apply');
        const written = result.written as Record<string, unknown>;
        expect(written.coverage).toBe('ok');
        expect(written.aligned).toBe(false);
        expect((written.changes as number)).toBeGreaterThan(0);
        // Aucune valeur de secret ne sort dans le rapport : que des NOMS préservés.
        const serialised = JSON.stringify(result);
        expect(serialised).not.toContain('sk-ant-do-not-leak');
        expect(serialised).toContain('ANTHROPIC_API_KEY');
        const running = result.running as Record<string, unknown>;
        expect(running.coverage).toBe('missing');
        expect(running.aligned).toBeNull();
    });

    test('status d’un siège aligné = aligned, avec un canon frais', async () => {
        await roosyncClaudishCascade({ action: 'apply', env_path: envPath, dry_run: false, now: T0 });
        const result = (await roosyncClaudishCascade({
            action: 'status',
            env_path: envPath,
            now: T0,
        })) as Record<string, unknown>;
        // Écrit aligné ; RUNNING non lu ⇒ partial (jamais « aligned » sans preuve live).
        expect(result.verdict).toBe('partial');
    });

    test('aucun canon publié = not-covered, et rien n’est proposé à l’écriture', async () => {
        const empty = freshRoot();
        process.env.ROOSYNC_SHARED_PATH = empty;
        const env = join(empty, 'seat.env');
        writeFileSync(env, SEAT_ENV_TEXT, 'utf8');
        const result = (await roosyncClaudishCascade({ action: 'status', env_path: env, now: T0 })) as Record<string, unknown>;
        expect(result.verdict).toBe('not-covered');
    });
});

/**
 * #4427 — notes qu'AUCUNE variable d'environnement ne fait lire comme le canon
 * le dit.
 *
 * Rapport po-2025:claudish (27/11) : une note au 2ᵉ barreau et rien au 1ᵉʳ
 * n'arrive sur aucun siège — et rien ne le disait. L'écrivain s'arrête au trou
 * DÉLIBÉRÉMENT (le runtime lit `_NOTE` avec `splitSteps`, qui FILTRE les vides :
 * un `a>>c` décalerait la note sur le mauvais barreau). Ce qui manquait n'est
 * pas l'écriture — c'est la VISIBILITÉ : l'instrument rapporte désormais chaque
 * note laissée de côté, sans jamais inventer de valeur dans le `.env`.
 */
const GAP_NOTE = 'note du 2e barreau';

/** Payload du canon de tête, avec une note au 2ᵉ barreau et rien au 1ᵉʳ. */
function gappedPayload() {
    const gapped = structuredClone(PAYLOAD);
    gapped.roles.SONNET.steps[1].note = GAP_NOTE;
    return gapped;
}

async function publishGapped(): Promise<Record<string, unknown>> {
    const result = (await roosyncClaudishCascade({
        action: 'publish',
        payload: gappedPayload(),
        version: 'v2',
        now: T0,
    })) as Record<string, unknown>;
    expect(result.published).toBe(true);
    return result;
}

describe('notes non représentables — rapportées, jamais inventées', () => {
    test('publish d’un canon à trou RAPPORTE la note laissée de côté', async () => {
        const published = await publishGapped();
        expect(published.unrepresentable_notes).toEqual([
            { role: 'SONNET', index: 1, target: 'kc@k3', note: GAP_NOTE, reason: 'after-hole' },
        ]);
        // Le canon publié garde la note à SA place : rien n'est réécrit pour
        // « réparer » le trou dans le magasin.
        const latest = readLatestCascade(shared);
        expect(latest).not.toBeNull();
        const stored = latest!.payload as { roles: Record<string, { steps: Array<{ note?: string }> }> };
        expect(stored.roles.SONNET.steps[1].note).toBe(GAP_NOTE);
    });

    test('publish sans trou ne porte PAS le champ (état normal, résultat inchangé)', async () => {
        const published = (await roosyncClaudishCascade({
            action: 'publish',
            payload: PAYLOAD,
            version: 'v1',
            now: T0,
        })) as Record<string, unknown>;
        expect(published.idempotent).toBe(true);
        expect('unrepresentable_notes' in published).toBe(false);
    });

    test('apply (dry_run) : la note à trou n’est PAS inventée en `>>`, et elle est rapportée', async () => {
        await publishGapped();
        const result = (await roosyncClaudishCascade({
            action: 'apply',
            env_path: envPath,
            now: T0,
        })) as Record<string, unknown>;
        const keys = (result.would_write as Array<{ key: string }>).map((w) => w.key);
        expect(keys).not.toContain('CLAUDISH_FAILOVER_SONNET_NOTE');
        const dropped = result.unrepresentable_notes as Array<Record<string, unknown>>;
        expect(dropped.map((d) => `${String(d.role)}#${String(d.index)}`)).toEqual(['SONNET#1']);
    });

    test('contrôle négatif : une note de TÊTE est écrite, et rien n’est rapporté', async () => {
        const headNoted = structuredClone(PAYLOAD);
        headNoted.roles.SONNET.steps[0].note = 'raisonne en clair';
        const published = (await roosyncClaudishCascade({
            action: 'publish',
            payload: headNoted,
            version: 'v3',
            now: T0,
        })) as Record<string, unknown>;
        expect('unrepresentable_notes' in published).toBe(false);

        const result = (await roosyncClaudishCascade({
            action: 'apply',
            env_path: envPath,
            now: T0,
        })) as Record<string, unknown>;
        const write = (result.would_write as Array<{ key: string; value: string }>).find(
            (w) => w.key === 'CLAUDISH_FAILOVER_SONNET_NOTE',
        );
        expect(write?.value).toBe('raisonne en clair');
        expect('unrepresentable_notes' in result).toBe(false);
    });

    test('compare et confirm rapportent le trou du canon de tête, sans déplacer le verdict', async () => {
        await publishGapped();

        const compared = (await roosyncClaudishCascade({
            action: 'compare',
            env_path: envPath,
            now: T0,
        })) as Record<string, unknown>;
        expect((compared.unrepresentable_notes as unknown[]).length).toBe(1);
        expect(String(compared.note)).toMatch(/note/);
        // Le verdict reste celui de la comparaison réelle : le diagnostic ne le
        // déplace ni vers le vert ni vers le rouge.
        expect(compared.verdict).toBe('needs-apply');

        const confirmed = (await roosyncClaudishCascade({ action: 'confirm', now: T0 })) as Record<string, unknown>;
        expect((confirmed.unrepresentable_notes as unknown[]).length).toBe(1);
        expect(confirmed.verdict).toBe('not-covered');
    });
});
