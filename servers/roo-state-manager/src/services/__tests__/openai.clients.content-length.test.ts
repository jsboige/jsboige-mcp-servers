/**
 * #4824 — the three OpenAI clients ms#1801 did not cover, versus the doubled
 * content-length rejection (#4823).
 *
 * MEASURED (po-204, 17/11 — Node 24.6.0 + portable 24.14.1, undici 7.29.1,
 * openai 4.104.0): under the `node` condition the SDK's auto shim
 * (`openai/_shims/auto/runtime` → `runtime-node.mjs`) resolves its transport to
 * node-fetch v2 (node:http-based), NOT the built-in fetch — so the chat
 * clients and the single-endpoint embedding plan never traverse the
 * process-global undici dispatcher, where a caller-set content-length is
 * doubled ("N, N") and rejected pre-connect (UND_ERR_INVALID_ARG, the #4823
 * failure). Only the embedding FAILOVER wrapper routes through global fetch —
 * the path ms#1801 fixed.
 *
 * What these tests pin:
 * 1. The single-endpoint embedding client hands its fetch an init WITHOUT the
 *    SDK's explicit content-length (red before the #4824 wiring, green after):
 *    whatever transport the SDK picks, its POST init cannot carry a redundant
 *    content-length into a doubled-header-rejecting fetch.
 * 2. The measured immunity itself: a chat POST (primary or cloud fallback)
 *    traverses NO undici pipeline (zero `undici:request:create` events). The
 *    day an SDK bump swaps node-fetch for the built-in fetch — the direction
 *    openai v5 took — these tripwires go red and the #4824 assessment must be
 *    redone, with a stripping fetch then load-bearing for the chat clients.
 *    Deliberately NOT wired today: routing chat through global fetch would
 *    replace the SDK's agentkeepalive transport (agent timeout bumped to the
 *    30-min condensation ceiling) with undici Agent defaults
 *    (headersTimeout/bodyTimeout 300 s) — trading a measured-absent failure
 *    for a real one on >5-min thinking-mode condensations.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// The global setup (tests/setup/jest.setup.js) mocks 'openai' with no default
// export — these tests need the REAL SDK, whose transport choice (node-fetch
// under the node condition) is the very thing under measurement.
vi.unmock('openai');
import * as http from 'http';
import { AddressInfo } from 'net';
import diagnosticsChannel from 'node:diagnostics_channel';
import {
	getChatOpenAIClient,
	getEmbeddingQueryClient,
	getFallbackChatOpenAIClient,
	resetChatOpenAIClient,
	resetEmbeddingOpenAIClient,
	resetFallbackChatOpenAIClient,
} from '../openai.js';
import { getEmbeddingEndpointPlan } from '../embedding-endpoints.js';

/** The exact init shape openai@4 (`core.js` buildRequest/buildHeaders) hands fetch. */
const SDK_LIKE_INIT: RequestInit = {
	method: 'POST',
	headers: {
		accept: 'application/json',
		authorization: 'Bearer test-key-4824',
		'content-length': '28',
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

function chatCompletionResponse(): string {
	return JSON.stringify({
		id: 'chatcmpl-test',
		object: 'chat.completion',
		created: (Date.now() / 1000) | 0,
		model: 'test-model',
		choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
		usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
	});
}

describe('#4824 single-endpoint embedding client vs explicit content-length', () => {
	const origEnv = { ...process.env };

	beforeEach(() => {
		vi.stubEnv('EMBEDDING_API_KEY', 'test-key-4824');
		vi.stubEnv('EMBEDDING_API_BASE_URLS', '');
		vi.stubEnv('EMBEDDING_API_BASE_URL', 'http://a.test/v1');
		delete process.env.OPENAI_API_KEY;
		resetEmbeddingOpenAIClient();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
		resetEmbeddingOpenAIClient();
		process.env = { ...origEnv };
	});

	it('hands fetch an init without the SDK-set content-length (an undici-strict fetch rejects it)', async () => {
		// Precondition: the legacy single-endpoint contract (no failover wrapper).
		const plan = getEmbeddingEndpointPlan('query');
		expect(plan.endpoints.length).toBe(1);
		expect(plan.fetch).toBeUndefined();

		const seenContentLength: Array<string | null> = [];
		const strict = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			seenContentLength.push(headers.get('content-length'));
			// npm undici 7.29.1 processHeader: any explicit content-length fails
			// isValidContentLengthHeaderValue once internal fetch has doubled it.
			if (headers.has('content-length')) throw invalidContentLengthError();
			return okEmbeddingResponse();
		}) as unknown as typeof fetch;
		vi.stubGlobal('fetch', strict);

		const client = getEmbeddingQueryClient();
		// client.fetch is the SDK's captured transport (core.js: `this.fetch =
		// overriddenFetch ?? defaultFetch`) — post-fix it is the stripping wrapper.
		await client.fetch('http://127.0.0.1:1/v1/embeddings', SDK_LIKE_INIT);

		expect(seenContentLength[0]).toBeNull();
		const init = (strict as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
		expect(new Headers(init.headers).get('authorization')).toBe('Bearer test-key-4824');
	});

	it('real dispatch through the npm undici Agent puts ONE content-length on the wire', { timeout: 15000 }, async () => {
		const { Agent } = await import('undici');
		let sawContentLength: string | string[] | undefined;
		const server = http.createServer((req, res) => {
			req.on('data', () => undefined);
			req.on('end', () => {
				sawContentLength = req.headers['content-length'];
				res.writeHead(200, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ data: [{ embedding: [1, 2, 3] }] }));
			});
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;

		try {
			const client = getEmbeddingQueryClient();
			const body = JSON.stringify({ model: 'm', input: 'ping' });
			const response = await client.fetch(`${base}/embeddings`, {
				...SDK_LIKE_INIT,
				body,
				headers: { ...SDK_LIKE_INIT.headers, 'content-length': String(body.length) },
				// Deterministic vehicle: the npm undici dispatcher, exactly what the
				// process-global slot holds in a full server that loaded Qdrant first.
				dispatcher: new Agent(),
			} as RequestInit);
			expect(response.status).toBe(200);
			await response.text();
			// One digits-only content-length reached the wire — not "N, N", not absent.
			expect(sawContentLength).toBe(String(body.length));
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
});

describe('#4824 measured-immunity tripwires — chat POSTs traverse no undici pipeline', () => {
	const origEnv = { ...process.env };
	let server: http.Server;
	let baseUrl: string;
	let sawUndiciRequest: boolean;

	beforeEach(async () => {
		sawUndiciRequest = false;
		server = http.createServer((req, res) => {
			req.on('data', () => undefined);
			req.on('end', () => {
				res.writeHead(200, { 'content-type': 'application/json' });
				res.end(req.url.includes('/embeddings')
					? JSON.stringify({ data: [{ embedding: [1, 2, 3], index: 0 }], model: 'test', usage: { prompt_tokens: 1, total_tokens: 1 } })
					: chatCompletionResponse());
			});
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;

		vi.stubEnv('VLLM_API_KEY_MEDIUM', 'test-key-4824');
		vi.stubEnv('OPENAI_BASE_URL', baseUrl);
		vi.stubEnv('ZAI_API_KEY', 'test-key-4824');
		vi.stubEnv('ZAI_BASE_URL', baseUrl);
		delete process.env.ZAI_BASE_URL_FALLBACK;
		delete process.env.OPENAI_API_KEY;
		delete process.env.FALLBACK_API_KEY;
		delete process.env.FALLBACK_BASE_URL;
		resetChatOpenAIClient();
		resetFallbackChatOpenAIClient();
	});

	afterEach(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		vi.unstubAllEnvs();
		resetChatOpenAIClient();
		resetFallbackChatOpenAIClient();
		process.env = { ...origEnv };
	});

	/**
	 * Both undici copies in the process (Node's bundled one and the npm package
	 * @qdrant/js-client-rest pulls in) publish on the same process-global
	 * diagnostics channel names — a subscription catches any fetch that goes
	 * through EITHER dispatcher. node-fetch (node:http) publishes nothing.
	 */
	function subscribeUndiciRequests(): () => void {
		const onEvent = () => {
			sawUndiciRequest = true;
		};
		const channels = ['undici:request:create', 'undici:fetch:create'].map((name) => {
			const channel = diagnosticsChannel.channel(name);
			channel.subscribe(onEvent);
			return { channel, onEvent };
		});
		return () => channels.forEach(({ channel, onEvent: cb }) => channel.unsubscribe(cb));
	}

	async function chatPost(client: { chat: { completions: { create: (body: unknown) => Promise<{ choices: Array<{ message: { content: string } }> }> } } }): Promise<string> {
		const completion = await client.chat.completions.create({
			model: 'test-model',
			messages: [{ role: 'user', content: 'ping' }],
			max_tokens: 5,
		});
		return completion.choices[0].message.content;
	}

	it('primary chat client (condensation) produces zero undici dispatch events', { timeout: 15000 }, async () => {
		const unsubscribe = subscribeUndiciRequests();
		try {
			const content = await chatPost(getChatOpenAIClient() as never);
			expect(content).toBe('ok');
		} finally {
			unsubscribe();
		}
		expect(sawUndiciRequest).toBe(false);
	});

	it('cloud fallback chat client produces zero undici dispatch events', { timeout: 15000 }, async () => {
		const unsubscribe = subscribeUndiciRequests();
		try {
			const fallback = getFallbackChatOpenAIClient();
			expect(fallback).not.toBeNull();
			const content = await chatPost(fallback as never);
			expect(content).toBe('ok');
		} finally {
			unsubscribe();
		}
		expect(sawUndiciRequest).toBe(false);
	});
});
