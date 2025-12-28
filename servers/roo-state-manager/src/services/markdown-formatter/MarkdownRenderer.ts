/**
 * MarkdownRenderer - Rendu Markdown de base
 * 
 * Responsable du formatage des messages, appels d'outils et résultats
 * en Markdown/HTML.
 */

export class MarkdownRenderer {
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
    <h1>${metadata.title || 'RESUME DE TRACE D\'ORCHESTRATION ROO'}</h1>
    
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