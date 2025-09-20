import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { readVSCodeGlobalState, writeVSCodeGlobalState } from './vscode-global-state.js';

/**
 * Outil pour normaliser les chemins de workspace dans la base de données
 */
export const normalizeWorkspacePaths = {
    name: 'normalize_workspace_paths',
    description: 'Normalise tous les chemins de workspace dans le taskHistory de la base SQLite (remplace \\ par /).',
    inputSchema: {
        type: 'object',
        properties: {},
        required: []
    },
    async handler(): Promise<CallToolResult> {
        try {
            const state = await readVSCodeGlobalState();
            
            if (!state.taskHistory || !Array.isArray(state.taskHistory)) {
                return { content: [{ type: 'text', text: 'Aucun taskHistory trouvé.' }] };
            }

            let modifiedCount = 0;
            const originalPaths = new Set<string>();
            const newPaths = new Set<string>();

            for (const task of state.taskHistory) {
                if (task.workspace && task.workspace.includes('\\')) {
                    originalPaths.add(task.workspace);
                    task.workspace = task.workspace.replace(/\\/g, '/');
                    newPaths.add(task.workspace);
                    modifiedCount++;
                }
            }

            if (modifiedCount > 0) {
                await writeVSCodeGlobalState(state);
                let report = `# Normalisation des chemins de workspace\n\n`;
                report += `✅ **Succès !** ${modifiedCount} tâches ont été mises à jour.\n\n`;
                report += `## Exemples de chemins modifiés:\n`;
                const oldPathsSample = [...originalPaths].slice(0, 5);
                const newPathsSample = [...newPaths].slice(0, 5);
                oldPathsSample.forEach((p, i) => {
                    report += `- \`${p}\` -> \`${newPathsSample[i] || ''}\`\n`;
                });
                return { content: [{ type: 'text', text: report }] };
            } else {
                return { content: [{ type: 'text', text: 'Aucun chemin à normaliser. Tous les chemins utilisent déjà des slashes (/).' }] };
            }

        } catch (error) {
            return {
                content: [{
                    type: 'text',
                    text: `Erreur lors de la normalisation: ${error instanceof Error ? error.message : String(error)}`
                }]
            };
        }
    }
};