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
        this.insertIntoTree(this.root, normalizedPrefix, parentTaskId, instruction);
    }

    /**
     * Recherche le parent potentiel d'une tâche basé sur son titre/description
     * @param childText - Texte de la tâche enfant (titre + description)
     * @returns ID de la tâche parente ou undefined
     */
    findPotentialParent(childText: string): string | undefined {
        if (!childText) return undefined;

        const normalizedText = this.normalizePrefix(childText);
        const matches = this.searchInTree(this.root, normalizedText);
        
        if (matches.length === 0) return undefined;

        // Retourner le match avec le préfixe le plus long (plus spécifique)
        matches.sort((a, b) => b.prefix.length - a.prefix.length);
        return matches[0].parentTaskId;
    }

    /**
     * Recherche multiple - trouve tous les parents potentiels
     * @param childText - Texte de la tâche enfant
     * @returns Array des IDs de tâches parentes potentielles, triées par pertinence
     */
    findAllPotentialParents(childText: string): string[] {
        if (!childText) return [];

        const normalizedText = this.normalizePrefix(childText);
        const matches = this.searchInTree(this.root, normalizedText);
        
        // Supprimer les doublons et trier par pertinence (longueur du préfixe)
        const uniqueParents = Array.from(new Set(matches.map(m => m.parentTaskId!)));
        const parentScores = uniqueParents.map(parentId => {
            const maxPrefixLength = Math.max(...matches
                .filter(m => m.parentTaskId === parentId)
                .map(m => m.prefix.length));
            return { parentId, score: maxPrefixLength };
        });

        return parentScores
            .sort((a, b) => b.score - a.score)
            .map(ps => ps.parentId);
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

    // Méthodes privées

    private normalizePrefix(text: string): string {
        return text
            .toLowerCase()
            .replace(/\s+/g, ' ')
            .trim()
            .substring(0, 200); // Limiter à 200 caractères
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
        // Si ce noeud termine une clé et que le texte contient le préfixe actuel
        if (node.isEndOfKey && node.parentTaskId && text.includes(currentPrefix)) {
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