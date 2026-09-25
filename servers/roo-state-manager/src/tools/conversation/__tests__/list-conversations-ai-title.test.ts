/**
 * #3174 FAIL 1 — `list` must expose the ai-title for Claude sessions.
 *
 * Reproduction (po-2026, dispatch ai-01 25/09 13:37Z): sessions whose JSONL
 * carries `type: "ai-title"` entries (Claude Code's generated title) render
 * with no title in the `list` output — the detector path exposes it
 * (claude-storage-detector.extractTitle) but the list tool's own
 * extractClaudeJsonlMetadata never parses those entries, so metadata.title
 * falls back to the derived-from-first-user-message title (empty or
 * "/executor"-style for slash-command sessions).
 *
 * Covered fix sites:
 *  1. extractClaudeJsonlMetadata parses ai-title entries in head AND tail
 *     chunks — last in file order wins (mirrors the detector).
 *  2. The skeletonMap promotion guard treats a bare placeholder ("-",
 *     ≤1 char) as absent, so metadata.title is promoted.
 *  3. A real pre-extracted first user message still wins over the title
 *     (precedence regression guard).
 *
 * Fixtures are real JSONL files in a temp dir driven through the public
 * handler with ClaudeStorageDetector.detectStorageLocations mocked to that
 * dir — extractClaudeJsonlMetadata runs for real on them (fs.open + chunked
 * reads, no readFile dependency).
 */

import { describe, test, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

const { mockScanDisk, mockDetectClaudeLocations } = vi.hoisted(() => ({
  mockScanDisk: vi.fn().mockResolvedValue([]),
  mockDetectClaudeLocations: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../task/disk-scanner.js', () => ({
  scanDiskForNewTasks: (...args: any[]) => mockScanDisk(...args),
  evictGoneLocalTasks: vi.fn(async () => ({ evicted: [], skippedRemote: 0, failOpenRoo: true, failOpenClaude: true })),
}));

vi.mock('../../../utils/claude-storage-detector.js', () => ({
  ClaudeStorageDetector: {
    detectStorageLocations: (...args: any[]) => mockDetectClaudeLocations(...args),
    analyzeConversation: vi.fn(),
  },
}));

import { listConversationsTool } from '../list-conversations.tool.js';
import { RooStorageDetector } from '../../../utils/roo-storage-detector.js';
import type { ConversationSkeleton } from '../../../types/conversation.js';

// ─────────────────── fixture builders ───────────────────

const TS = '2026-09-25T12:00:00.000Z';

function userLine(content: string): string {
  return JSON.stringify({ type: 'user', timestamp: TS, cwd: 'D:/virtual/ai-title-ws', message: { role: 'user', content } });
}

function assistantLine(content: string): string {
  return JSON.stringify({ type: 'assistant', timestamp: TS, message: { role: 'assistant', content } });
}

function aiTitleLine(aiTitle: string): string {
  // ai-title entries carry no timestamp (#3174 — see types/claude-storage.ts)
  return JSON.stringify({ type: 'ai-title', aiTitle });
}

/** >48KB session whose ai-title lives in the tail chunk only (plus an earlier
 *  one in the head chunk that must NOT win — last in file order does). */
function buildLargeSessionLines(): string[] {
  const lines: string[] = [
    userLine('b padding question'),
    aiTitleLine('B head title (must be overridden)'),
  ];
  // ~600 B per line × 95 lines ≈ 57 KB — pushes the final ai-title past the
  // 48 KB head-chunk boundary.
  const pad = 'x'.repeat(600);
  for (let i = 0; i < 95; i++) {
    lines.push(assistantLine(pad));
  }
  lines.push(aiTitleLine('B tail title wins'));
  return lines;
}

// ─────────────────── helpers ───────────────────

function makeCacheSkeleton(taskId: string, title: string, claudeFirst?: string): ConversationSkeleton {
  const s: any = {
    taskId,
    sequence: [],
    metadata: {
      workspace: '/workspace/test',
      lastActivity: '2026-01-15T12:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
      messageCount: 5,
      actionCount: 2,
      totalSize: 512,
      title,
    },
  };
  if (claudeFirst !== undefined) {
    s._claudeFirstUserMessage = claudeFirst;
  }
  return s as ConversationSkeleton;
}

async function listAll(cache: Map<string, ConversationSkeleton>): Promise<Map<string, any>> {
  const result = await listConversationsTool.handler({ source: 'all' } as any, cache);
  const text = (result.content[0] as any).text;
  const response = JSON.parse(text);
  const conversations = response.conversations ?? response;
  return new Map(conversations.map((c: any) => [c.taskId, c]));
}

// ─────────────────── scan-path tests (real JSONL fixtures) ───────────────────

describe('list exposes ai-title for Claude JSONL sessions (#3174)', () => {
  // scanClaudeSessions caches results for 60 s (module-level TTL): all three
  // fixtures share ONE project dir so a single scan sees them all and later
  // tests in this describe read the same cached set.
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'list-ai-title-test-'));
    await writeFile(path.join(tmpDir, 'sessA.jsonl'), [
      userLine('<command-message>/executor</command-message>'),
      assistantLine('working'),
      aiTitleLine('Session A head title\nsecond line must be dropped'),
      userLine('real follow-up question'),
    ].join('\n') + '\n', 'utf8');
    await writeFile(path.join(tmpDir, 'sessB.jsonl'), buildLargeSessionLines().join('\n') + '\n', 'utf8');
    await writeFile(path.join(tmpDir, 'sessC.jsonl'), [
      userLine('plain deployment question'),
      assistantLine('answer'),
    ].join('\n') + '\n', 'utf8');
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    mockScanDisk.mockResolvedValue([]);
    mockDetectClaudeLocations.mockResolvedValue([
      { projectPath: tmpDir, projectName: 'ai-title-test' },
    ]);
    vi.spyOn(RooStorageDetector, 'detectStorageLocations').mockResolvedValue(['/mock/storage']);
  });

  test('ai-title in head chunk becomes metadata.title (multi-line: first line, 80-char rule)', async () => {
    const byTask = await listAll(new Map());
    const conv = byTask.get('claude-ai-title-test--sessA');
    expect(conv).toBeDefined();
    expect(conv.metadata.title).toBe('Session A head title');
  });

  test('ai-title in tail chunk wins over an earlier head ai-title (last in file order)', async () => {
    const byTask = await listAll(new Map());
    const conv = byTask.get('claude-ai-title-test--sessB');
    expect(conv).toBeDefined();
    expect(conv.metadata.title).toBe('B tail title wins');
  });

  test('no ai-title → derived title unchanged (regression guard)', async () => {
    const byTask = await listAll(new Map());
    const conv = byTask.get('claude-ai-title-test--sessC');
    expect(conv).toBeDefined();
    // Derived title equals the first user message — toConversationSummary drops
    // meta.title as redundant, so the guard is the preview itself.
    expect(conv.firstUserMessage).toBe('plain deployment question');
    expect(conv.metadata.title).toBeUndefined();
  });
});

// ─────────────────── promotion-guard tests (cache path, no scan) ───────────────────

describe('skeletonMap promotes metadata.title over placeholder previews (#3174)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockScanDisk.mockResolvedValue([]);
    mockDetectClaudeLocations.mockResolvedValue([]);
    vi.spyOn(RooStorageDetector, 'detectStorageLocations').mockResolvedValue(['/mock/storage']);
  });

  test('missing preview → title promoted (existing behavior kept)', async () => {
    const cache = new Map([['roo-x', makeCacheSkeleton('roo-x', 'X promoted from missing')]]);
    const byTask = await listAll(cache);
    expect(byTask.get('roo-x').firstUserMessage).toBe('X promoted from missing');
  });

  test('"-" placeholder preview → title promoted (new guard)', async () => {
    const cache = new Map([['roo-y', makeCacheSkeleton('roo-y', 'Y title over placeholder', '-')]]);
    const byTask = await listAll(cache);
    expect(byTask.get('roo-y').firstUserMessage).toBe('Y title over placeholder');
  });

  test('real pre-extracted preview wins over title (precedence regression guard)', async () => {
    const cache = new Map([['roo-z', makeCacheSkeleton('roo-z', 'Z title must not override', 'Z real first message')]]);
    const byTask = await listAll(cache);
    expect(byTask.get('roo-z').firstUserMessage).toBe('Z real first message');
  });
});
