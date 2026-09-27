/**
 * Tests #2609 V4 — squelette essentiel : le rendu ne noie plus le signal sous
 * des marqueurs vides.
 *
 * Baseline Epic #2609 (16/06, live) : sur le debrief CoursIA (8,69 M chars),
 * `view` rendait des milliers de marqueurs `[Assistant]:`/`[User]:` VIDES qui
 * consommaient le budget de sortie et noyaient le squelette. La rubric V4 (b)
 * exige que le rendu porte l'essentiel : un message au contenu vide ne rend
 * RIEN (aucun signal) — son omission est comptée et annoncée sur une ligne.
 *
 * Couvre les DEUX formatters :
 * - createFormatTaskFunction (chemin smart, par défaut),
 * - formatTask interne (chemin legacy, smart_truncation: false).
 *
 * Contre-épreuve (mutation vérifiée) :
 * - Restaurer le rendu inconditionnel des messages vides → le compteur de
 *   marqueurs `[role]` repasse de 3 à 7 et le test « marqueurs vides absents »
 *   échoue.
 *
 * Framework: Vitest
 * @module tools/__tests__/view-conversation-tree.essential-skeleton
 */

import { describe, test, expect } from 'vitest';
import { viewConversationTree } from '../view-conversation-tree.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ConversationSkeleton } from '../../types/conversation.js';

function firstText(result: CallToolResult): string {
    const first = result.content[0];
    return first && first.type === 'text' ? first.text : '';
}

function countRoleMarkers(text: string): number {
    return (text.match(/\[(?:👤 User|🤖 Assistant)\]/g) ?? []).length;
}

describe('view handler e2e (#2609 V4) : squelette essentiel, marqueurs vides omis', () => {
    // 7 messages dont 4 vides (2 strings vides, 1 whitespace-only, 1 de plus) :
    // la baseline live montrait exactement cette classe de bruit.
    const noisyTask: ConversationSkeleton = {
        taskId: 'v4-essential-skeleton',
        parentTaskId: undefined,
        metadata: {
            title: 'Session with empty markers',
            lastActivity: new Date().toISOString(),
            createdAt: new Date().toISOString(),
            messageCount: 7,
            actionCount: 0,
            totalSize: 100_000,
            workspace: '/test'
        },
        sequence: [
            { role: 'user',      content: 'Question initiale sur le pipeline', timestamp: '2026-06-16T10:00:00Z', isTruncated: false },
            { role: 'assistant', content: '',                                   timestamp: '2026-06-16T10:00:01Z', isTruncated: false },
            { role: 'user',      content: '   ',                                timestamp: '2026-06-16T10:00:02Z', isTruncated: false },
            { role: 'assistant', content: 'Réponse substantielle avec la décision: floor 12.17', timestamp: '2026-06-16T10:00:03Z', isTruncated: false },
            { role: 'user',      content: '',                                   timestamp: '2026-06-16T10:00:04Z', isTruncated: false },
            { role: 'user',      content: '',                                   timestamp: '2026-06-16T10:00:05Z', isTruncated: false },
            { role: 'assistant', content: 'Conclusion et prochaine étape',      timestamp: '2026-06-16T10:00:06Z', isTruncated: false },
        ],
    };

    test('chemin smart (défaut), skeleton : marqueurs vides omis, note d\'omission, signal intact', async () => {
        const cache = new Map([[noisyTask.taskId, noisyTask]]);
        const result = await viewConversationTree.handler(
            { task_id: noisyTask.taskId, detail_level: 'skeleton' },
            cache
        );

        const text = firstText(result as CallToolResult);

        // Les 3 messages substantiels sont rendus
        expect(text).toContain('Question initiale sur le pipeline');
        expect(text).toContain('floor 12.17');
        expect(text).toContain('Conclusion et prochaine étape');

        // Aucun marqueur suivi d'un contenu vide (le défaut de la baseline)
        expect(text).not.toMatch(/\[👤 User\]:[ \t]*$/m);
        expect(text).not.toMatch(/\[🤖 Assistant\]:[ \t]*$/m);

        // Exactement 3 marqueurs de rôle pour 3 messages non vides
        expect(countRoleMarkers(text)).toBe(3);

        // L'omission est annoncée avec le bon compte (4 messages vides)
        expect(text).toContain('[... 4 message(s) vide(s) omis(s) ...]');
    });

    test('chemin legacy (smart_truncation: false), skeleton : mêmes garanties', async () => {
        const cache = new Map([[noisyTask.taskId, noisyTask]]);
        const result = await viewConversationTree.handler(
            { task_id: noisyTask.taskId, detail_level: 'skeleton', smart_truncation: false },
            cache
        );

        const text = firstText(result as CallToolResult);
        expect(text).toContain('floor 12.17');
        expect(text).not.toMatch(/\[👤 User\]:[ \t]*$/m);
        expect(text).not.toMatch(/\[🤖 Assistant\]:[ \t]*$/m);
        expect(countRoleMarkers(text)).toBe(3);
        expect(text).toContain('[... 4 message(s) vide(s) omis(s) ...]');
    });

    test('mode summary (chemin smart) : les vides sont omis aussi, sans marker orphelin', async () => {
        const cache = new Map([[noisyTask.taskId, noisyTask]]);
        const result = await viewConversationTree.handler(
            { task_id: noisyTask.taskId, detail_level: 'summary' },
            cache
        );

        const text = firstText(result as CallToolResult);
        // En summary, un marker vide se rendrait « [role]:\n » suivi de rien :
        // aucun marker ne doit être immédiatement suivi d'une ligne vide.
        expect(text).not.toMatch(/\[(?:👤 User|🤖 Assistant)\]:\n(?:[ \t]*\n|\s*$)/);
        expect(countRoleMarkers(text)).toBe(3);
        expect(text).toContain('[... 4 message(s) vide(s) omis(s) ...]');
    });

    test('aucun message vide : aucune note d\'omission (pas de régression silencieuse)', async () => {
        const cleanTask: ConversationSkeleton = {
            ...noisyTask,
            taskId: 'v4-essential-skeleton-clean',
            metadata: { ...noisyTask.metadata, messageCount: 2 },
            sequence: [
                { role: 'user', content: 'Question', timestamp: '2026-06-16T10:00:00Z', isTruncated: false },
                { role: 'assistant', content: 'Réponse', timestamp: '2026-06-16T10:00:01Z', isTruncated: false },
            ],
        };
        const cache = new Map([[cleanTask.taskId, cleanTask]]);
        const result = await viewConversationTree.handler(
            { task_id: cleanTask.taskId, detail_level: 'skeleton' },
            cache
        );

        const text = firstText(result as CallToolResult);
        expect(text).not.toContain('vide(s) omis(s)');
        expect(countRoleMarkers(text)).toBe(2);
    });
});
