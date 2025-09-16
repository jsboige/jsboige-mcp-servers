/**
 * NarrativeContextBuilderService - Service de construction de contexte narratif récursif
 * 
 * Ce service implémente l'algorithme de construction de contexte narratif pour les synthèses.
 * Il parcourt l'arbre des conversations de manière intelligente pour construire un contexte
 * cohérent incluant les tâches parents, enfants et sœurs selon la stratégie définie.
 * 
 * Architecture inspirée des services existants de roo-state-manager.
 * 
 * SDDD Phase 1 : Squelette vide avec structure complète pour l'implémentation future
 * 
 * @author Roo Code v4 - SDDD Phase 1
 * @version 1.0.0
 */

import {
    ContextBuildingOptions,
    ContextBuildingResult,
    ContextTrace,
    ConversationAnalysis,
    CondensedSynthesisBatch
} from '../../models/synthesis/SynthesisModels.js';

// Type temporaire pour Phase 2 - sera défini dans SynthesisModels plus tard
interface NarrativeContext {
    taskId: string;
    contextSummary: string;
    [key: string]: any; // Flexible pour l'enrichissement
}
import { ConversationSkeleton, MessageSkeleton, ActionMetadata } from '../../types/conversation.js';

/**
 * Options de configuration spécifiques au service de construction de contexte.
 * Contrôle le comportement de parcours et de construction du contexte narratif.
 */
export interface NarrativeContextBuilderOptions {
    /** Répertoire de base pour lire les fichiers de synthèse */
    synthesisBaseDir: string;
    
    /** Répertoire pour les lots de synthèse condensée */
    condensedBatchesDir: string;
    
    /** Taille maximale du contexte avant déclenchement de condensation */
    maxContextSizeBeforeCondensation: number;
    
    /** Profondeur maximale par défaut de remontée dans l'arbre */
    defaultMaxDepth: number;
}

/**
 * Résultat intermédiaire de parcours d'arbre des conversations.
 * Utilisé pendant la construction du contexte pour traquer les éléments collectés.
 */
export interface TreeTraversalResult {
    /** Squelettes collectés pendant le parcours */
    collectedSkeletons: ConversationSkeleton[];
    
    /** Analyses de synthèse collectées (si disponibles) */
    collectedAnalyses: ConversationAnalysis[];
    
    /** Lots condensés utilisés pendant la construction */
    usedCondensedBatches: CondensedSynthesisBatch[];
    
    /** Profondeur maximale atteinte pendant le parcours */
    maxDepthReached: number;
}

/**
 * Structure représentant l'analyse de la structure d'une conversation
 */
export interface ConversationStructure {
    sequences: ConversationSequence[];
    timeline: ChronologicalEvent[];
    metadata: {
        totalMessages: number;
        totalActions: number;
        conversationDuration: number;
        participantCount: number;
    };
}

/**
 * Séquence conversationnelle identifiée
 */
export interface ConversationSequence {
    id: string;
    type: 'initialization' | 'task_execution' | 'problem_solving' | 'completion';
    startIndex: number;
    endIndex: number;
    summary: string;
    confidence: number;
}

/**
 * Événement chronologique dans la conversation
 */
export interface ChronologicalEvent {
    timestamp: string;
    type: 'user_input' | 'assistant_response' | 'tool_execution' | 'decision_point';
    description: string;
    significance: 'low' | 'medium' | 'high';
}

/**
 * Analyse thématique et des décisions
 */
export interface ThematicAnalysis {
    themes: ThematicCluster[];
    decisions: DecisionPoint[];
    confidence: number;
}

/**
 * Cluster thématique identifié
 */
export interface ThematicCluster {
    id: string;
    label: string;
    keywords: string[];
    messageIndices: number[];
    confidence: number;
    importance: 'low' | 'medium' | 'high';
}

/**
 * Point de décision dans la conversation
 */
export interface DecisionPoint {
    messageIndex: number;
    description: string;
    options: string[];
    chosenOption: string;
    reasoning: string;
    impact: 'minor' | 'moderate' | 'major';
}

/**
 * Analyse des acteurs et patterns de communication
 */
export interface ActorAnalysis {
    actors: ActorProfile[];
    patterns: PatternAnalysis[];
}

/**
 * Profil d'un acteur dans la conversation
 */
export interface ActorProfile {
    role: 'user' | 'assistant' | 'system';
    messageCount: number;
    characteristics: string[];
    communicationStyle: string;
    expertise: string[];
}

/**
 * Pattern de communication détecté
 */
export interface PatternAnalysis {
    type: 'question_answer' | 'instruction_execution' | 'iterative_refinement' | 'problem_solving';
    frequency: number;
    examples: string[];
    effectiveness: 'low' | 'medium' | 'high';
}

/**
 * Service de construction de contexte narratif récursif.
 * 
 * Ce service implémente la logique de construction intelligente du contexte narratif
 * nécessaire à la synthèse de conversations. Il parcourt l'arbre des tâches de manière
 * stratégique pour construire un contexte cohérent et optimisé.
 * 
 * Fonctionnalités principales :
 * - Parcours intelligent de l'arbre des conversations
 * - Construction de contexte narratif hiérarchique
 * - Gestion de la condensation automatique
 * - Support des lots de synthèse condensée
 */
export class NarrativeContextBuilderService {
    private options: NarrativeContextBuilderOptions;
    
    /**
     * Cache des squelettes de conversation pour éviter les re-lectures.
     * Optimisation performance pour les opérations de parcours d'arbre.
     */
    private skeletonCache: Map<string, ConversationSkeleton> = new Map();
    
    /**
     * Cache des analyses de synthèse pour éviter les re-lectures.
     * Optimisation performance pour l'accès aux synthèses existantes.
     */
    private analysisCache: Map<string, ConversationAnalysis> = new Map();

    /**
     * Constructeur avec options de configuration.
     * 
     * @param options Options de configuration du service
     */
    constructor(options: NarrativeContextBuilderOptions) {
        this.options = options;
    }

    // =========================================================================
    // MÉTHODES PRINCIPALES DE CONSTRUCTION DE CONTEXTE
    // =========================================================================

    /**
     * Construit le contexte narratif pour une tâche donnée.
     * 
     * Cette méthode est le point d'entrée principal du service. Elle orchestre
     * l'ensemble du processus de construction de contexte selon les options fournies.
     * 
     * Phase 1 : Méthode squelette qui retournera un résultat mock.
     * Phase 2 : Implémentera la logique complète de construction de contexte.
     * 
     * @param taskId ID de la tâche pour laquelle construire le contexte
     * @param options Options de construction (optionnelles)
     * @returns Promise du résultat de construction de contexte
     */
    async buildNarrativeContext(
        taskId: string,
        options?: ContextBuildingOptions
    ): Promise<ContextBuildingResult> {
        try {
            // 1. Validation des paramètres
            if (!taskId) {
                throw new Error('taskId is required');
            }

            // 2. Fusion avec les options par défaut
            const fullOptions = this.mergeWithDefaultOptions(options);
            
            // 3. Chargement du squelette de conversation principal
            const mainConversation = await this.getConversationSkeleton(taskId);
            if (!mainConversation) {
                throw new Error(`Conversation skeleton not found for taskId: ${taskId}`);
            }

            // 4. Construction du contexte narratif complet
            const contextSummary = await this.buildContextSummary(mainConversation, fullOptions);
            
            // 5. Construction de la trace de contexte
            const buildTrace = this.buildContextTrace(taskId, taskId, []);
            
            // 6. Détermination si le contexte a été condensé
            const wasCondensed = contextSummary.length > fullOptions.maxContextSize;
            
            // 7. Construction du résultat final selon l'interface attendue
            const result: ContextBuildingResult = {
                contextSummary,
                buildTrace,
                wasCondensed,
                condensedBatchPath: wasCondensed ? this.generateCondensedBatchPath(taskId) : undefined
            };

            return result;
            
        } catch (error) {
            // Retour d'un résultat d'erreur conforme à l'interface
            return {
                contextSummary: `Erreur lors de la construction du contexte: ${error instanceof Error ? error.message : 'Unknown error'}`,
                buildTrace: {
                    rootTaskId: taskId,
                    parentTaskId: undefined,
                    previousSiblingTaskIds: []
                },
                wasCondensed: false
            };
        }
    }

    /**
     * Enrichit un contexte narratif existant avec des analyses approfondies.
     *
     * Cette méthode prend un contexte de base et l'enrichit avec :
     * - Analyse sémantique avancée des conversations
     * - Détection des patterns de communication récurrents
     * - Identification des acteurs et leurs rôles dans les échanges
     * - Extraction des métadonnées comportementales et temporelles
     *
     * @param baseContext Le contexte narratif de base à enrichir
     * @param contextOptions Options pour l'enrichissement
     * @returns Promise du contexte enrichi avec analyses approfondies
     */
    async enrichContext(
        baseContext: NarrativeContext,
        contextOptions?: ContextBuildingOptions
    ): Promise<NarrativeContext> {
        try {
            // 1. Analyse sémantique des conversations incluses
            const semanticAnalysis = await this.performSemanticAnalysis(baseContext);
            
            // 2. Détection des patterns de communication
            const communicationPatterns = await this.detectCommunicationPatterns(baseContext);
            
            // 3. Identification et profilage des acteurs
            const actorProfiles = await this.buildActorProfiles(baseContext);
            
            // 4. Extraction des métadonnées comportementales
            const behavioralMetadata = await this.extractBehavioralMetadata(baseContext);
            
            // 5. Construction du contexte enrichi
            const enrichedContext: NarrativeContext = {
                ...baseContext,
                
                // Enrichissement sémantique
                semanticAnalysis: {
                    keyThemes: semanticAnalysis.themes,
                    conceptClusters: semanticAnalysis.clusters,
                    semanticSimilarity: semanticAnalysis.similarity,
                    topicalEvolution: semanticAnalysis.evolution
                },
                
                // Patterns de communication enrichis
                communicationPatterns: {
                    interactionFlows: communicationPatterns.flows,
                    collaborationStyles: communicationPatterns.styles,
                    problemSolvingApproaches: communicationPatterns.approaches,
                    decisionMakingPatterns: communicationPatterns.decisions
                },
                
                // Profils d'acteurs enrichis
                actorProfiles: {
                    participantRoles: actorProfiles.roles,
                    expertiseDomains: actorProfiles.expertise,
                    interactionDynamics: actorProfiles.dynamics,
                    contributionPatterns: actorProfiles.contributions
                },
                
                // Métadonnées comportementales
                behavioralMetadata: {
                    temporalPatterns: behavioralMetadata.temporal,
                    workflowEfficiency: behavioralMetadata.efficiency,
                    collaborationQuality: behavioralMetadata.quality,
                    adaptationStrategies: behavioralMetadata.adaptation
                },
                
                // Métadonnées d'enrichissement
                enrichmentMetadata: {
                    enrichmentTimestamp: new Date().toISOString(),
                    analysisDepth: 'advanced',
                    confidenceScore: this.calculateOverallConfidence(semanticAnalysis, communicationPatterns, actorProfiles),
                    coverageMetrics: this.calculateCoverageMetrics(baseContext, semanticAnalysis)
                }
            };
            
            return enrichedContext;
            
        } catch (error) {
            console.error('Erreur lors de l\'enrichissement du contexte:', error);
            // Retourner le contexte de base en cas d'erreur
            return {
                ...baseContext,
                enrichmentMetadata: {
                    enrichmentTimestamp: new Date().toISOString(),
                    analysisDepth: 'basic',
                    error: error instanceof Error ? error.message : 'Erreur inconnue'
                }
            };
        }
    }

    // =========================================================================
    // MÉTHODES AUXILIAIRES POUR L'ENRICHISSEMENT (STUBS PHASE 2)
    // =========================================================================

    /**
     * Effectue une analyse sémantique du contexte narratif.
     * TODO Phase 2: Implémenter l'analyse sémantique réelle
     */
    private async performSemanticAnalysis(context: NarrativeContext): Promise<any> {
        return {
            themes: ['theme1', 'theme2'],
            clusters: [],
            similarity: 0.8,
            evolution: []
        };
    }

    /**
     * Détecte les patterns de communication dans le contexte.
     * TODO Phase 2: Implémenter la détection de patterns
     */
    private async detectCommunicationPatterns(context: NarrativeContext): Promise<any> {
        return {
            flows: [],
            styles: [],
            approaches: [],
            decisions: []
        };
    }

    /**
     * Construit les profils des acteurs.
     * TODO Phase 2: Implémenter le profilage des acteurs
     */
    private async buildActorProfiles(context: NarrativeContext): Promise<any> {
        return {
            roles: [],
            expertise: [],
            dynamics: [],
            contributions: []
        };
    }

    /**
     * Extrait les métadonnées comportementales.
     * TODO Phase 2: Implémenter l'extraction de métadonnées
     */
    private async extractBehavioralMetadata(context: NarrativeContext): Promise<any> {
        return {
            temporal: [],
            efficiency: {},
            quality: {},
            adaptation: []
        };
    }

    /**
     * Calcule le score de confiance global.
     * TODO Phase 2: Implémenter le calcul de confiance
     */
    private calculateOverallConfidence(...args: any[]): number {
        return 0.85; // Placeholder
    }

    /**
     * Calcule les métriques de couverture.
     * TODO Phase 2: Implémenter le calcul de couverture
     */
    private calculateCoverageMetrics(context: NarrativeContext, analysis: any): any {
        return {
            completeness: 0.9,
            accuracy: 0.85
        };
    }

    /**
     * Construit le contexte initial pour une synthèse (contexte amont).
     * 
     * Cette méthode se concentre sur la construction du contexte des tâches
     * parentes et sœurs qui précèdent la tâche actuelle dans le narratif.
     * 
     * Phase 2 : Implémentera la logique de remontée dans l'arbre des tâches.
     * 
     * @param taskId ID de la tâche cible
     * @param options Options de construction
     * @returns Promise du contexte initial construit
     */
    async buildInitialContext(
        taskId: string,
        options: ContextBuildingOptions
    ): Promise<string> {
        // TODO Phase 2: Implémenter la construction du contexte initial
        throw new Error('NarrativeContextBuilderService.buildInitialContext() - Pas encore implémenté (Phase 1: Squelette)');
    }

    // =========================================================================
    // MÉTHODES DE PARCOURS D'ARBRE
    // =========================================================================

    /**
     * Parcourt récursivement l'arbre des conversations vers les parents.
     * 
     * Cette méthode remonte dans l'arbre des tâches pour collecter les éléments
     * de contexte nécessaires à la compréhension de la tâche actuelle.
     * 
     * Phase 2 : Implémentera l'algorithme de remontée récursive.
     * 
     * @param taskId ID de la tâche de départ
     * @param maxDepth Profondeur maximale de remontée
     * @returns Promise du résultat de parcours
     */
    async traverseUpwards(
        taskId: string,
        maxDepth: number
    ): Promise<TreeTraversalResult> {
        // TODO Phase 2: Implémenter le parcours vers les parents
        throw new Error('NarrativeContextBuilderService.traverseUpwards() - Pas encore implémenté (Phase 1: Squelette)');
    }

    /**
     * Collecte les tâches sœurs (même parent) pour enrichir le contexte.
     * 
     * Cette méthode identifie et collecte les tâches sœurs qui peuvent apporter
     * du contexte narratif utile à la compréhension de la tâche actuelle.
     * 
     * Phase 2 : Implémentera la logique de collecte des tâches sœurs.
     * 
     * @param taskId ID de la tâche de référence
     * @param includeSubsequent Si true, inclut aussi les tâches sœurs postérieures
     * @returns Promise des squelettes des tâches sœurs
     */
    async collectSiblingTasks(
        taskId: string,
        includeSubsequent: boolean = false
    ): Promise<ConversationSkeleton[]> {
        // TODO Phase 2: Implémenter la collecte des tâches sœurs
        throw new Error('NarrativeContextBuilderService.collectSiblingTasks() - Pas encore implémenté (Phase 1: Squelette)');
    }

    /**
     * Collecte les synthèses finales des tâches enfants pour inclusion dans le contexte.
     * 
     * Cette méthode collecte les synthèses des tâches enfants déjà complétées
     * pour enrichir la compréhension de la tâche parent.
     * 
     * Phase 2 : Implémentera la logique de collecte des synthèses enfants.
     * 
     * @param taskId ID de la tâche parent
     * @returns Promise des analyses des tâches enfants
     */
    async collectChildrenSyntheses(taskId: string): Promise<ConversationAnalysis[]> {
        // TODO Phase 2: Implémenter la collecte des synthèses enfants
        return [];
    }

    // =========================================================================
    // MÉTHODES DE GESTION DE LA CONDENSATION
    // =========================================================================

    /**
     * Détermine si le contexte construit nécessite une condensation.
     * 
     * Cette méthode évalue la taille et la complexité du contexte construit
     * pour décider s'il faut déclencher une condensation.
     * 
     * Phase 2 : Implémentera la logique de décision de condensation.
     * 
     * @param contextSummary Contexte narratif construit
     * @returns boolean true si condensation nécessaire
     */
    // Méthode déplacée vers la fin (évite la duplication)

    /**
     * Recherche un lot de synthèse condensée existant pour les tâches données.
     * 
     * Cette méthode vérifie s'il existe déjà un lot condensé couvrant
     * les tâches spécifiées pour éviter la re-condensation.
     * 
     * Phase 3 : Implémentera la logique de recherche de lots condensés.
     * 
     * @param taskIds Liste des IDs de tâches à couvrir
     * @returns Promise du lot condensé trouvé ou null
     */
    async findExistingCondensedBatch(taskIds: string[]): Promise<CondensedSynthesisBatch | null> {
        // TODO Phase 3: Implémenter la recherche de lots condensés
        return null; // Placeholder Phase 1
    }

    /**
     * Créé un nouveau lot de synthèse condensée pour optimiser le contexte.
     * 
     * Cette méthode lance la création d'un lot condensé quand la taille
     * du contexte dépasse les seuils configurés.
     * 
     * Phase 3 : Implémentera la logique de création de lots condensés.
     * 
     * @param analyses Liste des analyses à condenser
     * @param llmModelId Modèle LLM à utiliser pour la condensation
     * @returns Promise du lot condensé créé
     */
    async createCondensedBatch(
        analyses: ConversationAnalysis[],
        llmModelId: string
    ): Promise<CondensedSynthesisBatch> {
        // TODO Phase 3: Implémenter la création de lots condensés
        throw new Error('NarrativeContextBuilderService.createCondensedBatch() - Pas encore implémenté (Phase 1: Squelette)');
    }

    // =========================================================================
    // MÉTHODES D'ACCÈS AUX DONNÉES
    // =========================================================================

    /**
     * Charge un squelette de conversation depuis le cache ou le stockage.
     * 
     * Cette méthode gère l'accès optimisé aux squelettes avec mise en cache
     * pour éviter les re-lectures coûteuses.
     * 
     * Phase 2 : Implémentera la logique de chargement avec cache.
     * 
     * @param taskId ID de la tâche à charger
     * @returns Promise du squelette ou null si non trouvé
     */
    async getConversationSkeleton(taskId: string): Promise<ConversationSkeleton | null> {
        // Vérifier le cache d'abord
        if (this.skeletonCache.has(taskId)) {
            return this.skeletonCache.get(taskId)!;
        }

        // TODO Phase 2: Charger depuis le stockage et mettre en cache
        return null; // Placeholder Phase 1
    }

    /**
     * Charge une analyse de synthèse depuis le cache ou le stockage.
     * 
     * Cette méthode gère l'accès optimisé aux analyses avec mise en cache
     * pour éviter les re-lectures coûteuses.
     * 
     * Phase 2 : Implémentera la logique de chargement avec cache.
     * 
     * @param taskId ID de la tâche dont charger l'analyse
     * @returns Promise de l'analyse ou null si non trouvée
     */
    async getConversationAnalysis(taskId: string): Promise<ConversationAnalysis | null> {
        // Vérifier le cache d'abord
        if (this.analysisCache.has(taskId)) {
            return this.analysisCache.get(taskId)!;
        }

        // TODO Phase 2: Charger depuis le fichier de synthèse et mettre en cache
        return null; // Placeholder Phase 1
    }

    // =========================================================================
    // MÉTHODES DE GESTION DU CACHE
    // =========================================================================

    /**
     * Vide les caches du service pour libérer la mémoire.
     * Utile lors de traitements par lots volumineux.
     */
    clearCaches(): void {
        this.skeletonCache.clear();
        this.analysisCache.clear();
    }

    /**
     * Retourne les statistiques d'utilisation des caches.
     * Utile pour le monitoring et l'optimisation des performances.
     * 
     * @returns Statistiques des caches
     */
    getCacheStats(): {
        skeletonCacheSize: number;
        analysisCacheSize: number;
        memoryUsage: NodeJS.MemoryUsage;
    } {
        return {
            skeletonCacheSize: this.skeletonCache.size,
            analysisCacheSize: this.analysisCache.size,
            memoryUsage: process.memoryUsage()
        };
    }

    // =========================================================================
    // MÉTHODES UTILITAIRES PRIVÉES
    // =========================================================================

    /**
     * Construit la trace de contexte pour une opération de construction.
     * 
     * @param rootTaskId ID de la tâche racine
     * @param targetTaskId ID de la tâche cible
     * @param siblingIds IDs des tâches sœurs incluses
     * @returns Trace de contexte construite
     */
    private buildContextTrace(
        rootTaskId: string,
        targetTaskId: string,
        siblingIds: string[]
    ): ContextTrace {
        return {
            rootTaskId,
            parentTaskId: targetTaskId, // TODO: Calculer le vrai parent
            previousSiblingTaskIds: siblingIds
        };
    }

    /**
     * Valide les options de construction de contexte.
     * 
     * @param options Options à valider
     * @throws Error si les options sont invalides
     */
    private validateBuildingOptions(options: ContextBuildingOptions): void {
        if (options.maxDepth < 0) {
            throw new Error('maxDepth doit être >= 0');
        }
        
        if (options.maxContextSize <= 0) {
            throw new Error('maxContextSize doit être > 0');
        }
    }

    // =========================================================================
    // MÉTHODES AUXILIAIRES IMPLÉMENTÉES EN PHASE 2
    // =========================================================================

    /**
     * Fusionne les options avec les valeurs par défaut
     */
    private mergeWithDefaultOptions(options?: ContextBuildingOptions): ContextBuildingOptions {
        return {
            maxDepth: options?.maxDepth ?? this.options.defaultMaxDepth,
            maxContextSize: options?.maxContextSize ?? this.options.maxContextSizeBeforeCondensation,
            includeSiblings: options?.includeSiblings ?? true,
            includeChildrenSyntheses: options?.includeChildrenSyntheses ?? true
        };
    }

    /**
     * Construit le résumé de contexte narratif complet
     */
    private async buildContextSummary(
        conversation: ConversationSkeleton,
        options: ContextBuildingOptions
    ): Promise<string> {
        const parts: string[] = [];

        // 1. Contexte de base de la conversation
        parts.push(`# Synthèse de Contexte - ${conversation.taskId}`);
        parts.push(`**Titre:** ${conversation.metadata.title || 'N/A'}`);
        parts.push(`**Messages:** ${conversation.metadata.messageCount}`);
        parts.push(`**Actions:** ${conversation.metadata.actionCount}`);
        
        // 2. Analyse du contenu conversationnel
        const contentAnalysis = await this.analyzeConversationContent(conversation);
        parts.push('## Analyse du Contenu');
        parts.push(contentAnalysis);

        // 3. Contexte des tâches parentes si demandé
        if (conversation.parentTaskId && options.maxDepth > 0) {
            const parentContext = await this.buildParentContext(conversation.parentTaskId, options.maxDepth - 1);
            if (parentContext) {
                parts.push('## Contexte Parent');
                parts.push(parentContext);
            }
        }

        // 4. Contexte des tâches sœurs si demandé
        if (options.includeSiblings) {
            const siblingsContext = await this.buildSiblingsContext(conversation.taskId);
            if (siblingsContext) {
                parts.push('## Contexte des Tâches Sœurs');
                parts.push(siblingsContext);
            }
        }

        return parts.join('\n\n');
    }

    /**
     * Analyse le contenu d'une conversation en utilisant les patterns de TraceSummaryService
     */
    private async analyzeConversationContent(conversation: ConversationSkeleton): Promise<string> {
        const messages = conversation.sequence.filter((item): item is any =>
            'role' in item && 'content' in item);

        if (messages.length === 0) {
            return 'Aucun message trouvé dans cette conversation.';
        }

        const analysis: string[] = [];
        
        // Compteurs inspirés de TraceSummaryService
        let userMessages = 0;
        let assistantMessages = 0;
        let toolResults = 0;

        for (const message of messages) {
            if (message.role === 'user') {
                if (this.isToolResult(message.content)) {
                    toolResults++;
                } else {
                    userMessages++;
                }
            } else if (message.role === 'assistant') {
                assistantMessages++;
            }
        }

        analysis.push(`**Distribution des messages:**`);
        analysis.push(`- Messages utilisateur: ${userMessages}`);
        analysis.push(`- Réponses assistant: ${assistantMessages}`);
        analysis.push(`- Résultats d'outils: ${toolResults}`);

        // Premier message utilisateur (task initiale)
        const firstUserMessage = messages.find(m => m.role === 'user' && !this.isToolResult(m.content));
        if (firstUserMessage) {
            const taskPreview = this.extractTaskPreview(firstUserMessage.content);
            analysis.push(`**Tâche initiale:** ${taskPreview}`);
        }

        // Dernière interaction
        const lastMessage = messages[messages.length - 1];
        if (lastMessage && lastMessage.role === 'assistant') {
            const completionStatus = this.extractCompletionStatus(lastMessage.content);
            analysis.push(`**État final:** ${completionStatus}`);
        }

        return analysis.join('\n');
    }

    /**
     * Construit le contexte des tâches parentes
     */
    private async buildParentContext(parentTaskId: string, maxDepth: number): Promise<string | null> {
        if (maxDepth <= 0) return null;

        const parentConversation = await this.getConversationSkeleton(parentTaskId);
        if (!parentConversation) return null;

        const contextParts: string[] = [];
        contextParts.push(`**Tâche Parent (${parentTaskId}):**`);
        contextParts.push(`- Titre: ${parentConversation.metadata.title || 'N/A'}`);
        contextParts.push(`- Messages: ${parentConversation.metadata.messageCount}`);

        // Récursion pour remonter plus haut
        if (parentConversation.parentTaskId && maxDepth > 1) {
            const grandParentContext = await this.buildParentContext(parentConversation.parentTaskId, maxDepth - 1);
            if (grandParentContext) {
                contextParts.push(grandParentContext);
            }
        }

        return contextParts.join('\n');
    }

    /**
     * Construit le contexte des tâches sœurs
     */
    private async buildSiblingsContext(taskId: string): Promise<string | null> {
        const siblings = await this.collectSiblingTasks(taskId, false);
        if (siblings.length === 0) return null;

        const contextParts: string[] = [];
        contextParts.push(`**Tâches Sœurs (${siblings.length}):**`);
        
        siblings.forEach((sibling, index) => {
            contextParts.push(`${index + 1}. ${sibling.metadata.title || sibling.taskId} (${sibling.metadata.messageCount} messages)`);
        });

        return contextParts.join('\n');
    }

    /**
     * Génère le chemin d'un lot condensé
     */
    private generateCondensedBatchPath(taskId: string): string {
        return `${this.options.condensedBatchesDir}/batch-${taskId}-${Date.now()}.json`;
    }

    /**
     * Détecte si un message est un résultat d'outil (pattern de TraceSummaryService)
     */
    private isToolResult(content: string): boolean {
        return /\[[^\]]+\] Result:/i.test(content);
    }

    /**
     * Extrait un aperçu de la tâche depuis le premier message
     */
    private extractTaskPreview(content: string): string {
        // Prendre les premières lignes non-vides, sans environment_details
        const lines = content.split('\n');
        for (const line of lines) {
            const trimmedLine = line.trim();
            if (trimmedLine && !trimmedLine.startsWith('<') && !trimmedLine.includes('environment_details')) {
                return trimmedLine.length > 100
                    ? trimmedLine.substring(0, 100) + '...'
                    : trimmedLine;
            }
        }
        return 'Tâche sans description claire';
    }

    /**
     * Extrait le statut de completion depuis le dernier message
     */
    private extractCompletionStatus(content: string): string {
        if (/<attempt_completion>/i.test(content)) {
            return 'Tâche terminée avec attempt_completion';
        }
        if (content.includes('erreur') || content.includes('error')) {
            return 'Tâche terminée avec erreurs';
        }
        return 'Tâche en cours ou partiellement complète';
    }

    // =========================================================================
    // ARCHITECTURE V3 - CONSTRUCTION RÉCURSIVE DU CONTEXTE NARRATIF
    // =========================================================================

    /**
     * CŒUR DE L'ARCHITECTURE V3 : CONSTRUCTION RÉCURSIVE DU CONTEXTE NARRATIF
     *
     * Cette méthode implémente l'algorithme de parcours topologique de l'arbre des tâches
     * pour construire le contexte narratif selon les spécifications SDDD.
     *
     * Workflow :
     * 1. Remontée récursive dans l'arbre (parents, frères précédents)
     * 2. Collection des synthèses existantes dans l'ordre topologique
     * 3. Assemblage du contexte narratif structuré
     * 4. Gestion de la condensation si le contexte est trop volumineux
     *
     * @param taskId ID de la tâche cible
     * @param batchConfig Configuration du lot (avec préfixes personnalisés)
     * @returns Promise du contexte narratif construit
     */
    async buildContextForTask(
        taskId: string,
        batchConfig?: { taskFilter: any }
    ): Promise<string> {
        try {
            // 1. Initialisation du contexte avec préfixe personnalisé si fourni
            const contextSummaries: string[] = [];
            
            // 2. Traitement du contexte préfixe (fichiers .md externes)
            if (batchConfig?.taskFilter?.customContextPrefixFiles) {
                await this.processCustomContextPrefix(
                    batchConfig.taskFilter.customContextPrefixFiles,
                    contextSummaries
                );
                contextSummaries.push('\n\n--- Contexte Dynamique ---\n\n');
            }
            
            // 3. Remontée récursive dans l'arbre des tâches selon l'ordre topologique
            await this.traverseTaskTreeRecursively(taskId, contextSummaries);
            
            // 4. Vérification de la taille et condensation si nécessaire
            const fullContext = contextSummaries.join('\n');
            if (this.shouldCondenseContext(fullContext)) {
                return await this.triggerContextCondensation(contextSummaries, taskId);
            }
            
            return fullContext;
            
        } catch (error) {
            console.error(`Erreur lors de la construction du contexte pour ${taskId}:`, error);
            return `Contexte indisponible pour ${taskId}`;
        }
    }

    /**
     * Traite les fichiers de contexte préfixe personnalisés.
     *
     * @param customFiles Chemins vers les fichiers .md à inclure
     * @param contextSummaries Tableau de contexte à enrichir
     */
    private async processCustomContextPrefix(
        customFiles: string[],
        contextSummaries: string[]
    ): Promise<void> {
        for (const filePath of customFiles) {
            try {
                const fs = await import('fs/promises');
                const content = await fs.readFile(filePath, 'utf-8');
                contextSummaries.push(`=== Contexte Préfixe: ${filePath} ===\n${content}\n`);
            } catch (error) {
                console.warn(`Impossible de lire le fichier de contexte: ${filePath}`, error);
            }
        }
    }

    /**
     * Parcourt récursivement l'arbre des tâches pour collecter les synthèses.
     *
     * Implémente l'ordre topologique spécifié dans l'architecture v3 :
     * 1. Frères précédents (dans l'ordre chronologique)
     * 2. Parent de la tâche actuelle
     * 3. Remontée récursive vers les ancêtres
     *
     * @param taskId ID de la tâche actuelle
     * @param contextSummaries Tableau de contexte à enrichir
     * @param visitedTasks Set des tâches déjà visitées (évite les cycles)
     */
    private async traverseTaskTreeRecursively(
        taskId: string,
        contextSummaries: string[],
        visitedTasks: Set<string> = new Set()
    ): Promise<void> {
        // Protection contre les cycles infinis
        if (visitedTasks.has(taskId)) {
            return;
        }
        visitedTasks.add(taskId);

        try {
            const skeleton = await this.getConversationSkeleton(taskId);
            if (!skeleton) {
                return;
            }

            // 1. Traitement des frères précédents (ordre chronologique)
            // NOTE: La structure ConversationSkeleton n'a pas de propriété childTasks
            // TODO Phase 2: Implémenter la logique de collecte des frères via un service dédié
            if (skeleton.parentTaskId) {
                // Placeholder pour la collecte des frères précédents
                console.log(`TODO: Collecter les frères précédents pour ${taskId} via parent ${skeleton.parentTaskId}`);
            }

            // 2. Remontée récursive vers le parent
            if (skeleton.parentTaskId) {
                await this.traverseTaskTreeRecursively(skeleton.parentTaskId, contextSummaries, visitedTasks);
            }

        } catch (error) {
            console.error(`Erreur lors du parcours récursif pour ${taskId}:`, error);
        }
    }

    /**
     * Récupère la synthèse d'une tâche selon la logique de priorité définie.
     *
     * Priorité selon l'architecture v3 :
     * 1. Lot condensé (condensedBatchPath) - priorité haute
     * 2. Synthèse atomique (analysisFilePath) - priorité normale
     * 3. Génération à la volée si aucune synthèse disponible
     *
     * @param taskId ID de la tâche
     * @returns Promise de la synthèse ou null si indisponible
     */
    private async getSummaryForTask(taskId: string): Promise<string | null> {
        try {
            const skeleton = await this.getConversationSkeleton(taskId);
            if (!skeleton) {
                return null;
            }

            // Vérifier si skeleton a les métadonnées de synthèse (extension selon synthesis_models.md)
            const metadata = (skeleton as any).synthesisMetadata;
            if (!metadata) {
                return await this.generateOnDemandSummary(skeleton);
            }

            // 1. Priorité au lot condensé
            if (metadata.condensedBatchPath) {
                return await this.readCondensedBatchSummary(metadata.condensedBatchPath);
            }

            // 2. Synthèse atomique
            if (metadata.analysisFilePath) {
                return await this.readAtomicSynthesis(metadata.analysisFilePath);
            }

            // 3. Génération à la volée
            return await this.generateOnDemandSummary(skeleton);

        } catch (error) {
            console.error(`Erreur lors de la récupération de synthèse pour ${taskId}:`, error);
            return null;
        }
    }

    /**
     * Lit la synthèse d'un lot condensé.
     */
    private async readCondensedBatchSummary(batchPath: string): Promise<string> {
        try {
            const fs = await import('fs/promises');
            const batchContent = await fs.readFile(batchPath, 'utf-8');
            const batch = JSON.parse(batchContent);
            return batch.batchSummary || 'Lot condensé sans résumé';
        } catch (error) {
            console.error(`Erreur lecture lot condensé ${batchPath}:`, error);
            return 'Lot condensé inaccessible';
        }
    }

    /**
     * Lit une synthèse atomique.
     */
    private async readAtomicSynthesis(analysisPath: string): Promise<string> {
        try {
            const fs = await import('fs/promises');
            const analysisContent = await fs.readFile(analysisPath, 'utf-8');
            const analysis = JSON.parse(analysisContent);
            return analysis.finalTaskSummary || 'Synthèse atomique sans résumé';
        } catch (error) {
            console.error(`Erreur lecture synthèse atomique ${analysisPath}:`, error);
            return 'Synthèse atomique inaccessible';
        }
    }

    /**
     * Génère une synthèse à la volée pour une tâche sans synthèse existante.
     */
    private async generateOnDemandSummary(skeleton: ConversationSkeleton): Promise<string> {
        // Utiliser les données réelles de ConversationSkeleton
        const messageCount = skeleton.metadata.messageCount;
        const actionCount = skeleton.metadata.actionCount;
        const workspace = skeleton.metadata.workspace || 'workspace inconnu';
        const mode = skeleton.metadata.mode || 'mode inconnu';
        
        return `[Synthèse à la volée] Tâche ${skeleton.taskId} : ${messageCount} messages, ${actionCount} actions, mode ${mode} dans ${workspace}`;
    }

    /**
     * Détermine si le contexte doit être condensé selon le seuil configuré.
     */
    private shouldCondenseContext(context: string): boolean {
        return context.length > this.options.maxContextSizeBeforeCondensation;
    }

    /**
     * Déclenche la condensation du contexte (placeholder pour Phase 3).
     *
     * En Phase 3, cette méthode fera appel à SynthesisOrchestratorService
     * pour créer un lot de synthèses condensées.
     */
    private async triggerContextCondensation(
        contextSummaries: string[],
        triggerTaskId: string
    ): Promise<string> {
        // TODO Phase 3: Implémenter la vraie condensation avec orchestrateur
        console.log(`Condensation déclenchée pour ${triggerTaskId}, ${contextSummaries.length} éléments`);
        
        // Pour l'instant, on tronque simplement les éléments les plus anciens
        const truncatedContext = contextSummaries.slice(-10).join('\n');
        return `[CONTEXTE CONDENSÉ - ${contextSummaries.length} éléments]\n${truncatedContext}`;
    }
}