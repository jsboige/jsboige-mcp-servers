/**
 * Service de synchronisation de cascade Claudish — #4427 (PR2).
 *
 * RÈGLE DE RÉFÉRENCE : le PARSER RUNTIME fait foi, pas le canon. La grammaire
 * des variables d'environnement est lue dans `failover.ts` (runtime Claudish) :
 *   - `CLAUDISH_FAILOVER_<ROLE>`         = cibles, séparées par `>` ;
 *   - `CLAUDISH_FAILOVER_<ROLE>_LABEL`   = étiquettes, positionnelles ;
 *   - `CLAUDISH_FAILOVER_<ROLE>_DIRECTION`= directions, positionnelles ;
 *   - `CLAUDISH_FAILOVER_<ROLE>_NOTE`    = notes, positionnelles ;
 *   - `CLAUDISH_FAILOVER_<ROLE>_RESET`   = dates ISO, positionnelles ;
 *   - `CLAUDISH_FAILOVER_STEP_EXCLUDE`   = entrées `cible:machines`, séparées par `,` ;
 *   - `CLAUDISH_FAILOVER_ACTIVE`         = `role` ou `role@machine`, séparés par `,`/espace ;
 *   - `CLAUDISH_FAILOVER_ROLE_MODELS`    = `model:role`, séparés par `,` ;
 *   - `CLAUDISH_FAILOVER_AUTO`           = 1/true/yes/on.
 *
 * PR1 (`cascade-payload.ts`) a livré le CONTRAT : payload versionné, parseur du
 * canon textuel, validateurs « reject before write ». PR2 livre l'INSTRUMENT :
 * évaluer la fraîcheur d'une lecture, comparer des VALEURS CONCRÈTES, produire
 * un plan d'écriture borné, et sauvegarder/rétablir l'état précédent.
 *
 * CE QUE PR2 NE FAIT PAS (volontairement) :
 *   - il n'écrit jamais sur un siège : l'APPLY est un geste propriétaire du
 *     siège (« each seat owns application » — #4427, AC « Respect workspace
 *     ownership and approvals ») ; le service produit le plan, pas l'écriture ;
 *   - il ne lit pas le hub : la LECTURE LIVE vient d'une source attestée
 *     (PR3), ici le service prend un texte de canon déjà lu + sa provenance ;
 *   - il ne publie jamais un `.env` complet : seules des NOMS de clés
 *     préservées sont rapportées, jamais leur valeur.
 */

import { createHash } from 'crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import {
    CASCADE_ROLE_NAMES,
    CascadePayload,
    computeCanonicalHash,
    parseCascadeCanon,
    validateCascadePayload,
} from './cascade-payload.js';

/** Préfixe des variables de cascade lues par le runtime. */
export const CASCADE_ENV_PREFIX = 'CLAUDISH_FAILOVER_';

/**
 * Les SEULES clés que l'harmonisation peut écrire. Toute autre clé du `.env`
 * d'un siège est préservée par construction — la liste est fermée, pas filtrée
 * a posteriori (une liste de patterns laisserait passer un cas nouveau).
 */
export const CASCADE_WRITABLE_KEYS: readonly string[] = [
    ...CASCADE_ROLE_NAMES.map((r) => `${CASCADE_ENV_PREFIX}${r}`),
    ...CASCADE_ROLE_NAMES.map((r) => `${CASCADE_ENV_PREFIX}${r}_LABEL`),
    ...CASCADE_ROLE_NAMES.map((r) => `${CASCADE_ENV_PREFIX}${r}_DIRECTION`),
    ...CASCADE_ROLE_NAMES.map((r) => `${CASCADE_ENV_PREFIX}${r}_NOTE`),
    ...CASCADE_ROLE_NAMES.map((r) => `${CASCADE_ENV_PREFIX}${r}_RESET`),
    `${CASCADE_ENV_PREFIX}STEP_EXCLUDE`,
    `${CASCADE_ENV_PREFIX}ACTIVE`,
    `${CASCADE_ENV_PREFIX}ROLE_MODELS`,
    `${CASCADE_ENV_PREFIX}AUTO`,
];

const WRITABLE_KEY_SET = new Set(CASCADE_WRITABLE_KEYS);

/** Âge maximal par défaut d'une lecture de cascade (24 h). */
export const DEFAULT_CASCADE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Tolérance de dérive d'horloge (5 min).
 *
 * Une lecture datée LÉGÈREMENT dans le futur est tolérée (NTP, arrondi,
 * saisies à la seconde) : ce n'est pas un indice d'incohérence. Au-delà, la
 * date est INCRÉDIBLE — elle ne prouve pas la fraîcheur, elle la contredit :
 * la lecture est alors `invalid`, donc NON harmonisée.
 */
export const CASCADE_CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * Motifs de clés préservées — #4427 AC : « Do not overwrite credentials,
 * proxy keys, client login, relay upstream, ports, binds, capture locations or
 * unrelated .env values ». Ces clés sont RAPPORTÉES (nom + motif), jamais
 * leur valeur.
 */
export const SEAT_PRESERVED_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
    { pattern: /(API_KEY|SECRET|TOKEN|PASSWORD|PASSPHRASE|PRIVATE_KEY|CREDENTIAL)/i, reason: 'credential' },
    { pattern: /(PROXY_KEY|CLIENT_LOGIN|LOGIN|USERNAME)/i, reason: 'proxy key or client login' },
    // Le motif port/bind passe AVANT relay : `CLAUDISH_RELAY_PORT` est un PORT,
    // pas un upstream — le motif le plus spécifique doit gagner.
    { pattern: /(^|_)(PORT|PORT_BINDS?|BIND|HOST|ADDRESS|ENDPOINT)$/i, reason: 'port, bind or endpoint' },
    { pattern: /(RELAY|UPSTREAM|BACKEND)/i, reason: 'relay upstream' },
    { pattern: /CAPTURE/i, reason: 'capture location' },
];

/** Couverture d'une lecture de cascade : ce qui n'est pas `ok` n'est PAS harmonisé. */
export type CascadeCoverage = 'missing' | 'empty' | 'stale' | 'invalid' | 'ok';

export interface CascadeSourceInput {
    /** Étiquette de la source (ex. `hub po-2025`, `canon 29/10`). */
    source: string;
    /** Texte du canon lu (null = lecture impossible). */
    text?: string | null;
    /** ISO 8601 — quand la lecture a eu lieu. */
    readAt: string;
    /** ISO 8601 — le `VERIFIED` du canon lu (s'il y en a un). */
    verifiedAt?: string | null;
    /** instanceId du hub lu — non-secret, ancre la lecture. */
    instanceId?: string;
    /** Politique de fraîcheur (défaut 24 h). */
    maxAgeMs?: number;
    /** Horloge injectable (tests). */
    now?: string;
}

/**
 * Entrée de l'évaluation PAR PAYLOAD : même politique que la lecture textuelle,
 * pour un canon déjà constitué (magasin partagé, capture enregistrée).
 */
export interface AssessCascadePayloadInput {
    /** Étiquette de la source (ex. `canon v3`). */
    source: string;
    /** Payload brut — VALIDÉ ici, jamais fait confiance. */
    payload: unknown;
    /** ISO 8601 — quand la lecture a eu lieu (date de publication du canon). */
    readAt: string;
    /** ISO 8601 — le `VERIFIED` du canon lu (s'il y en a un). */
    verifiedAt?: string | null;
    /** instanceId du hub lu — non-secret, ancre la lecture. */
    instanceId?: string;
    /** Politique de fraîcheur (défaut 24 h). */
    maxAgeMs?: number;
    /** Horloge injectable (tests). */
    now?: string;
    /** Texte d'origine quand il existe : scelle `provenance.contentHash`. */
    text?: string | null;
}

export interface CascadeSourceSnapshot {
    covered: boolean;
    coverage: CascadeCoverage;
    detail: string;
    payload: CascadePayload | null;
    canonicalHash: string | null;
    /** Valeurs d'environnement ATTENDUES, rendues depuis le payload. */
    env: Record<string, string>;
    provenance: {
        source: string;
        readAt: string;
        verifiedAt: string | null;
        instanceId?: string;
        contentHash: string | null;
        ageMs: number | null;
    };
}

export interface CascadeEnvChange {
    /** Nom de la variable d'environnement. */
    key: string;
    kind: 'added' | 'removed' | 'modified';
    before: string | null;
    after: string | null;
    /**
     * La valeur porteuse a gardé sa cardinalité (même nombre d'éléments, contenu
     * différent) — un changement de MÊME cardinalité qu'un simple compte ne
     * révèle pas.
     */
    sameCardinality: boolean;
    /** Détail par élément quand la valeur est une liste `>`-séparée. */
    elements?: Array<{ index: number; before: string | null; after: string | null }>;
}

export interface CascadeComparison {
    covered: boolean;
    coverage: CascadeCoverage;
    changes: CascadeEnvChange[];
    /** Nombre de clés de cascade identiques des deux côtés. */
    unchanged: number;
    sourceHash: string | null;
    targetHash: string | null;
}

export interface CascadePreservedKey {
    key: string;
    reason: string;
}

export interface CascadeWrite {
    key: string;
    value: string;
    before: string | null;
}

export interface CascadeApplyPlan {
    applicable: boolean;
    coverage: CascadeCoverage;
    /** Raisons pour lesquelles le plan ne s'applique pas (verdict non-`ok`). */
    reasons: string[];
    changes: CascadeEnvChange[];
    /** Écritures proposals — UNIQUEMENT des clés de cascade. */
    writes: CascadeWrite[];
    /** Clés du siège que l'harmonisation ne touche pas (nom + motif, sans valeur). */
    preserved: CascadePreservedKey[];
    unchanged: number;
    sourceHash: string | null;
    targetHash: string | null;
}

export interface CascadeBackupRecord {
    backupId: string;
    createdAt: string;
    seat: string;
    payloadHash: string | null;
    /** Valeurs AVANT écriture — UNIQUEMENT les clés que le plan aurait écrites. */
    previous: Array<{ key: string; value: string | null }>;
}

// ---------------------------------------------------------------------------
// Lecture d'un `.env` (lecture seule, jamais de réécriture)
// ---------------------------------------------------------------------------

/**
 * Parse un `.env` en paires clé/valeur. Lit SEULEMENT ; ne réécrit jamais.
 * Les secrets lus ici ne sont jamais restitués : seuls les NOMS de clés
 * préservées sortent du service.
 */
export function parseCascadeEnv(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq <= 0) continue;
        const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
        let value = line.slice(eq + 1).trim();
        if (
            (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
            (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
        ) {
            value = value.slice(1, -1);
        }
        out[key] = value;
    }
    return out;
}

/** Sous-ensemble des variables de cascade d'un `.env` de siège. */
export function extractCascadeEnv(env: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const key of Object.keys(env)) {
        if (WRITABLE_KEY_SET.has(key)) out[key] = env[key];
    }
    return out;
}

/** Clés du siège qui ne font PAS partie de la cascade — classées par motif. */
export function findPreservedKeys(env: Record<string, string>): CascadePreservedKey[] {
    const out: CascadePreservedKey[] = [];
    for (const key of Object.keys(env)) {
        if (WRITABLE_KEY_SET.has(key)) continue;
        for (const { pattern, reason } of SEAT_PRESERVED_PATTERNS) {
            if (pattern.test(key)) {
                out.push({ key, reason });
                break;
            }
        }
    }
    return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Source : évaluation de fraîcheur + rendu des valeurs attendues
// ---------------------------------------------------------------------------

function sha256(text: string): string {
    return createHash('sha256').update(text, 'utf8').digest('hex');
}

function ageMsBetween(nowIso: string, thenIso: string | null | undefined): number | null {
    if (!thenIso) return null;
    const now = Date.parse(nowIso);
    const then = Date.parse(thenIso);
    if (Number.isNaN(now) || Number.isNaN(then)) return null;
    return now - then;
}

/**
 * Évalue un PAYLOAD de cascade déjà constitué (canon publié, capture datée).
 *
 * Même politique que `assessCascadeSource` — fraîcheur fail-closed, skew
 * d'horloge borné, valeurs rendues par `renderCascadeEnv` — mais sans passer par
 * le parseur de texte : un canon stocké est un payload, pas un fragment à
 * re-parser. Les deux entrées partagent CE corps, pour qu'il n'existe jamais
 * deux politiques de fraîcheur qui dérivent l'une de l'autre.
 */
export function assessCascadePayload(input: AssessCascadePayloadInput): CascadeSourceSnapshot {
    const now = input.now ?? new Date().toISOString();
    const maxAgeMs = input.maxAgeMs ?? DEFAULT_CASCADE_MAX_AGE_MS;
    const provenance = {
        source: input.source,
        readAt: input.readAt,
        verifiedAt: input.verifiedAt ?? null,
        instanceId: input.instanceId,
        contentHash: input.text ? sha256(input.text) : null,
        ageMs: null as number | null,
    };

    const fail = (coverage: CascadeCoverage, detail: string): CascadeSourceSnapshot => ({
        covered: false,
        coverage,
        detail,
        payload: null,
        canonicalHash: null,
        env: {},
        provenance,
    });

    const validation = validateCascadePayload(input.payload);
    if (!validation.ok) {
        return fail('invalid', `canon invalide : ${validation.errors.join(' ; ')}`);
    }
    const payload = input.payload as CascadePayload;
    const canonicalHash = validation.canonicalHash ?? computeCanonicalHash(payload);

    // La fraîcheur est un CONTRAT fail-closed : une lecture dont l'horodatage
    // est illisible n'est PAS « fraîche par défaut » — elle est INVALIDE, donc
    // non harmonisée. Un `verifiedAt` non parsable, un horodatage absent, ou une
    // date dans le futur au-delà de la tolérance d'horloge rendent tous la
    // lecture NON VÉRIFIABLE : la signaler vaut mieux que l'harmoniser.
    const stampIso: string | null | undefined = input.verifiedAt ?? input.readAt;
    const ageMs = ageMsBetween(now, stampIso);
    provenance.ageMs = ageMs;

    if (ageMs === null) {
        return fail(
            'invalid',
            `horodatage illisible (${stampIso ?? 'absent'}) — la lecture n'est pas datable, donc pas vérifiable`,
        );
    }

    if (ageMs < -CASCADE_CLOCK_SKEW_TOLERANCE_MS) {
        return fail(
            'invalid',
            `lecture datée dans le futur (${stampIso}, ${Math.round(-ageMs / 1000)} s d'avance) — horloge non fiable`,
        );
    }

    if (ageMs > maxAgeMs) {
        return {
            covered: false,
            coverage: 'stale',
            detail: `lecture périmée (${Math.round(ageMs / 3600000)} h > ${Math.round(maxAgeMs / 3600000)} h max) pour la source « ${input.source} »`,
            payload,
            canonicalHash,
            env: {},
            provenance,
        };
    }

    return {
        covered: true,
        coverage: 'ok',
        detail: `lecture fraîche de la source « ${input.source} »`,
        payload,
        canonicalHash,
        env: renderCascadeEnv(payload),
        provenance,
    };
}

/**
 * Évalue une lecture de cascade et rend les valeurs ATTENDUES.
 *
 * Un snapshot `missing` / `empty` / `stale` / `invalid` n'est PAS harmonisé :
 * il est rapporté comme tel (`covered: false`). Le service ne « complète »
 * jamais un canon manquant — un harmonisation sur une lecture périmée ou
 * invalide propagerait une dérive au lieu de la signaler.
 */
export function assessCascadeSource(input: CascadeSourceInput): CascadeSourceSnapshot {
    const now = input.now ?? new Date().toISOString();
    const maxAgeMs = input.maxAgeMs ?? DEFAULT_CASCADE_MAX_AGE_MS;
    const provenance = {
        source: input.source,
        readAt: input.readAt,
        verifiedAt: input.verifiedAt ?? null,
        instanceId: input.instanceId,
        contentHash: null as string | null,
        ageMs: null as number | null,
    };

    const fail = (coverage: CascadeCoverage, detail: string): CascadeSourceSnapshot => ({
        covered: false,
        coverage,
        detail,
        payload: null,
        canonicalHash: null,
        env: {},
        provenance,
    });

    if (input.text === null || input.text === undefined) {
        return fail('missing', `aucune lecture pour la source « ${input.source} »`);
    }
    if (input.text.trim() === '') {
        return fail('empty', `lecture vide pour la source « ${input.source} »`);
    }

    const parsed = parseCascadeCanon(input.text);
    if (!parsed.payload) {
        return fail('invalid', `canon illisible : ${parsed.errors.join(' ; ') || 'aucune valeur'}`);
    }

    // Le parseur laisse `provenance.readAt` VIDE (« daté par l'appelant, pas par
    // le texte ») : c'est ici que la lecture est datée. Sans cet horodatage, un
    // canon serait « hub-live » mais non daté — donc invérifiable.
    const payload: CascadePayload = {
        ...parsed.payload,
        provenance: {
            source: 'hub-live',
            readAt: input.readAt,
            ...(input.instanceId ? { instanceId: input.instanceId } : {}),
        },
    };

    return assessCascadePayload({
        source: input.source,
        payload,
        readAt: input.readAt,
        verifiedAt: input.verifiedAt ?? null,
        instanceId: input.instanceId,
        maxAgeMs,
        now,
        text: input.text,
    });
}

/**
 * Rend les variables d'environnement equivalents à un payload.
 *
 * Fidélité au runtime : `_RESET` est POSITIONNEL (une case vide vaut « pas de
 * reset pour CE step » — le runtime ne filtre PAS les vides sur cette variable,
 * contrairement aux labels) ; `_LABEL` / `_DIRECTION` / `_NOTE` ne sont émis
 * que s'ils portent une information (une étiquette qui retombe sur la cible,
 * une direction par défaut, une note absente ne doivent pas créer une
 * différence fictive entre deux configurations équivalentes).
 */
export function renderCascadeEnv(payload: CascadePayload): Record<string, string> {
    const env: Record<string, string> = {};

    for (const role of CASCADE_ROLE_NAMES) {
        const chain = payload.roles[role];
        if (!chain || chain.steps.length === 0) continue;
        const steps = chain.steps;

        env[`${CASCADE_ENV_PREFIX}${role}`] = steps
            .map((s) => (s.class === 'own' ? `${s.ref}!own` : s.ref))
            .join('>');

        // Le runtime retombe sur la CIBLE quand l'étiquette est absente
        // (`labels[i] ?? target`) : un label manquant ne doit pas rendre la
        // chaîne littérale « undefined » dans une variable d'environnement.
        const labels = steps.map((s) => (typeof s.label === 'string' ? s.label : s.ref));
        if (labels.some((l, i) => l !== steps[i].ref)) {
            env[`${CASCADE_ENV_PREFIX}${role}_LABEL`] = labels.join('>');
        }
        const directions = steps.map((s) => s.direction);
        if (directions.some((d) => d !== 'degraded')) {
            env[`${CASCADE_ENV_PREFIX}${role}_DIRECTION`] = directions.join('>');
        }
        const notes = steps.map((s) => s.note ?? '');
        // Le runtime lit les notes avec `splitSteps` (les VIDES sont filtrés) :
        // une note ne peut donc être représentée que comme un PRÉFIXE contigu.
        // Un trou (note au step 2, rien au step 1) n'est pas représentable — on
        // s'arrête au trou plutôt que de décaler silencieusement les notes.
        let notePrefix = 0;
        while (notePrefix < notes.length && notes[notePrefix] !== '') notePrefix += 1;
        if (notePrefix > 0) {
            env[`${CASCADE_ENV_PREFIX}${role}_NOTE`] = notes.slice(0, notePrefix).join('>');
        }
        const resets = steps.map((s) => s.resetAt ?? '');
        if (resets.some((r) => r !== '')) {
            env[`${CASCADE_ENV_PREFIX}${role}_RESET`] = resets.join('>');
        }
    }

    if (payload.stepExclude.length > 0) {
        env[`${CASCADE_ENV_PREFIX}STEP_EXCLUDE`] = payload.stepExclude
            .map((e) => `${e.stepTarget}:${e.machines.join(' ')}`)
            .join(',');
    }
    if (payload.active.length > 0) {
        env[`${CASCADE_ENV_PREFIX}ACTIVE`] = payload.active.join(',');
    }
    const roleModels = Object.entries(payload.roleModels ?? {});
    if (roleModels.length > 0) {
        env[`${CASCADE_ENV_PREFIX}ROLE_MODELS`] = roleModels
            .map(([model, role]) => `${model}:${role}`)
            .join(',');
    }
    env[`${CASCADE_ENV_PREFIX}AUTO`] = String(payload.auto);

    return env;
}

// ---------------------------------------------------------------------------
// Comparaison de VALEURS CONCRÈTES
// ---------------------------------------------------------------------------

function splitChain(value: string): string[] {
    return value.split('>').map((s) => s.trim()).filter((s) => s !== '');
}

/**
 * Compare les valeurs attendues et les valeurs du siège, clé par clé.
 *
 * Deux propriétés exigées par #4427 :
 *   - on compare des VALEURS, pas des comptes : une liste de même cardinalité
 *     dont un élément change est un `modified` à cardinalité constante ;
 *   - une clé absente d'un côté et présente de l'autre est un `added` /
 *     `removed` (les listes de valeurs n'ont pas de cardinalité comparable).
 */
export function compareCascadeEnv(
    sourceEnv: Record<string, string>,
    seatEnv: Record<string, string>,
): CascadeComparison {
    const changes: CascadeEnvChange[] = [];
    let unchanged = 0;
    const keys = new Set<string>([...Object.keys(sourceEnv), ...Object.keys(seatEnv)]);

    for (const key of [...keys].sort()) {
        const before = Object.prototype.hasOwnProperty.call(seatEnv, key) ? seatEnv[key] : null;
        const after = Object.prototype.hasOwnProperty.call(sourceEnv, key) ? sourceEnv[key] : null;
        if (before === after) {
            unchanged += 1;
            continue;
        }
        const kind: CascadeEnvChange['kind'] =
            before === null ? 'added' : after === null ? 'removed' : 'modified';
        const beforeParts = before === null ? [] : splitChain(before);
        const afterParts = after === null ? [] : splitChain(after);
        const sameCardinality = beforeParts.length === afterParts.length;
        const elements: CascadeEnvChange['elements'] = [];
        for (let i = 0; i < Math.max(beforeParts.length, afterParts.length); i++) {
            const b = beforeParts[i] ?? null;
            const a = afterParts[i] ?? null;
            if (b !== a) elements.push({ index: i, before: b, after: a });
        }
        changes.push({ key, kind, before, after, sameCardinality, elements });
    }

    return {
        covered: true,
        coverage: 'ok',
        changes,
        unchanged,
        sourceHash: null,
        targetHash: null,
    };
}

// ---------------------------------------------------------------------------
// Plan d'application (dry-run) — borné, non destructif
// ---------------------------------------------------------------------------

/**
 * Produit le plan d'harmonisation d'un siège : ce qui SERAIT écrit, ce qui
 * serait conservé, ce qui diffère.
 *
 * Le plan n'écrit rien. Les écritures portent EXCLUSIVEMENT sur des clés de
 * cascade ; les credentials, clés de proxy, logins, upstreams, ports, binds et
 * emplacements de capture sont rapportés (nom + motif) et laissés intacts.
 *
 * Une divergence NON ÉCRIVABLE — une clé de cascade que la source retire —
 * n'est jamais passée sous silence : elle est rendue dans `reasons`, avec la
 * clé concernée. Un plan « non applicable, aucune raison » se lirait comme
 * « rien à faire » alors que le siège porte une clé que la source ne veut
 * plus.
 */
export function planCascadeApply(
    source: CascadeSourceSnapshot,
    seatEnv: Record<string, string>,
): CascadeApplyPlan {
    const reasons: string[] = [];
    if (!source.covered) {
        reasons.push(`${source.coverage} : ${source.detail}`);
        return {
            applicable: false,
            coverage: source.coverage,
            reasons,
            changes: [],
            writes: [],
            preserved: findPreservedKeys(seatEnv),
            unchanged: 0,
            sourceHash: source.canonicalHash,
            targetHash: null,
        };
    }

    const seatCascade = extractCascadeEnv(seatEnv);
    const comparison = compareCascadeEnv(source.env, seatCascade);
    const writes: CascadeWrite[] = [];

    for (const change of comparison.changes) {
        if (change.kind === 'removed') {
            // Une clé retirée par la source EST une divergence réelle du siège.
            // Ce plan n'écrit que des VALEURS (borné, non destructif) : la
            // suppression n'est donc pas planifiable ici. Elle est RAPPORTÉE
            // comme raison explicite — le silence la lirait comme « rien à
            // faire » alors que le siège porte une clé que la source ne veut
            // plus.
            reasons.push(
                `clé de cascade retirée par la source : ${change.key} — suppression non planifiable par ce plan (écriture de valeur uniquement) ; à traiter par le propriétaire du siège`,
            );
            continue;
        }
        const value = change.after ?? '';
        if (!WRITABLE_KEY_SET.has(change.key)) continue; // garde : jamais une clé hors allow-list
        writes.push({ key: change.key, value, before: change.before });
    }

    return {
        applicable: writes.length > 0,
        coverage: source.coverage,
        reasons,
        changes: comparison.changes,
        writes,
        preserved: findPreservedKeys(seatEnv),
        unchanged: comparison.unchanged,
        sourceHash: source.canonicalHash,
        targetHash: hashEnv(seatCascade),
    };
}

function hashEnv(env: Record<string, string>): string {
    const canonical = Object.keys(env)
        .sort()
        .map((k) => `${k}=${env[k]}`)
        .join('\n');
    return sha256(canonical);
}

// ---------------------------------------------------------------------------
// Sauvegarde / rétablissement (état d'un siège, hors secrets)
// ---------------------------------------------------------------------------

/**
 * Magasin de sauvegardes d'un plan de cascade.
 *
 * Une sauvegarde ne contient QUE les clés que le plan aurait écrites, avec
 * leurs valeurs précédentes : c'est le strict nécessaire pour rétablir l'état,
 * sans jamais conserver un instantané du `.env` complet (les secrets du siège
 * n'entrent pas dans le magasin).
 */
export class CascadeBackupStore {
    private readonly dir: string;

    constructor(dir: string) {
        this.dir = dir;
    }

    private pathFor(backupId: string): string {
        return `${this.dir}/${backupId}.json`;
    }

    /** Crée une sauvegarde de l'état précédent (les clés du plan uniquement). */
    async backup(plan: CascadeApplyPlan, seat: string, now: string): Promise<CascadeBackupRecord> {
        const backupId = `cascade-${now.replace(/[:.]/g, '-')}-${hashEnv({ seed: seat + now }).slice(0, 8)}`;
        const record: CascadeBackupRecord = {
            backupId,
            createdAt: now,
            seat,
            payloadHash: plan.sourceHash,
            previous: plan.writes.map((w) => ({ key: w.key, value: w.before })),
        };
        mkdirSync(this.dir, { recursive: true });
        writeFileSync(this.pathFor(backupId), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
        return record;
    }

    /** Liste les identifiants de sauvegarde, du plus récent au plus ancien. */
    list(): string[] {
        if (!existsSync(this.dir)) return [];
        return readdirSync(this.dir)
            .filter((f) => f.startsWith('cascade-') && f.endsWith('.json'))
            .map((f) => f.replace(/\.json$/, ''))
            .sort()
            .reverse();
    }

    /** Relit une sauvegarde. */
    load(backupId: string): CascadeBackupRecord | null {
        const p = this.pathFor(backupId);
        if (!existsSync(p)) return null;
        try {
            return JSON.parse(readFileSync(p, 'utf8')) as CascadeBackupRecord;
        } catch {
            return null;
        }
    }

    /**
     * Rend la carte de rétablissement : les valeurs AVANT, à réécrire par
     * l'exécuteur propriétaire du siège. L'écriture reste hors du RSM —
     * « each seat owns application ».
     */
    restoreMap(backupId: string): Record<string, string | null> | null {
        const record = this.load(backupId);
        if (!record) return null;
        const out: Record<string, string | null> = {};
        for (const entry of record.previous) out[entry.key] = entry.value;
        return out;
    }
}
