import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { readVSCodeGlobalState } from './vscode-global-state.js';

interface HistoryItem {
    ts: number;
    task: string;
    workspace: string;
    id?: string;
}

/**
 * Examine l'état global Roo pour diagnostiquer le problème de taskHistory
 */
export async function examineRooGlobalState(): Promise<CallToolResult> {
    try {
        console.log('Examining Roo global state...');
        
        // Lire l'état global complet
        const globalState = await readVSCodeGlobalState();
        
        const report: string[] = [];
        report.push('# Examination de l\'état global Roo');
        report.push('');
        
        // Analyser taskHistory
        const taskHistory = globalState.taskHistory as HistoryItem[] | undefined;
        
        if (!taskHistory) {
            report.push('❌ **taskHistory n\'existe pas dans l\'état global**');
            report.push('');
        } else if (!Array.isArray(taskHistory)) {
            report.push(`❌ **taskHistory n'est pas un tableau**: ${typeof taskHistory}`);
            report.push('');
        } else {
            report.push(`✅ **taskHistory trouvé**: ${taskHistory.length} tâche(s)`);
            report.push('');
            
            if (taskHistory.length === 0) {
                report.push('⚠️ taskHistory est un tableau vide');
                report.push('');
            } else {
                // Analyser par workspace
                const byWorkspace: Record<string, number> = {};
                const targetWorkspace = 'd:/dev/2025-Epita-Intelligence-Symbolique';
                let targetWorkspaceTasks = 0;
                
                for (const item of taskHistory) {
                    const workspace = item.workspace || 'unknown';
                    byWorkspace[workspace] = (byWorkspace[workspace] || 0) + 1;
                    
                    if (workspace.toLowerCase() === targetWorkspace.toLowerCase() || 
                        workspace.replace(/\\/g, '/').toLowerCase() === targetWorkspace.toLowerCase()) {
                        targetWorkspaceTasks++;
                    }
                }
                
                report.push('## Distribution par workspace:');
                for (const [workspace, count] of Object.entries(byWorkspace).sort((a, b) => b[1] - a[1])) {
                    const marker = workspace.toLowerCase().includes('2025-epita-intelligence-symbolique') ? '🎯 ' : '  ';
                    report.push(`${marker}**${workspace}**: ${count} tâche(s)`);
                }
                report.push('');
                
                report.push(`## Tâches pour le workspace cible:`);
                report.push(`🎯 **${targetWorkspace}**: ${targetWorkspaceTasks} tâche(s)`);
                report.push('');
                
                // Échantillon des 5 dernières tâches
                report.push('## Échantillon des 5 dernières tâches:');
                const sortedTasks = [...taskHistory].sort((a, b) => (b.ts || 0) - (a.ts || 0));
                for (let i = 0; i < Math.min(5, sortedTasks.length); i++) {
                    const task = sortedTasks[i];
                    const date = task.ts ? new Date(task.ts).toLocaleString('fr-FR') : 'Date inconnue';
                    const preview = task.task ? task.task.substring(0, 100) + (task.task.length > 100 ? '...' : '') : 'Pas de contenu';
                    const workspace = task.workspace || 'Workspace inconnu';
                    
                    report.push(`### ${i + 1}. ${date}`);
                    report.push(`   **Workspace**: ${workspace}`);
                    report.push(`   **ID**: ${task.id || 'Non défini'}`);
                    report.push(`   **Contenu**: ${preview}`);
                    report.push('');
                }
                
                // Analyser la structure des tâches
                report.push('## Analyse de la structure:');
                const sampleTask = taskHistory[0];
                if (sampleTask) {
                    report.push('**Propriétés d\'une tâche type:**');
                    for (const [key, value] of Object.entries(sampleTask)) {
                        const type = typeof value;
                        const valuePreview = type === 'string' ? (value.length > 50 ? value.substring(0, 50) + '...' : value) : JSON.stringify(value);
                        report.push(`  - **${key}** (${type}): ${valuePreview}`);
                    }
                    report.push('');
                }
            }
        }
        
        // Analyser d'autres propriétés potentiellement pertinentes
        report.push('## Autres propriétés de l\'état global:');
        const relevantKeys = Object.keys(globalState).filter(key => 
            key.toLowerCase().includes('task') || 
            key.toLowerCase().includes('history') || 
            key.toLowerCase().includes('workspace')
        ).sort();
        
        if (relevantKeys.length > 0) {
            for (const key of relevantKeys) {
                const value = globalState[key];
                const type = typeof value;
                let valueDesc = '';
                
                if (type === 'object' && value !== null) {
                    if (Array.isArray(value)) {
                        valueDesc = `array[${value.length}]`;
                    } else {
                        valueDesc = `object with ${Object.keys(value).length} keys`;
                    }
                } else {
                    valueDesc = String(value).substring(0, 100);
                    if (String(value).length > 100) valueDesc += '...';
                }
                
                report.push(`  - **${key}** (${type}): ${valueDesc}`);
            }
        } else {
            report.push('  Aucune propriété task/history/workspace trouvée');
        }
        report.push('');
        
        // Taille totale de l'état
        const stateSize = JSON.stringify(globalState).length;
        report.push(`## Métadonnées:`);
        report.push(`  - **Taille totale de l'état**: ${(stateSize / 1024).toFixed(2)} KB`);
        report.push(`  - **Nombre total de propriétés**: ${Object.keys(globalState).length}`);
        
        return {
            content: [{
                type: 'text',
                text: report.join('\n')
            }]
        };
        
    } catch (error) {
        return {
            content: [{
                type: 'text',
                text: `Erreur lors de l'examen de l'état global Roo: ${error instanceof Error ? error.message : String(error)}`
            }],
            isError: true
        };
    }
}

// Export avec métadonnées pour MCP
export const examineRooGlobalStateTool = {
  name: 'examine_roo_global_state',
  description: 'Examine en détail l\'état global Roo (taskHistory) dans le SQLite VS Code pour diagnostiquer les problèmes d\'affichage.',
  inputSchema: {
    type: 'object',
    properties: {},
    required: []
  },
  handler: examineRooGlobalState
};