/**
 * #4427 suivi (ms#1591) — écriture ATOMIQUE du `.env` d'un siège.
 *
 * Un `writeFileSync` direct peut être interrompu : le `.env` resterait TRONQUÉ,
 * et c'est le fichier que le conteneur relit au prochain recreate — la perte
 * serait totale et silencieuse. On écrit donc un fichier temporaire VOISIN
 * (même volume : le `rename` par-dessus la cible y est atomique), puis on
 * RELIT et on COMPARE : `applied: true` n'est rendu qu'après que le disque a
 * rendu le texte attendu, octet pour octet.
 *
 * Ce module ne décide RIEN : il écrit, renomme, relit. La décision
 * (`applied` → oui ou non) appartient à l'appelant, sur le texte rendu.
 *
 * @module services/cascade-env-file
 */

import { chmodSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { randomBytes } from 'crypto';

export interface CascadeEnvFileWrite {
    /** `true` UNIQUEMENT si la relecture a rendu exactement le texte écrit. */
    applied: boolean;
    /**
     * `true` dès que le `rename` a réussi — la cible a été REMPLACÉE.
     * #4427 (review ai-01, ms#1602) : avec la relecture dans le filet, un
     * `error !== null` ne dit plus si l'original est intact (échec amont) ou si
     * le nouveau texte est déjà sur disque (relecture seule en échec). C'est ce
     * discriminant que l'appelant mappe sur la consigne de déploiement.
     */
    replaced: boolean;
    /** Ce que le disque a rendu après le rename (indéterminé si erreur amont). */
    reread: string | null;
    /** Erreur d'écriture/renommage/relecture. L'original n'est garanti intact que si `replaced` est `false`. */
    error: string | null;
}

let tempCounter = 0;

/**
 * Écrit `text` dans `envPath` via temp-voisin + rename, puis relit pour
 * vérifier. En cas d'échec avant le rename, la cible n'est PAS touchée et le
 * temporaire est retiré.
 */
export function writeSeatEnvAtomically(envPath: string, text: string): CascadeEnvFileWrite {
    const dir = dirname(envPath);
    tempCounter += 1;
    const tmp = join(dir, `.claude-cascade-apply-${process.pid}-${tempCounter}-${randomBytes(4).toString('hex')}.tmp`);
    // #4427 (review ai-01, item 2b): le rename REMPLACE le mode de la cible par
    // celui du temporaire (créé `0o666 & ~umask`). Sur un siège Linux un `.env`
    // en `0600` redeviendrait lisible par le groupe au premier apply ; on
    // recopie donc le mode d'origine. Sous Windows, le mode n'est qu'un bit
    // read-only — les ACL gouvernent réellement — et l'appel y est sans effet.
    let originalMode: number | null = null;
    try {
        originalMode = statSync(envPath).mode & 0o777;
    } catch {
        /* pas de cible (première écriture du siège) : rien à préserver */
    }
    try {
        writeFileSync(tmp, text, 'utf8');
        if (originalMode !== null) {
            try {
                // chmod n'est PAS masqué par l'umask, contrairement au mode
                // passé à create — c'est le seul moyen fiable de recopier.
                chmodSync(tmp, originalMode);
            } catch {
                /* préserver le mode est un mieux, pas le contrat : le contenu primera */
            }
        }
        renameSync(tmp, envPath);
    } catch (err) {
        // Le temporaire ne doit jamais survivre à un échec — un voisin qui
        // traîne dans le répertoire du siège serait lu comme un geste réussi.
        try {
            unlinkSync(tmp);
        } catch {
            /* déjà parti : le rename a peut-être réussi puis échoué après */
        }
        let reread: string | null = null;
        try {
            reread = readFileSync(envPath, 'utf8');
        } catch {
            /* la cible peut ne pas exister — on ne masque pas l'erreur amont */
        }
        return { applied: false, replaced: false, reread, error: err instanceof Error ? err.message : String(err) };
    }
    // #4427 (review ai-01, item 2a): la relecture est DANS le filet — une
    // relecture qui échoue (antivirus qui verrouille, fichier retiré entre le
    // rename et le read) doit rendre `applied:false`, jamais propager une
    // exception hors du module. Le contrat d'en-tête l'exige : `applied` n'est
    // vrai QUE si le disque a rendu le texte — un échec de relecture ne prouve
    // rien et ne peut donc pas valoir succès.
    let reread: string | null = null;
    try {
        reread = readFileSync(envPath, 'utf8');
    } catch (err) {
        // Le remplacement A EU LIEU : le nouveau texte est probablement sur
        // disque, c'est la RELECTURE seule qui échoue — d'où `replaced:true`,
        // pour que l'appelant ne dise jamais « l'original est intact » ici.
        return { applied: false, replaced: true, reread, error: err instanceof Error ? err.message : String(err) };
    }
    return { applied: reread === text, replaced: true, reread, error: null };
}
