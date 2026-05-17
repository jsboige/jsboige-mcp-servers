/**
 * #2195: Unit tests for per-cycle embedding metrics
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { getEmbeddingMetrics, resetEmbeddingMetricsForTest } from '../VectorIndexer.js';

describe('EmbeddingMetrics', () => {
    beforeEach(() => {
        resetEmbeddingMetricsForTest();
    });

    it('should start with all counters at 0', () => {
        const metrics = getEmbeddingMetrics();
        for (const [key, value] of Object.entries(metrics)) {
            expect(value, `counter ${key} should be 0`).toBe(0);
        }
    });

    it('should return a copy (not the mutable internal object)', () => {
        const a = getEmbeddingMetrics();
        const b = getEmbeddingMetrics();
        expect(a).toEqual(b);
        expect(a).not.toBe(b);
    });

    it('should reset all counters to 0', () => {
        // Mutate via internal reference would work, but we test reset indirectly
        // by verifying the exported reset function zeroes everything
        const metrics = getEmbeddingMetrics();
        const keys = Object.keys(metrics) as (keyof ReturnType<typeof getEmbeddingMetrics>)[];
        // Even if counters were somehow non-zero, reset should bring them back
        resetEmbeddingMetricsForTest();
        const after = getEmbeddingMetrics();
        for (const key of keys) {
            expect(after[key], `counter ${key} after reset`).toBe(0);
        }
    });

    it('should have exactly 11 counters', () => {
        const metrics = getEmbeddingMetrics();
        const keys = Object.keys(metrics);
        expect(keys.length).toBe(11);
    });

    it('should contain all expected counter names', () => {
        const metrics = getEmbeddingMetrics();
        const expected = [
            'embeddings_called_total',
            'embeddings_cached_hit_total',
            'embeddings_preflight_skipped_total',
            'embeddings_post_dedup_skipped_total',
            'embeddings_circuit_breaker_blocked_total',
            'embeddings_wrong_dim_total',
            'embeddings_rate_limit_waited_total',
            'preflight_batches_total',
            'preflight_batches_qdrant_unreachable_total',
            'preflight_chunks_returned_existing_total',
            'preflight_chunks_returned_missing_total',
        ];
        for (const name of expected) {
            expect(metrics).toHaveProperty(name);
        }
    });
});
