/**
 * Analyseur de workspace pour la détection automatique des workspaces
 * Phase 1 : Fondations et analyse de l'arborescence de tâches
 */
import { WorkspaceAnalysis } from '../types/task-tree.js';
import { ConversationSummary } from '../types/conversation.js';
export declare class WorkspaceAnalyzer {
    private static readonly TECH_INDICATORS;
    private static readonly WORKSPACE_INDICATORS;
    private static readonly MIN_CONVERSATIONS_FOR_WORKSPACE;
    private static readonly MIN_CONFIDENCE_THRESHOLD;
    /**
     * Analyse les conversations pour détecter les workspaces
     */
    static analyzeWorkspaces(conversations: ConversationSummary[]): Promise<WorkspaceAnalysis>;
    /**
     * Extrait les patterns de fichiers des conversations
     */
    private static extractFilePatterns;
    /**
     * Détecte la technologie associée à un pattern
     */
    private static detectTechnologyFromPattern;
    /**
     * Détecte les préfixes communs dans les chemins de fichiers
     */
    private static detectCommonPrefixes;
    /**
     * Détermine si un préfixe est un candidat workspace
     */
    private static isWorkspaceCandidate;
    /**
     * Clustering par similarité de chemins
     */
    private static clusterBySimilarity;
    /**
     * Calcule la confiance d'un préfixe
     */
    private static calculatePrefixConfidence;
    /**
     * Vérifie si deux préfixes sont similaires
     */
    private static areSimilarPrefixes;
    /**
     * Génère les candidats workspace à partir des clusters
     */
    private static generateWorkspaceCandidates;
    /**
     * Détecte les technologies utilisées dans un ensemble de chemins
     */
    private static detectTechnologies;
    /**
     * Génère un nom de workspace à partir du chemin
     */
    private static generateWorkspaceName;
    /**
     * Valide et score les candidats workspace
     */
    private static validateWorkspaceCandidates;
    /**
     * Calcule les métriques de qualité de l'analyse
     */
    private static calculateQualityMetrics;
}
//# sourceMappingURL=workspace-analyzer.d.ts.map