/**
 * MarkdownRenderer - Service de rendu Markdown avancé avec CSS et TOC
 * 
 * Génère du Markdown enrichi avec CSS, table des matières interactive,
 * coloration syntaxique et formatage avancé
 * Selon l'architecture définie dans docs/sddd/markdown_export_architecture.md
 */

import { ClassifiedContent, ToolCallDetails } from '../types/enhanced-conversation.js';

/**
 * Configuration pour le rendu Markdown
 */
export interface MarkdownRenderingConfig {
    includeCss: boolean;
    generateToc: boolean;
    colorizeByType: boolean;
    includeStatistics: boolean;
    compactStats: boolean;
    addLineNumbers: boolean;
    highlightCode: boolean;
    includeTimestamps: boolean;
    customCssPath?: string;
    tocMaxDepth: number;
    sectionSeparators: boolean;
    responsiveDesign: boolean;
}

/**
 * Statistiques de rendu
 */
export interface RenderingStatistics {
    totalSections: number;
    userMessages: number;
    assistantMessages: number;
    toolCalls: number;
    toolResults: number;
    totalContentSize: number;
    compressionRatio: number;
    renderingTime: number;
}

/**
 * Résultat du rendu
 */
export interface MarkdownRenderResult {
    content: string;
    statistics: RenderingStatistics;
    tocEntries: TOCEntry[];
    metadata: {
        generatedAt: string;
        configuration: MarkdownRenderingConfig;
        totalElements: number;
    };
}

/**
 * Entrée de table des matières
 */
export interface TOCEntry {
    id: string;
    title: string;
    level: number;
    type: 'user' | 'assistant' | 'tool' | 'section';
    lineNumber?: number;
}

export class MarkdownRenderer {
    private defaultConfig: MarkdownRenderingConfig = {
        includeCss: true,
        generateToc: true,
        colorizeByType: true,
        includeStatistics: true,
        compactStats: false,
        addLineNumbers: false,
        highlightCode: true,
        includeTimestamps: false,
        tocMaxDepth: 3,
        sectionSeparators: true,
        responsiveDesign: true
    };

    constructor(private config: Partial<MarkdownRenderingConfig> = {}) {
        this.config = { ...this.defaultConfig, ...this.config };
    }

    /**
     * Rend le contenu classifié en Markdown enrichi
     */
    render(
        content: ClassifiedContent[], 
        title?: string,
        config?: Partial<MarkdownRenderingConfig>
    ): MarkdownRenderResult {
        const startTime = Date.now();
        const effectiveConfig: MarkdownRenderingConfig = { ...this.defaultConfig, ...this.config, ...config };
        
        // Préparer les données pour le rendu
        const tocEntries: TOCEntry[] = [];
        const sections: string[] = [];
        
        // Statistiques
        const statistics: RenderingStatistics = {
            totalSections: 0,
            userMessages: 0,
            assistantMessages: 0,
            toolCalls: 0,
            toolResults: 0,
            totalContentSize: 0,
            compressionRatio: 0,
            renderingTime: 0
        };

        // En-tête du document
        if (effectiveConfig.includeCss) {
            sections.push(this.generateCSS(effectiveConfig));
        }

        // Titre principal
        if (title) {
            sections.push(`# ${title}\n`);
            tocEntries.push({
                id: 'main-title',
                title: title,
                level: 1,
                type: 'section'
            });
        }

        // Table des matières
        let tocPlaceholder = '';
        if (effectiveConfig.generateToc) {
            tocPlaceholder = '<!-- TABLE_OF_CONTENTS -->\n\n';
            sections.push(tocPlaceholder);
        }

        // Métadonnées du document
        sections.push(this.generateMetadata(effectiveConfig));

        // Rendu du contenu principal
        for (let i = 0; i < content.length; i++) {
            const item = content[i];
            const renderedSection = this.renderContentItem(item, i, effectiveConfig, tocEntries, statistics);
            if (renderedSection) {
                sections.push(renderedSection);
                statistics.totalSections++;
            }
        }

        // Statistiques finales
        if (effectiveConfig.includeStatistics) {
            const statsSection = this.generateStatistics(statistics, effectiveConfig.compactStats);
            sections.push(statsSection);
            tocEntries.push({
                id: 'statistics',
                title: 'Statistiques de la Conversation',
                level: 2,
                type: 'section'
            });
        }

        // Assemblage final
        let finalContent = sections.join('\n');

        // Générer la TOC et la remplacer
        if (effectiveConfig.generateToc) {
            const tocContent = this.generateTableOfContents(tocEntries, effectiveConfig.tocMaxDepth);
            finalContent = finalContent.replace(tocPlaceholder, tocContent);
        }

        // Finaliser les statistiques
        statistics.totalContentSize = finalContent.length;
        statistics.renderingTime = Date.now() - startTime;

        return {
            content: finalContent,
            statistics,
            tocEntries,
            metadata: {
                generatedAt: new Date().toISOString(),
                configuration: effectiveConfig,
                totalElements: content.length
            }
        };
    }

    /**
     * Génère le CSS embarqué
     */
    private generateCSS(config: MarkdownRenderingConfig): string {
        return `
<style>
/* === ROO CONVERSATION EXPORT STYLES === */

body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    line-height: 1.6;
    color: #24292e;
    max-width: 1200px;
    margin: 0 auto;
    padding: 20px;
    background-color: #ffffff;
}

/* Responsive Design */
${config.responsiveDesign ? `
@media (max-width: 768px) {
    body { padding: 10px; font-size: 14px; }
    .conversation-section { padding: 10px; }
    .toc-container { font-size: 12px; }
}
` : ''}

/* Headers */
h1, h2, h3, h4, h5, h6 {
    margin-top: 24px;
    margin-bottom: 16px;
    font-weight: 600;
    line-height: 1.25;
}

h1 { border-bottom: 2px solid #eaecef; padding-bottom: 8px; }
h2 { border-bottom: 1px solid #eaecef; padding-bottom: 8px; }

/* Table of Contents */
.toc-container {
    background: #f6f8fa;
    border: 1px solid #d0d7de;
    border-radius: 6px;
    padding: 16px;
    margin: 16px 0;
}

.toc-container h2 {
    margin-top: 0;
    font-size: 18px;
    border-bottom: none;
}

.toc-list {
    list-style: none;
    padding-left: 0;
    margin: 0;
}

.toc-list li {
    margin: 4px 0;
    padding-left: 0;
}

.toc-list .toc-level-1 { padding-left: 0; }
.toc-list .toc-level-2 { padding-left: 20px; }
.toc-list .toc-level-3 { padding-left: 40px; }

.toc-link {
    color: #0969da;
    text-decoration: none;
    font-size: 14px;
}

.toc-link:hover {
    text-decoration: underline;
    color: #0550ae;
}

/* Conversation Sections */
.conversation-section {
    margin: 20px 0;
    padding: 16px;
    border-radius: 8px;
    border-left: 4px solid;
    position: relative;
}

.conversation-section.user-message {
    background-color: #dbeafe;
    border-left-color: #3b82f6;
}

.conversation-section.assistant-message {
    background-color: #d1fae5;
    border-left-color: #10b981;
}

.conversation-section.tool-call {
    background-color: #fef3c7;
    border-left-color: #f59e0b;
}

.conversation-section.tool-result {
    background-color: #e0e7ff;
    border-left-color: #8b5cf6;
}

/* Section Headers */
.section-header {
    font-weight: 600;
    margin-bottom: 12px;
    font-size: 16px;
    display: flex;
    align-items: center;
    gap: 8px;
}

.section-type-badge {
    background: #6b7280;
    color: white;
    font-size: 11px;
    font-weight: 500;
    padding: 2px 8px;
    border-radius: 12px;
    text-transform: uppercase;
}

.user-message .section-type-badge { background: #3b82f6; }
.assistant-message .section-type-badge { background: #10b981; }
.tool-call .section-type-badge { background: #f59e0b; }
.tool-result .section-type-badge { background: #8b5cf6; }

/* Code Blocks */
pre, code {
    font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
    font-size: 12px;
}

pre {
    background: #f6f8fa;
    border-radius: 6px;
    padding: 16px;
    overflow: auto;
    border: 1px solid #d0d7de;
    margin: 12px 0;
}

code {
    background: rgba(175, 184, 193, 0.2);
    padding: 2px 4px;
    border-radius: 3px;
    font-size: 85%;
}

/* Tool Call Details */
.tool-details {
    background: #f8fafc;
    border: 1px solid #e2e8f0;
    border-radius: 6px;
    padding: 12px;
    margin: 8px 0;
    font-size: 13px;
}

.tool-name {
    font-weight: 600;
    color: #1e40af;
    margin-bottom: 8px;
}

.tool-args {
    background: #f1f5f9;
    padding: 8px;
    border-radius: 4px;
    font-family: monospace;
    font-size: 11px;
    overflow: auto;
}

/* Statistics */
.statistics-section {
    background: #fafbfc;
    border: 1px solid #e1e4e8;
    border-radius: 8px;
    padding: 20px;
    margin: 24px 0;
}

.stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 16px;
    margin: 16px 0;
}

.stat-item {
    text-align: center;
    padding: 12px;
    background: white;
    border-radius: 6px;
    border: 1px solid #e1e4e8;
}

.stat-value {
    font-size: 24px;
    font-weight: 700;
    color: #0366d6;
}

.stat-label {
    font-size: 12px;
    color: #586069;
    text-transform: uppercase;
    font-weight: 500;
}

/* Metadata */
.metadata-section {
    background: #f6f8fa;
    border-left: 3px solid #0366d6;
    padding: 12px 16px;
    margin: 16px 0;
    font-size: 13px;
    color: #586069;
}

/* Timestamps */
.timestamp {
    font-size: 11px;
    color: #8b949e;
    font-style: italic;
}

/* Line Numbers */
.line-number {
    color: #8b949e;
    font-family: monospace;
    font-size: 11px;
    margin-right: 8px;
    user-select: none;
}

/* Print Styles */
@media print {
    body { max-width: none; margin: 0; padding: 10px; }
    .conversation-section { break-inside: avoid; }
    .toc-container { break-before: page; }
}
</style>

`;
    }

    /**
     * Génère les métadonnées du document
     */
    private generateMetadata(config: MarkdownRenderingConfig): string {
        return `
<div class="metadata-section">
<strong>Document généré par Roo Export System</strong><br>
Date de génération: ${new Date().toLocaleString('fr-FR')}<br>
Configuration: CSS ${config.includeCss ? 'inclus' : 'exclu'}, TOC ${config.generateToc ? 'inclus' : 'exclu'}, Statistiques ${config.includeStatistics ? 'incluses' : 'exclues'}
</div>

`;
    }

    /**
     * Rend un élément de contenu individuel
     */
    private renderContentItem(
        item: ClassifiedContent,
        index: number,
        config: MarkdownRenderingConfig,
        tocEntries: TOCEntry[],
        statistics: RenderingStatistics
    ): string {
        const sections: string[] = [];
        
        // Détermine le type CSS et met à jour les statistiques
        let cssClass = 'conversation-section';
        let sectionTitle = '';
        let badgeText = '';

        switch (item.subType) {
            case 'UserMessage':
                cssClass += ' user-message';
                sectionTitle = `Message Utilisateur #${index + 1}`;
                badgeText = 'USER';
                statistics.userMessages++;
                break;
            case 'ToolCall':
                cssClass += ' tool-call';
                sectionTitle = `Appel d'Outil #${index + 1}`;
                badgeText = 'TOOL';
                statistics.toolCalls++;
                break;
            case 'ToolResult':
                cssClass += ' tool-result';
                sectionTitle = `Résultat d'Outil #${index + 1}`;
                badgeText = 'RESULT';
                statistics.toolResults++;
                break;
            case 'Completion':
            case 'Thinking':
            default:
                cssClass += ' assistant-message';
                sectionTitle = `Message Assistant #${index + 1}`;
                badgeText = 'ASSISTANT';
                statistics.assistantMessages++;
                break;
        }

        // Ajouter à la TOC si nécessaire
        const tocId = `section-${index}`;
        tocEntries.push({
            id: tocId,
            title: sectionTitle,
            level: 3,
            type: item.subType === 'UserMessage' ? 'user' : 
                  item.subType.includes('Tool') ? 'tool' : 'assistant'
        });

        // Début de la section
        sections.push(`<div class="${cssClass}" id="${tocId}">`);
        
        // En-tête de section
        if (config.addLineNumbers) {
            sections.push(`<div class="section-header"><span class="line-number">${(index + 1).toString().padStart(3, '0')}</span><span class="section-type-badge">${badgeText}</span>${sectionTitle}</div>`);
        } else {
            sections.push(`<div class="section-header"><span class="section-type-badge">${badgeText}</span>${sectionTitle}</div>`);
        }

        // Détails d'outil si applicable
        if (item.toolCallDetails && config.colorizeByType) {
            const toolDetails = this.renderToolDetails(item.toolCallDetails);
            sections.push(toolDetails);
        }

        // Contenu principal
        let content = item.content;
        
        // Nettoyer et formatter le contenu
        if (config.highlightCode) {
            content = this.enhanceCodeBlocks(content);
        }
        
        sections.push(`\n${content}\n`);
        
        // Fin de la section
        sections.push('</div>');
        
        // Séparateur si configuré
        if (config.sectionSeparators && index < statistics.totalSections - 1) {
            sections.push('\n---\n');
        }

        return sections.join('\n');
    }

    /**
     * Rend les détails d'un appel d'outil
     */
    private renderToolDetails(toolDetails: ToolCallDetails): string {
        if (!toolDetails.parseSuccess) {
            return `<div class="tool-details">⚠️ Erreur de parsing XML</div>`;
        }

        const sections = [
            '<div class="tool-details">',
            `<div class="tool-name">🔧 ${toolDetails.toolName}</div>`
        ];

        if (Object.keys(toolDetails.arguments).length > 0) {
            const argsJson = JSON.stringify(toolDetails.arguments, null, 2);
            sections.push(`<div class="tool-args">${this.escapeHtml(argsJson)}</div>`);
        }

        sections.push('</div>');
        return sections.join('\n');
    }

    /**
     * Génère la table des matières
     */
    private generateTableOfContents(entries: TOCEntry[], maxDepth: number): string {
        const filteredEntries = entries.filter(entry => entry.level <= maxDepth);
        
        if (filteredEntries.length === 0) {
            return '';
        }

        const sections = [
            '<div class="toc-container">',
            '<h2>📋 Table des Matières</h2>',
            '<ul class="toc-list">'
        ];

        for (const entry of filteredEntries) {
            const levelClass = `toc-level-${Math.min(entry.level, 3)}`;
            const typeIcon = this.getTOCIcon(entry.type);
            sections.push(
                `<li class="${levelClass}">` +
                `<a href="#${entry.id}" class="toc-link">${typeIcon} ${entry.title}</a>` +
                `</li>`
            );
        }

        sections.push('</ul>', '</div>', '');
        return sections.join('\n');
    }

    /**
     * Génère les statistiques
     */
    private generateStatistics(stats: RenderingStatistics, compact: boolean): string {
        if (compact) {
            return `
## 📊 Statistiques

**Messages:** ${stats.userMessages} utilisateur, ${stats.assistantMessages} assistant | **Outils:** ${stats.toolCalls} appels, ${stats.toolResults} résultats | **Taille:** ${Math.round(stats.totalContentSize / 1024)}KB | **Rendu:** ${stats.renderingTime}ms

`;
        }

        return `
<div class="statistics-section" id="statistics">

## 📊 Statistiques de la Conversation

<div class="stats-grid">

<div class="stat-item">
<div class="stat-value">${stats.userMessages}</div>
<div class="stat-label">Messages Utilisateur</div>
</div>

<div class="stat-item">
<div class="stat-value">${stats.assistantMessages}</div>
<div class="stat-label">Messages Assistant</div>
</div>

<div class="stat-item">
<div class="stat-value">${stats.toolCalls}</div>
<div class="stat-label">Appels d'Outils</div>
</div>

<div class="stat-item">
<div class="stat-value">${stats.toolResults}</div>
<div class="stat-label">Résultats d'Outils</div>
</div>

<div class="stat-item">
<div class="stat-value">${Math.round(stats.totalContentSize / 1024)}</div>
<div class="stat-label">Taille (KB)</div>
</div>

<div class="stat-item">
<div class="stat-value">${stats.renderingTime}</div>
<div class="stat-label">Temps de Rendu (ms)</div>
</div>

</div>
</div>

`;
    }

    /**
     * Améliore la coloration syntaxique des blocs de code
     */
    private enhanceCodeBlocks(content: string): string {
        return content.replace(
            /```(\w+)?\n([\s\S]*?)```/g,
            (match, language, code) => {
                const lang = language || 'text';
                return `\`\`\`${lang}\n${code.trim()}\n\`\`\``;
            }
        );
    }

    /**
     * Échappe le HTML
     */
    private escapeHtml(text: string): string {
        const map: Record<string, string> = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        };
        return text.replace(/[&<>"']/g, (m) => map[m]);
    }

    /**
     * Récupère l'icône pour la TOC selon le type
     */
    private getTOCIcon(type: string): string {
        switch (type) {
            case 'user': return '👤';
            case 'assistant': return '🤖';
            case 'tool': return '🔧';
            case 'section': return '📝';
            default: return '•';
        }
    }
}