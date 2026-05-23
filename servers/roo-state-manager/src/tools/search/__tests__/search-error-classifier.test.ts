/**
 * Tests for search-error-classifier.ts
 * #833 Phase 2 P0 blind spot — full coverage of error classification logic
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { classifySearchError, formatClassifiedError } from '../search-error-classifier.js';
import type { ClassifiedError } from '../search-error-classifier.js';

// Mock global.fetch for probeQdrantHealth tests
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function makeError(message: string, overrides: Record<string, unknown> = {}): Error & Record<string, unknown> {
	const err = new Error(message) as Error & Record<string, unknown>;
	for (const [k, v] of Object.entries(overrides)) {
		err[k] = v;
	}
	return err;
}

describe('classifySearchError', () => {
	beforeEach(() => {
		mockFetch.mockReset();
	});

	// ── Auth failures (highest priority — checked first) ──

	it('classifies 401 as auth_failed regardless of operation', async () => {
		const err = makeError('Unauthorized', { status: 401 });
		const result = await classifySearchError(err, 'embedding');
		expect(result.mode).toBe('auth_failed');
		expect(result.hint).toContain('API_KEY');
	});

	it('classifies 403 as auth_failed', async () => {
		const err = makeError('Forbidden', { status: 403 });
		const result = await classifySearchError(err, 'search');
		expect(result.mode).toBe('auth_failed');
	});

	it('classifies "API key" message as auth_failed even without status', async () => {
		const err = makeError('Invalid API key provided');
		const result = await classifySearchError(err, 'codebase_search');
		expect(result.mode).toBe('auth_failed');
	});

	it('auth takes priority over network error code', async () => {
		const err = makeError('Unauthorized', { code: 'ECONNREFUSED', status: 401 });
		const result = await classifySearchError(err, 'search');
		expect(result.mode).toBe('auth_failed');
	});

	// ── Collection not found (404) ──

	it('classifies 404 status as qdrant_collection_missing', async () => {
		const err = makeError('Not found', { status: 404 });
		const result = await classifySearchError(err, 'search');
		expect(result.mode).toBe('qdrant_collection_missing');
		expect(result.hint).toContain('rebuild');
	});

	it('classifies "Collection not found" message', async () => {
		const err = makeError('Collection not found: roo_tasks');
		const result = await classifySearchError(err, 'search');
		expect(result.mode).toBe('qdrant_collection_missing');
	});

	// ── Embedding-specific errors ──

	it('classifies ECONNREFUSED + embedding op as embedding_unreachable', async () => {
		const err = makeError('fetch failed', { code: 'ECONNREFUSED' });
		const result = await classifySearchError(err, 'embedding');
		expect(result.mode).toBe('embedding_unreachable');
		expect(result.hint).toContain('EMBEDDING_API_BASE_URL');
	});

	it('classifies "fetch failed" + embedding op as embedding_unreachable', async () => {
		const err = makeError('fetch failed');
		const result = await classifySearchError(err, 'embedding');
		expect(result.mode).toBe('embedding_unreachable');
	});

	it('classifies timeout + embedding op as embedding_timeout', async () => {
		const err = makeError('Request aborted due to timeout');
		const result = await classifySearchError(err, 'embedding');
		expect(result.mode).toBe('embedding_timeout');
		expect(result.hint).toContain('fallback');
	});

	it('classifies ETIMEDOUT + embedding op as embedding_unreachable (ETIMEDOUT is a network error)', async () => {
		const err = makeError('Connection timed out', { code: 'ETIMEDOUT' });
		const result = await classifySearchError(err, 'embedding');
		expect(result.mode).toBe('embedding_unreachable');
	});

	it('classifies UND_ERR_CONNECT_TIMEOUT + embedding op as embedding_timeout', async () => {
		const err = makeError('Connect timeout', { code: 'UND_ERR_CONNECT_TIMEOUT' });
		const result = await classifySearchError(err, 'embedding');
		expect(result.mode).toBe('embedding_timeout');
	});

	// ── Qdrant-level errors (search/codebase_search) ──

	it('classifies ECONNREFUSED + search op as qdrant_unreachable', async () => {
		const err = makeError('Connection refused', { code: 'ECONNREFUSED' });
		const result = await classifySearchError(err, 'search');
		expect(result.mode).toBe('qdrant_unreachable');
		expect(result.hint).toContain('QDRANT_URL');
	});

	it('classifies ENOTFOUND + codebase_search op as qdrant_unreachable', async () => {
		const err = makeError('DNS lookup failed', { code: 'ENOTFOUND' });
		const result = await classifySearchError(err, 'codebase_search');
		expect(result.mode).toBe('qdrant_unreachable');
	});

	it('classifies CERT_HAS_EXPIRED as qdrant_unreachable', async () => {
		const err = makeError('Certificate expired', { code: 'CERT_HAS_EXPIRED' });
		const result = await classifySearchError(err, 'search');
		expect(result.mode).toBe('qdrant_unreachable');
	});

	// ── probeQdrantHealth disambiguation ──

	it('probe OK → qdrant_proxy_drop (proxy drops POST)', async () => {
		mockFetch.mockResolvedValue({ ok: true, status: 200 });
		const err = makeError('This operation was aborted');
		const result = await classifySearchError(err, 'search');
		expect(result.mode).toBe('qdrant_proxy_drop');
		expect(result.hint).toContain('proxy');
	});

	it('probe !ok → qdrant_backend_slow', async () => {
		mockFetch.mockResolvedValue({ ok: false, status: 503 });
		const err = makeError('Request timeout');
		const result = await classifySearchError(err, 'search');
		expect(result.mode).toBe('qdrant_backend_slow');
		expect(result.hint).toContain('Qdrant backend');
	});

	it('probe throws → qdrant_unreachable', async () => {
		mockFetch.mockRejectedValue(new Error('Network error'));
		const err = makeError('Timeout occurred', { code: 'UND_ERR_CONNECT_TIMEOUT' });
		const result = await classifySearchError(err, 'search');
		expect(result.mode).toBe('qdrant_unreachable');
		expect(result.message).toContain('completely unreachable');
	});

	it('HTTP 5xx triggers probe', async () => {
		mockFetch.mockResolvedValue({ ok: true, status: 200 });
		const err = makeError('Bad Gateway');
		const result = await classifySearchError(err, 'search');
		expect(result.mode).toBe('qdrant_proxy_drop');
	});

	// ── Resource exhaustion ──

	it('classifies EMFILE as resource_exhausted', async () => {
		const err = makeError('too many open files', { code: 'EMFILE' });
		const result = await classifySearchError(err, 'embedding');
		expect(result.mode).toBe('resource_exhausted');
		expect(result.hint).toContain('ulimit');
	});

	it('classifies ENOMEM as resource_exhausted', async () => {
		const err = makeError('Cannot allocate memory', { code: 'ENOMEM' });
		const result = await classifySearchError(err, 'search');
		expect(result.mode).toBe('resource_exhausted');
	});

	it('classifies "out of memory" message as resource_exhausted', async () => {
		const err = makeError('JavaScript heap out of memory');
		const result = await classifySearchError(err, 'codebase_search');
		expect(result.mode).toBe('resource_exhausted');
	});

	// ── Fallback ──

	it('classifies unknown error as unknown', async () => {
		const err = makeError('Something unexpected happened');
		const result = await classifySearchError(err, 'search');
		expect(result.mode).toBe('unknown');
		expect(result.hint).toContain('diagnose');
	});

	it('handles non-Error input', async () => {
		const result = await classifySearchError('plain string error', 'search');
		expect(result.mode).toBe('unknown');
		expect(result.originalError).toBe('plain string error');
	});

	// ── Ordering proof ──

	it('auth (401) wins over network error code', async () => {
		const err = makeError('ECONNREFUSED', { code: 'ECONNREFUSED', status: 401 });
		const result = await classifySearchError(err, 'search');
		expect(result.mode).toBe('auth_failed');
	});

	it('404 wins over resource exhaustion message', async () => {
		const err = makeError('Collection not found (EMFILE resolved)', { status: 404 });
		const result = await classifySearchError(err, 'search');
		expect(result.mode).toBe('qdrant_collection_missing');
	});

	// ── ClassifiedError shape ──

	it('returns all required fields', async () => {
		const err = makeError('test', { code: 'EMFILE' });
		const result = await classifySearchError(err, 'search');
		expect(result).toHaveProperty('mode');
		expect(result).toHaveProperty('originalError');
		expect(result).toHaveProperty('message');
		expect(result).toHaveProperty('hint');
		expect(typeof result.mode).toBe('string');
		expect(typeof result.hint).toBe('string');
	});
});

describe('formatClassifiedError', () => {
	const base: ClassifiedError = {
		mode: 'auth_failed',
		originalError: 'Unauthorized',
		message: 'Authentication failed during search',
		hint: 'Check API key',
	};

	it('includes all labelled lines by default', () => {
		const result = formatClassifiedError(base);
		expect(result).toContain('Semantic search failed: auth_failed');
		expect(result).toContain('Detected:');
		expect(result).toContain('Likely cause:');
		expect(result).toContain('Original error: Unauthorized');
	});

	it('omits original error when includeOriginal=false', () => {
		const result = formatClassifiedError(base, false);
		expect(result).not.toContain('Original error:');
		expect(result).toContain('Detected:');
	});

	it('joins lines with newline', () => {
		const result = formatClassifiedError(base);
		const lines = result.split('\n');
		expect(lines.length).toBe(4); // header + detected + likely + original
	});
});
