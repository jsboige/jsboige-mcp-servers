/**
 * Format hiérarchique complet pour export d'arbres de tâches
 * Génère un format markdown conforme aux spécifications SDDD Mission 4/4
 */

import { TaskTreeNode } from './format-ascii-tree.js';

export interface FormatHierarchicalTreeOptions {
    includeToC?: boolean;
    includeLegend?: boolean;
    includeStats?: boolean;
}

/**
 * Génère les emojis de statut
 */
function getStatusEmoji(isCompleted: boolean): string {
    return isCompleted ? '✅' : '🔄';
}

/**
 * Génère les emojis de mode
 */
function getModeEmoji(mode: string): string {
    const modeMap: { [key: string]: string } = {
        'code': '💻',
        'debug': '🪲',
        'architect': '🏗️',
        'ask': '❓',
        'orchestrator': '🪃',
        'manager': '👨💼',
        'project-manager': '🏢'
    };
    return modeMap[mode.toLowerCase()] || '📍';
}

/**
 * Formate la date au format lisible
 */
function formatDate(dateStr: string): string {
    try {
        const date = new Date(dateStr);
        if (isNaN(date.getTime())) {
            return dateStr;
        }
        return date.toISOString();
    } catch {
        return dateStr;
    }
}

/**
 * Tronque l'instruction à 100 caractères
 */
function truncateInstruction(instruction: string | undefined): string {
    if (!instruction) return 'No instruction';
    if (instruction.length <= 100) return instruction;
    return instruction.substring(0, 100) + '...';
}

/**
 * Compte le nombre total de tâches dans l'arbre
 */
function countTotalTasks(node: TaskTreeNode): number {
    let count = 1;
    if (node.children) {
        node.children.forEach(child => {
            count += countTotalTasks(child);
        });
    }
    return count;
}

/**
 * Compte le nombre de relations (liens parent-enfant)
 */
function countRelations(node: TaskTreeNode): number {
    let count = 0;
    if (node.children) {
        count += node.children.length;
        node.children.forEach(child => {
            count += countRelations(child);
        });
    }
    return count;
}

/**
 * Trouve la profondeur maximale de l'arbre
 */
function getMaxDepth(node: TaskTreeNode): number {
    if (!node.children || node.children.length === 0) {
        return node.metadata?.depth ?? 0;
    }
    return Math.max(...node.children.map(child => getMaxDepth(child)));
}

/**
 * Génère l'en-tête avec table des matières et statistiques
 */
function generateHeader(rootNode: TaskTreeNode, options: FormatHierarchicalTreeOptions): string {
    const totalTasks = countTotalTasks(rootNode);
    const totalRelations = countRelations(rootNode);
    const maxDepth = getMaxDepth(rootNode) + 1; // +1 car depth commence à 0
    
    let header = `# Arbre Hiérarchique Complet - Cluster ${rootNode.taskIdShort}\n\n`;
    
    if (options.includeStats !== false) {
        header += `## Statistiques Globales\n`;
        header += `- **Total tâches** : ${totalTasks}\n`;
        header += `- **Relations détectées** : ${totalRelations}/${totalTasks} (${((totalRelations/totalTasks)*100).toFixed(2)}%)\n`;
        header += `- **Racines** : 1 (${rootNode.taskIdShort})\n`;
        header += `- **Profondeur maximale** : ${maxDepth} niveaux\n`;
        header += `- **Date de génération** : ${new Date().toISOString().split('T')[0]}\n\n`;
    }
    
    if (options.includeToC !== false) {
        header += `## Navigation Rapide\n`;
        header += `- [Racine ${rootNode.taskIdShort}](#task-${rootNode.taskIdShort}) - ${truncateInstruction(rootNode.metadata?.truncatedInstruction)}\n\n`;
    }
    
    if (options.includeLegend !== false) {
        header += `## Légende\n\n`;
        header += `### Statuts\n`;
        header += `- ✅ \`completed\` : Tâche terminée\n`;
        header += `- 🔄 \`in_progress\` : En cours d'exécution\n`;
        header += `- ⏸️ \`paused\` : En pause\n`;
        header += `- ❌ \`failed\` : Échec\n\n`;
        header += `### Modes\n`;
        header += `- 💻 \`code\` : Modifications de code\n`;
        header += `- 🪲 \`debug\` : Débogage\n`;
        header += `- 🏗️ \`architect\` : Architecture\n`;
        header += `- ❓ \`ask\` : Questions/Explications\n`;
        header += `- 🪃 \`orchestrator\` : Coordination\n\n`;
        header += `---\n\n`;
    }
    
    return header;
}

/**
 * Formate un nœud de tâche selon le format exact requis
 */
function formatTaskNode(node: TaskTreeNode, indentLevel: number = 0): string {
    const indent = '> '.repeat(indentLevel);
    const mode = node.metadata?.mode ?? 'Unknown';
    const modeEmoji = getModeEmoji(mode);
    const isCompleted = node.metadata?.isCompleted ?? false;
    const statusEmoji = getStatusEmoji(isCompleted);
    const status = isCompleted ? 'completed' : 'in_progress';
    const instruction = truncateInstruction(node.metadata?.truncatedInstruction);
    
    let output = '';
    
    // En-tête de la tâche avec ancre
    output += `${indent}## [${node.taskIdShort}] ${modeEmoji} ${instruction} (${mode})\n`;
    output += `${indent}{: #task-${node.taskIdShort} }\n`;
    
    // Métadonnées sur une ligne
    output += `${indent}**Status:** ${statusEmoji} ${status} | `;
    output += `**Created:** ${formatDate(node.metadata?.createdAt ?? 'Unknown')} | `;
    output += `**Messages:** ${node.metadata?.messageCount ?? 0} | `;
    output += `**Size:** ${node.metadata?.totalSizeKB ?? 0} KB\n`;
    
    // Instruction complète
    output += `${indent}**Instruction:** ${instruction}\n`;
    
    // Workspace
    output += `${indent}**Workspace:** ${node.metadata?.workspace ?? 'Unknown'}\n`;
    
    // Section Children
    output += `${indent}\n`;
    output += `${indent}### Children: ${node.metadata?.childrenCount ?? 0}\n`;
    
    // Traiter les enfants avec indentation
    if (node.children && node.children.length > 0) {
        output += `${indent}\n`;
        node.children.forEach(child => {
            output += formatTaskNode(child, indentLevel + 1);
        });
    }
    
    output += `${indent}\n`;
    
    return output;
}

/**
 * Génère l'arbre hiérarchique complet au format markdown
 */
export function formatTaskTreeHierarchical(
    tree: TaskTreeNode,
    options: FormatHierarchicalTreeOptions = {}
): string {
    let output = '';
    
    // En-tête avec statistiques et légende
    output += generateHeader(tree, options);
    
    // Arbre des tâches
    output += formatTaskNode(tree, 0);
    
    return output;
}