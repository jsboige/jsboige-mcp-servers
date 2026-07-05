/**
 * Coverage complement for SummaryGenerator — #833 Sprint C4 (Vein A).
 *
 * Add-only, tests-only. Pins the cold branches that the nominal suite
 * (SummaryGenerator.test.ts — "méthodes pures") never enters:
 *
 *  getOriginalContentSize:
 *   - sequence undefined (nullish `?? []` L202)                  (nominal always passes [])
 *   - role-only item (no `content` key) → filtered out           (nominal uses toolName-only)
 *   - content-only item (no `role` key) → filtered out
 *
 *  mergeWithDefaultOptions:
 *   - enableDetailLevels:false (explicit false gate L180)        (nominal only tests true)
 *   - hideEnvironmentDetails:false (explicit false L184)         (nominal only tests true)
 *   - jsonVariant / csvVariant passthrough (L177-178)            (nominal never sets these)
 *
 *  calculateStatistics:
 *   - 1-decimal rounding for non-clean split (L160-162 `*10)/10`)
 *   - percentage for a 0-category when total > 0
 *
 *  generateSummary (L25-109 — ENTIRE orchestrator untested by nominal):
 *   - success path, interactive branch (enableDetailLevels default true)
 *   - success path, standard branch (enableDetailLevels:false → else L79-87)
 *   - catch path (classifier throws on endIndex < 0 → L101-108 error result)
 *
 * Mock strategy: identical to nominal suite — NO module-level vi.mock.
 * generateSummary's catch is triggered by a real classifier throw
 * (classifyConversationContent L38 rejects endIndex < 0), no fault injection.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { SummaryGenerator } from '../SummaryGenerator.js';
import type { ClassifiedContent } from '../ContentClassifier.js';
import type { ConversationSkeleton } from '../../../../types/conversation.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeClassified(
  subType: ClassifiedContent['subType'],
  content: string,
  type: 'User' | 'Assistant' = 'User',
): ClassifiedContent {
  return {
    type,
    subType,
    content,
    index: 0,
    contentSize: content.length,
    isRelevant: true,
    confidenceScore: 1,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SummaryGenerator — coverage complement', () => {
  let generator: SummaryGenerator;

  beforeEach(() => {
    generator = new SummaryGenerator();
  });

  // ── getOriginalContentSize cold branches (L202) ──

  describe('getOriginalContentSize — nullish + filter edges', () => {
    test('returns 0 when sequence is undefined (nullish `?? []` L202)', () => {
      // Cast: ConversationSkeleton.sequence is typed required, but the guard
      // exists precisely for runtime-undefined inputs.
      const conv = { taskId: 't1' } as unknown as ConversationSkeleton;
      expect(generator.getOriginalContentSize(conv)).toBe(0);
    });

    test('filters out items that have role but no content key', () => {
      const conv = {
        taskId: 't1',
        sequence: [
          { role: 'user' }, // no `content` → filtered
          { role: 'assistant', content: 'yes' }, // 3 chars — kept
        ],
      } as unknown as ConversationSkeleton;
      expect(generator.getOriginalContentSize(conv)).toBe(3);
    });

    test('filters out items that have content but no role key', () => {
      const conv = {
        taskId: 't1',
        sequence: [
          { content: 'orphan' }, // no `role` → filtered
          { role: 'user', content: 'kept' }, // 4 chars — kept
        ],
      } as unknown as ConversationSkeleton;
      expect(generator.getOriginalContentSize(conv)).toBe(4);
    });
  });

  // ── mergeWithDefaultOptions cold branches (L177-186) ──

  describe('mergeWithDefaultOptions — false-gate + passthrough', () => {
    test('enableDetailLevels:false (explicit false, L180 `!== false` gate)', () => {
      const opts = generator.mergeWithDefaultOptions({ enableDetailLevels: false });
      expect(opts.enableDetailLevels).toBe(false);
    });

    test('hideEnvironmentDetails:false (explicit false, L184 `!== undefined` gate)', () => {
      const opts = generator.mergeWithDefaultOptions({ hideEnvironmentDetails: false });
      expect(opts.hideEnvironmentDetails).toBe(false);
    });

    test('passes jsonVariant through (L177)', () => {
      const opts = generator.mergeWithDefaultOptions({ jsonVariant: 'light' });
      expect(opts.jsonVariant).toBe('light');
    });

    test('passes csvVariant through (L178)', () => {
      const opts = generator.mergeWithDefaultOptions({ csvVariant: 'messages' });
      expect(opts.csvVariant).toBe('messages');
    });

    test('jsonVariant/csvVariant default to undefined when not provided', () => {
      const opts = generator.mergeWithDefaultOptions({});
      expect(opts.jsonVariant).toBeUndefined();
      expect(opts.csvVariant).toBeUndefined();
    });
  });

  // ── calculateStatistics rounding + zero-category (L160-162) ──

  describe('calculateStatistics — rounding + zero-category edges', () => {
    test('rounds non-clean percentages to 1 decimal (L160-162 `Math.round(x*100*10)/10`)', () => {
      // userContentSize=1, assistantContentSize=2 → total=3
      // userPercentage = round(33.333.. *10)/10 = 33.3
      const content: ClassifiedContent[] = [
        makeClassified('UserMessage', 'A', 'User'),          // size 1
        makeClassified('Completion', 'BB', 'Assistant'),     // size 2
      ];
      const stats = generator.calculateStatistics(content);
      expect(stats.totalContentSize).toBe(3);
      expect(stats.userPercentage).toBe(33.3);
      expect(stats.assistantPercentage).toBe(66.7);
    });

    test('reports 0 percentage for an absent category when total > 0', () => {
      // Only user content → assistant + toolResults categories are 0
      const content: ClassifiedContent[] = [
        makeClassified('UserMessage', 'hello', 'User'), // size 5
      ];
      const stats = generator.calculateStatistics(content);
      expect(stats.totalContentSize).toBe(5);
      expect(stats.userPercentage).toBe(100);
      expect(stats.assistantPercentage).toBe(0);
      expect(stats.toolResultsPercentage).toBe(0);
    });
  });

  // ── generateSummary orchestrator (L25-109 — uncovered by nominal) ──

  describe('generateSummary — 3 branches', () => {
    test('success path: interactive branch (enableDetailLevels default true, L44-77)', async () => {
      const conv = {
        taskId: 't1',
        metadata: {
          lastActivity: '2026-07-05T10:00:00Z',
          createdAt: '2026-07-05T09:00:00Z',
          messageCount: 2,
          actionCount: 0,
          totalSize: 22,
        },
        sequence: [
          { role: 'user', content: 'Hello world' },
          { role: 'assistant', content: 'Hi there' },
        ],
      } as unknown as ConversationSkeleton;

      const result = await generator.generateSummary(conv);

      expect(result.success).toBe(true);
      expect(typeof result.content).toBe('string');
      expect(result.content.length).toBeGreaterThan(0);
      expect(result.error).toBeUndefined();
      // compressionRatio computed in the success return (L92-98)
      expect(result.statistics).toBeDefined();
      expect(typeof result.statistics.compressionRatio).toBe('number');
    });

    test('success path: standard branch via enableDetailLevels:false (else L79-87)', async () => {
      const conv = {
        taskId: 't2',
        metadata: {
          lastActivity: '2026-07-05T10:00:00Z',
          createdAt: '2026-07-05T09:00:00Z',
          messageCount: 2,
          actionCount: 0,
          totalSize: 8,
        },
        sequence: [
          { role: 'user', content: 'Ping' },
          { role: 'assistant', content: 'Pong' },
        ],
      } as unknown as ConversationSkeleton;

      const result = await generator.generateSummary(conv, { enableDetailLevels: false });

      expect(result.success).toBe(true);
      expect(typeof result.content).toBe('string');
      expect(result.content.length).toBeGreaterThan(0);
      expect(result.error).toBeUndefined();
    });

    test('catch path: classifier throws on endIndex<0 → error result (L101-108)', async () => {
      const conv = {
        taskId: 't3',
        sequence: [{ role: 'user', content: 'x' }],
      } as unknown as ConversationSkeleton;

      // classifyConversationContent (ContentClassifier L38) rejects endIndex < 0.
      // generateSummary catch (L101-108) must surface it as a structured error result.
      const result = await generator.generateSummary(conv, { endIndex: -1 });

      expect(result.success).toBe(false);
      expect(result.content).toBe('');
      expect(result.error).toMatch(/Invalid endIndex/);
      // catch returns the empty-statistics factory (L211-225)
      expect(result.statistics.totalSections).toBe(0);
      expect(result.statistics.totalContentSize).toBe(0);
    });
  });
});
