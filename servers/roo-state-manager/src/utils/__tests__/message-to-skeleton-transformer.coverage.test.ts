/**
 * Coverage-complement tests for MessageToSkeletonTransformer (Sprint C3, utils m-z lane).
 *
 * Companion to message-to-skeleton-transformer.test.ts. Targets the reachable cold
 * branches left uncovered by the base suite (baseline 88.37% L / 81.69% B, measured
 * 2026-07-03 firsthand). Every case drives a previously-uncovered branch through the
 * PUBLIC transform() API:
 *   - buildMainInstruction strategy 1 (<task>) with normalizePrefixes:false (src L164-166 false arm)
 *   - buildChildTaskPrefixes else branch, raw trim (src L207-211)
 *   - detectCompletion criterion 2 `|| ''` fallback when last say has no subtype (src L236)
 *   - validateSkeletonCompatibility throws reachable via transform(): taskId missing (L264-266),
 *     lastActivity < createdAt (L276-278), child prefix > 192 chars (L290-292)
 *   - autoDetectWorkspace empty-text `continue` (src L318-320)
 *
 * The final describe documents branches that are structurally UNREACHABLE through the
 * public API (skip-with-evidence, #1936) so the residual gap is intentional, not a hole.
 *
 * Add-only: no source touched. Mirrors the base suite's mock wiring.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Shared mock instance that all UIMessagesDeserializer instances resolve to.
const sharedDeserializerMock = {
  extractToolCalls: vi.fn().mockReturnValue([]),
  extractNewTasks: vi.fn().mockReturnValue([]),
  extractApiRequests: vi.fn().mockReturnValue([]),
};

vi.mock('../ui-messages-deserializer.js', () => ({
  UIMessagesDeserializer: vi.fn().mockImplementation(() => sharedDeserializerMock),
}));

vi.mock('../workspace-detector.js', () => ({
  WorkspaceDetector: vi.fn().mockImplementation(() => ({})),
}));

// The mock lowercases; any raw (non-lowercased) assertion below therefore proves the
// normalizePrefixes:false arm was taken (which bypasses computeInstructionPrefix entirely).
vi.mock('../task-instruction-index.js', () => ({
  computeInstructionPrefix: vi.fn((text: string, k: number) =>
    text.toLowerCase().substring(0, k).trim()
  ),
}));

import { MessageToSkeletonTransformer } from '../message-to-skeleton-transformer.js';
import { UIMessagesDeserializer } from '../ui-messages-deserializer.js';
import type { UIMessage } from '../message-types.js';

function createUIMessage(overrides?: Partial<UIMessage>): UIMessage {
  return {
    ts: Date.now(),
    type: 'say',
    say: 'text',
    text: 'Hello world',
    ...overrides,
  };
}

describe('MessageToSkeletonTransformer — coverage complement (Sprint C3)', () => {
  beforeEach(() => {
    sharedDeserializerMock.extractToolCalls.mockReset().mockReturnValue([]);
    sharedDeserializerMock.extractNewTasks.mockReset().mockReturnValue([]);
    sharedDeserializerMock.extractApiRequests.mockReset().mockReturnValue([]);
    (UIMessagesDeserializer as any).mockImplementation(() => sharedDeserializerMock);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  // === buildMainInstruction — strategy 1 (<task>) with normalizePrefixes:false (src L164-166) ===
  describe('buildMainInstruction strategy 1, normalizePrefixes:false', () => {
    it('uses raw substring(0,192) (not computeInstructionPrefix) for the <task> path', async () => {
      const t = new MessageToSkeletonTransformer({ normalizePrefixes: false });
      sharedDeserializerMock.extractApiRequests.mockReturnValue([
        { request: '<task>BUILD The Project</task>' },
      ]);

      const result = await t.transform([createUIMessage({ ts: 1000 })], 'task-raw-task');

      // Case preserved → the substring arm ran, not the lowercasing mock.
      expect(result.skeleton.truncatedInstruction).toBe('BUILD The Project');
    });

    it('truncates a >192-char <task> instruction to 192 chars, raw', async () => {
      const t = new MessageToSkeletonTransformer({ normalizePrefixes: false });
      sharedDeserializerMock.extractApiRequests.mockReturnValue([
        { request: `<task>${'A'.repeat(300)}</task>` },
      ]);

      const result = await t.transform([createUIMessage({ ts: 1000 })], 'task-raw-long');

      expect(result.skeleton.truncatedInstruction).toBe('A'.repeat(192));
      expect(result.skeleton.truncatedInstruction.length).toBe(192);
    });
  });

  // === buildChildTaskPrefixes — else branch, raw trim (src L207-211) ===
  describe('buildChildTaskPrefixes, normalizePrefixes:false', () => {
    it('keeps the raw trimmed message (not normalized) when normalization disabled', async () => {
      const t = new MessageToSkeletonTransformer({ normalizePrefixes: false });
      sharedDeserializerMock.extractNewTasks.mockReturnValue([{ message: '  Raw Sub Task  ' }]);

      const result = await t.transform([createUIMessage({ ts: 1000 })], 'task-raw-child');

      // Trimmed but case preserved → else branch (task.message.trim()), not the mock.
      expect(result.skeleton.childTaskInstructionPrefixes).toEqual(['Raw Sub Task']);
    });
  });

  // === detectCompletion — criterion 2 `|| ''` fallback (src L236) ===
  describe('detectCompletion criterion 2, undefined say subtype', () => {
    it('is not completed when the last message is a say with no subtype', async () => {
      // Last message: type 'say' but `say` undefined → `lastMessage.say || ''` → '' → not final.
      const messages = [
        createUIMessage({ ts: 1000 }),
        createUIMessage({ ts: 2000, type: 'say', say: undefined, text: 'trailing' }),
      ];

      const result = await new MessageToSkeletonTransformer().transform(messages, 'task-say-undef');

      expect(result.skeleton.isCompleted).toBe(false);
    });
  });

  // === validateSkeletonCompatibility — throws reachable via public transform() (strict mode) ===
  describe('strict validation throws (reachable via public transform)', () => {
    it('throws when taskId is empty (src L264-266)', async () => {
      const t = new MessageToSkeletonTransformer({ strictValidation: true });
      await expect(t.transform([createUIMessage({ ts: 1000 })], '')).rejects.toThrow(
        /taskId is required/
      );
    });

    it('throws when lastActivity precedes createdAt (src L276-278)', async () => {
      // Completed + out-of-order timestamps: first ts 5000, last (completion) ts 1000
      // → completedAt (1000) < startedAt (5000) → lastActivity before createdAt.
      const t = new MessageToSkeletonTransformer({ strictValidation: true });
      const messages = [
        createUIMessage({ ts: 5000 }),
        createUIMessage({ ts: 1000, type: 'say', say: 'completion_result', text: 'done' }),
      ];
      await expect(t.transform(messages, 'task-ts-order')).rejects.toThrow(
        /lastActivity before createdAt/
      );
    });

    it('throws when a child prefix exceeds 192 chars (src L290-292)', async () => {
      // normalizePrefixes:false keeps the raw >192 message → strict prefix-length check trips.
      const t = new MessageToSkeletonTransformer({
        normalizePrefixes: false,
        strictValidation: true,
      });
      sharedDeserializerMock.extractNewTasks.mockReturnValue([{ message: 'x'.repeat(200) }]);
      await expect(
        t.transform([createUIMessage({ ts: 1000 })], 'task-long-prefix')
      ).rejects.toThrow(/prefix exceeds 192 chars/);
    });
  });

  // === autoDetectWorkspace — empty-text continue (src L318-320) ===
  describe('autoDetectWorkspace, empty text content', () => {
    it('skips messages with no text and resolves to no workspace', async () => {
      // No workspace param → autoDetect runs; message has no text → `!textContent` → continue.
      const messages = [createUIMessage({ ts: 1000, text: undefined })];
      const result = await new MessageToSkeletonTransformer().transform(messages, 'task-empty-text');
      expect(result.skeleton.metadata.workspace).toBeUndefined();
    });
  });

  // === Structurally unreachable through the public API — skip-with-evidence (#1936) ===
  describe('unreachable-defensive branches (skip-with-evidence)', () => {
    // L287-288 empty-prefix throw: buildChildTaskPrefixes applies `.filter(p => p.length > 0)`
    // (src L213) before validation sees the array → an empty prefix can never survive.
    it.skip('validateSkeletonCompatibility empty-prefix throw (L287-288) — filtered upstream at src L213', () => {});

    // L296-298 truncatedInstruction>192 throw: buildMainInstruction caps every arm at 192
    // (computeInstructionPrefix(_,192) or substring(0,192), src L164-166/L179-181) → the value
    // handed to validation is always <=192.
    it.skip('validateSkeletonCompatibility truncatedInstruction>192 throw (L296-298) — capped at source', () => {});

    // L269-271 createdAt-missing throw: metadata.createdAt = `new Date(startedAt).toISOString()`
    // (src L107) — always a non-empty string, never falsy.
    it.skip('validateSkeletonCompatibility createdAt-missing throw (L269-271) — always set at src L107', () => {});

    // L281-283 isCompleted-without-lastActivity throw: metadata.lastActivity =
    // `new Date(completedAt || startedAt).toISOString()` (src L108) — always set, so the
    // `isCompleted && !lastActivity` conjunction is never true.
    it.skip('validateSkeletonCompatibility isCompleted-no-lastActivity throw (L281-283) — lastActivity always set at src L108', () => {});

    // L335-338 autoDetectWorkspace catch: the try body (src L307-332) is pure in-memory
    // string/regex parsing — no I/O, nothing that throws → the catch is dead-defensive.
    it.skip('autoDetectWorkspace catch block (L335-338) — try body cannot throw', () => {});
  });
});
