/**
 * Outil pour afficher les détails techniques complets d'une tâche
 */

import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ConversationSkeleton } from '../../types/conversation.js';

/**
 * Formate les détails d'une action
 */
function formatActionDetails(action: any, index: number, truncate: number): string {
    const icon = action.type === 'command' ? '⚙️' : '🛠️';
    let output = `[${index}] ${icon} ${action.name} → ${action.status}\n`;
    
    // Type et timestamp
    output += `    Type: ${action.type}\n`;
    if (action.timestamp) {
        output += `    Timestamp: ${action.timestamp}\n`;
    }
    
    // Paramètres
    if (action.parameters) {
        const paramStr = JSON.stringify(action.parameters, null, 2);
        output += `    Paramètres: ${truncate > 0 ? truncateContent(paramStr, truncate) : paramStr}\n`;
    }
    
    // Résultat (si disponible)
    if ('result' in action && action.result) {
        const resultStr = typeof action.result === 'string' ? action.result : JSON.stringify(action.result, null, 2);
        output += `    Résultat: ${truncate > 0 ? truncateContent(resultStr, truncate) : resultStr}\n`;
    }
    
    // Erreur (si disponible)
    if ('error' in action && action.error) {
        output += `    ❌ Erreur: ${action.error}\n`;
    }
    
    // Métadonnées additionnelles (si disponibles)
    if (action.metadata) {
        const metaStr = JSON.stringify(action.metadata, null, 2);
        output += `    Métadonnées: ${truncate > 0 ? truncateContent(metaStr, truncate) : metaStr}\n`;
    }
    
    return output;
}

/**
 * Tronque un contenu en gardant le début et la fin
 */
function truncateContent(content: string, lines: number): string {
    if (lines <= 0) return content;
    
    const contentLines = content.split('\n');
    if (contentLines.length <= lines * 2) return content;
    
    const start = contentLines.slice(0, lines);
    const end = contentLines.slice(-lines);
    const omitted = contentLines.length - (lines * 2);
    
    return [
        ...start,
        `... [${omitted} lignes omises] ...`,
        ...end
    ].join('\n');
}

/**
 * Définition de l'outil view_task_details
 */
export const viewTaskDetailsTool = {
    definition: {
        name: 'view_task_details',
        description: 'Affiche les détails techniques complets (métadonnées des actions) pour une tâche spécifique',
        inputSchema: {
            type: 'object',
            properties: {
                task_id: {
                    type: 'string',
                    description: 'L\'ID de la tâche pour laquelle afficher les détails techniques.'
                },
                action_index: {
                    type: 'number',
                    description: 'Index optionnel d\'une action spécifique à examiner (commence à 0).'
                },
                truncate: {
                    type: 'number',
                    description: 'Nombre de lignes à conserver au début et à la fin des contenus longs (0 = complet).',
                    default: 0
                }
            },
            required: ['task_id']
        }
    },
    
    /**
     * Handler pour l'outil view_task_details
     */
    handler: async (
        args: { task_id: string, action_index?: number, truncate?: number },
        conversationCache: Map<string, ConversationSkeleton>
    ): Promise<CallToolResult> => {
        try {
            const skeleton = conversationCache.get(args.task_id);
            
            if (!skeleton) {
                return {
                    content: [{
                        type: 'text',
                        text: `❌ Aucune tâche trouvée avec l'ID: ${args.task_id}`
                    }]
                };
            }

            let output = `🔍 Détails techniques complets - Tâche: ${skeleton.metadata.title || skeleton.taskId}\n`;
            output += `═══════════════════════════════════════════════════════════════════════════════════════════════════════\n`;
            output += `ID: ${skeleton.taskId}\n`;
            output += `Messages: ${skeleton.metadata.messageCount}\n`;
            output += `Taille totale: ${skeleton.metadata.totalSize} octets\n`;
            output += `Dernière activité: ${skeleton.metadata.lastActivity}\n\n`;

            // Filtrer pour ne garder que les actions (pas les messages)
            const actions = (skeleton.sequence ?? []).filter((item: any) => !('role' in item));
            
            if (actions.length === 0) {
                output += "ℹ️ Aucune action technique trouvée dans cette tâche.\n";
            } else {
                output += `🛠️ Actions techniques trouvées: ${actions.length}\n`;
                output += "═══════════════════════════════════════════════════════════════════════════════════════════════════════\n\n";

                // Si un index spécifique est demandé
                if (args.action_index !== undefined) {
                    if (args.action_index >= 0 && args.action_index < actions.length) {
                        const action = actions[args.action_index];
                        output += formatActionDetails(action, args.action_index, args.truncate || 0);
                    } else {
                        output += `❌ Index ${args.action_index} invalide. Indices disponibles: 0-${actions.length - 1}\n`;
                    }
                } else {
                    // Afficher toutes les actions
                    actions.forEach((action: any, index: number) => {
                        output += formatActionDetails(action, index, args.truncate || 0);
                        if (index < actions.length - 1) {
                            output += "\n" + "─".repeat(80) + "\n\n";
                        }
                    });
                }
            }

            return {
                content: [{
                    type: 'text',
                    text: output
                }]
            };

        } catch (error) {
            console.error('Erreur dans viewTaskDetailsTool.handler:', error);
            return {
                content: [{
                    type: 'text',
                    text: `❌ Erreur lors de la récupération des détails: ${error instanceof Error ? error.message : String(error)}`
                }]
            };
        }
    }
};