/**
 * Coverage tests for handleDebugTaskParsing
 *
 * Cible les branches NON couvertes par les 3 fichiers de test existants
 * (debug-parsing.test.ts 34 tests, debug-parsing.tool.test.ts 12 tests,
 * debug-parsing.integration.test.ts 6 tests = 52 tests).
 *
 * **Gap fresh measure (94.01% stmts / 91.3% branch)** :
 *  - L52-57 : garde path-traversal (`..` / `/` / `\\`). Les tests existants
 *    n'utilisent QUE des UUID valides → les 2 gardes de sécurité sont jamais
 *    déclenchés (c'est la majeure partie du stmt gap).
 *  - L61-66 : garde format UUID invalide.
 *  - L181 : branche markdown `api_history_exists ? 'EXISTS' : 'MISSING'` (MISSING).
 *  - L188 : boucle `tag_details` dans le format markdown (tags présents).
 *  - L217/L219 : error handler `error?.message || 'Unknown error'` (json + markdown).
 *
 * Pattern C3 (Vein D, dispatch #2800) : 1 fichier = 1 PR.
 *
 * @module tools/task/__tests__/debug-parsing.coverage
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const mockDetectStorageLocations = vi.fn();
const mockAnalyzeConversation = vi.fn();
const mockReadFile = vi.fn();
const mockExistsSync = vi.fn();

vi.mock('../../../utils/roo-storage-detector.js', () => ({
    RooStorageDetector: {
        detectStorageLocations: mockDetectStorageLocations,
        analyzeConversation: mockAnalyzeConversation,
    },
}));

vi.mock('fs', () => ({
    promises: {
        readFile: mockReadFile,
    },
    existsSync: mockExistsSync,
}));

describe('debug-parsing.tool — coverage branches', () => {
    let handleDebugTaskParsing: typeof import('../debug-parsing.tool.js').handleDebugTaskParsing;

    beforeEach(async () => {
        vi.clearAllMocks();
        const mod = await import('../debug-parsing.tool.js');
        handleDebugTaskParsing = mod.handleDebugTaskParsing;

        // Default: UUID dir exists, ui_messages + api_history exist
        const VALID_UUID = 'a1b2c3d4-e5f6-4a8b-9c0d-1e2f3a4b5c6d';
        mockExistsSync.mockImplementation((p: string) =>
            typeof p === 'string' && p.includes(VALID_UUID)
        );
        mockDetectStorageLocations.mockResolvedValue(['/mock/storage']);
        mockAnalyzeConversation.mockResolvedValue({
            taskId: VALID_UUID,
            parentTaskId: 'parent-uuid-here',
            truncatedInstruction: 'instruction preview',
            childTaskInstructionPrefixes: ['pref1', 'pref2'],
        });
        mockReadFile.mockResolvedValue(JSON.stringify([
            { role: 'user', content: 'hello' },
        ]));
    });

    // ============================================================
    // Garde path traversal (L52-57)
    // ============================================================
    describe('path-traversal guard (L52-57)', () => {

        test('task_id avec ".." → throw INVALID_ARGUMENT', async () => {
            await expect(
                handleDebugTaskParsing({ task_id: '../etc/passwd' })
            ).rejects.toThrow(/path separators|parent directory/i);
        });

        test('task_id avec "/" → throw INVALID_ARGUMENT', async () => {
            await expect(
                handleDebugTaskParsing({ task_id: 'foo/bar' })
            ).rejects.toThrow(/path separators|parent directory/i);
        });

        test('task_id avec "\\" → throw INVALID_ARGUMENT', async () => {
            await expect(
                handleDebugTaskParsing({ task_id: 'foo\\bar' })
            ).rejects.toThrow(/path separators|parent directory/i);
        });
    });

    // ============================================================
    // Garde format UUID (L61-66)
    // ============================================================
    describe('UUID format guard (L61-66)', () => {

        test('task_id non-UUID (pas de path separator) → throw INVALID_ARGUMENT', async () => {
            // Pas de .., /, \\ mais format invalide → garde UUID
            await expect(
                handleDebugTaskParsing({ task_id: 'not-a-valid-id' })
            ).rejects.toThrow(/Invalid task_id format|Expected UUID/i);
        });

        test('task_id presque-UUID mais incomplet → throw', async () => {
            await expect(
                handleDebugTaskParsing({ task_id: 'a1b2c3d4-e5f6-4a8b-9c0d' })
            ).rejects.toThrow(/Expected UUID/i);
        });
    });

    // ============================================================
    // Markdown format — branches api_history MISSING + tag_details (L181, L188)
    // ============================================================
    describe('markdown format branches', () => {

        test('api_history MISSING (existsSync false pour api_history) → branche MISSING', async () => {
            const VALID_UUID = 'a1b2c3d4-e5f6-4a8b-9c0d-1e2f3a4b5c6d';
            // existsSync true pour le dir + ui_messages, mais FALSE pour api_history
            mockExistsSync.mockImplementation((p: string) => {
                if (typeof p !== 'string') return false;
                if (p.includes('api_conversation_history')) return false; // MISSING
                return p.includes(VALID_UUID);
            });

            const result = await handleDebugTaskParsing({ task_id: VALID_UUID });
            const text = (result.content[0] as any).text;
            expect(text).toContain('API History: MISSING');
        });

        test('markdown avec <task> + <new_task> tags → tag_details rendus (L188, L191, L194, L195)', async () => {
            const VALID_UUID = 'a1b2c3d4-e5f6-4a8b-9c0d-1e2f3a4b5c6d';
            mockReadFile.mockResolvedValue(JSON.stringify([
                {
                    role: 'user',
                    content: '<task>do something important here</task>',
                },
                {
                    role: 'assistant',
                    content: '<new_task>subtask creation</new_task>',
                },
            ]));

            const result = await handleDebugTaskParsing({ task_id: VALID_UUID });
            const text = (result.content[0] as any).text;
            // Format markdown rend les tags
            expect(text).toMatch(/<task> tags/i);
            expect(text).toContain('do something'); // preview substring(0,100)
            expect(text).toMatch(/<new_task> tags/i);
        });
    });

    // ============================================================
    // Error handler (L217 json / L219 markdown)
    // ============================================================
    describe('error handler branches (L217, L219)', () => {

        test('readFile lève une erreur → format json retourne {error} (L217)', async () => {
            const VALID_UUID = 'a1b2c3d4-e5f6-4a8b-9c0d-1e2f3a4b5c6d';
            mockReadFile.mockRejectedValue(new Error('disk read failed'));

            const result = await handleDebugTaskParsing({ task_id: VALID_UUID, format: 'json' });
            const parsed = JSON.parse((result.content[0] as any).text);
            expect(parsed.error).toBe('disk read failed');
            expect(parsed.task_id).toBe(VALID_UUID);
        });

        test('readFile lève une erreur sans message → format json "Unknown error" (L217 ||)', async () => {
            const VALID_UUID = 'a1b2c3d4-e5f6-4a8b-9c0d-1e2f3a4b5c6d';
            // Rejeter avec un objet Error-like sans .message → déclenche || 'Unknown error'
            mockReadFile.mockRejectedValue({ code: 'EIO' } as any);

            const result = await handleDebugTaskParsing({ task_id: VALID_UUID, format: 'json' });
            const parsed = JSON.parse((result.content[0] as any).text);
            expect(parsed.error).toBe('Unknown error');
        });

        test('readFile lève une erreur → format markdown "ERROR: ..." (L219)', async () => {
            const VALID_UUID = 'a1b2c3d4-e5f6-4a8b-9c0d-1e2f3a4b5c6d';
            mockReadFile.mockRejectedValue(new Error('parse boom'));

            const result = await handleDebugTaskParsing({ task_id: VALID_UUID }); // markdown default
            const text = (result.content[0] as any).text;
            expect(text).toContain('ERROR: parse boom');
        });

        test('readFile erreur sans message → format markdown "Unknown error" (L219 ||)', async () => {
            const VALID_UUID = 'a1b2c3d4-e5f6-4a8b-9c0d-1e2f3a4b5c6d';
            mockReadFile.mockRejectedValue({ code: 'EACCES' } as any); // pas de .message

            const result = await handleDebugTaskParsing({ task_id: VALID_UUID });
            const text = (result.content[0] as any).text;
            expect(text).toContain('ERROR: Unknown error');
        });
    });

    // ============================================================
    // Markdown format — boucle tag_details jamais itérée (L188, 0 tags)
    // ============================================================
    describe('markdown format — 0 tags (boucle L188 jamais itérée)', () => {
        test('ui_messages sans <task>/<new_task> tags → boucle tag_details vide', async () => {
            const VALID_UUID = 'a1b2c3d4-e5f6-4a8b-9c0d-1e2f3a4b5c6d';
            mockReadFile.mockResolvedValue(JSON.stringify([
                { role: 'user', content: 'just a plain message, no tags here' },
                { role: 'assistant', content: 'plain reply' },
            ]));

            const result = await handleDebugTaskParsing({ task_id: VALID_UUID });
            const text = (result.content[0] as any).text;
            // Le rendu markdown inclut les compteurs (a 0) mais n'itere pas tag_details
            expect(text).toContain('Task path:');
            expect(text).toMatch(/0/);
        });
    });
});
