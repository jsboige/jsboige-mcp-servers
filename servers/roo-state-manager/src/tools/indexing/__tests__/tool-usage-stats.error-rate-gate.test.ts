/**
 * Tests for the #3381 D2 error-rate gate in tool_usage_stats.
 *
 * Prescription (web1 c.355, triaged VALIDE-trivial in the #3381 §7.C triage):
 * no per-tool error rate may be published when the tool's call count on the
 * window is below MIN_CALLS_FOR_ERROR_RATE (30) — a rate on a tiny sample is
 * noise (1 errored call out of 7 publishes "57.1%"), and trend_report arrows
 * inherit the noise. Below the gate `error_rate` is null (rendered "n/a").
 *
 * @module tools/indexing/__tests__/tool-usage-stats.error-rate-gate
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const { mockDetectStorageLocations, mockHomedir, mockSharedStatePath } = vi.hoisted(() => ({
    mockDetectStorageLocations: vi.fn(),
    mockHomedir: { value: '' },
    mockSharedStatePath: { value: '' },
}));

vi.mock('../../../utils/roo-storage-detector.js', () => ({
    RooStorageDetector: {
        findConversationById: vi.fn(),
        detectStorageLocations: mockDetectStorageLocations,
    },
}));

vi.mock('../index-task.tool.js', () => ({
    indexTaskSemanticTool: { handler: vi.fn() },
}));

vi.mock('../reset-collection.tool.js', () => ({
    resetQdrantCollectionTool: { handler: vi.fn() },
}));

vi.mock('../diagnose-index.tool.js', () => ({
    handleDiagnoseSemanticIndex: vi.fn(),
}));

// Intercept os.homedir() so the Claude Code scan reads a controlled tmpdir
// instead of the real ~/.claude/projects (pattern: roosync-indexing.tool.actions.test.ts).
vi.mock('os', async (importOriginal) => {
    const mod = await importOriginal<typeof import('os')>();
    return {
        ...mod,
        homedir: () => mockHomedir.value || mod.homedir(),
        hostname: () => 'rsm-test-host',
    };
});

// Redirect save_snapshot / trend_report away from the real shared-state path.
vi.mock('../../../utils/shared-state-path.js', () => ({
    getSharedStatePath: () => mockSharedStatePath.value,
    tryGetSharedStatePath: () => mockSharedStatePath.value,
}));

import { handleRooSyncIndexing, MIN_CALLS_FOR_ERROR_RATE } from '../roosync-indexing.tool.js';

/**
 * Build a Claude Code session JSONL with `calls` tool_use blocks for one tool,
 * `errors` of them marked is_error on the matching tool_result blocks.
 * Timestamps are recent (inside the default 28-day window) so the scan sees them.
 */
function writeSessionFixture(dir: string, calls: number, errors: number, toolName = 'mcp__rsm__roosync_dashboard'): void {
    fs.mkdirSync(dir, { recursive: true });
    const lines: string[] = [];
    const ts = new Date(Date.now() - 3600_000).toISOString();
    for (let i = 0; i < calls; i++) {
        const id = `toolu_${i.toString().padStart(3, '0')}`;
        lines.push(JSON.stringify({
            type: 'assistant',
            message: { role: 'assistant', content: [{ type: 'tool_use', id, name: toolName, input: {} }] },
            timestamp: ts,
        }));
        lines.push(JSON.stringify({
            type: 'user',
            message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: i < errors }] },
            timestamp: ts,
        }));
    }
    fs.writeFileSync(path.join(dir, 'session.jsonl'), lines.join('\n') + '\n', 'utf-8');
}

describe('tool_usage_stats error-rate gate (#3381 D2)', () => {
    const cache = new Map();
    const ensureFresh = vi.fn().mockResolvedValue(true);
    const saveSkeleton = vi.fn();
    const setEnabled = vi.fn();
    const rebuildHandler = vi.fn();
    let tmpRoot: string;

    beforeEach(() => {
        vi.clearAllMocks();
        mockDetectStorageLocations.mockResolvedValue([]);
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'd2-gate-'));
        mockHomedir.value = tmpRoot;
        mockSharedStatePath.value = path.join(tmpRoot, 'shared');
    });

    afterEach(() => {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    test('MIN_CALLS_FOR_ERROR_RATE is 30 (the prescribed threshold)', () => {
        expect(MIN_CALLS_FOR_ERROR_RATE).toBe(30);
    });

    test('below the gate: error_rate is null even with errors (the 57% on 7 calls case)', async () => {
        const projDir = path.join(tmpRoot, '.claude', 'projects', 'd2-ws');
        writeSessionFixture(projDir, 7, 4);

        const result = await handleRooSyncIndexing(
            { action: 'tool_usage_stats' },
            cache, ensureFresh, saveSkeleton, new Set(), setEnabled, rebuildHandler,
        );

        expect(result.isError).toBe(false);
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.total_tool_calls).toBe(7);
        const row = parsed.tools[0];
        expect(row.tool_name).toBe('roosync_dashboard');
        expect(row.calls).toBe(7);
        expect(row.errors).toBe(4);
        expect(row.error_rate).toBeNull();
        // Untouched by the gate: retry_rate stays numeric (prescription names error rate only).
        expect(typeof row.retry_rate).toBe('number');
    });

    test('at the gate exactly (30 calls): error_rate is published', async () => {
        const projDir = path.join(tmpRoot, '.claude', 'projects', 'd2-ws');
        writeSessionFixture(projDir, 30, 3);

        const result = await handleRooSyncIndexing(
            { action: 'tool_usage_stats' },
            cache, ensureFresh, saveSkeleton, new Set(), setEnabled, rebuildHandler,
        );

        const parsed = JSON.parse(result.content[0].text);
        const row = parsed.tools[0];
        expect(row.calls).toBe(30);
        expect(row.error_rate).toBe(10);
    });

    test('above the gate: error_rate reflects actual errors', async () => {
        const projDir = path.join(tmpRoot, '.claude', 'projects', 'd2-ws');
        writeSessionFixture(projDir, 45, 9);

        const result = await handleRooSyncIndexing(
            { action: 'tool_usage_stats' },
            cache, ensureFresh, saveSkeleton, new Set(), setEnabled, rebuildHandler,
        );

        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.tools[0].error_rate).toBe(20);
    });

    test('trend_report renders null error_rate as n/a, never "null%"', async () => {
        // Two snapshots of the same machine; latest carries a null error_rate
        // (sub-threshold tool), previous a numeric one — the exact shape the
        // gate produces via save_snapshot recursion.
        const snapsDir = path.join(mockSharedStatePath.value, 'tool-usage-snapshots');
        fs.mkdirSync(snapsDir, { recursive: true });
        const toolsLatest = [
            { tool_name: 'roosync_dashboard', calls: 7, errors: 4, error_rate: null, retry_rate: 0, downstream_action_rate: 0 },
            { tool_name: 'roosync_search', calls: 210, errors: 21, error_rate: 10, retry_rate: 5, downstream_action_rate: 50 },
        ];
        const toolsPrevious = [
            { tool_name: 'roosync_dashboard', calls: 6, errors: 0, error_rate: 0, retry_rate: 0, downstream_action_rate: 0 },
            { tool_name: 'roosync_search', calls: 200, errors: 10, error_rate: 5, retry_rate: 5, downstream_action_rate: 48 },
        ];
        fs.writeFileSync(path.join(snapsDir, 'rsm-test-host-2026-09-01.json'), JSON.stringify({ tools: toolsPrevious }), 'utf-8');
        fs.writeFileSync(path.join(snapsDir, 'rsm-test-host-2026-09-04.json'), JSON.stringify({ tools: toolsLatest }), 'utf-8');

        const result = await handleRooSyncIndexing(
            { action: 'trend_report' },
            cache, ensureFresh, saveSkeleton, new Set(), setEnabled, rebuildHandler,
        );

        expect(result.isError).toBe(false);
        const text = result.content[0].text;
        expect(text).toContain('n/a');
        expect(text).not.toContain('null%');
        // The numeric-rate tool still gets its arrow against the previous snapshot.
        expect(text).toContain('↑');
    });
});
