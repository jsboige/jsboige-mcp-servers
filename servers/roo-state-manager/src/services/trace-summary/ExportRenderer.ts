import { ConversationSkeleton } from '../../types/conversation.js';
import { SummaryOptions, SummaryStatistics, MsgType } from '../TraceSummaryService.js';
import { ClassifiedContent, ContentClassifier } from './ContentClassifier.js';

/**
 * ChatGPT-5: Item unifié pour la source unique TOC + Corps
 */
export interface RenderItem {
    type: MsgType;
    n: number;
    title: string;
    html: string;
    originalIndex?: number;
    toolType?: string;
    resultType?: string;
    sid?: string;      // ID de section stable (assigné une fois)
    tid?: string;      // ID TOC stable = 'toc-' + sid (assigné une fois)
    lineNumber?: number; // Ligne de référence dans le source
}

interface TechnicalBlock {
    type: 'thinking' | 'tool';
    content: string;
    toolTag?: string;
}

// ---- ChatGPT-5 Drop-in Helper Functions ------------------------------------------------

export function escapeHtml(s: string): string {
    return (s ?? '')
        .replace(/&/g, '&')
        .replace(/</g, '<').replace(/>/g, '>')
        .replace(/"/g, '"');
}

export function unescapeHtml(s: string): string {
    return (s ?? '')
        .replace(/</g, '<')
        .replace(/>/g, '>')
        .replace(/"/g, '"')
        .replace(/&/g, '&'); // DOIT être fait en dernier pour éviter double-décodage
}

function baseSectionId(i: RenderItem): string {
    switch (i.type) {
        case 'assistant': return `reponse-assistant-${i.n}`;
        case 'outil': return `outil-${i.n}`;
        case 'user': return `message-utilisateur-${i.n}`;
        case 'erreur': return `erreur-${i.n}`;
        case 'condensation': return `condensation-${i.n}`;
        case 'new-instructions': return `nouvelles-instructions-${i.n}`;
        case 'completion': return `completion-${i.n}`;
    }
}

/**
 * PLAN BÉTON ChatGPT-5 : Assignation UNIQUE et STABLE des IDs
 * On appelle cette fonction UNE SEULE FOIS avant tout rendu
 */
function assignStableIds(items: RenderItem[]): void {
    const used = new Set<string>();
    for (const it of items) {
        let sid = baseSectionId(it);
        // Dédup si collision exceptionnelle
        if (used.has(sid)) {
            let k = 2;
            while (used.has(`${sid}--${k}`)) k++;
            sid = `${sid}--${k}`;
        }
        used.add(sid);
        it.sid = sid;
        it.tid = `toc-${sid}`;
    }
}

function tocClass(t: MsgType): string {
    const map = {
        assistant: 'toc-assistant',
        outil: 'toc-tool',
        user: 'toc-user',
        erreur: 'toc-error',
        condensation: 'toc-context-condensation',
        'new-instructions': 'toc-new-instructions',
        completion: 'toc-completion',
    };
    return map[t];
}

function boxClass(t: MsgType): string {
    const map = {
        assistant: 'assistant-message',
        outil: 'tool-message',
        user: 'user-message',
        erreur: 'error-message',
        condensation: 'context-condensation-message',
        'new-instructions': 'user-message',
        completion: 'completion-message',
    };
    return map[t];
}

// ---- Sanitizer étanche par section (PLAN BÉTON - équilibrage sans destruction) -----------

export function sanitizeSectionHtml(raw: string): string {
    let html = raw ?? '';

    // CORRECTION CRITIQUE PHASE 0: Protéger les balises <details> contre l'interprétation Markdown
    // Les balises <details> indentées sont transformées en code blocks par Markdown
    // On les préserve en s'assurant qu'elles sont au niveau 0 (pas d'indentation)

    // 0) Protection des balises <details> - CORRECTION CRITIQUE
    html = html.replace(/^[ \t]*<details>/gm, '<details>');
    html = html.replace(/^[ \t]*<\/details>/gm, '</details>');
    html = html.replace(/^[ \t]*<summary>/gm, '<summary>');
    html = html.replace(/^[ \t]*<\/summary>/gm, '</summary>');

    // 1) Dédup de la 1ère/2e ligne (symptôme titres/lead répétés)
    const lines = html.split('\n');
    if (lines.length >= 2 && lines[0].trim() && lines[0].trim() === lines[1].trim()) {
        lines.splice(1, 1);
        html = lines.join('\n');
    }

    // 2) Equilibrage des fences ``` (sans détruire le contenu)
    const fenceCount = (html.match(/^```/gm) || []).length;
    if (fenceCount % 2 === 1) {
        html = html.replace(/\s*$/, '\n```\n');
    }

    // 3) Equilibrage <details> ... </details> (sans détruire le contenu)
    const openDetails = (html.match(/<details(\s|>)/g) || []).length;
    const closeDetails = (html.match(/<\/details>/g) || []).length;
    for (let i = 0; i < openDetails - closeDetails; i++) {
        html += '\n</details>';
    }

    // 4) Limiter les blancs successifs
    html = html.replace(/\n{3,}/g, '\n\n');

    // SUPPRIMÉ : N'échappe plus les </div> (erreur destructrice)
    // Pas de modification du HTML, seulement équilibrage

    return html;
}

/**
 * CORRECTION CRITIQUE : Détermine si un contenu est "pur bruit" (quasi-exclusivement du bruit environnemental)
 * Remplace l'ancien filtrage destructif par un nettoyage conservateur
 */
function isPureEnvironmentNoise(html: string, options: SummaryOptions): boolean {
    if (options.hideEnvironmentDetails === false) {
        return false;
    }
    if (!html) return true;

    // Créer une copie pour nettoyer et tester
    let cleanedContent = html;

    // Supprimer tous les blocs <environment_details>
    cleanedContent = cleanedContent.replace(/<environment_details>[\s\S]*?<\/environment_details>/gi, '');

    // Supprimer les sections VSCode typiques
    cleanedContent = cleanedContent.replace(/# VSCode Visible Files[\s\S]*?(?=# [A-Z]|\n\n|$)/gi, '');
    cleanedContent = cleanedContent.replace(/# VSCode Open Tabs[\s\S]*?(?=# [A-Z]|\n\n|$)/gi, '');
    cleanedContent = cleanedContent.replace(/# Current Time[\s\S]*?(?=# [A-Z]|\n\n|$)/gi, '');
    cleanedContent = cleanedContent.replace(/# Current Mode[\s\S]*?(?=# [A-Z]|\n\n|$)/gi, '');
    cleanedContent = cleanedContent.replace(/# Current Workspace Directory[\s\S]*?(?=# [A-Z]|\n\n|$)/gi, '');
    cleanedContent = cleanedContent.replace(/# Current Cost[\s\S]*?(?=# [A-Z]|\n\n|$)/gi, '');

    // Supprimer les lignes vides multiples et trim
    cleanedContent = cleanedContent.replace(/\n{3,}/g, '\n\n').trim();

    // Si après nettoyage il reste moins de 3 caractères et aucun mot alphanumérique : considérer comme pur bruit
    return cleanedContent.length < 3 || !/[a-zA-Z0-9]/.test(cleanedContent);
}

// ---- Rendu TOC & sections PLAN BÉTON (sans génération d'ID) -------------------------------

function renderTOCChatGPT5(items: RenderItem[]): string {
    // PLAN BÉTON : Les IDs ont déjà été assignés dans items[].sid et items[].tid
    const lines: string[] = [];
    lines.push('<ol class="toc-list">');
    for (const it of items) {
        // Utilise directement les IDs pré-assignés
        lines.push(
            `<li id="${it.tid}"><a class="${tocClass(it.type)}" href="#${it.sid}">${escapeHtml(it.title)}</a></li>`
        );
    }
    lines.push('</ol>');
    return lines.join('\n');
}

function renderSectionChatGPT5(it: RenderItem): string {
    // PLAN BÉTON : Les IDs ont déjà été assignés dans it.sid et it.tid
    const content = sanitizeSectionHtml(it.html);

    // S'assurer que l'ID de section et l'ID TOC sont bien définis
    if (!it.sid || !it.tid) {
        console.error(`[renderSectionChatGPT5] IDs manquants pour l'item type=${it.type} n=${it.n}`);
    }

    return [
        `<h3 id="${it.sid}">${escapeHtml(it.title)}</h3>`,
        `<div class="${boxClass(it.type)}">`,
        content,
        `</div>`,
        `<div class="back"><a href="#${it.tid}" title="Retour à l'entrée correspondante dans la table des matières">↑ Retour à la TOC</a></div>`,
        ''
    ].join('\n');
}

// ---- NOUVEAU : Rendu TOC & sections Markdown -------------------------------

function renderTOCMarkdown(items: RenderItem[]): string {
    const lines: string[] = [];
    // Format purement Markdown
    lines.push('## Table des Matières');
    lines.push('');
    for (const it of items) {
        const lineRef = it.lineNumber ? ` [L${it.lineNumber}]` : '';
        // Utilise l'ID de section stable pour le lien
        lines.push(
            `- [${escapeHtml(it.title)}${lineRef}](#${it.sid})`
        );
    }
    return lines.join('\n');
}

function renderSectionMarkdown(it: RenderItem): string {
    // Le contenu est déjà sanitizé en amont
    const content = it.html;

    if (!it.sid) {
        console.error(`[renderSectionMarkdown] ID manquant pour l'item type=${it.type} n=${it.n}`);
    }

    return [
        // Ancre de destination pour la TOC (nécessaire pour les liens)
        `<a id="${it.sid}"></a>`,
        `### ${escapeHtml(it.title)}`,
        ``,
        content,
        ``,
        // Lien de retour vers la TOC
        `[↑ TOC](#table-des-matières)`,
        ''
    ].join('\n');
}

/**
 * Service responsable du rendu des exports (HTML, Markdown, etc.)
 */
export class ExportRenderer {
    private classifier: ContentClassifier;

    constructor() {
        this.classifier = new ContentClassifier();
    }

    /**
     * Génère le contenu du résumé selon les options
     */
    public async renderSummary(
        conversation: ConversationSkeleton,
        classifiedContent: ClassifiedContent[],
        statistics: SummaryStatistics,
        options: SummaryOptions
    ): Promise<string> {
        const parts: string[] = [];

        // 1. En-tête et métadonnées
        parts.push(this.generateHeader(conversation, options));
        parts.push(this.generateMetadata(conversation, statistics));

        // 2. CSS si demandé
        if (options.includeCss) {
            parts.push(this.generateEmbeddedCss());
        }

        // 3. Statistiques
        parts.push(this.generateStatistics(statistics, options.compactStats));

        // 4. Table des matières maintenant générée dans renderConversationContent via ChatGPT-5
        // (supprimé pour éviter les doublons - la TOC est maintenant dans le contenu conversationnel)
        // Le rendu de la TOC est géré par renderTOCChatGPT5 qui utilise les IDs pré-calculés.

        // 5. NOUVELLE SECTION : Contenu conversationnel
        if (options.detailLevel !== 'Summary') {
            // SDDD Phase 3: Utilisation des strategies si activées
            // Note: renderConversationContentWithStrategies est dans TraceSummaryService pour l'instant
            // Pour ce refactoring, nous utilisons renderConversationContent qui est la méthode de base
            const conversationContent = await this.renderConversationContent(
                classifiedContent,
                options
            );
            parts.push(conversationContent);
        }

        // 6. Footer
        parts.push(this.generateFooter(options));

        let finalContent = parts.join('\n\n');

        // Assurer un seul bloc CSS si inclus
        if (options.includeCss) {
            finalContent = this.ensureSingleCss(finalContent);
        }

        return finalContent;
    }

    /**
     * Génère l'en-tête du résumé
     */
    public generateHeader(conversation: ConversationSkeleton, options: SummaryOptions): string {
        const dateStr = new Date().toLocaleString('fr-FR', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        }).replace(',', ' a');

        // Note: getOriginalContentSize est dans SummaryGenerator, on peut l'injecter ou le recalculer
        // Pour simplifier, on utilise une valeur approximative ou on passe la stat
        // Ici on va utiliser une méthode simplifiée
        const sourceSizeKB = Math.round(conversation.metadata.totalSize / 1024 * 10) / 10;

        return `# RESUME DE TRACE D'ORCHESTRATION ROO

**Fichier source :** roo_task_sep-8-2025_11-11-29-pm.md
**Date de generation :** ${dateStr}
**Taille source :** ${sourceSizeKB} KB`;
    }

    /**
     * Génère les métadonnées de base
     */
    public generateMetadata(conversation: ConversationSkeleton, statistics: SummaryStatistics): string {
        return `**Taille totale du contenu :** ${Math.round(statistics.totalContentSize / 1024 * 10) / 10} KB
**Nombre total d'échanges :** ${statistics.totalSections}
**Créé le :** ${new Date(conversation.metadata.createdAt).toLocaleString('fr-FR')}
**Dernière activité :** ${new Date(conversation.metadata.lastActivity).toLocaleString('fr-FR')}
**Mode de conversation :** ${conversation.metadata.mode || 'N/A'}`;
    }

    /**
     * Génère le CSS embarqué pour le styling
     */
    public generateEmbeddedCss(): string {
        return `<style id="trace-summary-styles">
:root {
    --toc-user: #F44336;
    --toc-assistant: #2196F3;
    --toc-tool: #FF9800;
    --toc-error: #F44336;
    --toc-condensation: #FF9500;
    --toc-completion: #4CAF50;
}
.user-message {
    background-color: #FFEBEE; /* Light Red */
    border-left: 4px solid var(--toc-user);
    padding: 15px;
    margin: 10px 0;
    border-radius: 5px;
}
.error-message {
    background-color: #FFEBEE;
    border-left: 4px solid var(--toc-error);
    padding: 15px;
    margin: 10px 0;
    border-radius: 5px;
}
.context-condensation-message {
    background-color: #FFF3E0;
    border-left: 4px solid var(--toc-condensation);
    padding: 15px;
    margin: 10px 0;
    border-radius: 5px;
    font-style: italic;
    box-shadow: 0 2px 4px rgba(255,149,0,0.1);
}
.assistant-message {
    background-color: #E3F2FD; /* Light Blue */
    border-left: 4px solid var(--toc-assistant);
    padding: 15px;
    margin: 10px 0;
    border-radius: 5px;
}
.tool-message {
    background-color: #FFF8E1; /* Light Orange */
    border-left: 4px solid var(--toc-tool);
    padding: 15px;
    margin: 10px 0;
    border-radius: 5px;
}
.completion-message {
    background-color: #E8F5E9; /* Light Green */
    border-left: 4px solid var(--toc-completion);
    padding: 15px;
    margin: 10px 0;
    border-radius: 5px;
}
.toc {
    background-color: #f8f9fa;
    border: 1px solid #dee2e6;
    border-radius: 8px;
    padding: 20px;
    margin: 15px 0;
}
.toc h3 {
    margin-top: 0;
    color: #495057;
    border-bottom: 2px solid #6c757d;
    padding-bottom: 10px;
}
.toc-user, .toc-new-instructions, .toc-instruction {
    color: var(--toc-user) !important;
    font-weight: bold;
    text-decoration: none;
}
.toc-user:hover, .toc-new-instructions:hover, .toc-instruction:hover { background-color: #FFEBEE; padding: 2px 4px; border-radius: 3px; }
.toc-assistant {
    color: var(--toc-assistant) !important;
    font-weight: bold;
    text-decoration: none;
}
.toc-assistant:hover { background-color: #E3F2FD; padding: 2px 4px; border-radius: 3px; }
.toc-tool {
    color: var(--toc-tool) !important;
    font-weight: bold;
    text-decoration: none;
}
.toc-tool:hover { background-color: #FFF8E1; padding: 2px 4px; border-radius: 3px; }
.toc-context-condensation {
    color: var(--toc-condensation) !important;
    font-weight: bold;
    text-decoration: none;
}
.toc-context-condensation:hover { background-color: #FFF3E0; padding: 2px 4px; border-radius: 3px; }
.toc-error {
    color: var(--toc-error) !important;
    font-weight: bold;
    text-decoration: none;
}
.toc-error:hover { background-color: #FFEBEE; padding: 2px 4px; border-radius: 3px; }
.toc-completion {
    color: var(--toc-completion) !important;
    font-weight: bold;
    text-decoration: none;
}
.toc-completion:hover { background-color: #E8F5E9; padding: 2px 4px; border-radius: 3px; }
.toc-new-instructions, .toc-instruction {
    font-style: italic;
}
</style>`;
    }

    /**
     * Génère les statistiques détaillées
     */
    public generateStatistics(statistics: SummaryStatistics, compact: boolean): string {
        const header = compact ? "## STATISTIQUES" : "## STATISTIQUES DETAILLEES";

        if (compact) {
            return `${header}

| Metrique | Valeur | % |
|----------|--------|---|
| Messages User | ${statistics.userMessages} | ${statistics.userPercentage.toFixed(1)}% |
| Reponses Assistant | ${statistics.assistantMessages} | ${statistics.assistantPercentage.toFixed(1)}% |
| Resultats d'outils | ${statistics.toolResults} | ${statistics.toolResultsPercentage.toFixed(1)}% |
| Total echanges | ${statistics.totalSections} | 100% |`;
        } else {
            return `${header}

| Metrique | Valeur | Taille | % |
|----------|--------|--------|---|
| Messages User | ${statistics.userMessages} | ${Math.round(statistics.userContentSize/1024 * 10)/10} KB | ${statistics.userPercentage.toFixed(1)}% |
| Reponses Assistant | ${statistics.assistantMessages} | ${Math.round(statistics.assistantContentSize/1024 * 10)/10} KB | ${statistics.assistantPercentage.toFixed(1)}% |
| Resultats d'outils | ${statistics.toolResults} | ${Math.round(statistics.toolResultsSize/1024 * 10)/10} KB | ${statistics.toolResultsPercentage.toFixed(1)}% |
| **Total echanges** | **${statistics.totalSections}** | **${Math.round(statistics.totalContentSize/1024 * 10)/10} KB** | **100%** |`;
        }
    }

    /**
     * Génère le footer du résumé
     */
    public generateFooter(options: SummaryOptions): string {
        return `---

*Généré par Roo State Manager - TraceSummaryService*`;
    }

    /**
     * NOUVEAU : Assure qu'un seul bloc CSS est présent dans le HTML final
     */
    public ensureSingleCss(html: string): string {
        const styleBlockRegex = /<style id="trace-summary-styles">[\s\S]*?<\/style>/g;
        const matches = html.match(styleBlockRegex);

        if (!matches || matches.length <= 1) {
            // Si 0 ou 1 bloc, s'assurer qu'il y en ait exactement un
            if (!matches) {
                return this.generateEmbeddedCss() + '\n\n' + html;
            }
            return html;
        }

        // Garder le premier bloc, supprimer les autres
        const firstBlock = matches[0];
        let cleanedHtml = html.replace(styleBlockRegex, ''); // Supprime tous les blocs
        cleanedHtml = firstBlock + '\n\n' + cleanedHtml; // Ré-insère le premier

        return cleanedHtml;
    }

    public async renderConversationContent(
        classifiedContent: ClassifiedContent[],
        options: SummaryOptions
    ): Promise<string> {
        // ALGORITHME OBLIGATOIRE ChatGPT-5 : Source unique items[]

        // 1) Construis d'abord items[] (filtré, numéroté). NE RENDS PAS encore le MD.
        const items: RenderItem[] = [];
        let globalCounter = 1;
        let isFirstUser = true;

        for (const item of classifiedContent) {
            let renderItem: RenderItem | null = null;

            switch (item.subType) {
                case 'UserMessage':
                    if (this.shouldIncludeMessageType('user', options.detailLevel)) {
                        if (isFirstUser) {
                            renderItem = {
                                type: 'user',
                                n: globalCounter,
                                title: `INSTRUCTION DE TÂCHE INITIALE`,
                                html: this.processInitialTaskContent(item.content, options),
                                lineNumber: item.lineNumber
                            };
                            isFirstUser = false;
                        } else {
                            const cleanedContent = this.cleanUserMessage(item.content, options);
                            const firstLine = this.getTruncatedFirstLine(cleanedContent, 200);
                            renderItem = {
                                type: 'user',
                                n: globalCounter,
                                title: `UTILISATEUR #${globalCounter} - ${firstLine}`,
                                html: cleanedContent,
                                lineNumber: item.lineNumber
                            };
                        }
                    }
                    break;

                case 'ErrorMessage':
                    if (this.shouldIncludeMessageType('user', options.detailLevel)) {
                        const cleanedContent = this.cleanUserMessage(item.content, options);
                        const firstLine = this.getTruncatedFirstLine(cleanedContent, 200);
                        renderItem = {
                            type: 'erreur',
                            n: globalCounter,
                            title: `ERREUR SYSTÈME #${globalCounter} - ${firstLine}`,
                            html: cleanedContent,
                            lineNumber: item.lineNumber
                        };
                    }
                    break;

                case 'ContextCondensation':
                    if (this.shouldIncludeMessageType('user', options.detailLevel)) {
                        const cleanedContent = this.cleanUserMessage(item.content, options);
                        const firstLine = this.getTruncatedFirstLine(cleanedContent, 200);
                        renderItem = {
                            type: 'condensation',
                            n: globalCounter,
                            title: `CONDENSATION CONTEXTE #${globalCounter} - ${firstLine}`,
                            html: cleanedContent,
                            lineNumber: item.lineNumber
                        };
                    }
                    break;

                case 'NewInstructions':
                    if (this.shouldIncludeMessageType('user', options.detailLevel)) {
                        // Extraire le contenu après "New instructions for task continuation:"
                        const instructionMatch = item.content.match(/^New instructions for task continuation:\s*(.*)/i);
                        const actualInstruction = instructionMatch ? instructionMatch[1] : item.content;
                        const cleanedContent = this.cleanUserMessage(actualInstruction, options);
                        const firstLine = this.getTruncatedFirstLine(cleanedContent, 200);
                        renderItem = {
                            type: 'new-instructions',
                            n: globalCounter,
                            title: `NOUVELLES INSTRUCTIONS #${globalCounter} - ${firstLine}`,
                            html: cleanedContent,
                            lineNumber: item.lineNumber
                        };
                    }
                    break;

                case 'ToolResult':
                    if (this.shouldIncludeMessageType('tool', options.detailLevel)) {
                        const bracket = this.classifier.extractToolBracketSummaryFromResult(item.content);
                        const titleSuffix = bracket ? `[${bracket}]` : this.classifier.extractToolType(item.content);
                        renderItem = {
                            type: 'outil',
                            n: globalCounter,
                            title: `OUTIL #${globalCounter} - ${titleSuffix}`,
                            html: await this.renderUserToolResult(item.content, options),
                            toolType: item.toolType,
                            resultType: item.resultType,
                            lineNumber: item.lineNumber
                        };
                        console.log(`[TraceSummaryService] Extracted bracket summary: "${bracket}"`);
                    }
                    break;

                case 'ToolCall':
                case 'Completion':
                    if (this.shouldIncludeMessageType('assistant', options.detailLevel)) {
                        const firstLine = this.getTruncatedFirstLine(item.content, 200);
                        const isCompletion = item.subType === 'Completion';
                        // Traiter le contenu avec processAssistantContent
                        const { textContent, technicalBlocks } = await this.processAssistantContent(item.content, options);
                        const tech = await this.renderTechnicalBlocks(technicalBlocks, options);
                        const html = [textContent.trim(), tech].filter(Boolean).join('\n\n');

                        renderItem = {
                            type: 'assistant',
                            n: globalCounter,
                            title: isCompletion
                                ? `ASSISTANT #${globalCounter} (Terminaison) - ${firstLine}`
                                : `ASSISTANT #${globalCounter} - ${firstLine}`,
                            html: html,
                            lineNumber: item.lineNumber
                        };
                        console.log(`[TraceSummaryService] Rendered ${technicalBlocks.length} technical blocks for assistant message`);
                    }
                    break;
            }

            if (renderItem) {
                items.push(renderItem);
                globalCounter++;
            }
        }

        // CORRECTION CRITIQUE : Journalisation avant filtrage
        const countsByType = this.countItemsByType(items);
        console.log(`[TraceSummaryService] AVANT filtrage: ${JSON.stringify(countsByType)}`);

        // 2) PLAN BÉTON : Filtrage conservateur du pur bruit AVANT rendu
        const filteredItems = items.filter(it => !isPureEnvironmentNoise(it.html, options));

        // CORRECTION CRITIQUE : Journalisation après filtrage
        const filteredCountsByType = this.countItemsByType(filteredItems);
        console.log(`[TraceSummaryService] APRÈS filtrage: ${JSON.stringify(filteredCountsByType)}`);

        // 🔧 CORRECTION OFF-BY-ONE : Renuméroter après filtrage pour commencer à 1
        for (let i = 0; i < filteredItems.length; i++) {
            const oldN = filteredItems[i].n;
            const newN = i + 1;
            filteredItems[i].n = newN;
            // Mettre à jour le titre pour refléter le nouveau numéro
            filteredItems[i].title = filteredItems[i].title.replace(`#${oldN}`, `#${newN}`);
        }

        // 3) PLAN BÉTON : Assignation UNIQUE des IDs (une seule fois)
        assignStableIds(filteredItems);

        // 4) Incrémenter globalCounter pour chaque élément ajouté
        // (déplacé ici pour s'assurer que tous les éléments sont comptés)
        const parts: string[] = [];

        // Section d'introduction
        parts.push("## ÉCHANGES DE CONVERSATION");
        parts.push("");

        // 4) Génération TOC (sans générer d'IDs - utilise les IDs pré-assignés)
        if (options.generateToc && options.detailLevel !== 'Summary') {
            if (options.tocStyle === 'html') {
                parts.push(renderTOCChatGPT5(filteredItems));
            } else {
                parts.push(renderTOCMarkdown(filteredItems));
            }
            parts.push("");
        }

        // 5) Génération sections (sans générer d'IDs - utilise les IDs pré-assignés)
        for (const item of filteredItems) {
            if (options.tocStyle === 'html') {
                parts.push(renderSectionChatGPT5(item));
            } else {
                parts.push(renderSectionMarkdown(item));
            }
            parts.push("");
        }

        return parts.join('\n\n');
    }

    /**
     * Détermine quels types de messages inclure selon le mode
     */
    private shouldIncludeMessageType(
        messageType: 'user' | 'assistant' | 'tool',
        detailLevel: string
    ): boolean {
        switch (detailLevel) {
            case 'UserOnly':
                return messageType === 'user';
            case 'Messages':
                return ['user', 'assistant'].includes(messageType);
            default:
                return true;
        }
    }

    /**
     * Traite le contenu de la tâche initiale avec Progressive Disclosure
     */
    private processInitialTaskContent(content: string, options: SummaryOptions): string {
        if (options.hideEnvironmentDetails === false) {
            return '```markdown\n' + content + '\n```';
        }

        const parts: string[] = [];

        // Détecter et séparer environment_details
        const envDetailsMatch = content.match(/<environment_details>[\s\S]*?<\/environment_details>/);

        if (envDetailsMatch) {
            const beforeEnv = content.substring(0, envDetailsMatch.index!).trim();
            const afterEnv = content.substring(envDetailsMatch.index! + envDetailsMatch[0].length).trim();

            // Contenu principal
            if (beforeEnv) {
                parts.push('```markdown');
                parts.push(beforeEnv);
                parts.push('```');
                parts.push("");
            }

            // Environment details en Progressive Disclosure
            parts.push("<details>");
            parts.push("<summary>**Environment Details** - Cliquez pour afficher</summary>");
            parts.push("");
            parts.push('```');
            parts.push(envDetailsMatch[0]);
            parts.push('```');
            parts.push("</details>");

            // Contenu après environment_details
            if (afterEnv) {
                parts.push("");
                parts.push('```markdown');
                parts.push(afterEnv);
                parts.push('```');
            }
        } else {
            // Pas d'environment_details, affichage normal
            parts.push('```markdown');
            parts.push(content);
            parts.push('```');
        }

        return parts.join('\n');
    }

    /**
     * Nettoie le contenu des messages utilisateur
     */
    private cleanUserMessage(content: string, options: SummaryOptions): string {
        if (options.hideEnvironmentDetails === false) {
            return content;
        }
        let cleaned = content;

        // Supprimer les environment_details très verbeux
        cleaned = cleaned.replace(
            /<environment_details>[\s\S]*?<\/environment_details>/g,
            '[Environment details supprimés pour lisibilité]'
        );

        // Supprimer les listes de fichiers très longues
        cleaned = cleaned.replace(
            /# Current Workspace Directory[\s\S]*?(?=# [A-Z]|\n\n|$)/g,
            '[Liste des fichiers workspace supprimée]'
        );

        // Garder les informations importantes mais raccourcir
        cleaned = cleaned.replace(
            /# VSCode Visible Files\n([^\n]*)\n\n# VSCode Open Tabs\n([^\n]*(?:\n[^\n#]*)*)/g,
            "**Fichiers actifs:** $1"
        );

        // Supprimer les métadonnées redondantes
        cleaned = cleaned.replace(/# Current (Cost|Time)[\s\S]*?\n/g, '');

        // Nettoyer les espaces multiples
        cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
        cleaned = cleaned.trim();

        // Si le message devient trop court, extraire l'essentiel
        if (cleaned.length < 50 && content.length > 200) {
            const userMessageMatch = content.match(/<user_message>([\s\S]*?)<\/user_message>/);
            if (userMessageMatch) {
                cleaned = userMessageMatch[1].trim();
            }
        }

        return cleaned;
    }

    /**
     * Extrait et tronque la première ligne d'un contenu
     */
    private getTruncatedFirstLine(content: string, maxLength: number = 100): string {
        if (!content) return '';

        const lines = content.split(/\r?\n/);
        for (const line of lines) {
            const trimmedLine = line.trim();
            if (trimmedLine && !trimmedLine.startsWith('<')) {
                return trimmedLine.length > maxLength
                    ? trimmedLine.substring(0, maxLength) + '...'
                    : trimmedLine;
            }
        }

        return '';
    }

    /**
     * Rend un résultat d'outil utilisateur avec section repliable dédiée
     */
    private async renderUserToolResult(content: string, options: SummaryOptions): Promise<string> {
        const item = { content, type: 'User', subType: 'ToolResult' } as ClassifiedContent;
        const details = this.classifier.extractToolResultDetails(item);

        if (!details) {
            return `**Résultat d'outil :** (parsing échoué)\n\`\`\`\n${content}\n\`\`\``;
        }

        // Extraire le résultat brut (après "[toolName] Result:")
        let rawResult = details.parsedResult?.content || content;
        rawResult = rawResult.replace(/^\[[^\]]+\] Result:\s*/i, '').trim();

        // CORRECTION FINALE: SUPPRIMER les environment_details (pas de section repliable)
        // Référence: PowerShell ligne 32 - Clean-UserMessage supprime complètement les environment_details
        let cleanedResult = rawResult.replace(/<environment_details>[\s\S]*?<\/environment_details>/g, '').trim();

        // Appliquer la troncature si nécessaire
        if (options.truncationChars > 0 && cleanedResult.length > options.truncationChars) {
            cleanedResult = cleanedResult.substring(0, options.truncationChars) + '... [tronqué]';
        }

        // Déterminer le titre de section approprié
        let sectionTitle: string;

        if (cleanedResult.includes('<files>')) {
            sectionTitle = '**files :** Cliquez pour afficher';
        } else if (details.toolName === 'browser_action') {
            sectionTitle = '**navigation web :** Cliquez pour afficher';
        } else {
            sectionTitle = '**résultat :** Cliquez pour afficher';
        }

        // Format final : UNE SEULE section <details> avec le résultat nettoyé
        const parts = [
            `**Résultat d'outil :** \`${details.toolName}\``,
            '',
            '<details>',
            `<summary>${sectionTitle}</summary>`,
            '',
            '```',
            escapeHtml(cleanedResult),
            '```',
            '</details>'
        ];

        return parts.join('\n');
    }

    /**
     * Traite le contenu assistant et extrait les blocs techniques
     */
    private async processAssistantContent(
        content: string,
        options: SummaryOptions
    ): Promise<{textContent: string, technicalBlocks: TechnicalBlock[]}> {
        let textContent = content;
        const technicalBlocks: TechnicalBlock[] = [];

        // 1. Extraction des blocs <thinking>
        let thinkingMatch;
        while ((thinkingMatch = textContent.match(/<thinking>[\s\S]*?<\/thinking>/)) !== null) {
            technicalBlocks.push({
                type: 'thinking',
                content: thinkingMatch[0]
            });
            textContent = textContent.replace(thinkingMatch[0], '');
        }

        // 2. Extraction des outils XML (patterns simples d'abord)
        const commonTools = ['read_file', 'write_to_file', 'apply_diff', 'execute_command', 'codebase_search', 'search_files'];
        for (const toolName of commonTools) {
            const toolRegex = new RegExp(`<${toolName}>([\\s\\S]*?)<\\/${toolName}>`, 'g');
            let toolMatch;
            while ((toolMatch = toolRegex.exec(textContent)) !== null) {
                technicalBlocks.push({
                    type: 'tool',
                    content: toolMatch[0],
                    toolTag: toolName
                });
                textContent = textContent.replace(toolMatch[0], '');
            }
        }

        // CORRECTION CRITIQUE : Gestion de l'échappement HTML selon le format de sortie
        // - En HTML : Échapper pour éviter l'injection de balises
        // - En markdown : Désechapper le contenu car les fichiers source contiennent du texte déjà échappé
        //   (les balises XML comme <read_file> sont stockées comme <read_file>)
        return {
            textContent: options.outputFormat === 'html'
                ? escapeHtml(textContent.trim())
                : unescapeHtml(textContent.trim()),
            technicalBlocks
        };
    }

    /**
     * Rend les blocs techniques avec Progressive Disclosure
     */
    private async renderTechnicalBlocks(
        blocks: TechnicalBlock[],
        options: SummaryOptions
    ): Promise<string> {
        const parts: string[] = [];

        for (const block of blocks) {
            switch (block.type) {
                case 'thinking':
                    if (this.shouldShowThinking(options.detailLevel)) {
                        parts.push("");
                        parts.push("<details>");
                        parts.push("<summary>**RÉFLEXION** - Cliquez pour afficher</summary>");
                        parts.push("");
                        parts.push('```xml');
                        parts.push(block.content);
                        parts.push('```');
                        parts.push("</details>");
                    }
                    break;

                case 'tool':
                    if (this.shouldShowTools(options.detailLevel)) {
                        const toolSection = await this.renderToolBlock(block, options);
                        parts.push(toolSection);
                    }
                    break;
            }
        }

        return parts.join('\n');
    }

    /**
     * Rend un bloc outil XML avec Progressive Disclosure et aperçu des paramètres
     */
    private async renderToolBlock(
        block: TechnicalBlock,
        options: SummaryOptions
    ): Promise<string> {
        const item = { content: block.content, type: 'Assistant', subType: 'ToolCall' } as ClassifiedContent;
        const details = this.classifier.extractToolCallDetails(item);

        if (!details || details.toolCalls.length === 0) {
            return `\n<details>\n<summary>OUTIL (parsing échoué)</summary>\n\n\`\`\`xml\n${block.content}\n\`\`\`\n\n</details>\n`;
        }

        // Utiliser la nouvelle fonction de formatage
        const markdownContent = this.formatToolCallsAsMarkdown(details);

        return `\n<details>\n<summary>OUTIL - ${details.toolCalls.map((c:any) => c.toolName).join(', ')}</summary>\n\n${markdownContent}\n\n</details>\n`;
    }

    /**
     * NOUVEAU : Formate les appels d'outils en Markdown granulaire
     * CORRECTION FINALE: Sections <details> individuelles pour chaque paramètre (référence PowerShell lignes 827-834)
     */
    private formatToolCallsAsMarkdown(details: any): string {
        if (!details || !details.toolCalls || details.toolCalls.length === 0) {
            return '';
        }

        const parts: string[] = [];
        for (const call of details.toolCalls) {
            // Section principale légère (juste le titre, pas de contenu)
            parts.push('*Voir sections détaillées ci-dessous*');
            parts.push('');

            if (call.parameters && Object.keys(call.parameters).length > 0) {
                // CORRECTION FINALE: Chaque paramètre a sa propre section <details> INDIVIDUELLE
                // Référence: PowerShell lignes 827-834 - sections séquentielles au même niveau
                for (const [paramName, paramValue] of Object.entries(call.parameters)) {
                    parts.push('<details>');
                    parts.push(`<summary>${paramName}</summary>`);
                    parts.push('');
                    // Afficher le contenu de la VALEUR du paramètre sans les balises XML englobantes
                    if (typeof paramValue === 'string') {
                        parts.push('```xml');
                        parts.push(paramValue);
                        parts.push('```');
                    } else {
                        parts.push('```json');
                        parts.push(JSON.stringify(paramValue, null, 2));
                        parts.push('```');
                    }
                    parts.push('</details>');
                    parts.push('');
                }
            }
        }
        return parts.join('\n');
    }

    /**
     * Détermine si les blocs thinking doivent être affichés
     */
    private shouldShowThinking(detailLevel: string): boolean {
        return ['Full', 'NoTools', 'NoResults'].includes(detailLevel);
    }

    /**
     * Détermine si les outils doivent être affichés
     */
    private shouldShowTools(detailLevel: string): boolean {
        return !['NoTools', 'Messages'].includes(detailLevel);
    }

    /**
     * CORRECTION CRITIQUE : Compte les items par type pour la journalisation
     */
    private countItemsByType(items: RenderItem[]): Record<string, number> {
        const counts: Record<string, number> = {
            user: 0,
            assistant: 0,
            outil: 0,
            erreur: 0,
            condensation: 0,
            'new-instructions': 0,
            completion: 0
        };

        for (const item of items) {
            if (counts.hasOwnProperty(item.type)) {
                counts[item.type]++;
            }
        }

        return counts;
    }
}