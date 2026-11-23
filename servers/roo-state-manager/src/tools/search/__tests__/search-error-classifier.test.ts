/**
 * Tests for search-error-classifier.ts
 * #833 Phase 2 P0 blind spot — full coverage of error classification logic
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { classifySearchError, formatClassifiedError, unwrapTransportCause, failureComponent } from '../search-error-classifier.js';
import type { ClassifiedError, FailureMode } from '../search-error-classifier.js';

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
	const originalQdrantUrl = process.env.QDRANT_URL;
	beforeEach(() => {
		mockFetch.mockReset();
	});
	afterEach(() => {
		if (originalQdrantUrl === undefined) delete process.env.QDRANT_URL;
		else process.env.QDRANT_URL = originalQdrantUrl;
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

	// ── #4438 dispatch item 1: a 404 on the EMBEDDING call is not a Qdrant collection issue ──

	it('classifies 404 + embedding op as embedding_endpoint_not_found, not qdrant_collection_missing', async () => {
		const err = makeError('404 Not found: /v2/embeddings', { status: 404 });
		const result = await classifySearchError(err, 'embedding');
		expect(result.mode).toBe('embedding_endpoint_not_found');
		expect(result.hint).toContain('EMBEDDING_API_BASE_URL');
		// The expensive wrong remedy must not be SUGGESTED for an embedder 404
		// (the hint may name it only to forbid it).
		expect(result.hint).not.toContain('Run roosync_indexing');
	});

	it('classifies "Not found" message + embedding op (no status) the same way', async () => {
		const err = makeError('Not found');
		const result = await classifySearchError(err, 'embedding');
		expect(result.mode).toBe('embedding_endpoint_not_found');
	});

	it('embedding_endpoint_not_found implicates the embeddings component (failureComponent)', () => {
		expect(failureComponent('embedding_endpoint_not_found')).toBe('embeddings');
	});

	it('embedding_endpoint_not_found counts as an infrastructure error for the degraded banner', async () => {
		const { INFRASTRUCTURE_ERROR_MODES } = await import('../search-semantic.tool.js');
		expect(INFRASTRUCTURE_ERROR_MODES.has('embedding_endpoint_not_found')).toBe(true);
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
		process.env.QDRANT_URL = 'https://qdrant.example.org';
		mockFetch.mockResolvedValue({ ok: true, status: 200 });
		const err = makeError('This operation was aborted');
		const result = await classifySearchError(err, 'search');
		expect(result.mode).toBe('qdrant_proxy_drop');
		expect(result.hint).toContain('proxy');
	});

	// #4352: on ai-01 QDRANT_URL is localhost:6333 and the search itself timed out
	// (cold cache, on-disk vectors); the proxy verdict sent operators to IIS/ARR.
	it.each([
		['http://127.0.0.1:6333'],
		['http://localhost:6333'],
		['http://[::1]:6333'],
	])('probe OK on loopback %s → qdrant_backend_slow, never a proxy drop', async (url) => {
		process.env.QDRANT_URL = url;
		mockFetch.mockResolvedValue({ ok: true, status: 200 });
		const result = await classifySearchError(makeError('This operation was aborted'), 'codebase_search');
		expect(result.mode).toBe('qdrant_backend_slow');
		expect(result.message).toContain('no proxy in the path');
	});

	it('unset QDRANT_URL defaults to localhost → qdrant_backend_slow', async () => {
		delete process.env.QDRANT_URL;
		mockFetch.mockResolvedValue({ ok: true, status: 200 });
		const result = await classifySearchError(makeError('This operation was aborted'), 'search');
		expect(result.mode).toBe('qdrant_backend_slow');
	});

	it("Qdrant's own search timeout → qdrant_backend_slow even behind a public URL", async () => {
		process.env.QDRANT_URL = 'https://qdrant.example.org';
		mockFetch.mockResolvedValue({ ok: true, status: 200 });
		const err = makeError("Service internal error: 1 of 1 read operations failed: Timeout error: Operation 'Search' timed out after 59 seconds", { status: 500 });
		const result = await classifySearchError(err, 'codebase_search');
		expect(result.mode).toBe('qdrant_backend_slow');
	});

	// #4880: the shape the 1.20 JS client ACTUALLY throws (measured ai-01 23/11
	// with a 1 s server budget): message = HTTP status text, reason on `data`.
	// The two tests above put the reason in the message — a shape that never
	// reaches the classifier, so they stayed green while this one fell to unknown.
	const qdrant120Error = (reason: string) => makeError('Internal Server Error', {
		status: 500,
		data: { status: { error: reason }, time: 1.0026 },
	});

	it("#4880: Qdrant's own search timeout in the 1.20 client's shape → qdrant_backend_slow", async () => {
		process.env.QDRANT_URL = 'https://qdrant.example.org';
		mockFetch.mockResolvedValue({ ok: true, status: 200 });
		const err = qdrant120Error("Service internal error: 1 of 1 read operations failed:\n  Timeout error: Operation 'Search' timed out after 999.251028ms");
		const result = await classifySearchError(err, 'search');
		expect(result.mode).toBe('qdrant_backend_slow');
		expect(result.originalError).toContain("Operation 'Search' timed out");
	});

	it('#4880: joining a NON-timeout reason does not make a 500 look like a slow search', async () => {
		process.env.QDRANT_URL = 'https://qdrant.example.org';
		mockFetch.mockResolvedValue({ ok: true, status: 200 });
		const result = await classifySearchError(qdrant120Error('Service internal error: segment checksum mismatch'), 'search');
		expect(result.mode).not.toBe('qdrant_backend_slow');
		expect(result.originalError).toContain('segment checksum mismatch');
	});

	it("Qdrant's own search timeout with no HTTP status still enters the timeout branch", async () => {
		process.env.QDRANT_URL = 'https://qdrant.example.org';
		mockFetch.mockResolvedValue({ ok: true, status: 200 });
		const err = makeError("Timeout error: Operation 'Search' timed out after 59 seconds");
		const result = await classifySearchError(err, 'search');
		expect(result.mode).toBe('qdrant_backend_slow');
	});

	// ── #4881: a proxy verdict needs proof — RFC1918 + light-POST discriminant ──

	// The fleet topology: executors hit Qdrant directly on its native port over
	// a private LAN (synthetic example: 10.0.0.5:6333; the real seat address is
	// deliberately not in this public repo). The client-side abort "This
	// operation was aborted" fires at QDRANT_SEARCH_TIMEOUT_MS before the server
	// can word its own timeout, so the #4352 message exemption never triggers
	// and the verdict blamed a proxy that is not in the path.
	it.each([
		['http://10.0.0.5:6333'],
		['http://10.1.2.3:6333'],
		['http://172.16.0.9:6333'],
		['http://172.31.255.255:6333'],
	])('RFC1918 LAN URL %s → qdrant_backend_slow, never a proxy drop', async (url) => {
		process.env.QDRANT_URL = url;
		mockFetch.mockResolvedValue({ ok: true, status: 200 });
		const result = await classifySearchError(makeError('This operation was aborted'), 'codebase_search');
		expect(result.mode).toBe('qdrant_backend_slow');
		expect(result.message).toContain('no proxy in the path');
	});

	it('public-range 172.32.x is NOT exempted from the proxy path', async () => {
		process.env.QDRANT_URL = 'http://172.32.0.1:6333';
		mockFetch.mockResolvedValue({ ok: true, status: 200 }); // no json() → probe null → legacy verdict
		const result = await classifySearchError(makeError('This operation was aborted'), 'search');
		expect(result.mode).toBe('qdrant_proxy_drop');
	});

	// Routes the classifier's probes: /healthz, /collections (listing), and the
	// light POST scroll. `scroll`: 'ok' → answered (POSTs traverse), 'drop' →
	// the POST itself aborts; `listing`: false → collections body unparsable.
	function routeFetch(opts: { scroll: 'ok' | 'drop'; listing?: boolean }) {
		mockFetch.mockImplementation(async (url: unknown) => {
			const u = String(url);
			if (u.endsWith('/healthz')) return { ok: true, status: 200 };
			if (u.endsWith('/collections')) {
				if (opts.listing === false) return { ok: true, status: 200 }; // no json() method
				return { ok: true, status: 200, json: async () => ({ result: { collections: [{ name: 'ws-a' }] } }) };
			}
			if (u.includes('/points/scroll')) {
				if (opts.scroll === 'drop') throw new Error('This operation was aborted');
				return { ok: true, status: 200, json: async () => ({ result: { points: [] } }) };
			}
			throw new Error(`unexpected fetch: ${u}`);
		});
	}

	it('public URL, healthz OK, light POST answered → qdrant_backend_slow (POSTs are NOT dropped)', async () => {
		process.env.QDRANT_URL = 'https://qdrant.example.org';
		routeFetch({ scroll: 'ok' });
		const result = await classifySearchError(makeError('This operation was aborted'), 'search');
		expect(result.mode).toBe('qdrant_backend_slow');
		expect(result.message).toContain('light scroll answered');
		expect(result.hint).toContain('not being dropped');
	});

	it('light POST answered with an HTTP error status still proves traversal (backend_slow)', async () => {
		process.env.QDRANT_URL = 'https://qdrant.example.org';
		mockFetch.mockImplementation(async (url: unknown) => {
			const u = String(url);
			if (u.endsWith('/healthz')) return { ok: true, status: 200 };
			if (u.endsWith('/collections')) return { ok: true, status: 200, json: async () => ({ result: { collections: [{ name: 'ws-a' }] } }) };
			if (u.includes('/points/scroll')) return { ok: false, status: 400, json: async () => ({}) };
			throw new Error(`unexpected fetch: ${u}`);
		});
		const result = await classifySearchError(makeError('This operation was aborted'), 'codebase_search');
		expect(result.mode).toBe('qdrant_backend_slow');
	});

	it('public URL, healthz OK, light POST also dropped → qdrant_proxy_drop WITH the proof in the message', async () => {
		process.env.QDRANT_URL = 'https://qdrant.example.org';
		routeFetch({ scroll: 'drop' });
		const result = await classifySearchError(makeError('This operation was aborted'), 'search');
		expect(result.mode).toBe('qdrant_proxy_drop');
		expect(result.message).toContain('light POST scroll also failed');
	});

	it('probe cannot run (unparsable listing) → legacy qdrant_proxy_drop, marked unverified', async () => {
		process.env.QDRANT_URL = 'https://qdrant.example.org';
		routeFetch({ scroll: 'ok', listing: false });
		const result = await classifySearchError(makeError('This operation was aborted'), 'search');
		expect(result.mode).toBe('qdrant_proxy_drop');
		expect(result.message).toContain('unverified');
	});

	// ── #4881 follow-ups c.7090296934: kill-switch + deadline budget ──

	it('(a) QDRANT_LIGHT_POST_PROBE=0 disables the light POST — no listing/scroll fetch, legacy unverified verdict', async () => {
		process.env.QDRANT_URL = 'https://qdrant.example.org';
		process.env.QDRANT_LIGHT_POST_PROBE = '0';
		try {
			routeFetch({ scroll: 'ok' });
			const result = await classifySearchError(makeError('This operation was aborted'), 'search');
			expect(result.mode).toBe('qdrant_proxy_drop');
			expect(result.message).toContain('unverified');
			const calledUrls = mockFetch.mock.calls.map((c) => String(c[0]));
			expect(calledUrls.some((u) => u.includes('/collections'))).toBe(false);
			expect(calledUrls.some((u) => u.includes('/points/scroll'))).toBe(false);
		} finally {
			delete process.env.QDRANT_LIGHT_POST_PROBE;
		}
	});

	it('(b) a deadline budget below 50 ms skips the probe entirely (no time for a useful probe)', async () => {
		process.env.QDRANT_URL = 'https://qdrant.example.org';
		routeFetch({ scroll: 'ok' });
		const result = await classifySearchError(makeError('This operation was aborted'), 'codebase_search', 30);
		expect(result.mode).toBe('qdrant_proxy_drop');
		expect(result.message).toContain('unverified');
		expect(mockFetch.mock.calls.some((c) => String(c[0]).includes('/collections'))).toBe(false);
	});

	it('(b) the light-POST probe aborts at min(budget - listing, 10 s) — the deadline response never loses the class', async () => {
		vi.useFakeTimers();
		try {
			process.env.QDRANT_URL = 'https://qdrant.example.org';
			mockFetch.mockImplementation(async (_url: unknown, init?: { signal?: AbortSignal }) => {
				const u = String(_url);
				if (u.endsWith('/healthz')) return { ok: true, status: 200 };
				if (u.endsWith('/collections')) return { ok: true, status: 200, json: async () => ({ result: { collections: [{ name: 'ws-a' }] } }) };
				if (u.includes('/points/scroll')) {
					// Stall the scroll forever; only the probe's own abort timer settles it.
					return await new Promise((_resolve, reject) => {
						init?.signal?.addEventListener('abort', () => { reject(new Error('This operation was aborted')); });
					});
				}
				throw new Error(`unexpected fetch: ${u}`);
			});
			const promise = classifySearchError(makeError('This operation was aborted'), 'codebase_search', 5000);
			// Advance past the scroll budget (5000 - 5000 listing = 0 → min(10000, 0)… but listing
			// consumed ~0 ms, so the scroll budget is min(10000, 5000) = 5000). Advancing 6000 ms
			// fires the probe's abort, which rejects the stalled scroll.
			await vi.advanceTimersByTimeAsync(6000);
			const result = await promise;
			// The scroll dropped (abort) → proxy_drop WITH proof, not the legacy
			// unverified verdict, and it resolved within the 5000 ms budget.
			expect(result.mode).toBe('qdrant_proxy_drop');
			expect(result.message).toContain('light POST scroll also failed');
		} finally {
			vi.useRealTimers();
		}
	});

	// #4352 review: roosync_search reports an embedding timeout under 'search'. The
	// OpenAI SDK's "Request timed out." must not be read as Qdrant being slow.
	it('an embedding SDK "Request timed out." on a loopback Qdrant is not blamed on Qdrant', async () => {
		process.env.QDRANT_URL = 'http://localhost:6333';
		mockFetch.mockResolvedValue({ ok: true, status: 200 });
		const result = await classifySearchError(makeError('Request timed out.'), 'search');
		expect(result.mode).not.toBe('qdrant_backend_slow');
		expect(result.mode).not.toBe('qdrant_proxy_drop');
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
		process.env.QDRANT_URL = 'https://qdrant.example.org';
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

// ── #3344: cause unwrapping + Qdrant-down vs client-failure disambiguation ──

describe('unwrapTransportCause (#3344)', () => {
	it('extracts errno from an undici fetch failed cause chain', () => {
		const inner: any = new Error('getaddrinfo ENOTFOUND qdrant.myia.io');
		inner.code = 'ENOTFOUND';
		const outer: any = new TypeError('fetch failed');
		outer.cause = inner;
		const unwrapped = unwrapTransportCause(outer);
		expect(unwrapped?.code).toBe('ENOTFOUND');
		expect(unwrapped?.message).toContain('ENOTFOUND');
	});

	it('handles the AggregateError DNS shape (.errors[])', () => {
		const e1: any = new Error('getaddrinfo ENOTFOUND qdrant.myia.io');
		e1.code = 'ENOTFOUND';
		const agg: any = new Error('All DNS requests failed');
		agg.errors = [e1];
		const outer: any = new TypeError('fetch failed');
		outer.cause = agg;
		const unwrapped = unwrapTransportCause(outer);
		expect(unwrapped?.code).toBe('ENOTFOUND');
	});

	it('returns null when the error has no cause', () => {
		expect(unwrapTransportCause(new Error('fetch failed'))).toBeNull();
	});

	it('stops at depth 5 on cyclic cause chains', () => {
		const a: any = new Error('a');
		const b: any = new Error('b');
		a.cause = b;
		b.cause = a;
		// No code/message beyond depth 5 — must terminate, not hang
		const unwrapped = unwrapTransportCause(a);
		expect(['a', 'b']).toContain(unwrapped?.message);
	});
});

describe('#3344 qdrant_client_failure vs qdrant_unreachable', () => {
	beforeEach(() => {
		mockFetch.mockReset();
	});

	function makeFetchFailed(causeCode: string, causeMsg: string): TypeError {
		const inner: any = new Error(causeMsg);
		inner.code = causeCode;
		const outer: any = new TypeError('fetch failed');
		outer.cause = inner;
		return outer as TypeError;
	}

	it('fetch failed + healthy /healthz probe → qdrant_client_failure (Qdrant UP, transport failed)', async () => {
		mockFetch.mockResolvedValue({ ok: true, status: 200 });
		const err = makeFetchFailed('ECONNRESET', 'read ECONNRESET');
		const result = await classifySearchError(err, 'codebase_search');
		expect(result.mode).toBe('qdrant_client_failure');
		expect(result.message).toContain('Qdrant is UP');
		expect(result.message).toContain('/healthz');
		// Real errno surfaced from the cause chain
		expect(result.originalError).toContain('ECONNRESET');
		expect(result.hint).toContain('do NOT treat this as backend-down');
	});

	it('fetch failed + dead probe → qdrant_unreachable with the REAL errno (not "unknown")', async () => {
		mockFetch.mockRejectedValue(new Error('probe refused'));
		const err = makeFetchFailed('ETIMEDOUT', 'connect ETIMEDOUT 1.2.3.4:443');
		const result = await classifySearchError(err, 'codebase_search');
		expect(result.mode).toBe('qdrant_unreachable');
		expect(result.message).toContain('ETIMEDOUT');
		expect(result.message).toContain('health probe also failed');
		expect(result.originalError).toContain('cause: ETIMEDOUT');
	});

	it('fetch failed + probe returns non-ok → qdrant_unreachable (backend unhealthy)', async () => {
		mockFetch.mockResolvedValue({ ok: false, status: 503 });
		const err = makeFetchFailed('ECONNREFUSED', 'connect ECONNREFUSED');
		const result = await classifySearchError(err, 'search');
		expect(result.mode).toBe('qdrant_unreachable');
	});

	it('bare fetch failed (no cause) + healthy probe → qdrant_client_failure with "no errno" hint', async () => {
		mockFetch.mockResolvedValue({ ok: true, status: 200 });
		const err = new TypeError('fetch failed');
		const result = await classifySearchError(err, 'search');
		expect(result.mode).toBe('qdrant_client_failure');
		expect(result.hint).toContain('no errno');
	});

	it('embedding op with unwrapped cause reports the errno in originalError', async () => {
		mockFetch.mockReset();
		const err = makeFetchFailed('ENOTFOUND', 'getaddrinfo ENOTFOUND embed.local');
		const result = await classifySearchError(err, 'embedding');
		expect(result.mode).toBe('embedding_unreachable');
		expect(result.originalError).toContain('ENOTFOUND');
	});
});

// ── #4438: which component a classified mode implicates ──

describe('failureComponent (#4438)', () => {
	it('maps the qdrant modes to qdrant', () => {
		expect(failureComponent('qdrant_unreachable')).toBe('qdrant');
		expect(failureComponent('qdrant_client_failure')).toBe('qdrant');
		expect(failureComponent('qdrant_proxy_drop')).toBe('qdrant');
		expect(failureComponent('qdrant_backend_slow')).toBe('qdrant');
		expect(failureComponent('qdrant_collection_missing')).toBe('qdrant');
	});

	it('maps the embedding modes to embeddings', () => {
		expect(failureComponent('embedding_unreachable')).toBe('embeddings');
		expect(failureComponent('embedding_timeout')).toBe('embeddings');
	});

	it('maps the two non-component modes to their own component', () => {
		expect(failureComponent('auth_failed')).toBe('auth');
		expect(failureComponent('resource_exhausted')).toBe('resources');
	});

	it('claims NO component for null or unknown', () => {
		expect(failureComponent(null)).toBeNull();
		expect(failureComponent('unknown')).toBeNull();
	});

	it('claims a component for EVERY mode of the FailureMode union except unknown', () => {
		// Add the new mode here when the union grows — a mode with no component
		// would make the degraded banner assert an owner it cannot know (#4438).
		const modes: FailureMode[] = [
			'embedding_unreachable', 'embedding_timeout',
			'qdrant_unreachable', 'qdrant_client_failure', 'qdrant_proxy_drop',
			'qdrant_backend_slow', 'qdrant_collection_missing',
			'auth_failed', 'resource_exhausted',
		];
		for (const mode of modes) {
			expect(failureComponent(mode), mode).not.toBeNull();
		}
	});
});

// ── #4736 P2: isTimeoutLikeError ─────────────────────────────────────────────

describe('isTimeoutLikeError', () => {
	// The Qdrant JS client's timeout message: 'Request Timeout' with a capital
	// T — the case-sensitive `includes('timeout')` checks in the classifier
	// missed it, which is why listWorkspaceCollections used to swallow it.
	it('recognizes the Qdrant client Request Timeout message', async () => {
		const { isTimeoutLikeError } = await import('../search-error-classifier.js');
		expect(isTimeoutLikeError(new Error('Request Timeout'))).toBe(true);
	});

	it('recognizes lowercase variants, timed out, and aborts', async () => {
		const { isTimeoutLikeError } = await import('../search-error-classifier.js');
		expect(isTimeoutLikeError(new Error('request timeout of 30000ms exceeded'))).toBe(true);
		expect(isTimeoutLikeError(new Error('The operation timed out'))).toBe(true);
		expect(isTimeoutLikeError(new Error('This operation was aborted'))).toBe(true);
	});

	it('recognizes the timeout error codes', async () => {
		const { isTimeoutLikeError } = await import('../search-error-classifier.js');
		expect(isTimeoutLikeError(makeError('generic', { code: 'ETIMEDOUT' }))).toBe(true);
		expect(isTimeoutLikeError(makeError('generic', { code: 'UND_ERR_CONNECT_TIMEOUT' }))).toBe(true);
	});

	it('does NOT claim a generic connection error or a 404', async () => {
		const { isTimeoutLikeError } = await import('../search-error-classifier.js');
		expect(isTimeoutLikeError(new Error('connection failed'))).toBe(false);
		expect(isTimeoutLikeError(makeError('Not Found', { status: 404 }))).toBe(false);
	});
});

// ── #4736 P2 review follow-ups (a)+(b): classifier-level routing of the
// 'Request Timeout' family — the predicate truth table above is necessary but
// not sufficient; the classifier itself must route these to the probe branch,
// case-aligned, and on HTTP 408 too. ─────────────────────────────────────────

describe('classifySearchError — Request Timeout family (#4736 P2 follow-ups)', () => {
	const originalQdrantUrl = process.env.QDRANT_URL;
	beforeEach(() => { mockFetch.mockReset(); });
	afterEach(() => {
		if (originalQdrantUrl === undefined) delete process.env.QDRANT_URL;
		else process.env.QDRANT_URL = originalQdrantUrl;
	});

	// (a) the literal Qdrant JS client message; (b) any case variant of it —
	// aligned on the one case-insensitive predicate.
	it.each([
		['Request Timeout'],   // the client's exact wording (capital T, no period)
		['request timeout'],   // lowercase variant
		['REQUEST TIMEOUT'],   // uppercase variant
	])('classifies %j on codebase_search as qdrant_backend_slow on a loopback Qdrant', async (msg) => {
		process.env.QDRANT_URL = 'http://localhost:6333';
		mockFetch.mockResolvedValue({ ok: true, status: 200 });
		const result = await classifySearchError(makeError(msg), 'codebase_search');
		expect(result.mode).toBe('qdrant_backend_slow');
	});

	it('classifies an HTTP 408 status into the timeout branch even with a plain message (follow-up b)', async () => {
		process.env.QDRANT_URL = 'http://localhost:6333';
		mockFetch.mockResolvedValue({ ok: true, status: 200 });
		const result = await classifySearchError(makeError('upstream returned 408', { status: 408 }), 'search');
		expect(result.mode).toBe('qdrant_backend_slow');
	});

	it("'Request Timeout' under operation='embedding' is an embedding_timeout, not unknown (case alignment)", async () => {
		const result = await classifySearchError(makeError('Request Timeout'), 'embedding');
		expect(result.mode).toBe('embedding_timeout');
	});

	// The contract the exclusion protects: the OpenAI SDK's phrasing (lowercase,
	// with a period) reported under 'search' by roosync_search stays OUT of the
	// Qdrant branches. Case alignment must not swallow this distinction.
	it('the embedding SDK "Request timed out." stays NOT blamed on Qdrant (regression pin)', async () => {
		process.env.QDRANT_URL = 'http://localhost:6333';
		mockFetch.mockResolvedValue({ ok: true, status: 200 });
		const result = await classifySearchError(makeError('Request timed out.'), 'search');
		expect(result.mode).not.toBe('qdrant_backend_slow');
		expect(result.mode).not.toBe('qdrant_proxy_drop');
	});
});
