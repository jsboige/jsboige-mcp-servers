/**
 * #4636 — generic XML delegation pattern: no catastrophic backtracking.
 *
 * The former pattern (kept below as LEGACY_GENERIC_XML, the oracle) froze the MCP host's
 * main thread on a 1.1 MB command output (measured on ai-01, 10/11/2026). These tests pin:
 *   1. a pathological message above the size bound crosses extractSubtaskInstructions fast;
 *   2. a pathological message under the bound (tempered path) stays fast;
 *   3. the tempered pattern returns exactly what the legacy pattern returned (oracle);
 *   4. a well-formed generic block is still extracted.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import {
    HierarchyReconstructionEngine,
    GENERIC_XML_BLOCK,
    GENERIC_XML_MAX_CHARS,
} from '../hierarchy-reconstruction-engine.js';
import type { EnhancedConversationSkeleton } from '../../types/enhanced-hierarchy.js';

const mockReadFileSync = vi.fn();
const mockExistsSync = vi.fn();

vi.mock('fs', () => ({
    existsSync: (...args: any[]) => mockExistsSync(...args),
    readFileSync: (...args: any[]) => mockReadFileSync(...args),
    statSync: vi.fn().mockReturnValue({ isDirectory: () => true, size: 1000, mtime: new Date('2025-01-01T00:00:00Z') }),
}));

vi.mock('fs/promises', () => ({
    readFile: vi.fn(),
    readdir: vi.fn().mockResolvedValue([]),
    stat: vi.fn().mockResolvedValue({ isDirectory: () => true, size: 1000, mtime: new Date('2025-01-01T00:00:00Z') }),
}));

// Oracle: the pattern as it stood before #4636 (hierarchy-reconstruction-engine.ts:782 @ 822797bf).
const LEGACY_GENERIC_XML = /<\s*([a-z_][\w\-]*)\b[^>]*>[\s\S]*?<\s*mode\s*>([\s\S]*?)<\/\s*mode\s*>[\s\S]*?<\s*message\s*>([\s\S]*?)<\/\s*message\s*>[\s\S]*?<\/\s*\1\s*>/i;

// Unit that triggers the backtracking: an opening tag with mode/message, never closed.
const UNCLOSED_UNIT = '<task_a> <mode>code</mode> some prose <message>do x</message> more prose\n';

function skeleton(taskId: string): EnhancedConversationSkeleton {
    return {
        taskId,
        sequence: [],
        metadata: {
            title: taskId,
            lastActivity: '2025-01-01T00:00:00Z',
            createdAt: '2025-01-01T00:00:00Z',
            messageCount: 1,
            actionCount: 0,
            totalSize: 1000,
            workspace: 'd:/test',
            dataSource: 'd:/test/tasks/' + taskId,
        },
        processingState: { phase1Completed: false, phase2Completed: false, processingErrors: [] },
        sourceFileChecksums: {},
    } as unknown as EnhancedConversationSkeleton;
}

function serveMessages(messages: unknown[]): void {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(messages));
}

beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockReturnValue('[]');
});

describe('#4636 generic XML pattern — bounded cost', () => {
    test('pathological message above the bound (1.1 MB) crosses extraction in < 1 s', async () => {
        const huge = UNCLOSED_UNIT.repeat(Math.ceil(1_136_815 / UNCLOSED_UNIT.length));
        expect(huge.length).toBeGreaterThan(GENERIC_XML_MAX_CHARS);
        serveMessages([{ type: 'say', say: 'command_output', ts: 1771621264713, text: huge }]);

        const engine = new HierarchyReconstructionEngine({ debugMode: false });
        const t0 = performance.now();
        await (engine as any).extractSubtaskInstructions(skeleton('redos-huge'));
        expect(performance.now() - t0).toBeLessThan(1000);
    });

    test('pathological message under the bound (tempered path) stays fast', async () => {
        // 8k chars: the legacy pattern needs ~16 s here (5.8k = 2.9 s, 11.7k > 97 s, measured),
        // so a regression FAILS on the assertion instead of hanging the runner — a synchronous
        // regex cannot be interrupted by vitest's testTimeout (a 64k input hung > 90 s).
        const dense = UNCLOSED_UNIT.repeat(Math.ceil(8192 / UNCLOSED_UNIT.length));
        expect(dense.length).toBeLessThanOrEqual(GENERIC_XML_MAX_CHARS);
        serveMessages([{ type: 'say', say: 'command_output', ts: 1, text: dense }]);

        const engine = new HierarchyReconstructionEngine({ debugMode: false });
        const t0 = performance.now();
        await (engine as any).extractSubtaskInstructions(skeleton('redos-dense'));
        expect(performance.now() - t0).toBeLessThan(1000);
    });

    test('a well-formed generic block is still extracted', async () => {
        serveMessages([{ type: 'say', ts: 1700000000, text: 'x <orchestrator_complex k="v"><mode>architect</mode><message>Design the new schema for storage</message><todos>t</todos></orchestrator_complex> y' }]);

        const engine = new HierarchyReconstructionEngine({ debugMode: false });
        const instructions = await (engine as any).extractSubtaskInstructions(skeleton('generic-ok'));
        expect(instructions.some((i: any) => i.mode === 'architect' && i.message === 'Design the new schema for storage')).toBe(true);
    });
});

describe('#4636 tempered pattern ≡ legacy pattern (oracle)', () => {
    // Deterministic generator biased toward near-valid blocks (missing/duplicated/mismatched delimiters).
    let seed = 4636;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    const pick = <T,>(arr: T[]): T => arr[rnd(arr.length)];
    const names = ['a', 'B', 'orch_x', 'new_task', 'a-b', 'mode', 'message'];
    function block(): string {
        const n = pick(names); const n2 = rnd(4) === 0 ? pick(names) : n;
        return [`<${rnd(3) === 0 ? ' ' : ''}${n}${rnd(4) === 0 ? ' k="v"' : ''}>`, pick(['', 'p ', '<mode>', '</mode>', '<x>']),
            rnd(6) ? '<mode>' : '', pick(['code', '', '<message>', '</mode>x']), rnd(6) ? pick(['</mode>', '</ MODE>']) : '',
            pick(['', ' ', '<mode>y</mode>', '</message>']), rnd(6) ? pick(['<message>', '<Message >']) : '', pick(['do it', '', '</mode>', '<message>z']),
            rnd(6) ? '</message>' : '', pick(['', ' tail ', `</${n}>`, '<todos>t</todos>']), rnd(5) ? `</${n2}>` : ''].join('');
    }
    const legacyAll = new RegExp(LEGACY_GENERIC_XML.source, 'gi');
    const temperedAll = new RegExp(GENERIC_XML_BLOCK.source, 'gi');

    test('identical match lists and captures on 5 000 generated inputs', () => {
        let withMatch = 0;
        for (let i = 0; i < 5000; i++) {
            let s = ''; const k = 1 + rnd(4);
            for (let j = 0; j < k; j++) s += block() + pick(['', '\n', ' x ']);
            const legacy = s.match(legacyAll);
            if (legacy) withMatch++;
            expect(s.match(temperedAll)).toEqual(legacy);
            const a = s.match(LEGACY_GENERIC_XML); const b = s.match(GENERIC_XML_BLOCK);
            expect(b && [b.index, ...b]).toEqual(a && [a.index, ...a]);
        }
        // Guard against a generator that never exercises the matching path.
        expect(withMatch).toBeGreaterThan(100);
    });
});
