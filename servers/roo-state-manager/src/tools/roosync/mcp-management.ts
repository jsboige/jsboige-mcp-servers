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
import { randomBytes } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { HeartbeatServiceError } from '../../services/roosync/HeartbeatService.js';
// #3987: manage.read masks mcpServers[*].env with the #3044 digest format —
// canonical definition in compare-config, imported (never copied).
import { maskSecretValue } from './compare-config.js';
// #2766 S2: getActiveMcpSettingsPath probes the filesystem for the installed
// extension (Roo vs Zoo-Code), so the tool finds the config on Zoo-only hosts
// instead of ENOENTing on the hardcoded roo-cline default.
import { getActiveMcpSettingsPath } from '../../utils/extension-paths.js';
// #3989 review (PR #1300 point 1): the read→write seal keys on the CALLER SEAT,
// resolved through the #3591 single choke point — not on os.hostname(), which is
// constant for the host process and could never tell two seats sharing it apart.
import { resolveCallerIdentity } from '../../utils/message-helpers.js';

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
 * #2766 S2: resolves via filesystem probe (getActiveMcpSettingsPath) so the
 * tool works on Zoo-only hosts where only `zoocodeorganization.zoo-code` is
 * installed and no `ROO_EXTENSION_ID` override is set. Previously delegated to
 * the env-only getExtensionMcpSettingsPath() which defaulted to roo-cline →
 * ENOENT on Zoo/clean machines.
 *
 * IMPORTANT: This is a function (not a constant) so that process.env.APPDATA
 * is read at CALL TIME, not at MODULE LOAD TIME. This is critical for test
 * isolation — vi.hoisted() sets APPDATA before import, but ESM module caching
 * can cause the constant to be evaluated with the wrong APPDATA value.
 *
 * See incident 2026-03-08: test wrote to REAL mcp_settings.json, wiping all
 * Roo MCP configs on ai-01 (753 backup files created).
 */
export function getMcpSettingsPath(targetExtension?: 'roo' | 'zoo'): string {
    const resolved = getActiveMcpSettingsPath(targetExtension);
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
        const appdataLower = appdata.toLowerCase();
        const isTestPath = appdata.includes('__test-data__') ||
            appdata.includes('__roo-state-manager-test-appdata__') ||
            appdata.includes('mcp-settings-integration') ||
            resolved.includes('__test-data__') ||
            appdataLower === 'c:\\users\\test\\appdata\\roaming' ||
            appdataLower.includes('/home/test') ||
            appdataLower.includes('/tmp/') ||
            appdataLower.includes('\\temp\\') ||
            appdata === '';
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

interface ReadAuthorization {
    seat: string;
    timestamp: number;
}

function getAuthorizationSeatId(as?: string): string {
    // #3989 review (PR #1300 point 1): the seal key is the caller SEAT.
    // os.hostname() is constant for the whole host process — two seats sharing
    // it always carried the same machineId, so the mismatch branch was
    // unreachable in production (the pre-review tests reached it only by
    // flipping a hostname mock). resolveCallerIdentity (#3591) is the single
    // choke point: an asserted `as` is canonicalized and trust-gated against
    // ROOSYNC_TRUSTED_CALLER_IDS (an untrusted assertion throws, so a rejected
    // seat can never fall back to the local identity); without `as` the
    // identity is exactly the local resolution — zero behavior change for
    // seats that don't assert.
    return resolveCallerIdentity(as).fullId.toLowerCase();
}

let lastReadAuthorization: ReadAuthorization | null = null;
const WRITE_AUTHORIZATION_TIMEOUT = 300000; // 5 minutes (fix #496: operations with file reads need more time)

function checkWriteAuthorization(as?: string): { isAuthorized: boolean; message: string } {
    if (lastReadAuthorization === null) {
        return {
            isAuthorized: false,
            message: '🚨 SÉCURITÉ: Lecture préalable requise avant toute écriture. Utilisez d\'abord l\'action "manage" avec subAction "read".'
        };
    }

    const now = Date.now();
    const timeSinceRead = now - lastReadAuthorization.timestamp;
    const remainingTime = WRITE_AUTHORIZATION_TIMEOUT - timeSinceRead;

    if (timeSinceRead > WRITE_AUTHORIZATION_TIMEOUT) {
        const minutesExpired = Math.ceil(timeSinceRead / 60000);
        return {
            isAuthorized: false,
            message: `🚨 SÉCURITÉ: Autorisation d'écriture expirée (lecture effectuée il y a ${minutesExpired} minute${minutesExpired > 1 ? 's' : ''}). Relancez d\'abord une action "manage" avec subAction "read".`
        };
    }

    // #3989: scellement par siège — l'autorisation est liée au lecteur
    // d'origine, y compris quand deux sièges partagent le même process hôte :
    // chacun asserte son identité réelle via `as` (#3591), et l'autorisation
    // ouverte par l'un ne couvre plus l'écriture de l'autre. Le refus est
    // explicite : le tiers refait son propre read avec SON `as` (la garde
    // l'oblige à lire d'abord lui-même, elle ne l'empêche pas d'écrire après).
    const writerSeat = getAuthorizationSeatId(as);
    if (lastReadAuthorization.seat !== writerSeat) {
        return {
            isAuthorized: false,
            message: `🚨 SÉCURITÉ (#3989): l'autorisation d'écriture a été ouverte par un autre siège (${lastReadAuthorization.seat || 'inconnu'}), pas par ${writerSeat || 'inconnu'}. Relancez d\'abord une action "manage" avec subAction "read" depuis CE siège (même \`as\` pour le read et le write).`
        };
    }

    const remainingMinutes = Math.ceil(remainingTime / 60000);
    return {
        isAuthorized: true,
        message: `✅ Écriture autorisée (siège ${writerSeat}, autorisation valable encore ${remainingMinutes} minute${remainingMinutes > 1 ? 's' : ''})`
    };
}

function recordSuccessfulRead(as?: string): void {
    lastReadAuthorization = {
        seat: getAuthorizationSeatId(as),
        timestamp: Date.now()
    };
}

function getAuthorizationStatus(): string {
    if (lastReadAuthorization === null) {
        return '🔒 Aucune lecture effectuée - Écriture non autorisée';
    }

    const now = Date.now();
    const timeSinceRead = now - lastReadAuthorization.timestamp;
    const remainingTime = WRITE_AUTHORIZATION_TIMEOUT - timeSinceRead;

    if (timeSinceRead > WRITE_AUTHORIZATION_TIMEOUT) {
        const minutesExpired = Math.ceil(timeSinceRead / 60000);
        return `⏰ Autorisation expirée depuis ${minutesExpired} minute${minutesExpired > 1 ? 's' : ''}`;
    }

    const remainingMinutes = Math.ceil(remainingTime / 60000);
    return `🟢 Autorisation active pour le siège ${lastReadAuthorization.seat || 'inconnu'} (expire dans ${remainingMinutes} minute${remainingMinutes > 1 ? 's' : ''})`;
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
        .describe('Nom du MCP à rebuild (requis pour action rebuild)'),

    // #3006: Target extension for path resolution. When provided, overrides the
    // filesystem probe in getActiveMcpSettingsPath. Fixes dual-install machines
    // where the probe picks Roo but the caller needs the Zoo config.
    targetExtension: z.enum(['roo', 'zoo']).optional()
        .describe('Target extension for path resolution (read AND write). "roo" = RooVeterinaryInc.roo-cline, "zoo" = ZooCodeOrganization.zoo-code. When omitted, auto-detects via filesystem probe (#2766 S2).'),

    // #3989 (PR #1300 review point 1): asserted caller seat for the read→write
    // seal. Gateway seats sharing one RSM host process MUST pass the same `as`
    // for the opening read and the write — the seal compares seats, not hosts.
    as: z.string().optional()
        .describe('#3591 caller identity assertion (gateway seats), format "machine" or "machine:workspace". Trust-gated against ROOSYNC_TRUSTED_CALLER_IDS. #3989: the read→write authorization is sealed per seat — pass the SAME `as` on the opening "read" and on the write, or the write is refused.')
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

/**
 * #3987: copy of settings where every mcpServers[*].env value is replaced by
 * its #3044 digest (`<set:len=N:sha256=hash8>`). The manage.read response
 * crosses agent/transcript boundaries and must never carry cleartext
 * credentials; digests keep the same/different arbitration signal.
 *
 * Blanket-mask env rather than pattern-match keys: env is credential-by-default
 * in MCP configs, a pattern gap would leak, and len+hash preserve drift checks.
 */
function maskEnvSecrets(settings: McpSettings): McpSettings {
    if (!settings || !settings.mcpServers || typeof settings.mcpServers !== 'object') {
        return settings;
    }
    const out: McpSettings = { mcpServers: {} };
    for (const [name, server] of Object.entries(settings.mcpServers)) {
        if (server && typeof server === 'object' && server.env && typeof server.env === 'object') {
            const env: Record<string, string> = {};
            for (const [k, v] of Object.entries(server.env)) {
                env[k] = maskSecretValue(v);
            }
            out.mcpServers[name] = { ...server, env };
        } else {
            out.mcpServers[name] = server;
        }
    }
    return out;
}

async function handleManageAction(args: McpManagementArgs): Promise<McpManagementResult> {
    const { subAction, server_name, server_config, settings, backup = true, targetExtension, as: callerSeat } = args;

    if (!subAction) {
        throw new HeartbeatServiceError(
            'subAction requis pour action "manage"',
            'MISSING_SUBACTION'
        );
    }

    const timestamp = new Date().toISOString();

    switch (subAction) {
        case 'read': {
            const settingsPath = getMcpSettingsPath(targetExtension);
            const content = await fs.readFile(settingsPath, 'utf-8');
            const mcpSettings = JSON.parse(content) as McpSettings;
            recordSuccessfulRead(callerSeat);

            // #3987: env blocks carry API keys/tokens — echo them as digests, never
            // cleartext. The read→write authorization does NOT need real values back:
            // writes replace or merge whole fields, they never re-submit the env read.
            return {
                success: true,
                action: 'manage',
                subAction: 'read',
                timestamp,
                message: `✅ Configuration MCP lue depuis ${settingsPath}\n\n🔒 **AUTORISATION D'ÉCRITURE ACCORDÉE** (valable 5 minutes)\n\n🔐 #3987: valeurs \`env\` masquées en empreintes (same/different arbitrable, jamais le clair)`,
                details: maskEnvSecrets(mcpSettings)
            };
        }

        case 'write': {
            if (!settings) {
                throw new HeartbeatServiceError('settings requis pour subAction "write"', 'MISSING_SETTINGS');
            }

            const authCheck = checkWriteAuthorization(callerSeat);
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
                await backupMcpSettings(targetExtension);
            }

            // #552: Clean up empty autoApprove arrays before writing
            cleanupEmptyAutoApprove(settings);
            const writePath = getMcpSettingsPath(targetExtension);
            await writeMcpSettingsAtomic(writePath, settings);

            return {
                success: true,
                action: 'manage',
                subAction: 'write',
                timestamp,
                message: `✅ Configuration MCP écrite avec succès${backup ? ' (sauvegarde créée)' : ''}\n\n${authCheck.message}`,
                details: { path: writePath }
            };
        }

        case 'backup': {
            const backupPath = await backupMcpSettings(targetExtension);

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

            const authCheck = checkWriteAuthorization(callerSeat);
            if (!authCheck.isAuthorized) {
                throw new HeartbeatServiceError(
                    `MISE À JOUR SERVEUR REFUSÉE: ${authCheck.message}\n\n📋 État actuel: ${getAuthorizationStatus()}`,
                    'WRITE_NOT_AUTHORIZED'
                );
            }

            const content = await fs.readFile(getMcpSettingsPath(targetExtension), 'utf-8');
            const mcpSettings = JSON.parse(content) as McpSettings;

            if (backup) {
                await backupMcpSettings(targetExtension);
            }

            mcpSettings.mcpServers[server_name] = server_config as McpServer;
            await writeMcpSettingsAtomic(getMcpSettingsPath(targetExtension), mcpSettings);

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

            const authCheck4 = checkWriteAuthorization(callerSeat);
            if (!authCheck4.isAuthorized) {
                throw new HeartbeatServiceError(
                    `MISE À JOUR CHAMP REFUSÉE: ${authCheck4.message}\n\n📋 État actuel: ${getAuthorizationStatus()}`,
                    'WRITE_NOT_AUTHORIZED'
                );
            }

            const content4 = await fs.readFile(getMcpSettingsPath(targetExtension), 'utf-8');
            const mcpSettings4 = JSON.parse(content4) as McpSettings;

            if (!mcpSettings4.mcpServers[server_name]) {
                throw new HeartbeatServiceError(
                    `Serveur "${server_name}" non trouvé dans mcp_settings.json`,
                    'SERVER_NOT_FOUND'
                );
            }

            if (backup) {
                await backupMcpSettings(targetExtension);
            }

            // FUSION (merge) au lieu de remplacement: on ne touche que les champs fournis
            const existingConfig = mcpSettings4.mcpServers[server_name];
            const updatedFields = Object.keys(server_config);
            mcpSettings4.mcpServers[server_name] = { ...existingConfig, ...server_config } as McpServer;

            await writeMcpSettingsAtomic(getMcpSettingsPath(targetExtension), mcpSettings4);

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

            const authCheck = checkWriteAuthorization(callerSeat);
            if (!authCheck.isAuthorized) {
                throw new HeartbeatServiceError(
                    `BASCULEMENT SERVEUR REFUSÉ: ${authCheck.message}\n\n📋 État actuel: ${getAuthorizationStatus()}`,
                    'WRITE_NOT_AUTHORIZED'
                );
            }

            const content = await fs.readFile(getMcpSettingsPath(targetExtension), 'utf-8');
            const mcpSettings = JSON.parse(content) as McpSettings;

            if (!mcpSettings.mcpServers[server_name]) {
                throw new HeartbeatServiceError(`Serveur "${server_name}" non trouvé`, 'SERVER_NOT_FOUND');
            }

            if (backup) {
                await backupMcpSettings(targetExtension);
            }

            const currentState = mcpSettings.mcpServers[server_name].disabled === true;
            mcpSettings.mcpServers[server_name].disabled = !currentState;

            await writeMcpSettingsAtomic(getMcpSettingsPath(targetExtension), mcpSettings);

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

            const authCheck = checkWriteAuthorization(callerSeat);
            if (!authCheck.isAuthorized) {
                throw new HeartbeatServiceError(
                    `SYNC AUTO-APPROVE REFUSÉ: ${authCheck.message}\n\n📋 État actuel: ${getAuthorizationStatus()}`,
                    'WRITE_NOT_AUTHORIZED'
                );
            }

            const content = await fs.readFile(getMcpSettingsPath(targetExtension), 'utf-8');
            const mcpSettings = JSON.parse(content) as McpSettings;

            if (!mcpSettings.mcpServers[server_name]) {
                throw new HeartbeatServiceError(`Serveur "${server_name}" non trouvé`, 'SERVER_NOT_FOUND');
            }

            if (backup) {
                await backupMcpSettings(targetExtension);
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

            await writeMcpSettingsAtomic(getMcpSettingsPath(targetExtension), mcpSettings);

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
    const { mcp_name, targetExtension } = args;

    if (!mcp_name) {
        throw new HeartbeatServiceError('mcp_name requis pour action "rebuild"', 'MISSING_MCP_NAME');
    }

    const timestamp = new Date().toISOString();

    // Lire la configuration MCP
    const settingsContent = await fs.readFile(getMcpSettingsPath(targetExtension), 'utf-8');
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

    // #4006: refuser de builder hors d'une racine de package — l'heuristique
    // dirname×2 peut résoudre vers une racine de disque (D:/build/index.js → D:/)
    // où `npm run build` échouerait de façon obscure ou toucherait le mauvais projet.
    try {
        await fs.access(path.join(mcpPath, 'package.json'));
    } catch {
        throw new HeartbeatServiceError(
            `Chemin résolu "${mcpPath}" pour MCP "${mcp_name}" sans package.json — heuristique args[0] probablement fausse. Ajoutez une propriété "cwd" pointant vers la racine du serveur.`,
            'INVALID_MCP_PATH'
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
        touchedFile = getMcpSettingsPath(targetExtension);
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

async function handleTouchAction(args: McpManagementArgs): Promise<McpManagementResult> {
    const { targetExtension } = args;
    const timestamp = new Date().toISOString();
    const settingsPath = getMcpSettingsPath(targetExtension);

    // Vérifier que le fichier existe
    await fs.access(settingsPath);

    // Toucher le fichier
    const now = new Date();
    await fs.utimes(settingsPath, now, now);

    return {
        success: true,
        action: 'touch',
        timestamp,
        message: `✅ Fichier mcp_settings.json touché avec succès - Tous les MCPs vont redémarrer`,
        details: {
            path: settingsPath,
            touchedAt: now.toISOString()
        }
    };
}

// ====================================================================
// FONCTIONS UTILITAIRES
// ====================================================================

async function backupMcpSettings(targetExtension?: 'roo' | 'zoo'): Promise<string> {
    // #4006: PID + random suffix — deux backups concurrents dans la même
    // milliseconde s'écrasaient mutuellement (perte d'historique de rollback).
    const timestamp = `${new Date().toISOString().replace(/[:.]/g, '-')}_${process.pid}-${randomBytes(4).toString('hex')}`;
    const settingsPath = getMcpSettingsPath(targetExtension);
    const backupPath = settingsPath.replace('.json', `_backup_${timestamp}.json`);

    const content = await fs.readFile(settingsPath, 'utf-8');
    await fs.writeFile(backupPath, content, 'utf-8');

    return backupPath;
}

/**
 * #3988: staged write pour mcp_settings.json — tmp PID-suffixé puis copy-in-place,
 * même pattern que dashboard.ts #3782/#4003. Un crash/kill pendant l'écriture ne
 * doit jamais laisser un JSON tronqué à la place du fichier vivant : l'extension
 * ne s'en remettrait pas seule (parse error au démarrage → MCP down machine-wide).
 * copyFile (pas rename) pour l'homogénéité avec le writer dashboard ; le unlink du
 * staging est best-effort en finally — son échec ne masque pas celui de la copie.
 */
async function writeMcpSettingsAtomic(settingsPath: string, settings: McpSettings | Record<string, any>): Promise<void> {
    const tmpPath = `${settingsPath}.${process.pid}.tmp`;
    try {
        await fs.writeFile(tmpPath, JSON.stringify(settings, null, 2), 'utf-8');
        await fs.copyFile(tmpPath, settingsPath);
    } finally {
        // best-effort (cf. #4003) — un staging orphelin est balayable, un fichier
        // vivant tronqué ne l'est pas. Promise.resolve wrappe un éventuel retour
        // non-Promise : le cleanup ne doit jamais lever là où il protège.
        await Promise.resolve(fs.unlink(tmpPath)).catch(() => {});
    }
}

/**
 * #2307 (Phase 4, item EBUSY) : retry borné sur EBUSY Windows — l'hôte MCP
 * vivant tient les binaires natifs (.node, ex. sqlite3.node) chargés pendant
 * un rebuild, et Windows verrouille les DLL chargées : le remplacement échoue
 * de façon transitoire jusqu'à ce que l'ancien hôte relâche le handle.
 * Organisme unique partagé avec l'outil legacy `rebuild_and_restart_mcp`
 * (même backoff, même plafond — pas deux implémentations qui dérivent).
 */
export const EBUSY_RETRIES = 3;
export const EBUSY_BASE_DELAY_MS = 2000;

export function isEBUSYError(error: unknown): boolean {
    const e = error as { message?: string; code?: string } | null;
    return Boolean(e?.message?.includes('EBUSY')) || e?.code === 'EBUSY';
}

export async function withEBUSYRetry<T>(
    op: () => Promise<T>,
    opts: {
        retries?: number;
        baseDelayMs?: number;
        wrapError?: (error: unknown, attempt: number, retries: number) => Error;
    } = {}
): Promise<T> {
    const { retries = EBUSY_RETRIES, baseDelayMs = EBUSY_BASE_DELAY_MS, wrapError } = opts;
    const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            return await op();
        } catch (error) {
            if (isEBUSYError(error) && attempt < retries) {
                await delay(attempt * baseDelayMs);
                continue;
            }
            throw wrapError ? wrapError(error, attempt, retries) : error;
        }
    }
    /* unreachable — chaque itération retourne ou lève */
    throw new Error('withEBUSYRetry: retries exhausted without throw');
}

async function runNpmBuild(mcpPath: string): Promise<string> {
    return withEBUSYRetry(
        () => new Promise<string>((resolve, reject) => {
            exec('npm run build', { cwd: mcpPath, windowsHide: true }, (error, stdout) => {
                if (error) {
                    reject(error);
                } else {
                    resolve(stdout);
                }
            });
        }),
        {
            wrapError: (error, attempt, retries) =>
                new HeartbeatServiceError(
                    `Build failed (attempt ${attempt}/${retries}): ${(error as Error)?.message || error}`,
                    'BUILD_FAILED'
                ),
        }
    );
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
                return await handleTouchAction(args);

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
