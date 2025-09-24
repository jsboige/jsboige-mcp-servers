/**
 * Index radix-tree pour les instructions de création de sous-tâches
 * Optimisé pour la recherche rapide de relations parent-enfant
 */

import { NewTaskInstruction } from '../types/conversation.js';

/**
 * Noeud du radix-tree pour l'indexation des instructions
 */
interface RadixTreeNode {
    prefix: string;
    isEndOfKey: boolean;
    parentTaskId?: string;
    instruction?: NewTaskInstruction;
    children: Map<string, RadixTreeNode>;
}

/**
 * Index radix-tree pour les instructions de création de sous-tâches
 */
export class TaskInstructionIndex {
    private root: RadixTreeNode;
    
    constructor() {
        this.root = {
            prefix: '',
            isEndOfKey: false,
            children: new Map()
        };
    }

    /**
     * Ajoute une instruction au radix-tree
     * @param instructionPrefix - Préfixe de l'instruction (tronqué à 200 chars)
     * @param parentTaskId - ID de la tâche parente qui contient cette instruction
     * @param instruction - Instruction complète (optionnelle)
     */
    addInstruction(instructionPrefix: string, parentTaskId: string, instruction?: NewTaskInstruction): void {
        if (!instructionPrefix || instructionPrefix.length === 0) return;
        
        // Normaliser le préfixe : minuscules + espaces normalisés
        const normalizedPrefix = this.normalizePrefix(instructionPrefix);
        console.log(`[PASS 1 - INDEXING] Task: ${parentTaskId.substring(0,8)} | NORMALIZED PREFIX: "${normalizedPrefix}"`);
        this.insertIntoTree(this.root, normalizedPrefix, parentTaskId, instruction);
    }

    /**
     * @deprecated MÉTHODE CORROMPUE - Violait le principe architectural
     *
     * 🛡️ PRINCIPE ARCHITECTURAL CORRECT :
     * - Les parents déclarent leurs enfants via les instructions new_task
     * - Le radix tree stocke ces déclarations (préfixes → parents)
     * - On NE DOIT JAMAIS utiliser ce tree pour "deviner" un parent depuis un enfant
     * - Le parentId vient UNIQUEMENT des métadonnées ou reste undefined
     *
     * @param childText - Texte de la tâche enfant (titre + description)
     * @returns TOUJOURS undefined pour respecter l'architecture
     */
    findPotentialParent(childText: string, excludeTaskId?: string): string | undefined {
        // 🛡️ CORRECTION ARCHITECTURE : Retourner toujours undefined
        // Plus aucune tentative de recherche inverse dans le radix tree
        // Le radix tree reste alimenté par les parents mais n'est plus utilisé pour l'inférence
        console.log(`[findPotentialParent] ⚠️ MÉTHODE DÉSACTIVÉE - Architecture corrigée`);
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
        // 🛡️ CORRECTION ARCHITECTURE : Retourner toujours un tableau vide
        console.log(`[findAllPotentialParents] ⚠️ MÉTHODE DÉSACTIVÉE - Architecture corrigée`);
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
                this.addInstruction(prefix, taskId);
            }
        }
        
        console.log(`[TaskInstructionIndex] ✅ Index reconstruit`);
    }

    /**
     * Obtient les statistiques de l'index
     */
    getStats(): { totalNodes: number; totalInstructions: number; avgDepth: number } {
        const stats = { totalNodes: 0, totalInstructions: 0, depths: [] as number[] };
        this.traverseForStats(this.root, 0, stats);
        
        return {
            totalNodes: stats.totalNodes,
            totalInstructions: stats.totalInstructions,
            avgDepth: stats.depths.length > 0 ? stats.depths.reduce((a, b) => a + b, 0) / stats.depths.length : 0
        };
    }

    /**
     * Vide complètement l'index
     */
    clear(): void {
        this.root = {
            prefix: '',
            isEndOfKey: false,
            children: new Map()
        };
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

    private normalizePrefix(text: string): string {
        // 🎯 CORRECTION CRITIQUE SDDD : Normalisation cohérente pour matching RadixTree
        // Applique exactement la même transformation pour indexation ET recherche
        return text.toLowerCase().trim().substring(0, 192);
    }

    private insertIntoTree(node: RadixTreeNode, key: string, parentTaskId: string, instruction?: NewTaskInstruction): void {
        if (key.length === 0) {
            node.isEndOfKey = true;
            node.parentTaskId = parentTaskId;
            node.instruction = instruction;
            return;
        }

        // Rechercher un enfant avec un préfixe commun
        for (const [childKey, childNode] of node.children) {
            const commonPrefix = this.getCommonPrefix(key, childKey);
            
            if (commonPrefix.length > 0) {
                if (commonPrefix === childKey) {
                    // Le préfixe correspond exactement, continuer dans cet enfant
                    this.insertIntoTree(childNode, key.substring(commonPrefix.length), parentTaskId, instruction);
                    return;
                } else {
                    // Diviser le noeud existant
                    this.splitNode(node, childKey, childNode, commonPrefix);
                    this.insertIntoTree(node, key, parentTaskId, instruction);
                    return;
                }
            }
        }

        // Aucun préfixe commun trouvé, créer un nouveau noeud
        const newNode: RadixTreeNode = {
            prefix: key,
            isEndOfKey: true,
            parentTaskId,
            instruction,
            children: new Map()
        };
        node.children.set(key, newNode);
    }

    private splitNode(parentNode: RadixTreeNode, existingKey: string, existingNode: RadixTreeNode, commonPrefix: string): void {
        // Supprimer l'ancien noeud
        parentNode.children.delete(existingKey);

        // Créer le nouveau noeud intermédiaire
        const intermediateNode: RadixTreeNode = {
            prefix: commonPrefix,
            isEndOfKey: false,
            children: new Map()
        };

        // Mettre à jour l'ancien noeud
        const remainingKey = existingKey.substring(commonPrefix.length);
        existingNode.prefix = remainingKey;
        intermediateNode.children.set(remainingKey, existingNode);

        // Ajouter le noeud intermédiaire au parent
        parentNode.children.set(commonPrefix, intermediateNode);
    }

    private searchInTree(node: RadixTreeNode, text: string): Array<{prefix: string, parentTaskId: string}> {
        const results: Array<{prefix: string, parentTaskId: string}> = [];

        // Recherche récursive dans tous les noeuds
        this.searchRecursive(node, text, '', results);

        return results;
    }

    private searchRecursive(node: RadixTreeNode, text: string, currentPrefix: string, results: Array<{prefix: string, parentTaskId: string}>): void {
        // Si ce noeud termine une clé et que le texte est similaire au préfixe actuel
        if (node.isEndOfKey && node.parentTaskId && this.calculateSimilarity(text, currentPrefix) > 0.2) {
            const similarity = this.calculateSimilarity(text, currentPrefix);
            console.log(`[SIMILARITY MATCH] Prefix: "${currentPrefix.substring(0, 50)}..." | Similarity: ${similarity.toFixed(3)} | TaskId: ${node.parentTaskId.substring(0, 8)}`);
            results.push({
                prefix: currentPrefix,
                parentTaskId: node.parentTaskId
            });
        }

        // Continuer la recherche dans tous les enfants
        for (const [childKey, childNode] of node.children) {
            const newPrefix = currentPrefix + childKey;
            this.searchRecursive(childNode, text, newPrefix, results);
        }
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

    private getCommonPrefix(str1: string, str2: string): string {
        let i = 0;
        while (i < str1.length && i < str2.length && str1[i] === str2[i]) {
            i++;
        }
        return str1.substring(0, i);
    }

    private traverseForStats(node: RadixTreeNode, depth: number, stats: any): void {
        stats.totalNodes++;
        if (node.isEndOfKey) {
            stats.totalInstructions++;
            stats.depths.push(depth);
        }

        for (const childNode of node.children.values()) {
            this.traverseForStats(childNode, depth + 1, stats);
        }
    }
}

/**
 * Instance globale du système d'index des instructions
 */
export const globalTaskInstructionIndex = new TaskInstructionIndex();