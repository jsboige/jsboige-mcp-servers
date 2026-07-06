/**
 * Module responsable de la validation et du nettoyage des embeddings et payloads.
 * Extrait de TaskIndexer.ts pour respecter le principe de responsabilité unique.
 */

import { StateManagerError } from '../../types/errors.js';
import { getEmbeddingDimensions } from '../openai.js';

/**
 * Valide qu'un vecteur a la bonne dimension et ne contient pas de NaN/Infinity
 * @param vector Le vecteur à valider
 * @param expectedDim La dimension attendue (défaut: from EMBEDDING_DIMENSIONS env or 1536)
 * @throws StateManagerError si le vecteur est invalide
 */
export function validateVectorGlobal(vector: number[], expectedDim?: number): void {
    const dim = expectedDim ?? getEmbeddingDimensions();
    if (!Array.isArray(vector)) {
        throw new StateManagerError(
            `Vector doit être un tableau, reçu: ${typeof vector}`,
            'INVALID_VECTOR_TYPE',
            'EmbeddingValidator',
            { receivedType: typeof vector, expectedType: 'array' }
        );
    }

    if (vector.length !== dim) {
        throw new StateManagerError(
            `Dimension invalide: ${vector.length}, attendu: ${dim}`,
            'INVALID_VECTOR_DIMENSION',
            'EmbeddingValidator',
            { actualDimension: vector.length, expectedDimension: dim }
        );
    }

    // Vérifier NaN/Infinity qui causent erreurs 400
    const hasInvalidValues = vector.some(v => !Number.isFinite(v));
    if (hasInvalidValues) {
        throw new StateManagerError(
            `Vector contient NaN ou Infinity - invalide pour Qdrant`,
            'INVALID_VECTOR_VALUES',
            'EmbeddingValidator',
            { hasNaN: vector.some(v => Number.isNaN(v)), hasInfinity: vector.some(v => !Number.isFinite(v) && !Number.isNaN(v)) }
        );
    }
}

/**
 * Patterns de secrets à masquer avant indexation Qdrant (sécurité #2783).
 *
 * Un secret loggé en clair dans une conversation (sortie `cat .env` / `printenv`,
 * header `api-key:`, extrait `~/.claude.json`, tool result echoant l'env) est sinon
 * embeddé VERBATIM dans le champ `content` du payload puis stocké dans
 * `roo_tasks_semantic_index` → devient retrouvable via `roosync_search(semantic)`.
 * Failure mode avéré : task `80e71054` (fuite `QDRANT_API_KEY` + `OPENAI_API_KEY`).
 *
 * Couche PRÉVENTION uniquement : ne purge pas les points déjà indexés (purge séparée,
 * côté coordinateur) et ne remplace pas la rotation de clé. La sur-redaction est
 * volontairement acceptée — un secret n'est pas un terme de recherche utile, mieux
 * vaut masquer trop que laisser fuiter. Chaque entrée = [regex, remplacement] ;
 * la VALEUR est masquée, le NOM de clé préservé pour garder le texte lisible.
 */
export const SECRET_PATTERNS: Array<[RegExp, string]> = [
    // Tokens auto-préfixés : masqués où qu'ils apparaissent, même sans nom de variable.
    [/sk-[A-Za-z0-9_-]{20,}/g, '<redacted-sk>'],            // OpenAI / Anthropic (incl. sk-proj-…)
    [/gh[opsur]_[A-Za-z0-9]{36,}/g, '<redacted-gh>'],        // GitHub PAT / OAuth / server tokens
    [/xox[baprs]-[A-Za-z0-9-]{10,}/g, '<redacted-slack>'],   // Slack tokens
    [/Bearer\s+[A-Za-z0-9_\-.=]+/gi, 'Bearer <redacted>'],   // Authorization: Bearer …
    // Forme NAME=VALUE / NAME: VALUE (env-dump, header HTTP). Groupe 1 = nom+connecteur (préservé).
    // Couvre QDRANT__SERVICE__API_KEY=…, OPENAI_API_KEY=…, api-key: …, ACCESS_KEY=…, SECRET: …
    // La valeur exige ≥ 8 caractères → un `TOKEN: abc` court n'est pas masqué (bruit).
    [
        /((?:[A-Za-z0-9_]*(?:API[_-]?KEY|APIKEY|SECRET|TOKEN|PASSWORD|PASSWD|ACCESS[_-]?KEY|PRIVATE[_-]?KEY)[A-Za-z0-9_]*)\s*[=:]\s*)['"]?[A-Za-z0-9_\-./+]{8,}['"]?/gi,
        '$1<redacted>',
    ],
];

/**
 * Masque les patterns de secrets dans une chaîne avant indexation (sécurité #2783).
 * @param value La chaîne potentiellement porteuse d'un secret
 * @returns La chaîne avec les valeurs secrètes remplacées par `<redacted…>`
 */
export function redactSecrets(value: string): string {
    let out = value;
    for (const [pattern, replacement] of SECRET_PATTERNS) {
        out = out.replace(pattern, replacement);
    }
    return out;
}

/**
 * Validation et nettoyage des payloads avant envoi à Qdrant
 * @param payload Le payload à nettoyer
 * @returns Le payload nettoyé
 */
export function sanitizePayload(payload: any): any {
    const cleaned = { ...payload };

    // Nettoyer les valeurs problématiques
    Object.keys(cleaned).forEach(key => {
        if (cleaned[key] === undefined) {
            delete cleaned[key];
        }
        if (cleaned[key] === null && key !== 'parent_task_id' && key !== 'root_task_id') {
            delete cleaned[key];
        }
        if (typeof cleaned[key] === 'string') {
            // Masquer les secrets AVANT le check empty (sécurité #2783)
            cleaned[key] = redactSecrets(cleaned[key]);
            // S'assurer que les strings ne sont pas vides
            if (cleaned[key].trim() === '') {
                delete cleaned[key];
            }
        }
    });

    return cleaned;
}