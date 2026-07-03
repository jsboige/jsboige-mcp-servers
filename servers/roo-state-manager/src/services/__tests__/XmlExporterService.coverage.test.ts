/**
 * #833 Sprint C3 — XmlExporterService branch coverage (po-2026 lane `src/services/**`)
 *
 * The base `XmlExporterService.test.ts` (30+ tests) covers generateTaskXml
 * structure/messages/actions, generateConversationXml hierarchy/maxDepth,
 * generateProjectXml summary/date-filtering, and validateFilePath via
 * saveXmlToFile (traversal, absolute `/`, too-long, `<`/`>` chars). It leaves a
 * cluster of genuine conditional branches cold:
 *
 * - `sequence ?? []` nullish coalescing (L61, L146): base always passes an
 *   array (often `[]`) — the undefined/null fallback is never exercised.
 * - action optional attrs `line_count` (L87) and `content_size` (L88): base
 *   asserts `file_path` (L86) only; these two spread arms are cold.
 * - generateConversationXml **action optional attrs** (file_path/line_count/
 *   content_size/parameters) — the conversation path duplicates the action
 *   logic (L159-171) but base conversation tests only check structure + depth.
 * - generateConversationXml **content truncation** (L154-156): base conversation
 *   tests never pass options.includeContent, so the truncate-vs-full branch in
 *   the conversation path is cold.
 * - generateProjectXml **taskCount with children** (L247-248): base "exclut les
 *   enfants" counts roots=1 but never a root WITH children to verify
 *   `taskCount = 1 + childCount`.
 * - generateProjectXml **title attribute** on conversation (L252): base never
 *   asserts the title surfaces in the project conversation element.
 * - validateFilePath **backslash-absolute** (L268 `/^[\/\\]/`): base tests
 *   forward-slash `/etc` only — the `\\` arm is cold.
 * - validateFilePath **remaining forbidden chars** (L269 `:"|?*`): base tests
 *   `<` and `>` only — `:`, `"`, `|`, `?`, `*` are cold.
 * - validateFilePath **distinct error codes** PATH_TRAVERSAL_DETECTED vs
 *   PATH_TOO_LONG (L275, L285): base asserts `instanceof StateManagerError`
 *   but never the specific `.code`.
 * - saveXmlToFile **mkdir invocation** (L303): base asserts writeFile called,
 *   never that the parent dir was created.
 * - generateTaskXml **prettyPrint=false** (L97): base always uses the default
 *   `prettyPrint=true` — the compact arm is cold.
 *
 * A regression in any of these branches would pass the nominal suite silently.
 * This add-only file pins them, each assertion anchored on a source line of
 * `XmlExporterService.ts`. Reuses the established fs/promises hoisted mock.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const { mockMkdir, mockWriteFile } = vi.hoisted(() => ({
  mockMkdir: vi.fn().mockResolvedValue(undefined),
  mockWriteFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('fs/promises', () => ({
  default: {
    mkdir: (...args: any[]) => mockMkdir(...args),
    writeFile: (...args: any[]) => mockWriteFile(...args),
  },
  mkdir: (...args: any[]) => mockMkdir(...args),
  writeFile: (...args: any[]) => mockWriteFile(...args),
}));

import { XmlExporterService } from '../XmlExporterService.js';
import type { ConversationSkeleton, MessageSkeleton, ActionMetadata } from '../../types/conversation.js';
import { StateManagerError } from '../../types/errors.js';

// ─────────────────── helpers ───────────────────

function makeMessage(overrides: Partial<MessageSkeleton> = {}): MessageSkeleton {
  return {
    role: 'user',
    content: 'Test message content',
    timestamp: '2026-01-01T10:00:00Z',
    isTruncated: false,
    ...overrides,
  };
}

function makeAction(overrides: Partial<ActionMetadata> = {}): ActionMetadata {
  return {
    type: 'tool',
    name: 'read_file',
    parameters: { path: '/tmp/test.ts' },
    status: 'success',
    timestamp: '2026-01-01T10:01:00Z',
    ...overrides,
  };
}

function makeSkeleton(overrides: Partial<ConversationSkeleton> = {}): ConversationSkeleton {
  return {
    taskId: 'task-001',
    metadata: {
      title: 'Test Task',
      lastActivity: '2026-01-01T12:00:00Z',
      createdAt: '2026-01-01T10:00:00Z',
      mode: 'code',
      messageCount: 2,
      actionCount: 1,
      totalSize: 1024,
    },
    sequence: [],
    ...overrides,
  };
}

let service: XmlExporterService;

beforeEach(() => {
  service = new XmlExporterService();
  vi.clearAllMocks();
  mockMkdir.mockResolvedValue(undefined);
  mockWriteFile.mockResolvedValue(undefined);
});

describe('XmlExporterService — branch coverage (#833 C3, source-grounded)', () => {

  // ============================================================
  // sequence ?? [] nullish fallback (L61, L146)
  // ============================================================
  describe('generateTaskXml — sequence ?? [] nullish fallback (L61)', () => {
    test('a null/undefined sequence does not throw and still emits <sequence> (L61)', () => {
      const skeleton = makeSkeleton();
      // Force sequence to undefined to hit the `?? []` fallback (L61).
      (skeleton as any).sequence = undefined;
      expect(() => service.generateTaskXml(skeleton)).not.toThrow();
      const xml = service.generateTaskXml(skeleton);
      expect(xml).toContain('<sequence');
      // No message/action elements when sequence is empty after the fallback.
      expect(xml).not.toContain('<message role=');
    });

    test('a null sequence is also tolerated (L61)', () => {
      const skeleton = makeSkeleton();
      (skeleton as any).sequence = null;
      expect(() => service.generateTaskXml(skeleton)).not.toThrow();
    });
  });

  // ============================================================
  // action optional attrs line_count + content_size (L87, L88)
  // ============================================================
  describe('generateTaskXml — action line_count/content_size attrs (L87, L88)', () => {
    test('line_count surfaces as lineCount attribute (L87)', () => {
      const skeleton = makeSkeleton({
        sequence: [makeAction({ line_count: 42 } as any)],
      });
      const xml = service.generateTaskXml(skeleton);
      expect(xml).toContain('lineCount');
      expect(xml).toContain('42');
    });

    test('content_size surfaces as contentSize attribute (L88)', () => {
      const skeleton = makeSkeleton({
        sequence: [makeAction({ content_size: 4096 } as any)],
      });
      const xml = service.generateTaskXml(skeleton);
      expect(xml).toContain('contentSize');
      expect(xml).toContain('4096');
    });
  });

  // ============================================================
  // generateTaskXml — prettyPrint=false compact arm (L97)
  // ============================================================
  describe('generateTaskXml — prettyPrint=false (L97)', () => {
    test('compact output omits the pretty indentation newlines (L97, L32 default true)', () => {
      const pretty = service.generateTaskXml(makeSkeleton(), { prettyPrint: true });
      const compact = service.generateTaskXml(makeSkeleton(), { prettyPrint: false });
      // Pretty output contains newlines between elements; compact collapses them.
      expect(pretty.split('\n').length).toBeGreaterThan(compact.split('\n').length);
      // Both still well-formed (carry the root + declaration).
      expect(compact).toContain('<?xml');
      expect(compact).toContain('<task');
    });
  });

  // ============================================================
  // generateConversationXml — action optional attrs (L159-171)
  // ============================================================
  describe('generateConversationXml — action attrs in conversation path (L159-171)', () => {
    test('action file_path + parameters render in conversation XML (L164, L169-171)', () => {
      const root = makeSkeleton({
        taskId: 'root-001',
        sequence: [makeAction({ name: 'write_file', file_path: '/src/a.ts', parameters: { k: 'v' } })],
      });
      const xml = service.generateConversationXml(root, []);
      expect(xml).toContain('filePath');
      expect(xml).toContain('<parameters>');
    });

    test('action line_count + content_size render in conversation XML (L165-167)', () => {
      const root = makeSkeleton({
        taskId: 'root-001',
        sequence: [makeAction({ line_count: 7, content_size: 99 } as any)],
      });
      const xml = service.generateConversationXml(root, []);
      expect(xml).toContain('lineCount');
      expect(xml).toContain('contentSize');
    });

    test('action without parameters omits <parameters> in conversation path (L169 guard)', () => {
      const root = makeSkeleton({
        taskId: 'root-001',
        sequence: [makeAction({ parameters: {} })],
      });
      const xml = service.generateConversationXml(root, []);
      expect(xml).not.toContain('<parameters>');
    });
  });

  // ============================================================
  // generateConversationXml — content truncation branch (L154-156)
  // ============================================================
  describe('generateConversationXml — content truncation in conversation path (L154-156)', () => {
    test('without includeContent: long message content is truncated with "..." (L156)', () => {
      const root = makeSkeleton({
        taskId: 'root-001',
        sequence: [makeMessage({ content: 'B'.repeat(250) })],
      });
      const xml = service.generateConversationXml(root, []);
      expect(xml).toContain('...');
    });

    test('with includeContent=true: full content preserved, no truncation (L154-155)', () => {
      const root = makeSkeleton({
        taskId: 'root-001',
        sequence: [makeMessage({ content: 'C'.repeat(150) })],
      });
      const xml = service.generateConversationXml(root, [], { includeContent: true });
      expect(xml).not.toContain('...');
    });
  });

  // ============================================================
  // generateProjectXml — taskCount with children + title attr (L247-248, L252)
  // ============================================================
  describe('generateProjectXml — childCount/taskCount + title attribute (L247-248, L252)', () => {
    test('a root with children reports taskCount = 1 + childCount (L247-248)', () => {
      const root = makeSkeleton({ taskId: 'root-1' });
      const childA = makeSkeleton({ taskId: 'child-a', parentTaskId: 'root-1' });
      const childB = makeSkeleton({ taskId: 'child-b', parentTaskId: 'root-1' });
      const xml = service.generateProjectXml([root, childA, childB], '/project');
      // taskCount for root-1 = 1 (root) + 2 (children) = 3.
      expect(xml).toContain('taskCount="3"');
    });

    test('conversation element carries the title attribute when present (L252)', () => {
      const root = makeSkeleton({ taskId: 'root-titled', metadata: { ...makeSkeleton().metadata, title: 'Unique Proj Title' } });
      const xml = service.generateProjectXml([root], '/project');
      expect(xml).toContain('title="Unique Proj Title"');
    });
  });

  // ============================================================
  // validateFilePath — backslash-absolute + remaining forbidden chars + codes
  // (L268, L269, L275, L285)
  // ============================================================
  describe('validateFilePath — backslash-absolute + remaining forbidden chars + codes (L268-289)', () => {
    test('backslash-absolute path matches ^[\\/\\\\] (L268) with PATH_TRAVERSAL code', async () => {
      try {
        await service.saveXmlToFile('<xml/>', '\\etc\\passwd');
        throw new Error('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(StateManagerError);
        expect((err as StateManagerError).code).toBe('PATH_TRAVERSAL_DETECTED');
      }
    });

    test.each([':', '"', '|', '?', '*'])('forbidden char %s matches [<>:"|?*] (L269) with PATH_TRAVERSAL code', async (ch) => {
      try {
        await service.saveXmlToFile('<xml/>', `bad${ch}name.xml`);
        throw new Error('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(StateManagerError);
        expect((err as StateManagerError).code).toBe('PATH_TRAVERSAL_DETECTED');
      }
    });

    test('too-long path (>260) yields PATH_TOO_LONG code distinct from traversal (L285)', async () => {
      // 'a/'.repeat(130) + 'file.xml' = 263 chars, no traversal/abs/forbidden.
      const longPath = 'a/'.repeat(130) + 'file.xml';
      expect(longPath.length).toBeGreaterThan(260);
      try {
        await service.saveXmlToFile('<xml/>', longPath);
        throw new Error('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(StateManagerError);
        expect((err as StateManagerError).code).toBe('PATH_TOO_LONG');
      }
    });

    test('traversal ../ path yields PATH_TRAVERSAL_DETECTED code specifically (L275)', async () => {
      try {
        await service.saveXmlToFile('<xml/>', '../secret');
        throw new Error('should have thrown');
      } catch (err) {
        expect((err as StateManagerError).code).toBe('PATH_TRAVERSAL_DETECTED');
      }
    });
  });

  // ============================================================
  // saveXmlToFile — mkdir invocation (L303)
  // ============================================================
  describe('saveXmlToFile — parent dir creation (L303)', () => {
    test('creates the parent directory recursively before writing (L302-303)', async () => {
      await service.saveXmlToFile('<xml/>', 'output/sub/test.xml');
      expect(mockMkdir).toHaveBeenCalledTimes(1);
      // mkdir is called with dirname('output/sub/test.xml') + { recursive: true } (L303).
      const args = mockMkdir.mock.calls[0];
      expect(args[0]).toBe('output/sub');
      expect(args[1]).toEqual({ recursive: true });
      expect(mockWriteFile).toHaveBeenCalledWith('output/sub/test.xml', '<xml/>', 'utf-8');
    });
  });
});
