import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import sqlite3 from 'sqlite3';
import { promisify } from 'util';
import { RooStorageDetector } from '../utils/roo-storage-detector.js';
import { ConversationSkeleton } from '../types/conversation.js';

interface HistoryItem {
    ts: number;
    task: string;
    workspace: string;
    id?: string;
}

interface VSCodeGlobalState {
    taskHistory?: HistoryItem[];
    [key: string]: any;
}

/**
 * Trouve le fichier de stockage global de VS Code pour l'extension Roo
 */
async function findVSCodeGlobalStateFile(): Promise<string> {
    const userDataDir = path.join(os.homedir(), 'AppData', 'Roaming', 'Code', 'User', 'globalStorage');
    
    // Le state global principal de VS Code est dans globalStorage/state.vscdb
    const possibleFiles = [
        path.join(userDataDir, 'state.vscdb'),
        path.join(userDataDir, 'storage.json'),
        path.join(userDataDir, 'global.json')
    ];

    for (const file of possibleFiles) {
        try {
            await fs.access(file);
            return file;
        } catch {
            continue;
        }
    }
    // Si aucun fichier trouvé, on recherche tous les fichiers dans le répertoire
    try {
        const files = await fs.readdir(userDataDir);
        for (const file of files) {
            if (file.endsWith('.vscdb') || file.endsWith('.json')) {
                const fullPath = path.join(userDataDir, file);
                const stats = await fs.stat(fullPath);
                if (stats.isFile() && stats.size > 0) {
                    return fullPath;
                }
            }
        }
    } catch (error) {
        throw new Error(`Impossible de trouver le fichier de stockage global VS Code dans ${userDataDir}: ${error}`);
    }
    
    throw new Error(`Aucun fichier de stockage global VS Code trouvé dans ${userDataDir}`);
}

/**
 * Ouvre une base de données SQLite
 */
async function openDatabase(filePath: string): Promise<sqlite3.Database> {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(filePath, sqlite3.OPEN_READWRITE, (err) => {
            if (err) {
                reject(new Error(`Impossible d'ouvrir la base de données ${filePath}: ${err.message}`));
            } else {
                resolve(db);
            }
        });
    });
}

/**
 * Ferme une base de données SQLite
 */
async function closeDatabase(db: sqlite3.Database): Promise<void> {
    return new Promise((resolve, reject) => {
        db.close((err) => {
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        });
    });
}

/**
 * Lit l'état global VS Code depuis la base SQLite
 */
async function readVSCodeGlobalState(): Promise<VSCodeGlobalState> {
    const stateFile = await findVSCodeGlobalStateFile();
    const db = await openDatabase(stateFile);
    
    try {
        const get = promisify(db.get.bind(db));
        const row = await get("SELECT value FROM ItemTable WHERE key = 'rooveterinaryinc.roo-cline'") as { value: string } | undefined;
        
        if (!row) {
            return {};
        }
        
        return JSON.parse(row.value);
    } finally {
        await closeDatabase(db);
    }
}

/**
 * Écrit l'état global VS Code dans la base SQLite
 */
async function writeVSCodeGlobalState(state: VSCodeGlobalState): Promise<void> {
    const stateFile = await findVSCodeGlobalStateFile();
    const db = await openDatabase(stateFile);
    
    try {
        await new Promise<void>((resolve, reject) => {
            db.run("INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)", 'rooveterinaryinc.roo-cline', JSON.stringify(state), (err: Error | null) => {
                if (err) reject(err);
                else resolve();
            });
        });
    } finally {
        await closeDatabase(db);
    }
}

export const testVscodeGlobalStateFile = {
    name: 'test_vscode_global_state_file',
    description: 'Outil de test pour vérifier que vscode-global-state.ts fonctionne.',
    inputSchema: {
        type: 'object',
        properties: {},
        required: []
    },
    async handler(): Promise<CallToolResult> {
        return {
            content: [{
                type: 'text',
                text: 'Test réussi ! Le fichier vscode-global-state.ts fonctionne correctement.'
            }]
        };
    }
};

export const rebuildTaskIndex = {
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
    async handler(args: { workspace_filter?: string, max_tasks?: number, dry_run?: boolean }): Promise<CallToolResult> {
        const { workspace_filter, max_tasks = 0, dry_run = false } = args;
        
        try {
            // Lire l'état VS Code actuel pour obtenir les tâches indexées
            const state = await readVSCodeGlobalState();
            const indexedTasks = new Set<string>();
            let currentTaskHistory: HistoryItem[] = [];
            
            if (state.taskHistory && Array.isArray(state.taskHistory)) {
                currentTaskHistory = [...state.taskHistory];
                state.taskHistory.forEach(task => {
                    if (task.id) {
                        indexedTasks.add(task.id);
                    }
                });
            }

            // Scanner les tâches sur le disque
            const tasksDir = path.join(os.homedir(), 'AppData', 'Roaming', 'Code', 'User', 'globalStorage', 'rooveterinaryinc.roo-cline', 'tasks');
            
            let diskTasks: Array<{id: string, workspace?: string, lastActivity?: Date}> = [];
            
            try {
                const taskFolders = await fs.readdir(tasksDir);
                
                for (const taskId of taskFolders) {
                    const taskPath = path.join(tasksDir, taskId);
                    const stats = await fs.stat(taskPath);
                    
                    if (stats.isDirectory() && taskId !== '.skeletons') {
                        let workspace = undefined;
                        let hasFiles = false;
                        
                        try {
                            // Vérifier s'il y a des fichiers dans ce répertoire
                            const files = await fs.readdir(taskPath);
                            hasFiles = files.length > 0;
                            
                            // Utiliser le WorkspaceDetector standardisé pour détecter le workspace
                            try {
                                const { WorkspaceDetector } = await import('../utils/workspace-detector.js');
                                const workspaceDetector = new WorkspaceDetector({
                                    enableCache: true,
                                    validateExistence: false,
                                    normalizePaths: true
                                });
                                
                                const workspaceResult = await workspaceDetector.detect(taskPath);
                                if (workspaceResult.workspace) {
                                    workspace = workspaceResult.workspace;
                                }
                            } catch (workspaceError) {
                                console.warn(`[WARN] Impossible de détecter le workspace pour ${taskId}: ${workspaceError}`);
                                // Garder la tâche même sans workspace
                            }
                        } catch (error) {
                            // Erreur générale, on garde la tâche sans workspace
                        }
                        
                        // Ajouter toutes les tâches qui ont des fichiers
                        if (hasFiles) {
                            diskTasks.push({
                                id: taskId,
                                workspace: workspace,
                                lastActivity: stats.mtime
                            });
                        }
                    }
                }
            } catch (error) {
                return {
                    content: [{
                        type: 'text',
                        text: `Erreur lors de la lecture du répertoire des tâches: ${error}`
                    }]
                };
            }

            // Identifier les tâches orphelines
            let orphanTasks = diskTasks.filter(task => !indexedTasks.has(task.id));
            
            // Appliquer le filtre de workspace si spécifié
            if (workspace_filter) {
                orphanTasks = orphanTasks.filter(task =>
                    task.workspace && task.workspace.includes(workspace_filter)
                );
            }
            
            // Appliquer la limite si spécifiée
            if (max_tasks > 0) {
                orphanTasks = orphanTasks.slice(0, max_tasks);
            }

            let report = `# Reconstruction de l'index des tâches\n\n`;
            report += `**Mode:** ${dry_run ? 'Simulation (dry-run)' : 'Reconstruction réelle'}\n`;
            report += `**Tâches dans l'index actuel:** ${indexedTasks.size}\n`;
            report += `**Tâches sur le disque:** ${diskTasks.length}\n`;
            report += `**Tâches orphelines totales:** ${diskTasks.filter(task => !indexedTasks.has(task.id)).length}\n`;
            
            if (workspace_filter) {
                report += `**Filtre workspace:** ${workspace_filter}\n`;
            }
            
            if (max_tasks > 0) {
                report += `**Limite:** ${max_tasks} tâches\n`;
            }
            
            report += `**Tâches à traiter:** ${orphanTasks.length}\n\n`;

            if (orphanTasks.length === 0) {
                report += `ℹ️ Aucune tâche orpheline à ajouter.\n`;
                return { content: [{ type: 'text', text: report }] };
            }

            // Préparer les nouvelles entrées pour taskHistory
            const newHistoryItems: HistoryItem[] = [];
            let addedTasks = 0;
            let failedTasks = 0;
            let successfulMetadata = 0;
            let failedMetadata = 0;
            const failureDetails: string[] = [];
            const metadataFailureDetails: string[] = [];
            
            for (const orphanTask of orphanTasks) {
                try {
                    // Obtenir le chemin complet de la tâche
                    const taskPath = path.join(tasksDir, orphanTask.id);
                    let skeleton: ConversationSkeleton | null = null;
                    let metadataGenerated = false;
                    
                    // Tentative de génération des métadonnées
                    try {
                        skeleton = await RooStorageDetector.analyzeConversation(orphanTask.id, taskPath);
                        
                        if (skeleton) {
                            const metadataFilePath = path.join(taskPath, 'task_metadata.json');
                            
                            // En mode non-dry-run, on écrit le fichier
                            if (!dry_run) {
                                await fs.writeFile(metadataFilePath, JSON.stringify(skeleton.metadata, null, 2), 'utf-8');
                            }
                            metadataGenerated = true;
                            successfulMetadata++;
                        } else {
                            failedMetadata++;
                            metadataFailureDetails.push(`${orphanTask.id}: Skeleton generation returned null`);
                        }
                    } catch (metadataError) {
                        failedMetadata++;
                        metadataFailureDetails.push(`${orphanTask.id}: ${metadataError}`);
                        // On ne bloque pas le processus, on continue avec un HistoryItem basique
                    }
                    
                    // Utiliser le workspace détecté par le WorkspaceDetector ou celui du squelette
                    // Le WorkspaceDetector est plus fiable que la détection manuelle précédente
                    let normalizedWorkspace = skeleton?.metadata?.workspace || orphanTask.workspace || 'unknown';
                    
                    // Normaliser le chemin de workspace pour éviter les problèmes forward/backslash
                    if (normalizedWorkspace !== 'unknown') {
                        // Convertir en backslashes et supprimer les slashes de fin
                        normalizedWorkspace = normalizedWorkspace
                            .replace(/\//g, '\\')
                            .replace(/\\+$/, '');
                    }
                    
                    // Création du HistoryItem (amélioré avec les données du squelette si disponible)
                    const historyItem: HistoryItem = {
                        ts: orphanTask.lastActivity ? orphanTask.lastActivity.getTime() : Date.now(),
                        // Utiliser le titre du squelette si disponible, sinon l'ID de la tâche
                        task: skeleton?.metadata?.title || orphanTask.id,
                        workspace: normalizedWorkspace,
                        id: orphanTask.id
                    };
                    
                    newHistoryItems.push(historyItem);
                    addedTasks++;
                } catch (error) {
                    failedTasks++;
                    failureDetails.push(`${orphanTask.id}: ${error}`);
                }
            }

            // Trier toutes les tâches par timestamp (les plus récentes en premier)
            const allTasks = [...currentTaskHistory, ...newHistoryItems].sort((a, b) => b.ts - a.ts);
            
            if (!dry_run && newHistoryItems.length > 0) {
                // Mettre à jour l'état global
                const updatedState = {
                    ...state,
                    taskHistory: allTasks
                };
                
                await writeVSCodeGlobalState(updatedState);
                
                report += `✅ **Index mis à jour avec succès !**\n\n`;
                report += `**Tâches ajoutées:** ${addedTasks}\n`;
                report += `**Total après mise à jour:** ${allTasks.length}\n`;
                
                if (failedTasks > 0) {
                    report += `**Échecs:** ${failedTasks}\n`;
                }
                
                report += `\n**Prochaines étapes:**\n`;
                report += `1. Redémarrer complètement VS Code\n`;
                report += `2. Vérifier que les tâches réapparaissent dans le panneau Roo\n`;
                report += `3. Valider que les tâches sont fonctionnelles\n`;
                
            } else {
                report += `🔍 **Simulation terminée.**\n\n`;
                report += `**Tâches qui seraient ajoutées:** ${addedTasks}\n`;
                report += `**Nouveau total après ajout:** ${currentTaskHistory.length + addedTasks}\n`;
                
                if (failedTasks > 0) {
                    report += `**Échecs potentiels:** ${failedTasks}\n`;
                }
            }
            
            // Afficher le rapport sur la génération de métadonnées
            report += `\n## Génération de Métadonnées:\n`;
            report += `**Succès:** ${successfulMetadata}\n`;
            report += `**Échecs:** ${failedMetadata}\n`;
            
            if (failedMetadata > 0 && metadataFailureDetails.length > 0) {
                report += `\n### Détails des échecs de métadonnées:\n`;
                metadataFailureDetails.slice(0, 5).forEach(detail => {
                    report += `- ${detail}\n`;
                });
                if (metadataFailureDetails.length > 5) {
                    report += `... et ${metadataFailureDetails.length - 5} autres échecs de métadonnées.\n`;
                }
            }

            // Afficher quelques exemples de tâches traitées
            if (newHistoryItems.length > 0) {
                report += `\n## Échantillon de tâches ${dry_run ? 'qui seraient ajoutées' : 'ajoutées'} (5 premières):\n`;
                newHistoryItems.slice(0, 5).forEach((task, index) => {
                    report += `${index + 1}. **${task.id}**\n`;
                    report += `   - Workspace: ${task.workspace}\n`;
                    report += `   - Timestamp: ${new Date(task.ts).toLocaleString()}\n\n`;
                });
            }
            
            // Afficher les détails des échecs si il y en a
            if (failedTasks > 0 && failureDetails.length > 0) {
                report += `\n## Détails des échecs:\n`;
                failureDetails.forEach(detail => {
                    report += `- ${detail}\n`;
                });
                if (failureDetails.length > 50) {
                    report += `... et ${failureDetails.length - 50} autres échecs.\n`;
                }
            }

            return { content: [{ type: 'text', text: report }] };
            
        } catch (error) {
            return {
                content: [{
                    type: 'text',
                    text: `Erreur lors de la reconstruction de l'index: ${error instanceof Error ? error.message : String(error)}`
                }]
            };
        }
    }
};