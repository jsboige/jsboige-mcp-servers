/**
 * Utilitaire de formatage d'arbre ASCII pour les tâches
 * Génère une représentation visuelle avec connecteurs graphiques
 */

/**
 * Interface pour un nœud de tâche dans l'arbre
 */
export interface TaskTreeNode {
    taskId: string;
    taskIdShort: string;
    title: string;
    metadata?: {
        isCompleted?: boolean;
        isCurrentTask?: boolean;
        truncatedInstruction?: string;
        messageCount?: number;
        actionCount?: number;
        totalSizeKB?: number;
        totalSizeBytes?: number;
        lastActivity?: string;
        createdAt?: string;
        mode?: string;
        workspace?: string;
        childrenCount?: number;
        depth?: number;
    };
    children?: TaskTreeNode[];
}

/**
 * Options de formatage pour l'arbre ASCII
 */
export interface FormatAsciiTreeOptions {
    /** Longueur maximale de l'instruction affichée (défaut: 80) */
    truncateInstruction?: number;
    /** Afficher les métadonnées détaillées (défaut: false) */
    showMetadata?: boolean;
    /** Afficher le statut de complétion (défaut: true) */
    showStatus?: boolean;
    /** Symbole pour la racine (défaut: ▶️) */
    rootSymbol?: string;
    /** Marquer la tâche actuelle (défaut: true) */
    highlightCurrent?: boolean;
}

/**
 * Formate un nœud de tâche et ses enfants en arbre ASCII
 * 
 * @param node - Le nœud racine à formatter
 * @param options - Options de formatage
 * @returns String représentant l'arbre ASCII complet
 */
export function formatTaskTreeAscii(
    node: TaskTreeNode,
    options: FormatAsciiTreeOptions = {}
): string {
    const {
        truncateInstruction = 80,
        showMetadata = false,
        showStatus = true,
        rootSymbol = '▶️',
        highlightCurrent = true
    } = options;

    /**
     * Fonction récursive interne pour formatter un nœud
     */
    function formatNode(
        node: TaskTreeNode,
        prefix: string = '',
        isLast: boolean = true,
        isRoot: boolean = false
    ): string {
        let result = '';
        
        // 🎯 CORRECTION : Pour un nœud seul, pas de connecteur
        const hasChildren = node.children && node.children.length > 0;
        const isSingleRoot = isRoot && !hasChildren;
        const connector = isSingleRoot ? '' : (isRoot ? rootSymbol + ' ' : (isLast ? '└─ ' : '├─ '));
        
        // ID court (8 caractères)
        const shortId = node.taskIdShort || node.taskId.substring(0, 8);
        
        // Instruction tronquée
        let instruction = node.metadata?.truncatedInstruction || node.title || 'No instruction';
        if (instruction.length > truncateInstruction) {
            instruction = instruction.substring(0, truncateInstruction - 3) + '...';
        }
        
        // Statut de complétion
        const status = showStatus && node.metadata?.isCompleted
            ? '[Completed]'
            : showStatus && !node.metadata?.isCompleted
            ? '[In Progress]'
            : '';
        
        // 🎯 CORRECTION CRITIQUE : Construire la ligne principale correctement
        let displayName = '';
        if (highlightCurrent && node.metadata?.isCurrentTask) {
            displayName = `${node.title} (TÂCHE ACTUELLE)`;
        } else {
            displayName = `${shortId} - ${instruction}`;
        }
        
        // 🎯 CORRECTION : Construire la ligne principale en une seule fois
        result += `${prefix}${connector}${displayName}`;
        if (status) {
            result += ` ${status}`;
        }
        result += '\n';
        
        // Métadonnées détaillées si demandées
        if (showMetadata && node.metadata) {
            const metaPrefix = prefix + (isLast ? '    ' : '│   ');
            if (node.metadata.messageCount !== undefined) {
                result += `${metaPrefix}    📝 ${node.metadata.messageCount} messages`;
                if (node.metadata.totalSizeBytes !== undefined) {
                    if (node.metadata.totalSizeBytes < 1024) {
                        result += ` | ${node.metadata.totalSizeBytes}`;
                    } else {
                        result += ` | ${node.metadata.totalSizeKB} KB`;
                    }
                }
                result += '\n';
            }
            
            // 🎯 CORRECTION : Ajouter l'icône de taille pour tous les nœuds avec métadonnées
            if (node.metadata.totalSizeBytes !== undefined) {
                result += `${metaPrefix}    📊 ${node.metadata.totalSizeBytes < 1024 ? node.metadata.totalSizeBytes : node.metadata.totalSizeKB} KB\n`;
            }
            
            if (node.metadata.mode) {
                result += `${metaPrefix}    🔧 Mode: ${node.metadata.mode}\n`;
            }
            
            if (node.metadata.workspace) {
                result += `${metaPrefix}    📁 Workspace: ${node.metadata.workspace}\n`;
            }
            
            if (node.metadata.lastActivity) {
                result += `${metaPrefix}    📅 Last activity: ${node.metadata.lastActivity}\n`;
            }
        }
        
        // Traiter les enfants
        if (node.children && node.children.length > 0) {
            const childPrefix = prefix + (isLast ? '    ' : '│   ');
            
            node.children.forEach((child, index) => {
                const isLastChild = index === node.children!.length - 1;
                // DEBUG: Ajout d'un log pour diagnostiquer le problème de connecteur
                if (isLastChild) {
                    console.log(`[DEBUG] Dernier enfant: ${child.taskId}, should use └─`);
                } else {
                    console.log(`[DEBUG] Enfant intermédiaire: ${child.taskId}, should use ├─`);
                }
                result += formatNode(child, childPrefix, isLastChild, false);
            });
        }
        
        return result;
    }
    
    // Commencer le formatage depuis la racine
    // 🎯 CORRECTION : Pour la racine, isLast=true et isRoot=true
    return formatNode(node, '', true, true);
}

/**
 * Génère un en-tête pour l'arbre avec informations contextuelles
 */
export function generateTreeHeader(
    conversationId: string,
    maxDepth: number,
    includeSiblings: boolean,
    rootTitle?: string
): string {
    const date = new Date().toISOString().split('T')[0];
    const time = new Date().toISOString().split('T')[1].substring(0, 8);
    
    let header = `# Arbre de Tâches - ${date} ${time}\n\n`;
    header += `**Conversation ID:** ${conversationId.substring(0, 8)}\n`;
    header += `**Profondeur max:** ${maxDepth === Infinity ? '∞' : maxDepth}\n`;
    header += `**Inclure siblings:** ${includeSiblings ? 'Oui' : 'Non'}\n`;
    if (rootTitle) {
        header += `**Racine:** ${rootTitle}\n`;
    }
    header += '\n---\n\n';
    
    return header;
}

/**
 * Génère un pied de page avec statistiques globales
 */
export function generateTreeFooter(
    totalNodes: number,
    maxDepth: number
): string {
    let footer = '\n---\n\n';
    footer += `**Statistiques:**\n`;
    footer += `- Nombre total de tâches: ${totalNodes}\n`;
    footer += `- Profondeur maximale atteinte: ${maxDepth}\n`;
    footer += `- Généré le: ${new Date().toISOString()}\n`;
    
    return footer;
}

/**
 * Compte récursivement le nombre de nœuds dans l'arbre
 */
export function countTreeNodes(node: TaskTreeNode): number {
    let count = 1; // Le nœud actuel
    if (node.children) {
        for (const child of node.children) {
            count += countTreeNodes(child);
        }
    }
    return count;
}

/**
 * Calcule la profondeur maximale de l'arbre
 */
export function getMaxTreeDepth(node: TaskTreeNode, currentDepth: number = 0): number {
    if (!node.children || node.children.length === 0) {
        return currentDepth;
    }
    
    let maxChildDepth = currentDepth;
    for (const child of node.children) {
        const childDepth = getMaxTreeDepth(child, currentDepth + 1);
        if (childDepth > maxChildDepth) {
            maxChildDepth = childDepth;
        }
    }
    
    return maxChildDepth;
}