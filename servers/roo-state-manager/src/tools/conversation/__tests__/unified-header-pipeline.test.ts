/**
 * A/B equivalence test — critère d'acceptation #1394
 * « 0 régression fonctionnelle (tests comparison) ».
 *
 * Path A (legacy) : la logique filtres+tri de list-conversations.tool.ts AVANT
 * la migration #1394, copiée verbatim ci-dessous (accès direct metadata).
 * Path B (unified) : applyUnifiedHeaderFiltersAndSort, qui opère sur la
 * projection UnifiedTask de chaque squelette.
 *
 * Les deux chemins doivent produire la MÊME séquence de taskIds et le même
 * workspaceFilteredCount sur tous les scénarios. Ce fichier est le garde-fou
 * de la migration : si la sémantique unified dérive, ce test échoue.
 */

import { describe, test, expect } from 'vitest';
import { ConversationSkeleton } from '../../../types/conversation.js';
import {
    applyUnifiedHeaderFiltersAndSort,
    UnifiedHeaderFilterArgs,
} from '../unified-header-pipeline.js';
import { parseFilterDate, isWithinDateRange } from '../../../utils/date-filters.js';
import { matchesWorkspace } from '../../../utils/workspace-match.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeSkeleton(overrides: {
    taskId: string;
    workspace?: string;
    machineId?: string;
    lastActivity: string;
    messageCount: number;
    totalSize: number;
    parentTaskId?: string;
}): ConversationSkeleton {
    return {
        taskId: overrides.taskId,
        parentTaskId: overrides.parentTaskId,
        metadata: {
            lastActivity: overrides.lastActivity,
            createdAt: overrides.lastActivity,
            messageCount: overrides.messageCount,
            actionCount: Math.floor(overrides.messageCount / 2),
            totalSize: overrides.totalSize,
            workspace: overrides.workspace,
            machineId: overrides.machineId,
            source: 'roo',
        },
        sequence: [],
    } as ConversationSkeleton;
}

/** Corpus couvrant : basename workspace variants, machines distinctes, dates
 *  étalées, ex æquo messageCount (stabilité du tri), tailles variées. */
const CORPUS: ConversationSkeleton[] = [
    makeSkeleton({
        taskId: 'roo-a',
        workspace: 'd:/dev/CoursIA',
        machineId: 'myia-po-2025',
        lastActivity: '2026-09-01T10:00:00Z',
        messageCount: 30,
        totalSize: 3000,
    }),
    makeSkeleton({
        taskId: 'roo-b',
        workspace: 'd:/CoursIA', // même basename que roo-a (match normalized)
        machineId: 'MYIA-PO-2026', // casse différente (match insensible)
        lastActivity: '2026-09-28T22:15:00Z',
        messageCount: 30, // ex æquo avec roo-a (stabilité tri)
        totalSize: 9000,
    }),
    makeSkeleton({
        taskId: 'roo-c',
        workspace: 'c:/dev/roo-extensions',
        machineId: 'myia-po-2026',
        lastActivity: '2026-09-15T08:30:00Z',
        messageCount: 5,
        totalSize: 500,
        parentTaskId: 'roo-a',
    }),
    makeSkeleton({
        taskId: 'claude-x',
        // pas de workspace — exclu par le filtre workspace, inclus sinon
        machineId: 'myia-ai-01',
        lastActivity: '2026-09-20T12:00:00Z',
        messageCount: 100,
        totalSize: 10000,
    }),
    makeSkeleton({
        taskId: 'roo-d',
        workspace: 'd:/dev/Argumentum',
        machineId: 'myia-web1',
        lastActivity: '2026-08-01T00:00:00Z', // ancien (filtre startDate)
        messageCount: 1,
        totalSize: 100,
    }),
];

// ─── Path A : implémentation legacy (pré-#1394), verbatim ─────────────────────

function legacyFilterAndSort(
    skeletons: ConversationSkeleton[],
    args: UnifiedHeaderFilterArgs,
): { skeletons: ConversationSkeleton[]; workspaceFilteredCount: number } {
    let all = [...skeletons];
    const workspaceMatchStrategy = args.workspacePathMatch || 'normalized';

    let workspaceFilteredCount = 0;
    if (args.workspace) {
        const countBeforeFilter = all.length;
        all = all.filter(skeleton =>
            matchesWorkspace(skeleton.metadata.workspace, args.workspace!, workspaceMatchStrategy)
        );
        workspaceFilteredCount = countBeforeFilter - all.length;
    }

    const parsedStartDate = parseFilterDate(args.startDate);
    const parsedEndDate = parseFilterDate(args.endDate);
    if (parsedStartDate || parsedEndDate) {
        all = all.filter(skeleton =>
            isWithinDateRange(skeleton.metadata?.lastActivity, parsedStartDate, parsedEndDate)
        );
    }

    if (args.machineId && args.machineId.trim().length > 0) {
        const targetMachineId = args.machineId.trim().toLowerCase();
        all = all.filter(skeleton => {
            const m = (skeleton.metadata?.machineId || '').toLowerCase();
            return m === targetMachineId;
        });
    }

    all.sort((a, b) => {
        let comparison = 0;
        const sortBy = args.sortBy || 'lastActivity';
        switch (sortBy) {
            case 'lastActivity':
                comparison = new Date(b.metadata!.lastActivity).getTime() - new Date(a.metadata!.lastActivity).getTime();
                break;
            case 'messageCount':
                comparison = (b.metadata?.messageCount || 0) - (a.metadata?.messageCount || 0);
                break;
            case 'totalSize':
                comparison = (b.metadata?.totalSize || 0) - (a.metadata?.totalSize || 0);
                break;
        }
        return (args.sortOrder === 'asc') ? -comparison : comparison;
    });

    return { skeletons: all, workspaceFilteredCount };
}

// ─── Comparaison ──────────────────────────────────────────────────────────────

function assertEquivalence(args: UnifiedHeaderFilterArgs): void {
    const legacy = legacyFilterAndSort(CORPUS, args);
    const unified = applyUnifiedHeaderFiltersAndSort(CORPUS, args);

    expect(unified.skeletons.map(s => s.taskId)).toEqual(legacy.skeletons.map(s => s.taskId));
    expect(unified.workspaceFilteredCount).toBe(legacy.workspaceFilteredCount);
}

describe('applyUnifiedHeaderFiltersAndSort — A/B equivalence avec le pipeline legacy', () => {
    test('aucun filtre, tri défaut (lastActivity desc)', () => assertEquivalence({}));

    test('workspace exact', () => assertEquivalence({ workspace: 'd:/dev/CoursIA', workspacePathMatch: 'exact' }));

    test('workspace normalized — basename cross-drive matche', () =>
        assertEquivalence({ workspace: 'coursia', workspacePathMatch: 'normalized' }));

    test('workspace substring', () =>
        assertEquivalence({ workspace: 'extensions', workspacePathMatch: 'substring' }));

    test('workspace sans stratégie explicite (défaut normalized)', () =>
        assertEquivalence({ workspace: 'CoursIA' }));

    test('workspace exclut les squelettes sans workspace', () =>
        assertEquivalence({ workspace: 'd:/dev', workspacePathMatch: 'substring' }));

    test('filtre startDate seul', () => assertEquivalence({ startDate: '2026-09-01' }));

    test('filtre endDate seul (fin de journée incluse)', () =>
        assertEquivalence({ endDate: '2026-09-15' }));

    test('fenêtre temporelle [start, end]', () =>
        assertEquivalence({ startDate: '2026-09-10', endDate: '2026-09-25T12:00:00Z' }));

    test('machineId insensible à la casse', () => assertEquivalence({ machineId: 'Myia-Po-2026' }));

    test('machineId inconnu — liste vide des deux côtés', () =>
        assertEquivalence({ machineId: 'myia-inconnue' }));

    test('machineId avec espaces (trim)', () => assertEquivalence({ machineId: '  myia-web1  ' }));

    test('tri messageCount desc (ex æquo roo-a/roo-b — stabilité)', () =>
        assertEquivalence({ sortBy: 'messageCount' }));

    test('tri messageCount asc', () => assertEquivalence({ sortBy: 'messageCount', sortOrder: 'asc' }));

    test('tri totalSize desc', () => assertEquivalence({ sortBy: 'totalSize' }));

    test('tri totalSize asc', () => assertEquivalence({ sortBy: 'totalSize', sortOrder: 'asc' }));

    test('tri lastActivity asc', () => assertEquivalence({ sortBy: 'lastActivity', sortOrder: 'asc' }));

    test('combinaison : workspace + machineId + tri totalSize asc', () =>
        assertEquivalence({
            workspace: 'dev',
            workspacePathMatch: 'substring',
            machineId: 'myia-po-2025',
            sortBy: 'totalSize',
            sortOrder: 'asc',
        }));

    test('combinaison : fenêtre + machineId + tri messageCount desc', () =>
        assertEquivalence({
            startDate: '2026-09-01',
            endDate: '2026-09-30',
            machineId: 'myia-po-2026',
            sortBy: 'messageCount',
        }));
});

describe('applyUnifiedHeaderFiltersAndSort — contrat du résultat unifié', () => {
    test('tasks[] aligné 1:1 avec skeletons[] (projection UnifiedTask)', () => {
        const result = applyUnifiedHeaderFiltersAndSort(CORPUS, {
            machineId: 'myia-po-2026',
            sortBy: 'messageCount',
        });
        expect(result.tasks.length).toBe(result.skeletons.length);
        result.tasks.forEach((task, i) => {
            expect(task.id).toBe(result.skeletons[i].taskId);
            expect(task.machineId).toBe(result.skeletons[i].metadata.machineId);
        });
    });

    test('ne mute pas le corpus d\'entrée', () => {
        const before = CORPUS.map(s => s.taskId).join(',');
        applyUnifiedHeaderFiltersAndSort(CORPUS, { sortBy: 'totalSize', sortOrder: 'asc' });
        expect(CORPUS.map(s => s.taskId).join(',')).toBe(before);
    });

    test('corpus vide — résultat vide, compteurs à 0', () => {
        const result = applyUnifiedHeaderFiltersAndSort([], { workspace: 'x' });
        expect(result.skeletons).toEqual([]);
        expect(result.tasks).toEqual([]);
        expect(result.workspaceFilteredCount).toBe(0);
    });
});
