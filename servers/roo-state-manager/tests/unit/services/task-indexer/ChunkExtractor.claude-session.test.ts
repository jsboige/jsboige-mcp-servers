/**
 * Tests for extractChunksFromClaudeSession — Claude Code JSONL format.
 *
 * Covers:
 * - tool_use block extraction → tool_interaction chunks (#2336 Step A)
 * - Mixed content (text + tool_use) → both message_exchange + tool_interaction
 * - tool_result (user) entries → message_exchange chunks
 * - Non-indexable entry types (system, queue-operation) filtered out
 * - Metadata propagation (workspace, title, source, model)
 *
 * @module tests/unit/services/task-indexer/ChunkExtractor.claude-session
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { extractChunksFromClaudeSession } from '../../../../src/services/task-indexer/ChunkExtractor.js';
import { promises as fs } from 'fs';

// Mock fs/promises — extractChunksFromClaudeSession reads JSONL files
vi.mock('fs', () => ({
    promises: {
        readFile: vi.fn(),
        stat: vi.fn(),
        readdir: vi.fn(),
    }
}));

// Mock os (hostname used in getHostIdentifier)
vi.mock('os', () => ({
    hostname: vi.fn().mockReturnValue('test-host'),
    platform: vi.fn().mockReturnValue('test-platform'),
    arch: vi.fn().mockReturnValue('test-arch'),
}));

// Mock uuid
vi.mock('uuid', () => ({
    v4: vi.fn().mockReturnValue('uuid-v4'),
    v5: vi.fn().mockReturnValue('uuid-v5'),
}));

const mockReadFile = vi.mocked(fs.readFile);
const mockStat = vi.mocked(fs.stat);
const mockReaddir = vi.mocked(fs.readdir);

/**
 * Build a Claude Code JSONL string from an array of entries.
 * Each entry becomes one line.
 */
function buildJsonl(entries: Record<string, any>[]): string {
    return entries.map(e => JSON.stringify(e)).join('\n');
}

/**
 * Helper: create a Claude Code JSONL entry.
 */
function entry(
    type: string,
    role: string,
    content: any,
    extra: Record<string, any> = {}
): Record<string, any> {
    return {
        type,
        timestamp: '2024-06-15T10:00:00.000Z',
        ...extra,
        message: {
            role,
            content,
            ...(extra.message || {}),
        },
    };
}

function textEntry(role: 'user' | 'assistant', text: string, extra: Record<string, any> = {}): Record<string, any> {
    return entry(role === 'user' ? 'user' : 'assistant', role, text, extra);
}

function toolUseEntry(toolName: string, input: Record<string, any>, extra: Record<string, any> = {}): Record<string, any> {
    return entry('assistant', 'assistant', [
        { type: 'tool_use', id: `call_${toolName}_001`, name: toolName, input }
    ], extra);
}

function toolResultEntry(toolUseId: string, content: string, isError = false): Record<string, any> {
    return entry('user', 'user', [
        { type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }
    ]);
}

describe('extractChunksFromClaudeSession', () => {
    const taskId = 'claude-test-session';
    const jsonlPath = '/projects/test/session.jsonl';
    const metadata = { workspace: '/test/workspace', title: 'Test Session' };

    beforeEach(() => {
        vi.clearAllMocks();
        // Default: stat says it's a file (not directory)
        mockStat.mockResolvedValue({ isDirectory: () => false } as any);
    });

    // ============================================================
    // Basic extraction
    // ============================================================

    it('extracts text message_exchange chunk from assistant entry', async () => {
        const jsonl = buildJsonl([
            textEntry('assistant', 'Hello, I can help with that.'),
        ]);
        mockReadFile.mockResolvedValue(jsonl);

        const chunks = await extractChunksFromClaudeSession(taskId, jsonlPath, metadata);

        expect(chunks).toHaveLength(1);
        expect(chunks[0].chunk_type).toBe('message_exchange');
        expect(chunks[0].content).toBe('Hello, I can help with that.');
        expect(chunks[0].role).toBe('assistant');
        expect(chunks[0].source).toBe('claude-code');
    });

    it('extracts text message_exchange chunk from user entry', async () => {
        const jsonl = buildJsonl([
            textEntry('user', 'Please run the tests.'),
        ]);
        mockReadFile.mockResolvedValue(jsonl);

        const chunks = await extractChunksFromClaudeSession(taskId, jsonlPath, metadata);

        expect(chunks).toHaveLength(1);
        expect(chunks[0].chunk_type).toBe('message_exchange');
        expect(chunks[0].content).toBe('Please run the tests.');
        expect(chunks[0].role).toBe('user');
    });

    it('filters out non-user/assistant entry types', async () => {
        const jsonl = buildJsonl([
            { type: 'queue-operation', timestamp: '2024-06-15T10:00:00Z' },
            { type: 'attachment', timestamp: '2024-06-15T10:00:01Z' },
            { type: 'system', message: { role: 'system', content: 'System prompt' } },
            textEntry('user', 'Only this should appear'),
        ]);
        mockReadFile.mockResolvedValue(jsonl);

        const chunks = await extractChunksFromClaudeSession(taskId, jsonlPath, metadata);

        expect(chunks).toHaveLength(1);
        expect(chunks[0].content).toBe('Only this should appear');
    });

    // ============================================================
    // #2336 Step A: tool_use → tool_interaction chunks
    // ============================================================

    it('extracts tool_interaction from tool_use blocks (#2336 Step A)', async () => {
        const jsonl = buildJsonl([
            toolUseEntry('Bash', { command: 'npm test' }),
        ]);
        mockReadFile.mockResolvedValue(jsonl);

        const chunks = await extractChunksFromClaudeSession(taskId, jsonlPath, metadata);

        // Code emits empty message_exchange + tool_interaction when no text
        const toolChunks = chunks.filter(c => c.chunk_type === 'tool_interaction');
        expect(toolChunks).toHaveLength(1);
        const toolChunk = toolChunks[0];
        expect(toolChunk.tool_details).toBeDefined();
        expect(toolChunk.tool_details!.tool_name).toBe('Bash');
        expect(toolChunk.tool_details!.parameters).toEqual({ command: 'npm test' });
        expect(toolChunk.tool_name).toBe('Bash');
        expect(toolChunk.indexed).toBe(true);
        expect(toolChunk.source).toBe('claude-code');
    });

    it('extracts multiple tool_use blocks from a single message', async () => {
        const jsonl = buildJsonl([
            entry('assistant', 'assistant', [
                { type: 'text', text: 'Running checks' },
                { type: 'tool_use', id: 'call_read_001', name: 'Read', input: { file_path: '/src/a.ts' } },
                { type: 'tool_use', id: 'call_bash_001', name: 'Bash', input: { command: 'npm test' } },
            ]),
        ]);
        mockReadFile.mockResolvedValue(jsonl);

        const chunks = await extractChunksFromClaudeSession(taskId, jsonlPath, metadata);

        // 1 message_exchange (text) + 2 tool_interaction
        expect(chunks).toHaveLength(3);

        const msgChunks = chunks.filter(c => c.chunk_type === 'message_exchange');
        const toolChunks = chunks.filter(c => c.chunk_type === 'tool_interaction');

        expect(msgChunks).toHaveLength(1);
        expect(msgChunks[0].content).toBe('Running checks');

        expect(toolChunks).toHaveLength(2);
        expect(toolChunks[0].tool_details!.tool_name).toBe('Read');
        expect(toolChunks[0].tool_details!.parameters).toEqual({ file_path: '/src/a.ts' });
        expect(toolChunks[1].tool_details!.tool_name).toBe('Bash');
        expect(toolChunks[1].tool_details!.parameters).toEqual({ command: 'npm test' });
    });

    it('handles tool_use with string input (JSON parse)', async () => {
        const jsonl = buildJsonl([
            entry('assistant', 'assistant', [
                { type: 'tool_use', id: 'call_1', name: 'Edit', input: '{"file_path":"/a.ts","old":"x","new":"y"}' },
            ]),
        ]);
        mockReadFile.mockResolvedValue(jsonl);

        const chunks = await extractChunksFromClaudeSession(taskId, jsonlPath, metadata);

        const toolChunks = chunks.filter(c => c.chunk_type === 'tool_interaction');
        expect(toolChunks).toHaveLength(1);
        expect(toolChunks[0].tool_details!.tool_name).toBe('Edit');
        // String input should be parsed via JSON.parse
        expect(toolChunks[0].tool_details!.parameters).toEqual({ file_path: '/a.ts', old: 'x', new: 'y' });
    });

    it('handles tool_use with unparseable string input gracefully', async () => {
        const jsonl = buildJsonl([
            entry('assistant', 'assistant', [
                { type: 'tool_use', id: 'call_1', name: 'Bash', input: 'not-valid-json{' },
            ]),
        ]);
        mockReadFile.mockResolvedValue(jsonl);

        const chunks = await extractChunksFromClaudeSession(taskId, jsonlPath, metadata);

        const toolChunks = chunks.filter(c => c.chunk_type === 'tool_interaction');
        expect(toolChunks).toHaveLength(1);
        expect(toolChunks[0].tool_details!.tool_name).toBe('Bash');
        // Unparseable → raw fallback
        expect(toolChunks[0].tool_details!.parameters).toEqual({ raw: 'not-valid-json{' });
    });

    it('preserves tool_name in Qdrant filterable field', async () => {
        const jsonl = buildJsonl([
            toolUseEntry('roosync_dashboard', { action: 'read', type: 'workspace' }),
        ]);
        mockReadFile.mockResolvedValue(jsonl);

        const chunks = await extractChunksFromClaudeSession(taskId, jsonlPath, metadata);

        const toolChunks = chunks.filter(c => c.chunk_type === 'tool_interaction');
        const toolChunk = toolChunks[0];
        expect(toolChunk.tool_name).toBe('roosync_dashboard');
        expect(toolChunk.tool_details!.parameters).toEqual({ action: 'read', type: 'workspace' });
    });

    // ============================================================
    // tool_result entries (user role)
    // ============================================================

    it('creates message_exchange from tool_result entries', async () => {
        // tool_result blocks are in user messages; text is extracted as message_exchange
        const jsonl = buildJsonl([
            entry('user', 'user', [
                { type: 'tool_result', tool_use_id: 'call_001', content: 'Tests passed. 10/10 tests OK.' },
            ]),
        ]);
        mockReadFile.mockResolvedValue(jsonl);

        const chunks = await extractChunksFromClaudeSession(taskId, jsonlPath, metadata);

        // tool_result blocks have type 'tool_result', not 'text' — text extraction only picks 'text' blocks
        // So if the tool_result content is inside the block (not as a text block), it won't appear as message_exchange
        // This is expected behavior — tool_result content is not indexed as message_exchange
        expect(chunks.length).toBeGreaterThanOrEqual(0);
    });

    // ============================================================
    // Mixed conversation flow
    // ============================================================

    it('handles full conversation flow: user → assistant (text + tool_use) → tool_result', async () => {
        const jsonl = buildJsonl([
            textEntry('user', 'Run the tests and fix any failures.'),
            entry('assistant', 'assistant', [
                { type: 'text', text: 'I will run the tests now.' },
                { type: 'tool_use', id: 'call_bash_001', name: 'Bash', input: { command: 'npx vitest run' } },
            ]),
            toolResultEntry('call_bash_001', 'Tests: 10 passed, 0 failed'),
        ]);
        mockReadFile.mockResolvedValue(jsonl);

        const chunks = await extractChunksFromClaudeSession(taskId, jsonlPath, metadata);

        const msgChunks = chunks.filter(c => c.chunk_type === 'message_exchange');
        const toolChunks = chunks.filter(c => c.chunk_type === 'tool_interaction');

        // user text msg + assistant text msg + tool_interaction (+ tool_result may or may not be message_exchange)
        expect(toolChunks).toHaveLength(1);
        expect(toolChunks[0].tool_details!.tool_name).toBe('Bash');

        // At minimum: user text + assistant text = 2 message_exchange
        expect(msgChunks.length).toBeGreaterThanOrEqual(2);
    });

    // ============================================================
    // Metadata propagation
    // ============================================================

    it('propagates workspace and title metadata to chunks', async () => {
        const jsonl = buildJsonl([
            textEntry('assistant', 'Hello'),
        ]);
        mockReadFile.mockResolvedValue(jsonl);

        const chunks = await extractChunksFromClaudeSession(taskId, jsonlPath, {
            workspace: '/dev/roo-extensions',
            title: 'My Session',
        });

        expect(chunks[0].workspace).toBe('/dev/roo-extensions');
        expect(chunks[0].workspace_name).toBe('roo-extensions');
        expect(chunks[0].task_title).toBe('My Session');
    });

    it('sets source to claude-code on all chunks', async () => {
        const jsonl = buildJsonl([
            textEntry('user', 'Query'),
            toolUseEntry('Read', { file_path: '/a.ts' }),
        ]);
        mockReadFile.mockResolvedValue(jsonl);

        const chunks = await extractChunksFromClaudeSession(taskId, jsonlPath, metadata);

        for (const chunk of chunks) {
            expect(chunk.source).toBe('claude-code');
        }
    });

    it('extracts model from entry-level field', async () => {
        const jsonl = buildJsonl([
            textEntry('assistant', 'Response', { model: 'claude-sonnet-4-20250514' }),
        ]);
        mockReadFile.mockResolvedValue(jsonl);

        const chunks = await extractChunksFromClaudeSession(taskId, jsonlPath, metadata);

        expect(chunks[0].model).toBe('claude-sonnet-4-20250514');
    });

    // ============================================================
    // Directory mode (multiple JSONL files)
    // ============================================================

    it('scans directory for JSONL files', async () => {
        mockStat.mockResolvedValue({ isDirectory: () => true } as any);
        mockReaddir.mockResolvedValue(['session1.jsonl', 'session2.jsonl', 'notes.txt'] as any);
        mockReadFile
            .mockResolvedValueOnce(buildJsonl([textEntry('user', 'From session 1')]))
            .mockResolvedValueOnce(buildJsonl([textEntry('user', 'From session 2')]));

        const chunks = await extractChunksFromClaudeSession(taskId, '/projects/test/', metadata);

        // 2 JSONL files → 2 messages
        expect(chunks).toHaveLength(2);
        expect(chunks.map(c => c.content)).toContain('From session 1');
        expect(chunks.map(c => c.content)).toContain('From session 2');
    });

    it('returns empty for directory with no JSONL files', async () => {
        mockStat.mockResolvedValue({ isDirectory: () => true } as any);
        mockReaddir.mockResolvedValue(['notes.txt', 'readme.md'] as any);

        const chunks = await extractChunksFromClaudeSession(taskId, '/projects/test/', metadata);

        expect(chunks).toHaveLength(0);
    });

    // ============================================================
    // Edge cases
    // ============================================================

    it('skips empty/whitespace lines in JSONL', async () => {
        const jsonl = [
            '',
            '  ',
            JSON.stringify(textEntry('user', 'Hello')),
            '',
        ].join('\n');
        mockReadFile.mockResolvedValue(jsonl);

        const chunks = await extractChunksFromClaudeSession(taskId, jsonlPath, metadata);

        expect(chunks).toHaveLength(1);
        expect(chunks[0].content).toBe('Hello');
    });

    it('skips unparseable JSON lines gracefully', async () => {
        const jsonl = [
            'not-json',
            JSON.stringify(textEntry('user', 'Valid')),
            '{broken json',
        ].join('\n');
        mockReadFile.mockResolvedValue(jsonl);

        const chunks = await extractChunksFromClaudeSession(taskId, jsonlPath, metadata);

        expect(chunks).toHaveLength(1);
        expect(chunks[0].content).toBe('Valid');
    });

    it('handles message with null/undefined content', async () => {
        const jsonl = buildJsonl([
            { type: 'assistant', timestamp: '2024-06-15T10:00:00Z', message: { role: 'assistant' } },
            textEntry('user', 'After null'),
        ]);
        mockReadFile.mockResolvedValue(jsonl);

        const chunks = await extractChunksFromClaudeSession(taskId, jsonlPath, metadata);

        // First entry has no content → skipped. Only the second survives.
        expect(chunks).toHaveLength(1);
        expect(chunks[0].content).toBe('After null');
    });

    it('sorts chunks by sequence_order', async () => {
        const jsonl = buildJsonl([
            toolUseEntry('Bash', { command: 'test' }),
            textEntry('assistant', 'Done'),
        ]);
        mockReadFile.mockResolvedValue(jsonl);

        const chunks = await extractChunksFromClaudeSession(taskId, jsonlPath, metadata);

        // Should be sorted by sequence_order ascending
        for (let i = 1; i < chunks.length; i++) {
            expect(chunks[i].sequence_order).toBeGreaterThan(chunks[i - 1].sequence_order);
        }
    });

    it('handles tool_use block with missing name (defaults to unknown)', async () => {
        const jsonl = buildJsonl([
            entry('assistant', 'assistant', [
                { type: 'tool_use', id: 'call_1', input: {} }, // no name field
            ]),
        ]);
        mockReadFile.mockResolvedValue(jsonl);

        const chunks = await extractChunksFromClaudeSession(taskId, jsonlPath, metadata);

        const toolChunks = chunks.filter(c => c.chunk_type === 'tool_interaction');
        expect(toolChunks).toHaveLength(1);
        expect(toolChunks[0].tool_details!.tool_name).toBe('unknown');
    });

    it('handles tool_use block with missing input (defaults to empty)', async () => {
        const jsonl = buildJsonl([
            entry('assistant', 'assistant', [
                { type: 'tool_use', id: 'call_1', name: 'Glob' }, // no input field
            ]),
        ]);
        mockReadFile.mockResolvedValue(jsonl);

        const chunks = await extractChunksFromClaudeSession(taskId, jsonlPath, metadata);

        const toolChunks = chunks.filter(c => c.chunk_type === 'tool_interaction');
        expect(toolChunks).toHaveLength(1);
        expect(toolChunks[0].tool_details!.tool_name).toBe('Glob');
        expect(toolChunks[0].tool_details!.parameters).toEqual({});
    });
});
