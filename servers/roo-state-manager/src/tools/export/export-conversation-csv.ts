/**
 * MCP Tool pour exporter des conversations au format CSV
 * 
 * Ce tool expose le TraceSummaryService pour générer des exports CSV
 * avec trois variantes : conversations, messages, et tools.
 */

import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { StateManagerError } from '../../types/errors.js';
import { TraceSummaryService, SummaryOptions } from '../../services/TraceSummaryService.js';
import { ExportConfigManager } from '../../services/ExportConfigManager.js';
import { ConversationSkeleton } from '../../types/conversation.js';
import fs from 'fs/promises';
import path from 'path';

/**
 * Arguments du tool export_conversation_csv
 */
interface ExportConversationCsvArgs {
    /** ID de la tâche pour laquelle générer l'export */
    taskId: string;
    /** Chemin de destination pour sauvegarder le fichier (optionnel) */
    filePath?: string;
    /** Variante CSV : conversations (vue table de conversations), messages (détail messages), ou tools (appels d'outils) */
    csvVariant?: 'conversations' | 'messages' | 'tools';
    /** Nombre max de caractères avant troncature (0 = pas de troncature) */
    truncationChars?: number;
    /** Index de début (1-based) pour traiter seulement une plage de messages */
    startIndex?: number;
    /** Index de fin (1-based) pour traiter seulement une plage de messages */
    endIndex?: number;
}

/**
 * Définition du tool MCP
 */
export const exportConversationCsvTool: Tool = {
    name: "export_conversation_csv",
    description: "Exporte une conversation au format CSV avec variantes conversations, messages, ou tools",
    inputSchema: {
        type: "object",
        properties: {
            taskId: {
                type: "string",
                description: "L'ID de la tâche pour laquelle générer l'export CSV"
            },
            filePath: {
                type: "string",
                description: "Chemin de destination pour sauvegarder le fichier (optionnel). Si non fourni, retourne le contenu."
            },
            csvVariant: {
                type: "string",
                enum: ["conversations", "messages", "tools"],
                description: "Variante CSV : conversations (vue table), messages (détail messages), ou tools (appels d'outils)",
                default: "conversations"
            },
            truncationChars: {
                type: "number",
                description: "Nombre max de caractères avant troncature (0 = pas de troncature)",
                default: 0
            },
            startIndex: {
                type: "number",
                description: "Index de début (1-based) pour traiter seulement une plage de messages (optionnel)",
                minimum: 1
            },
            endIndex: {
                type: "number",
                description: "Index de fin (1-based) pour traiter seulement une plage de messages (optionnel)",
                minimum: 1
            }
        },
        required: ["taskId"]
    }
};

/**
 * Implémentation du handler pour le tool export_conversation_csv
 */
export async function handleExportConversationCsv(
    args: ExportConversationCsvArgs,
    getConversationSkeleton: (taskId: string) => Promise<ConversationSkeleton | null>
): Promise<string> {
    try {
        // Valider les arguments
        if (!args.taskId) {
            throw new StateManagerError(
                'taskId est requis',
                'VALIDATION_FAILED',
                'ExportConversationCsvTool',
                { missingParam: 'taskId' }
            );
        }

        // Récupérer le ConversationSkeleton
        const conversation = await getConversationSkeleton(args.taskId);
        if (!conversation) {
            throw new StateManagerError(
                `Conversation avec taskId ${args.taskId} introuvable`,
                'CONVERSATION_NOT_FOUND',
                'ExportConversationCsvTool',
                { taskId: args.taskId }
            );
        }

        // Préparer les options de génération
        const summaryOptions: SummaryOptions = {
            detailLevel: 'Full', // Utiliser Full par défaut pour CSV
            outputFormat: 'csv',
            csvVariant: args.csvVariant || 'conversations',
            truncationChars: args.truncationChars || 0,
            compactStats: false,
            includeCss: false,
            generateToc: false,
            startIndex: args.startIndex,
            endIndex: args.endIndex
        };

        // Initialiser le service
        const exportConfigManager = new ExportConfigManager();
        const summaryService = new TraceSummaryService(exportConfigManager);

        // Générer l'export CSV
        const result = await summaryService.generateSummary(conversation, summaryOptions);

        if (!result.success) {
            throw new StateManagerError(
                `Erreur lors de la génération de l'export CSV: ${result.error}`,
                'EXPORT_GENERATION_FAILED',
                'ExportConversationCsvTool',
                { taskId: args.taskId, error: result.error }
            );
        }

        // Compter le nombre de lignes dans le CSV
        const csvLines = result.content.split('\n').length;

        // Si filePath est fourni, sauvegarder le fichier
        if (args.filePath) {
            try {
                // Créer les répertoires parent si nécessaire
                const dirPath = path.dirname(args.filePath);
                await fs.mkdir(dirPath, { recursive: true });
                
                // Sauvegarder le contenu
                await fs.writeFile(args.filePath, result.content, 'utf8');
                
                // Retourner une confirmation avec statistiques
                return [
                    `**Export CSV généré avec succès pour la tâche ${args.taskId}**`,
                    `**Fichier sauvegardé:** ${args.filePath}`,
                    ``,
                    `**Détails de l'export:**`,
                    `- Variante CSV: ${args.csvVariant || 'conversations'}`,
                    `- Nombre de lignes: ${csvLines} (incluant l'en-tête)`,
                    `- Taille du fichier: ${Math.round(result.content.length / 1024 * 10) / 10} KB`,
                    `- Format: CSV avec séparateur virgule`,
                    ``,
                    `**Statistiques de la conversation:**`,
                    `- Total sections: ${result.statistics.totalSections}`,
                    `- Messages utilisateur: ${result.statistics.userMessages}`,
                    `- Réponses assistant: ${result.statistics.assistantMessages}`,
                    `- Résultats d'outils: ${result.statistics.toolResults}`,
                    `- Taille totale originale: ${Math.round(result.statistics.totalContentSize / 1024 * 10) / 10} KB`,
                    result.statistics.compressionRatio ? `- Ratio de compression: ${result.statistics.compressionRatio}x` : ''
                ].filter(line => line !== '').join('\n');
                
            } catch (writeError) {
                throw new StateManagerError(
                    `Erreur lors de l'écriture du fichier ${args.filePath}: ${writeError}`,
                    'FILE_WRITE_FAILED',
                    'ExportConversationCsvTool',
                    { filePath: args.filePath, error: String(writeError) }
                );
            }
        }

        // Préparer la réponse avec métadonnées (cas où pas de filePath)
        const response = [
            `**Export CSV généré avec succès pour la tâche ${args.taskId}**`,
            ``,
            `**Détails de l'export:**`,
            `- Variante CSV: ${args.csvVariant || 'conversations'}`,
            `- Nombre de lignes: ${csvLines} (incluant l'en-tête)`,
            `- Taille: ${Math.round(result.content.length / 1024 * 10) / 10} KB`,
            `- Format: CSV avec séparateur virgule`,
            ``,
            `**Statistiques de la conversation:**`,
            `- Total sections: ${result.statistics.totalSections}`,
            `- Messages utilisateur: ${result.statistics.userMessages}`,
            `- Réponses assistant: ${result.statistics.assistantMessages}`,
            `- Résultats d'outils: ${result.statistics.toolResults}`,
            `- Taille totale originale: ${Math.round(result.statistics.totalContentSize / 1024 * 10) / 10} KB`,
            result.statistics.compressionRatio ? `- Ratio de compression: ${result.statistics.compressionRatio}x` : '',
            ``,
            `---`,
            ``,
            `**CONTENU CSV:**`,
            ``,
            '```csv',
            result.content,
            '```'
        ].filter(line => line !== '').join('\n');

        return response;

    } catch (error) {
        if (error instanceof StateManagerError) {
            throw error;
        }
        const errorMessage = error instanceof Error ? error.message : 'Erreur inconnue';
        throw new StateManagerError(
            `Export CSV échoué: ${errorMessage}`,
            'EXPORT_FAILED',
            'ExportConversationCsvTool',
            { taskId: args.taskId, originalError: errorMessage }
        );
    }
}