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
    let lastScalarKey: string | null = null;

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
            } else {
                // `>>>>` en fin de NOTE colle au texte du dernier barreau : la
                // découpe sur '>' produit des fragments vides de QUEUE qu'on
                // retire (ils viennent du marqueur, pas de barreaux manquants).
                const parts = value.split('>').map(s => s.trim());
                while (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
                const filtered = parts.filter(s => s.length > 0);
                if (key === 'LABEL') entry.labels = filtered;
                else if (key === 'DIRECTION') entry.directions = filtered;
                else entry.notes = filtered;
            }
            continue;
        }

        // Scalaire global (STEP_EXCLUDE, ACTIVE, AUTO, ROLE_MODELS, QWEN_THINKING).
        const scalar = line.match(/^(STEP_EXCLUDE|ACTIVE|AUTO|ROLE_MODELS|QWEN_THINKING)\s*=\s*(.*)$/);
        if (scalar) {
            scalars[scalar[1]] = scalar[2].trim();
            lastScalarKey = scalar[1];
            continue;
        }

        // Continuation de scalaire : le canon publié wrappe les valeurs longues
        // (ROLE_MODELS sur deux lignes, virgule finale en fin de première).
        // Une ligne sans `=` à valeur continuée est concaténée, pas rejetée.
        if (lastScalarKey && !line.includes('=') && /^[A-Za-z0-9@:._\-+,!/ ]+$/.test(line)) {
            scalars[lastScalarKey] = `${scalars[lastScalarKey]},${line}`.replace(/,\s*,/g, ',');
            continue;
        }
        lastScalarKey = null;

        // Déclaration de rôle : `ROLE = ref > ref > ...` avec directions
        // INLINE optionnelles entre parenthèses en fin de ligne — forme des
        // rôles courts du canon réel (mesure po-2025 29/10) :
        //   `HAIKU = vllm-myia@swift-1.5-27b!own > role:sonnet   (degraded>improved)`
        const roleDecl = line.match(/^([A-Z]+)\s*=\s*([^(]*?)\s*(?:\(([^)]*)\))?$/);
        if (roleDecl) {
            const name = roleDecl[1].toUpperCase();
            if (!(CASCADE_ROLE_NAMES as readonly string[]).includes(name)) {
                errors.push(`rôle inconnu « ${name} »`);
                continue;
            }
            const refs = roleDecl[2].split('>').map(s => s.trim()).filter(s => s.length > 0);
            const inlineDirections = (roleDecl[3] ?? '')
                .split('>').map(s => s.trim()).filter(s => s.length > 0);
            roles[name as CascadeRoleName] = {
                refs,
                labels: [],
                directions: inlineDirections,
                notes: [],
                reset: '',
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
        // #4427 « reject inconsistent lengths before write » : chaque bloc
        // positionnel déclaré doit couvrir EXACTEMENT la chaîne (longueur
        // égale) OU être un scalaire partagé (longueur 1, diffusé à tous les
        // barreaux — forme du NOTE réel du canon : une note commune + RESET).
        for (const [field, values] of [
            ['LABEL', entry.labels],
            ['DIRECTION', entry.directions],
            ['NOTE', entry.notes],
        ] as const) {
            if (values.length === 0) continue; // absent (directions inline p.ex.)
            if (values.length !== entry.refs.length && values.length !== 1) {
                errors.push(
                    `rôle ${name} : ${field} a ${values.length} entrées pour ${entry.refs.length} barreaux`,
                );
            }
        }
        const steps: CascadeStep[] = entry.refs.map((ref, i) => ({
            ref,
            label: entry.labels.length === 1 ? entry.labels[0] : entry.labels[i] ?? '',
            direction: (entry.directions.length === 1
                ? entry.directions[0]
                : entry.directions[i] ?? 'lateral') as CascadeDirection,
            note: entry.notes.length === 1 ? entry.notes[0] : entry.notes[i] ?? '',
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
 * Ref de barreau valide — trois formes mesurées dans le canon live :
 *  - `provider@model`            (mistral@zai-glm-5-3)
 *  - `provider@model!own`        (vllm-myia@swift-1.5-27b!own — ressource propre)
 *  - `role:<rôle>`               (role:sonnet — indirection vers une autre chaîne)
 */
export const STEP_REF_RE = /^(?:[^@\s]+@[^@\s]+!own|[^@\s]+@[^@\s]+|role:[a-z]+)$/;

/** Nom de machine flotte — `myia-*`. */
export const MACHINE_RE = /^myia-[a-z0-9-]+$/i;

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
            if (!step?.ref || !STEP_REF_RE.test(step.ref)) {
                errors.push(`rôle ${name} : ref de barreau invalide « ${String(step?.ref)} » (attendu provider@model, provider@model!own ou role:<rôle>)`);
            }
            if (seen.has(step.ref)) {
                errors.push(`rôle ${name} : barreau dupliqué « ${step.ref} »`);
            }
            seen.add(step.ref);
            if (step.direction !== undefined && !DIRECTION_SET.has(step.direction)) {
                errors.push(`rôle ${name} : direction inconnue « ${String(step.direction)} »`);
            }
        }
        // RESET : mesuré dans le canon live, SEUL le bloc SONNET étendu porte
        // un RESET — les rôles courts (OPUS/FABLE/HAIKU) n'en ont pas. Le
        // marqueur est capturé quand présent, jamais exigé.
    }
    if (!anyRole) errors.push('aucun rôle déclaré (SONNET/OPUS/FABLE/HAIKU)');

    // STEP_EXCLUDE : deux formes mesurées dans le canon réel (po-2025 29/10) —
    // `provider@model:machine` (saut du barreau pour la machine, UN SEUL `:`
    // — C2) ou machine nue (la machine saute le barreau du contexte, p.ex.
    // `myia-po-2028` sous `vllm-myia@…`). Plus d'un `:` = refus : la ligne
    // écrite serait ambigüe pour le consommateur.
    // Graphe — ensemble des barreaux, en ref COMPLÈTE et en ref BASE (sans le
    // suffixe `!own`) : le canon réel cite `vllm-myia@swift-1.5-27b` dans
    // STEP_EXCLUDE alors que le barreau déclaré est `…!own` — les deux formes
    // désignent le même barreau.
    const allRefs = new Set<string>();
    for (const name of CASCADE_ROLE_NAMES) {
        for (const s of roles[name]?.steps ?? []) {
            allRefs.add(s.ref);
            if (s.ref.endsWith('!own')) allRefs.add(s.ref.slice(0, -'!own'.length));
        }
    }
    const stepExclude = (p.stepExclude ?? []) as string[];
    for (const entry of stepExclude) {
        const colons = (entry.match(/:/g) ?? []).length;
        if (colons > 1) {
            errors.push(`STEP_EXCLUDE « ${entry} » : ${colons} « : » (0 ou 1 attendu — C2)`);
            continue;
        }
        if (colons === 1) {
            const [ref, machine] = entry.split(':');
            if (!allRefs.has(ref)) {
                errors.push(`STEP_EXCLUDE « ${entry} » : barreau « ${ref} » inconnu des rôles`);
            }
            if (!machine || !MACHINE_RE.test(machine)) {
                errors.push(`STEP_EXCLUDE « ${entry} » : machine « ${String(machine)} » invalide`);
            }
        } else if (!MACHINE_RE.test(entry)) {
            errors.push(`STEP_EXCLUDE « ${entry} » : ni provider@model:machine ni machine nue valide`);
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

    // AUTO : 0/1 entier (drapeau du canon).
    if (typeof p.auto !== 'number' || !Number.isInteger(p.auto) || p.auto < 0 || p.auto > 1) {
        errors.push(`auto doit être 0 ou 1 (reçu : ${String(p.auto)})`);
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
        if (prov?.snapshotHash && prov.snapshotHash !== canonicalHash) {
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
    // Quatre tours SALÉS concaténés (4 × 32 bits) : les collisions FNV sur des
    // documents courts ne surviennent que tour par tour, pas sur les quatre.
    return [1, 2, 3, 4].map(i => fnv1a32hex(`${i}:${text}`)).join('');
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
