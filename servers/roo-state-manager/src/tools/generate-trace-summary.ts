/**
 * MCP Tool pour générer des résumés intelligents de traces de conversation Roo
 * 
 * Ce tool expose le TraceSummaryService via l'interface MCP, permettant
 * la génération de résumés formatés à partir de ConversationSkeletons.
 */

import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { TraceSummaryService, SummaryOptions } from '../services/TraceSummaryService.js';
import { ExportConfigManager } from '../services/ExportConfigManager.js';
import { ConversationSkeleton } from '../types/conversation.js';

/**
 * Arguments du tool generate_trace_summary
 */
interface GenerateTraceSummaryArgs {
    /** ID de la tâche pour laquelle générer le résumé */
    taskId: string;
    /** Niveau de détail du résumé */
    detailLevel?: 'Full' | 'NoTools' | 'NoResults' | 'Messages' | 'Summary' | 'UserOnly';
    /** Format de sortie */
    outputFormat?: 'markdown' | 'html';
    /** Nombre max de caractères avant troncature (0 = pas de troncature) */
    truncationChars?: number;
    /** Utiliser un format compact pour les statistiques */
    compactStats?: boolean;
    /** Inclure le CSS embarqué */
    includeCss?: boolean;
    /** Générer la table des matières */
    generateToc?: boolean;
}

/**
 * Définition du tool MCP
 */
export const generateTraceSummaryTool: Tool = {
    name: "generate_trace_summary",
    description: "Génère un résumé intelligent et formaté d'une trace de conversation Roo",
    inputSchema: {
        type: "object",
        properties: {
            taskId: {
                type: "string",
                description: "L'ID de la tâche pour laquelle générer le résumé"
            },
            detailLevel: {
                type: "string",
                enum: ["Full", "NoTools", "NoResults", "Messages", "Summary", "UserOnly"],
                description: "Niveau de détail du résumé (défaut: Full)",
                default: "Full"
            },
            outputFormat: {
                type: "string",
                enum: ["markdown", "html"],
                description: "Format de sortie (défaut: markdown)",
                default: "markdown"
            },
            truncationChars: {
                type: "number",
                description: "Nombre max de caractères avant troncature (0 = pas de troncature)",
                default: 0
            },
            compactStats: {
                type: "boolean",
                description: "Utiliser un format compact pour les statistiques",
                default: false
            },
            includeCss: {
                type: "boolean",
                description: "Inclure le CSS embarqué pour le styling",
                default: true
            },
            generateToc: {
                type: "boolean",
                description: "Générer la table des matières interactive",
                default: true
            }
        },
        required: ["taskId"]
    }
};

/**
 * Implémentation du handler pour le tool generate_trace_summary
 */
export async function handleGenerateTraceSummary(
    args: GenerateTraceSummaryArgs,
    getConversationSkeleton: (taskId: string) => Promise<ConversationSkeleton | null>
): Promise<string> {
    try {
        // Valider les arguments
        if (!args.taskId) {
            throw new Error("taskId est requis");
        }

        // Récupérer le ConversationSkeleton
        const conversation = await getConversationSkeleton(args.taskId);
        if (!conversation) {
            throw new Error(`Conversation avec taskId ${args.taskId} introuvable`);
        }

        // Préparer les options de génération
        const summaryOptions: SummaryOptions = {
            detailLevel: args.detailLevel || 'Full',
            outputFormat: args.outputFormat || 'markdown',
            truncationChars: args.truncationChars || 0,
            compactStats: args.compactStats || false,
            includeCss: args.includeCss !== undefined ? args.includeCss : true,
            generateToc: args.generateToc !== undefined ? args.generateToc : true
        };

        // Initialiser le service avec un ExportConfigManager basic
        // TODO: Intégrer avec le vrai ExportConfigManager du système
        const exportConfigManager = new ExportConfigManager();
        const summaryService = new TraceSummaryService(exportConfigManager);

        // Générer le résumé
        const result = await summaryService.generateSummary(conversation, summaryOptions);

        if (!result.success) {
            throw new Error(`Erreur lors de la génération du résumé: ${result.error}`);
        }

        // Préparer la réponse avec métadonnées
        const response = [
            `**Résumé généré avec succès pour la tâche ${args.taskId}**`,
            ``,
            `**Statistiques:**`,
            `- Total sections: ${result.statistics.totalSections}`,
            `- Messages utilisateur: ${result.statistics.userMessages}`,
            `- Réponses assistant: ${result.statistics.assistantMessages}`,
            `- Résultats d'outils: ${result.statistics.toolResults}`,
            `- Taille totale: ${Math.round(result.statistics.totalContentSize / 1024 * 10) / 10} KB`,
            result.statistics.compressionRatio ? `- Ratio de compression: ${result.statistics.compressionRatio}x` : '',
            ``,
            `**Mode de génération:** ${summaryOptions.detailLevel}`,
            `**Format:** ${summaryOptions.outputFormat}`,
            ``,
            `---`,
            ``,
            result.content
        ].filter(line => line !== '').join('\n');

        return response;

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Erreur inconnue';
        throw new Error(`Génération de résumé échouée: ${errorMessage}`);
    }
}