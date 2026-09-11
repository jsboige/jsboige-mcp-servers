/**
 * Masquage des secrets au passage d'une frontière de PUBLICATION (#3584).
 *
 * Distinct de `redactSecrets` (`services/task-indexer/EmbeddingValidator.ts`), qui
 * protège l'INDEXATION : il ne voit que les formes auto-descriptives (préfixes
 * `sk-`/`ghp_`, `NAME=VALUE`, `Bearer …`). La fuite fondatrice #3584 est d'une autre
 * nature — une clé d'API **nue**, 64 caractères hexadécimaux, publiée sans nom de
 * variable. Aucun motif de forme ne peut la distinguer d'un SHA git de 40 caractères
 * ou d'un hash quelconque : un masquage par entropie casserait la citation des SHA,
 * qui est le vocabulaire courant du canal de coordination.
 *
 * D'où l'approche retenue ici : masquer par **valeur connue**, pas par forme. Les
 * valeurs secrètes de cette machine vivent déjà dans son `process.env` (chargé par
 * `dotenv` dans `mcp-wrapper.cjs`). Comparer le texte publié à ces valeurs est exact —
 * la clé fuitée est masquée, un SHA git ne l'est jamais.
 *
 * Limite assumée : une machine ne peut masquer que les secrets qu'elle DÉTIENT. La
 * couverture reste complémentaire de `redactSecrets`, qui attrape les formes
 * auto-descriptives quel que soit le détenteur. Les deux couches s'appliquent.
 */

/** Un nom de variable d'environnement qui désigne un secret (aligné sur les motifs
 *  de forme de `EmbeddingValidator.ts`, pour que les deux couches ne divergent pas). */
const SECRET_ENV_NAME = /(API[_-]?KEY|APIKEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|ACCESS[_-]?KEY|PRIVATE[_-]?KEY)/i;

/** En dessous, une valeur est trop courte pour être un secret — et assez banale pour
 *  qu'un masquage par sous-chaîne mutile le texte (un `PASSWORD=dev` masquerait
 *  chaque « dev » du canal). */
const MIN_SECRET_LENGTH = 8;

/**
 * Préconstruit l'index des valeurs secrètes connues et rend le masqueur associé.
 *
 * L'index (scan de `env` + tri par longueur) ne dépend PAS du texte : le
 * reconstruire par message est du travail perdu — mesuré 0,31 ms/message sur un
 * `env` de 128 entrées, soit un scan complet de l'intercom à chaque condensation
 * (#3584 rétention). Appeler une fois par PASSE de publication, réutiliser.
 *
 * @param env Source des secrets — injectable pour les tests, `process.env` sinon.
 * @returns `(text) => text`, masquant les valeurs connues par `<redacted:NAME>`.
 */
export function createKnownValueMasker(
    env: NodeJS.ProcessEnv = process.env
): (text: string) => string {
    // Dédoublonner par VALEUR : plusieurs variables peuvent porter le même secret
    // (alias `X_API_KEY` / `X_KEY`), et re-masquer serait un travail perdu.
    const byValue = new Map<string, string>();
    for (const [name, value] of Object.entries(env)) {
        if (typeof value !== 'string') continue;
        if (value.length < MIN_SECRET_LENGTH) continue;
        if (!SECRET_ENV_NAME.test(name)) continue;
        if (!byValue.has(value)) byValue.set(value, name);
    }

    // Les valeurs les plus longues d'abord : une valeur courte qui est un préfixe
    // d'une valeur longue laisserait sinon un fragment de la longue en clair.
    const values = Array.from(byValue.keys()).sort((a, b) => b.length - a.length);
    if (values.length === 0) return (text: string) => text;

    return (text: string): string => {
        let out = text;
        for (const value of values) {
            if (!out.includes(value)) continue;
            // `split`/`join` plutôt qu'une RegExp : une valeur secrète peut contenir des
            // métacaractères (`+`, `.`, `$` — fréquents en base64) qu'il faudrait échapper.
            out = out.split(value).join(`<redacted:${byValue.get(value)}>`);
        }
        return out;
    };
}

/**
 * Remplace dans `text` toute occurrence des valeurs secrètes connues de `env`.
 *
 * @param text Texte destiné à publication (message intercom, status de dashboard).
 * @param env  Source des secrets — injectable pour les tests, `process.env` sinon.
 * @returns Le texte, valeurs secrètes remplacées par `<redacted:NAME>`.
 */
export function redactKnownSecretValues(
    text: string,
    env: NodeJS.ProcessEnv = process.env
): string {
    if (!text) return text;
    return createKnownValueMasker(env)(text);
}
