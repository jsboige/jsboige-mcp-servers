/**
 * Index radix-tree pour les instructions de création de sous-tâches
 * Optimisé pour la recherche rapide de relations parent-enfant
 * Utilise exact-trie pour le matching longest-prefix robuste
 */

import { NewTaskInstruction } from '../types/conversation.js';
import Trie from 'exact-trie';
import { extractSubInstructions } from './sub-instruction-extractor.js';

/**
 * Structure pour stocker plusieurs parents par préfixe
 */
interface PrefixEntry {
    parentTaskIds: string[];
    instructions?: NewTaskInstruction[];
}

/**
 * Index radix-tree pour les instructions de création de sous-tâches
 */
export class TaskInstructionIndex {
    private trie: Trie; // exact-trie pour longest-prefix match
    private prefixToEntry: Map<string, PrefixEntry>; // Map interne pour itération et statistiques
    private parentToInstructions: Map<string, string[]>; // Pour getInstructionsByParent()
    
    constructor() {
        this.trie = new Trie();
        this.prefixToEntry = new Map();
        this.parentToInstructions = new Map();
    }

    /**
     * Ajoute une instruction au radix-tree
     * @param instructionPrefix - Préfixe de l'instruction (tronqué à 200 chars)
     * @param parentTaskId - ID de la tâche parente qui contient cette instruction
     * @param instruction - Instruction complète (optionnelle)
     */
    addInstruction(parentTaskId: string, instructionPrefix: string, instruction?: string): void {
        if (!instructionPrefix || instructionPrefix.length === 0) return;
        
        // Normaliser le préfixe avec la fonction unifiée
        const normalizedPrefix = computeInstructionPrefix(instructionPrefix, 192);
        
        // Récupérer ou créer l'entrée pour ce préfixe
        let entry = this.prefixToEntry.get(normalizedPrefix);
        if (!entry) {
            entry = { parentTaskIds: [], instructions: [] };
            this.prefixToEntry.set(normalizedPrefix, entry);
            this.trie.put(normalizedPrefix, entry); // Ajouter au trie pour longest-prefix search
        }
        
        // Ajouter le parentTaskId
        if (!entry.parentTaskIds.includes(parentTaskId)) {
            entry.parentTaskIds.push(parentTaskId);
        }
        
        // Ajouter l'instruction complète si fournie
        if (instruction && entry.instructions) {
            // Convertir la string en NewTaskInstruction
            const taskInstruction: NewTaskInstruction = {
                mode: 'unknown', // Mode sera déterminé par le contexte
                message: instruction,
                timestamp: Date.now()
            };
            entry.instructions.push(taskInstruction);
        }
        
        // Maintenir l'index inversé pour getInstructionsByParent
        if (!this.parentToInstructions.has(parentTaskId)) {
            this.parentToInstructions.set(parentTaskId, []);
        }
        const parentInstructions = this.parentToInstructions.get(parentTaskId)!;
        if (!parentInstructions.includes(normalizedPrefix)) {
            parentInstructions.push(normalizedPrefix);
        }
    }

    /**
     * Ajoute une tâche parent complète en extrayant automatiquement les sous-instructions
     * CORRECTION DE LA RÉGRESSION CRITIQUE
     * @param parentTaskId - ID de la tâche parente
     * @param fullInstructionText - Texte complet de l'instruction parente
     */
    addParentTaskWithSubInstructions(parentTaskId: string, fullInstructionText: string): number {
        if (!fullInstructionText) return 0;
        
        // 1. Extraire les sous-instructions du texte parent
        const subInstructions = extractSubInstructions(fullInstructionText);
        
        // 2. Indexer chaque sous-instruction extraite
        let indexedCount = 0;
        for (const subInstruction of subInstructions) {
            this.addInstruction(parentTaskId, subInstruction, subInstruction);
            indexedCount++;
        }
        
        // 3. Si aucune sous-instruction trouvée, utiliser l'ancienne méthode (fallback)
        if (indexedCount === 0) {
            const fallbackPrefix = computeInstructionPrefix(fullInstructionText, 192);
            this.addInstruction(parentTaskId, fallbackPrefix, fullInstructionText);
            indexedCount = 1;
        }
        
        return indexedCount;
    }

    /**
     * Recherche exacte sur préfixe dans l'index (SDDD Phase 2 - strict prefix only)
     * Utilise exact-trie.getWithCheckpoints() pour LONGEST PREFIX MATCH
     * @param childText - Texte de la tâche enfant pour générer le préfixe de recherche
     * @param K - Longueur de préfixe pour générer le searchPrefix (défaut: 192)
     * @returns Array des tâches avec préfixe exactement égal (longest match)
     *
     * IMPORTANT: K est utilisé pour normaliser ET tronquer childText avant la recherche.
     * Cela signifie que la recherche avec K=20 cherchera un préfixe de 20 chars dans le trie.
     * Pour le cas d'usage réel (reconstruction hiérarchique), K est toujours 192.
     */
    searchExactPrefix(childText: string, K: number = 192): Array<{ taskId: string, prefix: string }> {
        if (!childText || childText.length === 0) return [];
        
        // ATTENTION: On normalise avec K pour que la recherche soit cohérente
        // Si K=20, on cherche un préfixe de 20 chars
        // Si K=192, on cherche un préfixe de 192 chars (cas d'usage standard)
        const searchPrefix = computeInstructionPrefix(childText, K);
        if (process.env.ROO_DEBUG_INSTRUCTIONS === '1') {
            console.log(`[EXACT PREFIX SEARCH] Searching for: "${searchPrefix}" (K=${K})`);
        }
        
        // Utiliser getWithCheckpoints() pour EXACT PREFIX MATCH
        const entry = this.trie.getWithCheckpoints(searchPrefix) as PrefixEntry | undefined;
        
        const results: Array<{ taskId: string, prefix: string }> = [];
        
        if (entry) {
            // LOGIQUE SIMPLE ET FONCTIONNELLE : utiliser directement le résultat du trie
            // Trouver la clé exacte dans la Map qui correspond à cette entrée
            let matchedKey = '';
            for (const [key, value] of this.prefixToEntry.entries()) {
                if (value === entry) {
                    matchedKey = key;
                    break;
                }
            }
            
            if (matchedKey) {
                // Ajouter tous les parents associés à cette clé
                for (const parentId of entry.parentTaskIds) {
                    results.push({
                        taskId: parentId,
                        prefix: matchedKey
                    });
                }
                
                if (process.env.ROO_DEBUG_INSTRUCTIONS === '1') {
                    console.log(`[EXACT PREFIX SEARCH] Found exact match: "${matchedKey}" (${matchedKey.length} chars) → ${entry.parentTaskIds.length} parent(s)`);
                }
            }
        }
        
        if (process.env.ROO_DEBUG_INSTRUCTIONS === '1') {
            console.log(`[EXACT PREFIX SEARCH] Found ${results.length} exact matches`);
        }
        return results;
    }

    /**
     * @deprecated MÉTHODE CORROMPUE - Violait le principe architectural
     *
     * 🛡️ PRINCIPE ARCHITECTURAL CORRECT :
     * - Les parents déclarent leurs enfants via les instructions new_task
     * - Le radix tree stocke ces déclarations (préfixes → parents)
     * - On NE DOIT JAMAIS utiliser ce tree pour "deviner" un parent depuis un enfant
     * - Le parentId vient du matching exact du préfixe de longueur max, PAS d'une supposition
     *
     * @param childText - Texte de la tâche enfant (titre + description)
     * @returns TOUJOURS undefined pour respecter l'architecture
     */
    findPotentialParent(childText: string, excludeTaskId?: string): string | undefined {
        console.warn('⚠️ DEPRECATED: findPotentialParent() violates architecture - use searchExactPrefix() instead');
        // 🛡️ CORRECTION ARCHITECTURE : Méthode complètement désactivée
        // Les relations parent-enfant doivent être définies par les parents, pas devinées
        return undefined;
    }

    /**
     * @deprecated MÉTHODE CORROMPUE - Violait le principe architectural
     *
     * Cette méthode tentait de retrouver des parents depuis les enfants,
     * ce qui viole le principe de déclaration descendante.
     *
     * @returns TOUJOURS un tableau vide pour respecter l'architecture
     */
    findAllPotentialParents(childText: string): string[] {
        console.warn('⚠️ DEPRECATED: findAllPotentialParents() violates architecture - use searchExactPrefix() instead');
        return [];
    }

    /**
     * Reconstruction à partir de squelettes existants
     * @param skeletonPrefixes - Map des taskId vers leurs préfixes d'instructions
     */
    rebuildFromSkeletons(skeletonPrefixes: Map<string, string[]>): void {
        console.log(`[TaskInstructionIndex] 🔄 Reconstruction à partir de ${skeletonPrefixes.size} squelettes`);
        
        for (const [taskId, prefixes] of skeletonPrefixes) {
            for (const prefix of prefixes) {
                this.addInstruction(taskId, prefix);
            }
        }
        
        console.log(`[TaskInstructionIndex] ✅ Index reconstruit`);
    }

    /**
     * Obtient les statistiques de l'index
     */
    getStats(): { totalNodes: number; totalInstructions: number; avgDepth: number } {
        let totalInstructions = 0;
        let totalParents = 0;
        
        // Parcourir toutes les entrées via la Map interne
        for (const entry of this.prefixToEntry.values()) {
            totalInstructions++;
            totalParents += entry.parentTaskIds.length;
        }
        
        return {
            totalNodes: this.prefixToEntry.size, // Nombre de clés uniques
            totalInstructions,
            avgDepth: totalParents > 0 ? totalParents / totalInstructions : 0
        };
    }

    /**
     * Vide complètement l'index
     */
    clear(): void {
        this.trie = new Trie(); // Recréer le trie (pas de méthode clear())
        this.prefixToEntry.clear();
        this.parentToInstructions.clear();
    }

    /**
     * 🧪 TEST UNITAIRE SDDD - Validation de l'algorithme de similarité
     * Test les cas critiques identifiés dans la mission
     */
    testSimilarityAlgorithm(): void {
        console.log('\n🧪 === TEST ALGORITHME SIMILARITÉ SDDD ===');
        
        // Test case 1: Cas réel de la mission
        const text1 = "**mission debug critique : réparation du système hiérarchique...";
        const text2 = "**mission corrective finale : validation et documentation...";
        const similarity1 = this.calculateSimilarity(text1, text2);
        
        console.log(`🎯 TEST 1 (Cas réel mission):`);
        console.log(`   Text1: "${text1.substring(0, 50)}..."`);
        console.log(`   Text2: "${text2.substring(0, 50)}..."`);
        console.log(`   Similarité: ${similarity1.toFixed(3)} (seuil: 0.2)`);
        console.log(`   Résultat: ${similarity1 > 0.2 ? '✅ MATCH' : '❌ NO MATCH'}`);
        
        // Test case 2: Match évident
        const text3 = "**mission debug critique système réparation";
        const text4 = "**mission debug critique réparation système";
        const similarity2 = this.calculateSimilarity(text3, text4);
        
        console.log(`\n🎯 TEST 2 (Match évident):`);
        console.log(`   Text3: "${text3}"`);
        console.log(`   Text4: "${text4}"`);
        console.log(`   Similarité: ${similarity2.toFixed(3)} (seuil: 0.2)`);
        console.log(`   Résultat: ${similarity2 > 0.2 ? '✅ MATCH' : '❌ NO MATCH'}`);
        
        // Test case 3: Pas de match
        const text5 = "bonjour analyse git projet";
        const text6 = "mission powerpoint génération slides";
        const similarity3 = this.calculateSimilarity(text5, text6);
        
        console.log(`\n🎯 TEST 3 (Pas de match):`);
        console.log(`   Text5: "${text5}"`);
        console.log(`   Text6: "${text6}"`);
        console.log(`   Similarité: ${similarity3.toFixed(3)} (seuil: 0.2)`);
        console.log(`   Résultat: ${similarity3 > 0.2 ? '✅ MATCH' : '❌ NO MATCH'}`);
        
        console.log('\n🧪 === FIN TESTS SIMILARITÉ ===\n');
        
        // Validation SDDD
        if (similarity1 > 0.2 && similarity2 > 0.2 && similarity3 <= 0.2) {
            console.log('✅ 🎯 VALIDATION SDDD RÉUSSIE : Algorithme de similarité fonctionnel !');
        } else {
            console.log('❌ 🚨 ÉCHEC VALIDATION SDDD : Algorithme nécessite ajustement !');
        }
    }

    // Méthodes privées

    /**
     * @deprecated Use computeInstructionPrefix() instead for consistency
     */
    private normalizePrefix(text: string): string {
        // Délègue à computeInstructionPrefix pour cohérence
        return computeInstructionPrefix(text, 192);
    }

    /**
     * 🎯 CORRECTIF ALGORITHMIQUE SDDD : Algorithme de similarité robuste
     * Remplace le text.includes() défaillant par un système de mots communs pondérés
     * @param text1 - Premier texte (recherché)
     * @param text2 - Deuxième texte (indexé)
     * @returns Score de similarité [0-1]
     */
    private calculateSimilarity(text1: string, text2: string): number {
        if (!text1 || !text2) return 0;
        if (text1 === text2) return 1;

        // Normalisation identique pour les deux textes
        const words1 = this.extractSignificantWords(text1.toLowerCase());
        const words2 = this.extractSignificantWords(text2.toLowerCase());

        if (words1.length === 0 || words2.length === 0) return 0;

        // Algorithme de mots communs avec pondération par longueur
        const commonWords = words1.filter(w => words2.includes(w));
        const totalUniqueWords = new Set([...words1, ...words2]).size;

        // Score basé sur mots communs pondérés par importance
        const commonWordsScore = commonWords.length / Math.max(words1.length, words2.length);
        
        // Bonus pour mots significatifs longs (>4 caractères)
        const significantCommonWords = commonWords.filter(w => w.length > 4);
        const significantBonus = significantCommonWords.length * 0.1;

        // Score final avec bonus
        const finalScore = Math.min(1.0, commonWordsScore + significantBonus);
        
        return finalScore;
    }

    /**
     * Extrait les mots significatifs d'un texte (>3 caractères, filtre les mots vides)
     * @param text - Texte à analyser
     * @returns Array des mots significatifs
     */
    private extractSignificantWords(text: string): string[] {
        const stopWords = new Set(['les', 'des', 'une', 'est', 'sont', 'avec', 'dans', 'pour', 'que', 'qui', 'sur', 'par', 'and', 'the', 'for', 'are', 'that', 'this', 'with']);
        
        return text
            .replace(/[^\w\s]/g, ' ') // Remplacer ponctuation par espaces
            .split(/\s+/)
            .filter(word => word.length > 3 && !stopWords.has(word))
            .filter((word, index, arr) => arr.indexOf(word) === index); // Supprimer doublons
    }



    /**
     * Obtient la taille de l'index (nombre de clés uniques dans le trie)
     */
    async getSize(): Promise<number> {
        return this.prefixToEntry.size;
    }

    /**
     * Recherche similaire dans l'index avec seuil de similarité
     * @param searchText - Texte à rechercher
     * @param threshold - Seuil de similarité (0-1)
     * @returns Array des résultats avec leurs scores
     */
    async searchSimilar(searchText: string, threshold: number = 0.2): Promise<Array<{taskId: string, similarity: number, prefix: string, similarityScore?: number, matchType?: string}>> {
        if (!searchText || searchText.length === 0) return [];
        
        const normalizedSearch = this.normalizePrefix(searchText);
        const results: Array<{taskId: string, similarity: number, prefix: string, similarityScore?: number, matchType?: string}> = [];
        
        // Parcourir toutes les entrées via la Map interne
        for (const [prefix, entry] of this.prefixToEntry.entries()) {
            const similarity = this.calculateSimilarity(normalizedSearch, prefix);
            
            if (similarity >= threshold) {
                for (const parentId of entry.parentTaskIds) {
                    results.push({
                        taskId: parentId,
                        similarity,
                        similarityScore: similarity,
                        prefix,
                        matchType: similarity === 1 ? 'exact' : similarity > 0.5 ? 'prefix' : 'fuzzy'
                    });
                }
            }
        }
        
        // Trier par score décroissant
        return results.sort((a, b) => b.similarity - a.similarity);
    }

    /**
     * Obtient les instructions par parent
     * @param parentId - ID du parent
     * @returns Array des instructions du parent
     */
    getInstructionsByParent(parentId: string): string[] {
        return this.parentToInstructions.get(parentId) || [];
    }

    /**
     * Valide une relation parent-enfant via recherche exacte de préfixe
     * @param childText - Texte de l'enfant
     * @param parentId - ID du parent
     * @returns true si la relation est valide
     */
    validateParentChildRelation(childText: string, parentId: string): boolean {
        if (!childText || !parentId) return false;
        
        // Utiliser searchExactPrefix pour vérifier si ce parent est trouvé
        const matches = this.searchExactPrefix(childText, 192);
        return matches.some(m => m.taskId === parentId);
    }

}

/**
 * SDDD Phase 2 - API de préfixe unifiée
 * Fonction utilitaire unifiée pour la normalisation des préfixes d'instructions
 * @param raw - Texte brut de l'instruction
 * @param K - Longueur maximale du préfixe (défaut: 192)
 * @returns Préfixe normalisé et tronqué
 */
export function computeInstructionPrefix(raw: string, K: number = 192): string {
    if (!raw) return '';

    // Normalisations robustes avant troncature
    let s = String(raw);

    // 1) Retirer un éventuel BOM UTF-8 en tête
    s = s.replace(/^\uFEFF/, '');

    // 2) Dé-échappements simples courants (contenus provenant de JSON échappé)
    //    Ne pas faire de parsing JSON ici pour rester ultra-robuste
    s = s
        .replace(/\\r\\n/g, '\n')
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t')
        .replace(/\\\\/g, '\\')
        .replace(/\\"/g, '"')
        .replace(/\\'/g, "'");

    // 3) Décodage des entités HTML (nommées + numériques)
    // Ordre important pour éviter double-décodage
    s = s
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&apos;/gi, "'")
        .replace(/&#39;/gi, "'")
        .replace(/&amp;/gi, '&');

    // Entités numériques décimales
    s = s.replace(/&#(\d+);/g, (_m, d: string) => {
        const code = parseInt(d, 10);
        return Number.isFinite(code) ? String.fromCharCode(code) : _m;
    });
    // Entités numériques hexadécimales
    s = s.replace(/&#x([0-9a-fA-F]+);/g, (_m, h: string) => {
        const code = parseInt(h, 16);
        return Number.isFinite(code) ? String.fromCharCode(code) : _m;
    });

    // 4) Nettoyer les restes de JSON du parsing parent (content:", etc.)
    s = s
        .replace(/^["']?content["']?\s*:\s*["']?/i, '')  // Enlever "content": ou 'content': au début
        .replace(/["']$/,'' );  // Enlever guillemet final éventuel

    // 5) Supprimer explicitement les balises de délégation fréquemment vues
    //    et les wrappers <task> / <new_task> même non fermés
    s = s
        .replace(/<\s*task\s*>/gi, ' ')
        .replace(/<\s*\/\s*task\s*>/gi, ' ')
        .replace(/<\s*new_task\b[^>]*>/gi, ' ')
        .replace(/<\s*\/\s*new_task\s*>/gi, ' ');

    // 6) Purge générique de toutes les balises HTML/XML restantes
    s = s.replace(/<[^>]+>/g, ' ');

    // 7) Normalisations finales, minuscules + espaces
    s = s
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();

    // 8) Troncature à K
    // ATTENTION: Ne pas faire de trim() après substring() car cela change la longueur !
    // On fait le trim() AVANT pour normaliser, mais pas APRÈS pour préserver K
    const truncated = s.substring(0, K);
    
    // Si le dernier caractère est un espace, on peut le garder ou le supprimer
    // Pour cohérence avec les tests, on le supprime SEULEMENT si c'est le dernier
    return truncated.trimEnd();
}
/**
 * Instance globale du système d'index des instructions
 */
export const globalTaskInstructionIndex = new TaskInstructionIndex();