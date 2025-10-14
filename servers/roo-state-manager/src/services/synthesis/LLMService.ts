/**
 * LLMService - Service d'interface avec les modèles de langage (LLM)
 * 
 * Ce service fournit une interface unifiée pour les appels aux différents modèles LLM
 * utilisés dans le processus de synthèse. Il centralise la gestion des appels,
 * l'authentification, la gestion des erreurs et les optimisations de performance.
 * 
 * Architecture wrapper autour d'openai-node avec pattern "Exception Wrapping".
 * 
 * SDDD Phase 3 : Implémentation LLM complète avec intégration OpenAI réelle
 *
 * @author Roo Code v4 - SDDD Phase 3
 * @version 3.0.0
 */

import { ConversationAnalysis, CondensedSynthesisBatch, ContextTrace, SynthesisNarrative } from '../../models/synthesis/SynthesisModels.js';
import getOpenAIClient from '../openai.js';
import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import * as crypto from 'crypto';

// =============================================================================
// SCHEMAS ZOD POUR STRUCTURED OUTPUT
// =============================================================================

/**
 * Schema Zod pour la structure ContextTrace conforme aux models
 */
const ContextTraceSchema = z.object({
    rootTaskId: z.string(),
    parentTaskId: z.string().nullable(),
    previousSiblingTaskIds: z.array(z.string())
});

/**
 * Schema Zod pour la structure SynthesisNarrative conforme aux models
 */
const SynthesisNarrativeSchema = z.object({
    initialContextSummary: z.string(),
    finalTaskSummary: z.string()
});

/**
 * Schema Zod principal pour ConversationAnalysis - garantit la conformité structurée
 * Avec types explicites pour OpenAI structured outputs
 */
const ConversationAnalysisSchema = z.object({
    // Métadonnées de l'analyse
    taskId: z.string(),
    analysisEngineVersion: z.string(),
    analysisTimestamp: z.string(),
    llmModelId: z.string(),

    // Traçabilité du contexte
    contextTrace: ContextTraceSchema,

    // Sections d'analyse structurée avec types explicites
    objectives: z.object({
        primary_goal: z.string(),
        secondary_goals: z.array(z.string()),
        success_criteria: z.array(z.string())
    }),
    strategy: z.object({
        approach: z.string(),
        tools_used: z.array(z.string()),
        methodology: z.string()
    }),
    quality: z.object({
        completeness_score: z.number(),
        clarity_score: z.number(),
        effectiveness_rating: z.string(),
        issues_found: z.array(z.string())
    }),
    metrics: z.object({
        contextLength: z.number(),
        wasCondensed: z.boolean(),
        processing_time_ms: z.number().nullable(),
        complexity_score: z.number().nullable(),
        // Nouveau : traçage de l'arbre des synthèses incluses
        contextTree: z.object({
            currentTask: z.object({
                taskId: z.string(),
                synthesisType: z.enum(["atomic", "condensed_batch", "on_demand"]),
                includedInContext: z.boolean()
            }),
            parentTasks: z.array(z.object({
                taskId: z.string(),
                synthesisType: z.enum(["atomic", "condensed_batch", "on_demand", "missing"]),
                includedInContext: z.boolean(),
                errorMessage: z.string().nullable()
            })),
            siblingTasks: z.array(z.object({
                taskId: z.string(),
                synthesisType: z.enum(["atomic", "condensed_batch", "on_demand", "missing"]),
                includedInContext: z.boolean(),
                errorMessage: z.string().nullable()
            })),
            condensedBatches: z.array(z.object({
                batchId: z.string(),
                taskIds: z.array(z.string()),
                includedInContext: z.boolean()
            }))
        })
    }),

    // Synthèse narrative incrémentale
    synthesis: SynthesisNarrativeSchema
});

/**
 * Schema pour la condensation de synthèses multiples
 */
const CondensedSynthesisBatchSchema = z.object({
    batchId: z.string(),
    creationTimestamp: z.string(),
    llmModelId: z.string(),
    batchSummary: z.string(),
    sourceTaskIds: z.array(z.string())
});

// =============================================================================
// CONFIGURATIONS MODÈLES STANDARD
// =============================================================================

/**
 * Configuration par défaut pour GPT-4o optimisée pour la synthèse
 * Note: GPT-4o supporte les structured outputs avec zodResponseFormat
 */
const DEFAULT_MODEL_CONFIG: LLMModelConfig = {
    modelId: 'gpt-4o-mini-synthesis',
    displayName: 'GPT-4o Mini (Synthèse)',
    provider: 'openai',
    modelName: process.env.OPENAI_CHAT_MODEL_ID || 'gpt-4o-mini',
    maxTokens: 128000,
    costPerInputToken: 0.00015 / 1000,  // Prix GPT-4o-mini
    costPerOutputToken: 0.0006 / 1000,   // Prix GPT-4o-mini
    parameters: {
        temperature: 0.1
    }
};

/**
 * Configuration d'options par défaut pour le service
 */
const DEFAULT_SERVICE_OPTIONS: LLMServiceOptions = {
    models: [DEFAULT_MODEL_CONFIG],
    defaultModelId: 'gpt-4o-mini-synthesis',
    defaultTimeout: 60000, // 60 secondes
    maxRetries: 3,
    retryDelay: 1000,
    enableCaching: true
};

/**
 * Configuration d'un modèle LLM supporté.
 * Permet la gestion multi-modèles avec des paramètres spécifiques.
 */
export interface LLMModelConfig {
    /** Identifiant unique du modèle */
    modelId: string;
    
    /** Nom d'affichage du modèle */
    displayName: string;
    
    /** Fournisseur du modèle (OpenAI, Anthropic, etc.) */
    provider: 'openai' | 'anthropic' | 'azure' | 'local';
    
    /** Nom technique du modèle chez le fournisseur */
    modelName: string;
    
    /** Limite de tokens de contexte */
    maxTokens: number;
    
    /** Coût par token d'entrée (pour monitoring) */
    costPerInputToken: number;
    
    /** Coût par token de sortie (pour monitoring) */
    costPerOutputToken: number;
    
    /** Paramètres spécifiques au modèle */
    parameters: {
        temperature?: number;
    };
}

/**
 * Options globales de configuration du service LLM.
 * Contrôle le comportement général des appels LLM.
 */
export interface LLMServiceOptions {
    /** Configuration des modèles supportés */
    models: LLMModelConfig[];
    
    /** Modèle par défaut à utiliser */
    defaultModelId: string;
    
    /** Timeout par défaut pour les appels LLM (ms) */
    defaultTimeout: number;
    
    /** Nombre maximum de tentatives en cas d'échec */
    maxRetries: number;
    
    /** Délai entre les tentatives (ms) */
    retryDelay: number;
    
    /** Si true, active le cache des réponses LLM */
    enableCaching: boolean;
    
    /** Répertoire pour persister le cache (optionnel) */
    cacheDirectory?: string;
}

/**
 * Contexte d'un appel LLM avec tous les paramètres.
 * Utilisé pour la traçabilité et le debug des appels.
 */
export interface LLMCallContext {
    /** Identifiant unique de l'appel */
    callId: string;
    
    /** ID du modèle utilisé */
    modelId: string;
    
    /** Timestamp de début de l'appel */
    startTime: string;
    
    /** Prompt envoyé au modèle */
    prompt: string;
    
    /** Paramètres spécifiques à cet appel */
    parameters: Record<string, any>;
    
    /** Métadonnées additionnelles */
    metadata: Record<string, any>;
}

/**
 * Résultat d'un appel LLM avec métriques et métadonnées.
 * Fournit toutes les informations nécessaires pour le suivi et l'optimisation.
 */
export interface LLMCallResult {
    /** Contexte de l'appel original */
    context: LLMCallContext;
    
    /** Réponse du modèle */
    response: string;
    
    /** Timestamp de fin de l'appel */
    endTime: string;
    
    /** Durée totale de l'appel (ms) */
    duration: number;
    
    /** Métriques d'utilisation */
    usage: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
        estimatedCost: number;
    };
    
    /** Si true, la réponse provient du cache */
    fromCache: boolean;
    
    /** Erreur éventuelle (null si succès) */
    error?: string;
}

/**
 * Service d'interface avec les modèles de langage (LLM).
 * 
 * Ce service centralise tous les appels aux LLM pour le système de synthèse.
 * Il fournit une interface unifiée, gère les erreurs, optimise les performances
 * et offre une traçabilité complète des appels.
 * 
 * Fonctionnalités principales :
 * - Interface unifiée multi-modèles
 * - Gestion robuste des erreurs avec retry
 * - Cache intelligent des réponses
 * - Monitoring et métriques détaillées
 * - Support des appels en lot optimisés
 */
export class LLMService {
    private options: LLMServiceOptions;
    
    /**
     * Cache des réponses LLM pour éviter les re-appels coûteux.
     * Clé: hash du prompt + paramètres, Valeur: résultat de l'appel
     */
    private responseCache: Map<string, LLMCallResult> = new Map();
    
    /**
     * Historique des appels pour monitoring et debug.
     * Limité en taille pour éviter une croissance excessive de la mémoire.
     */
    private callHistory: LLMCallResult[] = [];
    private maxHistorySize = 1000;

    /**
     * Constructeur avec options de configuration.
     *
     * @param options Configuration du service LLM (optionnel, utilise les défauts)
     */
    constructor(options?: Partial<LLMServiceOptions>) {
        this.options = {
            ...DEFAULT_SERVICE_OPTIONS,
            ...options
        };
        this.validateConfiguration();
    }

    // =========================================================================
    // MÉTHODES PRINCIPALES D'APPEL LLM
    // =========================================================================

    /**
     * Génère une synthèse de conversation via LLM.
     * 
     * Cette méthode est le point d'entrée principal pour la génération de synthèses.
     * Elle utilise le modèle spécifié (ou celui par défaut) pour analyser le contexte
     * fourni et générer une synthèse structurée.
     * 
     * Phase 1 : Méthode squelette qui retournera un résultat mock.
     * Phase 3 : Implémentera la logique complète d'appel LLM.
     * 
     * @param context Contexte narratif à synthétiser
     * @param taskId ID de la tâche en cours de synthèse
     * @param modelId Modèle à utiliser (optionnel, utilise le défaut sinon)
     * @returns Promise du résultat de l'appel LLM
     */
    async generateSynthesis(
        context: string,
        taskId: string,
        modelId?: string
    ): Promise<LLMCallResult> {
        const activeModelId = modelId || this.options.defaultModelId;
        const modelConfig = this.getModelConfig(activeModelId);
        
        if (!modelConfig) {
            throw new Error(`Modèle non configuré: ${activeModelId}`);
        }

        // Construction du prompt optimisé pour la synthèse
        const synthesisPrompt = this.buildSynthesisPrompt(context, taskId, modelConfig.modelName);
        
        try {
            // Appel LLM avec structured output
            const result = await this.callLLM(
                synthesisPrompt,
                activeModelId,
                {
                    response_format: zodResponseFormat(ConversationAnalysisSchema, 'conversation_analysis')
                },
                { taskId, operation: 'synthesis' }
            );

            return result;
        } catch (error) {
            console.error(`Erreur génération synthèse pour tâche ${taskId}:`, error);
            throw new Error(`Échec génération synthèse: ${error instanceof Error ? error.message : 'Erreur inconnue'}`);
        }
    }

    /**
     * Condense un ensemble de synthèses en un lot unifié via LLM.
     * 
     * Cette méthode prend plusieurs analyses de conversation et les condense
     * en une synthèse de haut niveau pour optimiser l'utilisation du contexte.
     * 
     * Phase 1 : Méthode squelette qui retournera un résultat mock.
     * Phase 3 : Implémentera la logique complète de condensation.
     * 
     * @param analyses Liste des analyses à condenser
     * @param modelId Modèle à utiliser pour la condensation
     * @returns Promise du résultat de condensation
     */
    async condenseSyntheses(
        analyses: ConversationAnalysis[],
        modelId?: string
    ): Promise<LLMCallResult> {
        const activeModelId = modelId || this.options.defaultModelId;
        const modelConfig = this.getModelConfig(activeModelId);
        
        if (!modelConfig) {
            throw new Error(`Modèle non configuré: ${activeModelId}`);
        }

        if (analyses.length === 0) {
            throw new Error('Aucune analyse à condenser');
        }

        // Construction du prompt de condensation
        const condensationPrompt = this.buildCondensationPrompt(analyses);
        
        try {
            // Appel LLM avec structured output pour condensation
            const result = await this.callLLM(
                condensationPrompt,
                activeModelId,
                {
                    response_format: zodResponseFormat(CondensedSynthesisBatchSchema, 'condensed_batch')
                },
                {
                    operation: 'condensation',
                    sourceTaskIds: analyses.map(a => a.taskId)
                }
            );

            return result;
        } catch (error) {
            console.error(`Erreur condensation de ${analyses.length} synthèses:`, error);
            throw new Error(`Échec condensation: ${error instanceof Error ? error.message : 'Erreur inconnue'}`);
        }
    }

    /**
     * Effectue un appel LLM générique avec gestion complète des erreurs.
     * 
     * Cette méthode est la primitive de base pour tous les appels LLM.
     * Elle gère le retry, le cache, les métriques et la traçabilité.
     * 
     * Phase 3 : Implémentera la logique complète d'appel avec openai-node.
     * 
     * @param prompt Prompt à envoyer au modèle
     * @param modelId Modèle à utiliser
     * @param parameters Paramètres spécifiques à cet appel
     * @param metadata Métadonnées additionnelles
     * @returns Promise du résultat de l'appel
     */
    async callLLM(
        prompt: string,
        modelId?: string,
        parameters?: Record<string, any>,
        metadata?: Record<string, any>
    ): Promise<LLMCallResult> {
        const activeModelId = modelId || this.options.defaultModelId;
        const modelConfig = this.getModelConfig(activeModelId);
        
        if (!modelConfig) {
            throw new Error(`Modèle non configuré: ${activeModelId}`);
        }

        // Générer le contexte d'appel
        const callContext: LLMCallContext = {
            callId: this.generateCallId(),
            modelId: activeModelId,
            startTime: new Date().toISOString(),
            prompt,
            parameters: parameters || {},
            metadata: metadata || {}
        };

        // Vérifier le cache en premier
        const cachedResult = this.getCachedResponse(prompt, parameters || {}, activeModelId);
        if (cachedResult) {
            return cachedResult;
        }

        const startTime = Date.now();

        try {
            // Obtenir le client OpenAI configuré
            const client = getOpenAIClient();
            
            // Configuration de l'appel
            const openaiParams = {
                model: modelConfig.modelName,
                messages: [{ role: 'user' as const, content: prompt }],
                temperature: 0.1,
                max_tokens: 4000,
                // Ajouter response_format si présent
                ...(parameters?.response_format ? { response_format: parameters.response_format } : {})
            };

            console.log(`   - process.env.OPENAI_CHAT_MODEL_ID: ${process.env.OPENAI_CHAT_MODEL_ID}`);
            console.log(`   - openaiParams.model: ${openaiParams.model}`);
            console.log(`   - activeModelId: ${activeModelId}`);

            // Exécution de l'appel avec retry automatique d'OpenAI
            const completion = await client.chat.completions.create(openaiParams);
            
            const endTime = Date.now();
            const duration = endTime - startTime;

            // Extraction de la réponse
            const response = completion.choices[0]?.message?.content || '';
            
            // Construction du résultat
            const result: LLMCallResult = {
                context: {
                    ...callContext,
                    // CORRECTION: Utiliser le modèle retourné par OpenAI (plus fiable)
                    modelId: completion.model || modelConfig.modelName  // Priorité à la réponse OpenAI
                },
                response,
                endTime: new Date().toISOString(),
                duration,
                usage: {
                    promptTokens: completion.usage?.prompt_tokens || 0,
                    completionTokens: completion.usage?.completion_tokens || 0,
                    totalTokens: completion.usage?.total_tokens || 0,
                    estimatedCost: this.calculateCost(
                        completion.usage?.prompt_tokens || 0,
                        completion.usage?.completion_tokens || 0,
                        modelConfig
                    )
                },
                fromCache: false
            };
            
            console.log(`🤖 [LLMService] Modèle demandé: ${modelConfig.modelName}, modèle utilisé par OpenAI: ${completion.model}`);

            // Mettre en cache et ajouter à l'historique
            this.setCachedResponse(prompt, parameters || {}, activeModelId, result);
            this.addToHistory(result);

            return result;

        } catch (error) {
            const endTime = Date.now();
            const duration = endTime - startTime;
            
            // Gestion spécifique des erreurs OpenAI
            let errorMessage = 'Erreur LLM inconnue';
            if (error instanceof OpenAI.APIError) {
                errorMessage = `API OpenAI Error (${error.status}): ${error.message}`;
                console.error(`OpenAI API Error - Status: ${error.status}, Request ID: ${error.headers?.['x-request-id']}`);
            } else if (error instanceof Error) {
                errorMessage = error.message;
            }

            // Construction du résultat d'erreur
            const errorResult: LLMCallResult = {
                context: {
                    ...callContext,
                    // CORRECTION: Utiliser le vrai nom du modèle OpenAI, pas l'ID interne
                    modelId: modelConfig.modelName
                },
                response: '',
                endTime: new Date().toISOString(),
                duration,
                usage: {
                    promptTokens: 0,
                    completionTokens: 0,
                    totalTokens: 0,
                    estimatedCost: 0
                },
                fromCache: false,
                error: errorMessage
            };

            this.addToHistory(errorResult);
            throw error;
        }
    }

    // =========================================================================
    // MÉTHODES DE GESTION DES MODÈLES
    // =========================================================================

    /**
     * Retourne la configuration d'un modèle par son ID.
     * 
     * @param modelId ID du modèle recherché
     * @returns Configuration du modèle ou undefined si non trouvé
     */
    getModelConfig(modelId: string): LLMModelConfig | undefined {
        return this.options.models.find(model => model.modelId === modelId);
    }

    /**
     * Retourne la liste de tous les modèles configurés.
     * 
     * @returns Tableau des configurations de modèles
     */
    getAllModels(): LLMModelConfig[] {
        return [...this.options.models];
    }

    /**
     * Vérifie si un modèle est disponible et configuré.
     * 
     * @param modelId ID du modèle à vérifier
     * @returns boolean true si le modèle est disponible
     */
    isModelAvailable(modelId: string): boolean {
        return this.options.models.some(model => model.modelId === modelId);
    }

    // =========================================================================
    // MÉTHODES DE GESTION DU CACHE
    // =========================================================================

    /**
     * Vérifie si une réponse est disponible dans le cache.
     * 
     * @param prompt Prompt de l'appel
     * @param parameters Paramètres de l'appel
     * @param modelId Modèle utilisé
     * @returns Résultat mis en cache ou null si non trouvé
     */
    getCachedResponse(
        prompt: string,
        parameters: Record<string, any>,
        modelId: string
    ): LLMCallResult | null {
        if (!this.options.enableCaching) {
            return null;
        }

        const cacheKey = this.generateCacheKey(prompt, parameters, modelId);
        return this.responseCache.get(cacheKey) || null;
    }

    /**
     * Met en cache le résultat d'un appel LLM.
     * 
     * @param prompt Prompt de l'appel
     * @param parameters Paramètres de l'appel
     * @param modelId Modèle utilisé
     * @param result Résultat à mettre en cache
     */
    setCachedResponse(
        prompt: string,
        parameters: Record<string, any>,
        modelId: string,
        result: LLMCallResult
    ): void {
        if (!this.options.enableCaching) {
            return;
        }

        const cacheKey = this.generateCacheKey(prompt, parameters, modelId);
        this.responseCache.set(cacheKey, result);
    }

    /**
     * Vide le cache des réponses LLM.
     */
    clearCache(): void {
        this.responseCache.clear();
    }

    // =========================================================================
    // MÉTHODES DE MONITORING ET STATISTIQUES
    // =========================================================================

    /**
     * Retourne les statistiques d'utilisation du service.
     * Utile pour le monitoring des performances et coûts.
     * 
     * @returns Statistiques détaillées d'utilisation
     */
    getUsageStats(): {
        totalCalls: number;
        successfulCalls: number;
        failedCalls: number;
        totalCost: number;
        totalTokens: number;
        cacheHitRate: number;
        averageResponseTime: number;
        callsByModel: Record<string, number>;
    } {
        const totalCalls = this.callHistory.length;
        const successfulCalls = this.callHistory.filter(call => !call.error).length;
        const failedCalls = totalCalls - successfulCalls;
        
        const totalCost = this.callHistory.reduce((sum, call) => sum + call.usage.estimatedCost, 0);
        const totalTokens = this.callHistory.reduce((sum, call) => sum + call.usage.totalTokens, 0);
        
        const cachedCalls = this.callHistory.filter(call => call.fromCache).length;
        const cacheHitRate = totalCalls > 0 ? (cachedCalls / totalCalls) * 100 : 0;
        
        const totalDuration = this.callHistory.reduce((sum, call) => sum + call.duration, 0);
        const averageResponseTime = totalCalls > 0 ? totalDuration / totalCalls : 0;
        
        const callsByModel: Record<string, number> = {};
        this.callHistory.forEach(call => {
            callsByModel[call.context.modelId] = (callsByModel[call.context.modelId] || 0) + 1;
        });

        return {
            totalCalls,
            successfulCalls,
            failedCalls,
            totalCost,
            totalTokens,
            cacheHitRate,
            averageResponseTime,
            callsByModel
        };
    }

    /**
     * Retourne l'historique des appels récents.
     * 
     * @param limit Nombre maximum d'appels à retourner
     * @returns Historique des appels récents
     */
    getCallHistory(limit: number = 100): LLMCallResult[] {
        return this.callHistory.slice(-limit);
    }

    // =========================================================================
    // MÉTHODES PRIVÉES ET UTILITAIRES
    // =========================================================================

    /**
     * Valide la configuration du service au démarrage.
     * 
     * @throws Error si la configuration est invalide
     */
    private validateConfiguration(): void {
        if (!this.options.models || this.options.models.length === 0) {
            throw new Error('Au moins un modèle doit être configuré');
        }

        if (!this.options.defaultModelId) {
            throw new Error('Un modèle par défaut doit être spécifié');
        }

        const defaultModel = this.getModelConfig(this.options.defaultModelId);
        if (!defaultModel) {
            throw new Error(`Le modèle par défaut '${this.options.defaultModelId}' n'est pas configuré`);
        }

        // Valider chaque modèle configuré
        for (const model of this.options.models) {
            if (!model.modelId || !model.modelName || !model.provider) {
                throw new Error(`Configuration invalide pour le modèle: ${JSON.stringify(model)}`);
            }
        }
    }

    /**
     * Construit le prompt optimisé pour la génération de synthèse.
     * Intègre les instructions contextuelles et le format attendu.
     *
     * @param context Contexte narratif à synthétiser
     * @param taskId ID de la tâche en cours
     * @returns Prompt structuré pour l'analyse LLM
     */
    private buildSynthesisPrompt(context: string, taskId: string, modelName: string): string {
        return `Tu es un expert en analyse de conversations techniques et développement logiciel.
Analyse la conversation suivante et génère une synthèse structurée complète.

CONTEXTE À ANALYSER :
=====================================
${context}
=====================================

INSTRUCTIONS :
1. Analyse les objectifs de la conversation (ce qui était recherché)
2. Identifie la stratégie utilisée (comment le problème a été abordé)
3. Évalue la qualité globale (efficacité, clarté, résultats)
4. Calcule des métriques pertinentes (temps, complexité, succès)
5. Produis une synthèse narrative en deux parties :
   - initialContextSummary : résumé du contexte initial et des prérequis
   - finalTaskSummary : synthèse finale de ce qui a été accompli

IMPORTANT :
- Sois précis et factuel
- Base-toi uniquement sur le contenu fourni
- Utilise un langage technique approprié
- Génère du contenu utile pour la documentation et le suivi

TaskId de référence : ${taskId}

IMPÉRATIF : utilise "${modelName}" comme valeur pour le champ llmModelId dans ta réponse JSON`;
    }

    /**
     * Construit le prompt pour condenser plusieurs synthèses.
     * Optimisé pour créer un résumé de haut niveau cohérent.
     *
     * @param analyses Synthèses individuelles à condenser
     * @returns Prompt structuré pour la condensation
     */
    private buildCondensationPrompt(analyses: ConversationAnalysis[]): string {
        const taskIds = analyses.map(a => a.taskId).join(', ');
        const synthesesSummary = analyses.map((analysis, index) =>
            `SYNTHÈSE ${index + 1} (${analysis.taskId}):\n${analysis.synthesis.finalTaskSummary}`
        ).join('\n\n---\n\n');

        return `Tu es un expert en synthèse documentaire. Condense les synthèses suivantes en un résumé de haut niveau unifié.

SYNTHÈSES À CONDENSER :
${synthesesSummary}

INSTRUCTIONS :
1. Crée un résumé global cohérent qui capture l'essence de toutes les synthèses
2. Identifie les patterns et thèmes communs
3. Conserve les informations clés de chaque synthèse
4. Produis une synthèse condensée fluide et utile

IDs des tâches source : ${taskIds}
Nombre de synthèses à condenser : ${analyses.length}`;
    }

    /**
     * Calcule le coût estimé d'un appel LLM basé sur les tokens utilisés.
     *
     * @param promptTokens Nombre de tokens d'entrée
     * @param completionTokens Nombre de tokens de sortie
     * @param modelConfig Configuration du modèle avec coûts
     * @returns Coût estimé en dollars US
     */
    private calculateCost(
        promptTokens: number,
        completionTokens: number,
        modelConfig: LLMModelConfig
    ): number {
        const inputCost = promptTokens * modelConfig.costPerInputToken;
        const outputCost = completionTokens * modelConfig.costPerOutputToken;
        return inputCost + outputCost;
    }

    /**
     * Génère une clé de cache pour un appel LLM.
     *
     * @param prompt Prompt de l'appel
     * @param parameters Paramètres de l'appel
     * @param modelId Modèle utilisé
     * @returns Clé de cache unique
     */
    private generateCacheKey(
        prompt: string,
        parameters: Record<string, any>,
        modelId: string
    ): string {
        const data = JSON.stringify({ prompt, parameters, modelId });
        return crypto.createHash('sha256').update(data).digest('hex').substring(0, 32);
    }

    /**
     * Génère un ID unique pour un appel LLM.
     * 
     * @returns ID unique de l'appel
     */
    private generateCallId(): string {
        return `llm_call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    /**
     * Ajoute un résultat d'appel à l'historique avec gestion de la taille.
     * 
     * @param result Résultat de l'appel à ajouter
     */
    private addToHistory(result: LLMCallResult): void {
        this.callHistory.push(result);
        
        // Limiter la taille de l'historique pour éviter une croissance excessive
        if (this.callHistory.length > this.maxHistorySize) {
            this.callHistory = this.callHistory.slice(-this.maxHistorySize);
        }
    }

    // =========================================================================
    // MÉTHODES DE NETTOYAGE
    // =========================================================================

    /**
     * Nettoie les ressources du service.
     * Appelé lors de l'arrêt du serveur MCP.
     */
    async cleanup(): Promise<void> {
        // Persister le cache si configuré
        if (this.options.cacheDirectory && this.options.enableCaching) {
            // TODO Phase 3: Implémenter la persistance du cache
        }

        this.clearCache();
        this.callHistory = [];
    }
}