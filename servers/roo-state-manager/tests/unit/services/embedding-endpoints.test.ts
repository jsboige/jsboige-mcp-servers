/**
 * #4352 (a5) — ordered embedding endpoints, transport-only failover.
 *
 * Pins the behaviours the coordinator's acceptance criteria depend on:
 *  - unset list = unchanged single-endpoint client (no wrapper);
 *  - ordered failover on connection failure, timeout and 5xx;
 *  - a 4xx is an answer and is NEVER hidden by a second endpoint;
 *  - a short interactive budget returns in seconds when every endpoint is dead;
 *  - negative cache stops re-paying for a known-dead endpoint;
 *  - a dimension mismatch refuses that endpoint instead of mixing vector spaces;
 *  - the canonical (first) endpoint is the supplement sentinel fingerprint.
 */
import { describe, expect, it, vi } from 'vitest';
import {
	createEmbeddingFailoverFetch,
	EmbeddingEndpointsUnavailableError,
	getCanonicalEmbeddingBaseUrl,
	getEmbeddingClientModeSettings,
	getEmbeddingClientTimeoutMs,
	getEmbeddingEndpointPlan,
	parseEmbeddingEndpoints,
} from '../../../src/services/embedding-endpoints.js';
import { getCodebaseEmbeddingEndpoint } from '../../../src/services/code-index/embedding-client.js';

function env(values: Record<string, string>): NodeJS.ProcessEnv {
	return { ...values } as NodeJS.ProcessEnv;
}

function embeddingResponse(dimension = 4, status = 200): Response {
	return new Response(JSON.stringify({ data: [{ embedding: new Array(dimension).fill(0.1) }] }), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

/** The SDK's default wire shape: float32 bytes encoded as base64. */
function base64EmbeddingResponse(dimension: number): Response {
	const vector = new Float32Array(dimension).fill(0.1);
	const embedding = Buffer.from(vector.buffer).toString('base64');
	return new Response(JSON.stringify({ data: [{ embedding }] }), {
		status: 200,
		headers: { 'content-type': 'application/json' },
	});
}

function failover(options: Partial<Parameters<typeof createEmbeddingFailoverFetch>[0]> = {}) {
	return createEmbeddingFailoverFetch({
		endpoints: ['http://lan:8004/v1', 'https://proxy.example/v1'],
		canonicalBaseURL: 'http://lan:8004/v1',
		perAttemptTimeoutMs: 1000,
		expectedDimensions: 4,
		negativeCacheMs: 60_000,
		warn: () => undefined,
		...options,
	});
}

describe('#4352 (a5) endpoint configuration', () => {
	it('parses, normalises and de-duplicates the ordered list', () => {
		expect(parseEmbeddingEndpoints(env({
			EMBEDDING_API_BASE_URLS: ' http://192.168.0.46:8004/v1/ , https://embeddings.myia.io/v1 ',
		}))).toEqual(['http://192.168.0.46:8004/v1', 'https://embeddings.myia.io/v1']);
		expect(parseEmbeddingEndpoints(env({
			EMBEDDING_API_BASE_URLS: 'http://a/v1,http://a/v1/',
		}))).toEqual(['http://a/v1']);
	});

	it('keeps the legacy single base URL form', () => {
		expect(parseEmbeddingEndpoints(env({ EMBEDDING_API_BASE_URL: 'https://embeddings.myia.io/v1/' })))
			.toEqual(['https://embeddings.myia.io/v1']);
	});

	it('fails loud on an invalid list instead of silently falling back', () => {
		expect(() => parseEmbeddingEndpoints(env({ EMBEDDING_API_BASE_URLS: 'not-a-url' }))).toThrow(/Invalid embedding endpoint/);
		expect(() => parseEmbeddingEndpoints(env({ EMBEDDING_API_BASE_URLS: 'ftp://example/v1' }))).toThrow(/http\(s\)/);
	});

	it('rejects URL userinfo and never echoes endpoint secrets in parse errors', () => {
		const secrets = ['s3cr3t', 'p4ssw0rd'];
		const invalidEndpoints = [
			'https://alice:s3cr3t@lan.example/v1',
			'https://p4ssw0rd@lan.example/v1',
			'ftp://alice:s3cr3t@lan.example/v1',
			'http://alice:p4ssw0rd@/v1',
		];
		for (const endpoint of invalidEndpoints) {
			let message = '';
			try {
				parseEmbeddingEndpoints(env({ EMBEDDING_API_BASE_URLS: endpoint }));
			} catch (error) {
				message = (error as Error).message;
			}
			expect(message, `endpoint ${endpoint} must be rejected`).not.toBe('');
			expect(message).not.toContain(endpoint);
			for (const secret of secrets) expect(message).not.toContain(secret);
		}
		expect(() => parseEmbeddingEndpoints(env({
			EMBEDDING_API_BASE_URLS: 'https://alice:s3cr3t@lan.example/v1',
		}))).toThrow(/must not carry URL userinfo/);
	});

	it('leaves the client byte-for-byte unchanged when the list is unset or non-public', () => {
		const plan = getEmbeddingEndpointPlan('index', env({}));
		expect(plan).toEqual({ endpoints: [], baseURL: undefined, fetch: undefined });

		// A NON-public single base stays a plain single-endpoint client (no
		// wrapper). The public-vhost case now gains the LAN-direct entry — see #4395.
		const legacy = getEmbeddingEndpointPlan('index', env({ EMBEDDING_API_BASE_URL: 'http://localhost:8080/v1' }));
		expect(legacy.baseURL).toBe('http://localhost:8080/v1');
		expect(legacy.fetch).toBeUndefined();
	});

	it('uses the canonical (first) endpoint for the sentinel fingerprint', () => {
		expect(getCanonicalEmbeddingBaseUrl(env({
			EMBEDDING_API_BASE_URLS: 'http://192.168.0.46:8004/v1,https://embeddings.myia.io/v1',
		}))).toBe('http://192.168.0.46:8004/v1');
		expect(getCanonicalEmbeddingBaseUrl(env({}))).toBeUndefined();
	});

	it('gives query clients a short per-endpoint timeout and a total budget', () => {
		const query = getEmbeddingClientModeSettings('query', env({}));
		expect(query.perAttemptTimeoutMs).toBe(6000);
		expect(query.totalBudgetMs).toBe(12000);
		expect(getEmbeddingClientTimeoutMs('query', 2, env({}))).toBe(14000);

		const index = getEmbeddingClientModeSettings('index', env({}));
		expect(index.perAttemptTimeoutMs).toBe(60000);
		expect(index.totalBudgetMs).toBeUndefined();
		expect(getEmbeddingClientTimeoutMs('index', 2, env({}))).toBe(125000);
	});
});

describe('#4352 (a5) failover classification', () => {
	it('fails over in order on a transport error and keeps the target path', async () => {
		const calls: string[] = [];
		const fetcher = vi.fn(async (url: string | URL | Request) => {
			const text = String(url);
			calls.push(text);
			if (text.startsWith('http://lan')) throw new TypeError('fetch failed');
			return embeddingResponse();
		});
		const response = await failover({ fetchImpl: fetcher as typeof fetch })(
			'http://lan:8004/v1/embeddings',
			{ method: 'POST', body: '{"input":"x"}' },
		);

		expect(response.status).toBe(200);
		expect(calls).toEqual([
			'http://lan:8004/v1/embeddings',
			'https://proxy.example/v1/embeddings',
		]);
	});

	it('does NOT fail over on a 4xx: the endpoint answered about the key/model', async () => {
		const fetcher = vi.fn(async () => new Response('unauthorized', { status: 401 }));
		const response = await failover({ fetchImpl: fetcher as typeof fetch })(
			'http://lan:8004/v1/embeddings',
			{ method: 'POST', body: '{}' },
		);

		expect(response.status).toBe(401);
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it('fails over on 5xx (an endpoint outage, not a request problem)', async () => {
		const calls: string[] = [];
		const fetcher = vi.fn(async (url: string | URL | Request) => {
			calls.push(String(url));
			return String(url).startsWith('http://lan') ? new Response('down', { status: 503 }) : embeddingResponse();
		});
		const response = await failover({ fetchImpl: fetcher as typeof fetch })(
			'http://lan:8004/v1/embeddings',
			{ method: 'POST', body: '{}' },
		);

		expect(response.status).toBe(200);
		expect(calls).toHaveLength(2);
	});

	it('negative-caches a dead endpoint so the next call is not delayed again', async () => {
		const calls: string[] = [];
		const fetcher = vi.fn(async (url: string | URL | Request) => {
			calls.push(String(url));
			if (String(url).startsWith('http://lan')) throw new TypeError('fetch failed');
			return embeddingResponse();
		});
		const fetchWithFailover = failover({ fetchImpl: fetcher as typeof fetch }) as typeof fetch;

		await fetchWithFailover('http://lan:8004/v1/embeddings', { method: 'POST', body: '{}' });
		await fetchWithFailover('http://lan:8004/v1/embeddings', { method: 'POST', body: '{}' });

		expect(calls.filter((url) => url.startsWith('http://lan'))).toHaveLength(1);
		expect(calls.filter((url) => url.startsWith('https://proxy'))).toHaveLength(2);
	});

	it('returns an unavailable error within the total budget when every endpoint hangs', async () => {
		const fetcher = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
			init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
		}));
		const fetchWithFailover = failover({
			fetchImpl: fetcher as typeof fetch,
			perAttemptTimeoutMs: 40,
			totalBudgetMs: 80,
			negativeCacheMs: 1,
		});

		const started = Date.now();
		await expect(fetchWithFailover('http://lan:8004/v1/embeddings', { method: 'POST', body: '{}' }))
			.rejects.toBeInstanceOf(EmbeddingEndpointsUnavailableError);
		expect(Date.now() - started).toBeLessThan(1000);
		expect(fetcher).toHaveBeenCalledTimes(2);
	});
});

describe('#4352 (a5) vector-space guard', () => {
	it('refuses an endpoint whose dimension differs and uses the compatible one', async () => {
		const calls: string[] = [];
		const fetcher = vi.fn(async (url: string | URL | Request) => {
			calls.push(String(url));
			return embeddingResponse(String(url).startsWith('http://lan') ? 3 : 4);
		});
		const fetchWithFailover = failover({
			fetchImpl: fetcher as typeof fetch,
			expectedDimensions: 4,
		}) as typeof fetch;

		const first = await fetchWithFailover('http://lan:8004/v1/embeddings', { method: 'POST', body: '{}' });
		expect(first.status).toBe(200);
		expect(calls).toEqual([
			'http://lan:8004/v1/embeddings',
			'https://proxy.example/v1/embeddings',
		]);

		// The incompatible endpoint is permanently out of rotation for this client.
		await fetchWithFailover('http://lan:8004/v1/embeddings', { method: 'POST', body: '{}' });
		expect(calls.filter((url) => url.startsWith('http://lan'))).toHaveLength(1);
	});

	it('surfaces a clear error when every endpoint serves the wrong dimension', async () => {
		const fetcher = vi.fn(async () => embeddingResponse(3));
		await expect(failover({
			fetchImpl: fetcher as typeof fetch,
			expectedDimensions: 4,
		})('http://lan:8004/v1/embeddings', { method: 'POST', body: '{}' }))
			.rejects.toThrow(/all embedding endpoints unavailable/i);
	});

	it('enforces the dimension guard on the SDK default base64 wire shape', async () => {
		const calls: string[] = [];
		const fetcher = vi.fn(async (url: string | URL | Request) => {
			calls.push(String(url));
			return base64EmbeddingResponse(String(url).startsWith('http://lan') ? 3 : 4);
		});
		const fetchWithFailover = failover({
			fetchImpl: fetcher as typeof fetch,
			expectedDimensions: 4,
		}) as typeof fetch;

		const response = await fetchWithFailover('http://lan:8004/v1/embeddings', { method: 'POST', body: '{}' });
		expect(response.status).toBe(200);
		expect(calls).toEqual([
			'http://lan:8004/v1/embeddings',
			'https://proxy.example/v1/embeddings',
		]);
		const payload = await response.json() as { data: Array<{ embedding: string }> };
		const bytes = Buffer.from(payload.data[0].embedding, 'base64');
		const decoded = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / Float32Array.BYTES_PER_ELEMENT);
		expect(decoded).toHaveLength(4);

		// A base64 mismatch alone is rejected: this failed under the previous
		// array-only guard, which returned the first response without failing over.
		const wrongDimension = vi.fn(async () => base64EmbeddingResponse(3));
		await expect(failover({
			fetchImpl: wrongDimension as typeof fetch,
			expectedDimensions: 4,
		})('http://lan:8004/v1/embeddings', { method: 'POST', body: '{}' }))
			.rejects.toThrow(/dimension 3 != 4/i);
	});
});

describe('#4395 (RX126) LAN-direct default', () => {
	// The public vhost the fleet embeds through, and the LAN backend it hides.
	const PUBLIC = 'https://embeddings.myia.io/v1';
	const LAN = 'http://myia-po-2023:8004/v1';

	it('public canonical → try order [LAN, public]; baseURL/canonical/fingerprint stay the vhost', () => {
		const e = env({ EMBEDDING_API_BASE_URL: PUBLIC, EMBEDDING_DIMENSIONS: '4' });
		const plan = getEmbeddingEndpointPlan('index', e);
		expect(plan.endpoints).toEqual([LAN, PUBLIC]);
		// The SDK base and the canonical are the vhost, NOT the LAN entry.
		expect(plan.baseURL).toBe(PUBLIC);
		expect(plan.fetch).toBeDefined();
		// The supplement sentinel fingerprint stays the vhost host → no rebuild.
		expect(getCanonicalEmbeddingBaseUrl(e)).toBe(PUBLIC);
	});

	it('keeps the vhost host in getCodebaseEmbeddingEndpoint() under LAN-direct', () => {
		const prev = process.env.EMBEDDING_API_BASE_URL;
		process.env.EMBEDDING_API_BASE_URL = PUBLIC;
		try {
			expect(getCodebaseEmbeddingEndpoint()).toBe('embeddings.myia.io');
		} finally {
			if (prev === undefined) delete process.env.EMBEDDING_API_BASE_URL;
			else process.env.EMBEDDING_API_BASE_URL = prev;
		}
	});

	it('a refused LAN (ECONNREFUSED/DNS) fails over to the public vhost, in order, /v1 kept', async () => {
		const calls: string[] = [];
		const fetcher = vi.fn(async (url: string | URL | Request) => {
			const text = String(url);
			calls.push(text);
			if (text.startsWith(LAN)) {
				const err = new TypeError('fetch failed');
				(err as { code?: string }).code = 'ECONNREFUSED';
				throw err;
			}
			return embeddingResponse(4);
		});
		vi.spyOn(globalThis, 'fetch').mockImplementation(fetcher as typeof fetch);
		try {
			const plan = getEmbeddingEndpointPlan('index', env({ EMBEDDING_API_BASE_URL: PUBLIC, EMBEDDING_DIMENSIONS: '4' }));
			// The SDK builds the request from the canonical (public) base.
			const response = await plan.fetch!(
				`${PUBLIC}/embeddings`,
				{ method: 'POST', body: '{"input":"x"}' },
			);
			expect(response.status).toBe(200);
			// LAN tried FIRST, then the public vhost — and /v1 preserved on both.
			expect(calls).toEqual([`${LAN}/embeddings`, `${PUBLIC}/embeddings`]);
		} finally {
			vi.restoreAllMocks();
		}
	});

	it('EMBEDDING_LAN_DIRECT=0 → public only, no fetch (legacy byte-for-byte)', () => {
		const plan = getEmbeddingEndpointPlan('index', env({
			EMBEDDING_API_BASE_URL: PUBLIC,
			EMBEDDING_LAN_DIRECT: '0',
		}));
		expect(plan.endpoints).toEqual([PUBLIC]);
		expect(plan.baseURL).toBe(PUBLIC);
		expect(plan.fetch).toBeUndefined();
	});

	it('a non-public canonical (custom URL) is left unchanged', () => {
		const plan = getEmbeddingEndpointPlan('index', env({
			EMBEDDING_API_BASE_URL: 'http://localhost:8080/v1',
		}));
		expect(plan.endpoints).toEqual(['http://localhost:8080/v1']);
		expect(plan.baseURL).toBe('http://localhost:8080/v1');
		expect(plan.fetch).toBeUndefined();
	});

	it('explicit list, public first → LAN inserted first; no duplicate if LAN already listed', () => {
		// Public vhost first, LAN not listed → LAN inserted at the front.
		const inserted = getEmbeddingEndpointPlan('index', env({
			EMBEDDING_API_BASE_URLS: `${PUBLIC},https://backup.example/v1`,
		}));
		expect(inserted.endpoints).toEqual([LAN, PUBLIC, 'https://backup.example/v1']);
		expect(inserted.baseURL).toBe(PUBLIC);

		// LAN already in the list → kept, not duplicated, order preserved.
		const noDup = getEmbeddingEndpointPlan('index', env({
			EMBEDDING_API_BASE_URLS: `${PUBLIC},${LAN}`,
		}));
		expect(noDup.endpoints).toEqual([PUBLIC, LAN]);
		expect(noDup.baseURL).toBe(PUBLIC);
	});

	it('EMBEDDING_LAN_DIRECT_URL overrides the default LAN target', () => {
		const plan = getEmbeddingEndpointPlan('index', env({
			EMBEDDING_API_BASE_URL: PUBLIC,
			EMBEDDING_LAN_DIRECT_URL: 'http://10.0.0.7:9001/v1/',
		}));
		expect(plan.endpoints).toEqual(['http://10.0.0.7:9001/v1', PUBLIC]);
		expect(plan.baseURL).toBe(PUBLIC);
	});

	it('a malformed EMBEDDING_LAN_DIRECT_URL falls back to the default LAN and still serves', async () => {
		const calls: string[] = [];
		const fetcher = vi.fn(async (url: string | URL | Request) => {
			calls.push(String(url));
			return embeddingResponse(4);
		});
		vi.spyOn(globalThis, 'fetch').mockImplementation(fetcher as typeof fetch);
		const warn = vi.spyOn(console, 'warn');
		try {
			const plan = getEmbeddingEndpointPlan('index', env({
				EMBEDDING_API_BASE_URL: PUBLIC,
				EMBEDDING_LAN_DIRECT_URL: 'not-a-valid-url',
				EMBEDDING_DIMENSIONS: '4',
			}));
			// Falls back to the DEFAULT LAN target (NOT public-only); vhost stays canonical.
			expect(plan.endpoints).toEqual([LAN, PUBLIC]);
			expect(plan.baseURL).toBe(PUBLIC);
			// ...and it still serves: the call goes out and comes back 200.
			const response = await plan.fetch!(`${PUBLIC}/embeddings`, { method: 'POST', body: '{}' });
			expect(response.status).toBe(200);
			expect(calls).toHaveLength(1);
			// The fallback names the variable in its warn.
			expect(warn).toHaveBeenCalledWith(expect.stringContaining('EMBEDDING_LAN_DIRECT_URL'));
		} finally {
			vi.restoreAllMocks();
		}
	});
});
