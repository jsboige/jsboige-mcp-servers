/**
 * #833 C3 (po-2024 c.133) — lazy-roosync.ts value-passthrough proxy coverage
 *
 * Source: src/services/lazy-roosync.ts L58-75 — the `RooSyncService` lazy facade object
 * (LazyRooSyncServiceStatic). The sibling `lazy-roosync.test.ts` covers getRooSyncService,
 * the module cache, resetInstance, getInstance, and concurrency. But its mock (L9-21 of the
 * base test) omits `isDegraded` and `getInitError` — so those two proxy methods (L67-74)
 * were never exercised (66.66% funcs).
 *
 * These are NOT void forwards — they return VALUES consumed by callers:
 *   - `isDegraded()` (L67-70): returns the underlying service's degraded boolean.
 *     Used by #1843 degraded-mode detection across the fleet. A negation silent-swap
 *     (`return !mod.RooSyncService.isDegraded()`) would invert degraded-mode and pass
 *     a "method was called" test undetected.
 *   - `getInitError()` (L71-74): returns the underlying Error | null. A null-coercion
 *     swap (`?? new Error('x')`) would mask the healthy "no error" state.
 *
 * This file uses its OWN vi.mock (mirrors the base test's mock + adds isDegraded/getInitError)
 * so it is fully add-only — no modification to the existing base test.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RooSyncService } from '../lazy-roosync.js';

// Mock RooSyncService module — mirrors the base test mock AND adds the 2 cold methods.
vi.mock('../RooSyncService.js', () => ({
    RooSyncServiceError: class MockRooSyncServiceError extends Error {
        constructor(message: string) { super(message); this.name = 'RooSyncServiceError'; }
    },
    getRooSyncService: vi.fn(() => Promise.resolve('mock-service-instance')),
    RooSyncService: {
        resetInstance: vi.fn(),
        getInstance: vi.fn(() => Promise.resolve({ name: 'mock-instance' })),
        isDegraded: vi.fn(() => true),
        getInitError: vi.fn(() => null),
    },
}));

describe('lazy-roosync — value-passthrough proxy coverage (#833 C3 c.133)', () => {
    beforeEach(() => { vi.clearAllMocks(); });
    afterEach(() => { vi.resetModules(); });

    describe('RooSyncService.isDegraded() — value passthrough (L67-70, #1843)', () => {
        it('returns the underlying service isDegraded() boolean (true)', async () => {
            // Source L67-70: `const mod = await _ensureLoaded(); return mod.RooSyncService.isDegraded();`
            // Locks the value passthrough — a negation swap would flip this to false.
            const result = await RooSyncService.isDegraded();
            expect(result).toBe(true);
            expect(result).not.toBe(false); // explicit guard against negation silent-swap
        });

        it('returns false when the underlying service reports not-degraded', async () => {
            // Mirror assertion: flip the mock to false, confirm the proxy forwards it unchanged.
            const { RooSyncService: lazy } = await import('../lazy-roosync.js');
            const { RooSyncService: mock } = await import('../RooSyncService.js');
            (mock.isDegraded as ReturnType<typeof vi.fn>).mockReturnValue(false);
            const result = await lazy.isDegraded();
            expect(result).toBe(false);
        });
    });

    describe('RooSyncService.getInitError() — value passthrough (L71-74)', () => {
        it('returns null when the underlying service has no init error', async () => {
            // Source L71-74: `return mod.RooSyncService.getInitError();`. Default mock returns null.
            // Locks the null passthrough — a `?? new Error()` swap would replace null with an Error.
            const result = await RooSyncService.getInitError();
            expect(result).toBeNull();
        });

        it('returns the underlying Error instance when init failed', async () => {
            // Flip the mock to an Error, confirm the proxy forwards that exact instance (identity).
            const { RooSyncService: lazy } = await import('../lazy-roosync.js');
            const { RooSyncService: mock } = await import('../RooSyncService.js');
            const err = new Error('qdrant unreachable during init');
            (mock.getInitError as ReturnType<typeof vi.fn>).mockReturnValue(err);
            const result = await lazy.getInitError();
            expect(result).toBe(err); // identity — same instance, no wrapping/coercion
            expect(result?.message).toBe('qdrant unreachable during init');
        });
    });
});
