/**
 * Outil MCP : diagnose_conversation_bom
 * Diagnostique les fichiers de conversation corrompus par un BOM UTF-8
 */

import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Tool } from '../../types/tool-definitions.js';
import { RooStorageDetector } from '../../utils/roo-storage-detector.js';
import { promises as fs } from 'fs';
import path from 'path';

interface DiagnoseConversationBomArgs {
    fix_found?: boolean;
}

export const diagnoseConversationBomTool: Tool<DiagnoseConversationBomArgs> = {
    definition: {
        name: 'diagnose_conversation_bom',
        description: 'Diagnostique les fichiers de conversation corrompus par un BOM UTF-8.',
        inputSchema: {
            type: 'object',
            properties: {
                fix_found: {
                    type: 'boolean',
                    description: 'Si true, répare automatiquement les fichiers trouvés.',
                    default: false
                },
            },
            required: [],
        }
    },
    handler: async (args: DiagnoseConversationBomArgs): Promise<CallToolResult> => {
        const { fix_found = false } = args;

        const locations = await RooStorageDetector.detectStorageLocations();
        if (locations.length === 0) {
            return { content: [{ type: 'text', text: 'Aucun emplacement de stockage Roo trouvé.' }] };
        }

        let totalFiles = 0;
        let corruptedFiles = 0;
        let repairedFiles = 0;
        const corruptedList: string[] = [];

        for (const location of locations) {
            try {
                const tasksPath = path.join(location, 'tasks');
                const conversationDirs = await fs.readdir(tasksPath, { withFileTypes: true });

                for (const convDir of conversationDirs) {
                    if (convDir.isDirectory()) {
                        const apiHistoryPath = path.join(tasksPath, convDir.name, 'api_conversation_history.json');

                        try {
                            await fs.access(apiHistoryPath);
                            totalFiles++;

                            const buffer = await fs.readFile(apiHistoryPath);
                            const hasBOM = buffer.length >= 3 &&
                                         buffer[0] === 0xEF &&
                                         buffer[1] === 0xBB &&
                                         buffer[2] === 0xBF;

                            if (hasBOM) {
                                corruptedFiles++;
                                corruptedList.push(apiHistoryPath);

                                if (fix_found) {
                                    // Réparer automatiquement
                                    // On enlève les 3 premiers octets (BOM)
                                    const cleanBuffer = buffer.subarray(3);
                                    const cleanContent = cleanBuffer.toString('utf-8');

                                    try {
                                        JSON.parse(cleanContent); // Vérifier que c'est du JSON valide
                                        await fs.writeFile(apiHistoryPath, cleanContent, 'utf-8');
                                        repairedFiles++;
                                    } catch (jsonError) {
                                        console.error(`Fichier ${apiHistoryPath} corrompu au-delà du BOM:`, jsonError);
                                    }
                                }
                            }
                        } catch (fileError) {
                            // Fichier n'existe pas ou non accessible, on ignore
                        }
                    }
                }
            } catch (dirError) {
                console.error(`Erreur lors du scan de ${location}/tasks:`, dirError);
            }
        }

        let report = `# Diagnostic BOM des conversations\n\n`;
        report += `**Fichiers analysés:** ${totalFiles}\n`;
        report += `**Fichiers corrompus (BOM):** ${corruptedFiles}\n`;

        if (fix_found && repairedFiles > 0) {
            report += `**Fichiers réparés:** ${repairedFiles}\n\n`;
            report += `✅ Réparation automatique effectuée.\n`;
        } else if (corruptedFiles > 0) {
            report += `\n⚠️  Des fichiers corrompus ont été trouvés. Utilisez 'repair_conversation_bom' pour les réparer.\n`;
        }

        if (corruptedList.length > 0 && corruptedList.length <= 20) {
            report += `\n## Fichiers corrompus détectés:\n`;
            corruptedList.forEach(file => {
                report += `- ${file}\n`;
            });
        } else if (corruptedList.length > 20) {
            report += `\n## Fichiers corrompus détectés (20 premiers):\n`;
            corruptedList.slice(0, 20).forEach(file => {
                report += `- ${file}\n`;
            });
            report += `\n... et ${corruptedList.length - 20} autres fichiers.\n`;
        }

        return { content: [{ type: 'text', text: report }] };
    }
};