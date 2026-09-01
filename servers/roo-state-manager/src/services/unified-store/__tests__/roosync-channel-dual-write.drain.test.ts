/**
 * The exit door must hold for in-flight mirror writes (#3151).
 *
 * #1069 made a *failing* mirror observable. The measured residual loss
 * (po-2024 24.5 % / po-2027 72.5 %, 26/08→01/09) is the mirror that never got
 * to fail: the process exits while the fire-and-forget write is still in
 * flight — reproduced 2026-09-01 even on the graceful stdin-end path, because
 * nothing drained the writer. This file asserts the drain that closes it:
 * registration of in-flight ops, bounded wait, writer close, and the timeout
 * path that names what it could not wait for.
 *
 * @module services/unified-store/__tests__/roosync-channel-dual-write.drain
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

// ─── Capture the logger (hoisted before the module under test loads) ──────────

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('../../../utils/logger.js', () => ({
  createLogger: () => ({ warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// ─── Controllable writer: gated promises + a counting close ───────────────────

const state = vi.hoisted(() => ({ gates: [] as Array<() => void>, closeCalls: 0 }));
vi.mock('../writer-factory.js', () => ({
  getUnifiedStoreWriter: () => ({
    insertRooSyncMessage: () => new Promise<void>(resolve => { state.gates.push(resolve); }),
    updateRooSyncMessage: () => new Promise<void>(resolve => { state.gates.push(resolve); }),
    insertRooSyncAttachment: () => Promise.resolve(),
    deleteRooSyncAttachment: () => Promise.resolve(),
    close: async () => { state.closeCalls++; },
  }),
}));

import {
  dualWriteRooSyncMessageRead,
  getPendingDualWriteCount,
  drainPendingDualWrites,
} from '../roosync-channel-dual-write.js';

/** Release every gate and let the tracked promises settle (test cleanup). */
async function releaseAll(): Promise<void> {
  const gates = state.gates.splice(0);
  gates.forEach(g => g());
  await new Promise(res => setImmediate(res));
}

describe('in-flight mirror writes are drained on exit', () => {
  beforeEach(() => {
    warn.mockClear();
    state.gates.length = 0;
    state.closeCalls = 0;
  });

  test('an in-flight op is registered synchronously and cleared when it settles', async () => {
    expect(getPendingDualWriteCount()).toBe(0);
    const p = dualWriteRooSyncMessageRead('msg-drain-1'); // gated, still in flight
    expect(getPendingDualWriteCount()).toBe(1);
    await releaseAll();
    await p;
    expect(getPendingDualWriteCount()).toBe(0);
  });

  test('drainPendingDualWrites waits for in-flight ops, closes the writer, returns true', async () => {
    const p = dualWriteRooSyncMessageRead('msg-drain-2');
    const drained = drainPendingDualWrites(2000); // must NOT resolve while gated
    await new Promise(res => setImmediate(res));
    expect(getPendingDualWriteCount()).toBe(1);
    await releaseAll();
    await p;
    expect(await drained).toBe(true);
    expect(state.closeCalls).toBe(1);
    expect(warn).not.toHaveBeenCalled();
  });

  test('drain timeout returns false and names the count it could not wait for', async () => {
    const p = dualWriteRooSyncMessageRead('msg-drain-3'); // never released within budget
    const result = await drainPendingDualWrites(50);
    expect(result).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    const [message, context] = warn.mock.calls[0];
    expect(String(message)).toContain('drain timed out');
    expect(context).toMatchObject({ stillPending: 1, timeoutMs: 50 });
    expect(state.closeCalls).toBe(1); // close is still attempted on the timeout path
    await releaseAll();
    await p; // cleanup: do not leak the op into sibling tests
  });

  test('drain with nothing in flight closes the writer and returns true', async () => {
    expect(await drainPendingDualWrites(50)).toBe(true);
    expect(state.closeCalls).toBe(1);
  });
});
