/**
 * #4427 — Claudish cascade payload: schema, canon parser, validators.
 *
 * PR1 (borné, schéma+tests) : ce module définit l'UNITÉ versionnée non-secrète
 * qu'une harmonisation de cascade échange entre le hub et les sièges. Rien ici
 * ne lit ni n'écrit de fichier, ne touche Claudish, ni ne décide d'un recreate :
 * c'est l'instrument pur (types + parsing + validations) que les PRs suivants
 * câblent sur collect/publish/compare/apply/confirm.
 *
 * Source de vérité de la forme du payload : le canon live lu par valeur dans le
 * conteneur hub (mesure po-2025 29/10 — valeurs exactes, aucun secret) :
 *
 *   SONNET = mistral@zai-glm-5-3 > kc@k3 > mmc@MiniMax-M3.1-Flash > ...
 *      LABEL     = ... ( parallèle, 1 entrée par barreau )
 *      DIRECTION = ... ( parallèle )
 *      NOTE      = ... ( parallèle )
 *      RESET     = >>>>
 *   OPUS/FABLE/HAIKU = ... (lateral>degraded)
 *   STEP_EXCLUDE = vllm-myia@swift-1.5-27b:myia-ai-01 myia-po-2028
 *   ACTIVE       = haiku@myia-po-2027,haiku@myia-po-2023,...
 *   AUTO = 1
 *   ROLE_MODELS  = glm-5.1:sonnet,... (model:role)
 *   QWEN_THINKING = budget:4096
 *
 * Règles issues de la barre d'acceptation indépendante (po-2027, c.6504913006)
 * et de l'issue #4427 : longueurs parallèles, graphes, exceptions par siège
 * (C2 : un SEUL `:` par entrée STEP_EXCLUDE), allow-list non-secrète, hash
 * canonique recalculé jamais cru (H1).
 */

/** Version du schéma. Bump = les payloads persistés doivent être revalidés. */
export const CASCADE_PAYLOAD_SCHEMA_VERSION = 1 as const;

export type CascadeRoleName = 'SONNET' | 'OPUS' | 'FABLE' | 'HAIKU';
export const CASCADE_ROLE_NAMES: readonly CascadeRoleName[] = ['SONNET', 'OPUS', 'FABLE', 'HAIKU'] as const;

export type CascadeDirection = 'lateral' | 'degraded' | 'improved';

/** Un barreau de cascade : provider@model + ses trois champs positionnels. */
export interface CascadeStep {
    /** `provider@model` — p.ex. `mistral@zai-glm-5-3`. Un seul `@`. */
    ref: string;
    label: string;
    direction: CascadeDirection;
    note: string;
}

export interface CascadeRoleChain {
    /** Chaîne ordonnée de repli (step 0 = préféré). */
    steps: CascadeStep[];
    /** Marqueur de reset du canon (p.ex. `>>>>`). */
    reset: string;
}

/**
 * Exception documentée par siège — #4427 : « documented machine-specific
 * exceptions ». Deux leviers mesurés dans le canon :
 *  - `stepExclude` : `provider@model:machine` — saut de barreau ;
 *  - `activeOverride` : rôle armé/désarmé par machine (`role@machine`).
 */
export interface CascadeSeatException {
    machine: string;
    stepExclude?: string[];
    activeOverride?: string[];
    /** Raison humaine — une exception non documentée n'est pas harmonisable. */
    reason: string;
}

/** Payload complet d'harmonisation de cascade. NON-SECRET par construction. */
export interface CascadePayload {
    schemaVersion: typeof CASCADE_PAYLOAD_SCHEMA_VERSION;
    provenance: {
        /** Un payload ne peut provenir QUE d'une lecture live du hub. */
        source: 'hub-live';
        /** ISO 8601. Un snapshot sans date est un snapshot invérifiable. */
        readAt: string;
        /** instanceId du hub lu — non-secret, ancre la lecture. */
        instanceId?: string;
        /**
         * Hash canonique des valeurs mesurées. INFORMATIF : le validateur le
         * RECALCULE (H1) — un hash revendiqué ne confirme jamais rien.
         */
        snapshotHash?: string;
    };
    roles: Record<CascadeRoleName, CascadeRoleChain>;
    /** `model:role` — p.ex. `glm-5.3:sonnet`. */
    roleModels: Record<string, string>;
    /** `provider@model:machine` — barreaux sautés par machine. */
    stepExclude: string[];
    /** `role@machine` — bras de rôle armés par machine. */
    active: string[];
    auto: number;
    /** P.ex. `budget:4096`. Absent = défaut du code (`disabled`). */
    qwenThinking?: string;
    /** Exceptions par siège — chacune doit porter sa raison. */
    exceptions?: CascadeSeatException[];
}

/** Résultat de validation : jamais d'exception, toujours un verdict daté. */
export interface CascadeValidationResult {
    ok: boolean;
    errors: string[];
    /** Hash canonique RECALCULÉ (présent même si le payload est invalide). */
    canonicalHash?: string;
}

// ---------------------------------------------------------------------------
// Canon textuel → payload (parseur)
// ---------------------------------------------------------------------------

/** Lignes du canon : `ROLE = a@b > c@d` + blocs positionnels indentés. */
export function parseCascadeCanon(text: string): { payload: CascadePayload | null; errors: string[] } {
    const errors: string[] = [];
    const roles: Partial<Record<CascadeRoleName, { refs: string[]; labels: string[]; directions: string[]; notes: string[]; reset: string }>> = {};
    const scalars: Record<string, string> = {};

    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;

        // Bloc positionnel indenté (LABEL/DIRECTION/NOTE/RESET sous un rôle).
        const positional = line.match(/^(LABEL|DIRECTION|NOTE|RESET)\s*=\s*(.*)$/i);
        if (positional) {
            const key = positional[1].toUpperCase();
            const value = positional[2].trim();
            const owner = lastDeclaredRole(roles);
            if (!owner) {
                errors.push(`positional ${key} avant toute déclaration de rôle`);
                continue;
            }
            const entry = roles[owner as CascadeRoleName]!;
            if (key === 'RESET') {
                entry.reset = value;
            } else if (key === 'LABEL') {
                entry.labels = value.split('>').map(s => s.trim()).filter(s => s.length > 0);
            } else if (key === 'DIRECTION') {
                entry.directions = value.split('>').map(s => s.trim()).filter(s => s.length > 0);
            } else {
                entry.notes = value.split('>').map(s => s.trim()).filter(s => s.length > 0);
            }
            continue;
        }

        // Scalaire global (STEP_EXCLUDE, ACTIVE, AUTO, ROLE_MODELS, QWEN_THINKING).
        const scalar = line.match(/^(STEP_EXCLUDE|ACTIVE|AUTO|ROLE_MODELS|QWEN_THINKING)\s*=\s*(.*)$/);
        if (scalar) {
            scalars[scalar[1]] = scalar[2].trim();
            continue;
        }

        // Déclaration de rôle : `ROLE = ref > ref > ...`.
        const roleDecl = line.match(/^([A-Z]+)\s*=\s*(.+)$/);
        if (roleDecl) {
            const name = roleDecl[1].toUpperCase();
            if (!(CASCADE_ROLE_NAMES as readonly string[]).includes(name)) {
                errors.push(`rôle inconnu « ${name} »`);
                continue;
            }
            roles[name as CascadeRoleName] = {
                refs: roleDecl[2].split('>').map(s => s.trim()).filter(s => s.length > 0),
                labels: [], directions: [], notes: [], reset: '',
            };
            continue;
        }

        errors.push(`ligne non reconnue : « ${line} »`);
    }

    if (errors.length > 0) return { payload: null, errors };

    const payload: CascadePayload = {
        schemaVersion: CASCADE_PAYLOAD_SCHEMA_VERSION,
        provenance: { source: 'hub-live', readAt: '' }, // daté par l'appelant, pas par le texte
        roles: {} as Record<CascadeRoleName, CascadeRoleChain>,
        roleModels: {},
        stepExclude: [],
        active: [],
        auto: scalars.AUTO ? Number(scalars.AUTO) : 0,
    };

    for (const name of CASCADE_ROLE_NAMES) {
        const entry = roles[name];
        if (!entry) continue;
        const steps: CascadeStep[] = entry.refs.map((ref, i) => ({
            ref,
            label: entry.labels[i] ?? '',
            direction: (entry.directions[i] ?? 'lateral') as CascadeDirection,
            note: entry.notes[i] ?? '',
        }));
        payload.roles[name] = { steps, reset: entry.reset };
    }

    // ROLE_MODELS = model:role,model:role
    if (scalars.ROLE_MODELS) {
        for (const pair of scalars.ROLE_MODELS.split(',').map(s => s.trim()).filter(Boolean)) {
            const idx = pair.lastIndexOf(':');
            if (idx <= 0) { errors.push(`ROLE_MODELS entrée invalide « ${pair} »`); continue; }
            payload.roleModels[pair.slice(0, idx)] = pair.slice(idx + 1);
        }
    }

    // STEP_EXCLUDE / ACTIVE : séparateurs distincts mesurés dans le canon —
    // espace pour STEP_EXCLUDE, virgule pour ACTIVE.
    if (scalars.STEP_EXCLUDE) {
        payload.stepExclude = scalars.STEP_EXCLUDE.split(' ').map(s => s.trim()).filter(Boolean);
    }
    if (scalars.ACTIVE) {
        payload.active = scalars.ACTIVE.split(',').map(s => s.trim()).filter(Boolean);
    }
    if (scalars.QWEN_THINKING) {
        payload.qwenThinking = scalars.QWEN_THINKING;
    }

    if (errors.length > 0) return { payload: null, errors };
    return { payload, errors: [] };
}

function lastDeclaredRole(
    roles: Partial<Record<CascadeRoleName, { refs: string[] }>>,
): CascadeRoleName | null {
    const declared = CASCADE_ROLE_NAMES.filter(n => roles[n] !== undefined);
    return declared.length > 0 ? declared[declared.length - 1] : null;
}

// ---------------------------------------------------------------------------
// Validations (avant toute écriture — #4427 « reject before write »)
// ---------------------------------------------------------------------------

/** Patterns sécrêts — allow-list NON-secrète : la moindre correspondance rejette. */
const SECRET_PATTERNS: Array<{ re: RegExp; name: string }> = [
    { re: /\bsk-[A-Za-z0-9]{16,}/, name: 'clé API sk-…' },
    { re: /\bghp_[A-Za-z0-9]{20,}/, name: 'token GitHub' },
    { re: /\bgho_[A-Za-z0-9]{20,}/, name: 'token GitHub OAuth' },
    { re: /\b(API_KEY|SECRET|TOKEN|PASSWORD|PASSPHRASE)\s*[:=]/i, name: 'assignation de secret' },
    { re: /\b(Bearer|Basic)\s+[A-Za-z0-9+/=]{20,}/i, name: 'header d\'authentification' },
];

/** Clés top-level autorisées — toute autre clé = refus (allow-list stricte). */
const ALLOWED_TOP_LEVEL = new Set([
    'schemaVersion', 'provenance', 'roles', 'roleModels',
    'stepExclude', 'active', 'auto', 'qwenThinking', 'exceptions',
]);

const DIRECTION_SET = new Set(['lateral', 'degraded', 'improved']);

/**
 * Valide un payload complet. Pur : aucune IO. Le hash canonique est RECALCULÉ
 * puis comparé au hash revendiqué (H1) — jamais l'inverse.
 */
export function validateCascadePayload(payload: unknown): CascadeValidationResult {
    const errors: string[] = [];

    if (typeof payload !== 'object' || payload === null) {
        return { ok: false, errors: ['payload n\'est pas un objet'] };
    }
    const p = payload as Record<string, unknown>;

    for (const key of Object.keys(p)) {
        if (!ALLOWED_TOP_LEVEL.has(key)) {
            errors.push(`clé top-level hors allow-list : « ${key} »`);
        }
    }

    if (p.schemaVersion !== CASCADE_PAYLOAD_SCHEMA_VERSION) {
        errors.push(`schemaVersion ${String(p.schemaVersion)} != ${CASCADE_PAYLOAD_SCHEMA_VERSION}`);
    }

    const prov = p.provenance as CascadePayload['provenance'] | undefined;
    if (!prov || prov.source !== 'hub-live') {
        errors.push('provenance.source doit être « hub-live » (jamais un checkout périmé)');
    }
    if (!prov?.readAt || Number.isNaN(Date.parse(prov.readAt))) {
        errors.push('provenance.readAt absent ou non ISO');
    }

    // Secrets : le texte entier du payload est balayé, champ par champ.
    scanForSecrets(p, '', errors);

    // Rôles : structure, longueurs (structurelles ici), graphe.
    const roles = (p.roles ?? {}) as Record<string, CascadeRoleChain>;
    let anyRole = false;
    for (const name of CASCADE_ROLE_NAMES) {
        const chain = roles[name];
        if (!chain) continue;
        anyRole = true;
        if (!Array.isArray(chain.steps) || chain.steps.length === 0) {
            errors.push(`rôle ${name} : chaîne vide`);
            continue;
        }
        const seen = new Set<string>();
        for (const step of chain.steps) {
            if (!step?.ref || !/^[^@\s]+@[^@\s]+$/.test(step.ref)) {
                errors.push(`rôle ${name} : ref de barreau invalide « ${String(step?.ref)} » (attendu provider@model)`);
            }
            if (seen.has(step.ref)) {
                errors.push(`rôle ${name} : barreau dupliqué « ${step.ref} »`);
            }
            seen.add(step.ref);
            if (step.direction !== undefined && !DIRECTION_SET.has(step.direction)) {
                errors.push(`rôle ${name} : direction inconnue « ${String(step.direction)} »`);
            }
        }
        if (!chain.reset) {
            errors.push(`rôle ${name} : RESET absent`);
        }
    }
    if (!anyRole) errors.push('aucun rôle déclaré (SONNET/OPUS/FABLE/HAIKU)');

    // STEP_EXCLUDE : `provider@model:machine` avec UN SEUL `:` (C2).
    const allRefs = new Set<string>();
    for (const name of CASCADE_ROLE_NAMES) {
        for (const s of roles[name]?.steps ?? []) allRefs.add(s.ref);
    }
    const stepExclude = (p.stepExclude ?? []) as string[];
    for (const entry of stepExclude) {
        const colons = (entry.match(/:/g) ?? []).length;
        if (colons !== 1) {
            errors.push(`STEP_EXCLUDE « ${entry} » : ${colons} « : » (exactement 1 attendu — C2)`);
            continue;
        }
        const [ref, machine] = entry.split(':');
        if (!allRefs.has(ref)) {
            errors.push(`STEP_EXCLUDE « ${entry} » : barreau « ${ref} » inconnu des rôles`);
        }
        if (!machine || !/^myia-[a-z0-9-]+$/i.test(machine)) {
            errors.push(`STEP_EXCLUDE « ${entry} » : machine « ${String(machine)} » invalide`);
        }
    }

    // ACTIVE : `role@machine`.
    const active = (p.active ?? []) as string[];
    for (const entry of active) {
        const at = (entry.match(/@/g) ?? []).length;
        if (at !== 1 || !entry.split('@')[0]) {
            errors.push(`ACTIVE « ${entry} » : format role@machine attendu`);
            continue;
        }
        const [role] = entry.split('@');
        if (!(CASCADE_ROLE_NAMES as readonly string[]).includes(role.toUpperCase())) {
            errors.push(`ACTIVE « ${entry} » : rôle « ${role} » inconnu`);
        }
    }

    // ROLE_MODELS : valeurs ∈ rôles valides.
    const roleModels = (p.roleModels ?? {}) as Record<string, string>;
    for (const [model, role] of Object.entries(roleModels)) {
        if (!(CASCADE_ROLE_NAMES as readonly string[]).includes(String(role).toUpperCase())) {
            errors.push(`ROLE_MODELS[${model}] : rôle « ${String(role)} » inconnu`);
        }
    }

    // Exceptions par siège : chacune DOIT porter une raison (documentée ou rien).
    const exceptions = (p.exceptions ?? []) as CascadeSeatException[];
    for (const ex of exceptions) {
        if (!ex?.machine) errors.push('exception sans machine');
        if (!ex?.reason || String(ex.reason).trim().length === 0) {
            errors.push(`exception ${ex?.machine ?? '?'} : raison absente (une exception non documentée n'est pas harmonisable)`);
        }
        for (const e of ex.stepExclude ?? []) {
            if (!stepExclude.includes(e)) {
                errors.push(`exception ${ex.machine} : STEP_EXCLUDE « ${e} » absent du canon global`);
            }
        }
    }

    // H1 — le hash revendiqué est recalculé, jamais cru.
    let canonicalHash: string | undefined;
    if (errors.length === 0) {
        canonicalHash = computeCanonicalHash(p as unknown as CascadePayload);
        if (prov.snapshotHash && prov.snapshotHash !== canonicalHash) {
            errors.push(`snapshotHash revendiqué ≠ hash canonique recalculé (H1 : un hash revendiqué ne confirme jamais)`);
        }
    }

    return { ok: errors.length === 0, errors, canonicalHash };
}

function scanForSecrets(node: unknown, path: string, errors: string[]): void {
    if (typeof node === 'string') {
        for (const { re, name } of SECRET_PATTERNS) {
            if (re.test(node)) {
                errors.push(`valeur secrète (${name}) à « ${path || '(racine)'} »`);
            }
        }
        return;
    }
    if (Array.isArray(node)) {
        node.forEach((v, i) => scanForSecrets(v, `${path}[${i}]`, errors));
        return;
    }
    if (typeof node === 'object' && node !== null) {
        for (const [k, v] of Object.entries(node)) {
            scanForSecrets(v, path ? `${path}.${k}` : k, errors);
        }
    }
}

// ---------------------------------------------------------------------------
// Hash canonique
// ---------------------------------------------------------------------------

/**
 * Hash canonique : stable, indépendant de l'ordre des clés et des exceptions
 * (les exceptions sont PAR SIÈGE, pas partie de la valeur canon). FNV-1a 32 bits
 * ×4 sur un JSON trié — déterministe sans dépendance crypto du poste.
 */
export function computeCanonicalHash(payload: CascadePayload): string {
    const canonical = canonicalizeForHash(payload);
    const text = JSON.stringify(canonical);
    return fnv1a32hex(fnv1a32hex(fnv1a32hex(fnv1a32hex(text))));
}

function canonicalizeForHash(payload: CascadePayload): unknown {
    return {
        schemaVersion: payload.schemaVersion,
        roles: sortDeep(payload.roles),
        roleModels: sortDeep(payload.roleModels),
        stepExclude: [...payload.stepExclude].sort(),
        active: [...payload.active].sort(),
        auto: payload.auto,
        ...(payload.qwenThinking !== undefined ? { qwenThinking: payload.qwenThinking } : {}),
    };
}

function sortDeep<T>(value: T): T {
    if (Array.isArray(value)) {
        return value.map(sortDeep) as unknown as T;
    }
    if (typeof value === 'object' && value !== null) {
        const out: Record<string, unknown> = {};
        for (const k of Object.keys(value as Record<string, unknown>).sort()) {
            out[k] = sortDeep((value as Record<string, unknown>)[k]);
        }
        return out as unknown as T;
    }
    return value;
}

function fnv1a32hex(input: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
        h ^= input.charCodeAt(i);
        // FNV prime 16777619 en deux shifts-additions (précision 32 bits).
        h = (h + ((h << 1) >>> 0) + ((h << 4) >>> 0) + ((h << 7) >>> 0) + ((h << 8) >>> 0) + ((h << 24) >>> 0)) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
}
