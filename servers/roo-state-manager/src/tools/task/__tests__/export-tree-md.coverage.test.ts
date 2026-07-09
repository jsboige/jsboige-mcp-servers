/**
 * Coverage tests for handleExportTaskTreeMarkdown
 *
 * Cible les branches NON couvertes par les 3 fichiers de test existants
 * (export-tree-md.test.ts 18 tests, export-tree-md.tool.test.ts 13 tests,
 * export-tree-md.integration.test.ts 4 tests = 35 tests).
 *
 * **Gap fresh measure (95.23% stmts / 92.3% branch)** :
 *  - L150-157 : garde `typeof formattedTree !== 'string'` → INVALID_DATA_FORMAT.
 *    Aucun des 35 tests existants ne fait retourner par handleGetTaskTree un
 *    `content[0].text` NON-string → le garde de validation n'est jamais déclenché.
 *  - L203 : branche catch `String(e)` (error non-Error). Déclenchable via un
 *    mock rejetant avec une valeur non-Error.
 *
 * Pattern C3 (Vein D, dispatch #2800) : 1 fichier = 1 PR.
 *
 * @module tools/task/__tests__/export-tree-md.coverage
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ConversationSkeleton } from '../../../types/conversation.js';

// Mock fs (même pattern que export-tree-md.test.ts)
vi.mock('fs', () => {
    const actual = vi.importActual('fs');
    return {
        ...actual,
        default: actual,
        promises: {
            access: vi.fn(),
            utimes: vi.fn(),
            mkdir: vi.fn().mockResolvedValue(undefined),
            writeFile: vi.fn().mockResolvedValue(undefined),
            readFile: vi.fn(),
        },
    };
});

import { handleExportTaskTreeMarkdown } from '../export-tree-md.tool.js';

describe('export-tree-md.tool — coverage branches', () => {
    let mockHandleGetTaskTree: ReturnType<typeof vi.fn>;
    let mockEnsureFresh: ReturnType<typeof vi.fn>;

    const baseArgs = {
        conversation_id: 'conv-xyz-1234-5678-9abcdef01234',
    };

    beforeEach(() => {
        vi.clearAllMocks();
        mockEnsureFresh = vi.fn().mockResolvedValue(undefined);
        mockHandleGetTaskTree = vi.fn().mockResolvedValue({
            content: [{ type: 'text', text: '# Tree\n└── leaf' }],
        });
    });

    // ============================================================
    // INVALID_DATA_FORMAT : content[0].text non-string (L150-157)
    // ============================================================
    describe('INVALID_DATA_FORMAT — content[0].text non-string (L150-157)', () => {

        test('content[0].text = number → catch, isError true', async () => {
            mockHandleGetTaskTree.mockResolvedValue({
                content: [{ type: 'text', text: 12345 }], // text non-string
            } as unknown as CallToolResult);

            const result = await handleExportTaskTreeMarkdown(
                baseArgs,
                mockHandleGetTaskTree,
                mockEnsureFresh
            );

            expect(result.isError).toBe(true);
            const text = (result.content[0] as any).text;
            // Le StateManagerError INVALID_DATA_FORMAT est attrapé par le catch (L202)
            // et renvoyé comme message d'erreur
            expect(text).toMatch(/Format de données invalide|INVALID_DATA_FORMAT|number/i);
        });

        test('content[0].text = object → catch, isError true', async () => {
            mockHandleGetTaskTree.mockResolvedValue({
                content: [{ type: 'text', text: { unexpected: 'shape' } }],
            } as unknown as CallToolResult);

            const result = await handleExportTaskTreeMarkdown(
                baseArgs,
                mockHandleGetTaskTree,
                mockEnsureFresh
            );

            expect(result.isError).toBe(true);
        });

        test('content[0].text = null → catch, isError true', async () => {
            mockHandleGetTaskTree.mockResolvedValue({
                content: [{ type: 'text', text: null }],
            } as unknown as CallToolResult);

            const result = await handleExportTaskTreeMarkdown(
                baseArgs,
                mockHandleGetTaskTree,
                mockEnsureFresh
            );

            expect(result.isError).toBe(true);
        });
    });

    // ============================================================
    // catch String(e) : error non-Error (L203)
    // ============================================================
    describe('catch String(e) — error non-Error (L203)', () => {

        test('handleGetTaskTree reject avec une string brute → message non-Error', async () => {
            // Reject avec une valeur non-Error → `error instanceof Error` = false
            // → errorMessage = 'Erreur inconnue' via String(e)... Actually le code fait
            // `const errorMessage = error instanceof Error ? error.message : 'Erreur inconnue';`
            // Donc une string rejetée → 'Erreur inconnue'.
            mockHandleGetTaskTree.mockRejectedValue('raw string failure');

            const result = await handleExportTaskTreeMarkdown(
                baseArgs,
                mockHandleGetTaskTree,
                mockEnsureFresh
            );

            expect(result.isError).toBe(true);
            const text = (result.content[0] as any).text;
            // Branche non-Error → 'Erreur inconnue'
            expect(text).toContain('Erreur inconnue');
        });

        test('handleGetTaskTree reject avec un nombre → branche non-Error', async () => {
            mockHandleGetTaskTree.mockRejectedValue(42);

            const result = await handleExportTaskTreeMarkdown(
                baseArgs,
                mockHandleGetTaskTree,
                mockEnsureFresh
            );

            expect(result.isError).toBe(true);
            expect((result.content[0] as any).text).toContain('Erreur inconnue');
        });
    });

    // ============================================================
    // Garde-fou non-régression : path string normal réussit
    // ============================================================
    test('content[0].text string normal → export réussit (non-régression)', async () => {
        mockHandleGetTaskTree.mockResolvedValue({
            content: [{ type: 'text', text: '## Tree\n└── node' }],
        });

        const result = await handleExportTaskTreeMarkdown(
            baseArgs,
            mockHandleGetTaskTree,
            mockEnsureFresh
        );

        expect(result.isError).toBeUndefined();
        expect((result.content[0] as any).text).toContain('## Tree');
    });
});
