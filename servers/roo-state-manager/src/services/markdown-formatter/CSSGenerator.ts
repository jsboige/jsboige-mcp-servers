/**
 * CSSGenerator - Génération CSS pour le formatage Markdown
 * 
 * Responsable de la génération des styles CSS pour les exports Markdown/HTML.
 */

import { AdvancedFormattingOptions } from '../MarkdownFormatterService.js';

export class CSSGenerator {
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

/* ===========================
   PHASE 5: CSS INTERACTIF
   =========================== */

/* Table des matières */
.toc-container {
    background: linear-gradient(135deg, #f8fafc, #ffffff);
    border: 2px solid var(--color-metadata);
    border-radius: var(--radius-lg);
    padding: 24px;
    margin: 32px 0;
    box-shadow: var(--shadow-medium);
}

.toc-title {
    color: var(--color-primary);
    margin: 0 0 20px 0;
    font-size: 1.5rem;
    font-weight: 700;
    display: flex;
    align-items: center;
    gap: 8px;
}

.toc-search {
    margin-bottom: 20px;
}

.toc-search input {
    width: 100%;
    padding: 12px;
    border: 2px solid var(--color-metadata);
    border-radius: var(--radius-md);
    font-size: 1rem;
    ${options.animationsEnabled ? 'transition: all var(--transition-base);' : ''}
}

.toc-search input:focus {
    outline: none;
    border-color: var(--color-user);
    box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1);
}

.toc-stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 16px;
    margin-bottom: 24px;
}

.toc-stat-card {
    background: white;
    border-radius: var(--radius-md);
    padding: 16px;
    box-shadow: var(--shadow-subtle);
    ${options.animationsEnabled ? 'transition: all var(--transition-base);' : ''}
}

${options.animationsEnabled ? `
.toc-stat-card:hover {
    transform: translateY(-2px);
    box-shadow: var(--shadow-medium);
}
` : ''}

.toc-stat-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
}

.toc-icon {
    font-size: 1.2rem;
}

.toc-label {
    font-weight: 600;
    color: var(--color-secondary);
    font-size: 0.875rem;
}

.toc-count {
    font-size: 2rem;
    font-weight: 700;
    color: var(--color-primary);
    margin-bottom: 8px;
}

.toc-progress-bar {
    width: 100%;
    height: 4px;
    background: #e5e7eb;
    border-radius: 2px;
    overflow: hidden;
}

.toc-progress-fill {
    height: 100%;
    ${options.animationsEnabled ? 'transition: width var(--transition-base);' : ''}
}

.toc-nav-title {
    color: var(--color-secondary);
    margin: 0 0 16px 0;
    font-size: 1.125rem;
    font-weight: 600;
}

.toc-links {
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-height: 300px;
    overflow-y: auto;
}

.toc-link-item {
    padding: 8px 0;
    border-bottom: 1px solid #f3f4f6;
}

.toc-link-item:last-child {
    border-bottom: none;
}

.toc-link {
    display: flex;
    align-items: center;
    gap: 12px;
    text-decoration: none;
    ${options.animationsEnabled ? 'transition: all var(--transition-base);' : ''}
    padding: 8px 12px;
    border-radius: var(--radius-md);
}

.toc-link:hover {
    background: rgba(37, 99, 235, 0.1);
    ${options.animationsEnabled ? 'transform: translateX(4px);' : ''}
}

.toc-link.active {
    background: rgba(37, 99, 235, 0.15);
    font-weight: 600;
}

.toc-link-icon {
    font-size: 1rem;
}

.toc-link-text {
    flex: 1;
    font-weight: 500;
}

.toc-timestamp {
    font-size: 0.75rem;
    color: var(--color-metadata);
    font-family: monospace;
}

/* Contenu tronqué */
.truncation-container {
    position: relative;
}

.truncated-content,
.full-content {
    ${options.animationsEnabled ? 'transition: all var(--transition-base);' : ''}
}

.hidden {
    display: none;
}

.expand-button,
.collapse-button {
    background: var(--color-user);
    color: white;
    border: none;
    padding: 8px 16px;
    border-radius: var(--radius-md);
    font-size: 0.875rem;
    cursor: pointer;
    ${options.animationsEnabled ? 'transition: all var(--transition-base);' : ''}
    margin-top: 8px;
}

.expand-button:hover,
.collapse-button:hover {
    background: #1d4ed8;
    ${options.animationsEnabled ? 'transform: translateY(-1px);' : ''}
}

/* Contenu expandable */
.expandable-container {
    border: 2px solid var(--color-metadata);
    border-radius: var(--radius-md);
    margin: 16px 0;
}

.content-summary {
    padding: 16px;
    background: var(--bg-metadata);
    border-bottom: 1px solid var(--color-metadata);
}

.expand-toggle {
    width: 100%;
    padding: 12px;
    background: none;
    border: none;
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    ${options.animationsEnabled ? 'transition: all var(--transition-base);' : ''}
}

.expand-toggle:hover {
    background: rgba(107, 114, 128, 0.1);
}

.expand-icon {
    font-size: 0.875rem;
    ${options.animationsEnabled ? 'transition: transform var(--transition-base);' : ''}
}

.expand-text {
    font-weight: 500;
}

.expandable-content {
    padding: 16px;
    border-top: 1px solid var(--color-metadata);
    ${options.animationsEnabled ? 'animation: fadeIn 0.3s ease-out;' : ''}
}

/* Copy button */
.copy-button {
    background: var(--color-metadata);
    color: white;
    border: none;
    padding: 4px 8px;
    border-radius: var(--radius-sm);
    font-size: 0.75rem;
    cursor: pointer;
    ${options.animationsEnabled ? 'transition: all var(--transition-base);' : ''}
    z-index: 10;
}

.copy-button:hover {
    background: var(--color-secondary);
}

/* Highlight flash effect */
.highlight-flash {
    ${options.animationsEnabled ? 'animation: highlightFlash 2s ease-out;' : ''}
}

${options.animationsEnabled ? `
@keyframes highlightFlash {
    0% { background-color: rgba(37, 99, 235, 0.3); }
    100% { background-color: transparent; }
}
` : ''}

/* Ancres de navigation */
[id^="message-"] {
    scroll-margin-top: 20px;
}

/* Responsive pour les fonctionnalités Phase 5 */
${options.responsiveDesign ? `
@media (max-width: 768px) {
    .toc-stats-grid {
        grid-template-columns: repeat(2, 1fr);
        gap: 12px;
    }
    
    .toc-container {
        padding: 16px;
    }
    
    .toc-links {
        max-height: 200px;
    }
    
    .toc-link {
        font-size: 0.875rem;
    }
}
` : ''}
</style>`;
    }

    /**
     * Génère le CSS additionnel pour les fonctionnalités Phase 5
     */
    static generateInteractiveCSS(): string {
        return `
/* ===========================
   PHASE 5: CSS INTERACTIF
   =========================== */

/* Table des matières */
.toc-container {
    background: linear-gradient(135deg, #f8fafc, #ffffff);
    border: 2px solid var(--color-metadata);
    border-radius: var(--radius-lg);
    padding: 24px;
    margin: 32px 0;
    box-shadow: var(--shadow-medium);
}

.toc-title {
    color: var(--color-primary);
    margin: 0 0 20px 0;
    font-size: 1.5rem;
    font-weight: 700;
    display: flex;
    align-items: center;
    gap: 8px;
}

.toc-search {
    margin-bottom: 20px;
}

.toc-search input {
    width: 100%;
    padding: 12px;
    border: 2px solid var(--color-metadata);
    border-radius: var(--radius-md);
    font-size: 1rem;
    transition: all var(--transition-base);
}

.toc-search input:focus {
    outline: none;
    border-color: var(--color-user);
    box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1);
}

.toc-stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 16px;
    margin-bottom: 24px;
}

.toc-stat-card {
    background: white;
    border-radius: var(--radius-md);
    padding: 16px;
    box-shadow: var(--shadow-subtle);
    transition: all var(--transition-base);
}

.toc-stat-card:hover {
    transform: translateY(-2px);
    box-shadow: var(--shadow-medium);
}

.toc-stat-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
}

.toc-icon {
    font-size: 1.2rem;
}

.toc-label {
    font-weight: 600;
    color: var(--color-secondary);
    font-size: 0.875rem;
}

.toc-count {
    font-size: 2rem;
    font-weight: 700;
    color: var(--color-primary);
    margin-bottom: 8px;
}

.toc-progress-bar {
    width: 100%;
    height: 4px;
    background: #e5e7eb;
    border-radius: 2px;
    overflow: hidden;
}

.toc-progress-fill {
    height: 100%;
    transition: width var(--transition-base);
}

.toc-nav-title {
    color: var(--color-secondary);
    margin: 0 0 16px 0;
    font-size: 1.125rem;
    font-weight: 600;
}

.toc-links {
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-height: 300px;
    overflow-y: auto;
}

.toc-link-item {
    padding: 8px 0;
    border-bottom: 1px solid #f3f4f6;
}

.toc-link-item:last-child {
    border-bottom: none;
}

.toc-link {
    display: flex;
    align-items: center;
    gap: 12px;
    text-decoration: none;
    transition: all var(--transition-base);
    padding: 8px 12px;
    border-radius: var(--radius-md);
}

.toc-link:hover {
    background: rgba(37, 99, 235, 0.1);
    transform: translateX(4px);
}

.toc-link.active {
    background: rgba(37, 99, 235, 0.15);
    font-weight: 600;
}

.toc-link-icon {
    font-size: 1rem;
}

.toc-link-text {
    flex: 1;
    font-weight: 500;
}

.toc-timestamp {
    font-size: 0.75rem;
    color: var(--color-metadata);
    font-family: monospace;
}

/* Contenu tronqué */
.truncation-container {
    position: relative;
}

.truncated-content,
.full-content {
    transition: all var(--transition-base);
}

.hidden {
    display: none;
}

.expand-button,
.collapse-button {
    background: var(--color-user);
    color: white;
    border: none;
    padding: 8px 16px;
    border-radius: var(--radius-md);
    font-size: 0.875rem;
    cursor: pointer;
    transition: all var(--transition-base);
    margin-top: 8px;
}

.expand-button:hover,
.collapse-button:hover {
    background: #1d4ed8;
    transform: translateY(-1px);
}

/* Contenu expandable */
.expandable-container {
    border: 2px solid var(--color-metadata);
    border-radius: var(--radius-md);
    margin: 16px 0;
}

.content-summary {
    padding: 16px;
    background: var(--bg-metadata);
    border-bottom: 1px solid var(--color-metadata);
}

.expand-toggle {
    width: 100%;
    padding: 12px;
    background: none;
    border: none;
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    transition: all var(--transition-base);
}

.expand-toggle:hover {
    background: rgba(107, 114, 128, 0.1);
}

.expand-icon {
    font-size: 0.875rem;
    transition: transform var(--transition-base);
}

.expand-text {
    font-weight: 500;
}

.expandable-content {
    padding: 16px;
    border-top: 1px solid var(--color-metadata);
    animation: fadeIn 0.3s ease-out;
}

/* Copy button */
.copy-button {
    background: var(--color-metadata);
    color: white;
    border: none;
    padding: 4px 8px;
    border-radius: var(--radius-sm);
    font-size: 0.75rem;
    cursor: pointer;
    transition: all var(--transition-base);
    z-index: 10;
}

.copy-button:hover {
    background: var(--color-secondary);
}

/* Highlight flash effect */
.highlight-flash {
    animation: highlightFlash 2s ease-out;
}

@keyframes highlightFlash {
    0% { background-color: rgba(37, 99, 235, 0.3); }
    100% { background-color: transparent; }
}

/* Ancres de navigation */
[id^="message-"] {
    scroll-margin-top: 20px;
}

/* Responsive pour les fonctionnalités Phase 5 */
@media (max-width: 768px) {
    .toc-stats-grid {
        grid-template-columns: repeat(2, 1fr);
        gap: 12px;
    }
    
    .toc-container {
        padding: 16px;
    }
    
    .toc-links {
        max-height: 200px;
    }
    
    .toc-link {
        font-size: 0.875rem;
    }
}
`;
    }

    /**
     * Retourne la couleur appropriée pour un type de message
     */
    static getTypeColor(type: string): string {
        switch (type) {
            case 'user': return this.CSS_THEME_COLORS.userMessage;
            case 'assistant': return this.CSS_THEME_COLORS.assistantMessage;
            case 'tool_call': return this.CSS_THEME_COLORS.toolCall;
            case 'tool_result': return this.CSS_THEME_COLORS.toolResult;
            case 'metadata': return this.CSS_THEME_COLORS.metadata;
            case 'error': return this.CSS_THEME_COLORS.error;
            default: return this.CSS_THEME_COLORS.secondary;
        }
    }
}