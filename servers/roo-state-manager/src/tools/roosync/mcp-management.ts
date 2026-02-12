/**
 * Outil MCP : roosync_mcp_management
 *
 * Gestion complète des serveurs MCP (configuration, rebuild, reload).
 *
 * @module tools/roosync/mcp-management
 * @version 1.0.0
 */

import { z } from 'zod';
import { exec } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { HeartbeatServiceError } from '../../services/roosync/HeartbeatService.js';

// Types pour les serveurs MCP
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
    cwd?: string;
    watchPaths?: string[];
}

interface McpSettings {
    mcpServers: Record<string, McpServer>;
}

const MCP_SETTINGS_PATH = path.join(
    process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'Code',
    'User',
    'globalStorage',
    'rooveterinaryinc.roo-cline',
    'settings',
    'mcp_settings.json'
);

// ====================================================================
// 🔒 MÉCANISME DE SÉCURISATION - Protection contre l'écriture sans lecture préalable
// ====================================================================

let lastReadTimestamp: number | null = null;
const WRITE_AUTHORIZATION_TIMEOUT = 60000; // 1 minute

function checkWriteAuthorization(): { isAuthorized: boolean; message: string } {
    if (lastReadTimestamp === null) {
        return {
            isAuthorized: false,
            message: '🚨 SÉCURITÉ: Lecture préalable requise avant toute écriture. Utilisez d\'abord l\'action "manage" avec subAction "read".'
        };
    }

    const now = Date.now();
    const timeSinceRead = now - lastReadTimestamp;
    const remainingTime = WRITE_AUTHORIZATION_TIMEOUT - timeSinceRead;

    if (timeSinceRead > WRITE_AUTHORIZATION_TIMEOUT) {
        const minutesExpired = Math.ceil(timeSinceRead / 60000);
        return {
            isAuthorized: false,
            message: `🚨 SÉCURITÉ: Autorisation d'écriture expirée (lecture effectuée il y a ${minutesExpired} minute${minutesExpired > 1 ? 's' : ''}). Relancez d\'abord une action "manage" avec subAction "read".`
        };
    }

    const remainingMinutes = Math.ceil(remainingTime / 60000);
    return {
        isAuthorized: true,
        message: `✅ Écriture autorisée (autorisation valable encore ${remainingMinutes} minute${remainingMinutes > 1 ? 's' : ''})`
    };
}

function recordSuccessfulRead(): void {
    lastReadTimestamp = Date.now();
}

function getAuthorizationStatus(): string {
    if (lastReadTimestamp === null) {
        return '🔒 Aucune lecture effectuée - Écriture non autorisée';
    }

    const now = Date.now();
    const timeSinceRead = now - lastReadTimestamp;
    const remainingTime = WRITE_AUTHORIZATION_TIMEOUT - timeSinceRead;

    if (timeSinceRead > WRITE_AUTHORIZATION_TIMEOUT) {
        const minutesExpired = Math.ceil(timeSinceRead / 60000);
        return `⏰ Autorisation expirée depuis ${minutesExpired} minute${minutesExpired > 1 ? 's' : ''}`;
    }

    const remainingMinutes = Math.ceil(remainingTime / 60000);
    return `🟢 Autorisation active (expire dans ${remainingMinutes} minute${remainingMinutes > 1 ? 's' : ''})`;
}

// ====================================================================
// SCHEMAS DE VALIDATION
// ====================================================================

export const McpManagementArgsSchema = z.object({
    action: z.enum(['manage', 'rebuild', 'touch'])
        .describe('Type d\'opération MCP: manage (configuration), rebuild (build+restart), touch (force reload)'),

    // Paramètres pour action: 'manage'
    subAction: z.enum(['read', 'write', 'backup', 'update_server', 'toggle_server']).optional()
        .describe('Sous-action pour manage: read, write, backup, update_server, toggle_server'),
    server_name: z.string().optional()
        .describe('Nom du serveur MCP (pour update_server et toggle_server)'),
    server_config: z.record(z.any()).optional()
        .describe('Configuration du serveur (pour update_server)'),
    settings: z.record(z.any()).optional()
        .describe('Paramètres complets (pour write)'),
    backup: z.boolean().optional()
        .describe('Créer une sauvegarde avant modification (défaut: true pour manage)'),

    // Paramètre pour action: 'rebuild'
    mcp_name: z.string().optional()
        .describe('Nom du MCP à rebuild (requis pour action rebuild)')
});

export type McpManagementArgs = z.infer<typeof McpManagementArgsSchema>;

export const McpManagementResultSchema = z.object({
    success: z.boolean()
        .describe('Indique si l\'opération a réussi'),
    action: z.enum(['manage', 'rebuild', 'touch'])
        .describe('Type d\'opération effectuée'),
    subAction: z.string().optional()
        .describe('Sous-action effectuée (pour manage)'),
    timestamp: z.string()
        .describe('Timestamp de l\'opération (ISO 8601)'),
    message: z.string()
        .describe('Message de confirmation ou détails'),
    details: z.record(z.any()).optional()
        .describe('Détails supplémentaires selon l\'action')
});

export type McpManagementResult = z.infer<typeof McpManagementResultSchema>;

// ====================================================================
// IMPLÉMENTATION DES ACTIONS
// ====================================================================

async function handleManageAction(args: McpManagementArgs): Promise<McpManagementResult> {
    const { subAction, server_name, server_config, settings, backup = true } = args;

    if (!subAction) {
        throw new HeartbeatServiceError(
            'subAction requis pour action "manage"',
            'MISSING_SUBACTION'
        );
    }

    const timestamp = new Date().toISOString();

    switch (subAction) {
        case 'read': {
            const content = await fs.readFile(MCP_SETTINGS_PATH, 'utf-8');
            const mcpSettings = JSON.parse(content) as McpSettings;
            recordSuccessfulRead();

            return {
                success: true,
                action: 'manage',
                subAction: 'read',
                timestamp,
                message: `✅ Configuration MCP lue depuis ${MCP_SETTINGS_PATH}\n\n🔒 **AUTORISATION D'ÉCRITURE ACCORDÉE** (valable 1 minute)`,
                details: mcpSettings
            };
        }

        case 'write': {
            if (!settings) {
                throw new HeartbeatServiceError('settings requis pour subAction "write"', 'MISSING_SETTINGS');
            }

            const authCheck = checkWriteAuthorization();
            if (!authCheck.isAuthorized) {
                throw new HeartbeatServiceError(
                    `ÉCRITURE REFUSÉE: ${authCheck.message}\n\n📋 État actuel: ${getAuthorizationStatus()}`,
                    'WRITE_NOT_AUTHORIZED'
                );
            }

            if (!settings.mcpServers || typeof settings.mcpServers !== 'object') {
                throw new HeartbeatServiceError('Structure invalide: mcpServers requis', 'INVALID_SETTINGS');
            }

            if (backup) {
                await backupMcpSettings();
            }

            await fs.writeFile(MCP_SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf-8');

            return {
                success: true,
                action: 'manage',
                subAction: 'write',
                timestamp,
                message: `✅ Configuration MCP écrite avec succès${backup ? ' (sauvegarde créée)' : ''}\n\n${authCheck.message}`,
                details: { path: MCP_SETTINGS_PATH }
            };
        }

        case 'backup': {
            const backupPath = await backupMcpSettings();

            return {
                success: true,
                action: 'manage',
                subAction: 'backup',
                timestamp,
                message: `✅ Sauvegarde créée`,
                details: { backupPath }
            };
        }

        case 'update_server': {
            if (!server_name || !server_config) {
                throw new HeartbeatServiceError(
                    'server_name et server_config requis pour subAction "update_server"',
                    'MISSING_PARAMS'
                );
            }

            const authCheck = checkWriteAuthorization();
            if (!authCheck.isAuthorized) {
                throw new HeartbeatServiceError(
                    `MISE À JOUR SERVEUR REFUSÉE: ${authCheck.message}\n\n📋 État actuel: ${getAuthorizationStatus()}`,
                    'WRITE_NOT_AUTHORIZED'
                );
            }

            const content = await fs.readFile(MCP_SETTINGS_PATH, 'utf-8');
            const mcpSettings = JSON.parse(content) as McpSettings;

            if (backup) {
                await backupMcpSettings();
            }

            mcpSettings.mcpServers[server_name] = server_config as McpServer;
            await fs.writeFile(MCP_SETTINGS_PATH, JSON.stringify(mcpSettings, null, 2), 'utf-8');

            return {
                success: true,
                action: 'manage',
                subAction: 'update_server',
                timestamp,
                message: `✅ Configuration du serveur "${server_name}" mise à jour${backup ? ' (sauvegarde créée)' : ''}\n\n${authCheck.message}`,
                details: { serverName: server_name }
            };
        }

        case 'toggle_server': {
            if (!server_name) {
                throw new HeartbeatServiceError('server_name requis pour subAction "toggle_server"', 'MISSING_SERVER_NAME');
            }

            const authCheck = checkWriteAuthorization();
            if (!authCheck.isAuthorized) {
                throw new HeartbeatServiceError(
                    `BASCULEMENT SERVEUR REFUSÉ: ${authCheck.message}\n\n📋 État actuel: ${getAuthorizationStatus()}`,
                    'WRITE_NOT_AUTHORIZED'
                );
            }

            const content = await fs.readFile(MCP_SETTINGS_PATH, 'utf-8');
            const mcpSettings = JSON.parse(content) as McpSettings;

            if (!mcpSettings.mcpServers[server_name]) {
                throw new HeartbeatServiceError(`Serveur "${server_name}" non trouvé`, 'SERVER_NOT_FOUND');
            }

            if (backup) {
                await backupMcpSettings();
            }

            const currentState = mcpSettings.mcpServers[server_name].disabled === true;
            mcpSettings.mcpServers[server_name].disabled = !currentState;

            await fs.writeFile(MCP_SETTINGS_PATH, JSON.stringify(mcpSettings, null, 2), 'utf-8');

            const newState = mcpSettings.mcpServers[server_name].disabled ? 'désactivé' : 'activé';

            return {
                success: true,
                action: 'manage',
                subAction: 'toggle_server',
                timestamp,
                message: `✅ Serveur "${server_name}" ${newState}${backup ? ' (sauvegarde créée)' : ''}\n\n${authCheck.message}`,
                details: { serverName: server_name, newState }
            };
        }

        default:
            throw new HeartbeatServiceError(`subAction non reconnue: ${subAction}`, 'UNKNOWN_SUBACTION');
    }
}

async function handleRebuildAction(args: McpManagementArgs): Promise<McpManagementResult> {
    const { mcp_name } = args;

    if (!mcp_name) {
        throw new HeartbeatServiceError('mcp_name requis pour action "rebuild"', 'MISSING_MCP_NAME');
    }

    const timestamp = new Date().toISOString();

    // Lire la configuration MCP
    const settingsContent = await fs.readFile(MCP_SETTINGS_PATH, 'utf-8');
    const settings = JSON.parse(settingsContent) as McpSettings;

    const mcpConfig = settings.mcpServers?.[mcp_name];
    if (!mcpConfig) {
        throw new HeartbeatServiceError(`MCP "${mcp_name}" non trouvé dans settings`, 'MCP_NOT_FOUND');
    }

    // Déterminer le chemin du MCP
    let mcpPath: string;
    if (mcpConfig.cwd) {
        mcpPath = mcpConfig.cwd;
    } else if (mcpConfig.options?.cwd) {
        mcpPath = mcpConfig.options.cwd;
    } else if (mcpConfig.args?.[0] && (mcpConfig.args[0].includes('/') || mcpConfig.args[0].includes('\\'))) {
        mcpPath = path.dirname(path.dirname(mcpConfig.args[0]));
    } else {
        throw new HeartbeatServiceError(
            `Impossible de déterminer le répertoire de travail pour MCP "${mcp_name}". Ajoutez une propriété "cwd" à sa configuration.`,
            'MISSING_CWD'
        );
    }

    // Construire le build
    const buildResult = await runNpmBuild(mcpPath);

    // Déterminer la stratégie de restart
    let restartStrategy: 'targeted' | 'global';
    let touchedFile: string;
    let warningMessage = '';

    if (mcpConfig.watchPaths && mcpConfig.watchPaths.length > 0) {
        // Restart ciblé via watchPaths
        restartStrategy = 'targeted';
        touchedFile = mcpConfig.watchPaths[0];
        await touchFile(touchedFile);
    } else {
        // Restart global via settings file
        restartStrategy = 'global';
        touchedFile = MCP_SETTINGS_PATH;
        await touchFile(touchedFile);
        warningMessage = `\n\n⚠️ WARNING: MCP "${mcp_name}" n'a pas de 'watchPaths' configuré. Le restart est global, ce qui est moins fiable. Pour de meilleurs résultats, ajoutez une propriété 'watchPaths' pointant vers le fichier de build.`;
    }

    return {
        success: true,
        action: 'rebuild',
        timestamp,
        message: `✅ Build pour "${mcp_name}" réussi\n\nRestart déclenché: ${restartStrategy === 'targeted' ? 'ciblé via watchPaths' : 'global comme fallback'}${warningMessage}`,
        details: {
            mcpName: mcp_name,
            mcpPath,
            buildOutput: buildResult,
            restartStrategy,
            touchedFile
        }
    };
}

async function handleTouchAction(): Promise<McpManagementResult> {
    const timestamp = new Date().toISOString();

    // Vérifier que le fichier existe
    await fs.access(MCP_SETTINGS_PATH);

    // Toucher le fichier
    const now = new Date();
    await fs.utimes(MCP_SETTINGS_PATH, now, now);

    return {
        success: true,
        action: 'touch',
        timestamp,
        message: `✅ Fichier mcp_settings.json touché avec succès - Tous les MCPs vont redémarrer`,
        details: {
            path: MCP_SETTINGS_PATH,
            touchedAt: now.toISOString()
        }
    };
}

// ====================================================================
// FONCTIONS UTILITAIRES
// ====================================================================

async function backupMcpSettings(): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = MCP_SETTINGS_PATH.replace('.json', `_backup_${timestamp}.json`);

    const content = await fs.readFile(MCP_SETTINGS_PATH, 'utf-8');
    await fs.writeFile(backupPath, content, 'utf-8');

    return backupPath;
}

async function runNpmBuild(mcpPath: string): Promise<string> {
    return new Promise((resolve, reject) => {
        exec('npm run build', { cwd: mcpPath }, (error, stdout, stderr) => {
            if (error) {
                reject(new HeartbeatServiceError(`Build échoué: ${error.message}`, 'BUILD_FAILED'));
            } else {
                resolve(stdout);
            }
        });
    });
}

async function touchFile(filePath: string): Promise<void> {
    const command = `(Get-Item -LiteralPath "${filePath}").LastWriteTime = Get-Date`;
    return new Promise((resolve, reject) => {
        exec(`powershell.exe -Command "${command}"`, (error) => {
            if (error) {
                reject(new HeartbeatServiceError(`Touch échoué pour ${filePath}: ${error.message}`, 'TOUCH_FAILED'));
            } else {
                resolve();
            }
        });
    });
}

// ====================================================================
// OUTIL PRINCIPAL
// ====================================================================

export async function roosyncMcpManagement(args: McpManagementArgs): Promise<McpManagementResult> {
    try {
        const { action } = args;

        switch (action) {
            case 'manage':
                return await handleManageAction(args);

            case 'rebuild':
                return await handleRebuildAction(args);

            case 'touch':
                return await handleTouchAction();

            default:
                throw new HeartbeatServiceError(`Action non reconnue: ${action}`, 'UNKNOWN_ACTION');
        }
    } catch (error) {
        if (error instanceof HeartbeatServiceError) {
            throw error;
        }

        throw new HeartbeatServiceError(
            `Erreur lors de l'opération MCP ${args.action}: ${(error as Error).message}`,
            `MCP_${args.action.toUpperCase()}_FAILED`
        );
    }
}

/**
 * Métadonnées de l'outil pour l'enregistrement MCP
 */
export const mcpManagementToolMetadata = {
    name: 'roosync_mcp_management',
    description: 'Gestion complète des serveurs MCP. Actions : manage (read/write/backup/update/toggle configuration), rebuild (build npm + restart MCP avec watchPaths), touch (force reload de tous les serveurs MCP).',
    inputSchema: {
        type: 'object' as const,
        properties: {
            action: {
                type: 'string',
                enum: ['manage', 'rebuild', 'touch'],
                description: 'Type d\'opération MCP: manage (configuration), rebuild (build+restart), touch (force reload)'
            },
            subAction: {
                type: 'string',
                enum: ['read', 'write', 'backup', 'update_server', 'toggle_server'],
                description: 'Sous-action pour manage: read, write, backup, update_server, toggle_server'
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
                description: 'Créer une sauvegarde avant modification (défaut: true pour manage)'
            },
            mcp_name: {
                type: 'string',
                description: 'Nom du MCP à rebuild (requis pour action rebuild)'
            }
        },
        required: ['action'],
        additionalProperties: false
    }
};
