/**
 * Utilitaires de normalisation de chemins
 */

/**
 * Normalise un chemin pour la comparaison en gérant les différences de format
 * entre les plateformes et les sources de données
 */
export function normalizePath(inputPath: string): string {
    if (!inputPath) return '';
    
    // Convertir les slashes en forward slashes pour une comparaison uniforme
    const normalized = inputPath.replace(/\\/g, '/');
    
    // Supprimer les slashes de fin
    const trimmed = normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
    
    // Convertir en minuscules pour éviter les problèmes de casse (principalement Windows)
    return trimmed.toLowerCase();
}