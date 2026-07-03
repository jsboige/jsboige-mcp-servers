/**
 * #833 Sprint C3 — TraceSummaryService branch coverage (po-2026 lane `src/services/**`)
 *
 * The base `TraceSummaryService.test.ts` (35 tests) covers the public API thoroughly —
 * markdown/html delegation, JSON light/full, CSV conversations/messages/tools, cluster
 * summary validation/sort/modes, and error handling. It leaves a focused set of branches
 * cold, all pinned here against source lines of `TraceSummaryService.ts`.
 *
 * REACHABLE HELPERS (passed as callbacks to the real JsonCsvExporter — branches needing
 * specific input shapes the base suite never provides):
 * - `truncateContent` L545-549: the truncation arm (`maxChars > 0 && content.length > maxChars`).
 *   Base uses `truncationChars: 0` (mergeWithDefaultOptions L627 default) → always early-returns
 *   at L551, never producing the `[TRUNCATED N chars]` marker.
 * - `isContentTruncated` L558: the TRUE arm (`maxChars > 0 && content.length > maxChars`). Base
 *   maxChars=0 → always false. The false-arm-with-maxChars>0 is likewise cold.
 * - `truncateText` L564-573: the truncation path (text longer than maxLength), BOTH arms —
 *   word-boundary (L570 true, `lastSpace > maxLength * 0.8`) and hard-cut (L570 false). Base
 *   firstUserMessage ("Hello world", 11 chars) < 200 → early-returns at L565. The empty-text arm
 *   (`!text`, L565) is also cold — extractFirstUserMessage returns '' only when no user msg exists.
 * - `mergeWithDefaultOptions` L624-643: a cluster of explicit-value arms never exercised —
 *   `enableDetailLevels: false` (L635 `!== false`), `includeCss: false` (L629), `generateToc: false`
 *   (L630), `hideEnvironmentDetails: false` (L639), explicit `tocStyle` override (L638), non-default
 *   `detailLevel` (L626), `compactStats: true` (L628), `startIndex`/`endIndex` pass-through (L640-641).
 *   Base calls always take the `||`/`!== undefined` defaults.
 * - `calculateCompressionRatio` L649-651: the `: 1` fallback (`finalSize === 0`). Every success path
 *   yields non-empty content → `finalSize > 0` → the round arm; the zero-size arm is unreachable
 *   through nominal output.
 * - `getOriginalContentSize` L656-661: empty-sequence reduction (returns 0). Base always has 4 msgs.
 *
 * DEAD CODE (skip-with-evidence — orphaned duplicates, intentionally NOT covered):
 * The private JSON/CSV generation methods — `generateJsonSummary` (L169), `generateCsvSummary`
 * (L244), and their callees `calculateJsonLightSummary`/`convertToJsonSkeleton`/
 * `extractFirstUserMessage`/`convertToJsonMessages`/`extractToolCallsFromMessage`/
 * `generateCsvConversations`/`generateCsvMessages`/`generateCsvTools`/`formatCsvOutput`/
 * `escapeCsv`/`calculateJsonStatistics` — are **orphaned duplicates** of `JsonCsvExporter`
 * (`trace-summary/JsonCsvExporter.ts` L43-429 owns the LIVE copies). `generateSummary` delegates
 * to `this.jsonCsvExporter.*` (L113/L121); `this.generateJsonSummary` / `this.generateCsvSummary`
 * are never invoked (grep of `this.generateJsonSummary(` / `this.generateCsvSummary(` = 0 call
 * sites). Covering them via `(service as any).privateMethod()` would exercise orphaned code — an
 * anti-pattern. Documented as a skip for a future cleanup (deletion is out of C3 lane scope;
 * `.claude/rules/no-deletion-without-proof.md` applies).
 *
 * NOTE on direct private invocation: the LIVE helpers (`mergeWithDefaultOptions`,
 * `truncateContent`, `truncateText`, `calculateCompressionRatio`, `getOriginalContentSize`,
 * `getEmptyStatistics`) are all reached by the public API (`generateSummary` L108 merges; the
 * JSON/CSV callback injection L114-124 wires the rest). Their return values are not directly
 * observable through `generateSummary` output for most branches, so direct call is the pragmatic
 * path to pin each arm. This is distinct from the dead-code case above (those are never called at
 * all). Mock setup mirrors the base suite so the real JsonCsvExporter drives the callback paths.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { ConversationSkeleton, MessageSkeleton } from '../../types/conversation.js';

// ─────────────────── mocks (mirror base suite — real JsonCsvExporter/ClusterSummaryService) ───────────────────

const mockGenerateSummaryFn = vi.fn();
const mockCalculateStatisticsFn = vi.fn();

vi.mock('../trace-summary/SummaryGenerator.js', () => ({
    SummaryGenerator: class {
        generateSummary = (...args: any[]) => mockGenerateSummaryFn(...args);
        calculateStatistics = (...args: any[]) => mockCalculateStatisticsFn(...args);
    },
}));

const mockClassifyContentFn = vi.fn();
const mockIsToolResultFn = vi.fn();

vi.mock('../trace-summary/ContentClassifier.js', () => ({
    ContentClassifier: class {
        classifyContentFromMarkdownOrJson = (...args: any[]) => mockClassifyContentFn(...args);
        isToolResult = (...args: any[]) => mockIsToolResultFn(...args);
    },
}));

vi.mock('../ExportConfigManager.js', () => ({
    ExportConfigManager: class {
        getConfig = vi.fn().mockResolvedValue({});
    },
}));

vi.mock('../trace-summary/ExportRenderer.js', () => ({
    sanitizeSectionHtml: (html: string) => html,
}));

import { TraceSummaryService } from '../TraceSummaryService.js';

// ─────────────────── helpers ───────────────────

const makeMessage = (role: 'user' | 'assistant', content: string): MessageSkeleton => ({
    role,
    content,
    timestamp: new Date().toISOString(),
    isTruncated: false,
});

const makeSkeleton = (taskId: string, sequence: MessageSkeleton[] = []): ConversationSkeleton => ({
    taskId,
    parentTaskId: undefined,
    metadata: {
        title: `Task ${taskId}`,
        lastActivity: '2026-01-15T10:00:00Z',
        createdAt: '2026-01-15T09:00:00Z',
        messageCount: sequence.length || 4,
        actionCount: 2,
        totalSize: 5000,
        workspace: '/test/workspace',
    },
    sequence,
});

// ─────────────────── setup ───────────────────

let service: TraceSummaryService;

beforeEach(() => {
    vi.clearAllMocks();
    const mockConfigManager = { getConfig: vi.fn().mockResolvedValue({}) } as any;
    service = new TraceSummaryService(mockConfigManager);

    mockGenerateSummaryFn.mockResolvedValue({
        success: true,
        content: '# Summary',
        statistics: { totalSections: 1 },
    });
    mockCalculateStatisticsFn.mockReturnValue({ totalSections: 1 });
    mockClassifyContentFn.mockResolvedValue([]);
    mockIsToolResultFn.mockImplementation((content: string) =>
        content.includes('[') && content.includes('Result:')
    );
});

describe('TraceSummaryService — branch coverage (#833 C3, source-grounded)', () => {

    // ============================================================
    // truncateContent — truncation arm (L545-549) via JSON full + truncationChars
    // ============================================================
    describe('truncateContent — truncation arm (L545-549)', () => {
        test('produces the [TRUNCATED N chars] marker when maxChars>0 and content exceeds it (L545-549)', async () => {
            // Long user message (80 chars) + truncationChars:50 → exporter L246 invokes the
            // truncateContent callback → L545 arm fires (50>0 && 80>50).
            const longContent = 'x'.repeat(80);
            const conv = makeSkeleton('trunc-001', [
                makeMessage('user', longContent),
                makeMessage('assistant', 'hi'),
            ]);

            const result = await service.generateSummary(conv, {
                outputFormat: 'json',
                jsonVariant: 'full',
                truncationChars: 50,
            });

            expect(result.success).toBe(true);
            const parsed = JSON.parse(result.content);
            const longMsg = parsed.task.messages.find((m: any) => m.role === 'user');
            // L548 marker: `... [TRUNCATED ${content.length - maxChars} chars] ...` = 80-50 = 30.
            expect(longMsg.content).toContain('[TRUNCATED 30 chars]');
            // L547/L549: head + tail preserved (halfLength = floor(50/2) = 25).
            expect(longMsg.content.startsWith('x'.repeat(25))).toBe(true);
            expect(longMsg.content.endsWith('x'.repeat(25))).toBe(true);
        });
    });

    // ============================================================
    // isContentTruncated — TRUE arm + false-with-maxChars>0 (L558)
    // ============================================================
    describe('isContentTruncated — L558 arms', () => {
        test('returns TRUE for a message exceeding truncationChars (L558 true arm)', async () => {
            const conv = makeSkeleton('trunc-002', [
                makeMessage('user', 'y'.repeat(80)),
                makeMessage('assistant', 'hi'),
            ]);

            const result = await service.generateSummary(conv, {
                outputFormat: 'json',
                jsonVariant: 'full',
                truncationChars: 50,
            });

            const parsed = JSON.parse(result.content);
            const longMsg = parsed.task.messages.find((m: any) => m.role === 'user');
            const shortMsg = parsed.task.messages.find((m: any) => m.role === 'assistant');
            // L558 true: 50>0 && 80>50 → true.
            expect(longMsg.isTruncated).toBe(true);
            // L558 false (with maxChars>0): 50>0 && 'hi'.length(2)>50 → false. Base only ever
            // exercised this with maxChars=0; this pins the maxChars>0 && short-content arm.
            expect(shortMsg.isTruncated).toBe(false);
        });
    });

    // ============================================================
    // truncateText — all four arms (L565, L570 true, L570 false, L565 !text)
    // ============================================================
    describe('truncateText — branch arms (L564-573)', () => {
        test('early-returns the empty string unchanged (L565 !text arm)', () => {
            // extractFirstUserMessage returns '' when no user message exists → this arm. Base
            // always had a user message, so '' was never passed.
            expect((service as any).truncateText('', 200)).toBe('');
        });

        test('early-returns short text unchanged (L565 length<=maxLength arm)', () => {
            expect((service as any).truncateText('short text', 200)).toBe('short text');
        });

        test('word-boundary arm: truncates at the last space when one sits in the final 20% (L570 true)', () => {
            // 250 chars of "word " (5-char token). maxLength=200 → truncated = first 200 chars;
            // lastSpace within = 199 (space of the 40th token); 199 > 200*0.8 (160) → true →
            // substring(0, lastSpace) + '...' (L571). substring(0,199) EXCLUDES the space → result
            // ends with 'd...' and has length 199 + 3 = 202 (vs hard-cut's 203).
            const text = 'word '.repeat(50); // 250 chars
            const out = (service as any).truncateText(text, 200);

            expect(out.endsWith('...')).toBe(true);
            expect(out.length).toBeLessThan(text.length);
            // Word-boundary arm length = lastSpace(199) + '...'(3) = 202. Pins the cut position
            // and distinguishes it from the hard-cut arm (203).
            expect(out.length).toBe(202);
            // The char before '...' is the 'd' closing the last intact token (space at 199 dropped).
            expect(out.endsWith('d...')).toBe(true);
        });

        test('hard-cut arm: cuts at exactly maxLength when no space exists in the final 20% (L570 false)', () => {
            // 250 'x' (no spaces) → lastIndexOf(' ') = -1; -1 > 160 → false → truncated + '...' (L572).
            const text = 'x'.repeat(250);
            const out = (service as any).truncateText(text, 200);

            expect(out).toBe('x'.repeat(200) + '...');
        });
    });

    // ============================================================
    // mergeWithDefaultOptions — default + explicit-override arms (L624-643)
    // ============================================================
    describe('mergeWithDefaultOptions — branch arms (L624-643)', () => {
        test('applies every default when options is empty (L626-641 default arms)', () => {
            const merged = (service as any).mergeWithDefaultOptions({});

            // L626 detailLevel || 'Full'
            expect(merged.detailLevel).toBe('Full');
            // L627 truncationChars || 0
            expect(merged.truncationChars).toBe(0);
            // L628 compactStats || false
            expect(merged.compactStats).toBe(false);
            // L629 includeCss !== undefined ? ... : true → undefined arm → true
            expect(merged.includeCss).toBe(true);
            // L630 generateToc !== undefined ? ... : true → undefined arm → true
            expect(merged.generateToc).toBe(true);
            // L631 outputFormat || 'markdown'
            expect(merged.outputFormat).toBe('markdown');
            // L635 enableDetailLevels !== false → true
            expect(merged.enableDetailLevels).toBe(true);
            // L638 tocStyle || (outputFormat==='html'?'html':'markdown') → 'markdown'
            expect(merged.tocStyle).toBe('markdown');
            // L639 hideEnvironmentDetails !== undefined ? ... : true → true
            expect(merged.hideEnvironmentDetails).toBe(true);
            // L640/L641 startIndex/endIndex undefined pass-through
            expect(merged.startIndex).toBeUndefined();
            expect(merged.endIndex).toBeUndefined();
        });

        test('honors explicit overrides for every overridable field (L626,628,629,630,635,639,640,641)', () => {
            const merged = (service as any).mergeWithDefaultOptions({
                detailLevel: 'compact',        // L626 provided arm
                truncationChars: 100,          // L627 provided arm
                compactStats: true,            // L628 provided arm
                includeCss: false,             // L629 defined arm (!== undefined)
                generateToc: false,            // L630 defined arm
                enableDetailLevels: false,     // L635 === false arm
                hideEnvironmentDetails: false, // L639 defined arm
                startIndex: 5,                 // L640 provided arm
                endIndex: 10,                  // L641 provided arm
            });

            expect(merged.detailLevel).toBe('compact');
            expect(merged.truncationChars).toBe(100);
            expect(merged.compactStats).toBe(true);
            expect(merged.includeCss).toBe(false);
            expect(merged.generateToc).toBe(false);
            expect(merged.enableDetailLevels).toBe(false);
            expect(merged.hideEnvironmentDetails).toBe(false);
            expect(merged.startIndex).toBe(5);
            expect(merged.endIndex).toBe(10);
        });

        test('infers tocStyle=html from outputFormat when tocStyle is absent (L638 html arm)', () => {
            const merged = (service as any).mergeWithDefaultOptions({ outputFormat: 'html' });
            expect(merged.tocStyle).toBe('html');
        });

        test('explicit tocStyle overrides the outputFormat inference (L638 options.tocStyle || …)', () => {
            // options.tocStyle truthy → the `||` short-circuits before the html/markdown inference.
            const merged = (service as any).mergeWithDefaultOptions({
                outputFormat: 'html',
                tocStyle: 'markdown',
            });
            expect(merged.tocStyle).toBe('markdown');
        });
    });

    // ============================================================
    // calculateCompressionRatio — `: 1` zero-finalSize fallback (L651)
    // ============================================================
    describe('calculateCompressionRatio — fallback arm (L649-651)', () => {
        test('returns 1 when finalSize is 0 (L651 `: 1` fallback)', () => {
            // finalSize === 0 → ternary false arm. Unreachable via nominal output (success paths
            // always produce non-empty content), so direct call is the only way to pin it.
            expect((service as any).calculateCompressionRatio(100, 0)).toBe(1);
        });

        test('rounds the ratio to 2 decimals when finalSize > 0 (L650 round arm)', () => {
            // round((originalSize/finalSize)*100)/100. Pins the live round arm (warm via success
            // paths, but asserts the rounding contract directly).
            // 200/50 = 4 → round(400)/100 = 4.
            expect((service as any).calculateCompressionRatio(200, 50)).toBe(4);
            // 100/3 = 33.333… → round(3333.33)/100 = 3333/100 = 33.33 (the trailing /100 applies
            // AFTER round, so the 2-decimal precision is preserved, not floored).
            expect((service as any).calculateCompressionRatio(100, 3)).toBe(33.33);
        });
    });

    // ============================================================
    // getOriginalContentSize — empty-sequence reduction (L656-661)
    // ============================================================
    describe('getOriginalContentSize — empty/non-empty sequence (L656-661)', () => {
        test('returns 0 for a conversation with no message sequence (L657 ?? [] + reduce)', () => {
            // sequence undefined → (sequence ?? []) = [] → reduce initial 0. Base always had 4 msgs.
            expect((service as any).getOriginalContentSize({ sequence: undefined } as any)).toBe(0);
            expect((service as any).getOriginalContentSize({ sequence: [] } as any)).toBe(0);
        });

        test('sums content lengths across role/content messages (L660 reduce)', () => {
            const conv = {
                sequence: [
                    makeMessage('user', 'hello'),     // 5
                    makeMessage('assistant', 'world!'), // 6
                ],
            } as any;
            expect((service as any).getOriginalContentSize(conv)).toBe(11);
        });
    });

    // ============================================================
    // getEmptyStatistics — shape contract (L666-680)
    // ============================================================
    describe('getEmptyStatistics — zeroed shape (L666-680)', () => {
        test('returns a fully-zeroed SummaryStatistics object (L667-679)', () => {
            // Live private invoked by every error path (generateSummary catch L137, generateJson
            // catch L235, etc.). Pin the exact zeroed shape so a future field addition cannot
            // silently leave the error-path statistics partial.
            const stats = (service as any).getEmptyStatistics();
            expect(stats).toEqual({
                totalSections: 0,
                userMessages: 0,
                assistantMessages: 0,
                toolResults: 0,
                userContentSize: 0,
                assistantContentSize: 0,
                toolResultsSize: 0,
                totalContentSize: 0,
                userPercentage: 0,
                assistantPercentage: 0,
                toolResultsPercentage: 0,
            });
        });
    });

    // ============================================================
    // DEAD CODE — private JSON/CSV methods orphaned by JsonCsvExporter refactor
    // ============================================================
    describe('PRIVATE JSON/CSV methods — dead code (skip-with-evidence)', () => {
        test.skip(
            'generateJsonSummary (L169), generateCsvSummary (L244) + their 11 private callees ' +
            'are orphaned duplicates of JsonCsvExporter (trace-summary/JsonCsvExporter.ts L43-429) — ' +
            'generateSummary delegates to this.jsonCsvExporter.* (L113/L121); grep of ' +
            '`this.generateJsonSummary(`/`this.generateCsvSummary(` = 0 call sites. Not covered: ' +
            'reaching them via (service as any).privateMethod() would exercise orphaned code ' +
            '(anti-pattern). Documented for a future cleanup; deletion out of C3 lane scope.',
            () => {
                /* skip-with-evidence — see header + this description for the dead-code proof. */
            }
        );
    });
});
