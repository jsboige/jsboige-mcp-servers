/**
 * #4823: the failover wrapper must consume a success body exactly ONCE — never
 * via `Response.clone()` — and hand the caller a response it can still read.
 *
 * Root cause (measured, Node 24 + npm undici 7.29.1): `Response.clone()` tees
 * the body and re-registers the original response in undici's `streamRegistry`
 * FinalizationRegistry, holding a WeakRef to the branch the original keeps —
 * the branch the caller is about to read. In `await response.clone().json()`
 * the clone object is an unreachable temporary: a GC landing in the read window
 * fires the finalizer, which cancels the caller-bound branch ("Response object
 * has been garbage collected"), and the caller's `.json()` dies as
 * `TypeError: Body is unusable: Body has already been read`. On web1's off-LAN
 * canary every embed took the failover path (dead LAN primary), so every
 * success passed through the clone-based dimension check: ~2% of lots failed
 * per pass and the largest files never converged.
 *
 * The race itself is not CI-reproducible (it needs a GC inside a millisecond
 * window); the deterministic guard is the INVARIANT: on any path that hands a
 * response to the caller, the wrapper must not have cloned it. With the
 * pre-fix `dimensionOf` (clone-based), the spy records one call and these
 * tests go RED.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as http from 'http';
import { AddressInfo } from 'net';
import { createEmbeddingFailoverFetch, type EmbeddingFetch } from '../embedding-endpoints.js';

const SDK_LIKE_INIT: RequestInit = {
	method: 'POST',
	headers: {
		accept: 'application/json',
		authorization: 'Bearer test-key-4823',
		'content-type': 'application/json',
	},
	body: JSON.stringify({ model: 'm', input: 'ping' }),
};

function jsonServer(portEmbedding: number[]): Promise<{ server: http.Server; baseUrl: string }> {
	const server = http.createServer((req, res) => {
		req.on('data', () => undefined);
		req.on('end', () => {
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ data: [{ embedding: portEmbedding }] }));
		});
	});
	return new Promise((resolve) => {
		server.listen(0, '127.0.0.1', () => {
			resolve({ server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` });
		});
	});
}

describe('#4823 success path reads the body once (no Response.clone)', () => {
	let server: http.Server;
	let baseUrl: string;
	let cloneSpy: ReturnType<typeof vi.spyOn>;
	let fetchImpl: EmbeddingFetch;

	beforeEach(async () => {
		({ server, baseUrl } = await jsonServer([1, 2, 3]));
		cloneSpy = vi.spyOn(Response.prototype, 'clone');
		fetchImpl = ((input: Parameters<EmbeddingFetch>[0], init?: RequestInit) =>
			fetch(input, init)) as EmbeddingFetch;
	});

	afterEach(async () => {
		cloneSpy.mockRestore();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	it('returns a readable response without ever cloning it (clone-based dimension check = RED)', async () => {
		const failover = createEmbeddingFailoverFetch({
			endpoints: [baseUrl],
			canonicalBaseURL: baseUrl,
			perAttemptTimeoutMs: 5000,
			expectedDimensions: 3,
			fetchImpl,
			warn: () => undefined,
			info: () => undefined,
		});

		const response = await failover(`${baseUrl}/embeddings`, SDK_LIKE_INIT);
		expect(response.status).toBe(200);
		// The caller (openai SDK) must still be able to read the body exactly once.
		expect(response.bodyUsed).toBe(false);
		const payload = (await response.json()) as { data: Array<{ embedding: number[] }> };
		expect(payload.data[0].embedding).toEqual([1, 2, 3]);
		// The regression guard: no tee, no streamRegistry re-registration, no race.
		expect(cloneSpy).not.toHaveBeenCalled();
	}, 15000);

	it('dimension classification survives the rewrite: a mismatching endpoint is refused, the next one serves', async () => {
		const { server: wrongServer, baseUrl: wrongUrl } = await jsonServer([1, 2, 3, 4]);
		const warns: string[] = [];
		try {
			const failover = createEmbeddingFailoverFetch({
				endpoints: [wrongUrl, baseUrl],
				canonicalBaseURL: baseUrl,
				perAttemptTimeoutMs: 5000,
				expectedDimensions: 3,
				fetchImpl,
				warn: (message) => warns.push(message),
				info: () => undefined,
			});

			const response = await failover(`${baseUrl}/embeddings`, SDK_LIKE_INIT);
			expect(response.status).toBe(200);
			const payload = (await response.json()) as { data: Array<{ embedding: number[] }> };
			expect(payload.data[0].embedding).toEqual([1, 2, 3]);
			expect(warns.join(' | ')).toContain('dimension 4 != 3');
			expect(cloneSpy).not.toHaveBeenCalled();
		} finally {
			await new Promise<void>((resolve) => wrongServer.close(() => resolve()));
		}
	}, 15000);

	it('the reconstructed response carries the original status and content-type', async () => {
		const failover = createEmbeddingFailoverFetch({
			endpoints: [baseUrl],
			canonicalBaseURL: baseUrl,
			perAttemptTimeoutMs: 5000,
			expectedDimensions: 3,
			fetchImpl,
			warn: () => undefined,
			info: () => undefined,
		});

		const response = await failover(`${baseUrl}/embeddings`, SDK_LIKE_INIT);
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('application/json');
	}, 15000);

	it('fails over when the success body read rejects — transport failure, not caller error (CHANGES ai-01 19/11)', async () => {
		const calls: string[] = [];
		const warns: string[] = [];
		const brokenBody = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.error(new Error('socket hang up while streaming the success body'));
			},
		});
		const routingFetch: EmbeddingFetch = async (input, init) => {
			if (urlOf(input).startsWith('http://broken.test')) {
				calls.push('broken');
				return new Response(brokenBody, { status: 200, headers: { 'content-type': 'application/json' } });
			}
			calls.push('serving');
			return fetch(input, init);
		};
		const failover = createEmbeddingFailoverFetch({
			endpoints: ['http://broken.test/v1', baseUrl],
			canonicalBaseURL: baseUrl,
			perAttemptTimeoutMs: 5000,
			expectedDimensions: 3,
			fetchImpl: routingFetch,
			warn: (message) => warns.push(message),
			info: () => undefined,
		});

		const response = await failover(`${baseUrl}/embeddings`, SDK_LIKE_INIT);
		expect(response.status).toBe(200);
		const payload = (await response.json()) as { data: Array<{ embedding: number[] }> };
		expect(payload.data[0].embedding).toEqual([1, 2, 3]);
		expect(calls).toEqual(['broken', 'serving']);
		expect(warns.join(' | ')).toContain('reading the success body');
		expect(cloneSpy).not.toHaveBeenCalled();
	}, 15000);

	it('preserves a bodyless status (204) instead of rebuilding it — rebuilding throws', async () => {
		const failover = createEmbeddingFailoverFetch({
			endpoints: ['http://a.test/v1', 'http://b.test/v1'],
			canonicalBaseURL: 'http://a.test/v1',
			perAttemptTimeoutMs: 5000,
			expectedDimensions: 3,
			fetchImpl: async () => new Response(null, { status: 204 }),
			warn: () => undefined,
			info: () => undefined,
		});

		const response = await failover('http://a.test/v1/embeddings', SDK_LIKE_INIT);
		expect(response.status).toBe(204);
		expect(await response.text()).toBe('');
	}, 15000);

	it('does not fail over on invalid JSON — the read succeeded, the caller parse reports it', async () => {
		let secondHits = 0;
		const failover = createEmbeddingFailoverFetch({
			endpoints: ['http://a.test/v1', 'http://b.test/v1'],
			canonicalBaseURL: 'http://a.test/v1',
			perAttemptTimeoutMs: 5000,
			expectedDimensions: 3,
			fetchImpl: async (input) => {
				if (urlOf(input).includes('b.test')) secondHits += 1;
				return new Response('not json at all', { status: 200, headers: { 'content-type': 'application/json' } });
			},
			warn: () => undefined,
			info: () => undefined,
		});

		const response = await failover('http://a.test/v1/embeddings', SDK_LIKE_INIT);
		expect(await response.text()).toBe('not json at all');
		expect(secondHits).toBe(0);
	}, 15000);

	it('caller cancellation during the body read is never turned into a failover', async () => {
		const controller = new AbortController();
		const calls: string[] = [];
		const failover = createEmbeddingFailoverFetch({
			endpoints: ['http://a.test/v1', 'http://b.test/v1'],
			canonicalBaseURL: 'http://a.test/v1',
			perAttemptTimeoutMs: 5000,
			expectedDimensions: 3,
			fetchImpl: async (input) => {
				calls.push(urlOf(input).includes('b.test') ? 'second' : 'first');
				const stream = new ReadableStream<Uint8Array>({
					start(streamController) {
						controller.signal.addEventListener(
							'abort',
							() => streamController.error(new DOMException('The operation was aborted.', 'AbortError')),
							{ once: true },
						);
					},
				});
				return new Response(stream, { status: 200 });
			},
			warn: () => undefined,
			info: () => undefined,
		});

		const pending = failover('http://a.test/v1/embeddings', { ...SDK_LIKE_INIT, signal: controller.signal });
		setTimeout(() => controller.abort(), 10);
		await expect(pending).rejects.toThrow();
		expect(calls).toEqual(['first']);
	}, 15000);
});

function urlOf(input: Parameters<EmbeddingFetch>[0]): string {
	if (typeof input === 'string') return input;
	if (input instanceof URL) return input.toString();
	return input.url;
}
