/**
 * Exports pour les outils de résumé et synthèse
 *
 * Ce module regroupe tous les outils liés à la génération de résumés
 * et synthèses de conversations :
 * - roosync_summarize : Outil unifié consolidé (CONS-12)
 * - Résumés de traces individuelles (legacy)
 * - Résumés de grappes (clusters) (legacy)
 * - Synthèses LLM (legacy)
 */

// CONS-12: Outil unifié consolidé
export { roosyncSummarizeTool, handleRooSyncSummarize } from './roosync-summarize.tool.js';

// Legacy tools (conservés pour compatibilité)
export { generateTraceSummaryTool, handleGenerateTraceSummary } from './generate-trace-summary.tool.js';
export { generateClusterSummaryTool, handleGenerateClusterSummary } from './generate-cluster-summary.tool.js';
export { getConversationSynthesisTool, handleGetConversationSynthesis } from './get-conversation-synthesis.tool.js';