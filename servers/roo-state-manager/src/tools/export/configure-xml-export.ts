/**
 * MCP Tool pour gérer la configuration des exports XML
 */

import { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { StateManagerError } from '../../types/errors.js';
import { ExportConfigManager } from '../../services/ExportConfigManager.js';

/**
 * Arguments du tool configure_xml_export
 */
interface ConfigureXmlExportArgs {
    /** Action à effectuer : get, set, reset */
    action: 'get' | 'set' | 'reset';
    /** Objet de configuration pour l'action set */
    config?: any;
}

/**
 * Définition du tool MCP
 */
export const configureXmlExportTool: Tool = {
    name: 'configure_xml_export',
    description: 'Gère les paramètres de configuration des exports XML.',
    inputSchema: {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: ['get', 'set', 'reset'],
                description: 'L\'opération à effectuer : get, set, reset.'
            },
            config: {
                type: 'object',
                description: 'L\'objet de configuration à appliquer pour l\'action set.'
            }
        },
        required: ['action']
    }
};

/**
 * Implémentation du handler pour le tool configure_xml_export
 */
export async function handleConfigureXmlExport(
    args: ConfigureXmlExportArgs,
    exportConfigManager: ExportConfigManager
): Promise<CallToolResult> {
    try {
        const { action, config } = args;

        switch (action) {
            case 'get':
                const currentConfig = await exportConfigManager.getConfig();
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify(currentConfig, null, 2)
                    }]
                };

            case 'set':
                if (!config) {
                    throw new StateManagerError(
                        'Configuration manquante pour l\'action \'set\'',
                        'VALIDATION_FAILED',
                        'ConfigureXmlExportTool',
                        { action, missingParam: 'config' }
                    );
                }
                await exportConfigManager.updateConfig(config);
                return {
                    content: [{
                        type: 'text',
                        text: 'Configuration mise à jour avec succès.'
                    }]
                };

            case 'reset':
                await exportConfigManager.resetConfig();
                return {
                    content: [{
                        type: 'text',
                        text: 'Configuration remise aux valeurs par défaut.'
                    }]
                };

            default:
                throw new StateManagerError(
                    `Action non reconnue : ${action}`,
                    'INVALID_ACTION',
                    'ConfigureXmlExportTool',
                    { action, validActions: ['get', 'set', 'reset'] }
                );
        }

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
            content: [{
                type: 'text',
                text: `Erreur lors de la configuration : ${errorMessage}`
            }]
        };
    }
}