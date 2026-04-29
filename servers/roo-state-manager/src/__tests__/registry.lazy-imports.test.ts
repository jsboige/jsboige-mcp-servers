/**
 * Tests for #1817: Lazy dynamic imports in registry.ts
 *
 * Verifies:
 * 1. Lazy loaders cache the module after first call
 * 2. Lazy loaders return the same module on subsequent calls
 * 3. Lazy loaders propagate import errors
 * 4. Tool handlers call lazy loaders before accessing module exports
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

describe('#1817 — Lazy dynamic import patterns', () => {

    describe('lazy loader caching', () => {

        test('caches module after first import', async () => {
            let importCount = 0;
            const mockModule = { Foo: class Foo { static bar = 'baz'; } };

            // Simulate the lazy loader pattern from registry.ts
            let _cached: typeof mockModule | null = null;
            async function getModule() {
                if (!_cached) {
                    importCount++;
                    _cached = mockModule; // In real code: await import(...)
                }
                return _cached;
            }

            // First call — triggers import
            const result1 = await getModule();
            expect(importCount).toBe(1);
            expect(result1).toBe(mockModule);

            // Second call — cached
            const result2 = await getModule();
            expect(importCount).toBe(1); // No new import
            expect(result2).toBe(mockModule);
            expect(result2).toBe(result1); // Same reference
        });

        test('concurrent calls may import multiple times (thundering herd)', async () => {
            // The naive lazy pattern `if (!_cached) _cached = await import(...)` does NOT
            // deduplicate concurrent callers — each sees _cached === null before the first
            // resolves. In production, Node.js ESM deduplicates `import()` for the same
            // specifier, so the extra calls are harmless (same Promise). This test documents
            // the pattern's behavior accurately.
            let importCount = 0;
            let resolveImport: () => void;
            const importPromise = new Promise<void>((r) => { resolveImport = r; });

            const mockModule = { Service: vi.fn() };

            let _cached: typeof mockModule | null = null;
            async function getModule() {
                if (!_cached) {
                    importCount++;
                    await importPromise;
                    _cached = mockModule;
                }
                return _cached;
            }

            // Fire 3 concurrent calls before import resolves
            const results = Promise.all([getModule(), getModule(), getModule()]);

            // Resolve the import
            resolveImport!();

            const modules = await results;
            // All 3 callers entered the if-block before any resolved
            expect(importCount).toBe(3);
            // But they all end up with the same module reference
            expect(modules[0]).toBe(modules[1]);
            expect(modules[1]).toBe(modules[2]);
        });
    });

    describe('lazy loader error propagation', () => {

        test('propagates import error to caller', async () => {
            let _cached: any = null;
            async function getModule() {
                if (!_cached) {
                    _cached = await import('nonexistent-module-xyz');
                }
                return _cached;
            }

            await expect(getModule()).rejects.toThrow();
        });

        test('failed import is NOT cached (retry possible)', async () => {
            let importAttempts = 0;
            let failNext = true;

            // Simulate a loader that fails once then succeeds
            let _cached: any = null;
            async function getModule() {
                if (!_cached) {
                    importAttempts++;
                    if (failNext) {
                        failNext = false;
                        throw new Error('Network timeout');
                    }
                    _cached = { success: true };
                }
                return _cached;
            }

            // First call fails
            await expect(getModule()).rejects.toThrow('Network timeout');
            expect(_cached).toBeNull(); // Not cached

            // Second call succeeds
            const result = await getModule();
            expect(result).toEqual({ success: true });
            expect(importAttempts).toBe(2);
        });
    });

    describe('multiple independent lazy loaders', () => {

        test('each loader caches independently', async () => {
            const moduleA = { name: 'A' };
            const moduleB = { name: 'B' };
            const moduleC = { name: 'C' };

            let _a: typeof moduleA | null = null;
            async function getA() { if (!_a) _a = moduleA; return _a; }

            let _b: typeof moduleB | null = null;
            async function getB() { if (!_b) _b = moduleB; return _b; }

            let _c: typeof moduleC | null = null;
            async function getC() { if (!_c) _c = moduleC; return _c; }

            const [a, b, c] = await Promise.all([getA(), getB(), getC()]);

            expect(a).toBe(moduleA);
            expect(b).toBe(moduleB);
            expect(c).toBe(moduleC);
            expect(a).not.toBe(b);
            expect(b).not.toBe(c);
        });
    });

    describe('registry tool handler lazy pattern', () => {

        test('handler destructures lazy-loaded module before use', async () => {
            const mockDetector = {
                detectStorageLocations: vi.fn().mockResolvedValue([{ path: '/test', type: 'roo' }]),
            };
            const mockModule = { RooStorageDetector: mockDetector };

            // Simulate handler code pattern from registry.ts:
            // const { RooStorageDetector } = await getRooStorageDetector();
            // const locations = await RooStorageDetector.detectStorageLocations();
            let _cached: typeof mockModule | null = null;
            async function getModule() {
                if (!_cached) _cached = mockModule;
                return _cached;
            }

            // Handler body
            const mod = await getModule();
            const { RooStorageDetector } = mod;
            const locations = await RooStorageDetector.detectStorageLocations();

            expect(locations).toEqual([{ path: '/test', type: 'roo' }]);
            expect(mockDetector.detectStorageLocations).toHaveBeenCalledTimes(1);
        });
    });
});
