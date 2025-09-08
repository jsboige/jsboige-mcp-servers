import path from 'path';
import fs from 'fs/promises';
import sqlite3 from 'sqlite3';
import { promisify } from 'util';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { RooStorageDetector } from '../utils/roo-storage-detector.js';

interface TaskHistoryItem {
    id: string;
    number: number;
    ts: number;
    task: string;
    tokensIn?: number;
    tokensOut?: number;
    cacheWrites?: number;
    cacheReads?: number;
    totalCost?: number;
    size?: number;
    workspace: string;
    mode?: string;
}

async function repairTaskHistory(targetWorkspace: string): Promise<CallToolResult> {
    try {
        const debugLog: string[] = [`[DEBUG] Démarrage de la réparation pour: ${targetWorkspace}`];
        
        // 1. Trouver le chemin des tâches pour le workspace cible
        const locations = await RooStorageDetector.detectStorageLocations();
        debugLog.push(`[DEBUG] Emplacements de stockage détectés: ${locations.length}`);
        
        let tasksFound = 0;
        const newTasks: TaskHistoryItem[] = [];
        const normalizePath = (p: string) => path.resolve(p).toLowerCase().replace(/\\/g, '/').replace(/\/$/, '');
        const normalizedTargetWorkspace = normalizePath(targetWorkspace);
        debugLog.push(`[DEBUG] Workspace cible normalisé: ${normalizedTargetWorkspace}`);
        
        // 2. Scanner tous les fichiers de tâches
        for (const tasksPath of locations) {
            try {
                const conversations = await fs.readdir(tasksPath, { withFileTypes: true });
                
                for (const conv of conversations) {
                    if (!conv.isDirectory()) continue;
                    
                    const taskPath = path.join(tasksPath, conv.name);
                    const historyPath = path.join(taskPath, 'api_conversation_history.json');
                    const metadataPath = path.join(taskPath, 'task_metadata.json');
                    
                    try {
                        let historyContent = await fs.readFile(historyPath, 'utf-8');
                        if (historyContent.charCodeAt(0) === 0xFEFF) {
                            historyContent = historyContent.slice(1);
                        }
                        
                        const match = historyContent.match(/Current Workspace Directory \(([^)]+)\)/);
                        const workspace = match ? match[1].trim() : null;

                        const normalizedWorkspace = workspace ? normalizePath(workspace) : null;
                        
                        debugLog.push(`[SCAN] Tâche: ${conv.name}`);
                        debugLog.push(`  -> Workspace brut: ${workspace}`);
                        debugLog.push(`  -> Workspace normalisé: ${normalizedWorkspace}`);
                        
                        if (workspace && normalizedWorkspace === normalizedTargetWorkspace) {
                            debugLog.push(`  -> ✅ MATCH!`);
                            // Lire les métadonnées pour les détails supplémentaires
                            const metadataContent = await fs.readFile(metadataPath, 'utf-8').catch(() => '{}');
                            const metadata = JSON.parse(metadataContent.charCodeAt(0) === 0xFEFF ? metadataContent.slice(1) : metadataContent);

                            const taskItem: TaskHistoryItem = {
                                id: conv.name,
                                number: metadata.taskNumber || tasksFound + 1,
                                ts: metadata.timestamp ? new Date(metadata.timestamp).getTime() : (await fs.stat(taskPath)).mtime.getTime(),
                                task: metadata.prompt || `Tâche ${conv.name}`,
                                workspace: workspace,
                                mode: metadata.mode || 'code',
                                tokensIn: metadata.totalTokensIn || 0,
                                tokensOut: metadata.totalTokensOut || 0,
                                cacheWrites: 0,
                                cacheReads: 0,
                                totalCost: metadata.totalCost || 0,
                                size: metadata.historySize || 0
                            };
                            
                            newTasks.push(taskItem);
                            tasksFound++;
                        }
                    } catch (historyError) {
                        console.log(`Fichier d'historique illisible pour ${conv.name}`);
                    }
                }
            } catch (dirError) {
                console.error(`Erreur de lecture du répertoire ${tasksPath}:`, dirError);
            }
        }
        
        console.log(`${tasksFound} tâches trouvées pour le workspace cible`);
        
        if (tasksFound === 0) {
            return {
                content: [{
                    type: 'text',
                    text: `# VÉRIFICATION CACHE v3\n\nAucune tâche trouvée pour: ${targetWorkspace}\n\n--- JOURNAL DE DÉBOGAGE ---\n${debugLog.join('\n')}`
                }]
            };
        }
        
        // 3. Trier les tâches par timestamp (plus récentes en premier)
        newTasks.sort((a, b) => b.ts - a.ts);
        
        // 4. Ouvrir la base SQLite et récupérer l'état actuel
        const userDataDir = process.env.APPDATA || process.env.USERPROFILE;
        if (!userDataDir) {
            throw new Error('Impossible de trouver le répertoire utilisateur');
        }
        
        const sqlitePath = path.join(userDataDir, 'Code', 'User', 'globalStorage', 'state.vscdb');
        console.log(`Ouverture de la base SQLite: ${sqlitePath}`);
        
        const db = new sqlite3.Database(sqlitePath);
        const dbGet = promisify(db.get.bind(db));
        
        try {
            // 5. Récupérer l'état global actuel
            const stateRow = await dbGet("SELECT value FROM ItemTable WHERE key = 'RooVeterinaryInc.roo-cline'") as { value: string } | undefined;
            
            if (!stateRow || !stateRow.value) {
                throw new Error('État global Roo introuvable dans la base SQLite');
            }
            
            const globalState = JSON.parse(stateRow.value);
            const currentTaskHistory = globalState.taskHistory || [];
            
            console.log(`TaskHistory actuel: ${currentTaskHistory.length} tâches`);
            
            // 6. Fusionner les nouvelles tâches avec l'historique existant
            const existingTaskIds = new Set(currentTaskHistory.map((task: TaskHistoryItem) => task.id));
            const uniqueNewTasks = newTasks.filter(task => !existingTaskIds.has(task.id));
            
            // Filtrer les tâches existantes qui ne sont plus sur le disque pour ce workspace
            const updatedTaskHistory = [
                ...uniqueNewTasks,
                ...currentTaskHistory.filter((task: TaskHistoryItem) => 
                    path.resolve(task.workspace) !== path.resolve(targetWorkspace)
                )
            ];
            
            // Trier par timestamp
            updatedTaskHistory.sort((a: TaskHistoryItem, b: TaskHistoryItem) => b.ts - a.ts);
            
            // 7. Mettre à jour l'état global
            globalState.taskHistory = updatedTaskHistory;
            
            await new Promise<void>((resolve, reject) => {
                db.run(
                    "UPDATE ItemTable SET value = ? WHERE key = 'RooVeterinaryInc.roo-cline'",
                    [JSON.stringify(globalState)],
                    function (err) {
                        if (err) {
                            reject(err);
                        } else {
                            resolve();
                        }
                    }
                );
            });
            
            console.log(`TaskHistory mis à jour: ${updatedTaskHistory.length} tâches au total`);
            
            const workspaceTaskCount = updatedTaskHistory.filter((task: TaskHistoryItem) => 
                path.resolve(task.workspace) === path.resolve(targetWorkspace)
            ).length;
            
            return {
                content: [{
                    type: 'text',
                    text: `# Réparation TaskHistory Réussie ✅\n\n` +
                         `**Workspace cible:** ${targetWorkspace}\n` +
                         `**Nouvelles tâches ajoutées:** ${uniqueNewTasks.length}\n` +
                         `**Tâches totales pour ce workspace:** ${workspaceTaskCount}\n` +
                         `**Tâches totales dans taskHistory:** ${updatedTaskHistory.length}\n\n` +
                         `🔄 **Redémarrez VS Code** pour voir les changements dans l'interface.`
                }]
            };
            
        } finally {
            db.close();
        }
        
    } catch (error) {
        console.error('Erreur lors de la réparation du taskHistory:', error);
        return {
            content: [{
                type: 'text',
                text: `# Erreur de Réparation ❌\n\n` +
                     `**Erreur:** ${error instanceof Error ? error.message : String(error)}\n\n` +
                     `**Stack:** ${error instanceof Error ? error.stack : 'N/A'}`
            }]
        };
    }
}

// Export avec métadonnées pour MCP
export const repairTaskHistoryTool = {
    name: 'repair_task_history',
    description: 'Répare le taskHistory en synchronisant avec les fichiers de tâches sur disque pour un workspace donné.',
    inputSchema: {
        type: 'object',
        properties: {
            target_workspace: {
                type: 'string',
                description: 'Chemin du workspace à synchroniser (ex: "d:/dev/2025-Epita-Intelligence-Symbolique")'
            }
        },
        required: ['target_workspace']
    },
    handler: repairTaskHistory
};