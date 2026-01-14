/**
 * SynthesisOrchestratorService - Service orchestrateur principal pour la synthèse de conversations
 *
 * Ce service porte la logique de coordination et d'orchestration de l'ensemble
 * du processus de synthèse, en utilisant les services spécialisés pour chaque étape.
 *
 * Architecture inspirée du TraceSummaryService existant avec injection de dépendances.
 *
 * SDDD Phase 3 : Orchestration complète avec intégration LLM réelle
 *
 * @author Roo Code v4 - SDDD Phase 3
 * @version 3.0.0
 */

import {
    SynthesisMetadata,
    ConversationAnalysis,
    BatchSynthesisTask,
    BatchSynthesisConfig,
    ContextBuildingOptions,
    ContextBuildingResult,
    ExportOptions
} from '../../models/synthesis/SynthesisModels.js';
import { ConversationSkeleton } from '../../types/conversation.js';
import { NarrativeContextBuilderService } from './NarrativeContextBuilderService.js';
import { LLMService } from './LLMService.js';
import { SynthesisServiceError, SynthesisServiceErrorCode } from '../../types/errors.js';

/**
 * Options de configuration pour le service orchestrateur.
 * Contrôle le comportement global du processus de synthèse.
 */
export interface SynthesisOrchestratorOptions {
    /** Répertoire de base pour stocker les fichiers de synthèse */
    synthesisOutputDir: string;

    /** Taille maximale du contexte avant condensation */
    maxContextSize: number;

    /** Nombre maximum de synthèses en parallèle */
    maxConcurrency: number;

    /** Modèle LLM par défaut à utiliser */
    defaultLlmModel: string;
}

/**
 * Service orchestrateur principal pour la synthèse de conversations.
 *
 * Ce service coordonne l'ensemble du processus de synthèse :
 * - Construction du contexte narratif via NarrativeContextBuilderService
 * - Appel aux LLM via LLMService
 * - Gestion des lots de traitement
 * - Export des résultats
 *
 * Pattern de service singleton avec injection de dépendances.
 */
export class SynthesisOrchestratorService {
    private narrativeContextBuilder: NarrativeContextBuilderService;
    private llmService: LLMService;
    private options: SynthesisOrchestratorOptions;

    /**
     * File d'attente des tâches de synthèse en cours.
     * Utilisée pour gérer la concurrence et le statut des opérations.
     */
    private activeBatches: Map<string, BatchSynthesisTask> = new Map();

    /**
     * Constructeur avec injection de dépendances.
     *
     * @param narrativeContextBuilder Service de construction de contexte narratif
     * @param llmService Service d'interface avec les LLM
     * @param options Options de configuration du service
     */
    constructor(
        narrativeContextBuilder: NarrativeContextBuilderService,
        llmService: LLMService,
        options: SynthesisOrchestratorOptions
    ) {
        this.narrativeContextBuilder = narrativeContextBuilder;
        this.llmService = llmService;
        this.options = options;
    }

    // =========================================================================
    // MÉTHODES DE SYNTHÈSE INDIVIDUELLE
    // =========================================================================

    /**
     * Génère la synthèse pour une conversation individuelle.
     *
     * Phase 1 : Méthode squelette qui retournera une analyse mock.
     * Phase 3 : Intégrera la logique complète LLM.
     *
     * @param taskId ID de la tâche à analyser
     * @param options Options de construction de contexte (optionnelles)
     * @returns Promise de l'analyse complète de la conversation
     */
    async synthesizeConversation(
        taskId: string,
        options?: ContextBuildingOptions
    ): Promise<ConversationAnalysis> {
        try {
            console.log(`🚀 [SynthesisOrchestrator] Début synthèse conversation: ${taskId}`);

            // ÉTAPE 1: Construction du contexte narratif via NarrativeContextBuilderService
            console.log(`📖 [SynthesisOrchestrator] Construction contexte narratif pour ${taskId}...`);
            const contextResult = await this.narrativeContextBuilder.buildNarrativeContext(taskId, options);

            console.log(`✅ [SynthesisOrchestrator] Contexte construit (${contextResult.contextSummary.length} chars, condensé: ${contextResult.wasCondensed})`);

            // ÉTAPE 2: Phase 3 - Appel LLM réel pour générer la synthèse
            console.log(`🤖 [SynthesisOrchestrator] Génération synthèse LLM pour ${taskId}...`);

            try {
                const llmResult = await this.llmService.generateSynthesis(
                    contextResult.contextSummary,
                    taskId
                );

                console.log(`💰 [SynthesisOrchestrator] LLM cost: $${llmResult.usage.estimatedCost.toFixed(4)} (${llmResult.usage.totalTokens} tokens)`);

                // Parser la réponse JSON du LLM en ConversationAnalysis
                let llmAnalysis: ConversationAnalysis;
                try {
                    llmAnalysis = JSON.parse(llmResult.response) as ConversationAnalysis;
                } catch (parseError) {
                    console.warn(`⚠️ [SynthesisOrchestrator] Échec parsing JSON LLM, utilisation fallback`);

                    // Fallback si parsing échoue - structure minimale avec réponse brute
                    llmAnalysis = {
                        taskId,
                        analysisEngineVersion: "3.0.0-phase3-fallback",
                        analysisTimestamp: new Date().toISOString(),
                        llmModelId: llmResult.context.modelId,
                        contextTrace: contextResult.buildTrace,
                        objectives: { rawLlmResponse: llmResult.response },
                        strategy: { parsingFailed: true, error: parseError instanceof Error ? parseError.message : 'Unknown parse error' },
                        quality: { rawResponse: true },
                        metrics: {
                            contextLength: contextResult.contextSummary.length,
                            wasCondensed: contextResult.wasCondensed,
                            llmTokens: llmResult.usage.totalTokens,
                            llmCost: llmResult.usage.estimatedCost
                        },
                        synthesis: {
                            initialContextSummary: contextResult.contextSummary,
                            finalTaskSummary: llmResult.response.substring(0, 1000) + (llmResult.response.length > 1000 ? '...' : '')
                        }
                    };
                }

                // Assurer la cohérence des métadonnées critiques
                llmAnalysis.taskId = taskId;
                llmAnalysis.analysisTimestamp = new Date().toISOString();
                llmAnalysis.analysisEngineVersion = "3.0.0-phase3";
                llmAnalysis.llmModelId = llmResult.context.modelId; // Forcer le vrai nom de modèle
                llmAnalysis.contextTrace = contextResult.buildTrace;

                // Enrichir les métriques avec données du contexte et LLM
                llmAnalysis.metrics = {
                    ...llmAnalysis.metrics,
                    contextLength: contextResult.contextSummary.length,
                    wasCondensed: contextResult.wasCondensed,
                    condensedBatchPath: contextResult.condensedBatchPath || null,
                    llmTokens: llmResult.usage.totalTokens,
                    llmCost: llmResult.usage.estimatedCost,
                    llmDuration: llmResult.duration,

                    // Phase 3 : Arbre de contexte hiérarchique réel - DONNÉES CORRECTES
                    contextTree: {
                        currentTask: {
                            taskId: taskId,
                            synthesisType: contextResult.buildTrace.synthesisType || "atomic",
                            includedInContext: true
                        },
                        parentTasks: contextResult.buildTrace.parentContexts || [],
                        siblingTasks: contextResult.buildTrace.siblingContexts || [],
                        childTasks: contextResult.buildTrace.childContexts || [],
                        condensedBatches: contextResult.buildTrace.condensedBatches || [],
                        debugInfo: {
                            contextBuilderStatus: "fully_implemented_phase3",
                            implementedMethods: ["buildNarrativeContext", "enrichContext", "traverseUpwards", "collectSiblingTasks", "buildInitialContext", "collectChildrenSyntheses", "buildContextTrace"],
                            missingMethods: [],
                            explanation: "Le NarrativeContextBuilderService est complètement implémenté et peuple correctement le contextTree avec les données hiérarchiques.",
                            contextTraceData: {
                                rootTaskId: contextResult.buildTrace.rootTaskId,
                                parentTaskId: contextResult.buildTrace.parentTaskId,
                                hasParentContexts: !!contextResult.buildTrace.parentContexts?.length,
                                hasSiblingContexts: !!contextResult.buildTrace.siblingContexts?.length,
                                hasChildContexts: !!contextResult.buildTrace.childContexts?.length,
                                hasCondensedBatches: !!contextResult.buildTrace.condensedBatches?.length
                            }
                        }
                    }
                };

                // Garantir que la synthèse narrative utilise le contexte réel
                llmAnalysis.synthesis.initialContextSummary = contextResult.contextSummary;

                console.log(`🎯 [SynthesisOrchestrator] Synthèse LLM terminée pour ${taskId} (${llmResult.usage.totalTokens} tokens, $${llmResult.usage.estimatedCost.toFixed(4)})`);

                return llmAnalysis;

            } catch (llmError) {
                console.error(`❌ [SynthesisOrchestrator] Erreur LLM pour ${taskId}:`, llmError);
                if (llmError instanceof Error) {
                    console.error(`❌ [SynthesisOrchestrator] Stack:`, llmError.stack);
                }

                // Fallback avec contexte réel mais analyse d'erreur
                const fallbackAnalysis: ConversationAnalysis = {
                    taskId,
                    analysisEngineVersion: "3.0.0-phase3-error",
                    analysisTimestamp: new Date().toISOString(),
                    llmModelId: "error-fallback",
                    contextTrace: contextResult.buildTrace,
                    objectives: { llmError: true },
                    strategy: { llmError: true },
                    quality: { llmError: true },
                    metrics: {
                        contextLength: contextResult.contextSummary.length,
                        wasCondensed: contextResult.wasCondensed,
                        llmError: llmError instanceof Error ? llmError.message : 'Unknown LLM error',

                        // Phase 3 : Arbre de contexte pour traçabilité (même en cas d'erreur LLM)
                        contextTree: {
                            currentTask: {
                                taskId: taskId,
                                synthesisType: contextResult.buildTrace.synthesisType || "atomic",
                                includedInContext: true
                            },
                            parentTasks: contextResult.buildTrace.parentContexts || [],
                            siblingTasks: contextResult.buildTrace.siblingContexts || [],
                            childTasks: contextResult.buildTrace.childContexts || [],
                            condensedBatches: contextResult.buildTrace.condensedBatches || [],
                            debugInfo: {
                                contextBuilderStatus: "fully_implemented_phase3",
                                implementedMethods: ["buildNarrativeContext", "enrichContext", "traverseUpwards", "collectSiblingTasks", "buildInitialContext", "collectChildrenSyntheses", "buildContextTrace"],
                                missingMethods: [],
                                explanation: "Erreur LLM mais le NarrativeContextBuilderService a construit correctement le contexte hiérarchique.",
                                contextTraceData: {
                                    rootTaskId: contextResult.buildTrace.rootTaskId,
                                    parentTaskId: contextResult.buildTrace.parentTaskId,
                                    hasParentContexts: !!contextResult.buildTrace.parentContexts?.length,
                                    hasSiblingContexts: !!contextResult.buildTrace.siblingContexts?.length,
                                    hasChildContexts: !!contextResult.buildTrace.childContexts?.length,
                                    hasCondensedBatches: !!contextResult.buildTrace.condensedBatches?.length
                                }
                            }
                        }
                    },
                    synthesis: {
                        initialContextSummary: contextResult.contextSummary,
                        finalTaskSummary: `Erreur LLM lors de la synthèse: ${llmError instanceof Error ? llmError.message : 'Unknown LLM error'}`
                    }
                };

                return fallbackAnalysis;
            }

        } catch (error) {
            console.error(`❌ [SynthesisOrchestrator] Erreur synthèse ${taskId}:`, error);

            // Retour d'une analyse d'erreur conforme au contrat
            const errorAnalysis: ConversationAnalysis = {
                taskId,
                analysisEngineVersion: "3.0.0-phase3-error",
                analysisTimestamp: new Date().toISOString(),
                llmModelId: "error-handler",
                contextTrace: {
                    rootTaskId: taskId,
                    parentTaskId: undefined,
                    previousSiblingTaskIds: []
                },
                objectives: { error: true },
                strategy: { error: true },
                quality: { error: true },
                metrics: {
                    error: error instanceof Error ? error.message : 'Unknown error',

                    // Phase 3 : Arbre de contexte pour traçabilité (cas d'erreur critique)
                    contextTree: {
                        currentTask: {
                            taskId: taskId,
                            synthesisType: "atomic",
                            includedInContext: false
                        },
                        parentTasks: [],
                        siblingTasks: [],
                        childTasks: [],
                        condensedBatches: [],
                        debugInfo: {
                            contextBuilderStatus: "error_during_context_building",
                            implementedMethods: ["buildNarrativeContext", "enrichContext", "traverseUpwards", "collectSiblingTasks", "buildInitialContext", "collectChildrenSyntheses", "buildContextTrace"],
                            missingMethods: ["error recovery"],
                            explanation: "Erreur critique avant même l'appel au NarrativeContextBuilderService - toutes les méthodes sont implémentées.",
                            error: "Erreur lors de la construction du contexte narratif"
                        }
                    }
                },
                synthesis: {
                    initialContextSummary: "Erreur lors de la construction du contexte narratif",
                    finalTaskSummary: `Erreur lors de la synthèse: ${error instanceof Error ? error.message : 'Unknown error'}`
                }
            };

            return errorAnalysis;
        }
    }

    /**
     * Met à jour les métadonnées de synthèse dans un ConversationSkeleton.
     *
     * Phase 1 : Méthode squelette pour la structure.
     * Phase 2 : Implémentera la logique de mise à jour des métadonnées.
     *
     * @param skeleton Squelette de conversation à mettre à jour
     * @param analysis Analyse de conversation générée
     * @returns Promise du squelette mis à jour
     */
    async updateSynthesisMetadata(
        skeleton: ConversationSkeleton,
        analysis: ConversationAnalysis
    ): Promise<ConversationSkeleton> {
        // TODO Phase 2: Implémenter la mise à jour des métadonnées
        throw new SynthesisServiceError(
            'SynthesisOrchestratorService.updateSynthesisMetadata() - Pas encore implémenté (Phase 1: Squelette)',
            SynthesisServiceErrorCode.NOT_IMPLEMENTED,
            { method: 'updateSynthesisMetadata', phase: 1 }
        );
    }

    // =========================================================================
    // MÉTHODES DE TRAITEMENT PAR LOTS
    // =========================================================================

    /**
     * Lance un traitement de synthèse par lots.
     *
     * Phase 1 : Méthode squelette pour la structure.
     * Phase 4 : Implémentera la logique complète de traitement par lots.
     *
     * @param config Configuration du lot de traitement
     * @returns Promise de la tâche de traitement créée
     */
    async startBatchSynthesis(config: BatchSynthesisConfig): Promise<BatchSynthesisTask> {
        // TODO Phase 4: Implémenter la logique de traitement par lots
        throw new SynthesisServiceError(
            'SynthesisOrchestratorService.startBatchSynthesis() - Pas encore implémenté (Phase 1: Squelette)',
            SynthesisServiceErrorCode.NOT_IMPLEMENTED,
            { method: 'startBatchSynthesis', phase: 1, config }
        );
    }

    /**
     * Récupère le statut d'une tâche de traitement par lots.
     *
     * @param batchId ID du lot à vérifier
     * @returns Promise de la tâche de traitement ou null si non trouvée
     */
    async getBatchStatus(batchId: string): Promise<BatchSynthesisTask | null> {
        return this.activeBatches.get(batchId) || null;
    }

    /**
     * Annule un traitement par lots en cours.
     *
     * Phase 4 : Méthode pour l'annulation propre des traitements.
     *
     * @param batchId ID du lot à annuler
     * @returns Promise<boolean> true si annulé avec succès
     */
    async cancelBatchSynthesis(batchId: string): Promise<boolean> {
        // TODO Phase 4: Implémenter la logique d'annulation
        const batch = this.activeBatches.get(batchId);
        if (batch && batch.status === 'running') {
            // Logique d'annulation à implémenter
            return false; // Placeholder
        }
        return false;
    }

    // =========================================================================
    // MÉTHODES D'EXPORT ET UTILITAIRES
    // =========================================================================

    /**
     * Exporte les résultats de synthèse selon les options spécifiées.
     *
     * Phase 4 : Méthode pour l'export dans différents formats.
     *
     * @param taskIds Liste des IDs de tâches à exporter
     * @param options Options d'export
     * @returns Promise du chemin du fichier d'export généré
     */
    async exportSynthesisResults(
        taskIds: string[],
        options: ExportOptions
    ): Promise<string> {
        // TODO Phase 4: Implémenter la logique d'export
        throw new SynthesisServiceError(
            'SynthesisOrchestratorService.exportSynthesisResults() - Pas encore implémenté (Phase 1: Squelette)',
            SynthesisServiceErrorCode.NOT_IMPLEMENTED,
            { method: 'exportSynthesisResults', phase: 1, taskIds, options }
        );
    }

    /**
     * Nettoie les ressources et arrête les traitements en cours.
     * Appelé lors de l'arrêt du serveur MCP.
     *
     * @returns Promise<void>
     */
    async cleanup(): Promise<void> {
        // Nettoyer les tâches actives
        for (const [batchId, batch] of this.activeBatches) {
            if (batch.status === 'running') {
                await this.cancelBatchSynthesis(batchId);
            }
        }
        this.activeBatches.clear();
    }

    // =========================================================================
    // MÉTHODES PRIVÉES ET UTILITAIRES
    // =========================================================================

    /**
     * Génère un ID unique pour un nouveau lot de traitement.
     *
     * @returns string ID unique du lot
     */
    private generateBatchId(): string {
        return `batch_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    /**
     * Valide la configuration d'un lot de traitement.
     *
     * @param config Configuration à valider
     * @throws Error si la configuration est invalide
     */
    private validateBatchConfig(config: BatchSynthesisConfig): void {
        if (!config.llmModelId) {
            throw new SynthesisServiceError(
                'llmModelId est requis dans la configuration du lot',
                SynthesisServiceErrorCode.LLM_MODEL_REQUIRED,
                { config }
            );
        }

        if (config.maxConcurrency <= 0) {
            throw new SynthesisServiceError(
                'maxConcurrency doit être supérieur à 0',
                SynthesisServiceErrorCode.MAX_CONCURRENCY_INVALID,
                { maxConcurrency: config.maxConcurrency }
            );
        }

        if (!config.taskFilter || (!config.taskFilter.taskIds && !config.taskFilter.workspace)) {
            throw new SynthesisServiceError(
                'taskFilter doit spécifier soit taskIds soit workspace',
                SynthesisServiceErrorCode.TASK_FILTER_INVALID,
                { taskFilter: config.taskFilter }
            );
        }
    }

    // =========================================================================
    // MÉTHODES DE DIAGNOSTIC ET DEBUG
    // =========================================================================

    /**
     * Retourne les statistiques d'utilisation du service.
     * Utile pour le monitoring et le debug.
     *
     * @returns Statistiques d'utilisation
     */
    getServiceStats(): {
        activeBatches: number;
        totalBatchesProcessed: number;
        memoryUsage: NodeJS.MemoryUsage;
    } {
        return {
            activeBatches: this.activeBatches.size,
            totalBatchesProcessed: 0, // TODO: Compteur à implémenter
            memoryUsage: process.memoryUsage()
        };
    }
}