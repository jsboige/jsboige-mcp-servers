/**
 * MCP Tool pour exporter des conversations au format JSON
 * 
 * Ce tool expose le TraceSummaryService pour générer des exports JSON
 * avec deux variantes : light (multiple conversations) et full (détail complet).
 */

import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { StateManagerError } from '../../types/errors.js';
import { TraceSummaryService, SummaryOptions } from '../../services/TraceSummaryService.js';
import { ExportConfigManager } from '../../services/ExportConfigManager.js';
import { ConversationSkeleton } from '../../types/conversation.js';
import fs from 'fs/promises';
import path from 'path';

/**
 * Arguments du tool export_conversation_json
 */
interface ExportConversationJsonArgs {
    /** ID de la tâche pour laquelle générer l'export */
    taskId: string;
    /** Chemin de destination pour sauvegarder le fichier (optionnel) */
    filePath?: string;
    /** Variante JSON : light (squelette multiple conversations) ou full (détail complet) */
    jsonVariant?: 'light' | 'full';
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
export const exportConversationJsonTool: Tool = {
    name: "export_conversation_json",
    description: "Exporte une conversation au format JSON avec variantes light ou full",
    inputSchema: {
        type: "object",
        properties: {
            taskId: {
                type: "string",
                description: "L'ID de la tâche pour laquelle générer l'export JSON"
            },
            filePath: {
                type: "string",
                description: "Chemin de destination pour sauvegarder le fichier (optionnel). Si non fourni, retourne le contenu."
            },
            jsonVariant: {
                type: "string",
                enum: ["light", "full"],
                description: "Variante JSON : light (squelette multiple conversations) ou full (détail complet)",
                default: "light"
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
 * Implémentation du handler pour le tool export_conversation_json
 */
export async function handleExportConversationJson(
    args: ExportConversationJsonArgs,
    getConversationSkeleton: (taskId: string) => Promise<ConversationSkeleton | null>
): Promise<string> {
    try {
        // Valider les arguments
        if (!args.taskId) {
            throw new StateManagerError(
                'taskId est requis',
                'VALIDATION_FAILED',
                'ExportConversationJsonTool',
                { missingParam: 'taskId' }
            );
        }

        // Récupérer le ConversationSkeleton
        const conversation = await getConversationSkeleton(args.taskId);
        if (!conversation) {
            throw new StateManagerError(
                `Conversation avec taskId ${args.taskId} introuvable`,
                'CONVERSATION_NOT_FOUND',
                'ExportConversationJsonTool',
                { taskId: args.taskId }
            );
        }

        // Préparer les options de génération
        const summaryOptions: SummaryOptions = {
            detailLevel: 'Full', // Utiliser Full par défaut pour JSON
            outputFormat: 'json',
            jsonVariant: args.jsonVariant || 'light',
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

        // Générer l'export JSON
        const result = await summaryService.generateSummary(conversation, summaryOptions);

        if (!result.success) {
            throw new StateManagerError(
                `Erreur lors de la génération de l'export JSON: ${result.error}`,
                'EXPORT_GENERATION_FAILED',
                'ExportConversationJsonTool',
                { taskId: args.taskId, error: result.error }
            );
        }

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
                    `**Export JSON généré avec succès pour la tâche ${args.taskId}**`,
                    `**Fichier sauvegardé:** ${args.filePath}`,
                    ``,
                    `**Détails de l'export:**`,
                    `- Variante JSON: ${args.jsonVariant || 'light'}`,
                    `- Taille du fichier: ${Math.round(result.content.length / 1024 * 10) / 10} KB`,
                    `- Format: JSON structuré`,
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
                    'ExportConversationJsonTool',
                    { filePath: args.filePath, error: String(writeError) }
                );
            }
        }

        // Préparer la réponse avec métadonnées (cas où pas de filePath)
        const response = [
            `**Export JSON généré avec succès pour la tâche ${args.taskId}**`,
            ``,
            `**Détails de l'export:**`,
            `- Variante JSON: ${args.jsonVariant || 'light'}`,
            `- Taille: ${Math.round(result.content.length / 1024 * 10) / 10} KB`,
            `- Format: JSON structuré`,
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
            `**CONTENU JSON:**`,
            ``,
            '```json',
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
            `Export JSON échoué: ${errorMessage}`,
            'EXPORT_FAILED',
            'ExportConversationJsonTool',
            { taskId: args.taskId, originalError: errorMessage }
        );
    }
}