import * as fs from 'fs/promises';
import * as path from 'path';
import { ConversationSkeleton } from '../types/conversation.js';

/**
 * Service pour détecter les "death spiral tasks" en temps réel
 * #1786 Phase 3: Prévention de la pollution du cache par les exploded tasks
 */
export class DeathSpiralDetector {
    /**
     * Seuils par défaut pour la détection de death spiral
     */
    private static readonly DEFAULT_THRESHOLDS = {
        errorRatio: 0.8, // 80% d'erreurs
        assistantOutputRatio: 0.05, // <5% d'output assistant
        rapidErrorCount: 5, // 5 erreurs rapides
        timeWindowMinutes: 30, // 30 minutes
        consecutiveErrors: 3, // 3 erreurs consécutives
    };

    /**
     * Analyse les tâches pour détecter les death spirals
     */
    static async analyzeTasksForDeathSpiral(
        taskIds: string[],
        conversationCache: Map<string, ConversationSkeleton>,
        customThresholds: Partial<typeof this.DEFAULT_THRESHOLDS> = {}
    ): Promise<{
        deathSpirals: Array<{
            taskId: string;
            riskLevel: 'CRITICAL' | 'HIGH' | 'MEDIUM';
            triggers: string[];
            errorCount: number;
            errorRatio: number;
            assistantOutputCount: number;
            assistantOutputRatio: number;
            lastError: string;
            timeToDeathSpiral: string; // Temps estimé avant que la task devienne garbage
        }>;
        tasksAtRisk: Array<{
            taskId: string;
            riskFactors: string[];
            currentErrorRatio: number;
            trendingUp: boolean;
        }>;
        immediateActions: Array<{
            taskId: string;
            action: 'pause' | 'terminate' | 'isolate';
            reason: string;
        }>;
        recommendations: string[];
    }> {
        const thresholds = { ...this.DEFAULT_THRESHOLDS, ...customThresholds };
        const deathSpirals: any[] = [];
        const tasksAtRisk: any[] = [];
        const immediateActions: any[] = [];
        const recommendations: string[] = [];

        for (const taskId of taskIds) {
            const skeleton = conversationCache.get(taskId);
            if (!skeleton) {
                continue;
            }

            // Analyser les messages pour détecter les patterns de death spiral
            const analysis = this.analyzeTaskMessages(skeleton, thresholds);

            if (analysis.isDeathSpiral) {
                deathSpirals.push({
                    taskId,
                    riskLevel: analysis.riskLevel,
                    triggers: analysis.triggers,
                    errorCount: analysis.errorCount,
                    errorRatio: analysis.errorRatio,
                    assistantOutputCount: analysis.assistantOutputCount,
                    assistantOutputRatio: analysis.assistantOutputRatio,
                    lastError: analysis.lastError,
                    timeToDeathSpiral: analysis.timeToDeathSpiral
                });

                // Déterminer les actions immédiates
                if (analysis.riskLevel === 'CRITICAL') {
                    immediateActions.push({
                        taskId,
                        action: 'terminate' as const,
                        reason: `Death spiral CRITICAL détectée: ${analysis.triggers.join(', ')}`
                    });
                } else if (analysis.riskLevel === 'HIGH') {
                    immediateActions.push({
                        taskId,
                        action: 'isolate' as const,
                        reason: `Death spiral HIGH détectée: monitoring renforcé nécessaire`
                    });
                }
            } else if (analysis.isAtRisk) {
                tasksAtRisk.push({
                    taskId,
                    riskFactors: analysis.riskFactors,
                    currentErrorRatio: analysis.errorRatio,
                    trendingUp: analysis.trendingUp
                });
            }
        }

        // Générer des recommandations basées sur l'analyse
        if (deathSpirals.length > 0) {
            recommendations.push(`🚨 ${deathSpirals.length} death spirals détectées - actions immédiates nécessaires`);
            recommendations.push(`Considérer l'activation du mode 'emergency_pause' pour les tâches CRITICAL`);
        }

        if (tasksAtRisk.length > 0) {
            recommendations.push(`⚠️ ${tasksAtRisk.length} tâches montrant des signaux de risque`);
            recommendations.push(`Augmenter le monitoring des tâches avec error ratio > ${thresholds.errorRatio * 100}%`);
        }

        if (recommendations.length === 0) {
            recommendations.push(`✅ Aucun death spiral détecté. Le monitoring continue.`);
        }

        return {
            deathSpirals,
            tasksAtRisk,
            immediateActions,
            recommendations
        };
    }

    /**
     * Analyse les messages d'une tâche pour détecter les patterns de death spiral
     */
    private static analyzeTaskMessages(
        skeleton: ConversationSkeleton,
        thresholds: typeof this.DEFAULT_THRESHOLDS
    ): {
        isDeathSpiral: boolean;
        riskLevel: 'CRITICAL' | 'HIGH' | 'MEDIUM';
        triggers: string[];
        errorCount: number;
        errorRatio: number;
        assistantOutputCount: number;
        assistantOutputRatio: number;
        lastError: string;
        timeToDeathSpiral: string;
        isAtRisk: boolean;
        riskFactors: string[];
        trendingUp: boolean;
    } {
        let errorCount = 0;
        let assistantOutputCount = 0;
        let totalMessages = 0;
        let consecutiveErrors = 0;
        let errorTimestamps: number[] = [];
        let lastError = '';
        const errors: string[] = [];
        const messages: any[] = [];

        // Collecter tous les messages avec timestamps
        const collectMessages = (msgs: any[], parentTimestamp?: number) => {
            for (const msg of msgs) {
                const timestamp = msg.timestamp || parentTimestamp || Date.now();
                messages.push({
                    role: msg.role,
                    content: msg.content,
                    timestamp
                });

                if (msg.messages) {
                    collectMessages(msg.messages, timestamp);
                }
            }
        };

        collectMessages(skeleton.messages || []);

        // Trier les messages par timestamp
        messages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

        // Analyser chaque message
        for (const msg of messages) {
            totalMessages++;

            if (msg.role === 'user' && msg.content && Array.isArray(msg.content)) {
                for (const content of msg.content) {
                    if (content.type === 'text') {
                        // Détecter les erreurs
                        const isErrorMessage = this.isErrorMessage(content.text);
                        if (isErrorMessage) {
                            errorCount++;
                            consecutiveErrors++;
                            errors.push(content.text);
                            lastError = content.text;
                            errorTimestamps.push(msg.timestamp || Date.now());
                        } else {
                            consecutiveErrors = 0;
                        }
                    }
                }
            }

            if (msg.role === 'assistant' && msg.content && Array.isArray(msg.content)) {
                for (const content of msg.content) {
                    if (content.type === 'text' && content.text?.trim().length > 0) {
                        assistantOutputCount++;
                    }
                }
            }
        }

        const errorRatio = totalMessages > 0 ? errorCount / totalMessages : 0;
        const assistantOutputRatio = totalMessages > 0 ? assistantOutputCount / totalMessages : 0;

        // Vérifier les critères de death spiral
        const isDeathSpiral = this.checkDeathSpiralCriteria({
            errorCount,
            errorRatio,
            assistantOutputRatio,
            consecutiveErrors,
            errorTimestamps,
            thresholds,
            totalMessages
        });

        // Calculer le temps estimé avant death spiral
        const timeToDeathSpiral = this.calculateTimeToDeathSpiral(errorRatio, errorTimestamps);

        // Déterminer le niveau de risque
        const riskLevel = this.calculateRiskLevel(errorRatio, consecutiveErrors, isDeathSpiral);

        // Identifier les facteurs de risque
        const riskFactors: string[] = [];
        if (errorRatio > thresholds.errorRatio * 0.8) {
            riskFactors.push(`Error ratio élevé: ${(errorRatio * 100).toFixed(1)}%`);
        }
        if (consecutiveErrors >= thresholds.consecutiveErrors) {
            riskFactors.push(`${consecutiveErrors} erreurs consécutives`);
        }
        if (assistantOutputRatio < thresholds.assistantOutputRatio * 1.5) {
            riskFactors.push(`Assistant output faible: ${(assistantOutputRatio * 100).toFixed(1)}%`);
        }

        // Vérifier si la tendance est à la hausse
        const trendingUp = this.checkTrendingUp(errorTimestamps, thresholds.timeWindowMinutes);

        // Identifier les déclencheurs spécifiques
        const triggers = this.identifyTriggers(errors, errorRatio, consecutiveErrors);

        return {
            isDeathSpiral,
            riskLevel,
            triggers,
            errorCount,
            errorRatio,
            assistantOutputCount,
            assistantOutputRatio,
            lastError,
            timeToDeathSpiral,
            isAtRisk: errorRatio > thresholds.errorRatio * 0.7 || consecutiveErrors >= thresholds.consecutiveErrors - 1,
            riskFactors,
            trendingUp
        };
    }

    /**
     * Vérifier si un message contient une erreur
     */
    private static isErrorMessage(text: string): boolean {
        const errorPatterns = [
            /502\s+Bad\s+Gateway/i,
            /timeout/i,
            /context\s+overflow/i,
            /retry/i,
            /MCP\s+error/i,
            /too_many_tools_warning/i,
            /rate\s+limit/i,
            /connection\s+error/i,
            /internal\s+server\s+error/i,
            /service\s+unavailable/i
        ];

        return errorPatterns.some(pattern => pattern.test(text));
    }

    /**
     * Vérifier les critères de death spiral
     */
    private static checkDeathSpiralCriteria(params: {
        errorCount: number;
        errorRatio: number;
        assistantOutputRatio: number;
        consecutiveErrors: number;
        errorTimestamps: number[];
        thresholds: typeof this.DEFAULT_THRESHOLDS;
        totalMessages: number;
    }): boolean {
        const { errorRatio, assistantOutputRatio, consecutiveErrors, errorTimestamps, thresholds, totalMessages } = params;

        // Critère 1: Ratio d'erreur élevé + output assistant faible
        const meetsRatioCriteria = errorRatio >= thresholds.errorRatio &&
                                  assistantOutputRatio < thresholds.assistantOutputRatio;

        // Critère 2: Erreurs consécutives nombreuses
        const meetsConsecutiveCriteria = consecutiveErrors >= thresholds.consecutiveErrors;

        // Critère 3: Erreurs rapides (dans une fenêtre de temps)
        const meetsRapidCriteria = this.checkRapidErrors(errorTimestamps, thresholds.timeWindowMinutes, thresholds.rapidErrorCount);

        // Critère 4: Taille suffisante pour être significative
        const meetsSizeCriteria = totalMessages >= 10;

        return meetsRatioCriteria && (meetsConsecutiveCriteria || meetsRapidCriteria) && meetsSizeCriteria;
    }

    /**
     * Vérifier si les erreurs sont rapides
     */
    private static checkRapidErrors(errorTimestamps: number[], timeWindowMinutes: number, thresholdCount: number): boolean {
        if (errorTimestamps.length < thresholdCount) return false;

        const now = Date.now();
        const timeWindowMs = timeWindowMinutes * 60 * 1000;
        const recentErrors = errorTimestamps.filter(ts => now - ts < timeWindowMs);

        return recentErrors.length >= thresholdCount;
    }

    /**
     * Calculer le temps estimé avant death spiral
     */
    private static calculateTimeToDeathSpiral(errorRatio: number, errorTimestamps: number[]): string {
        if (errorTimestamps.length < 2) return 'N/A';

        // Calculer la tendance des erreurs
        const recentErrors = errorTimestamps.slice(-5);
        if (recentErrors.length < 2) return 'N/A';

        const timeDiff = recentErrors[recentErrors.length - 1] - recentErrors[0];
        const errorRate = recentErrors.length / (timeDiff / 1000 / 60); // erreurs par minute

        // Estimer quand le seuil sera atteint
        const targetRatio = 0.8; // 80%
        const currentRatio = errorRatio;
        const ratioDiff = targetRatio - currentRatio;

        if (errorRate <= 0 || ratioDiff <= 0) {
            return 'N/A';
        }

        const minutesToThreshold = ratioDiff / errorRate;
        return `${Math.ceil(minutesToThreshold)} minutes`;
    }

    /**
     * Calculer le niveau de risque
     */
    private static calculateRiskLevel(errorRatio: number, consecutiveErrors: number, isDeathSpiral: boolean): 'CRITICAL' | 'HIGH' | 'MEDIUM' {
        if (isDeathSpiral) {
            if (errorRatio > 0.9 || consecutiveErrors >= 5) {
                return 'CRITICAL';
            }
            return 'HIGH';
        }

        if (errorRatio > 0.7 || consecutiveErrors >= 4) {
            return 'HIGH';
        }
        if (errorRatio > 0.5 || consecutiveErrors >= 3) {
            return 'MEDIUM';
        }

        return 'MEDIUM';
    }

    /**
     * Vérifier si la tendance est à la hausse
     */
    private static checkTrendingUp(errorTimestamps: number[], timeWindowMinutes: number): boolean {
        if (errorTimestamps.length < 3) return false;

        const now = Date.now();
        const timeWindowMs = timeWindowMinutes * 60 * 1000;
        const recentErrors = errorTimestamps.filter(ts => now - ts < timeWindowMs);

        if (recentErrors.length < 2) return false;

        // Calculer la fréquence récente vs ancienne
        const halfPoint = Math.floor(recentErrors.length / 2);
        const firstHalf = recentErrors.slice(0, halfPoint);
        const secondHalf = recentErrors.slice(halfPoint);

        const firstHalfDuration = secondHalf[0] - firstHalf[0];
        const secondHalfDuration = recentErrors[recentErrors.length - 1] - secondHalf[0];

        if (firstHalfDuration === 0 || secondHalfDuration === 0) return false;

        const firstHalfRate = firstHalf.length / (firstHalfDuration / 1000 / 60);
        const secondHalfRate = secondHalf.length / (secondHalfDuration / 1000 / 60);

        return secondHalfRate > firstHalfRate;
    }

    /**
     * Identifier les déclencheurs spécifiques
     */
    private static identifyTriggers(errors: string[], errorRatio: number, consecutiveErrors: number): string[] {
        const triggers: string[] = [];
        const errorTypes = new Map<string, number>();

        // Compter les types d'erreurs
        errors.forEach(error => {
            if (error.includes('502')) errorTypes.set('502 Bad Gateway', (errorTypes.get('502 Bad Gateway') || 0) + 1);
            if (error.includes('timeout')) errorTypes.set('Timeout', (errorTypes.get('Timeout') || 0) + 1);
            if (error.includes('context overflow')) errorTypes.set('Context Overflow', (errorTypes.get('Context Overflow') || 0) + 1);
            if (error.includes('MCP error')) errorTypes.set('MCP Error', (errorTypes.get('MCP Error') || 0) + 1);
            if (error.includes('rate limit')) errorTypes.set('Rate Limit', (errorTypes.get('Rate Limit') || 0) + 1);
        });

        // Identifier les déclencheurs principaux
        const sortedErrors = Array.from(errorTypes.entries()).sort((a, b) => b[1] - a[1]);
        const topError = sortedErrors[0];

        if (topError && topError[1] >= 3) {
            triggers.push(topError[0] + ` dominant (${topError[1]} occurrences)`);
        }

        if (errorRatio > 0.9) triggers.push('Error ratio extrême (>90%)');
        if (consecutiveErrors >= 5) triggers.push(`Longue séquence d'erreurs (${consecutiveErrors})`);

        return triggers;
    }
}