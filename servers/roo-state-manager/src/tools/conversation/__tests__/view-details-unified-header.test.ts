/**
 * A/B equivalence test — critère d'acceptation #1394
 * « 0 régression fonctionnelle (tests comparison) ».
 *
 * Outil #2 migré : view_task_details. Path A (legacy) : le rendu de l'en-tête
 * du rapport AVANT la migration, copié verbatim ci-dessous (accès direct
 * metadata). Path B (unified) : le handler réel, dont l'en-tête est rendu
 * depuis la projection UnifiedTask.
 *
 * Les deux chemins doivent produire le MÊME bloc d'en-tête (6 premières
 * lignes de la sortie) sur tout le corpus. Le rendu des actions (sequence)
 * n'est pas couvert ici — il reste squelette par construction.
 */

import { describe, test, expect, vi } from 'vitest';
import { ConversationSkeleton } from '../../../types/conversation.js';
import { viewTaskDetailsTool } from '../view-details.tool.js';

vi.mock('../../../utils/claude-storage-detector.js', () => ({
    ClaudeStorageDetector: {
        findConversationById: vi.fn(),
    }
}));

// ─── Path A (legacy, congelé verbatim de view-details.tool.ts pré-#1394) ─────

function renderLegacyHeader(skeleton: ConversationSkeleton): string {
    let output = `🔍 Détails techniques complets - Tâche: ${skeleton.metadata.title || skeleton.taskId}\n`;
    output += `═══════════════════════════════════════════════════════════════════════════════════════════════════════\n`;
    output += `ID: ${skeleton.taskId}\n`;
    output += `Messages: ${skeleton.metadata.messageCount}\n`;
    output += `Taille totale: ${skeleton.metadata.totalSize} octets\n`;
    output += `Dernière activité: ${skeleton.metadata.lastActivity}\n\n`;
    return output;
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeSkeleton(overrides: {
    taskId: string;
    title?: string;
    messageCount: number;
    totalSize: number;
    lastActivity: string;
    createdAt?: string;
    source?: 'roo' | 'claude-code' | 'zoo-code';
}): ConversationSkeleton {
    return {
        taskId: overrides.taskId,
        metadata: {
            title: overrides.title,
            messageCount: overrides.messageCount,
            actionCount: 0,
            totalSize: overrides.totalSize,
            lastActivity: overrides.lastActivity,
            createdAt: overrides.createdAt ?? overrides.lastActivity,
            source: overrides.source ?? 'roo',
        },
        sequence: [],
    } as ConversationSkeleton;
}

/** Corpus : sans titre (repli taskId), compte nul, source zoo, activité vide,
 *  dates distinctes (createdAt ≠ lastActivity — piège la confusion des champs). */
const CORPUS: ConversationSkeleton[] = [
    makeSkeleton({
        taskId: 'roo-titled',
        title: 'Migration UnifiedTask',
        messageCount: 42,
        totalSize: 12345,
        lastActivity: '2026-09-28T10:00:00Z',
    }),
    makeSkeleton({
        taskId: 'claude-untitled',
        messageCount: 0,
        totalSize: 0,
        lastActivity: '2026-09-01T00:00:00Z',
        source: 'claude-code',
    }),
    makeSkeleton({
        taskId: 'zoo-fallback',
        messageCount: 7,
        totalSize: 999999,
        lastActivity: '',
        source: 'zoo-code',
    }),
    makeSkeleton({
        taskId: 'roo-accent-é',
        title: 'Tâche avec accents — et emoji 🎯',
        messageCount: 3,
        totalSize: 777,
        lastActivity: '2026-09-29T23:59:59Z',
    }),
    makeSkeleton({
        // createdAt ≠ lastActivity : une mutation qui rend createdAt au lieu de
        // lastActivity (ou l'inverse) DOIT être détectée sur cette entrée.
        taskId: 'distinct-dates',
        title: 'Créée tôt, active tard',
        messageCount: 9,
        totalSize: 4242,
        lastActivity: '2026-09-28T22:00:00Z',
        createdAt: '2026-08-14T06:00:00Z',
    }),
];

// ─── Assertions ───────────────────────────────────────────────────────────────

describe('view_task_details — en-tête A/B legacy vs UnifiedTask (#1394)', () => {
    test.each(CORPUS.map(s => [s.taskId, s] as const))(
        'en-tête identique pour %s',
        async (_taskId, skeleton) => {
            const cache = new Map<string, ConversationSkeleton>();
            cache.set(skeleton.taskId, skeleton);

            const result = await viewTaskDetailsTool.handler({ task_id: skeleton.taskId }, cache);
            const output = (result.content[0] as { type: string; text: string }).text;

            // L'en-tête unifié (6 lignes) doit être EXACTEMENT le rendu legacy.
            const expectedHeader = renderLegacyHeader(skeleton);
            expect(output.startsWith(expectedHeader)).toBe(true);

            // Les lignes header sont rendues (le bloc n'est pas vide/tronqué).
            expect(output).toContain(`ID: ${skeleton.taskId}`);
            expect(output).toContain(`Messages: ${skeleton.metadata.messageCount}`);
            expect(output).toContain(`Taille totale: ${skeleton.metadata.totalSize} octets`);
        }
    );

    test('la sortie sans actions garde le pied de rapport inchangé', async () => {
        const skeleton = CORPUS[1];
        const cache = new Map<string, ConversationSkeleton>();
        cache.set(skeleton.taskId, skeleton);

        const result = await viewTaskDetailsTool.handler({ task_id: skeleton.taskId }, cache);
        const output = (result.content[0] as { type: string; text: string }).text;
        expect(output).toContain('Aucune action technique trouvée');
    });
});
