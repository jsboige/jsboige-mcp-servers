/**
 * Module responsable de la validation et du nettoyage des embeddings et payloads.
 * Extrait de TaskIndexer.ts pour respecter le principe de responsabilité unique.
 */

import { StateManagerError } from '../../types/errors.js';

/**
 * Valide qu'un vecteur a la bonne dimension et ne contient pas de NaN/Infinity
 * @param vector Le vecteur à valider
 * @param expectedDim La dimension attendue (défaut: 1536)
 * @throws StateManagerError si le vecteur est invalide
 */
export function validateVectorGlobal(vector: number[], expectedDim: number = 1536): void {
    if (!Array.isArray(vector)) {
        throw new StateManagerError(
            `Vector doit être un tableau, reçu: ${typeof vector}`,
            'INVALID_VECTOR_TYPE',
            'EmbeddingValidator',
            { receivedType: typeof vector, expectedType: 'array' }
        );
    }

    if (vector.length !== expectedDim) {
        throw new StateManagerError(
            `Dimension invalide: ${vector.length}, attendu: ${expectedDim}`,
            'INVALID_VECTOR_DIMENSION',
            'EmbeddingValidator',
            { actualDimension: vector.length, expectedDimension: expectedDim }
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
        // S'assurer que les strings ne sont pas vides
        if (typeof cleaned[key] === 'string' && cleaned[key].trim() === '') {
            delete cleaned[key];
        }
    });

    return cleaned;
}