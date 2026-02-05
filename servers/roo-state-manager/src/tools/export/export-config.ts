/**
 * Outil MCP consolidé : export_config
 *
 * CONS-10: Alias/wrapper pour configure_xml_export avec nom cohérent.
 * Gère les paramètres de configuration des exports.
 *
 * @module tools/export/export-config
 * @version 1.0.0
 * @since CONS-10
 */

import { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { StateManagerError } from '../../types/errors.js';
import { ExportConfigManager } from '../../services/ExportConfigManager.js';

/**
 * Actions supportées
 */
export type ExportConfigAction = 'get' | 'set' | 'reset';

/**
 * Arguments du tool export_config
 */
export interface ExportConfigArgs {
    /** Action à effectuer : get, set, reset */
    action: ExportConfigAction;
    /** Objet de configuration pour l'action set */
    config?: Record<string, unknown>;
}

/**
 * Définition du tool MCP consolidé
 */
export const exportConfigTool: Tool = {
    name: 'export_config',
    description: `Gère les paramètres de configuration des exports.

Actions supportées:
- get: Récupère la configuration actuelle
- set: Met à jour la configuration (nécessite le paramètre config)
- reset: Remet la configuration aux valeurs par défaut

CONS-10: Remplace configure_xml_export`,
    inputSchema: {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: ['get', 'set', 'reset'],
                description: 'L\'opération à effectuer: get, set, ou reset'
            },
            config: {
                type: 'object',
                description: 'L\'objet de configuration à appliquer pour l\'action set'
            }
        },
        required: ['action']
    }
};

/**
 * Handler pour export_config
 */
export async function handleExportConfig(
    args: ExportConfigArgs,
    exportConfigManager: ExportConfigManager
): Promise<CallToolResult> {
    try {
        // Valider l'action
        if (!args.action) {
            return {
                isError: true,
                content: [{
                    type: 'text',
                    text: 'Paramètre "action" requis. Valeurs: get, set, reset'
                }]
            };
        }

        const validActions: ExportConfigAction[] = ['get', 'set', 'reset'];
        if (!validActions.includes(args.action)) {
            return {
                isError: true,
                content: [{
                    type: 'text',
                    text: `Action "${args.action}" invalide. Valeurs: ${validActions.join(', ')}`
                }]
            };
        }

        switch (args.action) {
            case 'get': {
                const currentConfig = await exportConfigManager.getConfig();
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify(currentConfig, null, 2)
                    }]
                };
            }

            case 'set': {
                if (!args.config) {
                    throw new StateManagerError(
                        'Configuration manquante pour l\'action "set"',
                        'VALIDATION_FAILED',
                        'ExportConfigTool',
                        { action: args.action, missingParam: 'config' }
                    );
                }
                await exportConfigManager.updateConfig(args.config);
                return {
                    content: [{
                        type: 'text',
                        text: 'Configuration mise à jour avec succès.'
                    }]
                };
            }

            case 'reset': {
                await exportConfigManager.resetConfig();
                return {
                    content: [{
                        type: 'text',
                        text: 'Configuration remise aux valeurs par défaut.'
                    }]
                };
            }

            default:
                // TypeScript devrait empêcher ce cas, mais par sécurité
                return {
                    isError: true,
                    content: [{
                        type: 'text',
                        text: `Action non reconnue: ${args.action}`
                    }]
                };
        }

    } catch (error) {
        if (error instanceof StateManagerError) {
            return {
                isError: true,
                content: [{
                    type: 'text',
                    text: `Erreur: ${error.message} (${error.code})`
                }]
            };
        }

        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
            isError: true,
            content: [{
                type: 'text',
                text: `Erreur lors de la configuration: ${errorMessage}`
            }]
        };
    }
}
