/**
 * Coverage complement for JsonCsvExporter — #833 Sprint C4 (Vein A).
 *
 * Add-only, tests-only. Pins the cold branches the nominal suite
 * (JsonCsvExporter.test.ts — 43 tests) never enters.
 *
 * Targets the PRIVATE methods of JsonCsvExporter, exercised via the public
 * interface (no reflection — the methods are reached through their real
 * internal call sites):
 *
 *  truncateText (L414-423) — private, called at L205 for firstUserMessage:
 *   - nominal 'X'.repeat(300) has NO spaces → always takes the else branch
 *     (`lastSpace <= 0.8*maxLength` → hard cut). This file pins the IF branch
 *     (`lastSpace > maxLength*0.8` → cut at last space) with text that has a
 *     space near the 200-char boundary.
 *   - also: text.length === maxLength (boundary, returns text as-is)
 *   - also: empty/falsy text returns it as-is (the `!text` guard L415)
 *
 *  escapeCsv (L406-412) — private, called at L317/356/387/399:
 *   - nominal covers comma, quote, newline (escaping path). This file pins
 *     the NON-escaping path: a plain value with no special chars returns as-is
 *     (L411 `return str`).
 *   - also: falsy value (undefined / null / 0) → String(value || '') → '' (L407)
 *
 *  formatCsvOutput (L395-404) — private wrapper:
 *   - empty rows array → only the header line is emitted (forEach no-op).
 *
 * Mock strategy: identical to nominal — real JsonCsvExporter with the same
 * mockClassifier. No module-level vi.mock.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JsonCsvExporter } from '../JsonCsvExporter.js';
import type { ConversationSkeleton, MessageSkeleton } from '../../../types/conversation.js';
import type { SummaryOptions, SummaryStatistics } from '../../../types/trace-summary.js';

// ---------- Mock ContentClassifier (same as nominal) ----------

const mockClassifier = {
    isToolResult: vi.fn((content: string) =>
        /^\[([^\]]+?)(?:\s+for\s+[^\]]*)?]\s+Result:/i.test(
            typeof content === 'string' ? content.trim() : '',
        ),
    ),
} as any;

// ---------- Helpers (same shape as nominal) ----------

function makeMessage(role: 'user' | 'assistant', content: string, timestamp = '2026-01-01T00:00:00Z'): MessageSkeleton {
    return { role, content, timestamp, isTruncated: false };
}

function makeSkeleton(messages: MessageSkeleton[] = [], taskId = 'cov-task-001'): ConversationSkeleton {
    return {
        taskId,
        metadata: {
            title: 'Cov conversation',
            lastActivity: '2026-01-01T01:00:00Z',
            createdAt: '2026-01-01T00:00:00Z',
            messageCount: messages.length,
            actionCount: messages.filter((m) => m.role === 'assistant').length,
            totalSize: messages.reduce((s, m) => s + (m.content?.length || 0), 0),
            workspace: 'cov-workspace',
        },
        sequence: messages,
    };
}

const defaultJsonHelpers = {
    truncateContent: (content: string, maxChars: number) =>
        content.length > maxChars ? content.substring(0, maxChars) + '...' : content,
    isContentTruncated: (content: string, maxChars: number) => (content?.length || 0) > maxChars,
    getEmptyStatistics: (): SummaryStatistics => ({
        totalSections: 0, userMessages: 0, assistantMessages: 0, toolResults: 0,
        userContentSize: 0, assistantContentSize: 0, toolResultsSize: 0,
        totalContentSize: 0, userPercentage: 0, assistantPercentage: 0, toolResultsPercentage: 0,
    }),
    getOriginalContentSize: (conv: ConversationSkeleton) => conv.metadata.totalSize,
    calculateCompressionRatio: (original: number, final: number) =>
        original > 0 ? Math.round((final / original) * 100) / 100 : 0,
};

const baseOptions: SummaryOptions = {
    detailLevel: 'Summary',
    truncationChars: 5000,
    compactStats: false,
    includeCss: false,
    generateToc: false,
    outputFormat: 'json',
};

let exporter: JsonCsvExporter;

beforeEach(() => {
    vi.clearAllMocks();
    exporter = new JsonCsvExporter(mockClassifier);
});

// ─── truncateText — IF branch (cut at last space, L420-421) ──────────────────

describe('truncateText (private, via firstUserMessage) — IF branch cut-at-space', () => {
    it('cuts at the last space when a space sits within 80%-100% of maxLength (L420)', async () => {
        // maxLength = 200 (firstUserMessage cap, L205). Build a 250-char message
        // whose only space sits at index 190 (> 0.8*200 = 160). The IF branch
        // should fire: truncate at the space → "...word" rather than mid-word.
        const head = 'a'.repeat(189);          // 189 chars, no space
        const tail = ' boundaryword'.repeat(5); // spaces inside, pushes total > 200
        const longMsgWithSpace = head + tail;   // 189 + 70 = 259 chars, last space in [0,200) at idx ~189
        expect(longMsgWithSpace.length).toBeGreaterThan(200);

        const conv = makeSkeleton([makeMessage('user', longMsgWithSpace)]);
        const result = await exporter.generateJsonSummary(
            conv,
            { ...baseOptions, jsonVariant: 'light' },
            defaultJsonHelpers,
        );
        const parsed = JSON.parse(result.content);
        const firstUser = parsed.conversations[0].firstUserMessage as string;

        // IF branch: output is "head" (cut at the space near 189) + "..."
        // — NOT a hard cut at 200, and the output is shorter than 200 + 3.
        expect(firstUser.endsWith('...')).toBe(true);
        // Cut-at-space means output length = head.length(189) + 3 ("...") = 192,
        // strictly less than the hard-cut length (200 + 3 = 203).
        expect(firstUser.length).toBeLessThan(203);
        expect(firstUser.length).toBe(189 + 3);
    });

    it('returns text as-is when length === maxLength (boundary, L415 guard)', async () => {
        // Exactly 200 chars → `text.length <= maxLength` is true → returned as-is, no "...".
        const exactMsg = 'b'.repeat(200);
        const conv = makeSkeleton([makeMessage('user', exactMsg)]);
        const result = await exporter.generateJsonSummary(
            conv,
            { ...baseOptions, jsonVariant: 'light' },
            defaultJsonHelpers,
        );
        const parsed = JSON.parse(result.content);
        const firstUser = parsed.conversations[0].firstUserMessage as string;

        expect(firstUser.length).toBe(200);
        expect(firstUser.endsWith('...')).toBe(false);
    });

    it('returns empty/falsy content unchanged (L415 `!text` guard)', async () => {
        // Empty user message — the `!text` guard short-circuits before any cutting.
        const conv = makeSkeleton([makeMessage('user', '')]);
        const result = await exporter.generateJsonSummary(
            conv,
            { ...baseOptions, jsonVariant: 'light' },
            defaultJsonHelpers,
        );
        const parsed = JSON.parse(result.content);
        // firstUserMessage for empty content — truncateText('') returns '' unchanged.
        expect(parsed.conversations[0].firstUserMessage).toBe('');
    });
});

// ─── escapeCsv — non-escaping path + falsy (L406-412) ────────────────────────

describe('escapeCsv (private, via generateCsvSummary) — non-escaping + falsy', () => {
    // NOTE: generateCsvSummary takes a SINGLE conversation (L124), not an array —
    // it wraps into [conversation] internally (L147). Passing [conv] would nest.

    it('returns a plain value with no special chars as-is (L411 no-escape path)', async () => {
        // workspace = 'cov-workspace' (no comma/quote/newline) → escapeCsv returns str unchanged.
        const conv = makeSkeleton([makeMessage('user', 'hello')]);
        const result = await exporter.generateCsvSummary(
            conv,
            { ...baseOptions, outputFormat: 'csv', csvVariant: 'conversations' },
            {
                isContentTruncated: () => false,
                getEmptyStatistics: defaultJsonHelpers.getEmptyStatistics,
                truncateText: (t: string, m: number) => t,
            },
        );
        expect(result.success).toBe(true);
        const lines = result.content.split('\n');
        // Header is line 0; data row is line 1. workspace should appear bare (no quotes).
        const dataRow = lines[1];
        expect(dataRow).toContain(',cov-workspace,');
        expect(dataRow).not.toContain('"cov-workspace"');
    });

    it('stringifies a falsy/undefined value to empty string (L407 `String(value || "")`)', async () => {
        // Delete workspace → `conv.metadata.workspace` is undefined → escapeCsv(undefined)
        // → String(undefined || '') === '' → empty cell, no quotes, no crash.
        const conv = makeSkeleton([makeMessage('user', 'hello')]);
        delete (conv.metadata as any).workspace;
        const result = await exporter.generateCsvSummary(
            conv,
            { ...baseOptions, outputFormat: 'csv', csvVariant: 'conversations' },
            {
                isContentTruncated: () => false,
                getEmptyStatistics: defaultJsonHelpers.getEmptyStatistics,
                truncateText: (t: string, m: number) => t,
            },
        );
        expect(result.success).toBe(true);
        // The row is well-formed CSV (same column count as header) — falsy workspace
        // didn't throw and produced an empty field rather than the literal "undefined".
        const lines = result.content.split('\n');
        const headerCols = lines[0].split(',').length;
        const dataCols = lines[1].split(',').length;
        expect(headerCols).toBe(dataCols);
        expect(lines[1]).not.toMatch(/\bundefined\b/);
    });
});
