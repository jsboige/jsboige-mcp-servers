/**
 * PROFILING INSTRUMENTATION pour conversation_browser
 *
 * Ce fichier contient des fonctions de profilage à intégrer dans list-conversations.tool.ts
 * pour identifier les goulots d'étranglement.
 *
 * Usage: Ajouter console.time/timeEnd aux points clés identifiés ci-dessous.
 */

/**
 * Points d'instrumentation identifiés dans list-conversations.tool.ts handler:
 *
 * 1. PHASE 1: Disk scan Roo (scanDiskForNewTasks)
 *    - Ligne 337: const scanPromise = scanDiskForNewTasks(conversationCache);
 *    - Ajouter: console.time('diskScanRoo');
 *    - Après ligne 350: console.timeEnd('diskScanRoo');
 *
 * 2. PHASE 2: Claude session scan (scanClaudeSessions)
 *    - Ligne 362: const claudePromise = scanClaudeSessions(args.workspace);
 *    - Ajouter: console.time('claudeSessionScan');
 *    - Après ligne 371: console.timeEnd('claudeSessionScan');
 *
 * 3. PHASE 3: Filtrage workspace
 *    - Ligne 376: if (args.workspace) {
 *    - Ajouter: console.time('workspaceFilter');
 *    - Après ligne 396: console.timeEnd('workspaceFilter');
 *
 * 4. PHASE 4: Filtrage pendingSubtaskOnly
 *    - Ligne 399: if (args.pendingSubtaskOnly === true) {
 *    - Ajouter: console.time('pendingSubtaskFilter');
 *    - Après ligne 417: console.timeEnd('pendingSubtaskFilter');
 *
 * 5. PHASE 5: Filtrage contentPattern
 *    - Ligne 420: if (args.contentPattern && args.contentPattern.trim().length > 0) {
 *    - Ajouter: console.time('contentPatternFilter');
 *    - Après ligne 438: console.timeEnd('contentPatternFilter');
 *
 * 6. PHASE 6: Tri
 *    - Ligne 441: allSkeletons.sort((a, b) => {
 *    - Ajouter: console.time('sorting');
 *    - Après ligne 456: console.timeEnd('sorting');
 *
 * 7. PHASE 7: Création SkeletonNode
 *    - Ligne 459: const skeletonMap = new Map<string, SkeletonNode>(...
 *    - Ajouter: console.time('skeletonNodeCreation');
 *    - Après fin de la boucle: console.timeEnd('skeletonNodeCreation');
 *
 * 8. PHASE 8: Synthesis detection (detectSynthesis)
 *    - À identifier dans le code (lecture fichiers GDrive)
 *    - Ajouter: console.time('synthesisDetection');
 *    - Après: console.timeEnd('synthesisDetection');
 *
 * 9. PHASE 9: Pagination + JSON serialization
 *    - Vers la fin du handler
 *    - Ajouter: console.time('paginationSerialization');
 *    - Avant return: console.timeEnd('paginationSerialization');
 */

/**
 * Exemple d'implémentation dans le handler:
 *
 * ```typescript
 * handler: async (args, conversationCache): Promise<CallToolResult> => {
 *     console.time('totalHandlerTime');
 *
 *     // PHASE 1: Disk scan
 *     console.time('diskScanRoo');
 *     const newTasks = await scanDiskForNewTasks(conversationCache);
 *     console.timeEnd('diskScanRoo');
 *
 *     // PHASE 2: Claude scan
 *     console.time('claudeSessionScan');
 *     const claudeSkeletons = await scanClaudeSessions(args.workspace);
 *     console.timeEnd('claudeSessionScan');
 *
 *     // ... autres phases
 *
 *     console.timeEnd('totalHandlerTime');
 *     return result;
 * }
 * ```
 */

/**
 * Template pour rapport de profiling:
 *
 * ```
 * conversation_browser(list) - Performance Report
 * ===================================================
 * totalHandlerTime:          XXXX ms
 * ├─ diskScanRoo:            XXXX ms (cache hit/miss?)
 * ├─ claudeSessionScan:      XXXX ms
 * ├─ workspaceFilter:        XXXX ms
 * ├─ pendingSubtaskFilter:   XXXX ms (if applicable)
 * ├─ contentPatternFilter:   XXXX ms (if applicable)
 * ├─ sorting:                XXXX ms
 * ├─ skeletonNodeCreation:   XXXX ms
 * ├─ synthesisDetection:     XXXX ms (if applicable)
 * └─ paginationSerialization: XXXX ms
 *
 * Total skeletons processed: XXXX
 * Cache hit rate: XX%
 * ```
 */

export const PROFILING_PHASES = {
    DISK_SCAN_ROO: 'diskScanRoo',
    CLAUDE_SESSION_SCAN: 'claudeSessionScan',
    WORKSPACE_FILTER: 'workspaceFilter',
    PENDING_SUBTASK_FILTER: 'pendingSubtaskFilter',
    CONTENT_PATTERN_FILTER: 'contentPatternFilter',
    SORTING: 'sorting',
    SKELETON_NODE_CREATION: 'skeletonNodeCreation',
    SYNTHESIS_DETECTION: 'synthesisDetection',
    PAGINATION_SERIALIZATION: 'paginationSerialization',
    TOTAL_HANDLER_TIME: 'totalHandlerTime',
} as const;

/**
 * Helper pour logger un rapport de profiling structuré
 */
export function logProfilingReport(timings: Record<string, number>, metadata: {
    totalSkeletons: number;
    cacheHit?: boolean;
}): void {
    console.log(`
conversation_browser(list) - Performance Report
${'='.repeat(50)}
${PROFILING_PHASES.TOTAL_HANDLER_TIME}:          ${timings.totalHandlerTime ?? 'N/A'} ms
├─ ${PROFILING_PHASES.DISK_SCAN_ROO}:            ${timings.diskScanRoo ?? 'N/A'} ms ${metadata.cacheHit ? '(cache hit)' : '(cache miss)'}
├─ ${PROFILING_PHASES.CLAUDE_SESSION_SCAN}:      ${timings.claudeSessionScan ?? 'N/A'} ms
├─ ${PROFILING_PHASES.WORKSPACE_FILTER}:        ${timings.workspaceFilter ?? 'N/A'} ms
├─ ${PROFILING_PHASES.PENDING_SUBTASK_FILTER}:   ${timings.pendingSubtaskFilter ?? 'N/A'} ms
├─ ${PROFILING_PHASES.CONTENT_PATTERN_FILTER}:   ${timings.contentPatternFilter ?? 'N/A'} ms
├─ ${PROFILING_PHASES.SORTING}:                ${timings.sorting ?? 'N/A'} ms
├─ ${PROFILING_PHASES.SKELETON_NODE_CREATION}:   ${timings.skeletonNodeCreation ?? 'N/A'} ms
├─ ${PROFILING_PHASES.SYNTHESIS_DETECTION}:     ${timings.synthesisDetection ?? 'N/A'} ms
└─ ${PROFILING_PHASES.PAGINATION_SERIALIZATION}: ${timings.paginationSerialization ?? 'N/A'} ms

Total skeletons processed: ${metadata.totalSkeletons}
Cache hit rate: ${metadata.cacheHit ? '100%' : '0%'}
    `);
}
