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

  it('#2825 (G2): oversized api history is NOT truncated — child units carry the overflow (was L191-195)', async () => {
    const many = Array.from({ length: MAX_MESSAGES_PER_TASK + 5 }, (_, i) => ({
      role: 'user', content: 'm' + i, timestamp: 't',
    }));
    setupTaskFiles({ metadata: JSON.stringify({}), api: JSON.stringify(many) });
    const chunks = await extractChunksFromTask('t6', '/task');
    // #2825 (G2): NO DROP — all messages emitted. Overflow lands in child units
    // (taskId#unit-2). Total chunk count = message count (one chunk per non-system message).
    expect(chunks.length).toBe(MAX_MESSAGES_PER_TASK + 5);
    // Head unit retains the original task_id (backward compat with existing filters).
    expect(chunks[0].task_id).toBe('t6');
    expect(chunks[0].child_unit_index).toBe(1);
    // Overflow unit is tagged with the synthetic child id + parent lineage.
    const overflowChunk = chunks.find(c => c.task_id === 't6#unit-2');
    expect(overflowChunk).toBeDefined();
    expect(overflowChunk!.parent_task_id).toBe('t6');
    expect(overflowChunk!.child_unit_index).toBe(2);
    expect(overflowChunk!.child_unit_total).toBe(2);
    // The warn fires under the new tag (#2825/G2) instead of the old #1758.
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('#2825/G2'));
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

  it('#2825 (G2): oversized Claude session is NOT truncated — child units carry the overflow (was L491-493)', async () => {
    mockStat.mockResolvedValue({ isDirectory: () => false } as any); // direct-file path
    const lines = Array.from({ length: MAX_MESSAGES_PER_TASK + 3 }, (_, i) =>
      JSON.stringify({ type: 'user', message: { content: 'c' + i } })).join('\n');
    pushStream(lines);
    const chunks = await extractChunksFromClaudeSession('claude-z', '/proj/session.jsonl');
    // #2825 (G2): NO DROP — every JSONL line emits a chunk. Overflow lands in child units.
    expect(chunks.length).toBe(MAX_MESSAGES_PER_TASK + 3);
    expect(chunks[0].task_id).toBe('claude-z');
    expect(chunks[0].child_unit_index).toBe(1);
    const overflowChunk = chunks.find(c => c.task_id === 'claude-z#unit-2');
    expect(overflowChunk).toBeDefined();
    expect(overflowChunk!.parent_task_id).toBe('claude-z');
    expect(overflowChunk!.child_unit_index).toBe(2);
    // The warn fires under the new tag (#2825/G2).
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('#2825/G2'));
  });
});

describe('ChunkExtractor coverage — #2825 (G5) condensation-fallback chunk_type', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockReadFile.mockReset();
    mockAccess.mockReset();
    mockStat.mockReset();
    mockReaddir.mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockAccess.mockResolvedValue(undefined);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('emits chunk_type="task_summary" when metadata.source === "condensation-fallback"', async () => {
    // #2825 (G5): synthetic condensation tasks (written by dashboard.ts G6) carry
    // a metadata.source='condensation-fallback' marker. The extractor must switch
    // chunk_type to 'task_summary' (instead of 'message_exchange') so search
    // consumers can filter condensation outputs.
    const messages = [
      { role: 'user', content: '[CONDENSATION ARCHIVE] 42 messages archived', timestamp: 't0' },
      { role: 'assistant', content: 'archived body — verbatim, lossless', timestamp: 't0' },
    ];
    mockReadFile.mockImplementation(async (p: string) => {
      if (p.endsWith('task_metadata.json')) {
        return JSON.stringify({
          taskId: '_cond-test-2026-07-14',
          title: '[Condensation summary] test',
          workspace: 'system',
          source: 'condensation-fallback',
          condensation: { originalDashboardKey: 'test', messageCount: 42 },
        });
      }
      if (p.endsWith('api_conversation_history.json')) {
        return JSON.stringify(messages);
      }
      return '{}';
    });

    const chunks = await extractChunksFromTask('_cond-test-2026-07-14', '/task');
    expect(chunks.length).toBe(2);
    for (const c of chunks) {
      expect(c.chunk_type).toBe('task_summary');
      expect(c.task_id).toBe('_cond-test-2026-07-14');
      expect(c.child_unit_index).toBe(1);
      expect(c.child_unit_total).toBe(1);
    }
  });

  it('keeps chunk_type="message_exchange" when metadata.source is absent (regression guard)', async () => {
    // Existing tasks without a `source` field must continue to emit the original
    // chunk_type — this test guards against an over-eager G5 defaulting.
    mockReadFile.mockImplementation(async (p: string) => {
      if (p.endsWith('task_metadata.json')) return JSON.stringify({ taskId: 'plain' });
      if (p.endsWith('api_conversation_history.json')) {
        return JSON.stringify([{ role: 'user', content: 'hi', timestamp: 't' }]);
      }
      return '{}';
    });
    const chunks = await extractChunksFromTask('plain', '/task');
    expect(chunks.length).toBe(1);
    expect(chunks[0].chunk_type).toBe('message_exchange');
  });
});

describe('ChunkExtractor coverage — #2828 lineage metadata nits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStream();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); });

  // ============================================================
  // #2828 nit 1: child_unit_total must include api + ui messages
  // ============================================================

  it('#2828 nit 1: child_unit_total accounts for api + ui messages combined (no undercount)', async () => {
    // api messages alone don't exceed MAX_MESSAGES_PER_TASK, but api + ui do.
    // Old code computed childUnitCount from apiMessages.length only, so ui
    // messages that pushed messageIndex past the boundary got child_unit_index
    // values exceeding child_unit_total.
    const apiCount = MAX_MESSAGES_PER_TASK - 2;  // Just under the limit
    const uiCount = 5;                            // Pushes combined over the limit
    const apiMsgs = Array.from({ length: apiCount }, (_, i) => ({
      role: 'user', content: 'api-' + i, timestamp: 't',
    }));
    const uiMsgs = Array.from({ length: uiCount }, (_, i) => ({
      author: 'user', text: 'ui-' + i, timestamp: 't',
    }));
    setupTaskFiles({
      metadata: JSON.stringify({}),
      api: JSON.stringify(apiMsgs),
      ui: JSON.stringify(uiMsgs),
    });

    const chunks = await extractChunksFromTask('t-nit1', '/task');
    // All api + ui messages emitted
    expect(chunks.length).toBe(apiCount + uiCount);

    // The last ui messages cross the MAX_MESSAGES_PER_TASK boundary → child unit 2
    const overflowChunks = chunks.filter(c => c.child_unit_index === 2);
    expect(overflowChunks.length).toBeGreaterThan(0);

    // KEY ASSERTION: child_unit_total >= max child_unit_index across ALL chunks
    const maxIdx = Math.max(...chunks.map(c => c.child_unit_index || 1));
    const total = chunks[0].child_unit_total;
    expect(total).toBeGreaterThanOrEqual(maxIdx);
    expect(total).toBe(2);
    // Every chunk must have child_unit_total == 2 (no undercount)
    for (const c of chunks) {
      expect(c.child_unit_total).toBe(2);
    }
  });

  // ============================================================
  // #2828 nit 2: Claude path paging on emitted messages, not raw lines
  // ============================================================

  it('#2828 nit 2: Claude child-unit paging based on emitted messages (no phantom units from skipped lines)', async () => {
    mockStat.mockResolvedValue({ isDirectory: () => false } as any);
    // Build a JSONL with M+2 emitted messages followed by M skipped lines
    // (system entries without content → `continue` in the extractor).
    // Old code paged on totalLines (2M+2), producing a phantom unit 3.
    // New code pages on fileMessageCount (M+2), correctly producing 2 units.
    const emitted = MAX_MESSAGES_PER_TASK + 2;
    const skipped = MAX_MESSAGES_PER_TASK;
    const lines: string[] = [];
    for (let i = 0; i < emitted; i++) {
      lines.push(JSON.stringify({ type: 'user', message: { content: 'msg-' + i } }));
    }
    for (let i = 0; i < skipped; i++) {
      // System entries are filtered out by the extractor (not user/assistant)
      lines.push(JSON.stringify({ type: 'system', message: { role: 'system', content: 'skip' } }));
    }
    pushStream(lines.join('\n'));

    const chunks = await extractChunksFromClaudeSession('claude-nit2', '/proj/session.jsonl');

    // Only emitted messages become chunks (skipped lines produce nothing)
    expect(chunks.length).toBe(emitted);

    // No chunk should reference child_unit_index > 2 (the correct total)
    const maxIdx = Math.max(...chunks.map(c => c.child_unit_index || 1));
    expect(maxIdx).toBe(2);

    // child_unit_total should be at most 2 (based on emitted count),
    // NOT 3 (which would result from raw line count 2M+2).
    for (const c of chunks) {
      expect(c.child_unit_total).toBeLessThanOrEqual(2);
    }
  });
});
