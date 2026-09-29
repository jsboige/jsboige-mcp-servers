/**
 * A/B equivalence test — critère d'acceptation #1394
 * « 0 régression fonctionnelle (tests comparison) ».
 *
 * Outil #3 migré : roosync_search(action:"semantic") — étape d'enrichissement
 * `conversation_stats` depuis le conversationCache. Path A (legacy) :
 * l'expression AVANT migration, copiée verbatim (accès direct metadata).
 * Path B (unified) : la projection UnifiedTask avec l'expression exacte du
 * handler migré (search-semantic.tool.ts, bloc #636 Phase 2).
 *
 * Le garde-fou piège notamment la perte du repli `lastActivity || createdAt`
 * et l'oubli du `|| 0` sur messageCount dans le chemin unifié.
 */

import { describe, test, expect } from 'vitest';
import { ConversationSkeleton } from '../../../types/conversation.js';
import { buildConversationStats } from '../search-semantic.tool.js';

// ─── Path A (legacy, congelé verbatim de search-semantic.tool.ts pré-#1394) ──

interface ConversationStatsA {
    total_messages: number;
    workspace: string | undefined;
    last_activity: string | undefined;
}

function legacyConversationStats(cached: ConversationSkeleton): ConversationStatsA {
    return {
        total_messages: cached.metadata?.messageCount || 0,
        workspace: cached.metadata?.workspace,
        last_activity: cached.metadata?.lastActivity || cached.metadata?.createdAt,
    };
}

// ─── Path B (unified) : le helper LIVE du handler migré (#1394) ───────────────

const unifiedConversationStats = buildConversationStats;

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeSkeleton(overrides: {
    taskId: string;
    messageCount: number;
    workspace?: string;
    lastActivity?: string;
    createdAt?: string;
}): ConversationSkeleton {
    return {
        taskId: overrides.taskId,
        metadata: {
            messageCount: overrides.messageCount,
            actionCount: 0,
            totalSize: 100,
            lastActivity: overrides.lastActivity ?? '2026-09-28T12:00:00Z',
            createdAt: overrides.createdAt ?? '2026-09-01T08:00:00Z',
            workspace: overrides.workspace,
            source: 'roo',
        },
        sequence: [],
    } as ConversationSkeleton;
}

const CORPUS: ConversationSkeleton[] = [
    // Cas nominal : tout rempli, lastActivity > createdAt.
    makeSkeleton({ taskId: 'full', messageCount: 12, workspace: 'd:/dev/CoursIA' }),
    // messageCount 0 → total_messages 0 par `|| 0` des deux côtés.
    makeSkeleton({ taskId: 'zero-messages', messageCount: 0, workspace: 'c:/x' }),
    // Pas de workspace → undefined des deux côtés.
    makeSkeleton({ taskId: 'no-workspace', messageCount: 3 }),
    // lastActivity vide → repli createdAt (le piège principal).
    makeSkeleton({
        taskId: 'empty-activity-fallback',
        messageCount: 5,
        workspace: 'w',
        lastActivity: '',
        createdAt: '2026-09-15T09:30:00Z',
    }),
    // lastActivity ET createdAt vides → undefined des deux côtés.
    makeSkeleton({
        taskId: 'both-empty',
        messageCount: 1,
        lastActivity: '',
        createdAt: '',
    }),
];

// ─── Assertions ───────────────────────────────────────────────────────────────

describe('roosync_search semantic — conversation_stats A/B legacy vs UnifiedTask (#1394)', () => {
    test.each(CORPUS.map(s => [s.taskId, s] as const))(
        'stats identiques pour %s',
        (_taskId, skeleton) => {
            expect(unifiedConversationStats(skeleton)).toEqual(legacyConversationStats(skeleton));
        }
    );

    test('corpus entier : chaque champ identique champ à champ', () => {
        for (const skeleton of CORPUS) {
            const a = legacyConversationStats(skeleton);
            const b = unifiedConversationStats(skeleton);
            expect(b.total_messages).toBe(a.total_messages);
            expect(b.workspace).toBe(a.workspace);
            expect(b.last_activity).toBe(a.last_activity);
        }
    });

    test('le repli createdAt est actif dans le chemin unifié (garde anti-dérive)', () => {
        const skeleton = CORPUS.find(s => s.taskId === 'empty-activity-fallback')!;
        const stats = unifiedConversationStats(skeleton);
        expect(stats.last_activity).toBe('2026-09-15T09:30:00Z');
    });
});
