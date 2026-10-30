/**
 * #4427 PR3 — magasin du canon de cascade Claudish.
 *
 * Sous-arbre PROPRE (`<store>/claudish-cascade/`), hors `configs/` : le payload
 * est une politique machine-indépendante, pas un instantané de configuration
 * par machine — le mélanger au canon de config ferait écraser l'un par l'autre
 * au prochain `roosync_config collect` (spec, § Magasin).
 *
 * Forme du magasin :
 *
 * ```
 * <store>/claudish-cascade/latest.json                          → pointeur de tête
 * <store>/claudish-cascade/versions/v<version>-<ts>/payload.json
 * <store>/claudish-cascade/versions/v<version>-<ts>/manifest.json
 * ```
 *
 * Deux propriétés portées ici, et testées :
 *
 * 1. **IMMUTABILITÉ** — republier une version EXISTANTE avec un contenu
 *    différent est REFUSÉ, jamais un écrasement silencieux : deux sièges qui
 *    publieraient la même version avec des contenus différents produiraient un
 *    canon qui dépend de l'ordre d'arrivée. Le même contenu, lui, est idempotent.
 * 2. **FAIL-CLOSED SUR STORE ABSENT** — la création passe par
 *    `ensureStoreSubdir` (#3459), et un `skipped-store-absent` est un REFUS,
 *    jamais un succès à moitié écrit.
 *
 * Aucun `mkdir` primitif sous la racine du store : la garde structurelle
 * (`fail-closed-store-structural.test.ts`) rend le contournement visible.
 *
 * @module services/cascade-store
 */

import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { ensureStoreSubdir } from '../utils/shared-state-path.js';
import {
    computeCanonicalHash,
    validateCascadePayload,
    type CascadePayload,
} from './cascade-payload.js';

/** Nom du sous-arbre du magasin, sous la racine RooSync partagée. */
export const CASCADE_STORE_SUBDIR = 'claudish-cascade';

/** Rétention : au-delà, les versions les plus anciennes sont retirées. */
export const CASCADE_STORE_RETENTION = 5;

/** Une version publiée, telle que le magasin la rend. */
export interface CascadeVersionRecord {
    version: string;
    publishedAt: string;
    canonicalHash: string;
    /** Nom du répertoire de version (sous `versions/`). */
    dirName: string;
}

/** Verdict de publication — jamais un booléen nu. */
export interface CascadePublishOutcome {
    published: boolean;
    /** Renseigné dès que `published: false` : la raison, en clair. */
    reason: string | null;
    /** Erreurs du validateur (payload invalide) — vide sinon. */
    errors: string[];
    version: CascadeVersionRecord | null;
    /** Même version, même contenu : rien réécrit, rien perdu. */
    idempotent: boolean;
    /** Versions retirées par la rétention (noms de répertoire). */
    pruned: string[];
    storeRoot: string;
}

/** Racine du magasin de cascade, dérivée de la racine RooSync partagée. */
export function cascadeStoreRoot(sharedStatePath: string): string {
    return join(sharedStatePath, CASCADE_STORE_SUBDIR);
}

/** Une version n'est un nom de répertoire que si elle est inoffensive. */
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function versionsDir(root: string): string {
    return join(root, 'versions');
}

/** Remplace `:` et `.` d'un horodatage ISO pour en faire un nom de répertoire triable. */
function stampForDir(iso: string): string {
    return iso.replace(/[:.]/g, '-');
}

function manifestPayloadHash(dirPath: string): string | null {
    const manifestPath = join(dirPath, 'manifest.json');
    if (!existsSync(manifestPath)) return null;
    try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { canonicalHash?: unknown };
        return typeof manifest.canonicalHash === 'string' ? manifest.canonicalHash : null;
    } catch {
        return null;
    }
}

/**
 * Liste les versions publiées, de la plus récente à la plus ancienne.
 *
 * Le tri est LEXICOGRAPHIQUE sur `v<version>-<horodatage>` : l'horodatage est
 * en tête décroissante naturelle (ISO), donc la version la plus récente sort
 * en premier — sauf si deux versions partagent la même seconde, cas où le nom
 * de version tranche.
 */
export function listCascadeVersions(sharedStatePath: string): CascadeVersionRecord[] {
    const dir = versionsDir(cascadeStoreRoot(sharedStatePath));
    if (!existsSync(dir)) return [];
    const records: CascadeVersionRecord[] = [];
    for (const dirName of readdirSync(dir)) {
        if (!dirName.startsWith('v')) continue;
        const manifestPath = join(dir, dirName, 'manifest.json');
        if (!existsSync(manifestPath)) continue;
        try {
            const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
                version?: unknown;
                publishedAt?: unknown;
                canonicalHash?: unknown;
            };
            records.push({
                version: typeof manifest.version === 'string' ? manifest.version : dirName,
                publishedAt: typeof manifest.publishedAt === 'string' ? manifest.publishedAt : '',
                canonicalHash: typeof manifest.canonicalHash === 'string' ? manifest.canonicalHash : '',
                dirName,
            });
        } catch {
            // Un manifeste illisible n'est pas une version publiable : il est
            // ignoré ici, et `latest.json` reste la seule autorité de tête.
        }
    }
    return records.sort((a, b) => (a.dirName < b.dirName ? 1 : a.dirName > b.dirName ? -1 : 0));
}

/** Contenu du pointeur de tête, tel qu'il est écrit sur disque. */
export interface CascadeLatestPointer extends CascadeVersionRecord {
    schemaVersion: number;
    /** Chemin relatif du payload, sous la racine du magasin. */
    payloadPath: string;
}

/**
 * Lit le pointeur de tête.
 *
 * Rend `null` quand il est absent ou illisible — jamais un canon reconstitué
 * depuis `versions/` : un `latest.json` corrompu est une anomalie à RAPPORTER,
 * pas à réparer en silence par le plus récent des répertoires.
 */
export function readLatestCascadePointer(sharedStatePath: string): CascadeLatestPointer | null {
    const latestPath = join(cascadeStoreRoot(sharedStatePath), 'latest.json');
    if (!existsSync(latestPath)) return null;
    try {
        const parsed = JSON.parse(readFileSync(latestPath, 'utf8')) as Partial<CascadeLatestPointer>;
        if (typeof parsed.dirName !== 'string' || typeof parsed.payloadPath !== 'string') return null;
        return {
            version: typeof parsed.version === 'string' ? parsed.version : '',
            publishedAt: typeof parsed.publishedAt === 'string' ? parsed.publishedAt : '',
            canonicalHash: typeof parsed.canonicalHash === 'string' ? parsed.canonicalHash : '',
            dirName: parsed.dirName,
            schemaVersion: typeof parsed.schemaVersion === 'number' ? parsed.schemaVersion : 0,
            payloadPath: parsed.payloadPath,
        };
    } catch {
        return null;
    }
}

/**
 * Lit le canon de tête : le payload PARSÉ, et le texte brut du fichier.
 *
 * `publishedAt` est la date de PUBLICATION : c'est elle qui date la lecture du
 * canon, et c'est sur elle que la politique de fraîcheur s'applique. Rendre la
 * date du jour ferait passer n'importe quel canon pour frais.
 *
 * Un `payload.json` illisible rend `null` : le store ne recompose jamais un
 * canon partiel à partir d'un fichier corrompu.
 */
export function readLatestCascade(
    sharedStatePath: string,
): { payload: unknown; text: string; readAt: string; verifiedAt: string; canonicalHash: string } | null {
    const pointer = readLatestCascadePointer(sharedStatePath);
    if (!pointer) return null;
    const payloadPath = join(cascadeStoreRoot(sharedStatePath), pointer.payloadPath);
    if (!existsSync(payloadPath)) return null;
    try {
        const text = readFileSync(payloadPath, 'utf8');
        return {
            payload: JSON.parse(text) as unknown,
            text,
            readAt: pointer.publishedAt,
            verifiedAt: pointer.publishedAt,
            canonicalHash: pointer.canonicalHash,
        };
    } catch {
        return null;
    }
}

export interface PublishCascadeArgs {
    sharedStatePath: string;
    /** Payload brut — validé ici, jamais fait confiance. */
    payload: unknown;
    /** Version demandée ; par défaut adressée par contenu (`h<hash8>`). */
    version?: string;
    /** Horloge injectable (tests). */
    now: string;
}

/**
 * Publie un canon versionné et immuable.
 *
 * Le payload est VALIDÉ avant toute écriture (un canon invalide publié
 * propagerait la dérive à toute la flotte). Le hash canonique est RECALCULÉ :
 * un `snapshotHash` revendiqué ne confirme jamais rien.
 */
export function publishCascadeCanon(args: PublishCascadeArgs): CascadePublishOutcome {
    const root = cascadeStoreRoot(args.sharedStatePath);
    const validation = validateCascadePayload(args.payload);
    if (!validation.ok || validation.canonicalHash === undefined) {
        return {
            published: false,
            reason: 'payload invalide — rien écrit',
            errors: validation.errors,
            version: null,
            idempotent: false,
            pruned: [],
            storeRoot: root,
        };
    }
    const payload = args.payload as CascadePayload;
    const canonicalHash = validation.canonicalHash;
    const version = args.version ?? `h${canonicalHash.slice(0, 8)}`;

    if (!VERSION_RE.test(version)) {
        return {
            published: false,
            reason: `version invalide « ${version} » — attendu [A-Za-z0-9][A-Za-z0-9._-]*`,
            errors: [],
            version: null,
            idempotent: false,
            pruned: [],
            storeRoot: root,
        };
    }

    // Fail-closed #3459 : le helper ne crée rien si la racine est absente, et
    // ce n'est PAS un succès.
    if (!existsSync(root) && ensureStoreSubdir(args.sharedStatePath, CASCADE_STORE_SUBDIR) === 'skipped-store-absent') {
        return {
            published: false,
            reason: 'racine du magasin RooSync absente — publication refusée (fail-closed)',
            errors: [],
            version: null,
            idempotent: false,
            pruned: [],
            storeRoot: root,
        };
    }

    // Immutabilité : une version déjà publiée ne change jamais de contenu.
    const existing = listCascadeVersions(args.sharedStatePath).filter(
        (r) => r.version === version || r.dirName.startsWith(`v${version}-`),
    );
    for (const prior of existing) {
        const priorHash = manifestPayloadHash(join(versionsDir(root), prior.dirName));
        if (priorHash === canonicalHash) {
            return {
                published: true,
                reason: null,
                errors: [],
                version: prior,
                idempotent: true,
                pruned: [],
                storeRoot: root,
            };
        }
        return {
            published: false,
            reason: `version ${version} déjà publiée avec un contenu DIFFÉRENT (${priorHash ?? 'hash illisible'}) — une version publiée est immuable, publier une nouvelle version`,
            errors: [],
            version: prior,
            idempotent: false,
            pruned: [],
            storeRoot: root,
        };
    }

    const dirName = `v${version}-${stampForDir(args.now)}`;
    if (ensureStoreSubdir(root, 'versions', dirName) === 'skipped-store-absent') {
        return {
            published: false,
            reason: 'sous-arbre versions/ non créé (racine du magasin absente) — publication refusée',
            errors: [],
            version: null,
            idempotent: false,
            pruned: [],
            storeRoot: root,
        };
    }

    const dirPath = join(versionsDir(root), dirName);
    const record: CascadeVersionRecord = {
        version,
        publishedAt: args.now,
        canonicalHash,
        dirName,
    };
    writeFileSync(join(dirPath, 'payload.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    writeFileSync(
        join(dirPath, 'manifest.json'),
        `${JSON.stringify(
            {
                version,
                publishedAt: args.now,
                canonicalHash,
                schemaVersion: payload.schemaVersion,
                provenance: payload.provenance,
            },
            null,
            2,
        )}\n`,
        'utf8',
    );
    writeFileSync(
        join(root, 'latest.json'),
        `${JSON.stringify(
            {
                version,
                publishedAt: args.now,
                canonicalHash,
                dirName,
                schemaVersion: payload.schemaVersion,
                payloadPath: `versions/${dirName}/payload.json`,
            },
            null,
            2,
        )}\n`,
        'utf8',
    );

    const pruned = pruneVersions(root);
    return {
        published: true,
        reason: null,
        errors: [],
        version: record,
        idempotent: false,
        pruned,
        storeRoot: root,
    };
}

/**
 * Applique la rétention : ne garde que les `CASCADE_STORE_RETENTION` versions
 * les plus récentes.
 *
 * Ne considère QUE les répertoires `v*` sous `versions/` : `latest.json` vit à
 * la racine du magasin et n'est jamais un candidat. Rend les noms retirés —
 * une rétention qui ne dit pas ce qu'elle a supprimé n'est pas observable.
 */
function pruneVersions(root: string): string[] {
    const dir = versionsDir(root);
    if (!existsSync(dir)) return [];
    const names = readdirSync(dir)
        .filter((n) => n.startsWith('v'))
        .sort()
        .reverse();
    const doomed = names.slice(CASCADE_STORE_RETENTION);
    const pruned: string[] = [];
    for (const name of doomed) {
        try {
            rmSync(join(dir, name), { recursive: true, force: true });
            pruned.push(name);
        } catch {
            // Un retrait raté laisse la version en place : la rétention est une
            // politique de place, pas une garantie de suppression.
        }
    }
    return pruned;
}
