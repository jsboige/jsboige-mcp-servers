/**
 * MarkdownFormatterService - Service de formatage Markdown avancé avec CSS Phase 4
 * 
 * SDDD Phase 4: CSS Avancé et Couleurs Différenciées
 * 
 * Système de couleurs spécifique Phase 4 :
 * - Messages utilisateur : Bleu (#2563eb)
 * - Messages assistant : Vert (#059669)
 * - Appels d'outils : Orange (#ea580c)
 * - Résultats d'outils : Violet (#7c3aed)
 * - Métadonnées/contexte : Gris (#6b7280)
 * - Erreurs/warnings : Rouge (#dc2626)
 */

import { ClassifiedContent, EnhancedSummaryOptions } from '../types/enhanced-conversation.js';

export interface AdvancedFormattingOptions {
    enableAdvancedCSS: boolean;
    responsiveDesign: boolean;
    syntaxHighlighting: boolean;
    animationsEnabled: boolean;
    compactMode: boolean;
}

export class MarkdownFormatterService {
    private static readonly CSS_THEME_COLORS = {
        // Couleurs Phase 4 spécifiées
        userMessage: '#2563eb',        // Bleu
        assistantMessage: '#059669',   // Vert
        toolCall: '#ea580c',          // Orange
        toolResult: '#7c3aed',        // Violet
        metadata: '#6b7280',          // Gris
        error: '#dc2626',             // Rouge
        
        // Couleurs complémentaires
        background: {
            userMessage: '#dbeafe',      // Bleu clair
            assistantMessage: '#dcfce7', // Vert clair
            toolCall: '#fed7aa',         // Orange clair
            toolResult: '#e9d5ff',       // Violet clair
            metadata: '#f3f4f6',         // Gris clair
            error: '#fee2e2'             // Rouge clair
        },
        
        // Couleurs système
        primary: '#1f2937',
        secondary: '#374151',
        accent: '#3b82f6',
        success: '#10b981',
        warning: '#f59e0b',
        danger: '#ef4444'
    };

    /**
     * Génère le CSS complet intégré pour la Phase 4
     */
    static generateCSS(options: AdvancedFormattingOptions = {
        enableAdvancedCSS: true,
        responsiveDesign: true,
        syntaxHighlighting: true,
        animationsEnabled: true,
        compactMode: false
    }): string {
        const colors = this.CSS_THEME_COLORS;
        
        return `<style>
/* === ROO CONVERSATION EXPORT - PHASE 4 ADVANCED CSS === */
/* SDDD Phase 4: CSS Avancé et Couleurs Différenciées */

:root {
    /* Variables CSS Phase 4 */
    --color-user: ${colors.userMessage};
    --color-assistant: ${colors.assistantMessage};
    --color-tool-call: ${colors.toolCall};
    --color-tool-result: ${colors.toolResult};
    --color-metadata: ${colors.metadata};
    --color-error: ${colors.error};
    
    --bg-user: ${colors.background.userMessage};
    --bg-assistant: ${colors.background.assistantMessage};
    --bg-tool-call: ${colors.background.toolCall};
    --bg-tool-result: ${colors.background.toolResult};
    --bg-metadata: ${colors.background.metadata};
    --bg-error: ${colors.background.error};
    
    --shadow-subtle: 0 1px 3px 0 rgba(0, 0, 0, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.06);
    --shadow-medium: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
    --radius-sm: 4px;
    --radius-md: 8px;
    --radius-lg: 12px;
    --transition-base: 0.15s ease-in-out;
}

/* Base Styles */
body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Helvetica Neue', Arial, sans-serif;
    line-height: 1.6;
    color: ${colors.primary};
    max-width: ${options.compactMode ? '900px' : '1200px'};
    margin: 0 auto;
    padding: ${options.compactMode ? '16px' : '24px'};
    background: linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%);
    min-height: 100vh;
}

/* Headers avec style Phase 4 */
h1, h2, h3, h4, h5, h6 {
    margin-top: 32px;
    margin-bottom: 16px;
    font-weight: 700;
    line-height: 1.25;
    color: ${colors.primary};
}

h1 {
    font-size: 2.25rem;
    border-bottom: 3px solid var(--color-user);
    padding-bottom: 12px;
    background: linear-gradient(135deg, var(--color-user), var(--color-assistant));
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
}

h2 {
    font-size: 1.875rem;
    border-bottom: 2px solid var(--color-metadata);
    padding-bottom: 8px;
}

h3 {
    font-size: 1.5rem;
    color: ${colors.secondary};
}

/* Table des Matières Avancée */
.toc-container {
    background: linear-gradient(135deg, var(--bg-metadata), #ffffff);
    border: 2px solid var(--color-metadata);
    border-radius: var(--radius-lg);
    padding: 24px;
    margin: 24px 0;
    box-shadow: var(--shadow-medium);
    ${options.animationsEnabled ? 'transition: all var(--transition-base);' : ''}
}

${options.animationsEnabled ? `
.toc-container:hover {
    box-shadow: 0 8px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04);
    transform: translateY(-1px);
}
` : ''}

.toc-container h2 {
    margin-top: 0;
    font-size: 1.5rem;
    border-bottom: none;
    color: var(--color-metadata);
    display: flex;
    align-items: center;
    gap: 8px;
}

.toc-container h2::before {
    content: "📋";
    font-size: 1.2rem;
}

.toc-list {
    list-style: none;
    padding-left: 0;
    margin: 16px 0 0 0;
}

.toc-list li {
    margin: 8px 0;
    padding: 6px 12px;
    border-radius: var(--radius-sm);
    ${options.animationsEnabled ? 'transition: all var(--transition-base);' : ''}
}

.toc-list li:hover {
    background-color: rgba(55, 65, 81, 0.05);
    ${options.animationsEnabled ? 'transform: translateX(4px);' : ''}
}

.toc-list .toc-level-1 { padding-left: 12px; font-weight: 600; }
.toc-list .toc-level-2 { padding-left: 32px; }
.toc-list .toc-level-3 { padding-left: 52px; }

.toc-link {
    color: ${colors.accent};
    text-decoration: none;
    font-size: 14px;
    display: flex;
    align-items: center;
    gap: 8px;
    ${options.animationsEnabled ? 'transition: color var(--transition-base);' : ''}
}

.toc-link:hover {
    color: ${colors.primary};
    text-decoration: underline;
}

/* Badges de Type Améliorés */
.message-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    font-weight: 600;
    padding: 4px 10px;
    border-radius: var(--radius-lg);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: white;
    ${options.animationsEnabled ? 'transition: all var(--transition-base);' : ''}
}

.message-badge.user { 
    background: var(--color-user);
    box-shadow: 0 2px 4px rgba(37, 99, 235, 0.3);
}

.message-badge.user::before { content: "👤"; }

.message-badge.assistant { 
    background: var(--color-assistant);
    box-shadow: 0 2px 4px rgba(5, 150, 105, 0.3);
}

.message-badge.assistant::before { content: "🤖"; }

.message-badge.tool-call { 
    background: var(--color-tool-call);
    box-shadow: 0 2px 4px rgba(234, 88, 12, 0.3);
}

.message-badge.tool-call::before { content: "🔧"; }

.message-badge.tool-result { 
    background: var(--color-tool-result);
    box-shadow: 0 2px 4px rgba(124, 58, 237, 0.3);
}

.message-badge.tool-result::before { content: "⚡"; }

/* Sections de Conversation Phase 4 */
.conversation-section {
    margin: 24px 0;
    padding: 20px;
    border-radius: var(--radius-md);
    border-left: 5px solid;
    position: relative;
    box-shadow: var(--shadow-subtle);
    ${options.animationsEnabled ? 'transition: all var(--transition-base);' : ''}
}

${options.animationsEnabled ? `
.conversation-section:hover {
    box-shadow: var(--shadow-medium);
    transform: translateY(-1px);
}
` : ''}

.conversation-section.user-message {
    background: linear-gradient(135deg, var(--bg-user), #ffffff);
    border-left-color: var(--color-user);
}

.conversation-section.assistant-message {
    background: linear-gradient(135deg, var(--bg-assistant), #ffffff);
    border-left-color: var(--color-assistant);
}

.conversation-section.tool-call {
    background: linear-gradient(135deg, var(--bg-tool-call), #ffffff);
    border-left-color: var(--color-tool-call);
}

.conversation-section.tool-result {
    background: linear-gradient(135deg, var(--bg-tool-result), #ffffff);
    border-left-color: var(--color-tool-result);
}

/* Headers de Section */
.section-header {
    font-weight: 700;
    margin-bottom: 16px;
    font-size: 1.1rem;
    display: flex;
    align-items: center;
    gap: 12px;
    color: ${colors.primary};
}

/* Blocs de Code avec Syntax Highlighting */
${options.syntaxHighlighting ? `
pre, code {
    font-family: 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, 'Courier New', monospace;
    background-color: #1e293b;
    color: #e2e8f0;
    border-radius: var(--radius-sm);
}

code {
    padding: 2px 6px;
    font-size: 0.875rem;
}

pre {
    padding: 16px;
    margin: 16px 0;
    overflow-x: auto;
    border: 1px solid #334155;
    position: relative;
}

pre code {
    background: none;
    padding: 0;
    color: inherit;
}

/* Syntax highlighting colors */
.hljs-keyword { color: #f472b6; }
.hljs-string { color: #34d399; }
.hljs-number { color: #fbbf24; }
.hljs-comment { color: #64748b; }
.hljs-function { color: #60a5fa; }
.hljs-variable { color: #e879f9; }
` : `
pre, code {
    background-color: #f8fafc;
    border: 1px solid #e2e8f0;
    border-radius: var(--radius-sm);
    font-family: 'SF Mono', Monaco, monospace;
}

code {
    padding: 2px 4px;
    font-size: 0.875rem;
}

pre {
    padding: 16px;
    margin: 16px 0;
    overflow-x: auto;
}
`}

/* Tableaux Formatés */
table {
    border-collapse: collapse;
    width: 100%;
    margin: 20px 0;
    background: white;
    border-radius: var(--radius-md);
    overflow: hidden;
    box-shadow: var(--shadow-subtle);
}

th, td {
    padding: 12px 16px;
    text-align: left;
    border-bottom: 1px solid #e5e7eb;
}

th {
    background: linear-gradient(135deg, var(--color-metadata), ${colors.secondary});
    color: white;
    font-weight: 600;
    font-size: 0.875rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
}

tr:hover {
    background-color: rgba(55, 65, 81, 0.02);
}

/* Séparateurs Visuels */
.section-separator {
    margin: 40px 0;
    height: 3px;
    background: linear-gradient(90deg, var(--color-user), var(--color-assistant), var(--color-tool-call), var(--color-tool-result));
    border-radius: var(--radius-sm);
    ${options.animationsEnabled ? 'animation: pulse 3s ease-in-out infinite;' : ''}
}

/* Messages d'Erreur et Warnings */
.error-message {
    background: var(--bg-error);
    border: 1px solid var(--color-error);
    border-radius: var(--radius-md);
    padding: 16px;
    margin: 16px 0;
    color: var(--color-error);
    display: flex;
    align-items: center;
    gap: 8px;
}

.error-message::before {
    content: "⚠️";
    font-size: 1.2rem;
}

.warning-message {
    background: var(--bg-tool-call);
    border: 1px solid var(--color-tool-call);
    border-radius: var(--radius-md);
    padding: 16px;
    margin: 16px 0;
    color: var(--color-tool-call);
}

/* Statistiques Détaillées */
.stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 20px;
    margin: 24px 0;
}

.stat-card {
    background: linear-gradient(135deg, #ffffff, #f8fafc);
    border: 2px solid var(--color-metadata);
    border-radius: var(--radius-lg);
    padding: 20px;
    text-align: center;
    box-shadow: var(--shadow-subtle);
    ${options.animationsEnabled ? 'transition: all var(--transition-base);' : ''}
}

${options.animationsEnabled ? `
.stat-card:hover {
    transform: translateY(-2px);
    box-shadow: var(--shadow-medium);
}
` : ''}

.stat-value {
    font-size: 2rem;
    font-weight: 700;
    color: var(--color-user);
    margin-bottom: 8px;
}

.stat-label {
    font-size: 0.875rem;
    color: var(--color-metadata);
    text-transform: uppercase;
    letter-spacing: 0.05em;
}

/* Responsive Design */
${options.responsiveDesign ? `
@media (max-width: 768px) {
    body { 
        padding: 12px; 
        font-size: 14px; 
    }
    
    .conversation-section { 
        padding: 16px; 
        margin: 16px 0; 
    }
    
    .toc-container { 
        padding: 16px; 
    }
    
    h1 { font-size: 1.75rem; }
    h2 { font-size: 1.5rem; }
    h3 { font-size: 1.25rem; }
    
    .stats-grid {
        grid-template-columns: 1fr;
        gap: 16px;
    }
    
    .message-badge {
        font-size: 10px;
        padding: 3px 8px;
    }
}

@media (max-width: 480px) {
    .toc-list .toc-level-2 { padding-left: 24px; }
    .toc-list .toc-level-3 { padding-left: 36px; }
    
    .section-header {
        flex-direction: column;
        align-items: flex-start;
        gap: 8px;
    }
}
` : ''}

/* Animations */
${options.animationsEnabled ? `
@keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
}

@keyframes fadeIn {
    from { opacity: 0; transform: translateY(10px); }
    to { opacity: 1; transform: translateY(0); }
}

.conversation-section {
    animation: fadeIn 0.3s ease-out;
}

.message-badge:hover {
    transform: scale(1.05);
}
` : ''}

/* Mode Compact */
${options.compactMode ? `
.conversation-section {
    padding: 12px;
    margin: 16px 0;
}

.toc-container {
    padding: 16px;
}

.section-header {
    font-size: 1rem;
    margin-bottom: 12px;
}

.stat-card {
    padding: 16px;
}
` : ''}

/* Print Styles */
@media print {
    body {
        background: white;
        padding: 0;
        max-width: none;
    }
    
    .conversation-section {
        page-break-inside: avoid;
        box-shadow: none;
        border: 1px solid #ccc;
    }
    
    .message-badge {
        background: #666 !important;
    }
    
    .section-separator {
        background: #333;
        animation: none;
    }
}

/* Accessibility */
.screen-reader-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
}

/* Focus states */
.toc-link:focus,
.message-badge:focus {
    outline: 2px solid var(--color-user);
    outline-offset: 2px;
}

</style>`;
    }

    /**
     * Formate un message utilisateur avec le style Phase 4
     */
    static formatUserMessage(content: string, timestamp?: string): string {
        const timestampStr = timestamp ? `<small class="timestamp">${timestamp}</small>` : '';
        
        return `
<div class="conversation-section user-message">
    <div class="section-header">
        <span class="message-badge user">Message Utilisateur</span>
        ${timestampStr}
    </div>
    <div class="message-content">
        ${content}
    </div>
</div>`;
    }

    /**
     * Formate un message assistant avec le style Phase 4
     */
    static formatAssistantMessage(content: string, timestamp?: string): string {
        const timestampStr = timestamp ? `<small class="timestamp">${timestamp}</small>` : '';
        
        return `
<div class="conversation-section assistant-message">
    <div class="section-header">
        <span class="message-badge assistant">Réponse Assistant</span>
        ${timestampStr}
    </div>
    <div class="message-content">
        ${content}
    </div>
</div>`;
    }

    /**
     * Formate un appel d'outil avec le style Phase 4
     */
    static formatToolCall(toolName: string, parameters: any, timestamp?: string): string {
        const timestampStr = timestamp ? `<small class="timestamp">${timestamp}</small>` : '';
        const paramsTable = this.formatToolParametersTable(parameters);
        
        return `
<div class="conversation-section tool-call">
    <div class="section-header">
        <span class="message-badge tool-call">Appel d'Outil: ${toolName}</span>
        ${timestampStr}
    </div>
    <div class="message-content">
        ${paramsTable}
    </div>
</div>`;
    }

    /**
     * Formate un résultat d'outil avec le style Phase 4
     */
    static formatToolResult(toolName: string, result: any, timestamp?: string): string {
        const timestampStr = timestamp ? `<small class="timestamp">${timestamp}</small>` : '';
        
        return `
<div class="conversation-section tool-result">
    <div class="section-header">
        <span class="message-badge tool-result">Résultat: ${toolName}</span>
        ${timestampStr}
    </div>
    <div class="message-content">
        <pre><code>${typeof result === 'string' ? result : JSON.stringify(result, null, 2)}</code></pre>
    </div>
</div>`;
    }

    /**
     * Génère l'en-tête de conversation avec métadonnées
     */
    static formatConversationHeader(metadata: {
        taskId: string;
        title?: string;
        createdAt?: string;
        messageCount?: number;
        totalSize?: string;
    }): string {
        return `
<div class="conversation-header">
    <h1>${metadata.title || 'Trace de Conversation Roo'}</h1>
    
    <div class="stats-grid">
        <div class="stat-card">
            <div class="stat-value">${metadata.messageCount || 0}</div>
            <div class="stat-label">Messages</div>
        </div>
        <div class="stat-card">
            <div class="stat-value">${metadata.totalSize || '0 KB'}</div>
            <div class="stat-label">Taille</div>
        </div>
        <div class="stat-card">
            <div class="stat-value">${metadata.createdAt ? new Date(metadata.createdAt).toLocaleDateString('fr-FR') : 'N/A'}</div>
            <div class="stat-label">Créé le</div>
        </div>
    </div>
    
    <div class="metadata-section">
        <p><strong>ID de Tâche :</strong> <code>${metadata.taskId}</code></p>
    </div>
    
    <div class="section-separator"></div>
</div>`;
    }

    /**
     * Génère un séparateur visuel entre sections
     */
    static formatSectionSeparator(title: string, color: string): string {
        return `
<div class="section-separator-with-title" style="border-color: ${color}">
    <h2 style="color: ${color}">${title}</h2>
</div>`;
    }

    /**
     * Formate un tableau de métadonnées
     */
    static formatMetadataTable(data: Record<string, any>): string {
        const rows = Object.entries(data).map(([key, value]) => 
            `<tr><td><strong>${key}</strong></td><td>${value}</td></tr>`
        ).join('');
        
        return `
<table class="metadata-table">
    <thead>
        <tr>
            <th>Propriété</th>
            <th>Valeur</th>
        </tr>
    </thead>
    <tbody>
        ${rows}
    </tbody>
</table>`;
    }

    /**
     * Formate un tableau de paramètres d'outil
     */
    static formatToolParametersTable(params: any): string {
        if (!params || typeof params !== 'object') {
            return `<pre><code>${String(params)}</code></pre>`;
        }

        const rows = Object.entries(params).map(([key, value]) => 
            `<tr><td><code>${key}</code></td><td><pre><code>${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</code></pre></td></tr>`
        ).join('');
        
        return `
<table class="tool-parameters-table">
    <thead>
        <tr>
            <th>Paramètre</th>
            <th>Valeur</th>
        </tr>
    </thead>
    <tbody>
        ${rows}
    </tbody>
</table>`;
    }
}