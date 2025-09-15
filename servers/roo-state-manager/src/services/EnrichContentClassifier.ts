/**
 * EnrichContentClassifier - Service de classification enrichie du contenu
 * 
 * Ce service remplace la logique simple de classification par une approche
 * plus sophistiquée qui utilise parsing XML, métadonnées et scoring de confiance.
 * Selon l'architecture définie dans docs/sddd/markdown_export_architecture.md
 */

import { ClassifiedContent, ToolCallDetails, ToolResultDetails } from '../types/enhanced-conversation.js';
import { ConversationSkeleton, MessageSkeleton } from '../types/conversation.js';
import { XmlParsingService } from './XmlParsingService.js';

export class EnrichContentClassifier {
    private xmlParser: XmlParsingService;

    constructor() {
        this.xmlParser = new XmlParsingService();
    }

    /**
     * Méthode publique pour classifier une conversation complète
     */
    async classifyConversationContent(conversation: ConversationSkeleton): Promise<ClassifiedContent[]> {
        const classified: ClassifiedContent[] = [];
        let index = 0;

        // Filtrer seulement les MessageSkeleton de la sequence
        const messages = conversation.sequence.filter((item): item is MessageSkeleton =>
            'role' in item && 'content' in item);

        for (const message of messages) {
            const classifiedMessage = await this.classifyMessage(message.content, message.role, index++);
            classified.push(classifiedMessage);
        }

        return classified;
    }

    /**
     * Classifie un message individuel avec enrichissement
     */
    async classifyMessage(content: string, role: 'user' | 'assistant', index: number): Promise<ClassifiedContent> {
        const contentSize = content.length;
        let type: 'User' | 'Assistant';
        let subType: 'UserMessage' | 'ToolResult' | 'ToolCall' | 'Completion' | 'Thinking';
        let toolCallDetails: ToolCallDetails | undefined;
        let toolResultDetails: ToolResultDetails | undefined;
        let isRelevant = true;
        let confidenceScore = 1.0;

        // Classification de base par rôle
        if (role === 'user') {
            type = 'User';
            
            // Détecter si c'est un résultat d'outil
            if (this.isToolResult(content)) {
                subType = 'ToolResult';
                toolResultDetails = this.extractToolResultDetails(content);
                confidenceScore = 0.95; // Très haute confiance pour les patterns reconnus
            } else {
                subType = 'UserMessage';
                confidenceScore = 0.9;
            }
        } else {
            type = 'Assistant';
            
            // Détecter les différents types de messages assistant
            if (this.isCompletionMessage(content)) {
                subType = 'Completion';
                confidenceScore = 0.98; // Très haute confiance - pattern très spécifique
            } else if (this.isThinkingMessage(content)) {
                subType = 'Thinking';
                confidenceScore = 0.85; // Moins spécifique
            } else if (this.hasToolCalls(content)) {
                subType = 'ToolCall';
                toolCallDetails = await this.extractToolCallDetails(content);
                confidenceScore = toolCallDetails?.parseSuccess ? 0.92 : 0.7;
            } else {
                subType = 'Completion'; // Par défaut
                confidenceScore = 0.8;
            }
        }

        // Évaluer la pertinence
        isRelevant = this.evaluateRelevance(content, subType, contentSize);

        // Ajuster le score de confiance selon la qualité du contenu
        confidenceScore = this.adjustConfidenceScore(confidenceScore, content, contentSize);

        return {
            type,
            subType,
            content,
            index,
            contentSize,
            isRelevant,
            confidenceScore,
            toolCallDetails,
            toolResultDetails
        };
    }

    /**
     * Détecte si un message est un résultat d'outil
     */
    private isToolResult(content: string): boolean {
        return /\[[^\]]+\]\s*Result:/i.test(content) || 
               /Command executed/i.test(content) ||
               /<file_write_result>/i.test(content) ||
               /Browser.*action/i.test(content);
    }

    /**
     * Détecte si un message assistant est une completion
     */
    private isCompletionMessage(content: string): boolean {
        return /<attempt_completion>/i.test(content);
    }

    /**
     * Détecte si un message contient des balises de réflexion
     */
    private isThinkingMessage(content: string): boolean {
        return /<thinking>/i.test(content) || 
               /^\s*Je\s+(vais|dois|pense)/i.test(content);
    }

    /**
     * Détecte la présence d'appels d'outils
     */
    private hasToolCalls(content: string): boolean {
        return /<\w+_\w+>[\s\S]*?<\/\w+_\w+>/i.test(content) ||
               /<read_file>/i.test(content) ||
               /<write_to_file>/i.test(content) ||
               /<execute_command>/i.test(content);
    }

    /**
     * Extrait les détails des appels d'outils avec parsing XML
     */
    private async extractToolCallDetails(content: string): Promise<ToolCallDetails> {
        try {
            const toolCallMatch = content.match(/<(\w+)>([\s\S]*?)<\/\1>/);
            if (!toolCallMatch) {
                return {
                    toolName: 'unknown',
                    arguments: {},
                    rawXml: '',
                    parseSuccess: false,
                    parseError: 'No tool call pattern found'
                };
            }

            const toolName = toolCallMatch[1];
            const rawXml = toolCallMatch[0];

            // Utiliser le service XML pour parser les arguments
            const parseResult = await this.xmlParser.parseToolCall(rawXml);
            
            return {
                toolName,
                arguments: parseResult.arguments || {},
                rawXml,
                parseSuccess: parseResult.success,
                parseError: parseResult.error
            };
        } catch (error) {
            return {
                toolName: 'error',
                arguments: {},
                rawXml: content.substring(0, 200),
                parseSuccess: false,
                parseError: error instanceof Error ? error.message : 'Unknown parsing error'
            };
        }
    }

    /**
     * Extrait les détails des résultats d'outils
     */
    private extractToolResultDetails(content: string): ToolResultDetails {
        let success = true;
        let resultType: 'text' | 'file' | 'error' | 'json' | 'html' = 'text';
        let truncated = false;
        let originalLength: number | undefined;
        let errorMessage: string | undefined;

        // Déterminer le type de résultat
        if (/<files>/i.test(content)) {
            resultType = 'file';
        } else if (/<file_write_result>/i.test(content)) {
            resultType = 'file';
        } else if (/Command executed/i.test(content)) {
            resultType = 'text';
        } else if (/{[\s\S]*}/i.test(content)) {
            resultType = 'json';
        } else if (/<html/i.test(content)) {
            resultType = 'html';
        }

        // Détecter les erreurs
        if (/error|failed|unable/i.test(content)) {
            success = false;
            resultType = 'error';
            const errorMatch = content.match(/error:\s*([^\n]+)/i);
            errorMessage = errorMatch ? errorMatch[1].trim() : 'Unknown error';
        }

        // Détecter la troncature
        if (/truncated|\.{3}|…/.test(content) || content.includes('...')) {
            truncated = true;
            // Essayer d'extraire la longueur originale si mentionnée
            const lengthMatch = content.match(/(\d+)\s*(characters?|chars?|bytes?)/i);
            originalLength = lengthMatch ? parseInt(lengthMatch[1]) : undefined;
        }

        return {
            success,
            outputSize: content.length,
            resultType,
            truncated,
            originalLength,
            errorMessage
        };
    }

    /**
     * Évalue la pertinence d'un contenu
     */
    private evaluateRelevance(content: string, subType: string, contentSize: number): boolean {
        // Contenu trop court généralement peu pertinent
        if (contentSize < 10) return false;

        // Messages de debug ou logs techniques moins pertinents
        if (/^debug|^log:|console\./i.test(content.trim())) return false;

        // Environment details souvent peu pertinents pour le résumé
        if (/<environment_details>/i.test(content)) return false;

        // Messages d'erreur sont pertinents
        if (subType === 'ToolResult' && /error|failed/i.test(content)) return true;

        // Completion toujours pertinente
        if (subType === 'Completion') return true;

        return true; // Par défaut pertinent
    }

    /**
     * Ajuste le score de confiance selon la qualité
     */
    private adjustConfidenceScore(baseScore: number, content: string, contentSize: number): number {
        let adjustedScore = baseScore;

        // Pénaliser le contenu très court
        if (contentSize < 20) adjustedScore *= 0.8;
        
        // Pénaliser le contenu très long qui pourrait être du bruit
        if (contentSize > 10000) adjustedScore *= 0.9;

        // Récompenser le contenu bien structuré
        if (/^#|^\*\*|^-/.test(content.trim())) adjustedScore *= 1.1;

        // Pénaliser les messages répétitifs
        const words = content.toLowerCase().split(/\s+/);
        const uniqueWords = new Set(words);
        if (words.length > 10 && uniqueWords.size / words.length < 0.3) {
            adjustedScore *= 0.7; // Beaucoup de répétitions
        }

        // S'assurer que le score reste dans [0, 1]
        return Math.max(0, Math.min(1, adjustedScore));
    }
}