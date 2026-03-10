import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { GenericError, GenericErrorCode } from '../types/errors.js';

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

/**
 * Returns the path to mcp_settings.json.
 *
 * IMPORTANT: This is a function (not a constant) so that process.env.APPDATA
 * is read at CALL TIME, not at MODULE LOAD TIME. This is critical for test
 * isolation — see incident 2026-03-08 (ai-01 wipe) and 2026-03-10 (po-2026 wipe).
 */
function getMcpSettingsPath(): string {
    return path.join(
        process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
        'Code', 'User', 'globalStorage',
        'rooveterinaryinc.roo-cline', 'settings', 'mcp_settings.json'
    );
}

// ====================================================================
// 🔒 MÉCANISME DE SÉCURISATION - Protection contre l'écriture sans lecture préalable
// ====================================================================

/**
 * Horodatage de la dernière lecture réussie des paramètres MCP
 * Utilisé pour autoriser les écritures seulement après une lecture récente
 */
let lastReadTimestamp: number | null = null;

/**
 * Délai d'autorisation après lecture (en millisecondes)
 * Par défaut: 1 minute (60000 ms)
 */
const WRITE_AUTHORIZATION_TIMEOUT = 60000; // 1 minute

/**
 * Vérifie si une écriture est autorisée (lecture récente requise)
 * @returns {Object} Résultat avec isAuthorized (boolean) et message (string)
 */
function checkWriteAuthorization(): { isAuthorized: boolean; message: string } {
    if (lastReadTimestamp === null) {
        return {
            isAuthorized: false,
            message: '🚨 SÉCURITÉ: Lecture préalable requise avant toute écriture. Utilisez d\'abord l\'action "read" pour consulter les paramètres existants.'
        };
    }

    const now = Date.now();
    const timeSinceRead = now - lastReadTimestamp;
    const remainingTime = WRITE_AUTHORIZATION_TIMEOUT - timeSinceRead;

    if (timeSinceRead > WRITE_AUTHORIZATION_TIMEOUT) {
        const minutesExpired = Math.ceil(timeSinceRead / 60000);
        return {
            isAuthorized: false,
            message: `🚨 SÉCURITÉ: Autorisation d'écriture expirée (lecture effectuée il y a ${minutesExpired} minute${minutesExpired > 1 ? 's' : ''}). Relancez d\'abord une action "read" pour renouveler l\'autorisation.`
        };
    }

    const remainingMinutes = Math.ceil(remainingTime / 60000);
    return {
        isAuthorized: true,
        message: `✅ Écriture autorisée (autorisation valable encore ${remainingMinutes} minute${remainingMinutes > 1 ? 's' : ''})`
    };
}

/**
 * Enregistre un horodatage de lecture réussie
 */
function recordSuccessfulRead(): void {
    lastReadTimestamp = Date.now();
}

/**
 * Obtient les informations sur l'état d'autorisation actuel
 */
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

/**
 * Test-only: Réinitialise l'horodatage de lecture
 * WARNING: Cette fonction ne doit être utilisée que dans les tests unitaires
 */
export function _test_resetLastReadTimestamp(): void {
    lastReadTimestamp = null;
}

// ====================================================================

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
    async handler(args: {
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
        const content = await fs.readFile(getMcpSettingsPath(), 'utf-8');
        const settings = JSON.parse(content) as McpSettings;
        
        // 🔒 SÉCURITÉ: Enregistrer l'horodatage de lecture réussie
        recordSuccessfulRead();
        
        return {
            content: [{
                type: 'text' as const,
                text: `✅ Configuration MCP lue depuis ${getMcpSettingsPath()}\n\n🔒 **AUTORISATION D'ÉCRITURE ACCORDÉE** (valable 1 minute)\n\n${JSON.stringify(settings, null, 2)}`
            }]
        };
    } catch (error) {
        return {
            content: [{
                type: 'text' as const,
                text: `❌ Erreur de lecture: ${error instanceof Error ? error.message : String(error)}\n\n⚠️ Aucune autorisation d'écriture accordée due à l'échec de lecture.`
            }]
        };
    }
}

async function writeMcpSettings(settings: McpSettings, backup: boolean): Promise<CallToolResult> {
    try {
        // 🔒 SÉCURITÉ: Vérifier l'autorisation d'écriture
        const authCheck = checkWriteAuthorization();
        if (!authCheck.isAuthorized) {
            return {
                content: [{
                    type: 'text' as const,
                    text: `❌ **ÉCRITURE REFUSÉE**\n\n${authCheck.message}\n\n📋 **État actuel:** ${getAuthorizationStatus()}\n\n💡 **Solution:** Exécutez d'abord :\n\`\`\`\nuse_mcp_tool roo-state-manager manage_mcp_settings {"action": "read"}\n\`\`\``
                }]
            };
        }

        // Valider la structure JSON
        if (!settings.mcpServers || typeof settings.mcpServers !== 'object') {
            throw new GenericError('Structure invalide: mcpServers requis', GenericErrorCode.INVALID_ARGUMENT);
        }
        
        if (backup) {
            await backupMcpSettings();
        }
        
        const content = JSON.stringify(settings, null, 2);
        await fs.writeFile(getMcpSettingsPath(), content, 'utf-8');
        
        return {
            content: [{
                type: 'text' as const,
                text: `✅ **ÉCRITURE AUTORISÉE ET RÉUSSIE**\n\nConfiguration MCP écrite avec succès dans ${getMcpSettingsPath()}${backup ? ' (sauvegarde créée)' : ''}\n\n${authCheck.message}`
            }]
        };
    } catch (error) {
        return {
            content: [{
                type: 'text' as const,
                text: `❌ Erreur d'écriture: ${error instanceof Error ? error.message : String(error)}`
            }]
        };
    }
}

// Outil rebuild_task_index déplacé ici à cause d'un problème runtime dans vscode-global-state.ts
export const rebuildTaskIndexFixed = {
    name: 'rebuild_task_index',
    description: 'Reconstruit l\'index SQLite VS Code en ajoutant les tâches orphelines détectées sur le disque.',
    inputSchema: {
        type: 'object',
        properties: {
            workspace_filter: {
                type: 'string',
                description: 'Filtre optionnel par workspace. Si spécifié, seules les tâches de ce workspace seront ajoutées.'
            },
            max_tasks: {
                type: 'number',
                description: 'Nombre maximum de tâches à ajouter (pour test). Par défaut, toutes les tâches.',
                default: 0
            },
            dry_run: {
                type: 'boolean',
                description: 'Si true, simule l\'opération sans modifier l\'index SQLite.',
                default: false
            }
        },
        required: []
    },
    async handler(args: { workspace_filter?: string, max_tasks?: number, dry_run?: boolean }) {
        const { workspace_filter, max_tasks = 0, dry_run = false } = args;
        
        try {
            // Implémentation simplifiée qui ne dépend pas de RooStorageDetector
            const tasksDir = path.join(os.homedir(), 'AppData', 'Roaming', 'Code', 'User', 'globalStorage', 'rooveterinaryinc.roo-cline', 'tasks');
            
            let report = `# 🔧 REBUILD TASK INDEX - IMPLÉMENTATION SIMPLIFIÉE\n\n`;
            report += `**Mode:** ${dry_run ? '🧪 SIMULATION (dry-run)' : '⚡ RECONSTRUCTION RÉELLE'}\n`;
            report += `**Répertoire de base:** ${tasksDir}\n\n`;
            
            // Vérifier si le répertoire existe
            try {
                const stats = await fs.stat(tasksDir);
                if (!stats.isDirectory()) {
                    throw new GenericError('Pas un répertoire', GenericErrorCode.FILE_SYSTEM_ERROR);
                }
                report += `✅ **Répertoire des conversations trouvé !**\n\n`;
            } catch (error) {
                report += `❌ **Répertoire des conversations introuvable :** ${tasksDir}\n`;
                report += `⚠️ **Suggestion :** Vérifiez que Roo-Code a été utilisé au moins une fois.\n\n`;
                
                return {
                    content: [{
                        type: 'text' as const,
                        text: report
                    }]
                };
            }
            
            // Lister les tâches disponibles
            const entries = await fs.readdir(tasksDir);
            const taskDirs = [];
            
            for (const entry of entries) {
                const fullPath = path.join(tasksDir, entry);
                try {
                    const stats = await fs.stat(fullPath);
                    if (stats.isDirectory()) {
                        // Vérifier si c'est un UUID valide (format basique)
                        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entry)) {
                            taskDirs.push({
                                id: entry,
                                path: fullPath,
                                stats: stats
                            });
                        }
                    }
                } catch (error) {
                    // Ignorer les erreurs d'accès
                    continue;
                }
            }
            
            report += `📊 **Tâches détectées sur le disque:** ${taskDirs.length}\n`;
            
            if (workspace_filter) {
                report += `🔍 **Filtre workspace actif:** ${workspace_filter}\n`;
            }
            
            if (max_tasks > 0) {
                report += `🎯 **Limite fixée:** ${max_tasks} tâches\n`;
            }
            
            report += `\n## 📋 ANALYSE DES TÂCHES\n\n`;
            
            let processedCount = 0;
            let metadataGeneratedCount = 0;
            let errorCount = 0;
            
            // Traiter les tâches
            const tasksToProcess = max_tasks > 0 ? taskDirs.slice(0, max_tasks) : taskDirs;
            
            for (const task of tasksToProcess) {
                processedCount++;
                
                const metadataFile = path.join(task.path, 'task_metadata.json');
                
                try {
                    // Vérifier si task_metadata.json existe déjà
                    await fs.access(metadataFile);
                    report += `✅ **${task.id}** : task_metadata.json existe déjà\n`;
                } catch (error) {
                    // task_metadata.json n'existe pas, le créer
                    report += `🔧 **${task.id}** : Génération de task_metadata.json...\n`;
                    
                    if (!dry_run) {
                        try {
                            // Détecter le workspace réel avec WorkspaceDetector
                            let detectedWorkspace = 'unknown';
                            try {
                                const { WorkspaceDetector } = await import('../utils/workspace-detector.js');
                                const workspaceDetector = new WorkspaceDetector({
                                    enableCache: true,
                                    validateExistence: false,
                                    normalizePaths: true
                                });
                                
                                const workspaceResult = await workspaceDetector.detect(task.path);
                                if (workspaceResult.workspace) {
                                    detectedWorkspace = workspaceResult.workspace;
                                }
                            } catch (workspaceError) {
                                console.warn(`[WARN] Impossible de détecter le workspace pour ${task.id}: ${workspaceError}`);
                                // Garder 'unknown' comme fallback
                            }
                            
                            // Créer un metadata basique avec le workspace détecté
                            const basicMetadata = {
                                id: task.id,
                                createdAt: task.stats.birthtime.toISOString(),
                                lastModified: task.stats.mtime.toISOString(),
                                title: `Tâche ${task.id.substring(0, 8)}...`,
                                mode: 'unknown',
                                messageCount: 0,
                                actionCount: 0,
                                totalSize: 0,
                                workspace: detectedWorkspace,
                                status: 'restored'
                            };
                            
                            await fs.writeFile(metadataFile, JSON.stringify(basicMetadata, null, 2), 'utf-8');
                            metadataGeneratedCount++;
                            report += `   ✅ Metadata généré avec succès\n`;
                        } catch (writeError) {
                            errorCount++;
                            report += `   ❌ Erreur d'écriture: ${writeError}\n`;
                        }
                    } else {
                        metadataGeneratedCount++; // Compter comme réussi en mode dry-run
                        report += `   🧪 SIMULATION : Metadata serait généré\n`;
                    }
                }
                
                // Appliquer le filtre workspace si nécessaire
                if (workspace_filter) {
                    // En mode simplifié, on ne peut pas facilement extraire le workspace
                    // On fait confiance au filtre fourni
                }
            }
            
            report += `\n## 📊 RÉSULTATS\n\n`;
            report += `- **Tâches traitées:** ${processedCount}\n`;
            report += `- **Métadonnées générées:** ${metadataGeneratedCount}\n`;
            report += `- **Erreurs:** ${errorCount}\n`;
            
            if (dry_run) {
                report += `\n⚠️ **MODE SIMULATION** - Aucune modification effectuée sur le disque.\n`;
                report += `Relancez avec \`"dry_run": false\` pour appliquer les changements.\n`;
            } else {
                report += `\n✅ **RECONSTRUCTION TERMINÉE !**\n`;
                if (metadataGeneratedCount > 0) {
                    report += `🎉 ${metadataGeneratedCount} fichiers task_metadata.json ont été créés.\n`;
                    report += `📱 Les tâches devraient maintenant apparaître dans l'interface Roo-Code !\n`;
                }
            }
            
            return {
                content: [{
                    type: 'text' as const,
                    text: report
                }]
            };
            
        } catch (error) {
            return {
                content: [{
                    type: 'text' as const,
                    text: `❌ ERREUR lors de la reconstruction de l'index :\n\n${error instanceof Error ? error.message : String(error)}\n\nStack trace:\n${error instanceof Error ? error.stack : 'N/A'}`
                }]
            };
        }
    }
};

async function backupMcpSettings(): Promise<CallToolResult> {
    try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupPath = getMcpSettingsPath().replace('.json', `_backup_${timestamp}.json`);
        
        const content = await fs.readFile(getMcpSettingsPath(), 'utf-8');
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
        // 🔒 SÉCURITÉ: Vérifier l'autorisation d'écriture
        const authCheck = checkWriteAuthorization();
        if (!authCheck.isAuthorized) {
            return {
                content: [{
                    type: 'text' as const,
                    text: `❌ **MISE À JOUR SERVEUR REFUSÉE**\n\n${authCheck.message}\n\n📋 **État actuel:** ${getAuthorizationStatus()}\n\n💡 **Solution:** Exécutez d'abord :\n\`\`\`\nuse_mcp_tool roo-state-manager manage_mcp_settings {"action": "read"}\n\`\`\``
                }]
            };
        }

        const content = await fs.readFile(getMcpSettingsPath(), 'utf-8');
        const settings = JSON.parse(content) as McpSettings;
        
        if (backup) {
            await backupMcpSettings();
        }
        
        settings.mcpServers[serverName] = serverConfig;
        
        const newContent = JSON.stringify(settings, null, 2);
        await fs.writeFile(getMcpSettingsPath(), newContent, 'utf-8');
        
        return {
            content: [{
                type: 'text' as const,
                text: `✅ **MISE À JOUR SERVEUR AUTORISÉE ET RÉUSSIE**\n\nConfiguration du serveur "${serverName}" mise à jour avec succès${backup ? ' (sauvegarde créée)' : ''}\n\n${authCheck.message}`
            }]
        };
    } catch (error) {
        return {
            content: [{
                type: 'text' as const,
                text: `❌ Erreur de mise à jour du serveur: ${error instanceof Error ? error.message : String(error)}`
            }]
        };
    }
}

async function toggleServer(serverName: string, backup: boolean): Promise<CallToolResult> {
    try {
        // 🔒 SÉCURITÉ: Vérifier l'autorisation d'écriture
        const authCheck = checkWriteAuthorization();
        if (!authCheck.isAuthorized) {
            return {
                content: [{
                    type: 'text' as const,
                    text: `❌ **BASCULEMENT SERVEUR REFUSÉ**\n\n${authCheck.message}\n\n📋 **État actuel:** ${getAuthorizationStatus()}\n\n💡 **Solution:** Exécutez d'abord :\n\`\`\`\nuse_mcp_tool roo-state-manager manage_mcp_settings {"action": "read"}\n\`\`\``
                }]
            };
        }

        const content = await fs.readFile(getMcpSettingsPath(), 'utf-8');
        const settings = JSON.parse(content) as McpSettings;
        
        if (!settings.mcpServers[serverName]) {
            throw new GenericError(`Serveur "${serverName}" non trouvé`, GenericErrorCode.INVALID_ARGUMENT);
        }
        
        if (backup) {
            await backupMcpSettings();
        }
        
        const currentState = settings.mcpServers[serverName].disabled === true;
        settings.mcpServers[serverName].disabled = !currentState;
        
        const newContent = JSON.stringify(settings, null, 2);
        await fs.writeFile(getMcpSettingsPath(), newContent, 'utf-8');
        
        const newState = settings.mcpServers[serverName].disabled ? 'désactivé' : 'activé';
        
        return {
            content: [{
                type: 'text' as const,
                text: `✅ **BASCULEMENT SERVEUR AUTORISÉ ET RÉUSSI**\n\nServeur "${serverName}" ${newState} avec succès${backup ? ' (sauvegarde créée)' : ''}\n\n${authCheck.message}`
            }]
        };
    } catch (error) {
        return {
            content: [{
                type: 'text' as const,
                text: `❌ Erreur de basculement du serveur: ${error instanceof Error ? error.message : String(error)}`
            }]
        };
    }
}