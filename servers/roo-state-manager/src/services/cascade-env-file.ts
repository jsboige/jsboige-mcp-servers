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

import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { randomBytes } from 'crypto';

export interface CascadeEnvFileWrite {
    /** `true` UNIQUEMENT si la relecture a rendu exactement le texte écrit. */
    applied: boolean;
    /** Ce que le disque a rendu après le rename (indéterminé si erreur amont). */
    reread: string | null;
    /** Erreur d'écriture/renommage éventuelle (le fichier d'origine est intact). */
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
    try {
        writeFileSync(tmp, text, 'utf8');
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
        return { applied: false, reread, error: err instanceof Error ? err.message : String(err) };
    }
    const reread = readFileSync(envPath, 'utf8');
    return { applied: reread === text, reread, error: null };
}
