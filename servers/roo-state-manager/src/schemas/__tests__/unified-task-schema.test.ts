/**
 * Tests for JSON Schema validation of UnifiedTask — #1391
 */

import { describe, test, expect } from 'vitest';
import Ajv from 'ajv';
import type { ValidateFunction } from 'ajv';
import schema from '../unified-task.json';
import type { UnifiedTask } from '../../types/unified-task.js';

const ajv = new Ajv({ strict: false });
const validate = ajv.compile(schema) as ValidateFunction<UnifiedTask>;

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

// ─── JSON Schema validation ───────────────────────────────────────────────────

describe('UnifiedTask JSON Schema', () => {
  test('validates a complete Roo task', () => {
    expect(validate(validRooTask)).toBe(true);
  });

  test('validates a minimal Claude task', () => {
    expect(validate(validClaudeTask)).toBe(true);
  });

  test('validates task with all optional fields', () => {
    const full: UnifiedTask = {
      ...validRooTask,
      rootId: 'root-001',
      model: 'glm-5',
      storageTier: 'hot',
      sourceMetadata: { custom: 'data', count: 42 },
    };
    expect(validate(full)).toBe(true);
  });

  test('rejects missing required id', () => {
    const { id, ...noId } = validClaudeTask;
    expect(validate(noId)).toBe(false);
  });

  test('rejects missing required source', () => {
    const { source, ...noSource } = validClaudeTask;
    expect(validate(noSource)).toBe(false);
  });

  test('rejects missing required status', () => {
    const { status, ...noStatus } = validClaudeTask;
    expect(validate(noStatus)).toBe(false);
  });

  test('rejects invalid source enum', () => {
    expect(validate({ ...validClaudeTask, source: 'unknown-agent' })).toBe(false);
  });

  test('rejects invalid status enum', () => {
    expect(validate({ ...validClaudeTask, status: 'pending' })).toBe(false);
  });

  test('rejects invalid outcome enum', () => {
    expect(validate({ ...validRooTask, outcome: 'unknown' })).toBe(false);
  });

  test('rejects negative messageCount', () => {
    expect(validate({ ...validClaudeTask, messageCount: -1 })).toBe(false);
  });

  test('rejects negative actionCount', () => {
    expect(validate({ ...validClaudeTask, actionCount: -5 })).toBe(false);
  });

  test('rejects additional properties', () => {
    expect(validate({ ...validClaudeTask, extraField: 'nope' })).toBe(false);
  });

  test('accepts all valid storageTier values', () => {
    for (const tier of ['hot', 'warm', 'cold'] as const) {
      expect(validate({ ...validClaudeTask, storageTier: tier })).toBe(true);
    }
  });

  test('accepts all valid outcome values', () => {
    for (const outcome of ['success', 'failure', 'partial', 'cancelled'] as const) {
      expect(validate({ ...validRooTask, outcome })).toBe(true);
    }
  });

  test('accepts all valid status values', () => {
    for (const status of ['active', 'completed', 'abandoned', 'stuck', 'unknown'] as const) {
      expect(validate({ ...validClaudeTask, status })).toBe(true);
    }
  });
});

// ─── Schema structure ─────────────────────────────────────────────────────────

describe('JSON Schema structure', () => {
  test('has $schema draft-07', () => {
    expect(schema.$schema).toBe('http://json-schema.org/draft-07/schema#');
  });

  test('has $id for identification', () => {
    expect(schema.$id).toBe('https://roo-extensions.myia.io/schemas/unified-task.json');
  });

  test('has required fields defined', () => {
    const def = schema.definitions.UnifiedTask;
    expect(def.required).toContain('id');
    expect(def.required).toContain('source');
    expect(def.required).toContain('createdAt');
    expect(def.required).toContain('lastActivity');
    expect(def.required).toContain('messageCount');
    expect(def.required).toContain('actionCount');
    expect(def.required).toContain('totalSizeBytes');
    expect(def.required).toContain('status');
  });

  test('disallows additional properties', () => {
    const def = schema.definitions.UnifiedTask;
    expect(def.additionalProperties).toBe(false);
  });

  test('has correct source enum', () => {
    const def = schema.definitions.UnifiedTask;
    expect(def.properties.source.enum).toEqual(['roo', 'claude-code']);
  });

  test('has correct status enum', () => {
    const def = schema.definitions.UnifiedTask;
    expect(def.properties.status.enum).toEqual(['active', 'completed', 'abandoned', 'stuck', 'unknown']);
  });

  test('has minimum 0 on integer fields', () => {
    const def = schema.definitions.UnifiedTask;
    expect(def.properties.messageCount.minimum).toBe(0);
    expect(def.properties.actionCount.minimum).toBe(0);
    expect(def.properties.totalSizeBytes.minimum).toBe(0);
  });
});
