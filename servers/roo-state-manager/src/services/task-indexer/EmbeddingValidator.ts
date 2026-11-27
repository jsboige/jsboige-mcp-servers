/**
 * Module responsable de la validation et du nettoyage des embeddings et payloads.
 * Extrait de TaskIndexer.ts pour respecter le principe de responsabilité unique.
 */

import { StateManagerError } from '@vibesync/core/types/errors';
import { getEmbeddingDimensions } from '../openai.js';
import { redactSecrets } from '@vibesync/core/utils/secret-redaction';
import { createKnownValueMasker } from '@vibesync/core/utils/known-value-masker';

export { SECRET_PATTERNS, redactSecrets } from '@vibesync/core/utils/secret-redaction';

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
 * Validation et nettoyage des payloads avant envoi à Qdrant
 * @param payload Le payload à nettoyer
 * @returns Le payload nettoyé
 */
// Masqueur par valeur connue, construit une fois par process (l'index — scan de l'env,
// tri par longueur — ne dépend pas du payload ; cf. header de known-value-masker.ts).
let cachedKnownValueMasker: ((text: string) => string) | null = null;

/** Réinitialise le cache du masqueur par valeur — réservé aux tests (env injecté). */
export function resetKnownValueMaskerCache(): void {
    cachedKnownValueMasker = null;
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

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
            // Masquer les secrets AVANT le check empty (#2783, #3584 §5.3) :
            // forme d'abord (motifs auto-descriptifs), valeur connue ensuite.
            if (!cachedKnownValueMasker) cachedKnownValueMasker = createKnownValueMasker();
            cleaned[key] = cachedKnownValueMasker(redactSecrets(cleaned[key]));
            // splitChunk and the content_summary truncations cut by UTF-16 index and can
            // split an emoji's surrogate pair; Qdrant rejects the lone half with a 400 and
            // the whole upsert window fails (#4352, 27/10). Replace it with U+FFFD.
            cleaned[key] = cleaned[key].replace(LONE_SURROGATE, '�');
            // S'assurer que les strings ne sont pas vides
            if (cleaned[key].trim() === '') {
                delete cleaned[key];
            }
        }
    });

    return cleaned;
}