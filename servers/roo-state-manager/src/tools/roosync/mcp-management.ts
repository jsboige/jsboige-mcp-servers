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

/**
 * Returns the path to mcp_settings.json.
 *
 * IMPORTANT: This is a function (not a constant) so that process.env.APPDATA
 * is read at CALL TIME, not at MODULE LOAD TIME. This is critical for test
 * isolation — vi.hoisted() sets APPDATA before import, but ESM module caching
 * can cause the constant to be evaluated with the wrong APPDATA value.
 *
 * See incident 2026-03-08: test wrote to REAL mcp_settings.json, wiping all
 * Roo MCP configs on ai-01 (753 backup files created).
 */
export function getMcpSettingsPath(): string {
    const resolved = path.join(
        process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
        'Code',
        'User',
        'globalStorage',
        'rooveterinaryinc.roo-cline',
        'settings',
        'mcp_settings.json'
    );
    // SAFETY GUARD: In test environments, reject paths that point to the REAL
    // mcp_settings.json. This prevents tests from wiping production MCP configs.
    // Incidents: 2026-03-08 (ai-01, 753 backups), 2026-04-03 (po-2023).
    if (process.env.NODE_ENV === 'test' || process.env.VITEST) {
        const appdata = process.env.APPDATA || '';
        // Known test APPDATA values:
        // - __test-data__ (integration tests via vi.hoisted)
        // - __roo-state-manager-test-appdata__ (setup-env.ts global guard)
        // - mcp-settings-integration (touch integration tests)
        // - C:\Users\Test\... (unit tests with mocked fs)
        // - /home/test (unit tests with mocked os.homedir)
        // - os.tmpdir() based paths
        const isTestPath = appdata.includes('__test-data__') ||
            appdata.includes('__roo-state-manager-test-appdata__') ||
            appdata.includes('mcp-settings-integration') ||
            resolved.includes('__test-data__') ||
            appdata === 'C:\\Users\\Test\\AppData\\Roaming' ||
            appdata.includes('/home/test') ||
            appdata.includes('/tmp/');
        if (!isTestPath) {
            throw new Error(
                `SAFETY ABORT: getMcpSettingsPath() would resolve to the REAL mcp_settings.json in test mode!\n` +
                `  Resolved: ${resolved}\n` +
                `  APPDATA: ${process.env.APPDATA || '(unset)'}\n` +
                `  This would destroy production Roo MCP configs. Fix the test isolation.`
            );
        }
    }
    return resolved;
}

// ====================================================================
// 🔒 MÉCANISME DE SÉCURISATION - Protection contre l'écriture sans lecture préalable
// ====================================================================

let lastReadTimestamp: number | null = null;
const WRITE_AUTHORIZATION_TIMEOUT = 300000; // 5 minutes (fix #496: operations with file reads need more time)

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
    subAction: z.enum(['read', 'write', 'backup', 'update_server', 'update_server_field', 'toggle_server', 'sync_always_allow']).optional()
        .describe('Sous-action pour manage: read, write, backup, update_server (REMPLACE tout le bloc), update_server_field (FUSIONNE champs), toggle_server, sync_always_allow'),
    server_name: z.string().optional()
        .describe('Nom du serveur MCP (pour update_server, toggle_server, sync_always_allow)'),
    server_config: z.record(z.any()).optional()
        .describe('Configuration du serveur (pour update_server)'),
    settings: z.record(z.any()).optional()
        .describe('Paramètres complets (pour write)'),
    backup: z.boolean().optional()
        .describe('Créer une sauvegarde avant modification (défaut: true pour manage)'),
    tools: z.array(z.string()).optional()
        .describe('Liste des noms d\'outils à auto-approuver (pour sync_always_allow). Si omis, conserve la liste existante et ajoute les outils manquants.'),

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
            const content = await fs.readFile(getMcpSettingsPath(), 'utf-8');
            const mcpSettings = JSON.parse(content) as McpSettings;
            recordSuccessfulRead();

            return {
                success: true,
                action: 'manage',
                subAction: 'read',
                timestamp,
                message: `✅ Configuration MCP lue depuis ${getMcpSettingsPath()}\n\n🔒 **AUTORISATION D'ÉCRITURE ACCORDÉE** (valable 5 minutes)`,
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

            // #552: Clean up empty autoApprove arrays before writing
            cleanupEmptyAutoApprove(settings);
            await fs.writeFile(getMcpSettingsPath(), JSON.stringify(settings, null, 2), 'utf-8');

            return {
                success: true,
                action: 'manage',
                subAction: 'write',
                timestamp,
                message: `✅ Configuration MCP écrite avec succès${backup ? ' (sauvegarde créée)' : ''}\n\n${authCheck.message}`,
                details: { path: getMcpSettingsPath() }
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

            const content = await fs.readFile(getMcpSettingsPath(), 'utf-8');
            const mcpSettings = JSON.parse(content) as McpSettings;

            if (backup) {
                await backupMcpSettings();
            }

            mcpSettings.mcpServers[server_name] = server_config as McpServer;
            await fs.writeFile(getMcpSettingsPath(), JSON.stringify(mcpSettings, null, 2), 'utf-8');

            return {
                success: true,
                action: 'manage',
                subAction: 'update_server',
                timestamp,
                message: `✅ Configuration du serveur "${server_name}" mise à jour${backup ? ' (sauvegarde créée)' : ''}\n\n${authCheck.message}`,
                details: { serverName: server_name }
            };
        }

        case 'update_server_field': {
            if (!server_name) {
                throw new HeartbeatServiceError('server_name requis pour subAction "update_server_field"', 'MISSING_SERVER_NAME');
            }
            if (!server_config || Object.keys(server_config).length === 0) {
                throw new HeartbeatServiceError(
                    'server_config requis pour subAction "update_server_field" (contient uniquement les champs à modifier)',
                    'MISSING_PARAMS'
                );
            }

            const authCheck4 = checkWriteAuthorization();
            if (!authCheck4.isAuthorized) {
                throw new HeartbeatServiceError(
                    `MISE À JOUR CHAMP REFUSÉE: ${authCheck4.message}\n\n📋 État actuel: ${getAuthorizationStatus()}`,
                    'WRITE_NOT_AUTHORIZED'
                );
            }

            const content4 = await fs.readFile(getMcpSettingsPath(), 'utf-8');
            const mcpSettings4 = JSON.parse(content4) as McpSettings;

            if (!mcpSettings4.mcpServers[server_name]) {
                throw new HeartbeatServiceError(
                    `Serveur "${server_name}" non trouvé dans mcp_settings.json`,
                    'SERVER_NOT_FOUND'
                );
            }

            if (backup) {
                await backupMcpSettings();
            }

            // FUSION (merge) au lieu de remplacement: on ne touche que les champs fournis
            const existingConfig = mcpSettings4.mcpServers[server_name];
            const updatedFields = Object.keys(server_config);
            mcpSettings4.mcpServers[server_name] = { ...existingConfig, ...server_config } as McpServer;

            await fs.writeFile(getMcpSettingsPath(), JSON.stringify(mcpSettings4, null, 2), 'utf-8');

            return {
                success: true,
                action: 'manage',
                subAction: 'update_server_field',
                timestamp,
                message: `✅ Champ(s) mis à jour pour "${server_name}": ${updatedFields.join(', ')}${backup ? ' (sauvegarde créée)' : ''}\n\n` +
                    `⚠️ Seuls les champs fournis ont été modifiés, le reste de la configuration est préservé.\n\n${authCheck4.message}`,
                details: {
                    serverName: server_name,
                    updatedFields,
                    preservedFields: Object.keys(existingConfig).filter(k => !updatedFields.includes(k))
                }
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

            const content = await fs.readFile(getMcpSettingsPath(), 'utf-8');
            const mcpSettings = JSON.parse(content) as McpSettings;

            if (!mcpSettings.mcpServers[server_name]) {
                throw new HeartbeatServiceError(`Serveur "${server_name}" non trouvé`, 'SERVER_NOT_FOUND');
            }

            if (backup) {
                await backupMcpSettings();
            }

            const currentState = mcpSettings.mcpServers[server_name].disabled === true;
            mcpSettings.mcpServers[server_name].disabled = !currentState;

            await fs.writeFile(getMcpSettingsPath(), JSON.stringify(mcpSettings, null, 2), 'utf-8');

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

        case 'sync_always_allow': {
            if (!server_name) {
                throw new HeartbeatServiceError('server_name requis pour subAction "sync_always_allow"', 'MISSING_SERVER_NAME');
            }

            const authCheck = checkWriteAuthorization();
            if (!authCheck.isAuthorized) {
                throw new HeartbeatServiceError(
                    `SYNC AUTO-APPROVE REFUSÉ: ${authCheck.message}\n\n📋 État actuel: ${getAuthorizationStatus()}`,
                    'WRITE_NOT_AUTHORIZED'
                );
            }

            const content = await fs.readFile(getMcpSettingsPath(), 'utf-8');
            const mcpSettings = JSON.parse(content) as McpSettings;

            if (!mcpSettings.mcpServers[server_name]) {
                throw new HeartbeatServiceError(`Serveur "${server_name}" non trouvé`, 'SERVER_NOT_FOUND');
            }

            if (backup) {
                await backupMcpSettings();
            }

            const existingAlwaysAllow = mcpSettings.mcpServers[server_name].alwaysAllow || [];
            const { tools: newTools } = args;

            let updatedAlwaysAllow: string[];
            let added: string[];
            let removed: string[];

            if (newTools && newTools.length > 0) {
                // Replace mode: set alwaysAllow to exactly the provided list
                updatedAlwaysAllow = [...new Set(newTools)].sort();
                added = updatedAlwaysAllow.filter(t => !existingAlwaysAllow.includes(t));
                removed = existingAlwaysAllow.filter(t => !updatedAlwaysAllow.includes(t));
            } else {
                // No tools provided: keep existing (no-op, but report current state)
                updatedAlwaysAllow = existingAlwaysAllow;
                added = [];
                removed = [];
            }

            mcpSettings.mcpServers[server_name].alwaysAllow = updatedAlwaysAllow;

            // Fix #552: Clean up empty autoApprove arrays before writing
            for (const server of Object.keys(mcpSettings.mcpServers)) {
                const serverConfig = mcpSettings.mcpServers[server];
                if (serverConfig.autoApprove &&
                    Array.isArray(serverConfig.autoApprove) &&
                    serverConfig.autoApprove.length === 0) {
                    delete serverConfig.autoApprove;
                }
            }

            await fs.writeFile(getMcpSettingsPath(), JSON.stringify(mcpSettings, null, 2), 'utf-8');

            return {
                success: true,
                action: 'manage',
                subAction: 'sync_always_allow',
                timestamp,
                message: `✅ alwaysAllow mis à jour pour "${server_name}": ${updatedAlwaysAllow.length} outils${backup ? ' (sauvegarde créée)' : ''}\n\n` +
                    (added.length > 0 ? `Ajoutés (${added.length}): ${added.join(', ')}\n` : '') +
                    (removed.length > 0 ? `Retirés (${removed.length}): ${removed.join(', ')}\n` : '') +
                    (added.length === 0 && removed.length === 0 ? 'Aucun changement.\n' : '') +
                    `\n${authCheck.message}`,
                details: {
                    serverName: server_name,
                    totalTools: updatedAlwaysAllow.length,
                    added,
                    removed,
                    alwaysAllow: updatedAlwaysAllow
                }
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
    const settingsContent = await fs.readFile(getMcpSettingsPath(), 'utf-8');
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
        touchedFile = getMcpSettingsPath();
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
    await fs.access(getMcpSettingsPath());

    // Toucher le fichier
    const now = new Date();
    await fs.utimes(getMcpSettingsPath(), now, now);

    return {
        success: true,
        action: 'touch',
        timestamp,
        message: `✅ Fichier mcp_settings.json touché avec succès - Tous les MCPs vont redémarrer`,
        details: {
            path: getMcpSettingsPath(),
            touchedAt: now.toISOString()
        }
    };
}

// ====================================================================
// FONCTIONS UTILITAIRES
// ====================================================================

async function backupMcpSettings(): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = getMcpSettingsPath().replace('.json', `_backup_${timestamp}.json`);

    const content = await fs.readFile(getMcpSettingsPath(), 'utf-8');
    await fs.writeFile(backupPath, content, 'utf-8');

    return backupPath;
}

async function runNpmBuild(mcpPath: string): Promise<string> {
    return new Promise((resolve, reject) => {
        exec('npm run build', { cwd: mcpPath, windowsHide: true }, (error, stdout, stderr) => {
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
        exec(`powershell.exe -Command "${command}"`, { windowsHide: true }, (error) => {
            if (error) {
                reject(new HeartbeatServiceError(`Touch échoué pour ${filePath}: ${error.message}`, 'TOUCH_FAILED'));
            } else {
                resolve();
            }
        });
    });
}

/**
 * #552: Nettoie les tableaux autoApprove vides d'une configuration MCP
 * Les tableaux vides 'autoApprove: []' causent des erreurs de validation JSON dans VS Code
 * @param settings Configuration MCP (peut être McpSettings ou Record<string, any>)
 */
function cleanupEmptyAutoApprove(settings: McpSettings | Record<string, any>): void {
    if (!settings.mcpServers || typeof settings.mcpServers !== 'object') {
        return; // Pas de mcpServers, rien à nettoyer
    }
    for (const serverName of Object.keys(settings.mcpServers)) {
        const serverConfig = settings.mcpServers[serverName];
        if (serverConfig?.autoApprove &&
            Array.isArray(serverConfig.autoApprove) &&
            serverConfig.autoApprove.length === 0) {
            delete serverConfig.autoApprove;
        }
    }
}

/**
 * Écrit la configuration MCP avec nettoyage automatique des autoApprove vides
 */
async function writeMcpSettingsWithCleanup(settings: McpSettings): Promise<void> {
    cleanupEmptyAutoApprove(settings);
    await fs.writeFile(getMcpSettingsPath(), JSON.stringify(settings, null, 2), 'utf-8');
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
    description: 'Gestion complète des serveurs MCP. Actions : manage (read/write/backup/update/toggle/update_server_field/sync_always_allow configuration), rebuild (build npm + restart MCP avec watchPaths), touch (force reload de tous les serveurs MCP).',
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
                enum: ['read', 'write', 'backup', 'update_server', 'update_server_field', 'toggle_server', 'sync_always_allow'],
                description: 'Sous-action pour manage: read, write, backup, update_server (REMPLACE tout le bloc), update_server_field (FUSIONNE champs sans écraser), toggle_server, sync_always_allow'
            },
            server_name: {
                type: 'string',
                description: 'Nom du serveur MCP (pour update_server, update_server_field, toggle_server, sync_always_allow)'
            },
            server_config: {
                type: 'object',
                description: 'Configuration du serveur (pour update_server: REMPLACE tout) ou champs à modifier (pour update_server_field: FUSIONNE)'
            },
            settings: {
                type: 'object',
                description: 'Paramètres complets (pour write)'
            },
            backup: {
                type: 'boolean',
                description: 'Créer une sauvegarde avant modification (défaut: true pour manage)'
            },
            tools: {
                type: 'array',
                items: { type: 'string' },
                description: 'Liste des noms d\'outils à auto-approuver (pour sync_always_allow)'
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
