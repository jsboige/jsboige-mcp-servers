import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import sqlite3 from 'sqlite3';
import { promisify } from 'util';

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
        throw new Error(`Cannot find VS Code global storage directory: ${userDataDir}`);
    }

    throw new Error('No VS Code global state file found for Roo extension');
}

/**
 * Ouvre une connexion SQLite de façon promisifiée
 */
async function openDatabase(dbPath: string): Promise<sqlite3.Database> {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath, (err) => {
            if (err) {
                reject(err);
            } else {
                resolve(db);
            }
        });
    });
}

/**
 * Ferme une connexion SQLite de façon promisifiée
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
export async function readVSCodeGlobalState(): Promise<VSCodeGlobalState> {
    try {
        const stateFile = await findVSCodeGlobalStateFile();
        console.log(`Reading VS Code global state from SQLite: ${stateFile}`);
        
        // Si c'est un fichier JSON direct (cas rare)
        if (stateFile.endsWith('.json')) {
            const content = await fs.readFile(stateFile, 'utf8');
            return JSON.parse(content);
        }
        
        // Lecture depuis SQLite (.vscdb)
        const db = await openDatabase(stateFile);
        
        try {
            const getRooData = promisify(db.get.bind(db));
            const row = await getRooData("SELECT value FROM ItemTable WHERE key = 'RooVeterinaryInc.roo-cline'") as { value: string } | undefined;
            
            if (row && row.value) {
                console.log('Found Roo data in VS Code global state');
                return JSON.parse(row.value);
            } else {
                console.log('No Roo data found in VS Code global state');
                return {};
            }
        } finally {
            await closeDatabase(db);
        }
    } catch (error) {
        console.error('Error reading VS Code global state:', error);
        return {};
    }
}

/**
 * Écrit l'état global VS Code dans la base SQLite
 */
export async function writeVSCodeGlobalState(state: VSCodeGlobalState): Promise<void> {
    try {
        const stateFile = await findVSCodeGlobalStateFile();
        
        // Si c'est un fichier JSON direct (cas rare)
        if (stateFile.endsWith('.json')) {
            const backup = `${stateFile}.backup.${Date.now()}`;
            try {
                await fs.copyFile(stateFile, backup);
                console.log(`Backup created: ${backup}`);
            } catch (error) {
                console.warn('Could not create backup:', error);
            }
            
            const content = JSON.stringify(state, null, 2);
            await fs.writeFile(stateFile, content, 'utf8');
            console.log(`VS Code global state updated: ${stateFile}`);
            return;
        }
        
        // Sauvegarde de sécurité du fichier SQLite
        const backup = `${stateFile}.backup.${Date.now()}`;
        try {
            await fs.copyFile(stateFile, backup);
            console.log(`SQLite backup created: ${backup}`);
        } catch (error) {
            console.warn('Could not create SQLite backup:', error);
        }
        
        // Écriture dans SQLite
        const db = await openDatabase(stateFile);
        
        try {
            const stateJson = JSON.stringify(state);
            console.log(`Attempting to write state with ${state.taskHistory?.length || 0} tasks`);
            
            // D'abord lister les clés existantes pour diagnostic
            const existingCheck = promisify(db.all.bind(db));
            const allRooKeys = await existingCheck("SELECT key FROM ItemTable WHERE lower(key) LIKE '%roo%'") as { key: string }[];
            console.log(`Found ${allRooKeys.length} Roo-related keys:`, allRooKeys.map(r => r.key));
            
            // Vérifier la clé exacte
            const exactCheck = promisify(db.get.bind(db));
            const existingRow = await exactCheck("SELECT key FROM ItemTable WHERE key = 'RooVeterinaryInc.roo-cline'") as { key: string } | undefined;
            
            if (existingRow) {
                console.log('Key exists, performing UPDATE...');
                // La clé existe, faire un UPDATE
                await new Promise<void>((resolve, reject) => {
                    db.run(
                        "UPDATE ItemTable SET value = ? WHERE key = 'RooVeterinaryInc.roo-cline'",
                        [stateJson],
                        function(err) {
                            if (err) {
                                console.error('UPDATE failed:', err);
                                reject(err);
                            } else {
                                console.log(`UPDATE successful: ${this.changes} rows affected`);
                                if (this.changes === 0) {
                                    console.warn('UPDATE affected 0 rows - this is unexpected!');
                                }
                                resolve();
                            }
                        }
                    );
                });
            } else {
                console.log('Key does not exist, performing INSERT...');
                // La clé n'existe pas, faire un INSERT
                await new Promise<void>((resolve, reject) => {
                    db.run(
                        "INSERT INTO ItemTable (key, value) VALUES ('RooVeterinaryInc.roo-cline', ?)",
                        [stateJson],
                        function(err) {
                            if (err) {
                                console.error('INSERT failed:', err);
                                reject(err);
                            } else {
                                console.log(`INSERT successful: ${this.changes} rows affected`);
                                resolve();
                            }
                        }
                    );
                });
            }
            
            // Vérifier que les données ont été écrites
            const verifyCheck = await exactCheck("SELECT LENGTH(value) as len FROM ItemTable WHERE key = 'RooVeterinaryInc.roo-cline'") as { len: number } | undefined;
            if (verifyCheck) {
                console.log(`Verification: State data length is ${verifyCheck.len} bytes`);
            } else {
                console.error('Verification failed: No data found after write!');
            }
            
            console.log(`VS Code global state write operation completed: ${stateFile}`);
        } finally {
            await closeDatabase(db);
        }
    } catch (error) {
        console.error('Error writing VS Code global state:', error);
        throw error;
    }
}


/**
 * Analyse l'état global VS Code pour diagnostic (fonction interne)
 */
async function analyzeVSCodeGlobalStateInternal(): Promise<{
    stateFile: string;
    taskHistorySize: number;
    workspaces: { workspace: string; count: number }[];
    sampleTasks: HistoryItem[];
}> {
    try {
        const stateFile = await findVSCodeGlobalStateFile();
        const state = await readVSCodeGlobalState();
        
        const result = {
            stateFile,
            taskHistorySize: 0,
            workspaces: [] as { workspace: string; count: number }[],
            sampleTasks: [] as HistoryItem[]
        };
        
        if (state.taskHistory && Array.isArray(state.taskHistory)) {
            result.taskHistorySize = state.taskHistory.length;
            
            // Compte les workspaces
            const workspaceCount: { [key: string]: number } = {};
            for (const task of state.taskHistory) {
                if (task.workspace) {
                    workspaceCount[task.workspace] = (workspaceCount[task.workspace] || 0) + 1;
                }
            }
            
            result.workspaces = Object.entries(workspaceCount)
                .map(([workspace, count]) => ({ workspace, count }))
                .sort((a, b) => b.count - a.count);
            
            // Échantillon des premières tâches
            result.sampleTasks = state.taskHistory.slice(0, 5);
        }
        
        return result;
    } catch (error) {
        throw new Error(`Error analyzing VS Code global state: ${error}`);
    }
}

/**
 * Répare les workspace paths dans le taskHistory (fonction interne)
 */
async function repairVSCodeTaskHistoryInternal(oldWorkspace: string, newWorkspace: string): Promise<{
    totalTasks: number;
    repairedTasks: number;
    errors: string[];
}> {
    const errors: string[] = [];
    let totalTasks = 0;
    let repairedTasks = 0;
    
    try {
        const state = await readVSCodeGlobalState();
        
        if (!state.taskHistory || !Array.isArray(state.taskHistory)) {
            errors.push('No taskHistory found in VS Code global state');
            return { totalTasks, repairedTasks, errors };
        }
        
        totalTasks = state.taskHistory.length;
        console.log(`Found ${totalTasks} tasks in taskHistory`);
        
        // Répare chaque tâche avec l'ancien workspace
        for (const task of state.taskHistory) {
            if (task.workspace && task.workspace.includes(oldWorkspace)) {
                const originalWorkspace = task.workspace;
                task.workspace = task.workspace.replace(oldWorkspace, newWorkspace);
                console.log(`Repaired task ${task.task}: ${originalWorkspace} -> ${task.workspace}`);
                repairedTasks++;
            }
        }
        
        // Sauvegarde l'état modifié
        if (repairedTasks > 0) {
            await writeVSCodeGlobalState(state);
        }
        
        return { totalTasks, repairedTasks, errors };
    } catch (error) {
        errors.push(`Error repairing VS Code task history: ${error}`);
        return { totalTasks, repairedTasks, errors };
    }
}

// Objets MCP exportés
export const analyzeVSCodeGlobalState = {
    name: 'analyze_vscode_global_state',
    description: 'Analyse l\'état global VS Code pour diagnostiquer les tâches orphelines dans le taskHistory cache.',
    inputSchema: {
        type: 'object',
        properties: {},
        required: []
    },
    async execute(): Promise<CallToolResult> {
        try {
            const analysis = await analyzeVSCodeGlobalStateInternal();
            
            let report = `# Analyse de l'état global VS Code\n\n`;
            report += `**Fichier d'état:** ${analysis.stateFile}\n`;
            report += `**Nombre total de tâches:** ${analysis.taskHistorySize}\n\n`;
            
            if (analysis.workspaces.length > 0) {
                report += `## Distribution par workspace:\n`;
                analysis.workspaces.forEach(ws => {
                    report += `- **${ws.workspace}**: ${ws.count} tâche(s)\n`;
                });
                report += `\n`;
            }
            
            if (analysis.sampleTasks.length > 0) {
                report += `## Échantillon de tâches (5 premières):\n`;
                analysis.sampleTasks.forEach((task, index) => {
                    report += `${index + 1}. **${task.task}**\n`;
                    report += `   - Workspace: ${task.workspace}\n`;
                    report += `   - Timestamp: ${new Date(task.ts).toLocaleString()}\n`;
                    if (task.id) report += `   - ID: ${task.id}\n`;
                    report += `\n`;
                });
            }
            
            return { content: [{ type: 'text', text: report }] };
        } catch (error) {
            return {
                content: [{
                    type: 'text',
                    text: `Erreur lors de l'analyse: ${error instanceof Error ? error.message : String(error)}`
                }]
            };
        }
    }
};

export const repairVSCodeTaskHistory = {
    name: 'repair_vscode_task_history',
    description: 'Répare les workspace paths dans le taskHistory cache VS Code pour restaurer les tâches orphelines.',
    inputSchema: {
        type: 'object',
        properties: {
            old_workspace: {
                type: 'string',
                description: 'L\'ancien chemin de workspace à remplacer (ex: "c:/dev/2025-Epita-Intelligence-Symbolique")'
            },
            new_workspace: {
                type: 'string',
                description: 'Le nouveau chemin de workspace (ex: "d:/dev/2025-Epita-Intelligence-Symbolique")'
            }
        },
        required: ['old_workspace', 'new_workspace']
    },
    async execute(args: { old_workspace: string; new_workspace: string }): Promise<CallToolResult> {
        try {
            const result = await repairVSCodeTaskHistoryInternal(args.old_workspace, args.new_workspace);
            
            let report = `# Réparation du taskHistory VS Code\n\n`;
            report += `**Tâches totales:** ${result.totalTasks}\n`;
            report += `**Tâches réparées:** ${result.repairedTasks}\n`;
            report += `**Ancien workspace:** ${args.old_workspace}\n`;
            report += `**Nouveau workspace:** ${args.new_workspace}\n\n`;
            
            if (result.repairedTasks > 0) {
                report += `✅ **Succès !** ${result.repairedTasks} tâche(s) ont été réparées dans le cache VS Code.\n\n`;
                report += `**Prochaines étapes:**\n`;
                report += `1. Redémarrer complètement VS Code\n`;
                report += `2. Vérifier que les tâches réapparaissent dans le panneau Roo\n`;
            } else {
                report += `ℹ️ **Aucune réparation nécessaire.** Aucune tâche trouvée avec l'ancien workspace.\n`;
            }
            
            if (result.errors.length > 0) {
                report += `\n## Erreurs rencontrées:\n`;
                result.errors.forEach(error => {
                    report += `- ${error}\n`;
                });
            }
            
            return { content: [{ type: 'text', text: report }] };
        } catch (error) {
            return {
                content: [{
                    type: 'text',
                    text: `Erreur lors de la réparation: ${error instanceof Error ? error.message : String(error)}`
                }]
            };
        }
    }
};

export const scanOrphanTasks = {
    name: 'scan_orphan_tasks',
    description: 'Scanne les tâches présentes sur le disque mais absentes de l\'index SQLite VS Code et analyse les mappings de workspace.',
    inputSchema: {
        type: 'object',
        properties: {},
        required: []
    },
    async execute(): Promise<CallToolResult> {
        try {
            // Lire l'état VS Code pour obtenir les tâches indexées
            const state = await readVSCodeGlobalState();
            const indexedTasks = new Set<string>();
            
            if (state.taskHistory && Array.isArray(state.taskHistory)) {
                state.taskHistory.forEach(task => {
                    if (task.id) {
                        indexedTasks.add(task.id);
                    }
                });
            }

            // Scanner les répertoires de tâches sur le disque
            const tasksDir = path.join(os.homedir(), 'AppData', 'Roaming', 'Code', 'User', 'globalStorage', 'rooveterinaryinc.roo-cline', 'tasks');
            
            let diskTasks: Array<{id: string, workspace?: string, lastActivity?: Date}> = [];
            
            try {
                const taskFolders = await fs.readdir(tasksDir);
                
                for (const taskId of taskFolders) {
                    const taskPath = path.join(tasksDir, taskId);
                    const stats = await fs.stat(taskPath);
                    
                    if (stats.isDirectory()) {
                        let workspace = undefined;
                        let hasFiles = false;
                        
                        try {
                            // Essayer plusieurs sources pour le workspace
                            const historyFile = path.join(taskPath, 'api_conversation_history.json');
                            const metadataFile = path.join(taskPath, 'task_metadata.json');
                            
                            // Vérifier s'il y a des fichiers dans ce répertoire
                            const files = await fs.readdir(taskPath);
                            hasFiles = files.length > 0;
                            
                            // Essayer api_conversation_history.json en premier
                            try {
                                let historyContent = await fs.readFile(historyFile, 'utf8');
                                
                                // Gérer le BOM UTF-8
                                if (historyContent.charCodeAt(0) === 0xFEFF) {
                                    historyContent = historyContent.slice(1);
                                }
                                
                                // Recherche directe du pattern dans tout le contenu
                                const match = historyContent.match(/Current Workspace Directory \(([^)]+)\)/);
                                if (match && match[1]) {
                                    workspace = match[1];
                                }
                            } catch (historyError) {
                                // Essayer task_metadata.json si api_conversation_history.json n'existe pas
                                try {
                                    const metadataContent = await fs.readFile(metadataFile, 'utf8');
                                    const metadataData = JSON.parse(metadataContent);
                                    
                                    if (metadataData.workspace) {
                                        workspace = metadataData.workspace;
                                    }
                                } catch (metadataError) {
                                    // Pas de workspace trouvé, mais on garde quand même la tâche
                                    workspace = undefined;
                                }
                            }
                        } catch (error) {
                            // En cas d'erreur générale, on garde la tâche sans workspace
                            console.warn(`Error reading task ${taskId}:`, error);
                        }
                        
                        // Ajouter TOUTES les tâches qui ont des fichiers, même sans workspace
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

            // Identifier les tâches orphelines (sur le disque mais pas dans l'index)
            const orphanTasks = diskTasks.filter(task => !indexedTasks.has(task.id));
            
            // Analyser les workspaces des tâches orphelines
            const workspaceStats: { [key: string]: number } = {};
            orphanTasks.forEach(task => {
                if (task.workspace) {
                    workspaceStats[task.workspace] = (workspaceStats[task.workspace] || 0) + 1;
                }
            });

            let report = `# Analyse des tâches orphelines\n\n`;
            report += `**Tâches dans l'index SQLite:** ${indexedTasks.size}\n`;
            report += `**Tâches sur le disque:** ${diskTasks.length}\n`;
            report += `**Tâches orphelines:** ${orphanTasks.length}\n\n`;
            
            if (Object.keys(workspaceStats).length > 0) {
                report += `## Distribution des workspaces des tâches orphelines:\n`;
                Object.entries(workspaceStats)
                    .sort(([,a], [,b]) => b - a)
                    .forEach(([workspace, count]) => {
                        report += `- **${workspace}**: ${count} tâche(s)\n`;
                    });
                report += `\n`;
            }

            if (orphanTasks.length > 0) {
                report += `## Échantillon de tâches orphelines (5 premières):\n`;
                orphanTasks.slice(0, 5).forEach((task, index) => {
                    report += `${index + 1}. **ID:** ${task.id}\n`;
                    report += `   - Workspace: ${task.workspace || 'Non défini'}\n`;
                    report += `   - Dernière activité: ${task.lastActivity?.toLocaleString() || 'Inconnue'}\n`;
                    report += `\n`;
                });
            }

            return { content: [{ type: 'text', text: report }] };
        } catch (error) {
            return {
                content: [{
                    type: 'text',
                    text: `Erreur lors du scan des tâches orphelines: ${error instanceof Error ? error.message : String(error)}`
                }]
            };
        }
    }
};

export const testWorkspaceExtraction = {
    name: 'test_workspace_extraction',
    description: 'Teste l\'extraction du workspace pour une tâche spécifique à des fins de débogage.',
    inputSchema: {
        type: 'object',
        properties: {
            task_id: {
                type: 'string',
                description: 'L\'ID de la tâche à tester'
            }
        },
        required: ['task_id']
    },
    async execute(args: { task_id: string }): Promise<CallToolResult> {
        try {
            const tasksDir = path.join(os.homedir(), 'AppData', 'Roaming', 'Code', 'User', 'globalStorage', 'rooveterinaryinc.roo-cline', 'tasks');
            const taskPath = path.join(tasksDir, args.task_id);
            const historyFile = path.join(taskPath, 'api_conversation_history.json');
            const metadataFile = path.join(taskPath, 'task_metadata.json');
            
            let report = `# Test d'extraction de workspace pour la tâche ${args.task_id}\n\n`;
            
            // Vérifier l'existence du répertoire
            try {
                const stats = await fs.stat(taskPath);
                if (!stats.isDirectory()) {
                    return {
                        content: [{
                            type: 'text',
                            text: `❌ ${taskPath} n'est pas un répertoire`
                        }]
                    };
                }
                report += `✅ Répertoire de tâche trouvé: ${taskPath}\n\n`;
            } catch {
                return {
                    content: [{
                        type: 'text',
                        text: `❌ Répertoire de tâche non trouvé: ${taskPath}`
                    }]
                };
            }
            
            // Test avec api_conversation_history.json
            try {
                let historyContent = await fs.readFile(historyFile, 'utf8');
                
                report += `## Fichier api_conversation_history.json\n`;
                report += `📁 **Chemin:** ${historyFile}\n`;
                report += `📊 **Taille:** ${historyContent.length} caractères\n`;
                
                // Vérifier BOM
                const hasBOM = historyContent.charCodeAt(0) === 0xFEFF;
                report += `🔤 **BOM UTF-8:** ${hasBOM ? 'Présent' : 'Absent'}\n`;
                
                if (hasBOM) {
                    historyContent = historyContent.slice(1);
                    report += `🔧 **Après suppression BOM:** ${historyContent.length} caractères\n`;
                }
                
                // Afficher un extrait du début
                const preview = historyContent.substring(0, 500);
                report += `\n### Extrait du début (500 caractères):\n\`\`\`\n${preview}${historyContent.length > 500 ? '...' : ''}\n\`\`\`\n\n`;
                
                // Test de la regex actuelle
                const currentRegex = /Current Workspace Directory \(([^)]+)\)/;
                const currentMatch = historyContent.match(currentRegex);
                
                report += `### Test regex actuelle: \`/Current Workspace Directory \\(([^)]+)\\)/\`\n`;
                if (currentMatch) {
                    report += `✅ **Match trouvé:** ${currentMatch[1]}\n`;
                } else {
                    report += `❌ **Aucun match trouvé**\n`;
                    
                    // Tests alternatifs
                    const altTests = [
                        { name: 'Current Workspace Directory:', regex: /Current Workspace Directory:\s*([^\n\r]+)/ },
                        { name: 'workspace', regex: /"workspace":\s*"([^"]+)"/ },
                        { name: 'Workspace Directory', regex: /Workspace Directory[:\s]*([^\n\r\)]+)/ },
                        { name: 'Current Workspace', regex: /Current Workspace[:\s]*([^\n\r\)]+)/ }
                    ];
                    
                    report += `\n#### Tests alternatifs:\n`;
                    for (const test of altTests) {
                        const match = historyContent.match(test.regex);
                        if (match) {
                            report += `✅ **${test.name}:** ${match[1]}\n`;
                        } else {
                            report += `❌ **${test.name}:** Aucun match\n`;
                        }
                    }
                }
                
            } catch (historyError) {
                report += `## Fichier api_conversation_history.json\n`;
                report += `❌ **Erreur de lecture:** ${historyError}\n\n`;
            }
            
            // Test avec task_metadata.json
            try {
                const metadataContent = await fs.readFile(metadataFile, 'utf8');
                const metadataData = JSON.parse(metadataContent);
                
                report += `## Fichier task_metadata.json\n`;
                report += `📁 **Chemin:** ${metadataFile}\n`;
                report += `📊 **Taille:** ${metadataContent.length} caractères\n`;
                
                if (metadataData.workspace) {
                    report += `✅ **Workspace trouvé:** ${metadataData.workspace}\n`;
                } else {
                    report += `❌ **Pas de propriété workspace trouvée**\n`;
                    report += `🔍 **Propriétés disponibles:** ${Object.keys(metadataData).join(', ')}\n`;
                }
                
                // Afficher le contenu JSON
                report += `\n### Contenu JSON:\n\`\`\`json\n${JSON.stringify(metadataData, null, 2)}\n\`\`\`\n`;
                
            } catch (metadataError) {
                report += `## Fichier task_metadata.json\n`;
                report += `❌ **Erreur:** ${metadataError}\n\n`;
            }
            
            return { content: [{ type: 'text', text: report }] };
            
        } catch (error) {
            return {
                content: [{
                    type: 'text',
                    text: `Erreur lors du test: ${error instanceof Error ? error.message : String(error)}`
                }]
            };
        }
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
    async execute(args: { workspace_filter?: string, max_tasks?: number, dry_run?: boolean }): Promise<CallToolResult> {
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
                            const historyFile = path.join(taskPath, 'api_conversation_history.json');
                            const metadataFile = path.join(taskPath, 'task_metadata.json');
                            
                            // Vérifier s'il y a des fichiers dans ce répertoire
                            const files = await fs.readdir(taskPath);
                            hasFiles = files.length > 0;
                            
                            // Essayer d'extraire le workspace
                            try {
                                let historyContent = await fs.readFile(historyFile, 'utf8');
                                
                                // Gérer le BOM UTF-8
                                if (historyContent.charCodeAt(0) === 0xFEFF) {
                                    historyContent = historyContent.slice(1);
                                }
                                
                                // Recherche du workspace
                                const match = historyContent.match(/Current Workspace Directory \(([^)]+)\)/);
                                if (match && match[1]) {
                                    workspace = match[1];
                                }
                            } catch (historyError) {
                                // Essayer task_metadata.json comme fallback
                                try {
                                    const metadataContent = await fs.readFile(metadataFile, 'utf8');
                                    const metadataData = JSON.parse(metadataContent);
                                    
                                    if (metadataData.workspace) {
                                        workspace = metadataData.workspace;
                                    }
                                } catch (metadataError) {
                                    // Pas de workspace trouvé
                                }
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
            const failureDetails: string[] = [];
            
            for (const orphanTask of orphanTasks) {
                try {
                    // Normaliser le chemin de workspace pour éviter les problèmes forward/backslash
                    let normalizedWorkspace = orphanTask.workspace || 'unknown';
                    if (normalizedWorkspace !== 'unknown') {
                        // Convertir en backslashes et supprimer les slashes de fin
                        normalizedWorkspace = normalizedWorkspace
                            .replace(/\//g, '\\')
                            .replace(/\\+$/, '');
                    }
                    
                    const historyItem: HistoryItem = {
                        ts: orphanTask.lastActivity ? orphanTask.lastActivity.getTime() : Date.now(),
                        task: orphanTask.id,
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
                failureDetails.slice(0, 10).forEach(detail => {
                    report += `- ${detail}\n`;
                });
                if (failureDetails.length > 10) {
                    report += `... et ${failureDetails.length - 10} autres échecs.\n`;
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

/**
 * Outil de diagnostic SQLite pour examiner la structure de la base
 */
export const diagnoseSQLite = {
    name: 'diagnose_sqlite',
    description: 'Diagnostique la structure de la base SQLite VS Code pour identifier les problèmes.',
    inputSchema: {
        type: 'object',
        properties: {},
        required: []
    },
    async execute(): Promise<CallToolResult> {
        try {
            const stateFile = await findVSCodeGlobalStateFile();
            const db = await openDatabase(stateFile);
            
            let report = `# Diagnostic SQLite VS Code\n\n`;
            report += `**Fichier:** ${stateFile}\n\n`;
            
            try {
                // Lister tous les schémas de tables
                const getTables = promisify(db.all.bind(db));
                const tables = await getTables("SELECT name FROM sqlite_master WHERE type='table'") as { name: string }[];
                
                report += `## Tables disponibles:\n`;
                tables.forEach(table => {
                    report += `- ${table.name}\n`;
                });
                report += `\n`;
                
                // Examiner la structure de ItemTable
                if (tables.some(t => t.name === 'ItemTable')) {
                    const schema = await getTables("PRAGMA table_info(ItemTable)") as any[];
                    report += `## Structure de ItemTable:\n`;
                    schema.forEach(col => {
                        report += `- ${col.name}: ${col.type}\n`;
                    });
                    report += `\n`;
                    
                    // Chercher toutes les clés contenant "roo" (case insensitive)
                    const rooKeys = await getTables("SELECT key FROM ItemTable WHERE lower(key) LIKE '%roo%'") as { key: string }[];
                    report += `## Clés contenant "roo":\n`;
                    if (rooKeys.length > 0) {
                        rooKeys.forEach(row => {
                            report += `- \`${row.key}\`\n`;
                        });
                    } else {
                        report += `*Aucune clé trouvée contenant "roo"*\n`;
                    }
                    report += `\n`;
                    
                    // Lister toutes les clés (premières 20)
                    const allKeys = await getTables("SELECT key FROM ItemTable LIMIT 20") as { key: string }[];
                    report += `## Échantillon des clés existantes (20 premières):\n`;
                    allKeys.forEach(row => {
                        report += `- \`${row.key}\`\n`;
                    });
                    
                    // Compter le total
                    const keyCount = await getTables("SELECT COUNT(*) as count FROM ItemTable") as { count: number }[];
                    report += `\n**Total de clés:** ${keyCount[0].count}\n`;
                }
                
            } finally {
                await closeDatabase(db);
            }
            
            return { content: [{ type: 'text', text: report }] };
            
        } catch (error) {
            return {
                content: [{
                    type: 'text',
                    text: `Erreur lors du diagnostic SQLite : ${error}`
                }]
            };
        }
    }
};