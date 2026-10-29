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
	getEmbeddingShadowingStatus,
	parseEmbeddingEndpoints,
	recordEmbeddingFileConfig,
	resetEmbeddingFileConfigForTest,
} from '../../../src/services/embedding-endpoints.js';
import { captureHostEnvKeys, resetHostEnvKeysForTest } from '../../../src/services/host-env-snapshot.js';
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

describe('#4352 (deadep) host-dead configured endpoint falls back to the .env canonical', () => {
	// The ai-01 measurement (c.6478415645): the VS Code host carried po-2026's dead
	// LAN address while the `.env` said the public vhost; a shadowed SINGLE endpoint
	// armed no wrapper and indexed nothing.
	const FILE_CANONICAL = 'https://embeddings.myia.io/v1';
	const DEAD_HOST = 'http://192.168.0.51:8004/v1';

	afterEach(() => {
		resetEmbeddingFileConfigForTest();
		resetHostEnvKeysForTest();
		vi.restoreAllMocks();
	});

	it('a dead configured endpoint + healthy .env canonical → the call succeeds', async () => {
		recordEmbeddingFileConfig({ EMBEDDING_API_BASE_URL: FILE_CANONICAL });
		const calls: string[] = [];
		const fetcher = vi.fn(async (url: string | URL | Request) => {
			const text = String(url);
			calls.push(text);
			if (text.startsWith(DEAD_HOST)) {
				const err = new TypeError('fetch failed');
				(err as { code?: string }).code = 'ECONNREFUSED';
				throw err;
			}
			return embeddingResponse(4);
		});
		vi.spyOn(globalThis, 'fetch').mockImplementation(fetcher as typeof fetch);
		const plan = getEmbeddingEndpointPlan('index', env({
			EMBEDDING_API_BASE_URL: DEAD_HOST,
			EMBEDDING_DIMENSIONS: '4',
		}));
		// The wrapper IS armed: the shadowed single endpoint is no longer alone.
		expect(plan.fetch).toBeDefined();
		const response = await plan.fetch!(`${DEAD_HOST}/embeddings`, { method: 'POST', body: '{}' });
		expect(response.status).toBe(200);
		// Dead host tried first, then the .env canonical — /v1 preserved on both.
		expect(calls).toEqual([`${DEAD_HOST}/embeddings`, `${FILE_CANONICAL}/embeddings`]);
	});

	it('the fallback attempt carries the FILE key, not the client key (review ai-01 28/10)', async () => {
		// Key A on the configured (host) client, key B in the `.env` record: the
		// appended canonical must be reached with B — A there is a fabricated 401
		// (or a Bearer handed to a service it was never issued for).
		recordEmbeddingFileConfig({ EMBEDDING_API_BASE_URL: FILE_CANONICAL, EMBEDDING_API_KEY: 'key-B' });
		const auths: Array<{ url: string; authorization: string | null }> = [];
		const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			const text = String(url);
			auths.push({ url: text, authorization: new Headers(init?.headers).get('authorization') });
			if (text.startsWith(DEAD_HOST)) {
				const err = new TypeError('fetch failed');
				(err as { code?: string }).code = 'ECONNREFUSED';
				throw err;
			}
			return embeddingResponse(4);
		});
		vi.spyOn(globalThis, 'fetch').mockImplementation(fetcher as typeof fetch);
		const plan = getEmbeddingEndpointPlan('index', env({
			EMBEDDING_API_BASE_URL: DEAD_HOST,
			EMBEDDING_DIMENSIONS: '4',
		}));
		// The SDK built this request with the HOST key.
		await plan.fetch!(`${DEAD_HOST}/embeddings`, {
			method: 'POST',
			body: '{}',
			headers: { Authorization: 'Bearer key-A' },
		});
		// The configured endpoint keeps the caller's Authorization; the appended
		// canonical is attempted with ITS OWN `.env` key.
		expect(auths).toEqual([
			{ url: `${DEAD_HOST}/embeddings`, authorization: 'Bearer key-A' },
			{ url: `${FILE_CANONICAL}/embeddings`, authorization: 'Bearer key-B' },
		]);
	});

	it('no file key recorded → the fallback keeps the caller Authorization', async () => {
		// The `.env` names the canonical but no key: nothing to substitute, the
		// attempt goes out exactly as the SDK built it.
		recordEmbeddingFileConfig({ EMBEDDING_API_BASE_URL: FILE_CANONICAL });
		const auths: string[] = [];
		const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			auths.push(new Headers(init?.headers).get('authorization') ?? '(none)');
			if (String(url).startsWith(DEAD_HOST)) {
				const err = new TypeError('fetch failed');
				(err as { code?: string }).code = 'ECONNREFUSED';
				throw err;
			}
			return embeddingResponse(4);
		});
		vi.spyOn(globalThis, 'fetch').mockImplementation(fetcher as typeof fetch);
		const plan = getEmbeddingEndpointPlan('index', env({
			EMBEDDING_API_BASE_URL: DEAD_HOST,
			EMBEDDING_DIMENSIONS: '4',
		}));
		await plan.fetch!(`${DEAD_HOST}/embeddings`, {
			method: 'POST',
			body: '{}',
			headers: { Authorization: 'Bearer key-A' },
		});
		expect(auths).toEqual(['Bearer key-A', 'Bearer key-A']);
	});

	it('a HEALTHY configured endpoint answers and is never replaced (negative control)', async () => {
		recordEmbeddingFileConfig({ EMBEDDING_API_BASE_URL: FILE_CANONICAL });
		const calls: string[] = [];
		const fetcher = async (url: string | URL | Request) => {
			calls.push(String(url));
			return embeddingResponse(4);
		};
		vi.spyOn(globalThis, 'fetch').mockImplementation(fetcher as typeof fetch);
		const plan = getEmbeddingEndpointPlan('index', env({
			EMBEDDING_API_BASE_URL: 'http://healthy-host:8004/v1',
			EMBEDDING_DIMENSIONS: '4',
		}));
		const response = await plan.fetch!('http://healthy-host:8004/v1/embeddings', { method: 'POST', body: '{}' });
		expect(response.status).toBe(200);
		// Served by the configured endpoint; the canonical was never contacted.
		expect(calls).toEqual(['http://healthy-host:8004/v1/embeddings']);
	});

	it('appends the file canonical but keeps the configured endpoint as SDK baseURL', () => {
		recordEmbeddingFileConfig({ EMBEDDING_API_BASE_URL: FILE_CANONICAL });
		const plan = getEmbeddingEndpointPlan('index', env({ EMBEDDING_API_BASE_URL: DEAD_HOST }));
		expect(plan.endpoints).toEqual([DEAD_HOST, FILE_CANONICAL]);
		// The SDK base (and the supplement fingerprint) stays the CONFIGURED value:
		// the fallback must not look like an endpoint switch for the collection.
		expect(plan.baseURL).toBe(DEAD_HOST);
	});

	it('warns once per shadowing episode, naming BOTH hosts and the masking layer (review ai-01 28/10)', () => {
		recordEmbeddingFileConfig({ EMBEDDING_API_BASE_URL: FILE_CANONICAL });
		captureHostEnvKeys({ RSM_HOST_ENV_KEYS: 'EMBEDDING_API_BASE_URL' } as NodeJS.ProcessEnv);
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		getEmbeddingEndpointPlan('index', env({ EMBEDDING_API_BASE_URL: DEAD_HOST }));
		getEmbeddingEndpointPlan('query', env({ EMBEDDING_API_BASE_URL: DEAD_HOST }));
		// Same configured/file pair → one warn, not one per client build.
		expect(warn).toHaveBeenCalledTimes(1);
		const message = warn.mock.calls[0][0];
		// Both labels are named: which configured endpoint, which canonical.
		expect(message).toContain('192.168.0.51:8004');
		expect(message).toContain('embeddings.myia.io');
		expect(message).toContain('host process env');
		// A different pair re-arms the episode.
		getEmbeddingEndpointPlan('index', env({ EMBEDDING_API_BASE_URL: 'http://other:8004/v1' }));
		expect(warn).toHaveBeenCalledTimes(2);
	});

	it('no shadowing (file canonical == configured) → nothing appended', () => {
		// Non-vhost canonical on purpose: the vhost form arms LAN-direct (#4395),
		// which is a different (and already pinned) try-order change.
		recordEmbeddingFileConfig({ EMBEDDING_API_BASE_URL: 'http://custom:8004/v1' });
		const plan = getEmbeddingEndpointPlan('index', env({ EMBEDDING_API_BASE_URL: 'http://custom:8004/v1' }));
		expect(plan.endpoints).toEqual(['http://custom:8004/v1']);
		expect(plan.fetch).toBeUndefined();
	});

	it('no file record → unchanged single-endpoint plan', () => {
		const plan = getEmbeddingEndpointPlan('index', env({ EMBEDDING_API_BASE_URL: DEAD_HOST }));
		expect(plan.endpoints).toEqual([DEAD_HOST]);
		expect(plan.fetch).toBeUndefined();
	});

	it('a malformed file value is ignored, not fatal', () => {
		recordEmbeddingFileConfig({ EMBEDDING_API_BASE_URL: 'not-a-url' });
		const plan = getEmbeddingEndpointPlan('index', env({ EMBEDDING_API_BASE_URL: DEAD_HOST }));
		expect(plan.endpoints).toEqual([DEAD_HOST]);
		expect(plan.fetch).toBeUndefined();
	});

	it('getEmbeddingShadowingStatus names both hosts, or null when aligned', () => {
		// No file record → nothing to compare → null.
		expect(getEmbeddingShadowingStatus(env({ EMBEDDING_API_BASE_URL: DEAD_HOST }))).toBeNull();
		recordEmbeddingFileConfig({ EMBEDDING_API_BASE_URL: FILE_CANONICAL });
		captureHostEnvKeys({ RSM_HOST_ENV_KEYS: 'EMBEDDING_API_BASE_URL' } as NodeJS.ProcessEnv);
		expect(getEmbeddingShadowingStatus(env({ EMBEDDING_API_BASE_URL: DEAD_HOST }))).toEqual({
			configuredHost: '192.168.0.51:8004',
			fileCanonicalHost: 'embeddings.myia.io',
			layer: expect.stringContaining('host process env'),
		});
		// Aligned (configured == file canonical) → null.
		expect(getEmbeddingShadowingStatus(env({ EMBEDDING_API_BASE_URL: FILE_CANONICAL }))).toBeNull();
	});
});
