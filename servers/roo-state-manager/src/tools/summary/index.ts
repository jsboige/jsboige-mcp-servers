/**
 * Exports pour les outils de résumé et synthèse
 *
 * Ce module regroupe tous les outils liés à la génération de résumés
 * et synthèses de conversations :
 * - roosync_summarize : Outil unifié consolidé (CONS-12)
 *
 * CLEANUP-2: Legacy tools retirés (generate_trace_summary, generate_cluster_summary, get_conversation_synthesis)
 * Ces outils ont été remplacés par roosync_summarize (CONS-12) qui offre une API unifiée
 * avec support de tous les modes (task, cluster, full) et formats (text, json, markdown).
 */

// CONS-12: Outil unifié consolidé
export { roosyncSummarizeTool, handleRooSyncSummarize } from './roosync-summarize.tool.js';