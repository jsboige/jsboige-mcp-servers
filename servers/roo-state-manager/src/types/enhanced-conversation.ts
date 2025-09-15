/**
 * Types étendus pour l'architecture d'export Markdown améliorée
 * Selon le plan architectural défini dans docs/sddd/markdown_export_architecture.md
 */

/**
 * Niveaux de détail pour l'export Markdown selon script PowerShell référence
 */
export type DetailLevel = 'Full' | 'NoTools' | 'NoResults' | 'Messages' | 'Summary' | 'UserOnly';

/**
 * Détails structurés d'un appel d'outil parsé depuis XML
 */
export interface ToolCallDetails {
    toolName: string;
    arguments: Record<string, any>;
    rawXml: string;
    parseSuccess: boolean;
    parseError?: string;
}

/**
 * Détails structurés d'un résultat d'outil
 */
export interface ToolResultDetails {
    success: boolean;
    outputSize: number;
    resultType: 'text' | 'file' | 'error' | 'json' | 'html';
    truncated: boolean;
    originalLength?: number;
    errorMessage?: string;
}

/**
 * Contenu classifié enrichi avec parsing structuré
 */
export interface ClassifiedContent {
    type: 'User' | 'Assistant';
    subType: 'UserMessage' | 'ToolResult' | 'ToolCall' | 'Completion' | 'Thinking';
    content: string;
    index: number;
    
    // Propriétés existantes pour compatibility
    toolType?: string;
    resultType?: string;
    
    // Nouvelles propriétés enrichies selon l'architecture
    toolCallDetails?: ToolCallDetails;
    toolResultDetails?: ToolResultDetails;
    
    // Métadonnées pour le filtrage intelligent
    contentSize: number;
    isRelevant: boolean;
    confidenceScore: number;
}

/**
 * Configuration pour le pipeline de génération
 */
export interface PipelineConfig {
    useNewPipeline: boolean;
    debugMode: boolean;
    xmlParsingEnabled: boolean;
    smartFilteringEnabled: boolean;
}

/**
 * Résultat du parsing XML d'un appel d'outil
 */
export interface XmlParsingResult {
    success: boolean;
    toolName?: string;
    arguments?: Record<string, any>;
    error?: string;
    rawContent: string;
}

/**
 * Interface pour les services de parsing XML
 */
export interface IXmlParsingService {
    parseToolCall(xmlContent: string): XmlParsingResult;
    isValidToolCall(content: string): boolean;
    extractToolName(xmlContent: string): string | null;
    extractArguments(xmlContent: string): Record<string, any> | null;
}

/**
 * Interface pour l'enrichissement de contenu
 */
export interface IEnrichContentClassifier {
    enrichContent(rawContent: ClassifiedContent[]): Promise<ClassifiedContent[]>;
    classifyToolCall(content: string, index: number): Promise<ClassifiedContent>;
    classifyToolResult(content: string, index: number): Promise<ClassifiedContent>;
    calculateRelevanceScore(content: ClassifiedContent): number;
}

/**
 * Résultat du filtrage par les stratégies de reporting
 */
export interface FilteringResult {
    filteredContent: string[];
    statistics: FilteringStatistics;
    appliedRules: string[];
}

/**
 * Statistiques de filtrage
 */
export interface FilteringStatistics {
    included: number;
    excluded: number;
    inclusionRate: number;
    strategy: string;
}

/**
 * Options étendues pour la génération de résumés
 */
export interface EnhancedSummaryOptions {
    detailLevel?: 'Full' | 'NoTools' | 'NoResults' | 'Messages' | 'Summary' | 'UserOnly';
    outputFormat?: 'markdown' | 'html' | 'text';
    truncationChars?: number;
    compactStats?: boolean;
    includeCss?: boolean;
    generateToc?: boolean;
    includeMetadata?: boolean;
    includeTimestamps?: boolean;
    enhancementFlags?: {
        useEnhancedClassification?: boolean;
        useStrategyFiltering?: boolean;
        useSmartCleaning?: boolean;
        useAdvancedRendering?: boolean;
        preserveLegacyBehavior?: boolean;
    };
}