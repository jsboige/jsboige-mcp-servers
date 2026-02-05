/**
 * MCP Tool unifié pour les opérations de résumé et synthèse RooSync
 *
 * CONS-12: Consolidation Summary 3→1
 * - Remplace: generate_trace_summary, generate_cluster_summary, get_conversation_synthesis
 * - Approche: Type-based action dispatcher
 *
 * Ce tool expose toutes les fonctionnalités de résumé via une interface unifiée
 * avec dispatch basé sur le paramètre `type`.
 *
 * @version 1.0.0
 * @author CONS-12 Implementation
 */

import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { StateManagerError } from '../../types/errors.js';
import { ConversationSkeleton } from '../../types/conversation.js';
import * as path from 'path';

// Import des handlers existants
import {
    handleGenerateTraceSummary,
    GenerateTraceSummaryArgs
} from './generate-trace-summary.tool.js';
import {
    handleGenerateClusterSummary,
    GenerateClusterSummaryArgs
} from './generate-cluster-summary.tool.js';
import {
    handleGetConversationSynthesis,
    GetConversationSynthesisArgs
} from './get-conversation-synthesis.tool.js';

// Import des détecteurs de stockage (Roo + Claude)
import { RooStorageDetector } from '../../utils/roo-storage-detector.js';
import { ClaudeStorageDetector } from '../../utils/claude-storage-detector.js';

/**
 * Arguments du tool roosync_summarize unifié
 * Combine tous les paramètres possibles des 3 outils originaux
 */
export interface RooSyncSummarizeArgs {
    /** Type d'opération de résumé */
    type: 'trace' | 'cluster' | 'synthesis';

    /** ID de la tâche (requis pour tous les types) */
    taskId: string;

    /** Source des conversations : 'roo' (défaut) ou 'claude' */
    source?: 'roo' | 'claude';

    /** Chemin optionnel pour sauvegarder le fichier */
    filePath?: string;

    /** Format de sortie (markdown/html pour trace/cluster, json/markdown pour synthesis) */
    outputFormat?: 'markdown' | 'html' | 'json';

    // ===== Options communes trace/cluster =====

    /** Niveau de détail du résumé */
    detailLevel?: 'Full' | 'NoTools' | 'NoResults' | 'Messages' | 'Summary' | 'UserOnly';

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

    // ===== Options spécifiques cluster =====

    /** Liste des IDs des tâches enfantes (optionnel, peut être auto-détecté) */
    childTaskIds?: string[];

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
}

/**
 * Définition du tool MCP roosync_summarize
 */
export const roosyncSummarizeTool: Tool = {
    name: "roosync_summarize",
    description: "Outil unifié pour générer des résumés et synthèses de conversations (trace, cluster, synthesis) - Supporte Roo et Claude Code",
    inputSchema: {
        type: "object",
        properties: {
            type: {
                type: "string",
                enum: ["trace", "cluster", "synthesis"],
                description: "Type d'opération: 'trace' (résumé simple), 'cluster' (grappe de tâches), 'synthesis' (synthèse LLM)"
            },
            taskId: {
                type: "string",
                description: "ID de la tâche (ou tâche racine pour cluster)"
            },
            source: {
                type: "string",
                enum: ["roo", "claude"],
                description: "Source des conversations : 'roo' (Roo Code, défaut) ou 'claude' (Claude Code)",
                default: "roo"
            },
            filePath: {
                type: "string",
                description: "Chemin optionnel pour sauvegarder le fichier (si omis, retourne le contenu)"
            },
            outputFormat: {
                type: "string",
                enum: ["markdown", "html", "json"],
                description: "Format de sortie (markdown/html pour trace/cluster, json/markdown pour synthesis)",
                default: "markdown"
            },

            // Options communes trace/cluster
            detailLevel: {
                type: "string",
                enum: ["Full", "NoTools", "NoResults", "Messages", "Summary", "UserOnly"],
                description: "Niveau de détail du résumé (défaut: Full)",
                default: "Full"
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
                description: "Index de début (1-based) pour traiter seulement une plage de messages",
                minimum: 1
            },
            endIndex: {
                type: "number",
                description: "Index de fin (1-based) pour traiter seulement une plage de messages",
                minimum: 1
            },

            // Options spécifiques cluster
            childTaskIds: {
                type: "array",
                items: { type: "string" },
                description: "Liste des IDs des tâches enfantes (si non fourni, sera auto-détecté)"
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
            }
        },
        required: ["type", "taskId"]
    }
};

/**
 * Crée le bon getter de conversation selon la source
 */
function createConversationGetter(
    source: 'roo' | 'claude'
): (taskId: string) => Promise<ConversationSkeleton | null> {
    return async (taskId: string) => {
        if (source === 'claude') {
            // Pour Claude, on cherche dans les projets Claude
            const locations = await ClaudeStorageDetector.detectStorageLocations();

            for (const location of locations) {
                const skeleton = await ClaudeStorageDetector.analyzeConversation(taskId, location.projectPath);
                if (skeleton) {
                    return skeleton;
                }
            }
            return null;
        } else {
            // Pour Roo (défaut), on utilise le cache Roo existant
            // Note: Cette implémentation nécessite le state.conversationCache
            // qui sera injecté depuis l'extérieur
            throw new Error('Roo source requires external cache injection');
        }
    };
}

/**
 * Crée le bon finder de tâches enfantes selon la source
 */
function createChildTasksFinder(
    source: 'roo' | 'claude'
): (rootTaskId: string) => Promise<ConversationSkeleton[]> {
    return async (rootTaskId: string) => {
        if (source === 'claude') {
            // Pour Claude, chercher les tâches avec le même parentTaskId
            const locations = await ClaudeStorageDetector.detectStorageLocations();
            const allTasks: ConversationSkeleton[] = [];

            for (const location of locations) {
                const projects = await ClaudeStorageDetector.listProjects(location.path);

                for (const projectName of projects) {
                    const projectPath = path.join(location.path, projectName);
                    try {
                        // Lire tous les fichiers JSONL et extraire les parentTaskIds
                        const skeleton = await ClaudeStorageDetector.analyzeConversation('dummy', projectPath);
                        if (skeleton?.metadata.dataSource) {
                            // Extraire le vrai taskId depuis les fichiers
                            const entries = await ClaudeStorageDetector.detectStorageLocations();
                            // Note: Cette implémentation est simplifiée
                            // Une version complète nécessiterait plus de logique
                        }
                    } catch {
                        // Ignorer les erreurs
                    }
                }
            }

            return allTasks.filter(t => t.parentTaskId === rootTaskId);
        } else {
            // Pour Roo, logique existante
            throw new Error('Roo source requires external cache injection');
        }
    };
}

/**
 * Handler unifié pour roosync_summarize
 * Dispatche vers le handler approprié selon le type et la source
 */
export async function handleRooSyncSummarize(
    args: RooSyncSummarizeArgs,
    getConversationSkeleton?: (taskId: string) => Promise<ConversationSkeleton | null>,
    findChildTasks?: (rootTaskId: string) => Promise<ConversationSkeleton[]>
): Promise<string> {
    try {
        // Validation des arguments communs
        if (!args.type) {
            throw new StateManagerError(
                'type est requis',
                'VALIDATION_FAILED',
                'RooSyncSummarizeTool',
                { missingParam: 'type' }
            );
        }

        if (!args.taskId) {
            throw new StateManagerError(
                'taskId est requis',
                'VALIDATION_FAILED',
                'RooSyncSummarizeTool',
                { missingParam: 'taskId' }
            );
        }

        // Déterminer la source (défaut: roo)
        const source = args.source || 'roo';

        // Créer les getters appropriés selon la source
        let actualGetConversationSkeleton: (taskId: string) => Promise<ConversationSkeleton | null>;
        let actualFindChildTasks: ((rootTaskId: string) => Promise<ConversationSkeleton[]>) | undefined;

        if (source === 'claude') {
            // Pour Claude, créer un getter spécial
            actualGetConversationSkeleton = createConversationGetter('claude');
            actualFindChildTasks = createChildTasksFinder('claude');
        } else {
            // Pour Roo, utiliser les getters injectés
            if (!getConversationSkeleton) {
                throw new StateManagerError(
                    'getConversationSkeleton est requis pour source=roo',
                    'VALIDATION_FAILED',
                    'RooSyncSummarizeTool',
                    { source: 'roo' }
                );
            }
            actualGetConversationSkeleton = getConversationSkeleton;
            actualFindChildTasks = findChildTasks;
        }

        // Dispatch basé sur le type
        switch (args.type) {
            case 'trace':
                return await dispatchTraceHandler(args, actualGetConversationSkeleton);

            case 'cluster':
                return await dispatchClusterHandler(args, actualGetConversationSkeleton, actualFindChildTasks);

            case 'synthesis':
                return await dispatchSynthesisHandler(args, actualGetConversationSkeleton);

            default:
                throw new StateManagerError(
                    `Type d'opération non supporté: ${args.type}`,
                    'INVALID_TYPE',
                    'RooSyncSummarizeTool',
                    { type: args.type, supportedTypes: ['trace', 'cluster', 'synthesis'] }
                );
        }

    } catch (error) {
        if (error instanceof StateManagerError) {
            throw error;
        }
        const errorMessage = error instanceof Error ? error.message : 'Erreur inconnue';
        throw new StateManagerError(
            `Erreur lors du résumé/synthèse: ${errorMessage}`,
            'SUMMARIZE_FAILED',
            'RooSyncSummarizeTool',
            { type: args.type, taskId: args.taskId, originalError: errorMessage }
        );
    }
}

/**
 * Dispatch vers handleGenerateTraceSummary
 */
async function dispatchTraceHandler(
    args: RooSyncSummarizeArgs,
    getConversationSkeleton: (taskId: string) => Promise<ConversationSkeleton | null>
): Promise<string> {
    // Convertir les args unifiés vers les args spécifiques trace
    const traceArgs: Partial<GenerateTraceSummaryArgs> = {
        taskId: args.taskId,
        filePath: args.filePath,
        detailLevel: args.detailLevel,
        outputFormat: args.outputFormat as 'markdown' | 'html' | undefined,
        truncationChars: args.truncationChars,
        compactStats: args.compactStats,
        includeCss: args.includeCss,
        generateToc: args.generateToc,
        startIndex: args.startIndex,
        endIndex: args.endIndex
    };

    return await handleGenerateTraceSummary(
        traceArgs as GenerateTraceSummaryArgs,
        getConversationSkeleton
    );
}

/**
 * Dispatch vers handleGenerateClusterSummary
 */
async function dispatchClusterHandler(
    args: RooSyncSummarizeArgs,
    getConversationSkeleton: (taskId: string) => Promise<ConversationSkeleton | null>,
    findChildTasks?: (rootTaskId: string) => Promise<ConversationSkeleton[]>
): Promise<string> {
    // Convertir les args unifiés vers les args spécifiques cluster
    const clusterArgs: Partial<GenerateClusterSummaryArgs> = {
        rootTaskId: args.taskId,
        childTaskIds: args.childTaskIds,
        detailLevel: args.detailLevel,
        outputFormat: args.outputFormat as 'markdown' | 'html' | undefined,
        truncationChars: args.truncationChars,
        compactStats: args.compactStats,
        includeCss: args.includeCss,
        generateToc: args.generateToc,
        clusterMode: args.clusterMode,
        includeClusterStats: args.includeClusterStats,
        crossTaskAnalysis: args.crossTaskAnalysis,
        maxClusterDepth: args.maxClusterDepth,
        clusterSortBy: args.clusterSortBy,
        includeClusterTimeline: args.includeClusterTimeline,
        clusterTruncationChars: args.clusterTruncationChars,
        showTaskRelationships: args.showTaskRelationships,
        startIndex: args.startIndex,
        endIndex: args.endIndex
    };

    return await handleGenerateClusterSummary(
        clusterArgs as GenerateClusterSummaryArgs,
        getConversationSkeleton,
        findChildTasks
    );
}

/**
 * Dispatch vers handleGetConversationSynthesis
 */
async function dispatchSynthesisHandler(
    args: RooSyncSummarizeArgs,
    getConversationSkeleton: (taskId: string) => Promise<ConversationSkeleton | null>
): Promise<string> {
    // Convertir les args unifiés vers les args spécifiques synthesis
    const synthesisArgs: Partial<GetConversationSynthesisArgs> = {
        taskId: args.taskId,
        filePath: args.filePath,
        outputFormat: args.outputFormat as 'json' | 'markdown' | undefined
    };

    const result = await handleGetConversationSynthesis(
        synthesisArgs as GetConversationSynthesisArgs,
        getConversationSkeleton
    );

    // handleGetConversationSynthesis peut retourner string ou ConversationAnalysis
    // On convertit en string si nécessaire
    if (typeof result === 'string') {
        return result;
    } else {
        // Si c'est un objet, on le sérialise en JSON
        return JSON.stringify(result, null, 2);
    }
}
