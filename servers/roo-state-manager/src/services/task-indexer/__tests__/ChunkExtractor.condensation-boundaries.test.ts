/**
 * #3763: Cover the chapter-aligned child-unit paging — the new helper
 * `detectCondensationBoundaries` + the integration into `extractChunksFromTask`
 * and `extractChunksFromClaudeSession`. Three branches:
 *
 *   1. inline boundary detected on a single api message → unit splits at that index
 *   2. multiple inline boundaries → N+1 chapter-aligned units
 *   3. NO boundaries detected → falls back to count-based paging (no regression)
 *
 * Mock strategy mirrors the existing suites in this directory: `vi.mock('fs')`
 * exposes the promises API + a queue-driven createReadStream for the JSONL
 * path. The pure helpers are imported directly (no fs dependency).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as fsModule from 'fs';
import {
  extractChunksFromTask,
  extractChunksFromClaudeSession,
  detectCondensationBoundaries,
  pickChildUnitCutPoints,
  childUnitIndexFor,
  MAX_MESSAGES_PER_TASK,
} from '../ChunkExtractor.js';

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

vi.mock('uuid', async () => await vi.importActual('uuid'));

const pushStream = (x: any) => (fsModule as any).__pushStream(x);
const resetStream = () => (fsModule as any).__resetStream();

const mockReadFile = vi.mocked(fs.readFile);
const mockAccess = vi.mocked(fs.access);
const mockStat = vi.mocked(fs.stat);
const mockReaddir = vi.mocked(fs.readdir);

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

describe('ChunkExtractor — #3763 detectCondensationBoundaries (pure helper)', () => {
  it('returns empty array when no boundary markers are present', () => {
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
      { role: 'user', content: 'how are you?' },
    ];
    expect(detectCondensationBoundaries(messages)).toEqual([]);
  });

  it('detects [CONDENSATION ARCHIVE] user-message prefix (1-based index)', () => {
    const messages = [
      { role: 'user', content: 'preface text' },
      { role: 'assistant', content: 'preface reply' },
      { role: 'user', content: '[CONDENSATION ARCHIVE] 42 messages archived' },
      { role: 'assistant', content: 'archived body — verbatim' },
    ];
    // The third message (1-based index 3) starts a chapter.
    expect(detectCondensationBoundaries(messages)).toEqual([3]);
  });

  it('detects [Condensation summary] prefix in assistant messages too', () => {
    const messages = [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'assistant', content: '[Condensation summary] recap of chapter 1' },
      { role: 'user', content: 'q2' },
    ];
    expect(detectCondensationBoundaries(messages)).toEqual([3]);
  });

  it('handles UiMessage shape ({author, text})', () => {
    const messages = [
      { author: 'user', text: 'plain ui message' },
      { author: 'agent', text: '[CONDENSATION ARCHIVE] 7 messages archived' },
    ];
    expect(detectCondensationBoundaries(messages)).toEqual([2]);
  });

  it('extracts head from array content blocks (first text block)', () => {
    const messages = [
      { role: 'user', content: [
        { type: 'text', text: '[CONDENSATION ARCHIVE] head of chapter' },
        { type: 'text', text: 'body' },
      ] },
    ];
    expect(detectCondensationBoundaries(messages)).toEqual([1]);
  });

  it('returns multiple boundaries when several markers are present', () => {
    const messages = [
      { role: 'user', content: 'first chapter' },
      { role: 'assistant', content: '[Condensation summary] end of chapter 1' },
      { role: 'user', content: 'second chapter' },
      { role: 'assistant', content: '[CONDENSATION ARCHIVE] 50 messages archived' },
      { role: 'user', content: 'third chapter' },
    ];
    expect(detectCondensationBoundaries(messages)).toEqual([2, 4]);
  });
});

describe('ChunkExtractor — #3763 pickChildUnitCutPoints (pure helper)', () => {
  it('returns [1, N+1] when no boundaries and N ≤ budget', () => {
    const cuts = pickChildUnitCutPoints(50, [], 100);
    expect(cuts).toEqual([1, 51]);
  });

  it('falls back to count-based paging every budget when no boundaries', () => {
    const cuts = pickChildUnitCutPoints(250, [], 100);
    expect(cuts).toEqual([1, 101, 201, 251]);
  });

  it('uses boundaries as cut points when present', () => {
    const cuts = pickChildUnitCutPoints(250, [51, 101, 201], 100);
    // Boundaries are 1-based; cut points = [1, 51, 101, 201, 251]
    expect(cuts).toEqual([1, 51, 101, 201, 251]);
  });

  it('dedupes cut points when boundary falls on a count-based page boundary', () => {
    // Boundary at index 101 coincides with the count-based page break.
    const cuts = pickChildUnitCutPoints(250, [101], 100);
    expect(cuts).toEqual([1, 101, 251]);
  });

  it('ignores out-of-range boundaries', () => {
    const cuts = pickChildUnitCutPoints(50, [0, 51, 100], 100);
    expect(cuts).toEqual([1, 51]);
  });

  it('returns [1] for empty input', () => {
    expect(pickChildUnitCutPoints(0, [], 100)).toEqual([1]);
  });
});

describe('ChunkExtractor — #3763 childUnitIndexFor (pure helper)', () => {
  const cuts = [1, 51, 101, 201, 251];

  it('maps a message in the first unit', () => {
    expect(childUnitIndexFor(1, cuts)).toBe(1);
    expect(childUnitIndexFor(50, cuts)).toBe(1);
  });

  it('maps a message at a cut point to the next unit (chapter head)', () => {
    expect(childUnitIndexFor(51, cuts)).toBe(2);
    expect(childUnitIndexFor(101, cuts)).toBe(3);
  });

  it('maps a message in the trailing unit', () => {
    expect(childUnitIndexFor(200, cuts)).toBe(3);
    expect(childUnitIndexFor(201, cuts)).toBe(4);
    expect(childUnitIndexFor(250, cuts)).toBe(4);
  });
});

describe('ChunkExtractor — #3763 integration: extractChunksFromTask chapter-aligned paging', () => {
  it('splits at one inline boundary in a long api history (was count-based before #3763)', async () => {
    // 50 normal messages + 1 boundary message + 50 more = 101 emitted.
    // Pre-#3763: ceil(101 / MAX_MESSAGES_PER_TASK)=1 unit, but with 100+
    // messages it WOULD have been 2 units by count. Post-#3763: 2 units,
    // split at the boundary.
    // To force the count-based path to ACT, we go well past MAX_MESSAGES_PER_TASK.
    const head = Array.from({ length: MAX_MESSAGES_PER_TASK }, (_, i) => ({
      role: 'user', content: `head-${i}`, timestamp: 't',
    }));
    const boundary = {
      role: 'user',
      content: '[CONDENSATION ARCHIVE] chapter break',
      timestamp: 't',
    };
    const tail = Array.from({ length: MAX_MESSAGES_PER_TASK }, (_, i) => ({
      role: 'user', content: `tail-${i}`, timestamp: 't',
    }));
    setupTaskFiles({
      metadata: JSON.stringify({ workspace: 'd:/ws', title: 'T' }),
      api: JSON.stringify([...head, boundary, ...tail]),
    });
    const chunks = await extractChunksFromTask('cap-test', '/task');

    // Lossless: every emitted message becomes a chunk (no truncation).
    expect(chunks.length).toBe(head.length + 1 + tail.length);

    // The boundary message is at emitted-index MAX_MESSAGES_PER_TASK + 1.
    // Head unit spans [1, MAX_MESSAGES_PER_TASK]; tail unit starts at MAX_MESSAGES_PER_TASK + 1.
    const headChunks = chunks.filter(c => c.child_unit_index === 1);
    const tailChunks = chunks.filter(c => c.child_unit_index === 2);
    expect(headChunks.length).toBe(MAX_MESSAGES_PER_TASK);
    expect(tailChunks.length).toBe(1 + MAX_MESSAGES_PER_TASK);

    // Lineage: tail unit chunks have parent_task_id = head task_id; root_task_id same.
    for (const c of tailChunks) {
      expect(c.task_id).toBe('cap-test#unit-2');
      expect(c.parent_task_id).toBe('cap-test');
      expect(c.root_task_id).toBe('cap-test');
    }
    // Head unit keeps the original task_id (backward compat with filters).
    for (const c of headChunks) {
      expect(c.task_id).toBe('cap-test');
      // parent_task_id / root_task_id from metadata (which is null in this test).
      expect(c.parent_task_id).toBeNull();
      expect(c.root_task_id).toBeNull();
    }
    // Both units declare the same child_unit_total = 2.
    for (const c of chunks) {
      expect(c.child_unit_total).toBe(2);
    }
  });

  it('falls back to count-based paging when NO boundary marker is detected', async () => {
    // Regression guard: a long session WITHOUT markers must still split every
    // MAX_MESSAGES_PER_TASK messages (existing #2825 G2 behavior).
    const many = Array.from({ length: MAX_MESSAGES_PER_TASK + 5 }, (_, i) => ({
      role: 'user', content: `plain-${i}`, timestamp: 't',
    }));
    setupTaskFiles({ metadata: JSON.stringify({}), api: JSON.stringify(many) });
    const chunks = await extractChunksFromTask('plain', '/task');

    expect(chunks.length).toBe(MAX_MESSAGES_PER_TASK + 5);
    const overflowChunk = chunks.find(c => c.task_id === 'plain#unit-2');
    expect(overflowChunk).toBeDefined();
    expect(overflowChunk!.child_unit_index).toBe(2);
    expect(overflowChunk!.child_unit_total).toBe(2);
  });

  it('produces N+1 chapter-aligned units for N boundaries', async () => {
    // 3 boundaries → 4 chapters. Total messages = 4 * MAX_MESSAGES_PER_TASK.
    const chapter = (label: string) =>
      Array.from({ length: MAX_MESSAGES_PER_TASK }, (_, i) => ({
        role: 'user', content: `${label}-${i}`, timestamp: 't',
      }));
    const api = [
      ...chapter('c1'),
      { role: 'user', content: '[CONDENSATION ARCHIVE] end of chapter 1', timestamp: 't' },
      ...chapter('c2'),
      { role: 'user', content: '[Condensation summary] end of chapter 2', timestamp: 't' },
      ...chapter('c3'),
      { role: 'user', content: '[CONDENSATION ARCHIVE] end of chapter 3', timestamp: 't' },
      ...chapter('c4'),
    ];
    // Sanity: the api array has 4*MAX_MESSAGES_PER_TASK + 3 entries.
    expect(api.length).toBe(4 * MAX_MESSAGES_PER_TASK + 3);
    setupTaskFiles({ metadata: JSON.stringify({}), api: JSON.stringify(api) });
    const chunks = await extractChunksFromTask('multi', '/task');

    expect(chunks.length).toBe(api.length);
    // Exactly 4 child units.
    const distinct = new Set(chunks.map(c => c.child_unit_index));
    expect(distinct.size).toBe(4);
    for (const c of chunks) {
      expect(c.child_unit_total).toBe(4);
    }
    // The three boundary messages start units 2, 3, 4.
    const boundaryChunks = chunks.filter(c =>
      c.content.startsWith('[CONDENSATION ARCHIVE]') ||
      c.content.startsWith('[Condensation summary]')
    );
    expect(boundaryChunks.map(c => c.child_unit_index).sort()).toEqual([2, 3, 4]);
    // Each unit's lineage points back to the head task.
    for (let u = 2; u <= 4; u++) {
      const inUnit = chunks.filter(c => c.child_unit_index === u);
      expect(inUnit.length).toBeGreaterThan(0);
      for (const c of inUnit) {
        expect(c.task_id).toBe(`multi#unit-${u}`);
        expect(c.parent_task_id).toBe('multi');
        expect(c.root_task_id).toBe('multi');
      }
    }
  });

  it('boundary detection is robust: a message with the marker is not skipped even if it is the only message', async () => {
    setupTaskFiles({
      metadata: JSON.stringify({}),
      api: JSON.stringify([
        { role: 'user', content: '[CONDENSATION ARCHIVE] 99 messages archived', timestamp: 't' },
      ]),
    });
    const chunks = await extractChunksFromTask('solo', '/task');
    // Single chunk, single unit, head task_id (no overflow).
    expect(chunks.length).toBe(1);
    expect(chunks[0].child_unit_index).toBe(1);
    expect(chunks[0].child_unit_total).toBe(1);
    expect(chunks[0].task_id).toBe('solo');
  });

  it('boundary in ui_messages alone still triggers chapter split', async () => {
    // Boundary lives in the ui stream (not api) — the merger must still pick it up.
    const apiMsgs = Array.from({ length: MAX_MESSAGES_PER_TASK }, (_, i) => ({
      role: 'user', content: `api-${i}`, timestamp: 't',
    }));
    const uiMsgs = [
      { author: 'user', text: 'ui-0', timestamp: 't' },
      { author: 'user', text: '[CONDENSATION ARCHIVE] boundary in ui', timestamp: 't' },
      ...Array.from({ length: 3 }, (_, i) => ({ author: 'user', text: `ui-${i + 1}`, timestamp: 't' })),
    ];
    setupTaskFiles({
      metadata: JSON.stringify({}),
      api: JSON.stringify(apiMsgs),
      ui: JSON.stringify(uiMsgs),
    });
    const chunks = await extractChunksFromTask('ui-cap', '/task');

    expect(chunks.length).toBe(apiMsgs.length + uiMsgs.length);
    // The boundary is the 2nd emitted ui message (= emitted index MAX_MESSAGES_PER_TASK + 2).
    // Head unit = [1, MAX_MESSAGES_PER_TASK + 1]; tail unit = [MAX_MESSAGES_PER_TASK + 2, ...].
    const headChunks = chunks.filter(c => c.child_unit_index === 1);
    const tailChunks = chunks.filter(c => c.child_unit_index === 2);
    expect(headChunks.length).toBe(MAX_MESSAGES_PER_TASK + 1);
    expect(tailChunks.length).toBe(4);
    for (const c of chunks) {
      expect(c.child_unit_total).toBe(2);
    }
  });

  // --- #3763 review fixes: the discriminating tests the original 22 could
  // not be (0 occurrences of tool_calls/tool_use in them). They pin the
  // invariant written at the tool-chunk emission site: tools belong to the
  // same child unit as their parent message, at boundaries included.

  it('#3763 review: tool_calls adjacent to a boundary stay in their parent text unit (was: cursor drift)', async () => {
    // Emitted layout: [1..MAX-1] plain, MAX = text + 2 tool_calls,
    // MAX+1 = boundary marker, then tail. The cut lands at MAX+1 — the
    // tool chunks MUST stay in unit 1 with their parent text chunk.
    // Pre-fix: the cursor heuristic invented MAX+1/MAX+2 for the tools →
    // they landed in unit 2, separated from their parent in unit 1.
    const head = Array.from({ length: MAX_MESSAGES_PER_TASK - 1 }, (_, i) => ({
      role: 'user', content: `head-${i}`, timestamp: 't',
    }));
    const parentMsg = {
      role: 'assistant',
      content: 'parent text with tools',
      tool_calls: [
        { function: { name: 'Read', arguments: '{"file_path":"a.ts"}' } },
        { function: { name: 'Grep', arguments: '{"pattern":"x"}' } },
      ],
      timestamp: 't',
    };
    const boundary = {
      role: 'user',
      content: '[CONDENSATION ARCHIVE] chapter break',
      timestamp: 't',
    };
    const tail = Array.from({ length: 3 }, (_, i) => ({
      role: 'user', content: `tail-${i}`, timestamp: 't',
    }));
    setupTaskFiles({
      metadata: JSON.stringify({}),
      api: JSON.stringify([...head, parentMsg, boundary, ...tail]),
    });
    const chunks = await extractChunksFromTask('tool-boundary', '/task');

    const toolChunks = chunks.filter(c => c.chunk_type === 'tool_interaction');
    expect(toolChunks.length).toBe(2);
    // Stamped with the PARENT message's emitted index (MAX), not invented.
    for (const c of toolChunks) {
      expect(c.message_index).toBe(MAX_MESSAGES_PER_TASK);
      expect(c.child_unit_index).toBe(1);
      expect(c.task_id).toBe('tool-boundary');
    }
    // The parent text chunk is in unit 1 too — same unit as its tools.
    const parentText = chunks.find(c => c.content === 'parent text with tools');
    expect(parentText).toBeDefined();
    expect(parentText!.child_unit_index).toBe(1);
    // Boundary + tail form unit 2; no ghost unit.
    const units = new Set(chunks.map(c => c.child_unit_index));
    expect([...units].sort((a, b) => a - b)).toEqual([1, 2]);
    for (const c of chunks) {
      expect(c.child_unit_total).toBe(2);
    }
    const unit2 = chunks.filter(c => c.child_unit_index === 2);
    expect(unit2.length).toBe(1 + tail.length);
    for (const c of unit2) {
      expect(c.task_id).toBe('tool-boundary#unit-2');
    }
  });

  it('#3763 review: ui boundary after api tool calls yields units {1,2} — no ghost unit 3 (was: cursor accumulation)', async () => {
    // Emitted layout: [1..MAX-1] plain api, MAX = text + 2 tool_calls,
    // then ui messages whose FIRST carries the boundary (emitted MAX+1).
    // Pre-fix: the accumulated cursor (MAX+2 after two invented tool
    // indices) pushed the ui chunks to MAX+3.. → a phantom unit 3.
    const head = Array.from({ length: MAX_MESSAGES_PER_TASK - 1 }, (_, i) => ({
      role: 'user', content: `api-${i}`, timestamp: 't',
    }));
    const parentMsg = {
      role: 'assistant',
      content: 'tools here',
      tool_calls: [
        { function: { name: 'Bash', arguments: '{"command":"ls"}' } },
        { function: { name: 'Bash', arguments: '{"command":"pwd"}' } },
      ],
      timestamp: 't',
    };
    const uiMsgs = [
      { author: 'user', text: '[CONDENSATION ARCHIVE] ui chapter break', timestamp: 't' },
      ...Array.from({ length: 3 }, (_, i) => ({ author: 'user', text: `ui-${i}`, timestamp: 't' })),
    ];
    setupTaskFiles({
      metadata: JSON.stringify({}),
      api: JSON.stringify([...head, parentMsg]),
      ui: JSON.stringify(uiMsgs),
    });
    const chunks = await extractChunksFromTask('ui-after-tools', '/task');

    const units = new Set(chunks.map(c => c.child_unit_index));
    expect([...units].sort((a, b) => a - b)).toEqual([1, 2]);
    for (const c of chunks) {
      expect(c.child_unit_total).toBe(2);
    }
    // Tool chunks share the parent's unit (1) — stamped, not cursor-invented.
    const toolChunks = chunks.filter(c => c.chunk_type === 'tool_interaction');
    expect(toolChunks.length).toBe(2);
    for (const c of toolChunks) {
      expect(c.message_index).toBe(MAX_MESSAGES_PER_TASK);
      expect(c.child_unit_index).toBe(1);
    }
    // Ui chunks stamped with their own emitted indices (MAX+1..MAX+4),
    // all in unit 2.
    const uiChunks = chunks.filter(
      c => c.content.startsWith('ui-') || c.content.startsWith('[CONDENSATION')
    );
    expect(uiChunks.map(c => c.message_index).sort((a, b) => a! - b!)).toEqual([
      MAX_MESSAGES_PER_TASK + 1,
      MAX_MESSAGES_PER_TASK + 2,
      MAX_MESSAGES_PER_TASK + 3,
      MAX_MESSAGES_PER_TASK + 4,
    ]);
    for (const c of uiChunks) {
      expect(c.child_unit_index).toBe(2);
    }
  });
});

describe('ChunkExtractor — #3763 integration: extractChunksFromClaudeSession chapter-aligned paging', () => {
  it('splits at inline boundary in a Claude Code JSONL session', async () => {
    mockStat.mockResolvedValue({ isDirectory: () => false } as any); // direct-file path
    const lines: string[] = [];
    for (let i = 0; i < MAX_MESSAGES_PER_TASK; i++) {
      lines.push(JSON.stringify({ type: 'user', message: { content: `head-${i}` } }));
    }
    lines.push(JSON.stringify({
      type: 'user',
      message: { content: '[CONDENSATION ARCHIVE] chapter break in claude session' },
    }));
    for (let i = 0; i < MAX_MESSAGES_PER_TASK; i++) {
      lines.push(JSON.stringify({ type: 'user', message: { content: `tail-${i}` } }));
    }
    pushStream(lines.join('\n'));

    const chunks = await extractChunksFromClaudeSession('claude-cap', '/proj/session.jsonl');
    expect(chunks.length).toBe(2 * MAX_MESSAGES_PER_TASK + 1);

    const headChunks = chunks.filter(c => c.child_unit_index === 1);
    const tailChunks = chunks.filter(c => c.child_unit_index === 2);
    expect(headChunks.length).toBe(MAX_MESSAGES_PER_TASK);
    expect(tailChunks.length).toBe(1 + MAX_MESSAGES_PER_TASK);
    for (const c of chunks) {
      expect(c.child_unit_total).toBe(2);
    }
    for (const c of tailChunks) {
      expect(c.task_id).toBe('claude-cap#unit-2');
      expect(c.parent_task_id).toBe('claude-cap');
      expect(c.root_task_id).toBe('claude-cap');
    }
  });

  it('falls back to count-based paging when Claude JSONL has no boundary markers', async () => {
    mockStat.mockResolvedValue({ isDirectory: () => false } as any);
    const lines = Array.from({ length: MAX_MESSAGES_PER_TASK + 3 }, (_, i) =>
      JSON.stringify({ type: 'user', message: { content: `c-${i}` } })).join('\n');
    pushStream(lines);

    const chunks = await extractChunksFromClaudeSession('claude-no-boundary', '/proj/session.jsonl');
    expect(chunks.length).toBe(MAX_MESSAGES_PER_TASK + 3);
    const overflow = chunks.find(c => c.task_id === 'claude-no-boundary#unit-2');
    expect(overflow).toBeDefined();
    expect(overflow!.child_unit_index).toBe(2);
    expect(overflow!.child_unit_total).toBe(2);
  });

  it('#3763 review: JSONL tool_use after a boundary lands in its parent unit (was: pinned to unit 1)', async () => {
    // Emitted layout: [1..MAX] plain, MAX+1 = boundary, MAX+2 = assistant
    // text + tool_use, MAX+3..MAX+4 = tail. The tool chunk belongs to
    // unit 2 with its parent. Pre-fix: the `?? fileStartLocal` fallback
    // collapsed EVERY tool chunk onto local index 1 → unit 1, whatever
    // its real chapter.
    mockStat.mockResolvedValue({ isDirectory: () => false } as any);
    const lines: string[] = [];
    for (let i = 0; i < MAX_MESSAGES_PER_TASK; i++) {
      lines.push(JSON.stringify({ type: 'user', message: { content: `head-${i}` } }));
    }
    lines.push(JSON.stringify({
      type: 'user',
      message: { content: '[CONDENSATION ARCHIVE] break' },
    }));
    lines.push(JSON.stringify({
      type: 'assistant',
      message: { content: [
        { type: 'text', text: 'parent with tool_use' },
        { type: 'tool_use', name: 'Read', input: { file_path: 'x.ts' } },
      ] },
    }));
    for (let i = 0; i < 2; i++) {
      lines.push(JSON.stringify({ type: 'user', message: { content: `tail-${i}` } }));
    }
    pushStream(lines.join('\n'));

    const chunks = await extractChunksFromClaudeSession('claude-tool-boundary', '/proj/session.jsonl');
    const toolChunks = chunks.filter(c => c.chunk_type === 'tool_interaction');
    expect(toolChunks.length).toBe(1);
    // Stamped with the parent message's emitted index (MAX+2) → unit 2.
    expect(toolChunks[0].message_index).toBe(MAX_MESSAGES_PER_TASK + 2);
    expect(toolChunks[0].child_unit_index).toBe(2);
    expect(toolChunks[0].task_id).toBe('claude-tool-boundary#unit-2');
    // Parent text chunk in unit 2 as well — same unit as its tool.
    const parentText = chunks.find(c => c.content === 'parent with tool_use');
    expect(parentText).toBeDefined();
    expect(parentText!.child_unit_index).toBe(2);
    const units = new Set(chunks.map(c => c.child_unit_index));
    expect([...units].sort((a, b) => a - b)).toEqual([1, 2]);
    for (const c of chunks) {
      expect(c.child_unit_total).toBe(2);
    }
  });
});
