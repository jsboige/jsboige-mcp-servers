/**
 * Tests #3171 — applyHardCap borne la SOMME des blocs texte (pas content[0] seul)
 * + e2e : view avec max_output_length: N sur une session > 10 Mo rend ≤ N chars.
 *
 * Contre-épreuve (mutation vérifiée) :
 * - Restaurer le cap content[0]-seul  → le test multi-blocs échoue (somme > maxChars)
 * - Restaurer la constante 0.3 engine → le test e2e échoue (plancher 30% de la source)
 *
 * Framework: Vitest
 * @module tools/__tests__/view-conversation-tree.hardcap
 */

import { describe, test, expect } from 'vitest';
import { applyHardCap, viewConversationTree } from '../view-conversation-tree.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ConversationSkeleton } from '../../types/conversation.js';

function textResult(texts: string[]): CallToolResult {
    return { content: texts.map(t => ({ type: 'text' as const, text: t })) };
}

function textTotal(result: CallToolResult): number {
    return result.content
        .filter((c): c is Extract<typeof c, { type: 'text' }> => c.type === 'text')
        .reduce((sum, c) => sum + c.text.length, 0);
}

describe('applyHardCap (#3171)', () => {
    test('no-op sous budget', () => {
        const result = textResult(['courts']);
        expect(applyHardCap(result, 100)).toBe(result);
    });

    test('single block: borne à maxChars', () => {
        const result = applyHardCap(textResult(['x'.repeat(50_000)]), 4000);
        expect(textTotal(result)).toBeLessThanOrEqual(4000);
    });

    test('multi-blocs: la SOMME de tous les blocs texte est bornée (pas content[0] seul)', () => {
        // Mesure ai-01 : cap "mordu" sur content[0], blocs suivants sortis intacts
        const result = applyHardCap(
            textResult(['a'.repeat(200_000), 'b'.repeat(100_000), 'c'.repeat(600_000)]),
            4000
        );
        expect(result.content).toHaveLength(3);
        expect(textTotal(result)).toBeLessThanOrEqual(4000);
        // Chaque bloc tronqué porte le marqueur hard cap
        for (const c of result.content) {
            if (c.type === 'text') expect(c.text).toContain('hard cap');
        }
    });

    test('blocs non-texte préservés intacts et non comptés', () => {
        const binary = { type: 'image' as const, data: 'binary', mimeType: 'image/png' };
        const result = applyHardCap(
            { content: [{ type: 'text', text: 'x'.repeat(50_000) }, binary] },
            4000
        );
        expect(result.content[1]).toBe(binary);
        expect(textTotal(result)).toBeLessThanOrEqual(4000);
    });

    test('budgets disproportionnés entre blocs: la somme reste bornée', () => {
        const result = applyHardCap(
            textResult(['tête'.repeat(10), 'z'.repeat(1_000_000), 'queue']),
            2000
        );
        expect(textTotal(result)).toBeLessThanOrEqual(2000);
    });
});

describe('view handler e2e (#3171 AC-3) : session > 10 Mo, max_output_length honoré', () => {
    const bigTask: ConversationSkeleton = {
        taskId: 'e2e-big-task',
        parentTaskId: undefined,
        metadata: {
            title: 'Big session 12MB',
            lastActivity: new Date().toISOString(),
            createdAt: new Date().toISOString(),
            messageCount: 60,
            actionCount: 0,
            totalSize: 12_000_000,
            workspace: '/test'
        },
        // 60 messages × ~200 000 chars ≈ 12 Mo, contenus multi-lignes pour que
        // truncateMiddle (5+5 lignes) comprime réellement chaque élément marqué
        sequence: Array(60).fill(null).map((_, i) => ({
            role: i % 2 === 0 ? 'user' as const : 'assistant' as const,
            content: Array(2000).fill('c'.repeat(100)).join('\n'),
            timestamp: new Date(Date.now() + i).toISOString(),
            isTruncated: false
        }))
    };

    test('rend ≤ 4000 chars tous blocs confondus pour max_output_length: 4000', async () => {
        const cache = new Map([[bigTask.taskId, bigTask]]);
        const result = await viewConversationTree.handler(
            {
                task_id: bigTask.taskId,
                detail_level: 'summary',
                smart_truncation: true,
                max_output_length: 4000
            },
            cache
        );

        const total = textTotal(result as CallToolResult);
        // CONTRE-ÉPREUVE: avec la constante 0.3 (engine) OU le cap content[0]-seul,
        // ce test échoue (rendu observé ~30% de la source, soit ~3,6 Mo)
        expect(total).toBeLessThanOrEqual(4000);
        expect((result as any).isError).toBeFalsy();
    }, 30_000);
});
