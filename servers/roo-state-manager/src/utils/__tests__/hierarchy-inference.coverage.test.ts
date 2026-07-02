/**
 * hierarchy-inference.coverage.test.ts - Coverage complement for hierarchy-inference.ts
 *
 * Source-grounded targets (pre-PR baseline 93.02% lines / 86.36% branches / 100% funcs):
 *
 * REACHABLE cold arms covered below:
 * - L44: data?.messages || [] arm (data is object WITHOUT messages key)
 * - L55: ?.text || '' empty-string fallback (content array has NO type='text' parts)
 * - L77: data?.messages || [] arm (same as L44 in extractParentFromUiMessages)
 * - L83-85: firstUserMessage?.content absent arm in extractParentFromUiMessages
 *
 * UNREACHABLE branches (documented skip-with-evidence per #1936):
 * - L28-30: extractTaskIdFromText contextual-pattern loop
 *   All 3 contextual patterns at L20-22 require a v4 UUID ([0-9a-f]{4}-4[0-9a-f]{3}).
 *   But L10's v4 regex also requires v4 UUID. If text has v4 UUID → L13-15 fires
 *   first → returns the v4 UUID → L25-30 never reached. If text has no v4 UUID →
 *   L13-15 doesn't fire → L25-30 enters loop → but no contextual pattern can
 *   match either (they also require v4 UUIDs) → L27 truthy never triggers.
 *   GENUINELY UNREACHABLE without modifying source.
 *   Possible source fix: contextual patterns should accept v1-v5 UUIDs, OR the
 *   contextual patterns should fire BEFORE the v4 check. Out of scope here.
 * - L116-119: inferParentTaskIdFromContent outer catch
 *   Both inner fns (extractParentFromApiHistory, extractParentFromUiMessages)
 *   have their own try/catch returning undefined. The `rawMetadata` parameter
 *   is declared but UNUSED. No sync code path can throw (process.stderr.write
 *   is non-throwing in practice, regex.match doesn't throw). GENUINELY
 *   UNREACHABLE without modifying source.
 *
 * Discipline:
 * - 0 source touched (add-only)
 * - Reuses established hoisted mock pattern (mockReadFile via vi.hoisted)
 * - Each reachable test names its source line anchor (anti-churn #1936)
 * - 2 unreachable branches documented via test.skip with source-grounded evidence
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Reuse existing mock setup pattern (hoisted fs/promises mock)
const { mockReadFile } = vi.hoisted(() => ({
    mockReadFile: vi.fn(),
}));
vi.mock('fs/promises', () => ({
    readFile: mockReadFile,
    default: { readFile: mockReadFile },
}));

import {
    extractTaskIdFromText,
    extractParentFromApiHistory,
    extractParentFromUiMessages,
    inferParentTaskIdFromContent,
} from '../hierarchy-inference.js';

describe('hierarchy-inference — coverage complement', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    });

    // ============================================================
    // SKIP-WITH-EVIDENCE: L25-30 unreachable-defensive
    // ============================================================

    describe('extractTaskIdFromText — contextual pattern loop (L25-30) SKIP-WITH-EVIDENCE', () => {
        it.skip('L27 truthy + L28-30: contextual-pattern capture-group branch is structurally unreachable', () => {
            // SKIP-WITH-EVIDENCE per anti-churn #1936:
            //
            // All 3 contextual patterns at L20-22 require a v4 UUID:
            //   /[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}/
            //
            // But the v4 regex at L10 also requires a v4 UUID.
            //
            // Case analysis:
            //   (A) Text contains v4 UUID → L11 match returns uuid(s) → L13-15 returns
            //       the first v4 UUID → L25-30 never reached.
            //   (B) Text contains NO v4 UUID → L11 match returns null → L13 false
            //       → L25-30 enters loop → but contextual patterns ALSO require v4
            //       UUIDs → no pattern matches → L27 truthy never fires.
            //
            // Therefore L25-30 is GENUINELY UNREACHABLE for any input text.
            //
            // Source design choice: the contextual patterns should probably accept
            // v1-v5 UUIDs (or fire BEFORE the v4 check). Modifying the source to
            // fix this is out of scope for an add-only coverage pass.
            //
            // Per no-deletion-without-proof: we DO NOT touch source. We document
            // the gap. If a future PR broadens the contextual regex to v1-v5,
            // these tests should be replaced with real assertions covering the
            // now-reachable branches.
            expect(true).toBe(true);
        });
    });

    // ============================================================
    // extractParentFromApiHistory — cold arms (L44, L55)
    // ============================================================

    describe('extractParentFromApiHistory — object-without-messages arm (L44)', () => {
        it('should return undefined when data is an object WITHOUT messages key (L44 falsy arm)', async () => {
            // L44: Array.isArray(data) ? data : (data?.messages || [])
            // Object without messages key → data?.messages is undefined → || [] → empty array
            // → messages.find returns undefined → returns undefined at L51
            const apiHistory = { someOtherKey: 'irrelevant' };
            mockReadFile.mockResolvedValue(JSON.stringify(apiHistory));

            const result = await extractParentFromApiHistory('/fake/path');
            expect(result).toBeUndefined();
        });

        it('should return undefined when data is null (L44 data?.messages cold path)', async () => {
            // data is null → data?.messages is undefined → || [] → empty array
            const apiHistory = null;
            mockReadFile.mockResolvedValue(JSON.stringify(apiHistory));

            const result = await extractParentFromApiHistory('/fake/path');
            expect(result).toBeUndefined();
        });
    });

    describe('extractParentFromApiHistory — content array without text parts (L55)', () => {
        it('should return undefined when content array has NO type=text part (L55 || "" arm)', async () => {
            // L55: firstUserMessage.content.find((c) => c.type === 'text')?.text || ''
            // Content array with only image parts → find returns undefined → '' → extractTaskIdFromText('') returns undefined
            const apiHistory = [
                {
                    role: 'user',
                    content: [
                        { type: 'image', data: 'base64data...' },
                        { type: 'tool_use', id: 'tool_123', name: 'some_tool', input: {} }
                    ]
                }
            ];
            mockReadFile.mockResolvedValue(JSON.stringify(apiHistory));

            const result = await extractParentFromApiHistory('/fake/path');
            // extractTaskIdFromText('') → undefined (covered by existing empty-string test)
            expect(result).toBeUndefined();
        });

        it('should return undefined when content array has empty text field (L55 truthy but empty)', async () => {
            // Edge case: type=text but text is empty string → finds it, text='' → extractTaskIdFromText('') → undefined
            const apiHistory = [
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: '' }
                    ]
                }
            ];
            mockReadFile.mockResolvedValue(JSON.stringify(apiHistory));

            const result = await extractParentFromApiHistory('/fake/path');
            expect(result).toBeUndefined();
        });
    });

    // ============================================================
    // extractParentFromUiMessages — cold arms (L77, L83-85)
    // ============================================================

    describe('extractParentFromUiMessages — object-without-messages arm (L77)', () => {
        it('should return undefined when data is an object WITHOUT messages key (L77 falsy arm)', async () => {
            // L77 mirrors L44 for extractParentFromUiMessages
            const uiMessages = { metadata: { version: '1.0' } };
            mockReadFile.mockResolvedValue(JSON.stringify(uiMessages));

            const result = await extractParentFromUiMessages('/fake/path');
            expect(result).toBeUndefined();
        });

        it('should return undefined when data is null (L77 data?.messages cold path)', async () => {
            const uiMessages = null;
            mockReadFile.mockResolvedValue(JSON.stringify(uiMessages));

            const result = await extractParentFromUiMessages('/fake/path');
            expect(result).toBeUndefined();
        });

        it('should return undefined when first user message has no content (L83-85)', async () => {
            // L83: if (!firstUserMessage?.content) return undefined
            const uiMessages = [
                { type: 'user' },  // no content field
                { type: 'assistant', content: 'response' }
            ];
            mockReadFile.mockResolvedValue(JSON.stringify(uiMessages));

            const result = await extractParentFromUiMessages('/fake/path');
            expect(result).toBeUndefined();
        });
    });

    // ============================================================
    // inferParentTaskIdFromContent — outer catch L116-119 SKIP-WITH-EVIDENCE
    // + happy-path short-circuit documentation (L109, L112)
    // ============================================================

    describe('inferParentTaskIdFromContent — outer catch (L116-119) SKIP-WITH-EVIDENCE', () => {
        it.skip('L116-119: outer catch is unreachable-defensive — SKIP-WITH-EVIDENCE', async () => {
            // SKIP-WITH-EVIDENCE per anti-churn #1936:
            //
            // Both inner functions have their own try/catch:
            //   - extractParentFromApiHistory (L40-66) catches ALL errors and returns undefined
            //   - extractParentFromUiMessages (L73-95) catches ALL errors and returns undefined
            //
            // Additionally:
            //   - extractTaskIdFromText (L6-34) only does regex.match() — cannot throw
            //   - The `rawMetadata` parameter (L104) is DECLARED but UNUSED in the function body
            //   - No sync code path in the try block can throw (process.stderr.write is sync
            //     but its return type is non-throwing in practice)
            //
            // Therefore the outer catch at L116-119 is GENUINELY UNREACHABLE without source
            // modification. Possible source fixes:
            //   (a) Remove the try/catch (YAGNI — would require proof of intentionality)
            //   (b) Actually USE rawMetadata in the inference logic (out of scope for coverage)
            //
            // Per no-deletion-without-proof, we DO NOT touch source. We document the gap.
            // If a future PR adds rawMetadata-based logic that can throw, this test should
            // be replaced with a real assertion.
            expect(true).toBe(true);
        });

        it('should return undefined gracefully when inner functions return undefined (happy path documented)', async () => {
            // Both inner fns return undefined → returns undefined at L115
            // This is the normal "no parent found" path
            mockReadFile.mockResolvedValue(JSON.stringify([]));  // empty array for both
            const result = await inferParentTaskIdFromContent('/api/path', '/ui/path', {});
            expect(result).toBeUndefined();
        });

        it('should return parent from api history when found, without falling back to ui (L109 short-circuit)', async () => {
            // L109: if (parentId) return parentId; — confirms short-circuit
            const testUuid = '550e8400-e29b-41d4-a716-446655440000';
            // First readFile call (apiHistory) returns a match
            // Second readFile call (uiMessages) should NOT happen
            mockReadFile.mockResolvedValueOnce(JSON.stringify([
                { role: 'user', content: `Task ${testUuid} here` }
            ]));

            const result = await inferParentTaskIdFromContent('/api/path', '/ui/path', {});
            expect(result).toBe(testUuid);
            // uiMessages file should never have been read
            expect(mockReadFile).toHaveBeenCalledTimes(1);
        });

        it('should fall back to ui messages when api history returns undefined (L112 fallback)', async () => {
            // L112: parentId = await extractParentFromUiMessages(uiMessagesPath);
            const testUuid = 'abcdef01-2345-4678-9abc-def012345678';
            // First call (apiHistory) returns empty array (no parent)
            mockReadFile.mockResolvedValueOnce(JSON.stringify([]));
            // Second call (uiMessages) returns a match
            mockReadFile.mockResolvedValueOnce(JSON.stringify([
                { type: 'user', content: `Parent task ${testUuid} reference` }
            ]));

            const result = await inferParentTaskIdFromContent('/api/path', '/ui/path', {});
            expect(result).toBe(testUuid);
            expect(mockReadFile).toHaveBeenCalledTimes(2);
        });
    });

    // ============================================================
    // extractTaskIdFromText — happy path smoke (anchor for L11, L15)
    // ============================================================

    describe('extractTaskIdFromText — happy path smoke', () => {
        it('returns first v4 UUID found (L15 happy path)', () => {
            // Sanity anchor: confirms v4 regex early-return still works
            // after the add-only coverage pass
            const text = 'Random text with 550e8400-e29b-41d4-a716-446655440000 embedded';
            expect(extractTaskIdFromText(text)).toBe('550e8400-e29b-41d4-a716-446655440000');
        });
    });
});