/**
 * Outil MCP : repair_conversation_bom
 * Répare les fichiers de conversation corrompus par un BOM UTF-8
 */

import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Tool } from '../../types/tool-definitions.js';
import { RooStorageDetector } from '../../utils/roo-storage-detector.js';
import { promises as fs } from 'fs';
import path from 'path';

interface RepairConversationBomArgs {
    dry_run?: boolean;
}

export const repairConversationBomTool: Tool<RepairConversationBomArgs> = {
    definition: {
        name: 'repair_conversation_bom',
        description: 'Répare les fichiers de conversation corrompus par un BOM UTF-8.',
        inputSchema: {
            type: 'object',
            properties: {
                dry_run: {
                    type: 'boolean',
                    description: 'Si true (défaut), simule la réparation sans modifier les fichiers. Passer explicitement dry_run=false pour réparer réellement (#3984).',
                    default: true
                },
            },
            required: [],
        }
    },
    handler: async (args: RepairConversationBomArgs): Promise<CallToolResult> => {
        // #3984: défaut inversé — la simulation est le comportement par défaut,
        // la réparation réelle exige dry_run=false explicite.
        const { dry_run = true } = args;

        const locations = await RooStorageDetector.detectStorageLocations();
        if (locations.length === 0) {
            return { content: [{ type: 'text', text: 'Aucun emplacement de stockage Roo trouvé.' }] };
        }

        let totalFiles = 0;
        let corruptedFiles = 0;
        let repairedFiles = 0;
        let failedRepairs = 0;
        const repairResults: { file: string, status: string, error?: string }[] = [];

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

                                if (dry_run) {
                                    repairResults.push({
                                        file: apiHistoryPath,
                                        status: 'SERAIT_REPARE'
                                    });
                                } else {
                                    // Effectuer la réparation
                                    try {
                                        const cleanBuffer = buffer.subarray(3);
                                        const cleanContent = cleanBuffer.toString('utf-8');

                                        JSON.parse(cleanContent); // Vérifier que c'est du JSON valide
                                        await fs.writeFile(apiHistoryPath, cleanContent, 'utf-8');
                                        repairedFiles++;
                                        repairResults.push({
                                            file: apiHistoryPath,
                                            status: 'REPARE'
                                        });
                                    } catch (repairError) {
                                        failedRepairs++;
                                        repairResults.push({
                                            file: apiHistoryPath,
                                            status: 'ECHEC',
                                            error: repairError instanceof Error ? repairError.message : String(repairError)
                                        });
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

        let report = `# Réparation BOM des conversations\n\n`;
        report += `**Mode:** ${dry_run ? 'Simulation (dry-run)' : 'Réparation réelle'}\n`;
        report += `**Fichiers analysés:** ${totalFiles}\n`;
        report += `**Fichiers corrompus (BOM):** ${corruptedFiles}\n`;

        if (!dry_run) {
            report += `**Fichiers réparés:** ${repairedFiles}\n`;
            report += `**Échecs de réparation:** ${failedRepairs}\n\n`;

            if (repairedFiles > 0) {
                report += `✅ ${repairedFiles} fichier(s) réparé(s) avec succès.\n`;
            }
            if (failedRepairs > 0) {
                report += `❌ ${failedRepairs} échec(s) de réparation (fichiers corrompus au-delà du BOM).\n`;
            }
        } else {
            report += `\n🔍 Simulation terminée. ${corruptedFiles} fichier(s) seraient réparés.\n`;
        }

        if (repairResults.length > 0 && repairResults.length <= 30) {
            report += `\n## Détails des opérations:\n`;
            repairResults.forEach(result => {
                const statusIcon = result.status === 'REPARE' ? '✅' :
                                 result.status === 'SERAIT_REPARE' ? '🔍' : '❌';
                report += `${statusIcon} ${result.file}`;
                if (result.error) {
                    report += ` - Erreur: ${result.error}`;
                }
                report += `\n`;
            });
        } else if (repairResults.length > 30) {
            report += `\n## Détails des opérations (30 premiers résultats):\n`;
            repairResults.slice(0, 30).forEach(result => {
                const statusIcon = result.status === 'REPARE' ? '✅' :
                                 result.status === 'SERAIT_REPARE' ? '🔍' : '❌';
                report += `${statusIcon} ${result.file}\n`;
            });
            report += `\n... et ${repairResults.length - 30} autres résultats.\n`;
        }

        return { content: [{ type: 'text', text: report }] };
    }
};