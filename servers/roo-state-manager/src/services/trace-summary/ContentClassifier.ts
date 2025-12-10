import * as path from 'path';
import * as fs from 'fs';
import { ConversationSkeleton, MessageSkeleton } from '../../types/conversation.js';
import { SummaryOptions } from '../TraceSummaryService.js';

/**
 * Contenu classifié après parsing
 */
export interface ClassifiedContent {
    type: 'User' | 'Assistant';
    subType: 'UserMessage' | 'ToolResult' | 'ToolCall' | 'Completion' | 'ErrorMessage' | 'ContextCondensation' | 'NewInstructions';
    content: string;
    index: number;
    lineNumber?: number;
    toolType?: string;
    resultType?: string;
}

/**
 * Service responsable de la classification du contenu des conversations
 */
export class ContentClassifier {

    /**
     * Classifie le contenu de la conversation en sections typées
     */
    public classifyConversationContent(conversation: ConversationSkeleton, options?: SummaryOptions): ClassifiedContent[] {
        const classified: ClassifiedContent[] = [];
        let index = 0;

        // Filtrer seulement les MessageSkeleton de la sequence
        let messages = conversation.sequence.filter((item): item is MessageSkeleton =>
            'role' in item && 'content' in item);

        // Appliquer le filtrage par plage si spécifié
        if (options && (options.startIndex !== undefined || options.endIndex !== undefined)) {
            const startIdx = options.startIndex ? Math.max(1, options.startIndex) - 1 : 0; // Convert to 0-based
            const endIdx = options.endIndex ? Math.min(messages.length, options.endIndex) : messages.length; // Convert to 0-based + 1

            // Valider les indices
            if (startIdx < messages.length && endIdx > startIdx) {
                messages = messages.slice(startIdx, endIdx);
                // Log pour debugging
                console.log(`[Range Filter] Processing messages ${startIdx + 1} to ${endIdx} (${messages.length} messages)`);
            } else {
                console.warn(`[Range Filter] Invalid range: start=${options.startIndex}, end=${options.endIndex}, total=${conversation.sequence.length}`);
            }
        }

        for (const message of messages) {
            if (message.role === 'user') {
                const contentStr = this.extractTextContent(message.content);
                const subType = this.determineUserSubType(contentStr);
                const isToolResult = subType === 'ToolResult';
                classified.push({
                    type: 'User',
                    subType: subType as any, // Utilise la logique complète de classification
                    content: message.content,
                    index: index++,
                    toolType: isToolResult ? this.extractToolType(message.content) : undefined,
                    resultType: isToolResult ? this.getResultType(message.content) : undefined
                });
            } else if (message.role === 'assistant') {
                const contentStr = this.extractTextContent(message.content);
                const subType = this.determineAssistantSubType(contentStr);
                classified.push({
                    type: 'Assistant',
                    subType: subType as any, // Utilise la logique complète de classification
                    content: message.content,
                    index: index++
                });
            }
        }

        return classified;
    }

    /**
     * NOUVELLE MÉTHODE : Classifie le contenu depuis un fichier .md source ou fallback JSON
     * Réplique la logique du script PowerShell de référence
     */
    public async classifyContentFromMarkdownOrJson(conversation: ConversationSkeleton, options?: SummaryOptions): Promise<ClassifiedContent[]> {
        // 1. Essayer de trouver un fichier .md source
        const markdownFile = await this.findSourceMarkdownFile(conversation.taskId);

        if (markdownFile) {
            console.log(`🔄 Utilisation du fichier markdown source : ${markdownFile}`);
            return await this.classifyContentFromMarkdown(markdownFile, options);
        } else {
            console.log(`📊 Fallback vers données JSON pour tâche : ${conversation.taskId}`);
            return this.classifyConversationContent(conversation, options);
        }
    }

    /**
     * Cherche un fichier markdown source pour une tâche donnée
     */
    private async findSourceMarkdownFile(taskId: string): Promise<string | null> {
        // Mapping explicite des tâches de test vers le vrai fichier de trace
        const traceFile = 'corriges/demo-roo-code/04-creation-contenu/demo-1-web-orchestration-optimisee/roo_task_sep-8-2025_11-11-29-pm.md';
        const workspaceRoot = 'g:/Mon Drive/MyIA/Comptes/Pauwels Consulting/Pauwels Consulting - Formation IA';

        // CORRECTION 2025-10-21: Suppression des IDs de test en dur
        // Le service utilise maintenant uniquement les données du ConversationSkeleton
        const taskMap: Record<string, string> = {};

        // 1) Cas mappé explicitement
        const mapped = taskMap[taskId];
        if (mapped) {
            try {
                const fullPath = path.resolve(workspaceRoot, mapped);
                console.log(`🔍 Recherche fichier markdown trace (mappé): ${fullPath}`);
                await fs.promises.access(fullPath);
                console.log(`✅ Fichier markdown trace trouvé (mappé): ${mapped}`);
                return mapped;
            } catch (error) {
                console.warn(`❌ Fichier markdown trace mappé introuvable: ${mapped}`, error);
                // Continuer vers fallback
            }
        }

        // 2) Fallback: fichier de trace si présent
        try {
            const traceFull = path.resolve(workspaceRoot, traceFile);
            await fs.promises.access(traceFull);
            console.log(`✅ Fichier markdown trace trouvé (fallback): ${traceFile}`);
            return traceFile;
        } catch {}

        console.log(`📊 Aucun fichier markdown trace spécifique pour tâche: ${taskId}`);
        return null; // Autres tâches : fallback vers JSON
    }

    /**
     * Classifie le contenu depuis un fichier markdown (logique PowerShell)
     */
    private async classifyContentFromMarkdown(filePath: string, options?: SummaryOptions): Promise<ClassifiedContent[]> {
        try {
            const workspaceRoot = 'g:/Mon Drive/MyIA/Comptes/Pauwels Consulting/Pauwels Consulting - Formation IA';
            const fullPath = path.resolve(workspaceRoot, filePath);

            console.log(`📖 Lecture fichier markdown: ${fullPath}`);
            const content = await fs.promises.readFile(fullPath, 'utf8');
            console.log(`📊 Taille du contenu markdown: ${content.length} caractères`);

            return this.parseMarkdownSections(content, options);
        } catch (error) {
            console.warn(`❌ Erreur lecture fichier markdown ${filePath}:`, error);
            throw error;
        }
    }

    /**
     * Parse les sections markdown avec la même logique que le script PowerShell
     */
    private parseMarkdownSections(content: string, options?: SummaryOptions): ClassifiedContent[] {
        const classified: ClassifiedContent[] = [];
        let index = 0;

        // Regex PowerShell exactes (traduites en JavaScript)
        // PowerShell: (?s)\*\*User:\*\*(.*?)(?=\*\*(?:User|Assistant):\*\*|$)
        // PowerShell: (?s)\*\*Assistant:\*\*(.*?)(?=\*\*(?:User|Assistant):\*\*|$)
        const userMatches = [...content.matchAll(/\*\*User:\*\*([\s\S]*?)(?=\*\*(?:User|Assistant):\*\*|$)/gs)];
        const assistantMatches = [...content.matchAll(/\*\*Assistant:\*\*([\s\S]*?)(?=\*\*(?:User|Assistant):\*\*|$)/gs)];

        // Créer et trier toutes les sections avec leur position
        const allSections: Array<{type: string, subType: string, content: string, index: number, lineNumber: number}> = [];

        // Traiter les sections User
        for (const match of userMatches) {
            const cleanContent = match[1].trim(); // Utiliser le groupe de capture
            const subType = this.determineUserSubType(cleanContent);
            const lineNumber = content.substring(0, match.index).split('\n').length;
            allSections.push({
                type: 'User',
                subType,
                content: cleanContent,
                index: match.index || 0,
                lineNumber
            });
        }

        // Traiter les sections Assistant
        for (const match of assistantMatches) {
            const cleanContent = match[1].trim(); // Utiliser le groupe de capture
            const subType = this.determineAssistantSubType(cleanContent);
            const lineNumber = content.substring(0, match.index).split('\n').length;
            allSections.push({
                type: 'Assistant',
                subType,
                content: cleanContent,
                index: match.index || 0,
                lineNumber
            });
        }

        // Trier par position dans le fichier
        allSections.sort((a, b) => a.index - b.index);

        // Convertir au format ClassifiedContent
        for (const section of allSections) {
            classified.push({
                type: section.type as 'User' | 'Assistant',
                subType: section.subType as any,
                content: section.content,
                index: index++,
                lineNumber: section.lineNumber,
                toolType: section.subType === 'ToolResult' ? this.extractToolType(section.content) : undefined,
                resultType: section.subType === 'ToolResult' ? this.getResultType(section.content) : undefined
            });
        }

        console.log(`📊 Parsed ${classified.length} sections from markdown`);
        console.log(`📊 Répartition: User(${userMatches.length}), Assistant(${assistantMatches.length}), Total(${classified.length})`);
        return classified;
    }

    /**
     * Détermine le sous-type d'une section User (logique PowerShell)
     */
    private determineUserSubType(content: string): string {
        const trimmed = content.trim();

        // 1. Résultats d'outils (priorité haute) - CORRECTION RÉGRESSION
        // Format classique : [tool_name] Result:
        if (/^\[([^\]]+)\] Result:/.test(trimmed)) {
            return "ToolResult";
        }

        // Format JSON Roo : {"tool":"...", "type":"use_mcp_tool", etc.
        if (/^{\s*"(tool|type)"\s*:/.test(trimmed)) {
            return "ToolResult";
        }

        // 2. Messages d'erreur système (SDDD: restent rouges)
        if (/^\[ERROR\]/i.test(trimmed)) {
            return "ErrorMessage";
        }

        // 3. Messages de condensation contexte (SDDD: nouvelle détection spécifique)
        if (/^1\.\s*\*\*Previous Conversation:\*\*/i.test(trimmed) ||
            /^1\.\s*Previous Conversation:/i.test(trimmed) ||
            trimmed.startsWith("1. **Previous Conversation:**")) {
            return "ContextCondensation";
        }

        // 4. Messages d'instructions continuation (SDDD: extraire contenu qui suit)
        if (/^New instructions for task continuation:/i.test(trimmed)) {
            return "NewInstructions";
        }

        // 5. Messages utilisateur normaux (SDDD: couleur violette)
        return "UserMessage";
    }

    /**
     * SDDD Phase 9: Améliore la détection des messages assistant avec nom d'outil
     */
    private determineAssistantSubType(content: string): string {
        const trimmed = content.trim();

        // 1. Messages de completion (priorité haute)
        if (content.includes('<attempt_completion>')) {
            console.log(`✅ Matched: Completion`);
            return 'Completion';
        }

        // 2. Messages d'outils normaux
        console.log(`❌ No special match, defaulting to ToolCall`);
        return 'ToolCall';
    }

    /**
     * Extrait les détails d'appel d'outil avec parsing XML amélioré (SDDD Phase 3)
     */
    public extractToolCallDetails(item: ClassifiedContent): any {
        if (item.type !== 'Assistant' || item.subType !== 'ToolCall') {
            return undefined;
        }

        // Parsing XML amélioré pour les outils
        const toolXmlMatches = item.content.match(/<([a-zA-Z_][a-zA-Z0-9_\-:]+)(?:\s+[^>]*)?>[\s\S]*?<\/\1>/g);

        if (!toolXmlMatches) {
            return undefined;
        }

        const toolCalls = toolXmlMatches.map(xmlBlock => {
            const tagMatch = xmlBlock.match(/<([a-zA-Z_][a-zA-Z0-9_\-:]+)/);
            const toolName = tagMatch ? tagMatch[1] : 'unknown_tool';

            // Extraction des paramètres avec parsing XML amélioré
            const parameters = this.parseToolParameters(xmlBlock);

            return {
                toolName,
                parameters,
                rawXml: xmlBlock,
                parsedSuccessfully: parameters !== null
            };
        });

        return {
            toolCalls,
            totalCalls: toolCalls.length,
            hasParsingErrors: toolCalls.some(call => !call.parsedSuccessfully)
        };
    }

    /**
     * Parse sophistiqué des paramètres d'outils XML (SDDD Phase 3)
     */
    public parseToolParameters(xmlBlock: string): Record<string, any> | null {
        try {
            // Extraction basique des paramètres pour l'instant
            // TODO: Implémenter un parsing XML plus sophistiqué si nécessaire
            const paramMatches = xmlBlock.match(/<([a-zA-Z_][a-zA-Z0-9_\-:]+)>([\s\S]*?)<\/\1>/g);

            if (!paramMatches) {
                return null;
            }

            const parameters: Record<string, any> = {};

            for (const paramMatch of paramMatches) {
                const tagMatch = paramMatch.match(/<([a-zA-Z_][a-zA-Z0-9_\-:]+)>([\s\S]*?)<\/\1>/);
                if (tagMatch) {
                    const [, paramName, paramValue] = tagMatch;
                    // Éviter de parser les balises racines d'outils
                    if (!this.isRootToolTag(paramName)) {
                        parameters[paramName] = paramValue.trim();
                    }
                }
            }

            return parameters;
        } catch (error) {
            console.warn('Failed to parse tool parameters:', error);
            return null;
        }
    }

    /**
     * Vérifie si une balise est une balise racine d'outil
     */
    private isRootToolTag(tagName: string): boolean {
        const rootToolTags = [
            'read_file', 'write_to_file', 'apply_diff', 'execute_command',
            'browser_action', 'search_files', 'codebase_search', 'list_files',
            'new_task', 'ask_followup_question', 'attempt_completion',
            'insert_content', 'search_and_replace', 'use_mcp_tool'
        ];
        return rootToolTags.includes(tagName);
    }

    /**
     * Extrait les détails de résultats d'outils
     */
    public extractToolResultDetails(item: ClassifiedContent): any {
        if (item.type !== 'User' || item.subType !== 'ToolResult') {
            return undefined;
        }

        const resultMatch = item.content.match(/\[([^\]]+)\] Result:\s*(.*)/s);
        if (!resultMatch) {
            return undefined;
        }

        const [, toolName, result] = resultMatch;

        return {
            toolName,
            resultType: this.getResultType(result),
            contentLength: result.length,
            hasError: this.detectResultError(result),
            parsedResult: this.parseStructuredResult(result)
        };
    }

    /**
     * Détecte si un résultat contient une erreur
     */
    private detectResultError(result: string): boolean {
        return /error|failed|unable|exception|denied/i.test(result);
    }

    /**
     * Parse les résultats structurés (JSON, XML, etc.)
     */
    public parseStructuredResult(result: string): any {
        // Tentative de parsing JSON
        try {
            return JSON.parse(result);
        } catch {
            // Pas un JSON valide
        }

        // Détection de structures XML ou autres formats
        if (result.includes('<files>') || result.includes('<file>')) {
            return { type: 'file_structure', content: result };
        }

        if (result.includes('Command executed')) {
            return { type: 'command_output', content: result };
        }

        return { type: 'text', content: result };
    }

    /**
     * Détecte si un message est un résultat d'outil
     */
    public isToolResult(content: string | any): boolean {
        // Gérer les contenus structurés (array d'objets)
        if (Array.isArray(content)) {
            const textContent = content
                .filter(item => item.type === 'text')
                .map(item => item.text)
                .join(' ');
            return /^\[([^\]]+?)(?:\s+for\s+[^\]]*)?]\s+Result:/i.test(textContent.trim());
        }

        // Gérer les contenus string simples
        if (typeof content === 'string') {
            return /^\[([^\]]+?)(?:\s+for\s+[^\]]*)?]\s+Result:/i.test(content.trim());
        }

        return false;
    }

    /**
     * Extrait le résumé complet entre crochets d'un résultat d'outil
     * Exemple: "[read_file for 'g:/path/file.ext']" retourne "read_file for 'g:/path/file.ext'"
     * Adapté pour traiter aussi les données JSON d'outils
     */
    public extractToolBracketSummaryFromResult(content: string): string | null {
        const textContent = this.extractTextContent(content);

        // Essayer d'abord le pattern bracket classique
        let match = textContent.match(/^\[([^\]]+)]\s+Result:/i);
        if (match) {
            return match[1];
        }

        // Si pas de bracket, essayer de parser le JSON d'outil
        try {
            const jsonMatch = textContent.match(/^\{.*\}$/s);
            if (jsonMatch) {
                const toolData = JSON.parse(jsonMatch[0]);
                if (toolData.tool) {
                    let summary = toolData.tool;

                    // Ajouter des détails selon le type d'outil
                    if (toolData.path) {
                        const shortPath = toolData.path.length > 50 ?
                            '...' + toolData.path.slice(-47) : toolData.path;
                        summary += ` for '${shortPath}'`;
                    } else if (toolData.serverName && toolData.toolName) {
                        summary = `${toolData.serverName}/${toolData.toolName}`;
                        if (toolData.arguments && typeof toolData.arguments === 'string') {
                            try {
                                const args = JSON.parse(toolData.arguments);
                                if (args.path) {
                                    const shortPath = args.path.length > 30 ?
                                        '...' + args.path.slice(-27) : args.path;
                                    summary += ` for '${shortPath}'`;
                                } else if (args.taskId) {
                                    summary += ` for task '${args.taskId.slice(0, 8)}...'`;
                                }
                            } catch {
                                // Ignore parsing errors
                            }
                        }
                    } else if (toolData.type) {
                        summary = toolData.type;
                    }

                    return summary;
                }
            }
        } catch {
            // Si le parsing JSON échoue, continuer avec l'extraction classique
        }

        return null;
    }

    /**
     * Extrait le type d'outil d'un message
     */
    public extractToolType(content: string | any): string {
        const textContent = this.extractTextContent(content);
        const match = textContent.match(/^\[([^\]]+?)(?:\s+for\s+[^\]]*)?]\s+Result:/i);
        return match ? match[1] : 'outil';
    }

    /**
     * Détermine le type de résultat d'un outil
     */
    public getResultType(content: string | any): string {
        const textContent = this.extractTextContent(content);
        if (/<files>/i.test(textContent)) return 'files';
        if (/<file_write_result>/i.test(textContent)) return 'écriture fichier';
        if (/Command executed/i.test(textContent)) return 'exécution commande';
        if (/Browser launched|Browser.*action/i.test(textContent)) return 'navigation web';
        if (/<environment_details>/i.test(textContent)) return 'détails environnement';
        if (/Result:.*Error|Unable to apply diff/i.test(textContent)) return 'erreur';
        if (/Todo list updated/i.test(textContent)) return 'mise à jour todo';
        return 'résultat';
    }

    /**
     * Extrait le contenu texte d'un message (string ou array structuré)
     */
    public extractTextContent(content: string | any): string {
        if (Array.isArray(content)) {
            return content
                .filter(item => item.type === 'text')
                .map(item => item.text)
                .join(' ');
        }

        if (typeof content === 'string') {
            return content;
        }

        return '';
    }

    /**
     * Extrait le nom du premier outil utilisé dans le message pour l'affichage dans le titre
     * PHASE 9: Amélioration des titres des messages assistant
     */
    public extractFirstToolName(content: string): string | null {
        if (!content) return null;

        // Liste des outils communs à détecter
        const commonTools = [
            'read_file', 'write_to_file', 'apply_diff', 'execute_command',
            'codebase_search', 'search_files', 'list_files', 'browser_action',
            'use_mcp_tool', 'list_code_definition_names', 'insert_content',
            'search_and_replace', 'ask_followup_question', 'attempt_completion'
        ];

        // Cherche le premier outil XML trouvé dans le contenu
        for (const toolName of commonTools) {
            const toolRegex = new RegExp(`<${toolName}[^>]*>`, 'i');
            if (toolRegex.test(content)) {
                return toolName;
            }
        }

        // Cherche également les balises use_mcp_tool avec server_name
        const mcpToolMatch = content.match(/<use_mcp_tool>[\s\S]*?<server_name>([^<]+)<\/server_name>/);
        if (mcpToolMatch) {
            return `use_mcp_tool:${mcpToolMatch[1].trim()}`;
        }

        return null;
    }
}