/**
 * Tests #2307 — export_data conversation json/csv must FAIL LOUD on empty sequence
 *
 * Mesure fondateur (20/10/2026) : une session JSONL de 602,4 MiB (> plafond de
 * découverte 500 MiB) donne un skeleton avec sequence vide ; export_data
 * (target=conversation, format=json/csv) fabriquait alors un document VIDE
 * annoncé comme un succès (0 message, timestamps fabriqués).
 *
 * La garde : EMPTY_CONVERSATION_SEQUENCE — erreur franche au lieu d'un
 * document vide "réussi". Les fixtures success doivent porter une séquence
 * non vide (voir export-data.test.ts createMockSkeleton, ajusté).
 *
 * @module tools/export/__tests__/export-data-empty-sequence
 * @version 1.0.0 (#2307)
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { handleExportData, ExportDataArgs } from '../export-data.js';
import { ConversationSkeleton } from '../../../types/conversation.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

function getTextContent(result: CallToolResult): string {
    const content = result.content[0];
    if (content && content.type === 'text') {
        return content.text;
    }
    return '';
}

// Mock XmlExporterService (non sollicité sur le chemin json/csv, requis par la signature)
const mockXmlExporterService = {
    generateTaskXml: vi.fn(),
    generateConversationXml: vi.fn(),
    generateProjectXml: vi.fn(),
    saveXmlToFile: vi.fn()
};

// Mock TraceSummaryService — la garde doit tirer AVANT toute génération
const { mockGenerateSummary } = vi.hoisted(() => ({
    mockGenerateSummary: vi.fn()
}));

vi.mock('../../../services/TraceSummaryService.js', () => ({
    TraceSummaryService: class {
        generateSummary = mockGenerateSummary;
    }
}));

vi.mock('../../../services/ExportConfigManager.js', () => ({
    ExportConfigManager: vi.fn().mockImplementation(() => ({}))
}));

vi.mock('fs/promises', () => ({
    default: {
        mkdir: vi.fn(),
        writeFile: vi.fn()
    }
}));

describe('#2307: export_data conversation json/csv — empty sequence fails loud', () => {
    let mockCache: Map<string, ConversationSkeleton>;
    let mockEnsureCache: (options?: { workspace?: string }) => Promise<void>;
    let mockGetSkeleton: (taskId: string) => Promise<ConversationSkeleton | null>;

    /** Skeleton au-dessus du plafond de découverte : fichier jamais lu → séquence vide. */
    const makeOversizedSkeleton = (taskId: string): ConversationSkeleton => ({
        taskId,
        metadata: {
            title: 'Oversized session',
            lastActivity: '2026-10-20T10:00:00.000Z',
            createdAt: '2026-10-19T08:00:00.000Z',
            messageCount: 0,
            actionCount: 0,
            totalSize: 631 * 1024 * 1024,
            workspace: '/test/workspace'
        },
        sequence: []
    });

    /** Stub Tier-3 (#3661) : séquence vide LÉGITIME, corps chargé à la demande. */
    const makeTier3StubSkeleton = (taskId: string): ConversationSkeleton => ({
        taskId,
        metadata: {
            title: 'Tier-3 archive stub',
            lastActivity: '2026-10-20T10:00:00.000Z',
            createdAt: '2026-10-19T08:00:00.000Z',
            messageCount: 0,
            actionCount: 0,
            totalSize: 0,
            hydrated: true,
            workspace: '/test/workspace'
        },
        sequence: []
    });

    const makePopulatedSkeleton = (taskId: string): ConversationSkeleton => ({
        taskId,
        metadata: {
            title: 'Normal session',
            lastActivity: '2026-10-20T10:00:00.000Z',
            createdAt: '2026-10-19T08:00:00.000Z',
            messageCount: 3,
            actionCount: 1,
            totalSize: 2048,
            workspace: '/test/workspace'
        },
        sequence: [
            { role: 'user', content: 'hello', timestamp: '2026-10-19T08:00:01.000Z', isTruncated: false },
            { role: 'assistant', content: 'hi', timestamp: '2026-10-19T08:00:02.000Z', isTruncated: false }
        ]
    });

    beforeEach(() => {
        vi.clearAllMocks();
        mockCache = new Map();
        mockCache.set('oversized-1', makeOversizedSkeleton('oversized-1'));
        mockCache.set('stub-1', makeTier3StubSkeleton('stub-1'));
        mockCache.set('normal-1', makePopulatedSkeleton('normal-1'));
        mockEnsureCache = vi.fn(async () => {});
        mockGetSkeleton = vi.fn(async (taskId: string) => mockCache.get(taskId) || null);
        mockGenerateSummary.mockResolvedValue({
            success: true,
            content: '{"mock": "json"}',
            statistics: {
                totalSections: 2,
                userMessages: 1,
                assistantMessages: 1,
                toolResults: 0,
                totalContentSize: 10
            }
        });
    });

    describe('format: json', () => {
        test('empty sequence → EMPTY_CONVERSATION_SEQUENCE, pas de succès fantôme', async () => {
            const args: ExportDataArgs = { target: 'conversation', format: 'json', taskId: 'oversized-1' };

            const result = await handleExportData(
                args, mockCache, mockXmlExporterService as any, mockEnsureCache, mockGetSkeleton
            );

            expect(result.isError).toBe(true);
            expect(getTextContent(result)).toContain('EMPTY_CONVERSATION_SEQUENCE');
            expect(getTextContent(result)).toContain('oversized-1');
        });

        test('empty sequence → generateSummary jamais appelé (la garde précède la génération)', async () => {
            const args: ExportDataArgs = { target: 'conversation', format: 'json', taskId: 'oversized-1' };

            await handleExportData(
                args, mockCache, mockXmlExporterService as any, mockEnsureCache, mockGetSkeleton
            );

            expect(mockGenerateSummary).not.toHaveBeenCalled();
        });

        test('Tier-3 stub (hydrated: true, séquence vide) → aussi EMPTY_CONVERSATION_SEQUENCE avec pistes de résolution', async () => {
            const args: ExportDataArgs = { target: 'conversation', format: 'json', taskId: 'stub-1' };

            const result = await handleExportData(
                args, mockCache, mockXmlExporterService as any, mockEnsureCache, mockGetSkeleton
            );

            expect(result.isError).toBe(true);
            expect(getTextContent(result)).toContain('EMPTY_CONVERSATION_SEQUENCE');
            // Le message doit orienter : l'export vide n'est pas négociable, mais la cause est expliquée
            expect(getTextContent(result)).toMatch(/hydrat|Tier-3|archive/i);
        });

        test('séquence non vide → succès inchangé (pas de régression)', async () => {
            const args: ExportDataArgs = { target: 'conversation', format: 'json', taskId: 'normal-1' };

            const result = await handleExportData(
                args, mockCache, mockXmlExporterService as any, mockEnsureCache, mockGetSkeleton
            );

            expect(result.isError).toBeFalsy();
            expect(mockGenerateSummary).toHaveBeenCalledTimes(1);
        });
    });

    describe('format: csv', () => {
        test('empty sequence → EMPTY_CONVERSATION_SEQUENCE, pas de succès fantôme', async () => {
            const args: ExportDataArgs = { target: 'conversation', format: 'csv', taskId: 'oversized-1' };

            const result = await handleExportData(
                args, mockCache, mockXmlExporterService as any, mockEnsureCache, mockGetSkeleton
            );

            expect(result.isError).toBe(true);
            expect(getTextContent(result)).toContain('EMPTY_CONVERSATION_SEQUENCE');
        });

        test('empty sequence → generateSummary jamais appelé', async () => {
            const args: ExportDataArgs = { target: 'conversation', format: 'csv', taskId: 'oversized-1' };

            await handleExportData(
                args, mockCache, mockXmlExporterService as any, mockEnsureCache, mockGetSkeleton
            );

            expect(mockGenerateSummary).not.toHaveBeenCalled();
        });

        test('séquence non vide → succès inchangé (pas de régression)', async () => {
            const args: ExportDataArgs = { target: 'conversation', format: 'csv', taskId: 'normal-1', csvVariant: 'messages' };

            const result = await handleExportData(
                args, mockCache, mockXmlExporterService as any, mockEnsureCache, mockGetSkeleton
            );

            expect(result.isError).toBeFalsy();
            expect(mockGenerateSummary).toHaveBeenCalledTimes(1);
        });
    });
});
