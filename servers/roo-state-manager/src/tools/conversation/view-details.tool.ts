/**
 * Outil pour afficher les détails techniques complets d'une tâche
 * #1752 Bug #1: Support Claude Code JSONL sessions via lazy loading
 * #1752 Bug #2: Add max_output_length parameter with hard cap
 */

import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ConversationSkeleton } from '../../types/conversation.js';
import { GenericError, GenericErrorCode } from '../../types/errors.js';
import { ContentTruncator } from '../smart-truncation/content-truncator.js';
import * as path from 'path';

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
        description: 'Affiche les détails techniques complets (métadonnées des actions) pour une tâche spécifique. Supporte les conversations Roo et Claude Code (lazy loading si sequence vide mais messageCount > 0).',
        inputSchema: {
            type: 'object',
            properties: {
                task_id: {
                    type: 'string',
                    description: 'L\'ID de la tâche pour laquelle afficher les détails techniques. Pour Claude Code, le format est "claude-{projectDir}".'
                },
                action_index: {
                    type: 'number',
                    description: 'Index optionnel d\'une action spécifique à examiner (commence à 0).'
                },
                truncate: {
                    type: 'number',
                    description: 'Nombre de lignes à conserver au début et à la fin des contenus longs (0 = complet).',
                    default: 0
                },
                max_output_length: {
                    type: 'number',
                    description: '#1752 Bug #2 — Limite maximale de caractères en sortie. Un hard cap final est appliqué pour garantir le respect de cette limite.',
                    default: 100000
                }
            },
            required: ['task_id']
        }
    },
    
    /**
     * Handler pour l'outil view_task_details
     * #1752 Bug #1: Add lazy loading for Claude Code sessions
     * #1752 Bug #2: Add max_output_length hard cap
     */
    handler: async (
        args: { task_id: string, action_index?: number, truncate?: number, max_output_length?: number },
        conversationCache: Map<string, ConversationSkeleton>
    ): Promise<CallToolResult> => {
        try {
            const { task_id, action_index, truncate = 0, max_output_length = 100000 } = args;
            let skeleton = conversationCache.get(task_id);

            // #1752 Bug #1: Load Claude Code sessions when not in cache or has empty sequence
            const isClaudeTaskId = task_id.startsWith('claude-');
            const needsClaudeLoad = !skeleton
                || (isClaudeTaskId && (!skeleton.sequence || skeleton.sequence.length === 0) && skeleton.metadata.messageCount > 0)
                || (skeleton && (!skeleton.sequence || skeleton.sequence.length === 0) && skeleton.metadata.messageCount > 0
                    && ((skeleton.metadata as any)?.source === 'claude-code' || (skeleton.metadata as any)?.dataSource === 'claude'));

            if (needsClaudeLoad && (isClaudeTaskId || (skeleton && ((skeleton.metadata as any)?.source === 'claude-code' || (skeleton.metadata as any)?.dataSource === 'claude')))) {
                try {
                    const { ClaudeStorageDetector } = await import('../../utils/claude-storage-detector.js');
                    const loaded = await ClaudeStorageDetector.findConversationById(task_id);
                    if (loaded && (loaded.sequence ?? []).length > 0) {
                        if (!loaded.metadata) loaded.metadata = {} as any;
                        (loaded.metadata as any).source = 'claude-code';
                        (loaded.metadata as any).dataSource = 'claude';
                        conversationCache.set(task_id, loaded);
                        skeleton = loaded;
                        console.log(`[view_task_details] Loaded Claude Code session ${task_id} (${(loaded.sequence ?? []).length} elements)`);
                    }
                } catch (err) {
                    console.warn(`[view_task_details] Claude Code load failed for ${task_id}:`, err instanceof Error ? err.message : err);
                }
            }

            if (!skeleton) {
                return {
                    content: [{
                        type: 'text',
                        text: `❌ Aucune tâche trouvée avec l'ID: ${task_id}`
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
                if (action_index !== undefined) {
                    if (action_index >= 0 && action_index < actions.length) {
                        const action = actions[action_index];
                        output += formatActionDetails(action, action_index, truncate);
                    } else {
                        output += `❌ Index ${action_index} invalide. Indices disponibles: 0-${actions.length - 1}\n`;
                    }
                } else {
                    // Afficher toutes les actions
                    actions.forEach((action: any, index: number) => {
                        output += formatActionDetails(action, index, truncate);
                        if (index < actions.length - 1) {
                            output += "\n" + "─".repeat(80) + "\n\n";
                        }
                    });
                }
            }

            // #1752 Bug #2: Apply hard cap to respect max_output_length
            const cappedOutput = ContentTruncator.hardCapString(output, max_output_length, { headerKeepChars: 2000 });

            return {
                content: [{
                    type: 'text',
                    text: cappedOutput
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