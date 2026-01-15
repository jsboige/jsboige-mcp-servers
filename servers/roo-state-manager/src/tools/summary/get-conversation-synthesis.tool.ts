/**
 * MCP Tool pour récupérer la synthèse d'une conversation individuelle
 * 
 * Ce tool expose l'accès aux résultats de synthèse via l'interface MCP,
 * permettant la récupération des analyses formatées à partir du SynthesisOrchestratorService.
 *
 * SDDD Phase 3 : Intégration LLM réelle avec pipeline complet de synthèse
 *
 * @author Roo Code v4 - SDDD Phase 3
 * @version 3.0.0
 */

import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { StateManagerError } from '../../types/errors.js';
import { ConversationAnalysis } from '../../models/synthesis/SynthesisModels.js';
import { ConversationSkeleton } from '../../types/conversation.js';
import { SynthesisOrchestratorService } from '../../services/synthesis/SynthesisOrchestratorService.js';
import { NarrativeContextBuilderService } from '../../services/synthesis/NarrativeContextBuilderService.js';
import { LLMService } from '../../services/synthesis/LLMService.js';
import fs from 'fs/promises';
import path from 'path';
import { RooStorageDetector } from '../../utils/roo-storage-detector.js';

/**
 * Arguments du tool get_conversation_synthesis
 */
export interface GetConversationSynthesisArgs {
    /** ID de la tâche pour laquelle récupérer la synthèse */
    taskId: string;
    
    /** Chemin optionnel pour sauvegarder la sortie. Si omis, le résultat est retourné */
    filePath?: string;
    
    /** Format de sortie : 'json' pour l'objet complet, 'markdown' pour la section narrative */
    outputFormat?: 'json' | 'markdown';
}

/**
 * Définition du tool MCP selon les spécifications de l'API v3
 */
export const getConversationSynthesisTool: Tool = {
    name: "get_conversation_synthesis",
    description: "Récupère ou exporte le résultat de la synthèse pour une seule conversation via LLM réel OpenAI (Phase 3).",
    inputSchema: {
        type: "object",
        properties: {
            taskId: {
                type: "string",
                description: "ID de la tâche pour laquelle récupérer la synthèse"
            },
            filePath: {
                type: "string",
                description: "Chemin optionnel pour sauvegarder la sortie. Si omis, le résultat est retourné."
            },
            outputFormat: {
                type: "string",
                enum: ["json", "markdown"],
                default: "json",
                description: "Le format de sortie. 'markdown' ne retourne que la section narrative finale."
            }
        },
        required: ["taskId"]
    }
};

/**
 * Implémentation du handler pour le tool get_conversation_synthesis
 * 
 * Phase 3 : Intégration LLM réelle avec SynthesisOrchestratorService
 */
export async function handleGetConversationSynthesis(
    args: GetConversationSynthesisArgs,
    getConversationSkeleton: (taskId: string) => Promise<ConversationSkeleton | null>
): Promise<string | ConversationAnalysis> {
    try {
        // Valider les arguments
        if (!args.taskId) {
            throw new StateManagerError(
                'taskId est requis',
                'VALIDATION_FAILED',
                'GetConversationSynthesisTool',
                { missingParam: 'taskId' }
            );
        }

        const outputFormat = args.outputFormat || 'json';
        
        // Phase 3 : Appel au pipeline LLM réel via SynthesisOrchestratorService
        const realAnalysis = await generateRealSynthesis(args.taskId, getConversationSkeleton);
        
        // Si un chemin de fichier est spécifié, écrire dans le fichier
        if (args.filePath) {
            await writeAnalysisToFile(realAnalysis, args.filePath, outputFormat);
            return `✅ Synthèse LLM réelle de la tâche '${args.taskId}' exportée vers '${args.filePath}' au format ${outputFormat}`;
        }
        
        // Sinon retourner le contenu selon le format demandé
        if (outputFormat === 'markdown') {
            return realAnalysis.synthesis.finalTaskSummary;
        } else {
            return realAnalysis;
        }
        
    } catch (error) {
        if (error instanceof StateManagerError) {
            throw error;
        }
        const errorMessage = error instanceof Error ? error.message : 'Erreur inconnue';
        throw new StateManagerError(
            `Erreur lors de la récupération de la synthèse: ${errorMessage}`,
            'SYNTHESIS_RETRIEVAL_FAILED',
            'GetConversationSynthesisTool',
            { taskId: args.taskId, originalError: errorMessage }
        );
    }
}

/**
 * Génère une synthèse réelle via le pipeline LLM complet
 * Phase 3 : Intégration LLM avec SynthesisOrchestratorService
 *
 * @param taskId ID de la tâche pour laquelle générer l'analyse
 * @param getConversationSkeleton Fonction pour récupérer le skeleton de conversation
 * @returns Promise de l'analyse générée par LLM
 */
async function generateRealSynthesis(
    taskId: string,
    getConversationSkeleton: (taskId: string) => Promise<ConversationSkeleton | null>
): Promise<ConversationAnalysis> {
    // Vérifier que la conversation existe
    const skeleton = await getConversationSkeleton(taskId);
    if (!skeleton) {
        throw new StateManagerError(
            `Conversation non trouvée: ${taskId}`,
            'CONVERSATION_NOT_FOUND',
            'GetConversationSynthesisTool',
            { taskId }
        );
    }

    // Instancier les services avec configuration par défaut
    const llmService = new LLMService();
    
    // ✅ SDDD FIX: Créer et peupler le cache avec les vraies conversations
    const conversationCache = new Map<string, ConversationSkeleton>();
    await populateConversationCache(conversationCache);
    
    const contextBuilder = new NarrativeContextBuilderService({
        synthesisBaseDir: '.skeletons/synthesis',
        condensedBatchesDir: '.skeletons/synthesis/batches',
        maxContextSizeBeforeCondensation: 50000,
        defaultMaxDepth: 10
    }, conversationCache);
    
    // Injecter la fonction de récupération des conversations dans le context builder
    // Note: En production, cette fonction sera fournie par le serveur principal
    (contextBuilder as any).getConversationSkeleton = getConversationSkeleton;
    
    const orchestrator = new SynthesisOrchestratorService(contextBuilder, llmService, {
        synthesisOutputDir: '.skeletons/synthesis',
        maxContextSize: 50000,
        maxConcurrency: 3,
        defaultLlmModel: 'gpt-4-turbo-synthesis'
    });

    try {
        // Appel du pipeline complet : contexte + LLM
        console.log(`🚀 [MCP Tool] Démarrage synthèse LLM pour ${taskId}...`);
        const analysis = await orchestrator.synthesizeConversation(taskId);
        console.log(`✅ [MCP Tool] Synthèse LLM terminée pour ${taskId}`);
        
        return analysis;
        
    } catch (error) {
        console.error(`❌ [MCP Tool] Erreur synthèse ${taskId}:`, error);
        
        // Fallback : retourner une analyse d'erreur cohérente
        const fallbackAnalysis: ConversationAnalysis = {
            taskId,
            analysisEngineVersion: "3.0.0-error",
            analysisTimestamp: new Date().toISOString(),
            llmModelId: "error-fallback",
            contextTrace: {
                rootTaskId: taskId,
                parentTaskId: undefined,
                previousSiblingTaskIds: []
            },
            objectives: { error: true, message: error instanceof Error ? error.message : 'Unknown error' },
            strategy: { error: true },
            quality: { error: true },
            metrics: { error: error instanceof Error ? error.message : 'Unknown error' },
            synthesis: {
                initialContextSummary: "Erreur lors de la construction du contexte narratif",
                finalTaskSummary: `Erreur lors de la synthèse LLM: ${error instanceof Error ? error.message : 'Unknown error'}`
            }
        };
        
        return fallbackAnalysis;
    }
}

/**
 * DEPRECATED: Génère une analyse MOCK (conservée pour référence)
 * Remplacée par generateRealSynthesis() en Phase 3
 */
async function generateMockAnalysis(taskId: string): Promise<ConversationAnalysis> {
    const timestamp = new Date().toISOString();
    
    // Générer des données MOCK cohérentes avec SynthesisModels.ts
    const mockAnalysis: ConversationAnalysis = {
        // Métadonnées de l'analyse
        taskId: taskId,
        analysisEngineVersion: "1.0.0-mock",
        analysisTimestamp: timestamp,
        llmModelId: "gpt-4-mock",
        
        // Trace de contexte (MOCK)
        contextTrace: {
            rootTaskId: generateMockRootTaskId(taskId),
            parentTaskId: generateMockParentTaskId(taskId),
            previousSiblingTaskIds: generateMockSiblingIds(taskId, 2)
        },
        
        // Sections d'analyse structurée (MOCK)
        objectives: {
            primaryGoal: "Résoudre un problème technique spécifique",
            secondaryGoals: ["Documenter la solution", "Tester l'implémentation"],
            complexityLevel: "medium",
            estimatedDuration: "2-4 heures"
        },
        
        strategy: {
            approach: "Analyse systématique et implémentation incrémentale",
            methodology: "SDDD (Semantic-Documentation-Driven-Design)",
            toolsUsed: ["codebase_search", "read_file", "apply_diff", "write_to_file"],
            phasedExecution: true
        },
        
        quality: {
            completionScore: 8.5,
            codeQuality: "high",
            documentationQuality: "excellent",
            testCoverage: "good",
            adherenceToPatterns: "excellent"
        },
        
        metrics: {
            totalMessages: 47,
            userMessages: 12,
            assistantMessages: 35,
            toolCallsCount: 28,
            filesModified: 5,
            linesOfCodeAdded: 342,
            linesOfCodeModified: 89,
            timeSpent: "3h 25m",
            tokenUsage: {
                input: 45230,
                output: 12890,
                total: 58120
            }
        },
        
        // Synthèse narrative incrémentale
        synthesis: {
            initialContextSummary: generateMockInitialContext(taskId),
            finalTaskSummary: generateMockFinalSummary(taskId)
        }
    };
    
    return mockAnalysis;
}

/**
 * Génère un contexte initial MOCK réaliste
 */
function generateMockInitialContext(taskId: string): string {
    return `
**Contexte Narratif Initial pour ${taskId}**

Cette tâche s'inscrit dans le cadre du développement du système de synthèse de conversations Roo. 
Le contexte préalable indique une architecture modulaire établie avec des services existants 
(TraceSummaryService, ExportConfigManager) suivant des patterns bien définis.

**Éléments de contexte collectés :**
- Architecture existante validée et documentée
- Patterns de développement TypeScript identifiés et respectés  
- Structure des services avec injection de dépendances confirmée
- Outils MCP avec pattern dual export (définition + handler) établi

**Objectifs contextuels :**
L'implémentation doit s'intégrer transparently dans l'écosystème existant sans rupture 
de compatibilité, en respectant scrupuleusement les conventions architecturales observées.
`.trim();
}

/**
 * Génère un résumé final MOCK réaliste
 */
function generateMockFinalSummary(taskId: string): string {
    return `
**Synthèse Finale - Phase 1 : Implémentation Squelette MCP Synthèse**

**Réalisations accomplies :**
✅ **Architecture intégrée** : Tous les composants suivent les patterns existants (singleton, DI, dual export)
✅ **Modèles de données** : SynthesisModels.ts complet avec 15+ interfaces TypeScript documentées
✅ **Services squelette** : 3 services créés (SynthesisOrchestrator, NarrativeContextBuilder, LLMService)
✅ **Outil MCP fonctionnel** : get_conversation_synthesis implémenté avec version MOCK
✅ **Documentation SDDD** : Traçabilité complète des décisions et découvertes architecturales

**Qualité technique :**
- **Respect des patterns** : 100% conforme aux conventions roo-state-manager
- **Documentation** : JSDoc complet sur toutes les interfaces et méthodes publiques
- **Structure modulaire** : Organisation claire models/services/tools selon architecture cible
- **Extensibilité** : Conception préparée pour les phases 2-4 d'implémentation

**Impact stratégique :**
Cette phase établit les fondations solides pour l'implémentation complète du système de synthèse. 
L'intégration transparente dans l'architecture existante garantit la maintenabilité et l'évolutivité.
La validation MCP confirme que l'infrastructure est opérationnelle pour les phases suivantes.

**Prochaines étapes recommandées :**
- Phase 2 : Implémentation de la construction de contexte narratif
- Phase 3 : Intégration LLM avec openai-node
- Phase 4 : Traitement par lots et exports avancés

*Note : Cette synthèse est générée par la version MOCK Phase 1 à des fins de validation d'infrastructure.*
`.trim();
}

/**
 * Écrit l'analyse dans un fichier selon le format spécifié
 */
async function writeAnalysisToFile(
    analysis: ConversationAnalysis,
    filePath: string,
    format: 'json' | 'markdown'
): Promise<void> {
    // Créer le répertoire si nécessaire
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    
    let content: string;
    
    if (format === 'markdown') {
        content = `# Synthèse de Conversation - ${analysis.taskId}

**Analyse générée le :** ${analysis.analysisTimestamp}  
**Moteur :** ${analysis.analysisEngineVersion}  
**Modèle LLM :** ${analysis.llmModelId}

---

## Contexte Initial

${analysis.synthesis.initialContextSummary}

---

## Synthèse Finale

${analysis.synthesis.finalTaskSummary}

---

## Métriques

- **Messages totaux :** ${analysis.metrics.totalMessages}
- **Fichiers modifiés :** ${analysis.metrics.filesModified || 'N/A'}
- **Temps estimé :** ${analysis.metrics.timeSpent || 'N/A'}
- **Score de qualité :** ${analysis.quality.completionScore}/10

---

*Synthèse générée automatiquement par roo-state-manager MCP Synthesis v${analysis.analysisEngineVersion}*
`;
    } else {
        content = JSON.stringify(analysis, null, 2);
    }
    
    await fs.writeFile(filePath, content, 'utf-8');
}

// =========================================================================
// FONCTIONS UTILITAIRES MOCK
// =========================================================================

/**
 * Génère un ID de tâche racine MOCK
 */
function generateMockRootTaskId(taskId: string): string {
    // Simuler une relation hiérarchique cohérente
    return `root_${taskId.substring(0, 8)}_main`;
}

/**
 * Génère un ID de tâche parent MOCK
 */
function generateMockParentTaskId(taskId: string): string | undefined {
    // 70% des tâches ont un parent dans la simulation
    return Math.random() > 0.3 ? `parent_${taskId.substring(0, 6)}_ctx` : undefined;
}

/**
 * Génère des IDs de tâches sœurs MOCK
 */
function generateMockSiblingIds(taskId: string, count: number): string[] {
    const siblings: string[] = [];
    for (let i = 0; i < count; i++) {
        siblings.push(`sibling_${taskId.substring(0, 6)}_${i + 1}`);
    }
    return siblings;
}

/**
 * SDDD Phase 3 FIX: Popule le cache de conversations avec la même logique que le serveur principal
 * Basé sur handleBuildSkeletonCache() du serveur principal (index.ts:894)
 *
 * @param conversationCache Cache à peupler
 */
async function populateConversationCache(conversationCache: Map<string, ConversationSkeleton>): Promise<void> {
    console.log('🔄 [SDDD FIX] Chargement du cache des conversations...');
    
    try {
        const locations = await RooStorageDetector.detectStorageLocations();
        if (locations.length === 0) {
            console.warn('⚠️ Aucun emplacement de stockage Roo détecté');
            return;
        }

        let totalLoaded = 0;
        const SKELETON_CACHE_DIR_NAME = '.skeletons';
        
        for (const location of locations) {
            const skeletonsCacheDir = path.join(location, SKELETON_CACHE_DIR_NAME);
            
            try {
                const skeletonFiles = await fs.readdir(skeletonsCacheDir);
                const jsonFiles = skeletonFiles.filter(file => file.endsWith('.json'));
                
                for (const fileName of jsonFiles) {
                    const skeletonPath = path.join(skeletonsCacheDir, fileName);
                    
                    try {
                        let skeletonContent = await fs.readFile(skeletonPath, 'utf-8');
                        
                        // Supprimer le BOM UTF-8 si présent (même logique que le serveur)
                        if (skeletonContent.charCodeAt(0) === 0xFEFF) {
                            skeletonContent = skeletonContent.slice(1);
                        }
                        
                        const skeleton: ConversationSkeleton = JSON.parse(skeletonContent);
                        if (skeleton && skeleton.taskId) {
                            conversationCache.set(skeleton.taskId, skeleton);
                            totalLoaded++;
                        }
                    } catch (parseError) {
                        console.warn(`⚠️ Erreur parsing skeleton ${fileName}:`, parseError);
                    }
                }
            } catch (readError) {
                console.warn(`⚠️ Impossible de lire le dossier ${skeletonsCacheDir}:`, readError);
            }
        }
        
        console.log(`✅ [SDDD FIX] Cache chargé avec ${totalLoaded} conversations (trouvées dans ${locations.length} emplacements)`);
        
    } catch (error) {
        console.error('❌ [SDDD FIX] Erreur lors du chargement du cache:', error);
    }
}