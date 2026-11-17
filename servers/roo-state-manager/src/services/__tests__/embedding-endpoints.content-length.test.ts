/**
 * #4823: the failover wrapper must not forward an explicit `content-length`
 * header to fetch.
 *
 * Each test below is written so that removing the guard it covers turns it
 * RED — a test that would still pass with the guard deleted proves nothing.
 *
 * Root cause (measured, Node 24.14.1): the built-in fetch appends its own
 * computed content-length to any caller-set one, serialising the header as
 * `"N, N"` at dispatch. Node's bundled dispatcher tolerates that; the npm
 * `undici` dispatcher (7.29.1, required transitively by
 * `@qdrant/js-client-rest`) throws
 * `InvalidArgumentError [UND_ERR_INVALID_ARG]: invalid content-length header`
 * BEFORE any connection — and requiring npm `undici` while the process-global
 * dispatcher slot is still empty installs its Agent process-wide
 * (`Symbol.for('undici.globalDispatcher.1')` is shared with the bundled copy).
 * The full server loads the Qdrant client before the first embedding call, so
 * every OpenAI-SDK POST (the SDK sets `content-length` explicitly) failed as
 * `TypeError: fetch failed` with zero undici debug lines toward the embedder.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as http from 'http';
import { AddressInfo } from 'net';
import { createEmbeddingFailoverFetch, type EmbeddingFetch } from '../embedding-endpoints.js';

/** The exact init shape openai@4 (`core.js` buildRequest/buildHeaders) hands fetch. */
const SDK_LIKE_INIT: RequestInit = {
	method: 'POST',
	headers: {
		accept: 'application/json',
		authorization: 'Bearer test-key-4823',
		'content-length': '57',
		'content-type': 'application/json',
	},
	body: JSON.stringify({ model: 'm', input: 'ping' }),
};

function invalidContentLengthError(): Error {
	const err = new Error('invalid content-length header') as Error & { code?: string; name: string };
	err.name = 'InvalidArgumentError';
	err.code = 'UND_ERR_INVALID_ARG';
	return err;
}

function okEmbeddingResponse(embedding: number[] = [1, 2, 3]): Response {
	return new Response(JSON.stringify({ data: [{ embedding }] }), {
		status: 200,
		headers: { 'content-type': 'application/json' },
	});
}

describe('#4823 explicit content-length through the failover wrapper', () => {
	it('strips the SDK-set content-length before calling fetch (an undici-strict fetch rejects it)', async () => {
		const seenContentLength: Array<string | null> = [];
		const seenAuthorization: Array<string | null> = [];
		const fetchImpl = vi.fn(async (_input: Parameters<EmbeddingFetch>[0], init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			seenContentLength.push(headers.get('content-length'));
			seenAuthorization.push(headers.get('authorization'));
			// npm undici 7.29.1 processHeader: any explicit content-length fails
			// isValidContentLengthHeaderValue once internal fetch has doubled it.
			if (headers.has('content-length')) throw invalidContentLengthError();
			return okEmbeddingResponse();
		}) as unknown as EmbeddingFetch;

		const failover = createEmbeddingFailoverFetch({
			endpoints: ['http://a.test/v1', 'http://b.test/v1'],
			canonicalBaseURL: 'http://a.test/v1',
			perAttemptTimeoutMs: 5000,
			expectedDimensions: 3,
			fetchImpl,
			warn: () => undefined,
			info: () => undefined,
		});

		const response = await failover('http://a.test/v1/embeddings', SDK_LIKE_INIT);
		expect(response.status).toBe(200);
		// The header never reached the fetch implementation…
		expect(seenContentLength[0]).toBeNull();
		// …and nothing else was lost in the normalisation.
		expect(seenAuthorization[0]).toBe('Bearer test-key-4823');
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it('leaves an init without content-length untouched (no reshaping)', async () => {
		const originalHeaders = { 'content-type': 'application/json' };
		const fetchImpl = vi.fn(async () => okEmbeddingResponse()) as unknown as EmbeddingFetch;
		const failover = createEmbeddingFailoverFetch({
			endpoints: ['http://a.test/v1'],
			canonicalBaseURL: 'http://a.test/v1',
			perAttemptTimeoutMs: 5000,
			expectedDimensions: 3,
			fetchImpl,
			warn: () => undefined,
		});
		await failover('http://a.test/v1/embeddings', {
			method: 'POST',
			headers: originalHeaders,
			body: JSON.stringify({ model: 'm', input: 'ping' }),
		});
		const init = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
		expect(init.headers).toBe(originalHeaders);
	});
});

describe('#4823 real regression against the npm undici dispatcher', () => {
	let server: http.Server;
	let baseUrl: string;
	let sawContentLength: string | string[] | undefined;

	beforeEach(async () => {
		sawContentLength = undefined;
		server = http.createServer((req, res) => {
			let chunks = 0;
			req.on('data', () => {
				chunks += 1;
			});
			req.on('end', () => {
				sawContentLength = req.headers['content-length'];
				res.writeHead(200, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ data: [{ embedding: [1, 2, 3] }], chunks }));
			});
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
	});

	afterEach(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	it('an SDK init with explicit content-length survives dispatch through the npm undici Agent', async () => {
		const { Agent } = await import('undici');
		const npmAgent = new Agent();
		// The wrapper passes unknown init keys through, so the test pins the
		// dispatcher explicitly — exactly the process state the full server ends
		// up in (npm Agent owning the global slot), deterministically.
		const fetchImpl: EmbeddingFetch = ((input: Parameters<EmbeddingFetch>[0], init?: RequestInit) =>
			fetch(input, init)) as EmbeddingFetch;

		const failover = createEmbeddingFailoverFetch({
			endpoints: [baseUrl],
			canonicalBaseURL: baseUrl,
			perAttemptTimeoutMs: 5000,
			expectedDimensions: 3,
			fetchImpl,
			warn: () => undefined,
		});

		const body = JSON.stringify({ model: 'm', input: 'ping' });
		const response = await failover(`${baseUrl}/embeddings`, {
			...SDK_LIKE_INIT,
			body,
			// The header must match the body actually sent, as the SDK computes it.
			headers: { ...SDK_LIKE_INIT.headers, 'content-length': String(body.length) },
			// Deterministic vehicle for the regression: the npm undici dispatcher,
			// exactly what the process-global slot holds in the full server.
			dispatcher: npmAgent,
		} as RequestInit);

		expect(response.status).toBe(200);
		// One digits-only content-length reached the wire — not "N, N", not absent.
		expect(sawContentLength).toBe(String(body.length));
	}, 15000);
});
