/**
 * XmlParsingService - Service de parsing XML robuste pour les appels d'outils
 * 
 * Remplace les regex fragiles par un parsing XML structuré
 * Selon l'architecture définie dans docs/sddd/markdown_export_architecture.md
 */

import { XMLParser } from 'fast-xml-parser';
import { 
    IXmlParsingService, 
    XmlParsingResult, 
    ToolCallDetails 
} from '../types/enhanced-conversation.js';

export class XmlParsingService implements IXmlParsingService {
    private xmlParser: XMLParser;
    
    constructor() {
        this.xmlParser = new XMLParser({
            ignoreAttributes: false,
            attributeNamePrefix: '@_',
            textNodeName: '#text',
            parseTagValue: false, // Préserver les valeurs comme strings
            trimValues: true,
            removeNSPrefix: false
        });
    }

    /**
     * Parse un appel d'outil XML et retourne les détails structurés
     */
    parseToolCall(xmlContent: string): XmlParsingResult {
        const result: XmlParsingResult = {
            success: false,
            rawContent: xmlContent
        };

        try {
            // Nettoyer le contenu XML
            const cleanXml = this.cleanXmlContent(xmlContent);
            if (!cleanXml) {
                result.error = 'Contenu XML vide après nettoyage';
                return result;
            }

            // Détecter si c'est un appel d'outil
            if (!this.isValidToolCall(cleanXml)) {
                result.error = 'Contenu ne correspond pas à un appel d\'outil';
                return result;
            }

            // Parser le XML
            const parsed = this.xmlParser.parse(cleanXml);
            
            // Extraire le nom de l'outil et les arguments
            const toolInfo = this.extractToolInfo(parsed);
            if (!toolInfo.toolName) {
                result.error = 'Impossible d\'extraire le nom de l\'outil';
                return result;
            }

            result.success = true;
            result.toolName = toolInfo.toolName;
            result.arguments = toolInfo.arguments || {};

        } catch (error) {
            result.error = `Erreur de parsing XML: ${error instanceof Error ? error.message : String(error)}`;
        }

        return result;
    }

    /**
     * Vérifie si le contenu ressemble à un appel d'outil XML
     */
    isValidToolCall(content: string): boolean {
        if (!content || typeof content !== 'string') {
            return false;
        }

        // Patterns typiques d'appels d'outils dans Roo
        const toolCallPatterns = [
            /<\s*read_file\s*>/,
            /<\s*write_to_file\s*>/,
            /<\s*apply_diff\s*>/,
            /<\s*execute_command\s*>/,
            /<\s*search_files\s*>/,
            /<\s*list_files\s*>/,
            /<\s*browser_action\s*>/,
            /<\s*codebase_search\s*>/,
            /<\s*use_mcp_tool\s*>/,
            // Pattern générique pour tout outil avec structure XML
            /<\s*\w+\s*>[\s\S]*<\/\s*\w+\s*>/
        ];

        return toolCallPatterns.some(pattern => pattern.test(content));
    }

    /**
     * Extrait le nom de l'outil depuis le contenu XML
     */
    extractToolName(xmlContent: string): string | null {
        try {
            const cleanXml = this.cleanXmlContent(xmlContent);
            if (!cleanXml) return null;

            // Chercher la première balise XML
            const tagMatch = cleanXml.match(/<\s*(\w+)[\s>]/);
            return tagMatch ? tagMatch[1] : null;
        } catch {
            return null;
        }
    }

    /**
     * Extrait les arguments depuis le contenu XML
     */
    extractArguments(xmlContent: string): Record<string, any> | null {
        try {
            const parseResult = this.parseToolCall(xmlContent);
            return parseResult.success ? (parseResult.arguments || {}) : null;
        } catch {
            return null;
        }
    }

    /**
     * Crée un ToolCallDetails enrichi
     */
    createToolCallDetails(xmlContent: string): ToolCallDetails {
        const parseResult = this.parseToolCall(xmlContent);
        
        return {
            toolName: parseResult.toolName || 'unknown',
            arguments: parseResult.arguments || {},
            rawXml: xmlContent,
            parseSuccess: parseResult.success,
            parseError: parseResult.error
        };
    }

    /**
     * Nettoie le contenu XML pour le parsing
     */
    private cleanXmlContent(content: string): string {
        if (!content) return '';

        return content
            // Enlever les espaces en début/fin
            .trim()
            // Enlever les retours à la ligne excessifs
            .replace(/\n\s*\n/g, '\n')
            // Conserver la structure XML mais nettoyer
            .replace(/>\s+</g, '><');
    }

    /**
     * Extrait les informations de l'outil depuis l'objet parsé
     */
    private extractToolInfo(parsed: any): { toolName?: string; arguments?: Record<string, any> } {
        if (!parsed || typeof parsed !== 'object') {
            return {};
        }

        // Trouver la première clé qui correspond à un nom d'outil
        const keys = Object.keys(parsed);
        if (keys.length === 0) {
            return {};
        }

        const toolName = keys[0];
        const toolData = parsed[toolName];

        // Si toolData est un objet, l'utiliser comme arguments
        if (toolData && typeof toolData === 'object') {
            return {
                toolName,
                arguments: this.flattenArguments(toolData)
            };
        }

        return { toolName, arguments: {} };
    }

    /**
     * Aplatit les arguments parsés en un objet simple
     */
    private flattenArguments(data: any): Record<string, any> {
        if (!data || typeof data !== 'object') {
            return {};
        }

        const result: Record<string, any> = {};

        for (const [key, value] of Object.entries(data)) {
            // Ignorer les métadonnées XML
            if (key.startsWith('@_') || key === '#text') {
                continue;
            }

            // Si c'est un objet avec juste #text, prendre la valeur text
            if (value && typeof value === 'object' && '#text' in value) {
                result[key] = (value as any)['#text'];
            } else if (typeof value === 'object' && value !== null) {
                // Récursion pour les objets imbriqués
                const nested = this.flattenArguments(value);
                if (Object.keys(nested).length > 0) {
                    result[key] = nested;
                } else {
                    result[key] = value;
                }
            } else {
                result[key] = value;
            }
        }

        return result;
    }
}