/**
 * XmlParsingService - Service de parsing XML robuste pour les appels d'outils
 *
 * Remplace les regex fragiles par un parsing XML structuré
 * Selon l'architecture définie dans docs/sddd/markdown_export_architecture.md
 *
 * Recovered from commit 6afcdfe~1 (Issue #813), adapted to use @xmldom/xmldom
 * instead of fast-xml-parser (removed dependency).
 */

import { DOMParser } from '@xmldom/xmldom';
import { ToolCallDetails } from '../types/enhanced-conversation.js';

/**
 * Result of XML parsing
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

export class XmlParsingService implements IXmlParsingService {
    private domParser: DOMParser;

    constructor() {
        this.domParser = new DOMParser();
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
            const cleanXml = this.cleanXmlContent(xmlContent);
            if (!cleanXml) {
                result.error = 'Contenu XML vide après nettoyage';
                return result;
            }

            if (!this.isValidToolCall(cleanXml)) {
                result.error = 'Contenu ne correspond pas à un appel d\'outil';
                return result;
            }

            // Parse with @xmldom/xmldom
            const doc = this.domParser.parseFromString(cleanXml, 'text/xml');
            const root = doc.documentElement;

            if (!root) {
                result.error = 'Impossible d\'extraire le nom de l\'outil';
                return result;
            }

            result.success = true;
            result.toolName = root.tagName;
            result.arguments = this.extractChildArguments(root);

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
            .trim()
            .replace(/\n\s*\n/g, '\n')
            .replace(/>\s+</g, '><');
    }

    /**
     * Extracts child elements as key-value arguments from an XML element
     */
    private extractChildArguments(element: Element): Record<string, any> {
        const result: Record<string, any> = {};
        const children = element.childNodes;

        for (let i = 0; i < children.length; i++) {
            const child = children[i];
            if (child.nodeType === 1) { // Element node
                const el = child as Element;
                const childChildren = el.childNodes;

                // If the element has only text content
                let hasElementChildren = false;
                for (let j = 0; j < childChildren.length; j++) {
                    if (childChildren[j].nodeType === 1) {
                        hasElementChildren = true;
                        break;
                    }
                }

                if (hasElementChildren) {
                    result[el.tagName] = this.extractChildArguments(el);
                } else {
                    result[el.tagName] = el.textContent || '';
                }
            }
        }

        return result;
    }
}
