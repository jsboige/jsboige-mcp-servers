/**
 * `roosync_claudish_cascade` — #4427 PR3, câblage de l'instrument de cascade.
 *
 * L'outil est l'INSTRUMENT, jamais le décideur : il ne choisit aucune politique
 * de cascade, ne recrée aucun conteneur et n'écrit sur aucun siège dont il
 * n'est pas le propriétaire. Le propriétaire du siège applique ; le recreate
 * reste chez l'exécuteur côté propriétaire (spec, § Le partage de propriété).
 *
 * Trois états, jamais fusionnés (spec, § Trois états) :
 *
 * - **INTENDED** — le canon publié dans le magasin partagé ;
 * - **WRITTEN** — le `.env` sur disque (ce que `compose` interprétera au
 *   prochain `create`) ;
 * - **RUNNING** / **CONSUMER** — l'env que le conteneur a reçu, et ce que son
 *   parseur a retenu. Seul le second prouve une confirmation.
 *
 * Deux gardes de conception, testées :
 *
 * 1. **`apply` est en `dry_run` PAR DÉFAUT.** Écrire le `.env` d'un siège est
 *    un geste qui engage un déploiement ; il se demande explicitement
 *    (`dry_run: false`), il ne s'hérite pas d'un oubli.
 * 2. **Un hash revendiqué ne confirme JAMAIS** — `confirm` relit le conteneur.
 *    Le champ `claimed_hash` est accepté, marqué ignoré, et n'entre jamais
 *    dans le verdict.
 *
 * @module tools/roosync/claudish-cascade
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { hostname } from 'os';
import { join } from 'path';
import { z } from 'zod';
import { getSharedStatePath, ensureStoreSubdir } from '../../utils/shared-state-path.js';
import {
    assessCascadePayload,
    assessCascadeSource,
    compareCascadeEnv,
    parseCascadeEnv,
    planCascadeApply,
    CascadeBackupStore,
    DEFAULT_CASCADE_MAX_AGE_MS,
    type CascadeComparison,
    type CascadeSourceSnapshot,
} from '../../services/cascade-sync.js';
import {
    cascadeStoreRoot,
    listCascadeVersions,
    publishCascadeCanon,
    readLatestCascade,
    readLatestCascadePointer,
} from '../../services/cascade-store.js';
import { readCascadeContainer, type CascadeContainerReading } from '../../services/cascade-container.js';
import { applyCascadeWrites } from '../../services/cascade-env-writer.js';

export const ClaudishCascadeArgsSchema = z.object({
    action: z.enum(['collect', 'publish', 'compare', 'apply', 'confirm', 'status', 'list']),
    payload: z.unknown().optional(),
    version: z.string().min(1).max(64).optional(),
    env_path: z.string().min(1).optional(),
    container: z.string().min(1).optional(),
    dry_run: z.boolean().optional(),
    backup: z.boolean().optional(),
    max_age_ms: z.number().int().positive().optional(),
    claimed_hash: z.string().optional(),
    now: z.string().optional(),
});

export type ClaudishCascadeArgs = z.infer<typeof ClaudishCascadeArgsSchema>;

/** Identité du siège — `machine` seule : la cascade est une politique de machine. */
function seatId(): string {
    return (process.env.COMPUTERNAME ?? hostname()).toLowerCase();
}

interface SeatEnvReading {
    coverage: 'ok' | 'missing' | 'unreadable';
    detail: string;
    path: string | null;
    text: string;
    env: Record<string, string>;
}

/**
 * Lit le `.env` du siège. Le chemin vient de l'appelant : une cascade n'invente
 * jamais l'emplacement d'un fichier de configuration — un chemin deviné
 * écrirait au mauvais endroit.
 */
function readSeatEnv(envPath: string | undefined): SeatEnvReading {
    if (!envPath) {
        return {
            coverage: 'missing',
            detail: 'env_path absent — le chemin du .env du siège est fourni par l’appelant (jamais deviné)',
            path: null,
            text: '',
            env: {},
        };
    }
    if (!existsSync(envPath)) {
        return { coverage: 'missing', detail: `fichier absent : ${envPath}`, path: envPath, text: '', env: {} };
    }
    try {
        const text = readFileSync(envPath, 'utf8');
        return { coverage: 'ok', detail: `lu : ${envPath}`, path: envPath, text, env: parseCascadeEnv(text) };
    } catch (error) {
        return {
            coverage: 'unreadable',
            detail: `lecture impossible : ${(error as Error).message}`,
            path: envPath,
            text: '',
            env: {},
        };
    }
}

/**
 * Évalue le canon de tête du magasin partagé.
 *
 * Le canon stocké est un PAYLOAD : le re-parser comme du texte n'aurait aucun
 * sens (et rendrait `invalid` sur tout canon valide). Il passe donc par
 * `assessCascadePayload`, qui applique la même politique de fraîcheur que la
 * lecture textuelle du hub — une seule politique, deux entrées.
 */
function assessPublishedCanon(sharedStatePath: string, maxAgeMs: number, now: string): CascadeSourceSnapshot {
    const latest = readLatestCascade(sharedStatePath);
    if (!latest) {
        return assessCascadeSource({
            source: 'canon publié',
            text: null,
            readAt: now,
            maxAgeMs,
            now,
        });
    }
    return assessCascadePayload({
        source: `canon ${readLatestCascadePointer(sharedStatePath)?.version ?? '?'}`,
        payload: latest.payload,
        readAt: latest.readAt,
        verifiedAt: latest.verifiedAt,
        maxAgeMs,
        now,
        text: latest.text,
    });
}

/**
 * Verdict de comparaison, par surface.
 *
 * `needs-apply` (le `.env` diverge) et `needs-recreate` (le `.env` est bon mais
 * le conteneur porte autre chose) ne sont PAS interchangeables : docker compose
 * fige `environment:` au `create`, donc écrire le fichier ne déploie rien.
 */
export type CascadeVerdict = 'aligned' | 'needs-apply' | 'needs-recreate' | 'partial' | 'not-covered';

interface SurfaceSummary {
    coverage: string;
    detail: string;
}

interface WrittenSurface extends SurfaceSummary {
    aligned: boolean;
    changes: number;
    unchanged: number;
    /** Clés du siège hors cascade : noms + motif, jamais de valeur. */
    preserved: Array<{ key: string; reason: string }>;
    writes: Array<{ key: string; value: string; before: string | null }>;
    reasons: string[];
}

interface RunningSurface extends SurfaceSummary {
    aligned: boolean | null;
    changes: number;
    startedAt: string | null;
    consumer: CascadeContainerReading['consumer'];
    /** `configured` du parseur vs nombre de rôles porteurs du canon. */
    consumerExpected: number;
    consumerMatches: boolean | null;
}

function summariseWritten(
    canon: CascadeSourceSnapshot,
    seatEnv: SeatEnvReading,
): WrittenSurface {
    if (seatEnv.coverage !== 'ok') {
        return {
            coverage: seatEnv.coverage,
            detail: seatEnv.detail,
            aligned: false,
            changes: 0,
            unchanged: 0,
            preserved: [],
            writes: [],
            reasons: [seatEnv.detail],
        };
    }
    const plan = planCascadeApply(canon, seatEnv.env);
    return {
        coverage: plan.coverage,
        detail: plan.reasons.length > 0 ? plan.reasons.join(' | ') : 'comparé au canon',
        aligned: plan.coverage === 'ok' && plan.changes.length === 0 && plan.reasons.length === 0,
        changes: plan.changes.length,
        unchanged: plan.unchanged,
        preserved: plan.preserved,
        writes: plan.writes.map((w) => ({ key: w.key, value: w.value, before: w.before })),
        reasons: plan.reasons,
    };
}

function countCarryingRoles(canon: CascadeSourceSnapshot): number {
    const payload = canon.payload;
    if (!payload) return 0;
    return Object.values(payload.roles).filter((chain) => chain && chain.steps.length > 0).length;
}

function summariseRunning(
    canon: CascadeSourceSnapshot,
    reading: CascadeContainerReading | null,
): RunningSurface {
    const consumerExpected = countCarryingRoles(canon);
    if (!reading) {
        return {
            coverage: 'missing',
            detail: 'conteneur non lu (aucun nom fourni) — RUNNING et CONSUMER restent NON COUVERTS',
            aligned: null,
            changes: 0,
            startedAt: null,
            consumer: null,
            consumerExpected,
            consumerMatches: null,
        };
    }
    let aligned: boolean | null = null;
    let changes = 0;
    if (reading.coverage === 'ok' && canon.covered) {
        const comparison: CascadeComparison = compareCascadeEnv(canon.env, reading.env);
        changes = comparison.changes.length;
        aligned = changes === 0;
    }
    // Un consommateur muet, ou un canon sans rôle porteur, ne se juge pas :
    // `null` (non couvert) n'est ni un accord ni un désaccord.
    const consumerMatches =
        reading.consumer === null || consumerExpected === 0
            ? null
            : reading.consumer.configured === consumerExpected;
    return {
        coverage: reading.coverage,
        detail: reading.detail,
        aligned,
        changes,
        startedAt: reading.startedAt,
        consumer: reading.consumer,
        consumerExpected,
        consumerMatches,
    };
}

export function decideVerdict(canon: CascadeSourceSnapshot, written: WrittenSurface, running: RunningSurface): CascadeVerdict {
    if (!canon.covered) return 'not-covered';
    if (!written.aligned) return 'needs-apply';
    if (running.coverage === 'ok' && running.aligned === false) return 'needs-recreate';
    if (running.coverage !== 'ok') return 'partial';
    return 'aligned';
}

/** Verdict d'une CONFIRMATION — toujours sur la relecture LIVE. */
export type CascadeConfirmVerdict = 'confirmed' | 'not-covered' | 'divergent' | 'consumer-muted' | 'needs-recreate';

/**
 * Confronte la relecture live au canon.
 *
 * Ordre des verdicts, du plus grave au plus favorable — et `consumer-muted`
 * n'est PAS un succès : sans ligne de parseur, l'env reçu ne prouve pas
 * l'acceptation (spec, § Trois états). Un hash revendiqué n'entre jamais ici :
 * la fonction ne prend que des lectures.
 */
export function decideConfirmVerdict(running: RunningSurface): CascadeConfirmVerdict {
    if (running.coverage !== 'ok') return 'not-covered';
    if (running.consumer === null) return 'consumer-muted';
    if (running.aligned === false) return 'divergent';
    if (running.consumerMatches === false) return 'needs-recreate';
    return 'confirmed';
}

export async function roosyncClaudishCascade(rawArgs: unknown): Promise<Record<string, unknown>> {
    const args = ClaudishCascadeArgsSchema.parse(rawArgs ?? {});
    const now = args.now ?? new Date().toISOString();
    const maxAgeMs = args.max_age_ms ?? DEFAULT_CASCADE_MAX_AGE_MS;
    // Fail-closed : sans racine de magasin, aucune opération de canon n'a de sens.
    const sharedStatePath = getSharedStatePath();
    const storeRoot = cascadeStoreRoot(sharedStatePath);
    const seat = seatId();

    if (args.action === 'list') {
        const pointer = readLatestCascadePointer(sharedStatePath);
        return {
            action: 'list',
            seat,
            store_root: storeRoot,
            store_present: existsSync(storeRoot),
            latest: pointer,
            versions: listCascadeVersions(sharedStatePath),
        };
    }

    if (args.action === 'publish') {
        if (args.payload === undefined) {
            return { action: 'publish', seat, published: false, reason: 'payload requis pour publish' };
        }
        const outcome = publishCascadeCanon({ sharedStatePath, payload: args.payload, version: args.version, now });
        return { action: 'publish', seat, ...outcome };
    }

    if (args.action === 'collect') {
        if (!args.container) {
            return {
                action: 'collect',
                seat,
                coverage: 'missing',
                detail: 'container requis — un nom de conteneur fourni par l’appelant, jamais déduit de l’environnement',
                env: {},
            };
        }
        const reading = readCascadeContainer({ container: args.container });
        return {
            action: 'collect',
            seat,
            coverage: reading.coverage,
            detail: reading.detail,
            source: reading.source,
            started_at: reading.startedAt,
            consumer: reading.consumer,
            env: reading.env,
            ...(reading.coverage !== 'ok'
                ? { note: 'une lecture impossible n’est pas un payload vide — rien à publier depuis cette lecture' }
                : {}),
        };
    }

    // compare / status / apply / confirm partagent l'évaluation du canon.
    const canon = assessPublishedCanon(sharedStatePath, maxAgeMs, now);

    if (args.action === 'compare' || args.action === 'status') {
        const seatEnv = readSeatEnv(args.env_path);
        const written = summariseWritten(canon, seatEnv);
        const reading = args.container ? readCascadeContainer({ container: args.container }) : null;
        const running = summariseRunning(canon, reading);
        return {
            action: args.action,
            seat,
            verdict: decideVerdict(canon, written, running),
            canon: {
                coverage: canon.coverage,
                detail: canon.detail,
                version: readLatestCascadePointer(sharedStatePath)?.version ?? null,
                published_at: readLatestCascadePointer(sharedStatePath)?.publishedAt ?? null,
                hash: canon.canonicalHash,
                age_ms: canon.provenance.ageMs,
            },
            written: { ...written, path: seatEnv.path },
            running,
        };
    }

    if (args.action === 'apply') {
        const seatEnv = readSeatEnv(args.env_path);
        if (seatEnv.coverage !== 'ok') {
            return { action: 'apply', seat, applied: false, reason: seatEnv.detail, written: { coverage: seatEnv.coverage } };
        }
        const plan = planCascadeApply(canon, seatEnv.env);
        if (!plan.applicable) {
            return {
                action: 'apply',
                seat,
                applied: false,
                reason: plan.reasons.length > 0 ? plan.reasons.join(' | ') : 'aucune écriture à appliquer',
                coverage: plan.coverage,
                reasons: plan.reasons,
                preserved: plan.preserved,
                unchanged: plan.unchanged,
                source_hash: plan.sourceHash,
            };
        }
        const outcome = applyCascadeWrites(seatEnv.text, plan.writes);
        // dry_run par DÉFAUT : écrire le .env engage un déploiement.
        const dryRun = args.dry_run !== false;
        const wantsBackup = args.backup !== false;
        if (dryRun) {
            return {
                action: 'apply',
                seat,
                applied: false,
                dry_run: true,
                coverage: plan.coverage,
                would_write: plan.writes,
                appended: outcome.appended,
                preserved: plan.preserved,
                unchanged: plan.unchanged,
                source_hash: plan.sourceHash,
                deployment: 'aucun — dry_run ; le recreate du conteneur appartient au propriétaire du siège',
                note: 'écrire exige dry_run:false explicitement',
            };
        }
        let backupId: string | null = null;
        if (wantsBackup) {
            ensureStoreSubdir(storeRoot, 'backups');
            const store = new CascadeBackupStore(join(storeRoot, 'backups'));
            const record = await store.backup(plan, seat, now);
            backupId = record.backupId;
        }
        writeFileSync(seatEnv.path as string, outcome.text, 'utf8');
        return {
            action: 'apply',
            seat,
            applied: true,
            dry_run: false,
            coverage: plan.coverage,
            written: outcome.written,
            appended: outcome.appended,
            preserved: plan.preserved,
            unchanged: plan.unchanged,
            backup_id: backupId,
            source_hash: plan.sourceHash,
            deployment: 'recreate requis pour que l’env entre dans le conteneur — geste du propriétaire du siège, jamais automatique ici',
        };
    }

    // confirm — relecture LIVE. Un hash revendiqué ne compte jamais.
    const reading = args.container ? readCascadeContainer({ container: args.container }) : null;
    const running = summariseRunning(canon, reading);
    const claimedIgnored = args.claimed_hash !== undefined;
    const verdict = decideConfirmVerdict(running);
    return {
        action: 'confirm',
        seat,
        verdict,
        canon_hash: canon.canonicalHash,
        claimed_hash_ignored: claimedIgnored,
        claimed_hash_note: claimedIgnored
            ? 'un hash revendiqué ne confirme jamais rien — seul le relecture live compte'
            : undefined,
        running,
    };
}
