/**
 * MCP Tool pour générer des résumés intelligents de grappes de tâches Roo
 * 
 * Ce tool expose les fonctionnalités cluster du TraceSummaryService via l'interface MCP,
 * permettant la génération de résumés agrégés pour des groupes de tâches liées.
 */

import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { TraceSummaryService } from '../../services/TraceSummaryService.js';
import { ExportConfigManager } from '../../services/ExportConfigManager.js';
import { ConversationSkeleton, ClusterSummaryOptions } from '../../types/conversation.js';

/**
 * Arguments du tool generate_cluster_summary
 */
interface GenerateClusterSummaryArgs {
    /** ID de la tâche racine de la grappe */
    rootTaskId: string;
    /** Liste des IDs des tâches enfantes (optionnel, peut être auto-détecté) */
    childTaskIds?: string[];
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
    /** Mode de clustering */
    clusterMode?: 'aggregated' | 'detailed' | 'comparative';
    /** Inclure les statistiques de grappe */
    includeClusterStats?: boolean;
    /** Activer l'analyse cross-task */
    crossTaskAnalysis?: boolean;
    /** Profondeur maximale de grappe */
    maxClusterDepth?: number;
    /** Critère de tri des tâches */
    clusterSortBy?: 'chronological' | 'size' | 'activity' | 'alphabetical';
    /** Inclure la timeline de grappe */
    includeClusterTimeline?: boolean;
    /** Troncature spécifique aux grappes */
    clusterTruncationChars?: number;
    /** Montrer les relations entre tâches */
    showTaskRelationships?: boolean;
    /** Index de début (1-based) pour traiter seulement une plage de messages */
    startIndex?: number;
    /** Index de fin (1-based) pour traiter seulement une plage de messages */
    endIndex?: number;
}

/**
 * Définition du tool MCP
 */
export const generateClusterSummaryTool: Tool = {
    name: "generate_cluster_summary",
    description: "Génère un résumé intelligent et formaté d'une grappe (groupe) de tâches Roo liées",
    inputSchema: {
        type: "object",
        properties: {
            rootTaskId: {
                type: "string",
                description: "L'ID de la tâche racine (parent principal) de la grappe"
            },
            childTaskIds: {
                type: "array",
                items: { type: "string" },
                description: "Liste des IDs des tâches enfantes (si non fourni, sera auto-détecté via parentTaskId)"
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
            clusterMode: {
                type: "string",
                enum: ["aggregated", "detailed", "comparative"],
                description: "Mode de génération du résumé de grappe (défaut: aggregated)",
                default: "aggregated"
            },
            includeClusterStats: {
                type: "boolean",
                description: "Inclure les statistiques spécifiques aux grappes",
                default: true
            },
            crossTaskAnalysis: {
                type: "boolean",
                description: "Activer l'analyse des patterns croisés entre tâches",
                default: false
            },
            maxClusterDepth: {
                type: "number",
                description: "Profondeur maximale de la hiérarchie de grappe à analyser",
                default: 10
            },
            clusterSortBy: {
                type: "string",
                enum: ["chronological", "size", "activity", "alphabetical"],
                description: "Critère de tri des tâches dans la grappe (défaut: chronological)",
                default: "chronological"
            },
            includeClusterTimeline: {
                type: "boolean",
                description: "Inclure une timeline chronologique de la grappe",
                default: false
            },
            clusterTruncationChars: {
                type: "number",
                description: "Troncature spécifique pour le contenu des tâches dans le mode agrégé",
                default: 0
            },
            showTaskRelationships: {
                type: "boolean",
                description: "Montrer explicitement les relations parent-enfant entre tâches",
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
        required: ["rootTaskId"]
    }
};

/**
 * Implémentation du handler pour le tool generate_cluster_summary
 */
export async function handleGenerateClusterSummary(
    args: GenerateClusterSummaryArgs,
    getConversationSkeleton: (taskId: string) => Promise<ConversationSkeleton | null>,
    findChildTasks?: (rootTaskId: string) => Promise<ConversationSkeleton[]>
): Promise<string> {
    try {
        // Valider les arguments
        if (!args.rootTaskId) {
            throw new Error("rootTaskId est requis");
        }

        // Récupérer la tâche racine
        const rootTask = await getConversationSkeleton(args.rootTaskId);
        if (!rootTask) {
            throw new Error(`Tâche racine avec taskId ${args.rootTaskId} introuvable`);
        }

        // Récupérer les tâches enfantes
        let childTasks: ConversationSkeleton[] = [];
        
        if (args.childTaskIds && args.childTaskIds.length > 0) {
            // Utiliser les IDs fournis explicitement
            for (const childId of args.childTaskIds) {
                const childTask = await getConversationSkeleton(childId);
                if (childTask) {
                    childTasks.push(childTask);
                } else {
                    console.warn(`Tâche enfante ${childId} introuvable, ignorée`);
                }
            }
        } else if (findChildTasks) {
            // Auto-détection via la fonction fournie
            childTasks = await findChildTasks(args.rootTaskId);
        }

        // Préparer les options de génération de grappe
        const clusterOptions: Partial<ClusterSummaryOptions> = {
            // Options héritées des résumés standards
            detailLevel: args.detailLevel || 'Full',
            outputFormat: args.outputFormat || 'markdown',
            truncationChars: args.truncationChars || 0,
            compactStats: args.compactStats || false,
            includeCss: args.includeCss !== undefined ? args.includeCss : true,
            generateToc: args.generateToc !== undefined ? args.generateToc : true,
            
            // Options spécifiques aux grappes
            clusterMode: args.clusterMode || 'aggregated',
            includeClusterStats: args.includeClusterStats !== undefined ? args.includeClusterStats : true,
            crossTaskAnalysis: args.crossTaskAnalysis || false,
            maxClusterDepth: args.maxClusterDepth || 10,
            clusterSortBy: args.clusterSortBy || 'chronological',
            includeClusterTimeline: args.includeClusterTimeline || false,
            clusterTruncationChars: args.clusterTruncationChars || 0,
            showTaskRelationships: args.showTaskRelationships !== undefined ? args.showTaskRelationships : true,
            startIndex: args.startIndex,
            endIndex: args.endIndex
        };

        // Initialiser le service
        const exportConfigManager = new ExportConfigManager();
        const summaryService = new TraceSummaryService(exportConfigManager);

        // Générer le résumé de grappe
        const result = await summaryService.generateClusterSummary(rootTask, childTasks, clusterOptions);

        if (!result.success) {
            throw new Error(`Erreur lors de la génération du résumé de grappe: ${result.error || 'Erreur inconnue'}`);
        }

        // Construction du résultat final avec métadonnées
        const metadata = [
            `<!-- Résumé de grappe généré le ${new Date().toISOString()} -->`,
            `<!-- Tâche racine: ${args.rootTaskId} -->`,
            `<!-- Nombre de tâches: ${result.clusterMetadata.totalTasks} -->`,
            `<!-- Mode: ${result.clusterMetadata.clusterMode} -->`,
            `<!-- Taille: ${result.size} caractères -->`,
            ''
        ].join('\n');

        return metadata + result.content;

    } catch (error) {
        // Gestion d'erreur avec contexte détaillé
        const errorMessage = error instanceof Error ? error.message : 'Erreur inconnue';
        const errorContext = [
            `## ❌ Erreur lors de la génération du résumé de grappe`,
            '',
            `**Tâche racine demandée :** \`${args.rootTaskId}\``,
            `**Tâches enfantes spécifiées :** ${args.childTaskIds ? args.childTaskIds.length : 'Auto-détection'}`,
            `**Mode de grappe :** ${args.clusterMode || 'aggregated'}`,
            '',
            `**Erreur :** ${errorMessage}`,
            '',
            `*Pour plus d'informations, vérifiez que la tâche racine existe et que les relations parent-enfant sont correctement définies via \`parentTaskId\`.*`
        ].join('\n');

        return errorContext;
    }
}

/**
 * Helper pour trouver automatiquement les tâches enfantes d'une tâche racine
 * Cette fonction sera fournie par le serveur principal qui a accès à toutes les tâches
 */
export type FindChildTasksFunction = (rootTaskId: string) => Promise<ConversationSkeleton[]>;