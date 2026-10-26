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

	it('leaves the client byte-for-byte unchanged when the list is unset', () => {
		const plan = getEmbeddingEndpointPlan('index', env({}));
		expect(plan).toEqual({ endpoints: [], baseURL: undefined, fetch: undefined });

		const legacy = getEmbeddingEndpointPlan('index', env({ EMBEDDING_API_BASE_URL: 'https://embeddings.myia.io/v1' }));
		expect(legacy.baseURL).toBe('https://embeddings.myia.io/v1');
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
