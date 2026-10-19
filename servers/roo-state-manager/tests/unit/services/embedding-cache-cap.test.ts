/**
 * #4153: embeddingCache hard-cap regression tests.
 *
 * The TTL on embeddingCache was enforced ONLY on read (embeddingCache.get) — no
 * eviction path existed, so a continuously-fed indexing queue grew the cache at
 * ~230-300 MB/h of private memory until the host died at ~3.6-3.8 GB (po-203,
 * 15-16/10). These tests pin the three properties the fix guarantees:
 *   1. the cache never exceeds EMBEDDING_CACHE_MAX_ENTRIES,
 *   2. eviction is FIFO (Map insertion order — JS language guarantee),
 *   3. EMBEDDING_CACHE_MAX_ENTRIES=0 disables caching entirely.
 *
 * The cap is read from process.env per call, and the cache is module-level state,
 * so each test runs against a freshly imported module (vi.resetModules) to stay
 * deterministic regardless of execution order.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ENV_KEY = 'EMBEDDING_CACHE_MAX_ENTRIES';
const savedEnv = process.env[ENV_KEY];

async function freshModule() {
    vi.resetModules();
    return await import('../../../src/services/task-indexer/VectorIndexer.js');
}

function vector(marker: number): number[] {
    return Array.from({ length: 8 }, (_, i) => (marker * 100 + i) / 1000);
}

describe('#4153 embeddingCache hard cap', () => {
    beforeEach(() => {
        process.env[ENV_KEY] = '3';
    });
    afterEach(() => {
        if (savedEnv === undefined) delete process.env[ENV_KEY];
        else process.env[ENV_KEY] = savedEnv;
    });

    it('caps the cache at EMBEDDING_CACHE_MAX_ENTRIES with FIFO eviction', async () => {
        const { cacheEmbedding, getEmbeddingMetrics } = await freshModule();
        for (let i = 0; i < 5; i++) {
            cacheEmbedding(`hash-${i}`, vector(i), Date.now());
        }
        expect(getEmbeddingMetrics().embeddings_cache_size).toBe(3);
    });

    it('EMBEDDING_CACHE_MAX_ENTRIES=0 disables the cache entirely', async () => {
        process.env[ENV_KEY] = '0';
        const { cacheEmbedding, getEmbeddingMetrics } = await freshModule();
        cacheEmbedding('hash-disable', vector(99), Date.now());
        expect(getEmbeddingMetrics().embeddings_cache_size).toBe(0);
    });

    it('an invalid EMBEDDING_CACHE_MAX_ENTRIES falls back to the default (2000)', async () => {
        process.env[ENV_KEY] = 'not-a-number';
        const { cacheEmbedding, getEmbeddingMetrics } = await freshModule();
        for (let i = 0; i < 5; i++) {
            cacheEmbedding(`hash-fallback-${i}`, vector(i), Date.now());
        }
        // 5 writes, cap fell back to 2000 — nothing evicted.
        expect(getEmbeddingMetrics().embeddings_cache_size).toBe(5);
    });
});
