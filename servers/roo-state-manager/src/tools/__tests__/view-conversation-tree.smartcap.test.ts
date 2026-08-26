/**
 * Tests #3280 — smart_truncation borne la taille TOTALE de la sortie.
 *
 * Récidive de #3171 sur un chemin non couvert : le moteur smart budgete le
 * CONTENU estimé à 50k (summary) mais l'overhead de rendu (header par message,
 * préfixe `    | ` par ligne, Params JSON pretty-printés) échappait à la borne —
 * 216 369 chars rendus pour une annonce "297k → 50k" (repro po-2025 26/08,
 * session 12,7 MB / 1125 messages). Le filet final appliquait max_output_length
 * (300k), pas la limite smart.
 *
 * AC issue #3280 :
 * 1. Sortie TOTALE (contenu + en-têtes + métadonnées) ≤ borne du chemin smart
 *    (50k par défaut en summary), sans max_output_length explicite.
 * 2. Le header « Compression intelligente » rapporte la taille RÉELLE rendue.
 *
 * Contre-épreuve (mutation vérifiée) :
 * - Restaurer applyHardCap(result, max_output_length) côté caller → le test
 *   « ≤ 50 000 » échoue (overhead de rendu ~1,3 Mo non borné).
 * - Supprimer la réécriture du header → le test « chars rendus » échoue.
 *
 * Framework: Vitest
 * @module tools/__tests__/view-conversation-tree.smartcap
 */

import { describe, test, expect } from 'vitest';
import { viewConversationTree } from '../view-conversation-tree.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ConversationSkeleton } from '../../types/conversation.js';

function textTotal(result: CallToolResult): number {
    return result.content
        .filter((c): c is Extract<typeof c, { type: 'text' }> => c.type === 'text')
        .reduce((sum, c) => sum + c.text.length, 0);
}

function firstText(result: CallToolResult): string {
    const first = result.content[0];
    return first && first.type === 'text' ? first.text : '';
}

describe('view handler e2e (#3280) : session ≥ 10 Mo, summary + smart_truncation, sortie TOTALE bornée', () => {
    // Shape du repro : ~1800 items où l'overhead de rendu DOMINE le contenu.
    // #3171 testait 60 messages énormes (peu d'en-têtes) ; le défaut #3280 ne
    // se manifeste qu'avec BEAUCOUP d'items (headers + préfixes par ligne).
    const MSG_COUNT = 1200;   // × ~10 099 chars multi-lignes
    const ACTION_COUNT = 600; // × params JSON ~1,2 ko

    const bigOverheadTask: ConversationSkeleton = {
        taskId: 'e2e-overhead-task',
        parentTaskId: undefined,
        metadata: {
            title: 'Big session 13MB overhead-heavy',
            lastActivity: new Date().toISOString(),
            createdAt: new Date().toISOString(),
            messageCount: MSG_COUNT,
            actionCount: ACTION_COUNT,
            totalSize: 13_000_000,
            workspace: '/test'
        },
        sequence: Array.from({ length: MSG_COUNT + ACTION_COUNT }, (_, i) => {
            const actionSlot = i % 3 === 2 && i < ACTION_COUNT * 3;
            if (actionSlot) {
                return {
                    name: 'tool_call',
                    type: 'tool',
                    status: 'success',
                    parameters: { p: 'x'.repeat(1200) },
                    timestamp: new Date(Date.now() + i).toISOString()
                };
            }
            return {
                role: i % 2 === 0 ? 'user' as const : 'assistant' as const,
                content: Array(100).fill('m'.repeat(100)).join('\n'),
                timestamp: new Date(Date.now() + i).toISOString(),
                isTruncated: false
            };
        })
    };

    test('rend ≤ 50 000 chars tous blocs confondus SANS max_output_length explicite', async () => {
        const cache = new Map([[bigOverheadTask.taskId, bigOverheadTask]]);
        const result = await viewConversationTree.handler(
            {
                task_id: bigOverheadTask.taskId,
                detail_level: 'summary',
                smart_truncation: true
                // PAS de max_output_length : borne = plafond smart summary (50 000)
            },
            cache
        );

        const total = textTotal(result as CallToolResult);
        // CONTRE-ÉPREUVE : avant #3280, le moteur visait 50k mais le rendu
        // (headers ×1800 + préfixes par ligne + Params JSON) sortait à ~1,3 Mo,
        // et le filet final bornait à 300k — pas à la limite smart.
        expect(total).toBeLessThanOrEqual(50_000);
        expect((result as any).isError).toBeFalsy();
        // Le cap total a bien mordu (marqueur hardCapString sur le rendu final)
        expect(firstText(result as CallToolResult)).toContain('hard cap');
    }, 60_000);

    test('le header « Compression intelligente » annonce la taille RÉELLE rendue', async () => {
        const cache = new Map([[bigOverheadTask.taskId, bigOverheadTask]]);
        const result = await viewConversationTree.handler(
            {
                task_id: bigOverheadTask.taskId,
                detail_level: 'summary',
                smart_truncation: true
            },
            cache
        );

        const text = firstText(result as CallToolResult);
        const total = textTotal(result as CallToolResult);

        // L'annonce réécrite porte le suffixe « rendus » (#3280)
        const match = text.match(/🎯 Compression intelligente: ([\d.]+)% \((\d+)k → (\d+)k chars rendus\)/);
        expect(match).not.toBeNull();

        // Le B annoncé correspond à la taille réelle à l'arrondi k près
        const announcedK = parseInt(match![3], 10);
        expect(Math.abs(announcedK * 1000 - total)).toBeLessThanOrEqual(1000);

        // L'ancienne forme (chiffres du plan, sans « rendus ») ne doit plus apparaître
        expect(text).not.toMatch(/Compression intelligente: [\d.]+% \(\d+k → \d+k chars\)\n/);
    }, 60_000);

    test('messageRange (pagination) reste inclus dans la borne TOTALE', async () => {
        const cache = new Map([[bigOverheadTask.taskId, bigOverheadTask]]);
        const result = await viewConversationTree.handler(
            {
                task_id: bigOverheadTask.taskId,
                detail_level: 'summary',
                smart_truncation: true,
                messageStart: 0,
                messageEnd: 900
            },
            cache
        );

        const text = firstText(result as CallToolResult);
        const total = textTotal(result as CallToolResult);
        // #3280 : le header messageRange est injecté APRÈS rendu mais AVANT le
        // cap final — la sortie paginée reste bornée, métadonnées incluses.
        expect(text).toContain('messageRange:');
        expect(total).toBeLessThanOrEqual(50_000);
    }, 60_000);
});
