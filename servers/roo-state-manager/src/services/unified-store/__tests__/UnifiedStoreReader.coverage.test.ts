/**
 * Coverage tests for UnifiedStoreReader.ts (Issue #2426, Phase A interface + Null).
 *
 * Targets the Null object — its base interface implementation:
 *   - init/close are no-ops
 *   - getConversation returns null
 *   - getMessages returns []
 *   - joinFromQdrant returns []
 *   - ping returns false
 *   - isNull returns true
 *
 * Pure test, no pg, no env vars.
 */

import { describe, test, expect } from 'vitest';
import { NullUnifiedStoreReader } from '../UnifiedStoreReader.js';
import type { UnifiedStoreSearchFilters } from '../types.js';

describe('NullUnifiedStoreReader — silent no-op contract', () => {
  test('init() resolves without throwing', async () => {
    const r = new NullUnifiedStoreReader();
    await expect(r.init()).resolves.toBeUndefined();
  });

  test('close() resolves without throwing', async () => {
    const r = new NullUnifiedStoreReader();
    await expect(r.close()).resolves.toBeUndefined();
  });

  test('init() then close() are idempotent', async () => {
    const r = new NullUnifiedStoreReader();
    await r.init();
    await r.close();
    await r.init();
    await r.close();
    // Multiple cycles — no side effect, no throw.
  });

  test('getConversation(any) returns null', async () => {
    const r = new NullUnifiedStoreReader();
    expect(await r.getConversation('task-1')).toBeNull();
    expect(await r.getConversation('')).toBeNull();
    expect(await r.getConversation('with-special-chars-!@#$%')).toBeNull();
  });

  test('getMessages(any) returns []', async () => {
    const r = new NullUnifiedStoreReader();
    expect(await r.getMessages('task-1')).toEqual([]);
  });

  test('getMessages(any, opts) returns [] (ignores options)', async () => {
    const r = new NullUnifiedStoreReader();
    expect(await r.getMessages('task-1', { limit: 100 })).toEqual([]);
    expect(await r.getMessages('task-1', { limit: 0, offset: 50 })).toEqual([]);
  });

  test('joinFromQdrant(empty) returns []', async () => {
    const r = new NullUnifiedStoreReader();
    expect(await r.joinFromQdrant([])).toEqual([]);
  });

  test('joinFromQdrant(non-empty hits, no filters) returns []', async () => {
    const r = new NullUnifiedStoreReader();
    const hits = [
      { task_id: 'task-A', score: 0.95 },
      { task_id: 'task-B', score: 0.7 },
    ];
    expect(await r.joinFromQdrant(hits)).toEqual([]);
  });

  test('joinFromQdrant(hits, filters) returns [] (filters ignored)', async () => {
    const r = new NullUnifiedStoreReader();
    const filters: UnifiedStoreSearchFilters = {
      workspace: 'ws-1',
      machine_id: 'machine-A',
      harness: 'claude',
      since: '2026-01-01T00:00:00Z',
      until: '2026-12-31T23:59:59Z',
      tool_name: 'Bash',
    };
    const hits = [{ task_id: 'task-A', score: 0.95 }];
    expect(await r.joinFromQdrant(hits, filters)).toEqual([]);
  });

  test('joinFromQdrant(hits, partial filters) returns []', async () => {
    const r = new NullUnifiedStoreReader();
    expect(await r.joinFromQdrant([{ task_id: 't1', score: 0.1 }], { workspace: 'w' })).toEqual([]);
    expect(await r.joinFromQdrant([{ task_id: 't2', score: 0.2 }], { tool_name: 'Read' })).toEqual([]);
  });

  test('ping() returns false', async () => {
    const r = new NullUnifiedStoreReader();
    expect(await r.ping()).toBe(false);
  });

  test('isNull() returns true', () => {
    const r = new NullUnifiedStoreReader();
    expect(r.isNull()).toBe(true);
  });

  test('multiple Null instances are independent', async () => {
    // Null object pattern: each `new` creates a fresh instance, no shared state.
    const a = new NullUnifiedStoreReader();
    const b = new NullUnifiedStoreReader();
    expect(a).not.toBe(b);
    expect(a.isNull()).toBe(true);
    expect(b.isNull()).toBe(true);
    expect(await a.getConversation('x')).toBeNull();
    expect(await b.getConversation('y')).toBeNull();
  });

  test('all methods callable in any order without error', async () => {
    const r = new NullUnifiedStoreReader();
    await r.close(); // close before init is fine
    await r.init();
    expect(await r.getConversation('x')).toBeNull();
    expect(await r.getMessages('x')).toEqual([]);
    expect(await r.joinFromQdrant([{ task_id: 'y', score: 1 }])).toEqual([]);
    expect(await r.ping()).toBe(false);
    await r.close();
  });
});