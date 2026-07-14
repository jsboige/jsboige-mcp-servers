/**
 * Coverage complement for ChunkExtractor.ts (#833 Sprint C3, lane src/services/task-indexer/**).
 *
 * Add-only. The two existing suites
 *   - src/services/task-indexer/__tests__/ChunkExtractor.test.ts (splitChunk / pure helpers)
 *   - tests/unit/services/task-indexer/ChunkExtractor.test.ts (extractChunksFromTask happy path)
 *   - tests/unit/services/task-indexer/ChunkExtractor.claude-session.test.ts (Claude happy path)
 * leave the following branch arms cold; this file reaches them:
 *   - #2825 (G1): oversized content preserved in full (lossless — no mid-content amputation)
 *   - metadata BOM strip (L160-162)
 *   - tool_use string-input arm (L228-229) + tool-call bad-JSON-args catch (L283-287)
 *   - non-string / non-array truthy content fallback (L235-238)
 *   - >MAX_MESSAGES_PER_TASK api warning (L191-193)
 *   - api-history try/catch → StateManagerError throw (L321-339)
 *   - Claude per-file error collection + summary (L614-625)
 *   - Claude outer critical catch → StateManagerError (L626-636)
 *   - >MAX_MESSAGES_PER_TASK Claude lines warning (L491-493)
 *
 * Same mock strategy as the existing suites: a per-file vi.mock('fs') exposing the
 * promises API + a queue-driven createReadStream (which throws synchronously for an
 * `{ __error }` sentinel to exercise the per-file catch).
 *
 * @module ChunkExtractor.coverage
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as fsModule from 'fs';
import {
  extractChunksFromTask,
  extractChunksFromClaudeSession,
  MAX_MESSAGES_PER_TASK,
} from '../ChunkExtractor.js';
import { StateManagerError } from '../../../types/errors.js';

vi.mock('fs', () => {
  const { Readable } = require('stream');
  const streamQueue: any[] = [];
  return {
    promises: {
      readFile: vi.fn(),
      access: vi.fn(),
      stat: vi.fn(),
      readdir: vi.fn(),
    },
    createReadStream: vi.fn(() => {
      const item = streamQueue.length ? streamQueue.shift() : '';
      if (item && typeof item === 'object' && item.__error) {
        // Simulate a stream that cannot be opened — surfaces at the per-file try.
        throw new Error(item.__error);
      }
      // Emit the content in small slices (like a real fs.ReadStream, which delivers
      // ~64 KB chunks) so readline reassembles and splits lines regardless of size.
      const content = typeof item === 'string' ? item : '';
      function* slices() {
        if (content.length === 0) return;
        for (let i = 0; i < content.length; i += 8192) yield content.slice(i, i + 8192);
      }
      return Readable.from(slices());
    }),
    __pushStream: (x: any) => streamQueue.push(x),
    __resetStream: () => { streamQueue.length = 0; },
  };
});

// computeChunkId relies on uuid v5. A global setup auto-mocks 'uuid' (v5 undefined),
// so declare the real implementation here (mirrors the existing src suite).
vi.mock('uuid', async () => await vi.importActual('uuid'));

const pushStream = (x: any) => (fsModule as any).__pushStream(x);
const resetStream = () => (fsModule as any).__resetStream();

const mockReadFile = vi.mocked(fs.readFile);
const mockAccess = vi.mocked(fs.access);
const mockStat = vi.mocked(fs.stat);
const mockReaddir = vi.mocked(fs.readdir);

/**
 * Configure readFile/access for extractChunksFromTask by filename suffix.
 * Any file left `undefined` rejects (simulating a missing file).
 */
function setupTaskFiles(opts: { metadata?: string; api?: string; ui?: string }) {
  mockReadFile.mockImplementation(async (p: any) => {
    const s = String(p);
    if (s.endsWith('task_metadata.json')) {
      if (opts.metadata === undefined) throw new Error('ENOENT metadata');
      return opts.metadata;
    }
    if (s.endsWith('api_conversation_history.json')) {
      if (opts.api === undefined) throw new Error('ENOENT api');
      return opts.api;
    }
    if (s.endsWith('ui_messages.json')) {
      if (opts.ui === undefined) throw new Error('ENOENT ui');
      return opts.ui;
    }
    throw new Error('unexpected readFile ' + s);
  });
  mockAccess.mockImplementation(async (p: any) => {
    const s = String(p);
    if (s.endsWith('api_conversation_history.json') && opts.api === undefined) throw new Error('ENOENT api access');
    if (s.endsWith('ui_messages.json') && opts.ui === undefined) throw new Error('ENOENT ui access');
    return undefined as any;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetStream();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ChunkExtractor coverage — extractChunksFromTask', () => {
  it('#2825 (G1): preserves oversized message content in FULL — no mid-content amputation', async () => {
    const big = 'x'.repeat(25000);
    setupTaskFiles({
      metadata: JSON.stringify({ workspace: 'd:/ws', title: 'T' }),
      api: JSON.stringify([{ role: 'user', content: big, timestamp: '2024-01-01T00:00:00Z' }]),
    });
    const chunks = await extractChunksFromTask('t1', '/task');
    expect(chunks.length).toBe(1);
    // Content is carried in full at extraction; lossless splitting happens downstream in VectorIndexer.
    expect(chunks[0].content).toBe(big);
    expect(chunks[0].content.length).toBe(25000);
    expect(chunks[0].content).not.toContain('[TRUNCATED for indexing');
  });

  it('strips a BOM prefix from task_metadata.json (L160-162)', async () => {
    const BOM = String.fromCharCode(0xFEFF);
    setupTaskFiles({
      metadata: BOM + JSON.stringify({ workspace: 'd:/roo', title: 'Titled' }),
      api: JSON.stringify([{ role: 'user', content: 'hi', timestamp: 't' }]),
    });
    const chunks = await extractChunksFromTask('t2', '/task');
    expect(chunks[0].workspace).toBe('d:/roo');
    expect(chunks[0].workspace_name).toBe('roo');
    expect(chunks[0].task_title).toBe('Titled');
  });

  it('handles a tool_use block with string input and unparseable args (L228-229, L283-287)', async () => {
    setupTaskFiles({
      metadata: JSON.stringify({}),
      api: JSON.stringify([
        { role: 'assistant', content: [{ type: 'tool_use', name: 'do_thing', input: 'not-json-args' }], timestamp: 't' },
      ]),
    });
    const chunks = await extractChunksFromTask('t3', '/task');
    const tool = chunks.find(c => c.chunk_type === 'tool_interaction');
    expect(tool).toBeDefined();
    expect(tool!.tool_details!.tool_name).toBe('do_thing');
    // arguments were a non-JSON string → JSON.parse catch → { raw }
    expect(tool!.tool_details!.parameters).toEqual({ raw: 'not-json-args' });
  });

  it('stringifies non-string / non-array truthy content (L235-238)', async () => {
    setupTaskFiles({
      metadata: JSON.stringify({}),
      api: JSON.stringify([{ role: 'user', content: 42, timestamp: 't' }]),
    });
    const chunks = await extractChunksFromTask('t4', '/task');
    expect(chunks[0].content).toBe('42');
  });

  it('throws StateManagerError on malformed api_conversation_history.json (L321-339)', async () => {
    setupTaskFiles({ metadata: JSON.stringify({}), api: '{ this is not json' });
    await expect(extractChunksFromTask('t5', '/task')).rejects.toThrow(StateManagerError);
    await expect(extractChunksFromTask('t5', '/task')).rejects.toMatchObject({ code: 'CHUNK_EXTRACTION_FAILED' });
  });

  it('warns and caps at MAX_MESSAGES_PER_TASK for an oversized api history (L191-195)', async () => {
    const many = Array.from({ length: MAX_MESSAGES_PER_TASK + 5 }, (_, i) => ({
      role: 'user', content: 'm' + i, timestamp: 't',
    }));
    setupTaskFiles({ metadata: JSON.stringify({}), api: JSON.stringify(many) });
    const chunks = await extractChunksFromTask('t6', '/task');
    expect(chunks.length).toBe(MAX_MESSAGES_PER_TASK);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('#1758'));
  });
});

describe('ChunkExtractor coverage — extractChunksFromClaudeSession', () => {
  it('throws StateManagerError when the project path cannot be stat-ed (L626-636)', async () => {
    mockStat.mockRejectedValue(new Error('ENOENT dir'));
    await expect(extractChunksFromClaudeSession('claude-x', '/missing')).rejects.toThrow(StateManagerError);
    await expect(extractChunksFromClaudeSession('claude-x', '/missing')).rejects.toMatchObject({ code: 'CHUNK_EXTRACTION_FAILED' });
  });

  it('collects per-file errors and continues with the remaining files (L614-625)', async () => {
    mockStat.mockResolvedValue({ isDirectory: () => true } as any);
    mockReaddir.mockResolvedValue(['a.jsonl', 'b.jsonl'] as any);
    pushStream({ __error: 'stream boom' });                                     // a.jsonl → per-file catch
    pushStream(JSON.stringify({ type: 'user', message: { content: 'hello' } })); // b.jsonl → 1 chunk
    const chunks = await extractChunksFromClaudeSession('claude-y', '/proj');
    expect(chunks.length).toBe(1);
    expect(chunks[0].content).toBe('hello');
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Error reading'));
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('file error'));
  });

  it('warns when a Claude session exceeds MAX_MESSAGES_PER_TASK lines (L491-493)', async () => {
    mockStat.mockResolvedValue({ isDirectory: () => false } as any); // direct-file path
    const lines = Array.from({ length: MAX_MESSAGES_PER_TASK + 3 }, (_, i) =>
      JSON.stringify({ type: 'user', message: { content: 'c' + i } })).join('\n');
    pushStream(lines);
    const chunks = await extractChunksFromClaudeSession('claude-z', '/proj/session.jsonl');
    expect(chunks.length).toBe(MAX_MESSAGES_PER_TASK);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('#1758'));
  });
});
