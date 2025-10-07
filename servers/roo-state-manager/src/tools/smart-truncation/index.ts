/**
 * Module de troncature intelligente pour view_conversation_tree
 * @fileoverview Point d'entrée principal pour le système de troncature intelligente
 */

export { SmartTruncationEngine } from './engine.js';
export { ContentTruncator, SmartOutputFormatter } from './content-truncator.js';
export type {
    SmartTruncationConfig,
    SmartTruncationResult,
    TaskTruncationPlan,
    ElementTruncationPlan,
    ViewConversationTreeArgs
} from './types.js';

/**
 * Configuration par défaut exportée
 */
export const DEFAULT_SMART_TRUNCATION_CONFIG = {
    maxOutputLength: 300000,
    gradientStrength: 2.0,
    minPreservationRate: 0.9,
    maxTruncationRate: 0.7,
    contentPriority: {
        userMessages: 1.0,
        assistantMessages: 0.8,
        actions: 0.6,
        metadata: 0.4
    }
};