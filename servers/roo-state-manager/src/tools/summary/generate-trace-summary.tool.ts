/**
 * MCP Tool pour générer des résumés intelligents de traces de conversation Roo
 * 
 * Ce tool expose le TraceSummaryService via l'interface MCP, permettant
 * la génération de résumés formatés à partir de ConversationSkeletons.
 */

import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { StateManagerError } from '../../types/errors.js';
import { TraceSummaryService, SummaryOptions } from '../../services/TraceSummaryService.js';
import { ExportConfigManager } from '../../services/ExportConfigManager.js';
import { ConversationSkeleton } from '../../types/conversation.js';
import fs from 'fs/promises';
import path from 'path';

/**
 * Arguments du tool generate_trace_summary
 */
export interface GenerateTraceSummaryArgs {
    /** ID de la tâche pour laquelle générer le résumé */
    taskId: string;
    /** Chemin de destination pour sauvegarder le fichier (optionnel) */
    filePath?: string;
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
    /** Index de début (1-based) pour traiter seulement une plage de messages */
    startIndex?: number;
    /** Index de fin (1-based) pour traiter seulement une plage de messages */
    endIndex?: number;
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
            filePath: {
                type: "string",
                description: "Chemin de destination pour sauvegarder le fichier (optionnel). Si non fourni, retourne le contenu."
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
 * Implémentation du handler pour le tool generate_trace_summary
 */
export async function handleGenerateTraceSummary(
    args: GenerateTraceSummaryArgs,
    getConversationSkeleton: (taskId: string) => Promise<ConversationSkeleton | null>
): Promise<string> {
    try {
        // Valider les arguments
        if (!args.taskId) {
            throw new StateManagerError(
                'taskId est requis',
                'VALIDATION_FAILED',
                'GenerateTraceSummaryTool',
                { missingParam: 'taskId' }
            );
        }

        // Récupérer le ConversationSkeleton
        const conversation = await getConversationSkeleton(args.taskId);
        if (!conversation) {
            throw new StateManagerError(
                `Conversation avec taskId ${args.taskId} introuvable`,
                'CONVERSATION_NOT_FOUND',
                'GenerateTraceSummaryTool',
                { taskId: args.taskId }
            );
        }

        // Préparer les options de génération
        const summaryOptions: SummaryOptions = {
            detailLevel: args.detailLevel || 'Full',
            outputFormat: args.outputFormat || 'markdown',
            truncationChars: args.truncationChars || 0,
            compactStats: args.compactStats || false,
            includeCss: args.includeCss !== undefined ? args.includeCss : true,
            generateToc: args.generateToc !== undefined ? args.generateToc : true,
            startIndex: args.startIndex,
            endIndex: args.endIndex
        };

        // Initialiser le service avec un ExportConfigManager basic
        // TODO: Intégrer avec le vrai ExportConfigManager du système
        const exportConfigManager = new ExportConfigManager();
        const summaryService = new TraceSummaryService(exportConfigManager);
// Générer le résumé
const result = await summaryService.generateSummary(conversation, summaryOptions);

if (!result.success) {
    throw new StateManagerError(
        `Erreur lors de la génération du résumé: ${result.error}`,
        'SUMMARY_GENERATION_FAILED',
        'GenerateTraceSummaryTool',
        { taskId: args.taskId, error: result.error }
    );
}

// Si filePath est fourni, sauvegarder le fichier
if (args.filePath) {
    try {
        // **CORRECTION CRITIQUE - Résolution intelligente des chemins**
        let absolutePath: string;
        
        if (path.isAbsolute(args.filePath)) {
            // Cas 1: Chemin absolu → utiliser tel quel
            absolutePath = args.filePath;
            console.log(`[DEBUG] Chemin absolu fourni: ${absolutePath}`);
        } else {
            // Cas 2: Chemin relatif → résoudre depuis le workspace de la conversation
            const workspaceDirectory = conversation.metadata?.workspace;
            
            if (workspaceDirectory && workspaceDirectory.trim() !== '') {
                // Résoudre depuis le workspace de la conversation
                absolutePath = path.resolve(workspaceDirectory, args.filePath);
                console.log(`[DEBUG] Chemin relatif résolu depuis workspace:`);
                console.log(`[DEBUG]   - Chemin demandé: ${args.filePath}`);
                console.log(`[DEBUG]   - Workspace: ${workspaceDirectory}`);
                console.log(`[DEBUG]   - Chemin absolu résolu: ${absolutePath}`);
            } else {
                // Cas 3: Chemin relatif mais pas de workspace → utiliser fallback avec message d'avertissement
                absolutePath = path.resolve(args.filePath);
                console.log(`[WARNING] Cette conversation n'a pas de workspace défini. Fichier créé dans: ${absolutePath}`);
            }
        }
        
        // Créer les répertoires parent si nécessaire
        const dirPath = path.dirname(absolutePath);
        console.log(`[DEBUG] Répertoire parent: ${dirPath}`);
        
        await fs.mkdir(dirPath, { recursive: true });
        console.log(`[DEBUG] Répertoire créé ou existe: ${dirPath}`);
        
        // Sauvegarder le contenu
        await fs.writeFile(absolutePath, result.content, 'utf8');
        console.log(`[DEBUG] Fichier écrit avec succès: ${absolutePath}`);
        
        // Vérifier que le fichier existe
        const fileExists = await fs.access(absolutePath).then(() => true).catch(() => false);
        console.log(`[DEBUG] Vérification existence fichier: ${fileExists}`);
        
        // Retourner une confirmation
        return [
            `**Résumé généré avec succès pour la tâche ${args.taskId}**`,
            `**Source des données:** ${conversation.metadata.dataSource || 'Cache des squelettes (tâche orpheline)'}`,
            `**Chemin de fichier demandé:** ${args.filePath}`,
            `**Chemin absolu résolu:** ${absolutePath}`,
            `**Fichier sauvegardé:** ${fileExists ? '✅ OUI' : '❌ NON'}`,
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
            `**Format:** ${summaryOptions.outputFormat}`
        ].filter(line => line !== '').join('\n');
        
    } catch (writeError) {
        throw new StateManagerError(
            `Erreur lors de l'écriture du fichier ${args.filePath}: ${writeError}`,
            'FILE_WRITE_FAILED',
            'GenerateTraceSummaryTool',
            { filePath: args.filePath, error: String(writeError) }
        );
    }
}

// Préparer la réponse avec métadonnées (cas où pas de filePath)
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
        if (error instanceof StateManagerError) {
            throw error;
        }
        const errorMessage = error instanceof Error ? error.message : 'Erreur inconnue';
        throw new StateManagerError(
            `Génération de résumé échouée: ${errorMessage}`,
            'SUMMARY_FAILED',
            'GenerateTraceSummaryTool',
            { taskId: args.taskId, originalError: errorMessage }
        );
    }
}