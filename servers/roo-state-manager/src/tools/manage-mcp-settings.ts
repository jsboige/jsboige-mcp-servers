import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import * as fs from 'fs/promises';
import * as path from 'path';

interface McpServer {
    transportType?: string;
    autoStart?: boolean;
    description?: string;
    disabled?: boolean;
    restart?: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    options?: Record<string, any>;
    autoApprove?: string[];
    alwaysAllow?: string[];
}

interface McpSettings {
    mcpServers: Record<string, McpServer>;
}

const MCP_SETTINGS_PATH = path.join(
    process.env.APPDATA || '',
    'Code',
    'User',
    'globalStorage',
    'rooveterinaryinc.roo-cline',
    'settings',
    'mcp_settings.json'
);

export const manageMcpSettings = {
    name: 'manage_mcp_settings',
    description: 'Gère le fichier mcp_settings.json en lecture et écriture sécurisée',
    inputSchema: {
        type: 'object',
        properties: {
            action: { 
                type: 'string', 
                enum: ['read', 'write', 'backup', 'update_server', 'toggle_server'],
                description: 'Action à effectuer'
            },
            server_name: { 
                type: 'string', 
                description: 'Nom du serveur MCP (pour update_server et toggle_server)'
            },
            server_config: { 
                type: 'object', 
                description: 'Configuration du serveur (pour update_server)'
            },
            settings: { 
                type: 'object', 
                description: 'Paramètres complets (pour write)'
            },
            backup: {
                type: 'boolean',
                description: 'Créer une sauvegarde avant modification',
                default: true
            }
        },
        required: ['action'],
    },
    async execute(args: { 
        action: string;
        server_name?: string;
        server_config?: McpServer;
        settings?: McpSettings;
        backup?: boolean;
    }): Promise<CallToolResult> {
        try {
            switch (args.action) {
                case 'read':
                    return await readMcpSettings();
                    
                case 'write':
                    if (!args.settings) {
                        return { content: [{ type: 'text' as const, text: 'Paramètre settings requis pour write' }] };
                    }
                    return await writeMcpSettings(args.settings, args.backup !== false);
                    
                case 'backup':
                    return await backupMcpSettings();
                    
                case 'update_server':
                    if (!args.server_name || !args.server_config) {
                        return { content: [{ type: 'text' as const, text: 'Paramètres server_name et server_config requis pour update_server' }] };
                    }
                    return await updateServerConfig(args.server_name, args.server_config, args.backup !== false);
                    
                case 'toggle_server':
                    if (!args.server_name) {
                        return { content: [{ type: 'text' as const, text: 'Paramètre server_name requis pour toggle_server' }] };
                    }
                    return await toggleServer(args.server_name, args.backup !== false);
                    
                default:
                    return { content: [{ type: 'text' as const, text: `Action non reconnue: ${args.action}` }] };
            }
        } catch (error) {
            return { 
                content: [{ 
                    type: 'text' as const, 
                    text: `Erreur dans manage_mcp_settings: ${error instanceof Error ? error.message : String(error)}` 
                }] 
            };
        }
    },
};

async function readMcpSettings(): Promise<CallToolResult> {
    try {
        const content = await fs.readFile(MCP_SETTINGS_PATH, 'utf-8');
        const settings = JSON.parse(content) as McpSettings;
        
        return {
            content: [{
                type: 'text' as const,
                text: `Configuration MCP lue depuis ${MCP_SETTINGS_PATH}:\n\n${JSON.stringify(settings, null, 2)}`
            }]
        };
    } catch (error) {
        return {
            content: [{
                type: 'text' as const,
                text: `Erreur de lecture: ${error instanceof Error ? error.message : String(error)}`
            }]
        };
    }
}

async function writeMcpSettings(settings: McpSettings, backup: boolean): Promise<CallToolResult> {
    try {
        // Valider la structure JSON
        if (!settings.mcpServers || typeof settings.mcpServers !== 'object') {
            throw new Error('Structure invalide: mcpServers requis');
        }
        
        if (backup) {
            await backupMcpSettings();
        }
        
        const content = JSON.stringify(settings, null, 2);
        await fs.writeFile(MCP_SETTINGS_PATH, content, 'utf-8');
        
        return {
            content: [{
                type: 'text' as const,
                text: `Configuration MCP écrite avec succès dans ${MCP_SETTINGS_PATH}${backup ? ' (sauvegarde créée)' : ''}`
            }]
        };
    } catch (error) {
        return {
            content: [{
                type: 'text' as const,
                text: `Erreur d'écriture: ${error instanceof Error ? error.message : String(error)}`
            }]
        };
    }
}

async function backupMcpSettings(): Promise<CallToolResult> {
    try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupPath = MCP_SETTINGS_PATH.replace('.json', `_backup_${timestamp}.json`);
        
        const content = await fs.readFile(MCP_SETTINGS_PATH, 'utf-8');
        await fs.writeFile(backupPath, content, 'utf-8');
        
        return {
            content: [{
                type: 'text' as const,
                text: `Sauvegarde créée: ${backupPath}`
            }]
        };
    } catch (error) {
        return {
            content: [{
                type: 'text' as const,
                text: `Erreur de sauvegarde: ${error instanceof Error ? error.message : String(error)}`
            }]
        };
    }
}

async function updateServerConfig(serverName: string, serverConfig: McpServer, backup: boolean): Promise<CallToolResult> {
    try {
        const content = await fs.readFile(MCP_SETTINGS_PATH, 'utf-8');
        const settings = JSON.parse(content) as McpSettings;
        
        if (backup) {
            await backupMcpSettings();
        }
        
        settings.mcpServers[serverName] = serverConfig;
        
        const newContent = JSON.stringify(settings, null, 2);
        await fs.writeFile(MCP_SETTINGS_PATH, newContent, 'utf-8');
        
        return {
            content: [{
                type: 'text' as const,
                text: `Configuration du serveur "${serverName}" mise à jour avec succès${backup ? ' (sauvegarde créée)' : ''}`
            }]
        };
    } catch (error) {
        return {
            content: [{
                type: 'text' as const,
                text: `Erreur de mise à jour du serveur: ${error instanceof Error ? error.message : String(error)}`
            }]
        };
    }
}

async function toggleServer(serverName: string, backup: boolean): Promise<CallToolResult> {
    try {
        const content = await fs.readFile(MCP_SETTINGS_PATH, 'utf-8');
        const settings = JSON.parse(content) as McpSettings;
        
        if (!settings.mcpServers[serverName]) {
            throw new Error(`Serveur "${serverName}" non trouvé`);
        }
        
        if (backup) {
            await backupMcpSettings();
        }
        
        const currentState = settings.mcpServers[serverName].disabled === true;
        settings.mcpServers[serverName].disabled = !currentState;
        
        const newContent = JSON.stringify(settings, null, 2);
        await fs.writeFile(MCP_SETTINGS_PATH, newContent, 'utf-8');
        
        const newState = settings.mcpServers[serverName].disabled ? 'désactivé' : 'activé';
        
        return {
            content: [{
                type: 'text' as const,
                text: `Serveur "${serverName}" ${newState} avec succès${backup ? ' (sauvegarde créée)' : ''}`
            }]
        };
    } catch (error) {
        return {
            content: [{
                type: 'text' as const,
                text: `Erreur de basculement du serveur: ${error instanceof Error ? error.message : String(error)}`
            }]
        };
    }
}