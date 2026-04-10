/**
 * Troncateur de contenu intelligent
 * @fileoverview Applique les plans de troncature aux éléments de conversation
 */

import { ConversationSkeleton } from '../../types/conversation.js';
import { TaskTruncationPlan, ElementTruncationPlan } from './types.js';

/**
 * Troncateur de contenu avec méthodes sémantiques
 */
export class ContentTruncator {
    /**
     * #1244 Couche 2.5 — Hard cap final pour garantir une borne stricte sur la sortie.
     *
     * Tronque le milieu d'une chaine de caracteres tout en preservant le debut
     * (header / metadata) et la fin (resume / dernier message). Ce filet de
     * securite est invoque en sortie de chaque handler view/list/summarize quand
     * le moteur principal de troncature n'a pas suffi a respecter `max_output_length`.
     *
     * Caracteristiques :
     *  - Operation char-level (pas line-level), donc applicable a n'importe quelle
     *    sortie textuelle deja formattee.
     *  - Reserve `headerKeepChars` au debut (par defaut 2000) pour conserver
     *    metadata, titre, breakdown, etc.
     *  - Le reste du budget va a la fin pour preserver le dernier contexte utile.
     *  - Insere un marqueur lisible `[... N chars tronques par hard cap ...]`.
     *  - No-op si `content.length <= maxChars`.
     */
    static hardCapString(
        content: string,
        maxChars: number,
        options: { headerKeepChars?: number } = {}
    ): string {
        if (content.length <= maxChars) return content;

        const headerKeepChars = Math.max(0, options.headerKeepChars ?? 2000);
        const marker = `\n\n[... TRUNCATED chars by hard cap ...]\n\n`;

        // Si headerKeepChars + marker depasse deja maxChars, fallback sur une simple coupe en fin
        if (headerKeepChars + marker.length >= maxChars) {
            const safeSize = Math.max(0, maxChars - marker.length);
            return content.substring(0, safeSize) + marker;
        }

        const tailBudget = maxChars - headerKeepChars - marker.length;
        const head = content.substring(0, headerKeepChars);
        const tail = content.substring(content.length - tailBudget);
        const removed = content.length - headerKeepChars - tailBudget;

        return `${head}${marker.replace('TRUNCATED chars', `${removed} chars`)}${tail}`;
    }

    /**
     * Applique les plans de troncature aux tâches
     */
    static applyTruncationPlans(
        tasks: ConversationSkeleton[],
        taskPlans: TaskTruncationPlan[]
    ): ConversationSkeleton[] {
        const planMap = new Map(taskPlans.map(plan => [plan.taskId, plan]));
        
        return tasks.map(task => {
            const plan = planMap.get(task.taskId);
            if (!plan || plan.elementPlans.length === 0) {
                return task; // Pas de troncature pour cette tâche
            }
            
            return this.applyTaskTruncation(task, plan);
        });
    }
    
    /**
     * Applique la troncature à une tâche spécifique
     */
    private static applyTaskTruncation(
        task: ConversationSkeleton, 
        plan: TaskTruncationPlan
    ): ConversationSkeleton {
        const elementPlanMap = new Map(plan.elementPlans.map(ep => [ep.sequenceIndex, ep]));
        
        const truncatedSequence = (task.sequence ?? []).map((item, index) => {
            const elementPlan = elementPlanMap.get(index);
            if (!elementPlan) {
                return item; // Pas de troncature pour cet élément
            }
            
            return this.applyElementTruncation(item, elementPlan);
        });
        
        return {
            ...task,
            sequence: truncatedSequence
        };
    }
    
    /**
     * Applique la troncature à un élément de séquence
     */
    private static applyElementTruncation(item: any, plan: ElementTruncationPlan): any {
        if ('role' in item) {
            // Message utilisateur/assistant
            return {
                ...item,
                content: this.truncateMessageContent(item.content, plan)
            };
        } else {
            // Action - peut tronquer les paramètres si nécessaire
            return this.truncateActionContent(item, plan);
        }
    }
    
    /**
     * Tronque le contenu d'un message selon la méthode spécifiée
     */
    private static truncateMessageContent(content: string, plan: ElementTruncationPlan): string {
        switch (plan.truncationMethod) {
            case 'preserve':
                return content;
                
            case 'truncate_middle':
                return this.truncateMiddle(
                    content, 
                    plan.truncationParams?.startLines || 5,
                    plan.truncationParams?.endLines || 5
                );
                
            case 'truncate_end':
                const lines = content.split('\n');
                const keepLines = plan.truncationParams?.startLines || 10;
                if (lines.length <= keepLines) return content;
                
                const truncatedLines = lines.slice(0, keepLines);
                return truncatedLines.join('\n') + '\n[... contenu tronqué ...]';
                
            case 'summary':
                return this.generateSummary(
                    content, 
                    plan.truncationParams?.summaryLength || 200
                );
                
            default:
                return content;
        }
    }
    
    /**
     * Tronque le milieu d'un contenu, préservant début et fin
     */
    private static truncateMiddle(content: string, startLines: number, endLines: number): string {
        const lines = content.split('\n');
        const totalLines = lines.length;
        
        // Pas besoin de tronquer si le contenu est déjà court
        if (totalLines <= startLines + endLines + 2) {
            return content;
        }
        
        const startPart = lines.slice(0, startLines).join('\n');
        const endPart = lines.slice(-endLines).join('\n');
        const removedLines = totalLines - startLines - endLines;
        
        return `${startPart}\n\n[... ${removedLines} lignes tronquées ...]\n\n${endPart}`;
    }
    
    /**
     * Tronque le contenu d'une action (paramètres principalement)
     */
    private static truncateActionContent(item: any, plan: ElementTruncationPlan): any {
        // Pour les actions, on peut tronquer les paramètres volumineux
        if (item.parameters && Object.keys(item.parameters).length > 0) {
            const paramStr = JSON.stringify(item.parameters, null, 2);
            
            if (paramStr.length > 500) { // Seuil pour tronquer les paramètres
                const truncatedParams = this.truncateMiddle(paramStr, 3, 3);
                
                return {
                    ...item,
                    parameters: { 
                        '...': '[paramètres tronqués]',
                        _truncated: true,
                        _originalSize: paramStr.length 
                    }
                };
            }
        }
        
        return item;
    }
    
    /**
     * Génère un résumé du contenu
     */
    private static generateSummary(content: string, maxLength: number): string {
        if (content.length <= maxLength) {
            return content;
        }
        
        // Troncature simple avec points de suspension
        const truncated = content.substring(0, maxLength - 20);
        const lastSpace = truncated.lastIndexOf(' ');
        const cleanTruncated = lastSpace > maxLength * 0.8 ? 
            truncated.substring(0, lastSpace) : truncated;
            
        return `${cleanTruncated}... [résumé tronqué de ${content.length} caractères]`;
    }
}

/**
 * Formateur de sortie pour les tâches tronquées
 */
export class SmartOutputFormatter {
    /**
     * Formate la sortie avec les informations de troncature
     */
    static formatTruncatedOutput(
        tasks: ConversationSkeleton[],
        taskPlans: TaskTruncationPlan[],
        originalViewMode: string,
        originalDetailLevel: string
    ): string {
        const hasAnyTruncation = taskPlans.some(plan => plan.truncationBudget > 0);
        
        let header = `Conversation Tree (Mode: ${originalViewMode}, Detail: ${originalDetailLevel})`;
        if (hasAnyTruncation) {
            header += ' - 🧠 Smart Truncation Applied';
        }
        header += '\n======================================\n';
        
        // Informations de diagnostic si troncature appliquée
        if (hasAnyTruncation) {
            const totalOriginal = taskPlans.reduce((sum, plan) => sum + plan.originalSize, 0);
            const totalFinal = taskPlans.reduce((sum, plan) => sum + plan.targetSize, 0);
            const compressionRatio = ((totalOriginal - totalFinal) / totalOriginal * 100).toFixed(1);
            
            header += `🎯 Compression intelligente: ${compressionRatio}% (${Math.round(totalOriginal/1000)}k → ${Math.round(totalFinal/1000)}k chars)\n`;
            header += `📊 Répartition par gradient: ${this.formatGradientInfo(taskPlans)}\n\n`;
        }
        
        return header;
    }
    
    /**
     * Formate les informations de gradient
     */
    private static formatGradientInfo(taskPlans: TaskTruncationPlan[]): string {
        const compressionByPosition = taskPlans
            .map(plan => ({
                pos: plan.position,
                ratio: plan.originalSize > 0 ? plan.truncationBudget / plan.originalSize : 0
            }))
            .sort((a, b) => a.pos - b.pos);
            
        return compressionByPosition
            .map(item => `${item.pos}:${(item.ratio * 100).toFixed(0)}%`)
            .join(' ');
    }
}