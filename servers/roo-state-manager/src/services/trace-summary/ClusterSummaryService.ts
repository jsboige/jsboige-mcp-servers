/**
 * ClusterSummaryService - Génération de résumés pour les grappes de tâches
 *
 * Extrait de TraceSummaryService.ts pour modularisation (#521)
 *
 * Responsable de:
 * - Validation et organisation des tâches en grappe
 * - Classification du contenu agrégé
 * - Calcul des statistiques de grappe
 * - Rendu multi-mode (aggregated, detailed, comparative)
 */

import {
    ConversationSkeleton,
    MessageSkeleton,
    ClusterSummaryOptions,
    ClusterSummaryStatistics,
    ClusterSummaryResult,
    OrganizedClusterTasks,
    ClassifiedClusterContent,
    CrossTaskPattern
} from '../../types/conversation.js';
import { SummaryOptions, SummaryStatistics } from '../../types/trace-summary.js';
import { SummaryGenerator } from './SummaryGenerator.js';
import { ContentClassifier, ClassifiedContent } from './ContentClassifier.js';
import { TraceSummaryServiceError, TraceSummaryServiceErrorCode } from '../../types/errors.js';

/**
 * Service de génération de résumés pour les grappes de tâches
 */
export class ClusterSummaryService {
    constructor(
        private readonly summaryGenerator: SummaryGenerator,
        private readonly classifier: ContentClassifier
    ) {}

    /**
     * Génère un résumé complet pour une grappe de tâches
     *
     * @param rootTask Tâche racine de la grappe (parent principal)
     * @param childTasks Liste des tâches enfantes de la grappe
     * @param options Options de génération spécifiques aux grappes
     * @param generateSummaryFn Fonction de génération de résumé individuel
     * @returns Résumé structuré de la grappe complète
     */
    async generateClusterSummary(
        rootTask: ConversationSkeleton,
        childTasks: ConversationSkeleton[],
        options: Partial<ClusterSummaryOptions> = {},
        generateSummaryFn: (conversation: ConversationSkeleton, opts: Partial<SummaryOptions>) => Promise<{ content: string }>
    ): Promise<ClusterSummaryResult> {
        try {
            // 1. Validation des entrées
            this.validateClusterInput(rootTask, childTasks);

            // 2. Configuration avec valeurs par défaut
            const finalOptions = this.mergeClusterOptions(options);

            // 3. Tri et organisation des tâches
            const organizedTasks = this.organizeClusterTasks(rootTask, childTasks, finalOptions);

            // 4. Classification du contenu agrégé
            const classifiedContent = await this.classifyClusterContent(organizedTasks, finalOptions);

            // 5. Calcul des statistiques de grappe
            const clusterStats = this.calculateClusterStatistics(organizedTasks, classifiedContent);

            // 6. Génération du contenu selon le mode
            const content = await this.renderClusterSummary(
                organizedTasks,
                clusterStats,
                finalOptions,
                generateSummaryFn
            );

            // 7. Construction du résultat
            return this.buildClusterResult(content, clusterStats, organizedTasks, finalOptions);

        } catch (error) {
            return {
                success: false,
                content: '',
                statistics: this.getEmptyClusterStatistics(),
                error: error instanceof Error ? error.message : 'Unknown error',
                clusterMetadata: {
                    rootTaskId: rootTask.taskId,
                    totalTasks: 0,
                    clusterMode: options.clusterMode || 'aggregated',
                    generationTimestamp: new Date().toISOString()
                },
                taskIndex: [],
                format: options.outputFormat || 'markdown',
                size: 0
            };
        }
    }

    // ============================================================================
    // MÉTHODES PRIVÉES - VALIDATION ET CONFIGURATION
    // ============================================================================

    private validateClusterInput(rootTask: ConversationSkeleton, childTasks: ConversationSkeleton[]): void {
        if (!rootTask || !rootTask.taskId) {
            throw new TraceSummaryServiceError(
                'Root task is required and must have a taskId',
                TraceSummaryServiceErrorCode.ROOT_TASK_REQUIRED,
                { rootTask }
            );
        }

        if (!Array.isArray(childTasks)) {
            throw new TraceSummaryServiceError(
                'Child tasks must be an array',
                TraceSummaryServiceErrorCode.CHILD_TASKS_INVALID,
                { childTasks: typeof childTasks }
            );
        }

        // Vérification que toutes les tâches enfantes référencent bien la tâche racine
        for (const child of childTasks) {
            if (child.parentTaskId !== rootTask.taskId) {
                console.warn(`Child task ${child.taskId} does not reference root task ${rootTask.taskId}`);
            }
        }
    }

    private mergeClusterOptions(options: Partial<ClusterSummaryOptions>): ClusterSummaryOptions {
        return {
            // Options héritées des résumés standards
            detailLevel: options.detailLevel || 'Full',
            truncationChars: options.truncationChars || 0,
            compactStats: options.compactStats || false,
            includeCss: options.includeCss !== false,
            generateToc: options.generateToc !== false,
            outputFormat: options.outputFormat || 'markdown',

            // Options spécifiques aux grappes
            clusterMode: options.clusterMode || 'aggregated',
            includeClusterStats: options.includeClusterStats !== false,
            crossTaskAnalysis: options.crossTaskAnalysis || false,
            maxClusterDepth: options.maxClusterDepth || 10,
            clusterSortBy: options.clusterSortBy || 'chronological',
            includeClusterTimeline: options.includeClusterTimeline || false,
            clusterTruncationChars: options.clusterTruncationChars || 0,
            showTaskRelationships: options.showTaskRelationships !== false
        };
    }

    // ============================================================================
    // MÉTHODES PRIVÉES - ORGANISATION DES TÂCHES
    // ============================================================================

    private organizeClusterTasks(
        rootTask: ConversationSkeleton,
        childTasks: ConversationSkeleton[],
        options: ClusterSummaryOptions
    ): OrganizedClusterTasks {

        const allTasks = [rootTask, ...childTasks];

        // Tri selon la stratégie choisie
        let sortedTasks: ConversationSkeleton[];
        switch (options.clusterSortBy) {
            case 'chronological':
                sortedTasks = this.sortTasksByChronology(allTasks);
                break;
            case 'size':
                sortedTasks = this.sortTasksBySize(allTasks);
                break;
            case 'activity':
                sortedTasks = this.sortTasksByActivity(allTasks);
                break;
            case 'alphabetical':
                sortedTasks = this.sortTasksAlphabetically(allTasks);
                break;
            default:
                sortedTasks = this.sortTasksByChronology(allTasks);
        }

        // Construction de la hiérarchie
        const taskHierarchy = new Map<string, ConversationSkeleton[]>();
        taskHierarchy.set(rootTask.taskId, childTasks);

        return {
            rootTask,
            allTasks,
            sortedTasks,
            taskHierarchy,
            taskOrder: sortedTasks.map(task => task.taskId)
        };
    }

    private sortTasksByChronology(tasks: ConversationSkeleton[]): ConversationSkeleton[] {
        return [...tasks].sort((a, b) =>
            new Date(a.metadata.createdAt).getTime() - new Date(b.metadata.createdAt).getTime()
        );
    }

    private sortTasksBySize(tasks: ConversationSkeleton[]): ConversationSkeleton[] {
        return [...tasks].sort((a, b) => b.metadata.totalSize - a.metadata.totalSize);
    }

    private sortTasksByActivity(tasks: ConversationSkeleton[]): ConversationSkeleton[] {
        return [...tasks].sort((a, b) =>
            new Date(b.metadata.lastActivity).getTime() - new Date(a.metadata.lastActivity).getTime()
        );
    }

    private sortTasksAlphabetically(tasks: ConversationSkeleton[]): ConversationSkeleton[] {
        return [...tasks].sort((a, b) => {
            const titleA = a.metadata.title || a.taskId;
            const titleB = b.metadata.title || b.taskId;
            return titleA.localeCompare(titleB);
        });
    }

    // ============================================================================
    // MÉTHODES PRIVÉES - CLASSIFICATION DU CONTENU
    // ============================================================================

    private async classifyClusterContent(organizedTasks: OrganizedClusterTasks, options?: ClusterSummaryOptions): Promise<ClassifiedClusterContent> {
        const allClassifiedContent: ClassifiedContent[] = [];
        const perTaskContent = new Map<string, ClassifiedContent[]>();

        // Classification par tâche individuelle
        for (const task of organizedTasks.allTasks) {
            // Adapter les ClusterSummaryOptions vers SummaryOptions si nécessaire
            const summaryOptions: SummaryOptions | undefined = options ? {
                detailLevel: options.detailLevel || 'Full',
                truncationChars: options.truncationChars || 0,
                compactStats: options.compactStats || false,
                includeCss: options.includeCss || false,
                generateToc: options.generateToc || false,
                outputFormat: options.outputFormat || 'markdown',
                startIndex: options.startIndex,
                endIndex: options.endIndex
            } : undefined;

            const taskContent = await this.classifier.classifyContentFromMarkdownOrJson(task, summaryOptions);
            perTaskContent.set(task.taskId, taskContent);
            allClassifiedContent.push(...taskContent);
        }

        // Identification des patterns cross-task
        const crossTaskPatterns = this.identifyCrossTaskPatterns(perTaskContent);

        return {
            aggregatedContent: allClassifiedContent,
            perTaskContent,
            crossTaskPatterns
        };
    }

    private identifyCrossTaskPatterns(perTaskContent: Map<string, ClassifiedContent[]>): CrossTaskPattern[] {
        const patterns: CrossTaskPattern[] = [];
        const toolUsage = new Map<string, string[]>();
        const modeUsage = new Map<string, string[]>();

        // Analyse des outils utilisés par tâche
        for (const [taskId, content] of perTaskContent) {
            const usedTools = new Set<string>();

            for (const item of content) {
                if (item.toolType) {
                    usedTools.add(item.toolType);
                }
            }

            for (const tool of usedTools) {
                if (!toolUsage.has(tool)) {
                    toolUsage.set(tool, []);
                }
                toolUsage.get(tool)!.push(taskId);
            }
        }

        // Création des patterns pour les outils fréquents
        for (const [tool, taskIds] of toolUsage) {
            if (taskIds.length > 1) {
                patterns.push({
                    pattern: tool,
                    frequency: taskIds.length,
                    taskIds,
                    category: 'tool'
                });
            }
        }

        return patterns.sort((a, b) => b.frequency - a.frequency);
    }

    // ============================================================================
    // MÉTHODES PRIVÉES - STATISTIQUES
    // ============================================================================

    private calculateClusterStatistics(
        organizedTasks: OrganizedClusterTasks,
        classifiedContent: ClassifiedClusterContent
    ): ClusterSummaryStatistics {

        // Statistiques de base (réutilise la logique existante)
        const baseStats = this.summaryGenerator.calculateStatistics(classifiedContent.aggregatedContent);

        // Métriques spécifiques aux grappes
        const totalTasks = organizedTasks.allTasks.length;
        const clusterDepth = this.calculateClusterDepth(organizedTasks);
        const averageTaskSize = organizedTasks.allTasks.reduce((sum, task) =>
            sum + task.metadata.totalSize, 0) / totalTasks;

        // Distribution des tâches
        const taskDistribution = this.calculateTaskDistribution(organizedTasks.allTasks);

        // Analyse temporelle
        const clusterTimeSpan = this.calculateClusterTimeSpan(organizedTasks.allTasks);

        // Métriques de contenu agrégées
        const clusterContentStats = this.aggregateContentStats(organizedTasks.allTasks);

        // Patterns communs
        const commonPatterns = this.analyzeCommonPatterns(classifiedContent);

        return {
            // Statistiques héritées
            ...baseStats,

            // Métriques spécifiques aux grappes
            totalTasks,
            clusterDepth,
            averageTaskSize,
            taskDistribution,
            clusterTimeSpan,
            clusterContentStats,
            commonPatterns
        };
    }

    private calculateClusterDepth(organizedTasks: OrganizedClusterTasks): number {
        // Pour l'instant, nous gérons seulement 1 niveau (parent + enfants)
        return organizedTasks.allTasks.length > 1 ? 2 : 1;
    }

    private calculateTaskDistribution(tasks: ConversationSkeleton[]) {
        const byMode: Record<string, number> = {};
        const bySize = { small: 0, medium: 0, large: 0 };
        const byActivity: Record<string, number> = {};

        for (const task of tasks) {
            // Distribution par mode
            const mode = task.metadata.mode || 'unknown';
            byMode[mode] = (byMode[mode] || 0) + 1;

            // Distribution par taille
            const size = task.metadata.totalSize;
            if (size < 10000) bySize.small++;
            else if (size < 100000) bySize.medium++;
            else bySize.large++;

            // Distribution par date d'activité (par jour)
            const activityDate = new Date(task.metadata.lastActivity).toDateString();
            byActivity[activityDate] = (byActivity[activityDate] || 0) + 1;
        }

        return { byMode, bySize, byActivity };
    }

    private calculateClusterTimeSpan(tasks: ConversationSkeleton[]) {
        const dates = tasks.map(task => new Date(task.metadata.createdAt));
        const startTime = new Date(Math.min(...dates.map(d => d.getTime())));
        const endTime = new Date(Math.max(...dates.map(d => d.getTime())));
        const totalDurationHours = (endTime.getTime() - startTime.getTime()) / (1000 * 60 * 60);

        return {
            startTime: startTime.toISOString(),
            endTime: endTime.toISOString(),
            totalDurationHours
        };
    }

    private aggregateContentStats(tasks: ConversationSkeleton[]) {
        let totalUserMessages = 0;
        let totalAssistantMessages = 0;
        let totalToolResults = 0;
        let totalContentSize = 0;

        for (const task of tasks) {
            const messages = task.sequence.filter((item): item is MessageSkeleton =>
                'role' in item);

            for (const message of messages) {
                if (message.role === 'user') {
                    if (this.classifier.isToolResult(message.content)) {
                        totalToolResults++;
                    } else {
                        totalUserMessages++;
                    }
                } else if (message.role === 'assistant') {
                    totalAssistantMessages++;
                }
                totalContentSize += message.content.length;
            }
        }

        const averageMessagesPerTask = tasks.length > 0 ?
            (totalUserMessages + totalAssistantMessages + totalToolResults) / tasks.length : 0;

        return {
            totalUserMessages,
            totalAssistantMessages,
            totalToolResults,
            totalContentSize,
            averageMessagesPerTask
        };
    }

    private analyzeCommonPatterns(classifiedContent: ClassifiedClusterContent) {
        const frequentTools: Record<string, number> = {};
        const commonModes: Record<string, number> = {};
        const crossTaskTopics: string[] = [];

        // Analyse des outils fréquents
        for (const pattern of classifiedContent.crossTaskPatterns) {
            if (pattern.category === 'tool') {
                frequentTools[pattern.pattern] = pattern.frequency;
            } else if (pattern.category === 'mode') {
                commonModes[pattern.pattern] = pattern.frequency;
            }
        }

        // Les topics cross-task peuvent être extraits des patterns
        crossTaskTopics.push(...classifiedContent.crossTaskPatterns
            .filter(p => p.category === 'topic')
            .map(p => p.pattern));

        return {
            frequentTools,
            commonModes,
            crossTaskTopics
        };
    }

    private getEmptyClusterStatistics(): ClusterSummaryStatistics {
        const emptyStats: SummaryStatistics = {
            totalSections: 0,
            userMessages: 0,
            assistantMessages: 0,
            toolResults: 0,
            userContentSize: 0,
            assistantContentSize: 0,
            toolResultsSize: 0,
            totalContentSize: 0,
            userPercentage: 0,
            assistantPercentage: 0,
            toolResultsPercentage: 0
        };
        return {
            ...emptyStats,
            totalTasks: 0,
            clusterDepth: 0,
            averageTaskSize: 0,
            taskDistribution: {
                byMode: {},
                bySize: { small: 0, medium: 0, large: 0 },
                byActivity: {}
            },
            clusterTimeSpan: {
                startTime: new Date().toISOString(),
                endTime: new Date().toISOString(),
                totalDurationHours: 0
            },
            clusterContentStats: {
                totalUserMessages: 0,
                totalAssistantMessages: 0,
                totalToolResults: 0,
                totalContentSize: 0,
                averageMessagesPerTask: 0
            }
        };
    }

    // ============================================================================
    // MÉTHODES PRIVÉES - RENDU
    // ============================================================================

    private async renderClusterSummary(
        organizedTasks: OrganizedClusterTasks,
        statistics: ClusterSummaryStatistics,
        options: ClusterSummaryOptions,
        generateSummaryFn: (conversation: ConversationSkeleton, opts: Partial<SummaryOptions>) => Promise<{ content: string }>
    ): Promise<string> {

        const parts: string[] = [];

        // En-tête de grappe
        parts.push(this.renderClusterHeader(organizedTasks.rootTask, statistics, options));

        // Métadonnées de grappe
        parts.push(this.renderClusterMetadata(organizedTasks, statistics, options));

        // Statistiques de grappe
        if (options.includeClusterStats) {
            parts.push(this.renderClusterStatistics(statistics, options));
        }

        // Table des matières
        if (options.generateToc) {
            parts.push(this.renderClusterTableOfContents(organizedTasks, options));
        }

        // Timeline unifiée
        if (options.includeClusterTimeline) {
            parts.push(this.renderClusterTimeline(organizedTasks, statistics));
        }

        // Contenu selon le mode
        switch (options.clusterMode) {
            case 'aggregated':
                parts.push(await this.renderAggregatedContent(organizedTasks, statistics, options, generateSummaryFn));
                break;
            case 'detailed':
                parts.push(await this.renderDetailedContent(organizedTasks, statistics, options, generateSummaryFn));
                break;
            case 'comparative':
                parts.push(await this.renderComparativeContent(organizedTasks, statistics, options, generateSummaryFn));
                break;
            default:
                parts.push(await this.renderAggregatedContent(organizedTasks, statistics, options, generateSummaryFn));
        }

        // Analyse cross-task
        if (options.crossTaskAnalysis) {
            parts.push(this.renderCrossTaskAnalysis(organizedTasks, statistics));
        }

        return parts.join('\n\n');
    }

    private renderClusterHeader(
        rootTask: ConversationSkeleton,
        statistics: ClusterSummaryStatistics,
        options: ClusterSummaryOptions
    ): string {

        const title = rootTask.metadata.title || 'Grappe de Tâches Sans Titre';
        const taskCount = statistics.totalTasks;
        const timeSpan = this.formatDuration(statistics.clusterTimeSpan.totalDurationHours);

        if (options.outputFormat === 'html') {
            return `<h1>🔗 ${title}</h1>
<div class="cluster-summary-header">
    <p><strong>Type:</strong> Résumé de Grappe de Tâches</p>
    <p><strong>Nombre de tâches:</strong> ${taskCount}</p>
    <p><strong>Durée totale:</strong> ${timeSpan}</p>
    <p><strong>Mode de rendu:</strong> ${options.clusterMode}</p>
</div>`;
        } else {
            return `# 🔗 ${title}

**Type:** Résumé de Grappe de Tâches
**Nombre de tâches:** ${taskCount}
**Durée totale:** ${timeSpan}
**Mode de rendu:** ${options.clusterMode}
**Généré le:** ${new Date().toLocaleString('fr-FR')}`;
        }
    }

    private renderClusterMetadata(
        organizedTasks: OrganizedClusterTasks,
        statistics: ClusterSummaryStatistics,
        options: ClusterSummaryOptions
    ): string {
        const metadata = statistics.clusterContentStats;
        const timeSpan = statistics.clusterTimeSpan;

        if (options.outputFormat === 'html') {
            return `<div class="cluster-metadata">
<h2>📊 Métadonnées de la Grappe</h2>
<div class="metadata-grid">
    <div class="metadata-item">
        <strong>Tâche racine :</strong> ${organizedTasks.rootTask.metadata.title || organizedTasks.rootTask.taskId}
    </div>
    <div class="metadata-item">
        <strong>Nombre de tâches enfantes :</strong> ${organizedTasks.allTasks.length - 1}
    </div>
    <div class="metadata-item">
        <strong>Profondeur de grappe :</strong> ${statistics.clusterDepth} niveau${statistics.clusterDepth > 1 ? 'x' : ''}
    </div>
    <div class="metadata-item">
        <strong>Période d'activité :</strong> ${new Date(timeSpan.startTime).toLocaleDateString('fr-FR')} - ${new Date(timeSpan.endTime).toLocaleDateString('fr-FR')}
    </div>
    <div class="metadata-item">
        <strong>Durée totale :</strong> ${this.formatDuration(timeSpan.totalDurationHours)}
    </div>
    <div class="metadata-item">
        <strong>Taille moyenne par tâche :</strong> ${this.formatBytes(statistics.averageTaskSize)}
    </div>
    <div class="metadata-item">
        <strong>Messages totaux :</strong> ${metadata.totalUserMessages + metadata.totalAssistantMessages}
    </div>
    <div class="metadata-item">
        <strong>Résultats d'outils :</strong> ${metadata.totalToolResults}
    </div>
</div>
</div>`;
        } else {
            return `## 📊 Métadonnées de la Grappe

| **Propriété** | **Valeur** |
|---------------|------------|
| **Tâche racine** | ${organizedTasks.rootTask.metadata.title || organizedTasks.rootTask.taskId} |
| **Nombre de tâches enfantes** | ${organizedTasks.allTasks.length - 1} |
| **Profondeur de grappe** | ${statistics.clusterDepth} niveau${statistics.clusterDepth > 1 ? 'x' : ''} |
| **Période d'activité** | ${new Date(timeSpan.startTime).toLocaleDateString('fr-FR')} - ${new Date(timeSpan.endTime).toLocaleDateString('fr-FR')} |
| **Durée totale** | ${this.formatDuration(timeSpan.totalDurationHours)} |
| **Taille moyenne par tâche** | ${this.formatBytes(statistics.averageTaskSize)} |
| **Messages totaux** | ${metadata.totalUserMessages + metadata.totalAssistantMessages} |
| **Résultats d'outils** | ${metadata.totalToolResults} |`;
        }
    }

    private renderClusterStatistics(statistics: ClusterSummaryStatistics, options: ClusterSummaryOptions): string {
        const dist = statistics.taskDistribution;
        const patterns = statistics.commonPatterns;

        if (options.compactStats) {
            return this.renderCompactClusterStats(statistics);
        }

        if (options.outputFormat === 'html') {
            return `<div class="cluster-statistics">
<h2>📈 Statistiques de la Grappe</h2>

<h3>Distribution des Tâches</h3>
<div class="stats-section">
    <h4>Par Mode :</h4>
    <ul>${Object.entries(dist.byMode).map(([mode, count]) =>
        `<li><strong>${mode}</strong>: ${count} tâche${count > 1 ? 's' : ''}</li>`).join('')}</ul>

    <h4>Par Taille :</h4>
    <ul>
        <li><strong>Petites</strong> (<10KB): ${dist.bySize.small} tâche${dist.bySize.small > 1 ? 's' : ''}</li>
        <li><strong>Moyennes</strong> (10-100KB): ${dist.bySize.medium} tâche${dist.bySize.medium > 1 ? 's' : ''}</li>
        <li><strong>Grandes</strong> (>100KB): ${dist.bySize.large} tâche${dist.bySize.large > 1 ? 's' : ''}</li>
    </ul>
</div>

${patterns ? `<h3>Outils Fréquents</h3>
<div class="tools-section">
    <ul>${Object.entries(patterns.frequentTools).map(([tool, count]) =>
        `<li><strong>${tool}</strong>: utilisé dans ${count} tâche${count > 1 ? 's' : ''}</li>`).join('')}</ul>
</div>` : ''}

<h3>Métriques de Contenu</h3>
<div class="content-metrics">
    <p><strong>Messages utilisateur :</strong> ${statistics.clusterContentStats.totalUserMessages}</p>
    <p><strong>Messages assistant :</strong> ${statistics.clusterContentStats.totalAssistantMessages}</p>
    <p><strong>Résultats d'outils :</strong> ${statistics.clusterContentStats.totalToolResults}</p>
    <p><strong>Moyenne messages/tâche :</strong> ${Math.round(statistics.clusterContentStats.averageMessagesPerTask * 10) / 10}</p>
</div>
</div>`;
        } else {
            return `## 📈 Statistiques de la Grappe

### Distribution des Tâches

**Par Mode :**
${Object.entries(dist.byMode).map(([mode, count]) =>
    `- **${mode}** : ${count} tâche${count > 1 ? 's' : ''}`).join('\n')}

**Par Taille :**
- **Petites** (<10KB) : ${dist.bySize.small} tâche${dist.bySize.small > 1 ? 's' : ''}
- **Moyennes** (10-100KB) : ${dist.bySize.medium} tâche${dist.bySize.medium > 1 ? 's' : ''}
- **Grandes** (>100KB) : ${dist.bySize.large} tâche${dist.bySize.large > 1 ? 's' : ''}

${patterns && Object.keys(patterns.frequentTools).length > 0 ? `### Outils Fréquents

${Object.entries(patterns.frequentTools).map(([tool, count]) =>
    `- **${tool}** : utilisé dans ${count} tâche${count > 1 ? 's' : ''}`).join('\n')}
` : ''}

### Métriques de Contenu

- **Messages utilisateur :** ${statistics.clusterContentStats.totalUserMessages}
- **Messages assistant :** ${statistics.clusterContentStats.totalAssistantMessages}
- **Résultats d'outils :** ${statistics.clusterContentStats.totalToolResults}
- **Moyenne messages/tâche :** ${Math.round(statistics.clusterContentStats.averageMessagesPerTask * 10) / 10}`;
        }
    }

    private renderCompactClusterStats(statistics: ClusterSummaryStatistics): string {
        const content = statistics.clusterContentStats;
        return `**Statistiques :** ${statistics.totalTasks} tâches, ${content.totalUserMessages + content.totalAssistantMessages} messages, ${content.totalToolResults} outils, ${this.formatDuration(statistics.clusterTimeSpan.totalDurationHours)}`;
    }

    private renderClusterTableOfContents(organizedTasks: OrganizedClusterTasks, options: ClusterSummaryOptions): string {
        if (options.outputFormat === 'html') {
            return `<div class="cluster-toc" id="table-des-matieres">
<h2>📑 Table des Matières</h2>
<nav class="toc-nav">
    <ol>
        <li><a href="#tache-racine-${this.sanitizeId(organizedTasks.rootTask.taskId)}">
            🎯 ${organizedTasks.rootTask.metadata.title || 'Tâche Racine'}
        </a></li>
        ${organizedTasks.sortedTasks.slice(1).map((task, index) =>
            `<li><a href="#tache-${this.sanitizeId(task.taskId)}">
                📝 ${task.metadata.title || `Tâche ${index + 1}`}
            </a></li>`
        ).join('')}
    </ol>
</nav>
</div>`;
        } else {
            return `## 📑 Table des Matières

1. [🎯 ${organizedTasks.rootTask.metadata.title || 'Tâche Racine'}](#tache-racine-${this.sanitizeId(organizedTasks.rootTask.taskId)})
${organizedTasks.sortedTasks.slice(1).map((task, index) =>
    `${index + 2}. [📝 ${task.metadata.title || `Tâche ${index + 1}`}](#tache-${this.sanitizeId(task.taskId)})`
).join('\n')}`;
        }
    }

    private renderClusterTimeline(organizedTasks: OrganizedClusterTasks, statistics: ClusterSummaryStatistics): string {
        const sortedByDate = [...organizedTasks.allTasks].sort((a, b) =>
            new Date(a.metadata.createdAt).getTime() - new Date(b.metadata.createdAt).getTime()
        );

        return `## ⏰ Timeline de la Grappe

${sortedByDate.map(task => {
            const date = new Date(task.metadata.createdAt);
            const icon = task === organizedTasks.rootTask ? '🎯' : '📝';
            const size = this.formatBytes(task.metadata.totalSize);

            return `**${date.toLocaleDateString('fr-FR')} ${date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}** - ${icon} ${task.metadata.title || task.taskId} (${size})`;
        }).join('\n')}`;
    }

    private async renderAggregatedContent(
        organizedTasks: OrganizedClusterTasks,
        statistics: ClusterSummaryStatistics,
        options: ClusterSummaryOptions,
        generateSummaryFn: (conversation: ConversationSkeleton, opts: Partial<SummaryOptions>) => Promise<{ content: string }>
    ): Promise<string> {
        const parts: string[] = [];

        // En-tête du contenu agrégé
        parts.push(`## 🔗 Contenu Agrégé de la Grappe`);

        // Résumé global
        const globalSummary = await this.generateGlobalClusterSummary(organizedTasks, options);
        parts.push(`### Résumé Global\n${globalSummary}`);

        // Contenu par tâche avec sections condensées
        parts.push(`### Contenu des Tâches`);

        for (const task of organizedTasks.sortedTasks) {
            const taskSummary = await generateSummaryFn(task, {
                detailLevel: 'Summary',
                truncationChars: options.clusterTruncationChars || 1000,
                compactStats: true,
                includeCss: false,
                generateToc: false,
                outputFormat: options.outputFormat
            });

            const icon = task === organizedTasks.rootTask ? '🎯' : '📝';
            const taskId = this.sanitizeId(task.taskId);
            const title = task.metadata.title || task.taskId;

            parts.push(`#### ${icon} ${title} {#tache${task === organizedTasks.rootTask ? '-racine' : ''}-${taskId}}`);
            parts.push(taskSummary.content);

            if (options.showTaskRelationships && task !== organizedTasks.rootTask) {
                parts.push(`*Tâche enfante de : ${organizedTasks.rootTask.metadata.title || organizedTasks.rootTask.taskId}*`);
            }

            parts.push('---'); // Séparateur
        }

        return parts.join('\n\n');
    }

    private async generateGlobalClusterSummary(
        organizedTasks: OrganizedClusterTasks,
        options: ClusterSummaryOptions
    ): Promise<string> {
        // Agrège les interactions principales de toutes les tâches
        const allInteractions: string[] = [];
        const toolsUsed = new Set<string>();
        const modesUsed = new Set<string>();

        // Calcul de la durée totale
        const allDates = organizedTasks.allTasks.map(task => new Date(task.metadata.createdAt));
        const startTime = new Date(Math.min(...allDates.map(d => d.getTime())));
        const endTime = new Date(Math.max(...allDates.map(d => d.getTime())));
        const totalDurationHours = (endTime.getTime() - startTime.getTime()) / (1000 * 60 * 60);

        for (const task of organizedTasks.allTasks) {
            // Extrait le contexte principal de chaque tâche
            const messages = task.sequence.filter((item): item is MessageSkeleton => 'role' in item);

            // Première et dernière interaction utilisateur pour le contexte
            const userMessages = messages.filter(m => m.role === 'user' && !this.classifier.isToolResult(m.content));

            if (userMessages.length > 0) {
                const firstMessage = userMessages[0].content.substring(0, 200);
                allInteractions.push(`**${task.metadata.title || task.taskId}**: ${firstMessage}...`);
            }

            // Collecte des outils et modes
            if (task.metadata.mode) modesUsed.add(task.metadata.mode);

            // Extraction des outils depuis les messages d'outils
            const toolMessages = messages.filter(m => m.role === 'user' && this.classifier.isToolResult(m.content));
            for (const toolMsg of toolMessages) {
                const toolMatch = toolMsg.content.match(/\[(\w+) for/);
                if (toolMatch) toolsUsed.add(toolMatch[1]);
            }
        }

        const summary = `Cette grappe de ${organizedTasks.allTasks.length} tâches${organizedTasks.allTasks.length > 1 ? ` organisée autour de "${organizedTasks.rootTask.metadata.title || 'la tâche racine'}"` : ''} couvre une période de ${this.formatDuration(totalDurationHours)}.

**Modes utilisés :** ${Array.from(modesUsed).join(', ') || 'Non spécifié'}
**Outils principaux :** ${Array.from(toolsUsed).slice(0, 5).join(', ') || 'Aucun outil détecté'}${Array.from(toolsUsed).length > 5 ? ' et autres...' : ''}

**Interactions principales :**
${allInteractions.slice(0, 3).join('\n')}${allInteractions.length > 3 ? '\n*...et autres interactions*' : ''}`;

        return summary;
    }

    private async renderDetailedContent(
        organizedTasks: OrganizedClusterTasks,
        statistics: ClusterSummaryStatistics,
        options: ClusterSummaryOptions,
        generateSummaryFn: (conversation: ConversationSkeleton, opts: Partial<SummaryOptions>) => Promise<{ content: string }>
    ): Promise<string> {
        const parts: string[] = [];

        parts.push(`## 📋 Contenu Détaillé de la Grappe`);

        for (const task of organizedTasks.sortedTasks) {
            const taskSummary = await generateSummaryFn(task, {
                detailLevel: options.detailLevel,
                truncationChars: options.truncationChars,
                compactStats: false,
                includeCss: false,
                generateToc: false,
                outputFormat: options.outputFormat
            });

            const icon = task === organizedTasks.rootTask ? '🎯' : '📝';
            const taskId = this.sanitizeId(task.taskId);
            const title = task.metadata.title || task.taskId;

            parts.push(`### ${icon} ${title} {#tache${task === organizedTasks.rootTask ? '-racine' : ''}-${taskId}}`);

            // Métadonnées de la tâche individuelle
            parts.push(`**ID :** \`${task.taskId}\`
**Mode :** ${task.metadata.mode || 'Non spécifié'}
**Créé le :** ${new Date(task.metadata.createdAt).toLocaleString('fr-FR')}
**Taille :** ${this.formatBytes(task.metadata.totalSize)}
${task !== organizedTasks.rootTask ? `**Parent :** ${organizedTasks.rootTask.metadata.title || organizedTasks.rootTask.taskId}` : '**Type :** Tâche racine de la grappe'}`);

            parts.push(taskSummary.content);

            parts.push('---'); // Séparateur entre tâches
        }

        return parts.join('\n\n');
    }

    private async renderComparativeContent(
        organizedTasks: OrganizedClusterTasks,
        statistics: ClusterSummaryStatistics,
        options: ClusterSummaryOptions,
        generateSummaryFn: (conversation: ConversationSkeleton, opts: Partial<SummaryOptions>) => Promise<{ content: string }>
    ): Promise<string> {
        const parts: string[] = [];

        parts.push(`## ⚖️ Analyse Comparative de la Grappe`);

        // Tableau comparatif des métadonnées
        parts.push(`### Comparaison des Tâches`);

        if (options.outputFormat === 'html') {
            parts.push(`<table class="comparative-table">
<thead>
    <tr>
        <th>Tâche</th>
        <th>Mode</th>
        <th>Taille</th>
        <th>Messages</th>
        <th>Date</th>
    </tr>
</thead>
<tbody>
    ${organizedTasks.sortedTasks.map(task => {
                const messageCount = task.sequence.filter(item => 'role' in item).length;
                const icon = task === organizedTasks.rootTask ? '🎯' : '📝';
                return `<tr>
        <td>${icon} ${task.metadata.title || task.taskId}</td>
        <td>${task.metadata.mode || 'N/A'}</td>
        <td>${this.formatBytes(task.metadata.totalSize)}</td>
        <td>${messageCount}</td>
        <td>${new Date(task.metadata.createdAt).toLocaleDateString('fr-FR')}</td>
    </tr>`;
            }).join('')}
</tbody>
</table>`);
        } else {
            parts.push(`| Tâche | Mode | Taille | Messages | Date |
|-------|------|--------|----------|------|
${organizedTasks.sortedTasks.map(task => {
                const messageCount = task.sequence.filter(item => 'role' in item).length;
                const icon = task === organizedTasks.rootTask ? '🎯' : '📝';
                return `| ${icon} ${task.metadata.title || task.taskId} | ${task.metadata.mode || 'N/A'} | ${this.formatBytes(task.metadata.totalSize)} | ${messageCount} | ${new Date(task.metadata.createdAt).toLocaleDateString('fr-FR')} |`;
            }).join('\n')}`);
        }

        // Comparaison des patterns de contenu
        parts.push(`### Patterns de Contenu`);

        const contentAnalysis = await this.generateComparativeAnalysis(organizedTasks);
        parts.push(contentAnalysis);

        return parts.join('\n\n');
    }

    private async generateComparativeAnalysis(organizedTasks: OrganizedClusterTasks): Promise<string> {
        const analysis: string[] = [];

        // Analyse des similitudes et différences
        const toolUsageByTask = new Map<string, Set<string>>();
        const contentTypesByTask = new Map<string, { user: number; assistant: number; tools: number }>();

        for (const task of organizedTasks.allTasks) {
            const tools = new Set<string>();
            const contentTypes = { user: 0, assistant: 0, tools: 0 };

            const messages = task.sequence.filter((item): item is MessageSkeleton => 'role' in item);

            for (const message of messages) {
                if (message.role === 'user') {
                    if (this.classifier.isToolResult(message.content)) {
                        contentTypes.tools++;
                        // Extraction du nom de l'outil
                        const toolMatch = message.content.match(/\[(\w+) for/);
                        if (toolMatch) tools.add(toolMatch[1]);
                    } else {
                        contentTypes.user++;
                    }
                } else if (message.role === 'assistant') {
                    contentTypes.assistant++;
                }
            }

            toolUsageByTask.set(task.taskId, tools);
            contentTypesByTask.set(task.taskId, contentTypes);
        }

        // Outils communs
        const allTools = new Set<string>();
        toolUsageByTask.forEach(tools => tools.forEach(tool => allTools.add(tool)));

        const commonTools: string[] = [];
        for (const tool of allTools) {
            const usageCount = Array.from(toolUsageByTask.values()).filter(taskTools => taskTools.has(tool)).length;
            if (usageCount > 1) {
                commonTools.push(`**${tool}** (${usageCount}/${organizedTasks.allTasks.length} tâches)`);
            }
        }

        if (commonTools.length > 0) {
            analysis.push(`**Outils communs :**\n${commonTools.join(', ')}`);
        }

        // Distribution des types de contenu
        const avgContentTypes = Array.from(contentTypesByTask.values()).reduce(
            (acc, types) => ({
                user: acc.user + types.user,
                assistant: acc.assistant + types.assistant,
                tools: acc.tools + types.tools
            }),
            { user: 0, assistant: 0, tools: 0 }
        );

        const taskCount = organizedTasks.allTasks.length;
        analysis.push(`**Moyenne par tâche :**
- Messages utilisateur : ${Math.round(avgContentTypes.user / taskCount * 10) / 10}
- Messages assistant : ${Math.round(avgContentTypes.assistant / taskCount * 10) / 10}
- Résultats d'outils : ${Math.round(avgContentTypes.tools / taskCount * 10) / 10}`);

        return analysis.join('\n\n');
    }

    private renderCrossTaskAnalysis(organizedTasks: OrganizedClusterTasks, statistics: ClusterSummaryStatistics): string {
        const parts: string[] = [];

        parts.push(`## 🔄 Analyse Cross-Task`);

        // Récupération des patterns depuis les statistiques
        if (statistics.commonPatterns) {
            const patterns = statistics.commonPatterns;

            if (Object.keys(patterns.frequentTools).length > 0) {
                parts.push(`### Outils Récurrents`);
                parts.push(Object.entries(patterns.frequentTools)
                    .sort(([,a], [,b]) => b - a)
                    .map(([tool, count]) => `- **${tool}** : utilisé dans ${count} tâche${count > 1 ? 's' : ''}`)
                    .join('\n'));
            }

            if (Object.keys(patterns.commonModes).length > 0) {
                parts.push(`### Modes Fréquents`);
                parts.push(Object.entries(patterns.commonModes)
                    .sort(([,a], [,b]) => b - a)
                    .map(([mode, count]) => `- **${mode}** : ${count} tâche${count > 1 ? 's' : ''}`)
                    .join('\n'));
            }

            if (patterns.crossTaskTopics.length > 0) {
                parts.push(`### Sujets Transversaux`);
                parts.push(patterns.crossTaskTopics.map(topic => `- ${topic}`).join('\n'));
            }
        }

        // Analyse des dépendances et relations
        parts.push(`### Relations entre Tâches`);

        const relationships: string[] = [];
        const rootTask = organizedTasks.rootTask;
        const childTasks = organizedTasks.allTasks.filter(task => task !== rootTask);

        relationships.push(`**Tâche racine :** ${rootTask.metadata.title || rootTask.taskId}`);

        if (childTasks.length > 0) {
            relationships.push(`**Tâches dépendantes (${childTasks.length}) :**`);
            childTasks.forEach((child, index) => {
                relationships.push(`${index + 1}. ${child.metadata.title || child.taskId} (${this.formatBytes(child.metadata.totalSize)})`);
            });
        }

        parts.push(relationships.join('\n'));

        return parts.join('\n\n');
    }

    private buildClusterResult(
        content: string,
        statistics: ClusterSummaryStatistics,
        organizedTasks: OrganizedClusterTasks,
        options: ClusterSummaryOptions
    ): ClusterSummaryResult {

        const taskIndex = organizedTasks.sortedTasks.map((task, index) => ({
            taskId: task.taskId,
            title: task.metadata.title || task.taskId,
            order: index,
            size: task.metadata.totalSize
        }));

        return {
            success: true,
            content,
            statistics,
            clusterMetadata: {
                rootTaskId: organizedTasks.rootTask.taskId,
                totalTasks: statistics.totalTasks,
                clusterMode: options.clusterMode || 'aggregated',
                generationTimestamp: new Date().toISOString()
            },
            taskIndex,
            format: options.outputFormat || 'markdown',
            size: content.length
        };
    }

    // ============================================================================
    // MÉTHODES UTILITAIRES
    // ============================================================================

    private formatDuration(hours: number): string {
        if (hours < 1) {
            return `${Math.round(hours * 60)} minutes`;
        } else if (hours < 24) {
            return `${Math.round(hours * 10) / 10} heures`;
        } else {
            const days = Math.floor(hours / 24);
            const remainingHours = Math.round((hours % 24) * 10) / 10;
            return `${days}j ${remainingHours}h`;
        }
    }

    private formatBytes(bytes: number): string {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024 * 10) / 10} KB`;
        if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024) * 10) / 10} MB`;
        return `${Math.round(bytes / (1024 * 1024 * 1024) * 10) / 10} GB`;
    }

    private sanitizeId(id: string): string {
        return id.toLowerCase()
            .replace(/[^a-z0-9-_]/g, '-')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '');
    }
}
