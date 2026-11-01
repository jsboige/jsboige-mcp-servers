/**
 * #4352 g9 — the Claude skeleton keeps the HEAD and the TAIL of a session.
 *
 * Before: only the first 20 000 entries were kept and files over 500 MiB were
 * skipped, so a live session's lastActivity froze and it was never re-queued for
 * indexing (ai-01 01/11: 41 sessions past 20 000 lines, two live coordinator
 * sessions of 625 MB and 1 064 MB seen with a lastActivity of 24-25/10).
 *
 * Real files in a temp dir; the window is shrunk through the env override so the
 * windowed path runs on a file of a few hundred KB.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ClaudeStorageDetector } from '../claude-storage-detector.js';

const BASE_MS = Date.UTC(2026, 9, 1, 0, 0, 0);
const ts = (i: number) => new Date(BASE_MS + i * 1000).toISOString();

function messageLine(i: number): string {
    const role = i % 2 === 0 ? 'user' : 'assistant';
    return JSON.stringify({
        type: role,
        message: { role, content: `msg-${i}` },
        timestamp: ts(i),
        uuid: `u-${i}`,
    });
}

function titleLine(title: string): string {
    return JSON.stringify({ type: 'ai-title', aiTitle: title });
}

/** Content markers (msg-N) of the sequence, in sequence order. */
function markers(skeleton: any): number[] {
    return skeleton.sequence
        .map((s: any) => /^msg-(\d+)$/.exec(String(s.content ?? ''))?.[1])
        .filter((m: string | undefined) => m !== undefined)
        .map(Number);
}

describe('ClaudeStorageDetector — #4352 g9 head + tail skeleton', () => {
    let tempDir: string;
    let projectDir: string;

    beforeEach(async () => {
        tempDir = path.join(os.tmpdir(), `claude-g9-tail-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        projectDir = path.join(tempDir, 'c--g9-project');
        await fs.mkdir(projectDir, { recursive: true });
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(async () => {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    });

    async function writeSession(lines: string[]): Promise<string> {
        const filePath = path.join(projectDir, 'session.jsonl');
        await fs.writeFile(filePath, lines.join('\n') + '\n', 'utf-8');
        return filePath;
    }

    it('past 20 000 entries, lastActivity is the LAST entry and createdAt the first', async () => {
        const n = 25_000;
        await writeSession(Array.from({ length: n }, (_, i) => messageLine(i)));

        const skeleton = await ClaudeStorageDetector.analyzeConversation('g9-id', projectDir);

        expect(skeleton).not.toBeNull();
        expect(skeleton!.metadata.createdAt).toBe(ts(0));
        // Before g9: ts(19 999), the 20 000th entry — the freeze this test pins.
        expect(skeleton!.metadata.lastActivity).toBe(ts(n - 1));

        const kept = markers(skeleton);
        expect(kept.length).toBe(20_000);
        // Head: entries 0-49. Tail: the last 19 950. In between: omitted.
        expect(kept.slice(0, 50)).toEqual(Array.from({ length: 50 }, (_, i) => i));
        expect(kept[50]).toBe(n - 19_950);
        expect(kept[kept.length - 1]).toBe(n - 1);
        expect(kept).not.toContain(1_000);
        // File order, no duplicate: strictly increasing.
        for (let i = 1; i < kept.length; i++) expect(kept[i]).toBeGreaterThan(kept[i - 1]);
    });

    it('a file larger than the tail window is read (head + last window), never skipped', async () => {
        const n = 5_000;
        const lines = Array.from({ length: n }, (_, i) => messageLine(i));
        lines.splice(10, 0, titleLine('Old title'));
        lines.splice(n - 5, 0, titleLine('Live title'));
        const filePath = await writeSession(lines);
        const size = (await fs.stat(filePath)).size;
        vi.stubEnv('CLAUDE_SKELETON_TAIL_WINDOW_BYTES', String(64 * 1024));
        expect(size).toBeGreaterThan(4 * 64 * 1024);

        const skeleton = await ClaudeStorageDetector.analyzeConversation('g9-id', projectDir);

        expect(skeleton).not.toBeNull();
        expect(skeleton!.metadata.createdAt).toBe(ts(0));
        expect(skeleton!.metadata.lastActivity).toBe(ts(n - 1));
        // The current ai-title is the late one, which only the tail carries.
        expect(skeleton!.metadata.title).toBe('Live title');

        const kept = markers(skeleton);
        // The head's 50 entries are msg-0..msg-48 plus the early ai-title.
        expect(kept.slice(0, 49)).toEqual(Array.from({ length: 49 }, (_, i) => i));
        expect(kept[49]).toBeGreaterThan(2_500);
        expect(kept).not.toContain(2_500);
        expect(kept[kept.length - 1]).toBe(n - 1);
        for (let i = 1; i < kept.length; i++) expect(kept[i]).toBeGreaterThan(kept[i - 1]);
        // Bounded read: the tail holds what fits in the window, not the whole file.
        expect(kept.length - 49).toBeLessThan(Math.ceil((64 * 1024) / 80));
    });

    it('window starting exactly at a line start: that line is kept, the one before is not duplicated', async () => {
        const n = 400;
        const lines = Array.from({ length: n }, (_, i) => messageLine(i));
        await writeSession(lines);
        const k = 100;
        const lastK = lines.slice(n - k).join('\n') + '\n';
        vi.stubEnv('CLAUDE_SKELETON_TAIL_WINDOW_BYTES', String(Buffer.byteLength(lastK, 'utf-8')));

        const skeleton = await ClaudeStorageDetector.analyzeConversation('g9-id', projectDir);
        const kept = markers(skeleton);

        expect(kept.slice(0, 50)).toEqual(Array.from({ length: 50 }, (_, i) => i));
        expect(kept.slice(50)).toEqual(Array.from({ length: k }, (_, i) => n - k + i));
        // A clean cut is not reported as invalid data.
        const warned = (console.warn as any).mock.calls.map((c: any[]) => String(c[0]));
        expect(warned.some((w: string) => w.includes('invalid JSONL lines'))).toBe(false);
    });

    it('window starting mid-line: the cut line is dropped, the next full line is kept, nothing counted invalid', async () => {
        const n = 400;
        const lines = Array.from({ length: n }, (_, i) => messageLine(i));
        await writeSession(lines);
        const k = 100;
        const lastK = lines.slice(n - k).join('\n') + '\n';
        // 3 bytes more: the offset falls inside line n-k-1.
        vi.stubEnv('CLAUDE_SKELETON_TAIL_WINDOW_BYTES', String(Buffer.byteLength(lastK, 'utf-8') + 3));

        const skeleton = await ClaudeStorageDetector.analyzeConversation('g9-id', projectDir);
        const kept = markers(skeleton);

        expect(kept).not.toContain(n - k - 1);
        expect(kept.slice(50)).toEqual(Array.from({ length: k }, (_, i) => n - k + i));
        const warned = (console.warn as any).mock.calls.map((c: any[]) => String(c[0]));
        expect(warned.some((w: string) => w.includes('invalid JSONL lines'))).toBe(false);
    });

    it('head region shorter than the head cap: the tail completes the head, every entry once, in order', async () => {
        const n = 60;
        const lines = Array.from({ length: n }, (_, i) => messageLine(i));
        await writeSession(lines);
        const tailLines = lines.slice(5).join('\n') + '\n';
        vi.stubEnv('CLAUDE_SKELETON_TAIL_WINDOW_BYTES', String(Buffer.byteLength(tailLines, 'utf-8')));

        const skeleton = await ClaudeStorageDetector.analyzeConversation('g9-id', projectDir);

        expect(markers(skeleton)).toEqual(Array.from({ length: n }, (_, i) => i));
        expect(skeleton!.metadata.lastActivity).toBe(ts(n - 1));
    });

    it('a truly invalid line inside the read region is still counted', async () => {
        const lines = Array.from({ length: 30 }, (_, i) => messageLine(i));
        lines.splice(15, 0, '{not json');
        await writeSession(lines);

        const skeleton = await ClaudeStorageDetector.analyzeConversation('g9-id', projectDir);

        expect(markers(skeleton).length).toBe(30);
        const warned = (console.warn as any).mock.calls.map((c: any[]) => String(c[0]));
        expect(warned.some((w: string) => w.includes('1 invalid JSONL lines'))).toBe(true);
    });

    it('invalid window env values fall back to the default (file read in full, not windowed)', async () => {
        const n = 300;
        await writeSession(Array.from({ length: n }, (_, i) => messageLine(i)));
        for (const bad of ['0', '-5', 'abc', '']) {
            vi.stubEnv('CLAUDE_SKELETON_TAIL_WINDOW_BYTES', bad);
            const skeleton = await ClaudeStorageDetector.analyzeConversation('g9-id', projectDir);
            expect(markers(skeleton)).toEqual(Array.from({ length: n }, (_, i) => i));
        }
    });
});
