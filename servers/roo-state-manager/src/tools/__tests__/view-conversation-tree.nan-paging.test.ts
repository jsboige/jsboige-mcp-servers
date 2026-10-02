/**
 * Tests #4002 — pagination NaN sur le chemin principal du tree view.
 *
 * Récidive du motif #4002 sur un bloc non couvert : la pagination async
 * (post-lazy-load, handleViewConversationTreeExecutionAsync) bornait
 * messageStart/messageEnd via Math.max/Math.min — or Math.max(0, NaN) est NaN
 * et slice(NaN, NaN) retourne [] silencieusement : rendu vide, aucune erreur.
 * La version synchrone (handleViewConversationTreeExecution) avait déjà la
 * garde sanitizeInt ; ce fichier couvre l'autre bloc (review ai-01, PR #1281).
 *
 * Contre-épreuve (mutation vérifiée) :
 * - Sans la garde (retour à Math.max(0, args.messageStart ?? 0)), les tests
 *   « rejects » échouent : le handler rend une sortie vide au lieu de rejeter.
 *
 * Framework: Vitest
 * @module tools/__tests__/view-conversation-tree.nan-paging
 */

import { describe, test, expect } from 'vitest';
import { viewConversationTree } from '../view-conversation-tree.js';
import type { ConversationSkeleton } from '../../types/conversation.js';

const pagedTask: ConversationSkeleton = {
    taskId: 'nan-paging-task',
    parentTaskId: undefined,
    metadata: {
        title: 'NaN paging fixture',
        lastActivity: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        messageCount: 4,
        actionCount: 0,
        totalSize: 1_000,
        workspace: '/test'
    },
    sequence: Array.from({ length: 4 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' as const : 'assistant' as const,
        content: `message ${i}`,
        timestamp: new Date(Date.now() + i).toISOString(),
        isTruncated: false
    }))
};

describe('view handler — pagination NaN (#4002, bloc async) : rejet nominal, jamais un rendu vide', () => {
    test('messageStart: NaN → GenericError nommant messageStart', async () => {
        const cache = new Map([[pagedTask.taskId, pagedTask]]);
        await expect(
            viewConversationTree.handler(
                { task_id: pagedTask.taskId, messageStart: Number.NaN, messageEnd: 3 } as any,
                cache
            )
        ).rejects.toThrow('messageStart must be a finite number (got NaN)');
    });

    test('messageEnd: NaN → GenericError nommant messageEnd', async () => {
        const cache = new Map([[pagedTask.taskId, pagedTask]]);
        await expect(
            viewConversationTree.handler(
                { task_id: pagedTask.taskId, messageStart: 1, messageEnd: Number.NaN } as any,
                cache
            )
        ).rejects.toThrow('messageEnd must be a finite number (got NaN)');
    });

    test('borne saine : messageStart/messageEnd valides paginent sans erreur', async () => {
        const cache = new Map([[pagedTask.taskId, pagedTask]]);
        const result: any = await viewConversationTree.handler(
            { task_id: pagedTask.taskId, messageStart: 1, messageEnd: 3 } as any,
            cache
        );
        // Le garde ne doit pas casser le paging normal : rendu présent, pas d'erreur.
        expect(result.isError).toBeFalsy();
        const text = result.content?.[0]?.text ?? '';
        expect(text.length).toBeGreaterThan(0);
    });
});
