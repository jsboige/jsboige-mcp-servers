/**
 * Module responsable de la validation et du nettoyage des embeddings et payloads.
 * Extrait de TaskIndexer.ts pour respecter le principe de responsabilité unique.
 */

/**
 * Valide qu'un vecteur a la bonne dimension et ne contient pas de NaN/Infinity
 * @param vector Le vecteur à valider
 * @param expectedDim La dimension attendue (défaut: 1536)
 * @throws Error si le vecteur est invalide
 */
export function validateVectorGlobal(vector: number[], expectedDim: number = 1536): void {
    if (!Array.isArray(vector)) {
        throw new Error(`Vector doit être un tableau, reçu: ${typeof vector}`);
    }

    if (vector.length !== expectedDim) {
        throw new Error(`Dimension invalide: ${vector.length}, attendu: ${expectedDim}`);
    }

    // Vérifier NaN/Infinity qui causent erreurs 400
    const hasInvalidValues = vector.some(v => !Number.isFinite(v));
    if (hasInvalidValues) {
        throw new Error(`Vector contient NaN ou Infinity - invalide pour Qdrant`);
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