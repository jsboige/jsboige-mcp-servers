/**
 * #4427 — Claudish cascade payload: schema, canon parser, validators.
 *
 * PR1 (borné, schéma+tests) : ce module définit l'UNITÉ versionnée non-secrète
 * qu'une harmonisation de cascade échange entre le hub et les sièges. Rien ici
 * ne lit ni n'écrit de fichier, ne touche Claudish, ni ne décide d'un recreate :
 * c'est l'instrument pur (types + parsing + validations) que les PRs suivants
 * câblent sur collect/publish/compare/apply/confirm.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * RÈGLE DE RÉFÉRENCE : le PARSER RUNTIME fait foi, pas le canon.
 * ══════════════════════════════════════════════════════════════════════════
 * Chaque règle de grammaire est calquée sur `packages/cli/src/fork/failover.ts`
 * (le code qui lit `CLAUDISH_FAILOVER_*` au boot du proxy Claudish) :
 *
 *  - `splitSteps` (labels/directions/notes) : split sur '>' puis FILTRE les
 *    vides → une valeur SCALAIRE n'atteint que le STEP 0. Pas de diffusion.
 *  - `parseStepResets` : split sur '>' SANS filtrer → le RESET est
 *    POSITIONNEL (une case vide compte), et c'est une date ISO par step.
 *  - `splitStepClass` : le suffixe `!own` est une CLASSE, pas une partie du
 *    nom de cible ; la cible reste `provider@model`.
 *  - `CLAUDISH_FAILOVER_STEP_EXCLUDE` : les ENTRÉES sont séparées par `,`,
 *    la cible est ce qui précède le DERNIER `:`, et les machines d'une entrée
 *    sont séparées par `/[\s,]+`.
 *  - `CLAUDISH_FAILOVER_ACTIVE` : split sur `/[,\s]+/`, pièce `role` ou
 *    `role@machine`, rôle obligatoirement connu.
 *  - `parseDirection` : `improved | degraded | lateral`, défaut `degraded`.
 *  - `parseRoleRef` : `role:<rôle>` — le rôle doit exister.
 *  - `delegationAcyclic` : le graphe de délégation `role:` ne doit pas boucler.
 *
 * Un canon n'est PAS un cas particulier du runtime : c'est le runtime qui
 * définit ce qu'un canon veut dire. (Le fixture doré ne peut pas arbitrer.)
 *
 * Forme du canon live lue par valeur dans le conteneur hub (po-2025 29/10) :
 *
 *   SONNET = mistral@zai-glm-5-3 > kc@k3 > mmc@MiniMax-M3.1-Flash > ...
 *      LABEL     = ... ( positionnel, 1 entrée par barreau )
 *      DIRECTION = ... ( positionnel )
 *      NOTE      = ... ( positionnel )
 *      RESET     = >>>>
 *   OPUS/FABLE/HAIKU = ... (directions inline entre parenthèses)
 *   STEP_EXCLUDE = vllm-myia@swift-1.5-27b:myia-ai-01 myia-po-2028
 *   ACTIVE       = haiku@myia-po-2027,haiku@myia-po-2023,...
 *   AUTO = 1
 *   ROLE_MODELS  = glm-5.1:sonnet,... (model:role)
 *   QWEN_THINKING = budget:4096
 */

/** Version du schéma. Bump = les payloads persistés doivent être revalidés. */
export const CASCADE_PAYLOAD_SCHEMA_VERSION = 1 as const;

export type CascadeRoleName = 'SONNET' | 'OPUS' | 'FABLE' | 'HAIKU';
export const CASCADE_ROLE_NAMES: readonly CascadeRoleName[] = ['SONNET', 'OPUS', 'FABLE', 'HAIKU'] as const;

/**
 * Rôles du runtime Claudish (`failover.ts: FAILOVER_ROLES`). Un `role:` qui
 * pointe ailleurs est refusé au LOAD par le runtime lui-même.
 */
const RUNTIME_ROLES: readonly string[] = ['opus', 'sonnet', 'haiku', 'fable'];

export type CascadeDirection = 'lateral' | 'degraded' | 'improved';

const DIRECTION_SET = new Set<string>(['lateral', 'degraded', 'improved']);

/** Le runtime retombe sur « degraded » (failover.ts: parseDirection). */
const DEFAULT_DIRECTION: CascadeDirection = 'degraded';

/**
 * Un barreau de cascade — les valeurs sont les valeurs EFFECTIVES, c'est-à-dire
 * celles que le runtime lira (`failover.ts: loadRules`) :
 *  - `label` = `labels[i] ?? target` (le runtime retombe sur la CIBLE) ;
 *  - `direction` = `parseDirection(directions[i])` (défaut `degraded`) ;
 *  - `note` = `notes[i]`, ABSENTE si le step n'a pas de note (pas de diffusion) ;
 *  - `resetAt` = date ISO positionnelle (`parseStepResets`).
 */
export interface CascadeStep {
    /** Cible du barreau, suffixe de classe retiré : `provider@model` ou `role:<rôle>`. */
    ref: string;
    /** Classe `own` (suffixe `!own` du canon), si déclarée. */
    class?: 'own';
    /** Étiquette effective (chute sur la cible si absente). */
    label: string;
    /** Direction effective. */
    direction: CascadeDirection;
    /** Note effective du step — absente si le canon n'en déclare pas pour CE step. */
    note?: string;
    /** Reset positionnel du step (ISO 8601), si déclaré. */
    resetAt?: string;
}

export interface CascadeRoleChain {
    /** Chaîne ordonnée de repli (step 0 = préféré). */
    steps: CascadeStep[];
}

/**
 * Exclusion par machine — le RUNTIME lit une entrée
 * `<stepTarget>:<machine> [<machine>…]` (cible = avant le DERNIER ':'), et la
 * cible doit correspondre à un barreau DÉCLARÉ. La forme plate `string[]` ne
 * pouvait pas exprimer ce regroupement : une exclusion par machines se perdait
 * silencieusement au round-trip.
 */
export interface CascadeStepExclusion {
    /** Cible du barreau exclu (comparée aux cibles déclarées, en minuscules). */
    stepTarget: string;
    /** Machines concernées par CETTE entrée. */
    machines: string[];
}

/**
 * Exception documentée par siège — #4427 : « documented machine-specific
 * exceptions ». Deux leviers mesurés dans le canon :
 *  - `stepExclude` : cibles de barreau exclues pour ce siège ;
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
    /** Exclusions par machine, groupées comme le runtime les lit. */
    stepExclude: CascadeStepExclusion[];
    /** `role` ou `role@machine` — bras de rôle armés. */
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

/** Brouillon d'un rôle pendant le parcours du texte. */
interface RoleDraft {
    refs: string[];
    classes: Array<'own' | undefined>;
    labels: string[];
    directions: string[];
    notes: string[];
    resets: string[];
    hasLabels: boolean;
    hasDirections: boolean;
    hasNotes: boolean;
    hasReset: boolean;
}

/**
 * Lignes du canon : `ROLE = a@b > c@d` + blocs positionnels indentés.
 *
 * Les blocs positionnels (LABEL/DIRECTION/NOTE/RESET) appartiennent au DERNIER
 * rôle DÉCLARÉ DANS LE TEXTE — pas au dernier rôle selon l'ordre canonique.
 * (Le runtime lit une variable par rôle : `CLAUDISH_FAILOVER_<ROLE>_LABEL`.)
 */
export function parseCascadeCanon(text: string): { payload: CascadePayload | null; errors: string[] } {
    const errors: string[] = [];
    const drafts: Partial<Record<CascadeRoleName, RoleDraft>> = {};
    /** Ordre de DÉCLARATION dans le texte (la source de vérité d'attribution). */
    const declaredInText: CascadeRoleName[] = [];
    const scalars: Record<string, string> = {};
    let lastScalarKey: string | null = null;

    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;

        // Bloc positionnel (LABEL/DIRECTION/NOTE/RESET sous un rôle).
        const positional = line.match(/^(LABEL|DIRECTION|NOTE|RESET)\s*=\s*(.*)$/i);
        if (positional) {
            const key = positional[1].toUpperCase();
            const value = positional[2].trim();
            const owner = declaredInText.length > 0 ? declaredInText[declaredInText.length - 1] : null;
            if (!owner) {
                errors.push(`bloc positionnel ${key} avant toute déclaration de rôle`);
                continue;
            }
            const draft = drafts[owner]!;
            const flag = key === 'LABEL' ? 'hasLabels' : key === 'DIRECTION' ? 'hasDirections' : key === 'NOTE' ? 'hasNotes' : 'hasReset';
            if (draft[flag]) {
                errors.push(`rôle ${owner} : bloc ${key} déclaré deux fois (la seconde valeur écraserait la première)`);
                continue;
            }
            // DIRECTION « en ligne » (parenthèses de la déclaration de rôle) ET
            // bloc DIRECTION : le bloc écrasait les directions en ligne SANS
            // le dire. On refuse — la direction écrite par l'opérateur ne se
            // perd pas en silence (le runtime, lui, écrase et continue).
            if (key === 'DIRECTION' && draft.directions.length > 0) {
                errors.push(
                    `rôle ${owner} : DIRECTION en ligne (parenthèses) ET bloc DIRECTION — la seconde valeur écraserait la première`,
                );
                continue;
            }
            draft[flag] = true;
            if (key === 'RESET') {
                // `parseStepResets` : les cases VIDES comptent (position), on ne
                // filtre donc rien ici.
                draft.resets = value.split('>').map(s => s.trim());
            } else {
                // `splitSteps` : on filtre les fragments vides — une valeur
                // scalaire n'atteint donc que le step 0.
                draft[key === 'LABEL' ? 'labels' : key === 'DIRECTION' ? 'directions' : 'notes'] =
                    value.split('>').map(s => s.trim()).filter(s => s.length > 0);
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

        // Continuation de scalaire : le canon publié wrappe les valeurs longues.
        if (lastScalarKey && !line.includes('=') && /^[A-Za-z0-9@:._\-+,!/ ]+$/.test(line)) {
            // STEP_EXCLUDE : le runtime sépare les ENTRÉES par ',', les machines
            // d'une entrée par un espace → une continuation se colle par un
            // ESPACE (une virgule ouvrirait une entrée nouvelle).
            const joiner = lastScalarKey === 'STEP_EXCLUDE' ? ' ' : ',';
            scalars[lastScalarKey] = `${scalars[lastScalarKey]}${joiner}${line}`.replace(/,\s*,/g, ',');
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
            const roleName = name as CascadeRoleName;
            if (drafts[roleName]) {
                errors.push(`rôle ${roleName} : déclaration en double (la seconde écraserait la première)`);
                continue;
            }
            const refs: string[] = [];
            const classes: Array<'own' | undefined> = [];
            for (const raw of roleDecl[2].split('>').map(s => s.trim()).filter(s => s.length > 0)) {
                const own = raw.endsWith('!own');
                refs.push(own ? raw.slice(0, -'!own'.length) : raw);
                classes.push(own ? 'own' : undefined);
            }
            const inlineDirections = (roleDecl[3] ?? '')
                .split('>').map(s => s.trim()).filter(s => s.length > 0);
            drafts[roleName] = {
                refs,
                classes,
                labels: [],
                directions: inlineDirections,
                notes: [],
                resets: [],
                hasLabels: false,
                hasDirections: false,
                hasNotes: false,
                hasReset: false,
            };
            declaredInText.push(roleName);
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

    for (const name of declaredInText) {
        const draft = drafts[name]!;
        // #4427 « reject inconsistent lengths before write » : un bloc positionnel
        // doit couvrir EXACTEMENT la chaîne (longueur égale) ou être un scalaire
        // (longueur 1). Le runtime, lui, tolère et REMPLIT — nous refusons, pour
        // que l'intention de l'opérateur ne se perde pas en silence.
        for (const [field, values] of [
            ['LABEL', draft.labels],
            ['DIRECTION', draft.directions],
            ['NOTE', draft.notes],
            ['RESET', draft.resets],
        ] as const) {
            if (values.length === 0) continue;
            if (values.length !== draft.refs.length && values.length !== 1) {
                errors.push(
                    `rôle ${name} : ${field} a ${values.length} entrées pour ${draft.refs.length} barreaux`,
                );
            }
        }

        const steps: CascadeStep[] = draft.refs.map((ref, i) => {
            // `labels[i] ?? target` — la chute du runtime est la CIBLE, pas vide.
            const label = draft.labels[i] ?? ref;
            const rawDirection = draft.directions[i];
            const direction: CascadeDirection = rawDirection && DIRECTION_SET.has(rawDirection)
                ? (rawDirection as CascadeDirection)
                : DEFAULT_DIRECTION;
            const note = draft.notes[i];
            const rawReset = draft.resets[i];
            // B8 : un reset ILLISIBLE est un VERDICT, pas un reset absent. Le
            // runtime, lui, tolère et REMPLIT ; nous refusons, pour que la date
            // que l'opérateur a écrite ne se perde pas en silence.
            let resetAt: string | undefined;
            if (rawReset !== undefined && rawReset !== '') {
                const parsedReset = Date.parse(rawReset);
                if (Number.isNaN(parsedReset)) {
                    errors.push(`rôle ${name} : reset illisible « ${rawReset} » (step ${i})`);
                } else {
                    resetAt = new Date(parsedReset).toISOString();
                }
            }
            return {
                ref,
                ...(draft.classes[i] ? { class: draft.classes[i] as 'own' } : {}),
                label,
                direction,
                ...(note !== undefined ? { note } : {}),
                ...(resetAt !== undefined ? { resetAt } : {}),
            };
        });
        payload.roles[name] = { steps };
    }

    // ROLE_MODELS = model:role,model:role
    if (scalars.ROLE_MODELS) {
        for (const pair of scalars.ROLE_MODELS.split(',').map(s => s.trim()).filter(Boolean)) {
            const idx = pair.lastIndexOf(':');
            if (idx <= 0) { errors.push(`ROLE_MODELS entrée invalide « ${pair} »`); continue; }
            payload.roleModels[pair.slice(0, idx)] = pair.slice(idx + 1);
        }
    }

    // STEP_EXCLUDE : grammaire du runtime — entrées séparées par ',', cible
    // avant le DERNIER ':', machines d'une entrée séparées par /[\s,]+/.
    if (scalars.STEP_EXCLUDE) {
        const { entries, entryErrors } = parseStepExcludeRaw(scalars.STEP_EXCLUDE);
        payload.stepExclude = entries;
        errors.push(...entryErrors);
    }

    // ACTIVE : split sur /[,\s]+/ (le runtime accepte l'espace ET la virgule).
    if (scalars.ACTIVE) {
        payload.active = scalars.ACTIVE.toLowerCase().split(/[,\s]+/).filter(Boolean);
    }

    if (scalars.QWEN_THINKING) {
        payload.qwenThinking = scalars.QWEN_THINKING;
    }

    if (errors.length > 0) return { payload: null, errors };
    return { payload, errors: [] };
}

/**
 * STEP_EXCLUDE — grammaire du runtime (`failover.ts`, lecture de
 * `CLAUDISH_FAILOVER_STEP_EXCLUDE`) :
 *   - les ENTRÉES sont séparées par `,` ;
 *   - la cible est ce qui précède le DERNIER `:` (une cible `role:x` contient
 *     lui-même un `:`) ;
 *   - les machines d'une entrée sont séparées par `/[\s,]+/` ;
 *   - une entrée sans `:`, sans machine, ou dont la partie machine contient
 *     `:` ou `@`, est MALFORMÉE (le runtime l'ignore — nous la refusons).
 */
function parseStepExcludeRaw(raw: string): { entries: CascadeStepExclusion[]; entryErrors: string[] } {
    const entries: CascadeStepExclusion[] = [];
    const entryErrors: string[] = [];
    for (const piece of raw.split(',').map(s => s.trim()).filter(Boolean)) {
        const at = piece.lastIndexOf(':');
        const target = at >= 0 ? piece.slice(0, at).trim().toLowerCase() : '';
        const machinesRaw = at >= 0 ? piece.slice(at + 1).trim() : '';
        const machines = machinesRaw.split(/[\s,]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
        if (at < 0 || !target) {
            entryErrors.push(`STEP_EXCLUDE « ${piece} » : want '<stepTarget>:<machine>[ <machine>…]'`);
            continue;
        }
        if (machines.length === 0 || machinesRaw.includes(':') || machinesRaw.includes('@')) {
            entryErrors.push(`STEP_EXCLUDE « ${piece} » : no valid machine name (names carry no ':' or '@')`);
            continue;
        }
        entries.push({ stepTarget: target, machines });
    }
    return { entries, entryErrors };
}

// ---------------------------------------------------------------------------
// Validations (avant toute écriture — #4427 « reject before write »)
// ---------------------------------------------------------------------------

/**
 * Patterns sécrêts — allow-list NON-secrète : la moindre correspondance rejette.
 * Les noms PRÉFIXÉS sont couverts (`ANTHROPIC_API_KEY=`, `DB_PASSWORD=`,
 * `AWS_SECRET_ACCESS_KEY=`, `HF_TOKEN=`) : un `.env` complet glissé dans un
 * champ string autorisé doit être rejeté, pas accepté.
 */
const SECRET_PATTERNS: Array<{ re: RegExp; name: string }> = [
    { re: /\bsk-[A-Za-z0-9_-]{16,}/, name: 'clé API sk-…' },
    { re: /\bghp_[A-Za-z0-9]{20,}/, name: 'token GitHub' },
    { re: /\bgho_[A-Za-z0-9]{20,}/, name: 'token GitHub OAuth' },
    { re: /\bgithub_pat_[A-Za-z0-9_]{20,}/, name: 'token GitHub fine-grained' },
    { re: /\b\w*(?:_API_KEY|_SECRET|_TOKEN|_PASSWORD|_PASSPHRASE)\w*\s*[:=]/i, name: 'assignation de secret' },
    { re: /\b(Bearer|Basic)\s+[A-Za-z0-9+/=]{20,}/i, name: 'header d\'authentification' },
];

/** Clés top-level autorisées — toute autre clé = refus (allow-list stricte). */
const ALLOWED_TOP_LEVEL = new Set([
    'schemaVersion', 'provenance', 'roles', 'roleModels',
    'stepExclude', 'active', 'auto', 'qwenThinking', 'exceptions',
]);

/** Allow-list STRUCTURELLE — l'allow-list DESCEND (une clé inconnue imbriquée
 *  est refusée : `roles.TURBO`, `steps[0].envFile`, `provenance.extraEnv`). */
const ALLOWED_PROVENANCE_KEYS = new Set(['source', 'readAt', 'instanceId', 'snapshotHash']);
const ALLOWED_CHAIN_KEYS = new Set(['steps']);
const ALLOWED_STEP_KEYS = new Set(['ref', 'class', 'label', 'direction', 'note', 'resetAt']);
const ALLOWED_EXCLUSION_KEYS = new Set(['stepTarget', 'machines']);
const ALLOWED_EXCEPTION_KEYS = new Set(['machine', 'stepExclude', 'activeOverride', 'reason']);

/**
 * Ref de barreau valide — CIBLE (suffixe de classe retiré) : deux formes
 * mesurées dans le canon live :
 *  - `provider@model`   (mistral@zai-glm-5-3)
 *  - `role:<rôle>`      (role:sonnet — indirection vers une autre chaîne)
 */
export const STEP_REF_RE = /^(?:[^@\s]+@[^@\s]+|role:[a-z]+)$/;

/** Nom de machine flotte — `myia-*`. */
export const MACHINE_RE = /^myia-[a-z0-9-]+$/i;

/**
 * Valide un payload complet. Pur : aucune IO. Le hash canonique est RECALCULÉ
 * puis comparé au hash revendiqué (H1) — jamais l'inverse.
 *
 * Le validateur ne LANCE JAMAIS : un `payload.json` malformé produit un verdict
 * (`errors[]`), pas une exception qui tue le processus.
 */
export function validateCascadePayload(payload: unknown): CascadeValidationResult {
    const errors: string[] = [];
    let canonicalHash: string | undefined;

    try {
        if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
            return { ok: false, errors: ['payload n\'est pas un objet'], canonicalHash: undefined };
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

        const prov = (typeof p.provenance === 'object' && p.provenance !== null && !Array.isArray(p.provenance))
            ? (p.provenance as Record<string, unknown>)
            : undefined;
        if (!prov) {
            errors.push('provenance absent');
        } else {
            checkKeys(prov, ALLOWED_PROVENANCE_KEYS, 'provenance', errors);
            if (prov.source !== 'hub-live') {
                errors.push('provenance.source doit être « hub-live » (jamais un checkout périmé)');
            }
            if (typeof prov.readAt !== 'string' || Number.isNaN(Date.parse(prov.readAt))) {
                errors.push('provenance.readAt absent ou non ISO');
            }
        }

        // Secrets : le texte entier du payload est balayé, champ par champ.
        scanForSecrets(p, '', errors);

        // Types STRICTS : un champ PRÉSENT avec le mauvais type est malformé
        // (un `null` silencieusement traité comme « absent » perdait une
        // exclusion, un rôle armé ou une exception).
        for (const key of ['stepExclude', 'active', 'exceptions'] as const) {
            if (Object.hasOwn(p, key) && !Array.isArray(p[key])) {
                errors.push(`${key} doit être un tableau (reçu : ${p[key] === null ? 'null' : typeof p[key]})`);
            }
        }
        for (const key of ['roles', 'roleModels'] as const) {
            if (Object.hasOwn(p, key)
                && (typeof p[key] !== 'object' || p[key] === null || Array.isArray(p[key]))) {
                errors.push(`${key} doit être un objet (reçu : ${p[key] === null ? 'null' : typeof p[key]})`);
            }
        }

        // Rôles : structure, longueurs (structurelles ici), graphe.
        const roles = (typeof p.roles === 'object' && p.roles !== null && !Array.isArray(p.roles))
            ? (p.roles as Record<string, unknown>)
            : {};
        let anyRole = false;
        for (const [name, chainRaw] of Object.entries(roles)) {
            if (!(CASCADE_ROLE_NAMES as readonly string[]).includes(name)) {
                errors.push(`clé hors allow-list : « roles.${name} » (rôles : ${CASCADE_ROLE_NAMES.join('/')})`);
                continue;
            }
            anyRole = true;
            const chain = (typeof chainRaw === 'object' && chainRaw !== null && !Array.isArray(chainRaw))
                ? (chainRaw as Record<string, unknown>)
                : undefined;
            if (!chain) {
                errors.push(`rôle ${name} : chaîne vide`);
                continue;
            }
            checkKeys(chain, ALLOWED_CHAIN_KEYS, `roles.${name}`, errors);
            const steps = Array.isArray(chain.steps) ? chain.steps : [];
            if (!Array.isArray(chain.steps) || steps.length === 0) {
                errors.push(`rôle ${name} : chaîne vide`);
                continue;
            }
            const seen = new Set<string>();
            for (const [i, stepRaw] of steps.entries()) {
                if (typeof stepRaw !== 'object' || stepRaw === null || Array.isArray(stepRaw)) {
                    errors.push(`rôle ${name} : barreau ${i} n'est pas un objet`);
                    continue;
                }
                const step = stepRaw as Record<string, unknown>;
                checkKeys(step, ALLOWED_STEP_KEYS, `roles.${name}.steps[${i}]`, errors);
                const ref = step.ref;
                if (typeof ref !== 'string' || !STEP_REF_RE.test(ref)) {
                    errors.push(`rôle ${name} : ref de barreau invalide « ${String(ref)} » (attendu provider@model ou role:<rôle>)`);
                    continue;
                }
                if (seen.has(ref)) {
                    errors.push(`rôle ${name} : barreau dupliqué « ${ref} »`);
                }
                seen.add(ref);
                if (step.class !== undefined && step.class !== 'own') {
                    errors.push(`rôle ${name} : classe de barreau inconnue « ${String(step.class)} » (own attendu)`);
                }
                if (step.direction !== undefined && !DIRECTION_SET.has(String(step.direction))) {
                    errors.push(`rôle ${name} : direction inconnue « ${String(step.direction)} »`);
                }
                if (step.resetAt !== undefined
                    && (typeof step.resetAt !== 'string' || Number.isNaN(Date.parse(step.resetAt)))) {
                    errors.push(`rôle ${name} : resetAt non ISO « ${String(step.resetAt)} »`);
                }
            }
        }
        if (!anyRole) errors.push('aucun rôle déclaré (SONNET/OPUS/FABLE/HAIKU)');

        // Graphe de délégation : un `role:` doit pointer un rôle EXISTANT, et le
        // graphe ne doit pas boucler (le runtime refuse un cycle au LOAD).
        const delegationRefs = new Map<string, string[]>();
        for (const name of CASCADE_ROLE_NAMES) {
            const chain = roles[name] as { steps?: Array<{ ref?: string }> } | undefined;
            const refs: string[] = [];
            for (const step of chain?.steps ?? []) {
                const ref = step?.ref;
                if (typeof ref !== 'string') continue;
                if (ref.startsWith('role:')) {
                    const target = ref.slice('role:'.length).toLowerCase();
                    if (!RUNTIME_ROLES.includes(target)) {
                        errors.push(`rôle ${name} : délégation « ${ref} » vers un rôle inconnu`);
                    } else {
                        refs.push(target);
                    }
                }
            }
            if (refs.length > 0) delegationRefs.set(name.toLowerCase(), refs);
        }
        for (const [from, refs] of delegationRefs) {
            if (hasDelegationCycle(from, delegationRefs)) {
                errors.push(`rôle ${from} : le graphe de délégation « role: » forme un cycle (le runtime refuse un cycle au LOAD)`);
            }
        }

        // STEP_EXCLUDE : entrées groupées (cible + machines).
        const stepExcludeRaw = Array.isArray(p.stepExclude) ? p.stepExclude : [];
        const declaredTargets = new Set<string>();
        for (const name of CASCADE_ROLE_NAMES) {
            const chain = roles[name] as { steps?: Array<{ ref?: string }> } | undefined;
            for (const step of chain?.steps ?? []) {
                const ref = step?.ref;
                if (typeof ref !== 'string') continue;
                declaredTargets.add(ref.toLowerCase());
                // Un step `role:x` est indexé sous les DEUX formes (la cible et
                // `role:x`) — c'est ce que le runtime fait.
                if (ref.startsWith('role:')) declaredTargets.add(ref.toLowerCase());
            }
        }
        for (const [i, entryRaw] of stepExcludeRaw.entries()) {
            if (typeof entryRaw !== 'object' || entryRaw === null || Array.isArray(entryRaw)) {
                errors.push(`STEP_EXCLUDE[${i}] n'est pas un objet {stepTarget, machines}`);
                continue;
            }
            const entry = entryRaw as Record<string, unknown>;
            checkKeys(entry, ALLOWED_EXCLUSION_KEYS, `stepExclude[${i}]`, errors);
            const target = entry.stepTarget;
            if (typeof target !== 'string' || target.trim().length === 0) {
                errors.push(`STEP_EXCLUDE[${i}] : stepTarget absent`);
            } else if (!declaredTargets.has(target.trim().toLowerCase())) {
                errors.push(`STEP_EXCLUDE[${i}] : barreau « ${target} » inconnu des rôles`);
            }
            const machines = entry.machines;
            if (!Array.isArray(machines) || machines.length === 0) {
                errors.push(`STEP_EXCLUDE[${i}] : aucune machine`);
            } else {
                for (const m of machines) {
                    if (typeof m !== 'string' || !MACHINE_RE.test(m)) {
                        errors.push(`STEP_EXCLUDE[${i}] : machine « ${String(m)} » invalide`);
                    }
                }
            }
        }

        // B11 : une exclusion qui couvre TOUS les barreaux d'un rôle pour une
        // machine revient à DÉSACTIVER ce rôle — une perte de capacité
        // silencieuse, qui se lirait « le rôle est là » alors qu'il ne l'est
        // plus. On refuse.
        const roleSteps = new Map<CascadeRoleName, string[]>();
        for (const name of CASCADE_ROLE_NAMES) {
            const chain = roles[name] as { steps?: Array<{ ref?: string }> } | undefined;
            const refs: string[] = [];
            for (const step of chain?.steps ?? []) {
                if (typeof step?.ref === 'string') refs.push(step.ref.toLowerCase());
            }
            if (refs.length > 0) roleSteps.set(name, [...new Set(refs)]);
        }
        const excludedFor = new Map<string, Set<string>>();
        for (const entryRaw of stepExcludeRaw) {
            if (typeof entryRaw !== 'object' || entryRaw === null || Array.isArray(entryRaw)) continue;
            const entry = entryRaw as Record<string, unknown>;
            const target = typeof entry.stepTarget === 'string' ? entry.stepTarget.trim().toLowerCase() : '';
            if (!target) continue;
            const machines = Array.isArray(entry.machines)
                ? entry.machines.filter((m): m is string => typeof m === 'string')
                : [];
            for (const [role, refs] of roleSteps) {
                if (!refs.includes(target)) continue;
                for (const machine of machines) {
                    const key = `${role}|${machine}`;
                    const set = excludedFor.get(key) ?? new Set<string>();
                    set.add(target);
                    excludedFor.set(key, set);
                }
            }
        }
        for (const [role, refs] of roleSteps) {
            for (const [key, set] of excludedFor) {
                const separator = key.indexOf('|');
                if (key.slice(0, separator) !== role) continue;
                if (set.size >= refs.length) {
                    errors.push(
                        `STEP_EXCLUDE : le rôle ${role} est exclu INTÉGRALEMENT sur ${key.slice(separator + 1)} — il serait désactivé`,
                    );
                    break;
                }
            }
        }

        // ACTIVE : `role` ou `role@machine` (split /[,\s]+/ côté runtime).
        const active = Array.isArray(p.active) ? p.active : [];
        for (const entry of active) {
            if (typeof entry !== 'string' || entry.trim().length === 0) {
                errors.push(`ACTIVE : entrée vide ou non textuelle`);
                continue;
            }
            const at = entry.indexOf('@');
            const role = (at >= 0 ? entry.slice(0, at) : entry).toLowerCase();
            if (!RUNTIME_ROLES.includes(role)) {
                errors.push(`ACTIVE « ${entry} » : rôle « ${role} » inconnu`);
            }
            if (at >= 0) {
                const machine = entry.slice(at + 1);
                if (machine.length === 0) {
                    errors.push(`ACTIVE « ${entry} » : machine vide`);
                } else if (machine.includes('@')) {
                    errors.push(`ACTIVE « ${entry} » : machine malformée (« @ » en trop)`);
                } else if (!MACHINE_RE.test(machine)) {
                    errors.push(`ACTIVE « ${entry} » : machine « ${machine} » invalide`);
                }
            }
        }

        // ROLE_MODELS : valeurs ∈ rôles valides.
        const roleModels = (typeof p.roleModels === 'object' && p.roleModels !== null && !Array.isArray(p.roleModels))
            ? (p.roleModels as Record<string, unknown>)
            : {};
        for (const [model, role] of Object.entries(roleModels)) {
            if (typeof role !== 'string' || !RUNTIME_ROLES.includes(role.toLowerCase())) {
                errors.push(`ROLE_MODELS[${model}] : rôle « ${String(role)} » inconnu`);
            }
        }

        // AUTO : 0/1 entier (drapeau du canon).
        if (typeof p.auto !== 'number' || !Number.isInteger(p.auto) || p.auto < 0 || p.auto > 1) {
            errors.push(`auto doit être 0 ou 1 (reçu : ${String(p.auto)})`);
        }

        // Exceptions par siège : chacune DOIT porter une raison (documentée ou rien).
        const exceptions = Array.isArray(p.exceptions) ? p.exceptions : [];
        for (const [i, exRaw] of exceptions.entries()) {
            if (typeof exRaw !== 'object' || exRaw === null || Array.isArray(exRaw)) {
                errors.push(`exception ${i} : n'est pas un objet`);
                continue;
            }
            const ex = exRaw as Record<string, unknown>;
            checkKeys(ex, ALLOWED_EXCEPTION_KEYS, `exceptions[${i}]`, errors);
            if (!ex.machine) errors.push('exception sans machine');
            if (typeof ex.reason !== 'string' || ex.reason.trim().length === 0) {
                errors.push(`exception ${String(ex.machine ?? '?')} : raison absente (une exception non documentée n'est pas harmonisable)`);
            }
            const exExclude = Array.isArray(ex.stepExclude) ? ex.stepExclude : [];
            for (const e of exExclude) {
                const found = stepExcludeRaw.some((entryRaw) => {
                    const entry = entryRaw as Record<string, unknown>;
                    return typeof entry?.stepTarget === 'string'
                        && entry.stepTarget.toLowerCase() === String(e).toLowerCase();
                });
                if (!found) {
                    errors.push(`exception ${String(ex.machine)} : STEP_EXCLUDE « ${String(e)} » absent du canon global`);
                }
            }
        }

        // H1 — le hash revendiqué est recalculé, jamais cru. Le hash est calculé
        // QUOI QU'IL ARRIVE (un payload invalide a quand même un hash : « absent
        // quand invalide » faisait de l'absence une information).
        canonicalHash = computeCanonicalHash(payload as CascadePayload);
        if (prov && typeof prov.snapshotHash === 'string' && prov.snapshotHash !== canonicalHash) {
            errors.push(`snapshotHash revendiqué ≠ hash canonique recalculé (H1 : un hash revendiqué ne confirme jamais)`);
        }
    } catch (err) {
        errors.push(`erreur interne de validation : ${err instanceof Error ? err.message : String(err)}`);
    }

    return { ok: errors.length === 0, errors, canonicalHash };
}

/** Clés inattendues dans un objet — l'allow-list descend. */
function checkKeys(obj: Record<string, unknown>, allowed: Set<string>, path: string, errors: string[]): void {
    for (const key of Object.keys(obj)) {
        if (!allowed.has(key)) {
            errors.push(`clé hors allow-list : « ${path}.${key} »`);
        }
    }
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

/** Le graphe de délégation `role:` contient-il un cycle ? */
function hasDelegationCycle(from: string, refs: Map<string, string[]>): boolean {
    const visiting = new Set<string>();
    const walk = (node: string): boolean => {
        if (visiting.has(node)) return true;
        visiting.add(node);
        for (const next of refs.get(node) ?? []) {
            if (walk(next)) return true;
        }
        visiting.delete(node);
        return false;
    };
    return walk(from);
}

// ---------------------------------------------------------------------------
// Hash canonique
// ---------------------------------------------------------------------------

/**
 * Hash canonique : stable, indépendant de l'ordre des clés et des listes, et
 * **sensible aux exceptions par siège** (F1 : deux payloads qui ne diffèrent que
 * par une exception ne DOIVENT pas partager un hash — une exception non
 * documentée fausserait la comparaison). FNV-1a 32 bits ×4 sur un JSON trié —
 * déterministe sans dépendance crypto du poste.
 */
export function computeCanonicalHash(payload: CascadePayload): string {
    const canonical = canonicalizeForHash(payload);
    const text = JSON.stringify(canonical);
    // Quatre tours SALÉS concaténés (4 × 32 bits) : les collisions FNV sur des
    // documents courts ne surviennent que tour par tour, pas sur les quatre.
    return [1, 2, 3, 4].map(i => fnv1a32hex(`${i}:${text}`)).join('');
}

/** Forme canonique — défensive : un payload malformé ne doit pas lever. */
function canonicalizeForHash(payload: CascadePayload): unknown {
    const p = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>;
    const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
    const obj = (v: unknown): Record<string, unknown> =>
        (typeof v === 'object' && v !== null && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
    return {
        schemaVersion: p.schemaVersion,
        roles: sortDeep(obj(p.roles)),
        roleModels: sortDeep(obj(p.roleModels)),
        stepExclude: arr(p.stepExclude)
            .map(e => {
                const entry = obj(e);
                return {
                    stepTarget: String(entry.stepTarget ?? ''),
                    machines: arr(entry.machines).map(String).sort(),
                };
            })
            .sort((a, b) => a.stepTarget.localeCompare(b.stepTarget)),
        active: arr(p.active).map(String).sort(),
        auto: p.auto,
        ...(p.qwenThinking !== undefined ? { qwenThinking: String(p.qwenThinking) } : {}),
        exceptions: arr(p.exceptions)
            .map(e => {
                const ex = obj(e);
                return {
                    machine: String(ex.machine ?? ''),
                    reason: String(ex.reason ?? ''),
                    stepExclude: arr(ex.stepExclude).map(String).sort(),
                    activeOverride: arr(ex.activeOverride).map(String).sort(),
                };
            })
            .sort((a, b) => a.machine.localeCompare(b.machine)),
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
