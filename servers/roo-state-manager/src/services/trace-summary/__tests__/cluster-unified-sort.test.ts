/**
 * A/B equivalence test — critère d'acceptation #1394
 * « 0 régression fonctionnelle (tests comparison) ».
 *
 * Outil #4 migré : conversation_summarizer (cluster) — tri des tâches de la
 * grappe. Path A (legacy) : les 4 tris AVANT migration (sortTasksByChronology /
 * Size / Activity / Alphabetically), copiés verbatim (accès direct metadata).
 * Path B (unified) : ClusterSummaryService.sortClusterTasks, qui opère sur la
 * projection UnifiedTask de chaque tâche.
 *
 * Les deux chemins doivent produire la MÊME séquence de taskIds pour les 4
 * stratégies — y compris sur les ex æquo (stabilité du tri) et les titres
 * absents (repli taskId).
 */

import { describe, test, expect } from 'vitest';
import { ConversationSkeleton } from '../../../types/conversation.js';
import { ClusterSummaryService } from '../ClusterSummaryService.js';

// ─── Path A (legacy, congelé verbatim de ClusterSummaryService.ts pré-#1394) ──

function legacySortByChronology(tasks: ConversationSkeleton[]): ConversationSkeleton[] {
    return [...tasks].sort((a, b) =>
        new Date(a.metadata.createdAt).getTime() - new Date(b.metadata.createdAt).getTime()
    );
}

function legacySortBySize(tasks: ConversationSkeleton[]): ConversationSkeleton[] {
    return [...tasks].sort((a, b) => b.metadata.totalSize - a.metadata.totalSize);
}

function legacySortByActivity(tasks: ConversationSkeleton[]): ConversationSkeleton[] {
    return [...tasks].sort((a, b) =>
        new Date(b.metadata.lastActivity).getTime() - new Date(a.metadata.lastActivity).getTime()
    );
}

function legacySortAlphabetically(tasks: ConversationSkeleton[]): ConversationSkeleton[] {
    return [...tasks].sort((a, b) => {
        const titleA = a.metadata.title || a.taskId;
        const titleB = b.metadata.title || b.taskId;
        return titleA.localeCompare(titleB);
    });
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

type SortBy = 'chronological' | 'size' | 'activity' | 'alphabetical';

function makeSkeleton(overrides: {
    taskId: string;
    title?: string;
    createdAt: string;
    lastActivity: string;
    totalSize: number;
}): ConversationSkeleton {
    return {
        taskId: overrides.taskId,
        metadata: {
            title: overrides.title,
            messageCount: 1,
            actionCount: 0,
            totalSize: overrides.totalSize,
            lastActivity: overrides.lastActivity,
            createdAt: overrides.createdAt,
            source: 'roo',
        },
        sequence: [],
    } as ConversationSkeleton;
}

/** Corpus : ex æquo createdAt (stabilité), ex æquo totalSize, titres absents
 *  (repli taskId), accents pour localeCompare, activités désordonnées. */
const CORPUS: ConversationSkeleton[] = [
    makeSkeleton({
        taskId: 'zeta-titled',
        title: 'Zébra task',
        createdAt: '2026-09-10T08:00:00Z',
        lastActivity: '2026-09-20T10:00:00Z',
        totalSize: 5000,
    }),
    makeSkeleton({
        // Ex æquo createdAt exact avec zeta-titled → l'ordre d'entrée doit primer.
        taskId: 'alpha-untitled',
        createdAt: '2026-09-10T08:00:00Z',
        lastActivity: '2026-09-25T09:00:00Z',
        totalSize: 9000,
    }),
    makeSkeleton({
        // Ex æquo totalSize exact avec 9000-size → l'ordre d'entrée doit primer.
        taskId: 'mid-eq-size',
        title: 'aardvark',
        createdAt: '2026-09-12T12:00:00Z',
        lastActivity: '2026-09-18T16:45:00Z',
        totalSize: 9000,
    }),
    makeSkeleton({
        taskId: 'old-small',
        title: 'Ancienne petite tâche',
        createdAt: '2026-08-01T06:30:00Z',
        lastActivity: '2026-08-02T06:30:00Z',
        totalSize: 10,
    }),
    makeSkeleton({
        taskId: 'éacute-title',
        title: 'Étude comparative',
        createdAt: '2026-09-05T00:00:00Z',
        lastActivity: '2026-09-28T23:00:00Z',
        totalSize: 5000,
    }),
];

const service = new ClusterSummaryService();
const unifiedSort = (tasks: ConversationSkeleton[], sortBy: SortBy): ConversationSkeleton[] =>
    (service as any).sortClusterTasks(tasks, sortBy);

const LEGACY: Record<SortBy, (t: ConversationSkeleton[]) => ConversationSkeleton[]> = {
    chronological: legacySortByChronology,
    size: legacySortBySize,
    activity: legacySortByActivity,
    alphabetical: legacySortAlphabetically,
};

// ─── Assertions ───────────────────────────────────────────────────────────────

describe('conversation_summarizer cluster — tri A/B legacy vs UnifiedTask (#1394)', () => {
    test.each(Object.keys(LEGACY) as SortBy[])(
        'séquence de taskIds identique pour la stratégie %s',
        (sortBy) => {
            const idsA = LEGACY[sortBy](CORPUS).map(t => t.taskId);
            const idsB = unifiedSort(CORPUS, sortBy).map(t => t.taskId);
            expect(idsB).toEqual(idsA);
        }
    );

    test('défaut (sans stratégie) = chronologique, identique au legacy', () => {
        const idsA = legacySortByChronology(CORPUS).map(t => t.taskId);
        const idsB = unifiedSort(CORPUS, undefined as any).map(t => t.taskId);
        expect(idsB).toEqual(idsA);
    });

    test("le tri unifié ne mute pas le tableau d'entrée", () => {
        const input = [...CORPUS];
        const idsBefore = input.map(t => t.taskId).join('|');
        unifiedSort(input, 'size');
        expect(input.map(t => t.taskId).join('|')).toBe(idsBefore);
    });

    test("les squelettes restitués sont les objets d'origine (identité)", () => {
        const sorted = unifiedSort(CORPUS, 'activity');
        for (const skeleton of sorted) {
            expect(CORPUS).toContain(skeleton);
        }
    });

    test("ex æquo createdAt : stabilité préservée (ordre d'entrée)", () => {
        const sorted = unifiedSort(CORPUS, 'chronological');
        const zetaIdx = sorted.findIndex(t => t.taskId === 'zeta-titled');
        const alphaIdx = sorted.findIndex(t => t.taskId === 'alpha-untitled');
        expect(zetaIdx).toBeGreaterThan(-1);
        expect(alphaIdx).toBeGreaterThan(-1);
        // zeta-titled précède alpha-untitled dans CORPUS → doit le précéder au tri stable.
        expect(zetaIdx).toBeLessThan(alphaIdx);
    });
});
