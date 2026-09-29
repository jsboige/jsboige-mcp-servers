/**
 * Unified header pipeline — étape filtres/tri de conversation_browser(list)
 * opérant sur UnifiedTask (#1394, Phase 4 de #1360).
 *
 * Rôle : le premier consommateur PRODUCTION du schéma unifié (#1391). Les
 * filtres de niveau header (workspace, fenêtre temporelle, machineId) et le
 * tri passent par la projection UnifiedTask de chaque squelette ; le résultat
 * restitue les objets ConversationSkeleton d'origine (l'étape suivante du
 * pipeline — extraction sequence, pendingSubtask, contentPattern — reste
 * dépendante du squelette pendant la transition).
 *
 * Parité comportementale : chaque prédicat réplique exactement la sémantique
 * historique de list-conversations.tool.ts (assertée par le test A/B
 * `unified-header-pipeline.test.ts` — critère d'acceptation #1394
 * « 0 régression fonctionnelle (tests comparison) »).
 */

import { ConversationSkeleton } from '../../types/conversation.js';
import { toUnifiedTask, UnifiedTask } from '../../types/unified-task.js';
import { parseFilterDate, isWithinDateRange } from '../../utils/date-filters.js';
import { matchesWorkspace } from '../../utils/workspace-match.js';

export interface UnifiedHeaderFilterArgs {
    /** Filtre par workspace (stratégie : exact/normalized/substring, défaut normalized). */
    workspace?: string;
    workspacePathMatch?: 'exact' | 'normalized' | 'substring';
    /** Filtre lastActivity >= startDate (ISO 8601 ou YYYY-MM-DD). */
    startDate?: string;
    /** Filtre lastActivity <= endDate (fin de journée si heure absente). */
    endDate?: string;
    /** Filtre par identifiant machine (comparaison insensible à la casse). */
    machineId?: string;
    /** Critère de tri (défaut lastActivity). */
    sortBy?: 'lastActivity' | 'messageCount' | 'totalSize';
    /** Ordre de tri (défaut desc). */
    sortOrder?: 'asc' | 'desc';
}

export interface UnifiedHeaderPipelineResult {
    /** Squelettes d'origine, filtrés puis triés (ordre stable identique au pipeline legacy). */
    skeletons: ConversationSkeleton[];
    /** Nombre de squelettes écartés par le filtre workspace (télémétrie du tool). */
    workspaceFilteredCount: number;
    /** Projections UnifiedTask des squelettes retenus, dans le même ordre. */
    tasks: UnifiedTask[];
}

export function applyUnifiedHeaderFiltersAndSort(
    skeletons: ConversationSkeleton[],
    args: UnifiedHeaderFilterArgs,
): UnifiedHeaderPipelineResult {
    let pairs = skeletons.map(skeleton => ({ skeleton, task: toUnifiedTask(skeleton) }));

    let workspaceFilteredCount = 0;
    if (args.workspace) {
        const countBefore = pairs.length;
        const strategy = args.workspacePathMatch || 'normalized';
        pairs = pairs.filter(p => matchesWorkspace(p.task.workspace, args.workspace!, strategy));
        workspaceFilteredCount = countBefore - pairs.length;
    }

    const parsedStartDate = parseFilterDate(args.startDate);
    const parsedEndDate = parseFilterDate(args.endDate);
    if (parsedStartDate || parsedEndDate) {
        pairs = pairs.filter(p => isWithinDateRange(p.task.lastActivity, parsedStartDate, parsedEndDate));
    }

    if (args.machineId && args.machineId.trim().length > 0) {
        const targetMachineId = args.machineId.trim().toLowerCase();
        pairs = pairs.filter(p => (p.task.machineId || '').toLowerCase() === targetMachineId);
    }

    const sortBy = args.sortBy || 'lastActivity';
    pairs.sort((a, b) => {
        let comparison = 0;
        switch (sortBy) {
            case 'lastActivity':
                comparison = new Date(b.task.lastActivity).getTime() - new Date(a.task.lastActivity).getTime();
                break;
            case 'messageCount':
                comparison = (b.task.messageCount || 0) - (a.task.messageCount || 0);
                break;
            case 'totalSize':
                comparison = (b.task.totalSizeBytes || 0) - (a.task.totalSizeBytes || 0);
                break;
        }
        return (args.sortOrder === 'asc') ? -comparison : comparison;
    });

    return {
        skeletons: pairs.map(p => p.skeleton),
        tasks: pairs.map(p => p.task),
        workspaceFilteredCount,
    };
}
