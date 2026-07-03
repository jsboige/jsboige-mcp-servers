/**
 * Coverage complement for dashboard-helpers.ts — `resolveMentionTarget`.
 *
 * The base suite (dashboard-helpers.test.ts) exercises the two IO-heavy
 * exports (updateDashboardActivityAsync, updateDashboardMetricsAsync) but
 * leaves `resolveMentionTarget` (L306-324) entirely cold — it is a pure,
 * mock-free function, so this add-only file pins every one of its paths and
 * branches. Each assertion is anchored on a `dashboard-helpers.ts` source line.
 *
 * Scope: 0 source lines touched (anti-churn #1936). Pure function, no mocks.
 *
 * @module utils/__tests__/dashboard-helpers.coverage
 * @issue #1363 (mentions v3), #1472 (workspace-loss fix)
 */

import { describe, it, expect } from 'vitest';
import { resolveMentionTarget } from '../dashboard-helpers.js';
import type { Mention, UserId } from '../../tools/roosync/dashboard-schemas.js';

describe('resolveMentionTarget (coverage)', () => {
  describe('userId arm (L307-309)', () => {
    it('returns the userId verbatim when present', () => {
      const userId: UserId = { machineId: 'myia-ai-01', workspace: 'roo-extensions' };
      const out = resolveMentionTarget({ userId });
      // Same shape, and returned as-is (L308 `return mention.userId`)
      expect(out).toEqual({ machineId: 'myia-ai-01', workspace: 'roo-extensions' });
      expect(out).toBe(userId); // identity: no copy
    });

    it('prefers userId over messageId when both are present (userId arm wins)', () => {
      // Schema XOR normally forbids both, but the function checks userId first
      // (L307) and returns before ever inspecting messageId — pin that ordering.
      const userId: UserId = { machineId: 'm', workspace: 'w' };
      const out = resolveMentionTarget({ userId, messageId: 'x:y:z' } as Mention);
      expect(out).toBe(userId);
    });
  });

  describe('messageId parse arm (L310-321)', () => {
    it('splits a v3 messageId on the first two colons only', () => {
      // machineId:workspace:ic-<ts>-<rand>
      const out = resolveMentionTarget({ messageId: 'myia-po-2026:CoursIA:ic-123-abc' });
      expect(out).toEqual({ machineId: 'myia-po-2026', workspace: 'CoursIA' });
    });

    it('keeps the 3rd segment intact even when it contains extra colons and dashes (L312 comment)', () => {
      // The id segment itself may hold ':' and '-'; only the first two colons
      // delimit machineId/workspace (L313-314, substring bounds L319-320).
      const out = resolveMentionTarget({
        messageId: 'myia-ai-01:roo-extensions:ic-20260703T055433-worker:report-x'
      });
      expect(out).toEqual({ machineId: 'myia-ai-01', workspace: 'roo-extensions' });
    });

    it('yields an empty machineId when the id starts with a colon (firstColon===0 boundary)', () => {
      // firstColon = 0 is NOT < 0, so the parse proceeds (L315 first operand false).
      const out = resolveMentionTarget({ messageId: ':ws:ic-1' });
      expect(out).toEqual({ machineId: '', workspace: 'ws' });
    });

    it('yields an empty workspace for adjacent colons (substring(a,a) === "")', () => {
      // machine::id → firstColon at 7, secondColon at 8, workspace = substring(8,8) = ''
      const out = resolveMentionTarget({ messageId: 'machine::ic-1' });
      expect(out).toEqual({ machineId: 'machine', workspace: '' });
    });
  });

  describe('invalid-format throw (L315-317)', () => {
    it('throws when the messageId has no colon (firstColon < 0, ternary false arm)', () => {
      // firstColon = -1 → secondColon short-circuited to -1 (L314 ternary) → throw.
      expect(() => resolveMentionTarget({ messageId: 'nocolon' }))
        .toThrow(/Invalid messageId format: 'nocolon'/);
    });

    it('throws when the messageId has only one colon (secondColon < 0)', () => {
      // firstColon >= 0 but no second colon → secondColon = -1 → throw (L315 second operand).
      expect(() => resolveMentionTarget({ messageId: 'machine:workspace' }))
        .toThrow(/expected machineId:workspace:id/);
    });

    it('throws on an empty-string messageId (indexOf === -1)', () => {
      expect(() => resolveMentionTarget({ messageId: '' } as Mention))
        .toThrow(/Invalid messageId format/);
    });
  });

  describe('XOR-invariant-violation throw (L323)', () => {
    it('throws when neither userId nor messageId is provided', () => {
      // Schema refine normally prevents this; the runtime guard (L323) is the
      // defensive backstop. Cast past the type to exercise it.
      expect(() => resolveMentionTarget({} as Mention))
        .toThrow(/neither userId nor messageId/);
    });

    it('throws when both fields are explicitly undefined', () => {
      expect(() => resolveMentionTarget({ userId: undefined, messageId: undefined } as Mention))
        .toThrow(/schema XOR invariant violated/);
    });
  });
});
