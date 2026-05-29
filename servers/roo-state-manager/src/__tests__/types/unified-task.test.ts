/**
 * Tests for UnifiedTask schema — #1391
 */

import { describe, test, expect } from 'vitest';
import {
  UnifiedTaskSchema,
  toUnifiedTask,
  computeStorageTier,
  parseUnifiedTask,
  safeParseUnifiedTask,
  TaskSource,
  TaskStatus,
  TaskOutcome,
  StorageTier,
} from '../../types/unified-task.js';
import type { UnifiedTask } from '../../types/unified-task.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const validRooTask: UnifiedTask = {
  id: 'task-001',
  source: 'roo',
  parentId: 'parent-001',
  title: 'Fix authentication bug',
  instruction: 'Fix the login flow bug in auth.ts',
  createdAt: '2026-05-10T10:00:00Z',
  lastActivity: '2026-05-10T11:30:00Z',
  completedAt: '2026-05-10T11:30:00Z',
  messageCount: 42,
  actionCount: 15,
  totalSizeBytes: 8192,
  workspace: '/dev/roo-extensions',
  machineId: 'myia-po-2025',
  mode: 'code-simple',
  status: 'completed',
  outcome: 'success',
  indexedAt: '2026-05-10T12:00:00Z',
};

const validClaudeTask: UnifiedTask = {
  id: 'session-abc123',
  source: 'claude-code',
  createdAt: '2026-05-11T08:00:00Z',
  lastActivity: '2026-05-11T08:05:00Z',
  messageCount: 10,
  actionCount: 3,
  totalSizeBytes: 4096,
  status: 'active',
};

// ─── Schema validation ────────────────────────────────────────────────────────

describe('UnifiedTaskSchema', () => {
  test('validates a complete Roo task', () => {
    const result = UnifiedTaskSchema.safeParse(validRooTask);
    expect(result.success).toBe(true);
  });

  test('validates a minimal Claude task', () => {
    const result = UnifiedTaskSchema.safeParse(validClaudeTask);
    expect(result.success).toBe(true);
  });

  test('rejects missing required fields', () => {
    const result = UnifiedTaskSchema.safeParse({
      id: 'test',
      // missing: source, createdAt, lastActivity, messageCount, actionCount, totalSizeBytes, status
    });
    expect(result.success).toBe(false);
  });

  test('rejects invalid source', () => {
    const result = UnifiedTaskSchema.safeParse({
      ...validClaudeTask,
      source: 'unknown-agent',
    });
    expect(result.success).toBe(false);
  });

  test('rejects invalid status', () => {
    const result = UnifiedTaskSchema.safeParse({
      ...validClaudeTask,
      status: 'pending',
    });
    expect(result.success).toBe(false);
  });

  test('rejects negative messageCount', () => {
    const result = UnifiedTaskSchema.safeParse({
      ...validClaudeTask,
      messageCount: -1,
    });
    expect(result.success).toBe(false);
  });

  test('accepts optional fields as undefined', () => {
    const minimal: UnifiedTask = {
      id: 't1',
      source: 'roo',
      createdAt: '2026-05-11T00:00:00Z',
      lastActivity: '2026-05-11T00:00:00Z',
      messageCount: 0,
      actionCount: 0,
      totalSizeBytes: 0,
      status: 'unknown',
    };
    const result = UnifiedTaskSchema.safeParse(minimal);
    expect(result.success).toBe(true);
  });

  test('accepts sourceMetadata as opaque record', () => {
    const task = {
      ...validClaudeTask,
      sourceMetadata: { customField: 'value', nested: { deep: true } },
    };
    const result = UnifiedTaskSchema.safeParse(task);
    expect(result.success).toBe(true);
  });

  test('accepts storageTier hot/warm/cold', () => {
    for (const tier of ['hot', 'warm', 'cold'] as const) {
      const result = UnifiedTaskSchema.safeParse({ ...validClaudeTask, storageTier: tier });
      expect(result.success).toBe(true);
    }
  });

  test('rejects invalid datetime format', () => {
    const result = UnifiedTaskSchema.safeParse({
      ...validClaudeTask,
      createdAt: 'not-a-date',
    });
    expect(result.success).toBe(false);
  });
});

// ─── Enums ────────────────────────────────────────────────────────────────────

describe('Task enums', () => {
  test('TaskSource has expected values', () => {
    expect(TaskSource.options).toEqual(['roo', 'claude-code', 'zoo-code']);
  });

  test('TaskStatus has expected values', () => {
    expect(TaskStatus.options).toContain('active');
    expect(TaskStatus.options).toContain('completed');
    expect(TaskStatus.options).toContain('stuck');
    expect(TaskStatus.options).toContain('unknown');
  });

  test('TaskOutcome has expected values', () => {
    expect(TaskOutcome.options).toContain('success');
    expect(TaskOutcome.options).toContain('failure');
    expect(TaskOutcome.options).toContain('partial');
  });

  test('StorageTier has hot/warm/cold', () => {
    expect(StorageTier.options).toEqual(['hot', 'warm', 'cold']);
  });
});

// ─── toUnifiedTask conversion ─────────────────────────────────────────────────

describe('toUnifiedTask', () => {
  test('converts a Roo SkeletonHeader-like input', () => {
    const input = {
      taskId: 'task-roo-42',
      parentTaskId: 'parent-10',
      metadata: {
        title: 'Fix bug in auth',
        lastActivity: '2026-05-10T15:00:00Z',
        createdAt: '2026-05-10T14:00:00Z',
        mode: 'code-simple',
        messageCount: 25,
        actionCount: 8,
        totalSize: 5000,
        workspace: '/dev/project',
        machineId: 'myia-po-2025',
        source: 'roo' as const,
      },
      truncatedInstruction: 'Fix the authentication flow in login.ts',
      isCompleted: false,
    };

    const result = toUnifiedTask(input);

    expect(result.id).toBe('task-roo-42');
    expect(result.source).toBe('roo');
    expect(result.parentId).toBe('parent-10');
    expect(result.title).toBe('Fix bug in auth');
    expect(result.instruction).toBe('Fix the authentication flow in login.ts');
    expect(result.messageCount).toBe(25);
    expect(result.actionCount).toBe(8);
    expect(result.totalSizeBytes).toBe(5000);
    expect(result.workspace).toBe('/dev/project');
    expect(result.machineId).toBe('myia-po-2025');
    expect(result.mode).toBe('code-simple');
  });

  test('defaults source to "roo" when metadata.source is undefined', () => {
    const input = {
      taskId: 'task-no-source',
      metadata: {
        lastActivity: '2026-05-10T15:00:00Z',
        createdAt: '2026-05-10T14:00:00Z',
        messageCount: 1,
      },
    };

    const result = toUnifiedTask(input);
    expect(result.source).toBe('roo');
  });

  test('sets completed status for isCompleted=true', () => {
    const input = {
      taskId: 'task-done',
      metadata: {
        lastActivity: '2026-05-10T15:00:00Z',
        createdAt: '2026-05-10T14:00:00Z',
        messageCount: 5,
      },
      isCompleted: true,
    };

    const result = toUnifiedTask(input);
    expect(result.status).toBe('completed');
    expect(result.outcome).toBe('success');
    expect(result.completedAt).toBe('2026-05-10T15:00:00Z');
  });

  test('sets stuck status for tasks inactive > 7 days', () => {
    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const input = {
      taskId: 'task-old',
      metadata: {
        lastActivity: oldDate,
        createdAt: oldDate,
        messageCount: 3,
      },
      isCompleted: false,
    };

    const result = toUnifiedTask(input);
    expect(result.status).toBe('stuck');
  });

  test('truncates long instructions to 500 chars', () => {
    const longInstruction = 'A'.repeat(600);
    const input = {
      taskId: 'task-long',
      metadata: {
        lastActivity: '2026-05-10T15:00:00Z',
        createdAt: '2026-05-10T14:00:00Z',
        messageCount: 1,
      },
      truncatedInstruction: longInstruction,
    };

    const result = toUnifiedTask(input);
    expect(result.instruction).toBeDefined();
    expect(result.instruction!.length).toBe(503); // 500 + '...'
    expect(result.instruction!.endsWith('...')).toBe(true);
  });
});

// ─── computeStorageTier ───────────────────────────────────────────────────────

describe('computeStorageTier', () => {
  test('returns hot for recent tasks (<=7 days)', () => {
    const task = { ...validClaudeTask, lastActivity: new Date().toISOString() };
    expect(computeStorageTier(task)).toBe('hot');
  });

  test('returns warm for tasks 8-90 days old', () => {
    const daysAgo = 30;
    const date = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
    const task = { ...validClaudeTask, lastActivity: date };
    expect(computeStorageTier(task)).toBe('warm');
  });

  test('returns cold for tasks >90 days old', () => {
    const daysAgo = 120;
    const date = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
    const task = { ...validClaudeTask, lastActivity: date };
    expect(computeStorageTier(task)).toBe('cold');
  });

  test('boundary: just under 7 days = hot', () => {
    // Use -1ms to avoid microsecond drift between Date.now() calls
    const date = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000 + 1).toISOString();
    const task = { ...validClaudeTask, lastActivity: date };
    expect(computeStorageTier(task)).toBe('hot');
  });

  test('boundary: just under 90 days = warm', () => {
    const date = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000 + 1).toISOString();
    const task = { ...validClaudeTask, lastActivity: date };
    expect(computeStorageTier(task)).toBe('warm');
  });
});

// ─── parseUnifiedTask / safeParseUnifiedTask ──────────────────────────────────

describe('parseUnifiedTask', () => {
  test('parses valid data', () => {
    const result = parseUnifiedTask(validClaudeTask);
    expect(result.id).toBe('session-abc123');
  });

  test('throws on invalid data', () => {
    expect(() => parseUnifiedTask({ bad: true })).toThrow();
  });
});

describe('safeParseUnifiedTask', () => {
  test('returns success for valid data', () => {
    const result = safeParseUnifiedTask(validRooTask);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBe('task-001');
      expect(result.data.source).toBe('roo');
    }
  });

  test('returns failure for invalid data', () => {
    const result = safeParseUnifiedTask({ id: 123 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors).toBeDefined();
      expect(result.errors.issues.length).toBeGreaterThan(0);
    }
  });
});
