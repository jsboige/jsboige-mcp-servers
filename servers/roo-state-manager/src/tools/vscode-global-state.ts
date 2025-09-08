import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

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
    const rooExtensionDir = path.join(userDataDir, 'rooveterinaryinc.roo-cline');
    
    // Le state global est généralement dans un fichier state.vscdb ou similaire
    const possibleFiles = [
        path.join(rooExtensionDir, 'state.vscdb'),
        path.join(rooExtensionDir, 'storage.json'),
        path.join(rooExtensionDir, 'global.json')
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
        const files = await fs.readdir(rooExtensionDir);
        for (const file of files) {
            if (file.endsWith('.vscdb') || file.endsWith('.json')) {
                const fullPath = path.join(rooExtensionDir, file);
                const stats = await fs.stat(fullPath);
                if (stats.isFile() && stats.size > 0) {
                    return fullPath;
                }
            }
        }
    } catch (error) {
        throw new Error(`Cannot find VS Code global storage directory: ${rooExtensionDir}`);
    }

    throw new Error('No VS Code global state file found for Roo extension');
}

/**
 * Lit l'état global VS Code (fichier binaire vscdb ou JSON)
 */
export async function readVSCodeGlobalState(): Promise<VSCodeGlobalState> {
    try {
        const stateFile = await findVSCodeGlobalStateFile();
        console.log(`Reading VS Code global state from: ${stateFile}`);
        
        const content = await fs.readFile(stateFile, 'utf8');
        
        // Si c'est un fichier JSON direct
        if (stateFile.endsWith('.json')) {
            return JSON.parse(content);
        }
        
        // Si c'est un fichier .vscdb, il peut contenir du JSON ou être binaire
        try {
            return JSON.parse(content);
        } catch {
            // Le fichier vscdb peut être binaire, on essaie de trouver du JSON dedans
            const jsonMatch = content.match(/\{.*"taskHistory".*\}/s);
            if (jsonMatch) {
                return JSON.parse(jsonMatch[0]);
            }
            throw new Error('Cannot parse VS Code global state file');
        }
    } catch (error) {
        console.error('Error reading VS Code global state:', error);
        return {};
    }
}

/**
 * Écrit l'état global VS Code
 */
export async function writeVSCodeGlobalState(state: VSCodeGlobalState): Promise<void> {
    try {
        const stateFile = await findVSCodeGlobalStateFile();
        const backup = `${stateFile}.backup.${Date.now()}`;
        
        // Sauvegarde de sécurité
        try {
            await fs.copyFile(stateFile, backup);
            console.log(`Backup created: ${backup}`);
        } catch (error) {
            console.warn('Could not create backup:', error);
        }
        
        // Écriture du nouveau state
        const content = JSON.stringify(state, null, 2);
        await fs.writeFile(stateFile, content, 'utf8');
        console.log(`VS Code global state updated: ${stateFile}`);
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