/**
 * #4352 (a5): ordered embedding endpoints with transport-only failover.
 *
 * One vhost outage (embeddings.myia.io, 25/10 16:10Z) removed semantic search
 * fleet-wide for six hours while the LAN backend kept answering. The SDK had a
 * single base URL and a 60 s timeout with one retry, so every call waited the
 * outage out before degrading. This module is the failover layer both embedding
 * factories share — the task indexer (`services/openai.ts`) and the codebase
 * indexer/search (`services/code-index/embedding-client.ts`).
 *
 * Contract:
 *  - `EMBEDDING_API_BASE_URLS` is an ordered, comma-separated list of
 *    OpenAI-compatible base URLs. The FIRST entry is canonical: it is the
 *    `baseURL` the SDK builds requests for, and its host is what the supplement
 *    sentinel fingerprints. Failover must never look like a model switch.
 *  - When the list is unset the factories keep their previous single-endpoint
 *    behaviour byte for byte: no wrapper, no new timeout, no new retry.
 *  - Failover happens on transport failures (connection refused/reset, DNS,
 *    timeout) and HTTP 5xx. A 4xx is the endpoint ANSWERING — a bad key, a bad
 *    model, a malformed request — and must surface immediately, never be hidden
 *    by a second endpoint that happens to accept it.
 *  - A failed endpoint is negative-cached for a short TTL, so an outage costs
 *    seconds on the first call and almost nothing afterwards.
 *  - Interactive query clients get a shorter per-attempt timeout and a total
 *    budget; background indexing keeps the long 60 s ceiling it needs.
 *  - Every endpoint must produce the configured embedding dimension. A mismatch
 *    refuses that endpoint (and, if every endpoint mismatches, the call) rather
 *    than mixing two vector spaces in one collection.
 *
 * The variable is host-owned (`~/.claude.json` MCP env): `roosync_diagnose
 * reload` cannot change it, so a change needs a respawn.
 */

import { getHostEnvKeys } from './host-env-snapshot.js';

/** Minimal fetch shape, so tests can inject a fake without a network. */
export type EmbeddingFetch = typeof fetch;

export interface EmbeddingEndpointPlan {
	/** Ordered, normalised endpoints. Empty means "SDK default, unchanged". */
	endpoints: string[];
	/** Endpoint handed to the OpenAI SDK as `baseURL`. */
	baseURL: string | undefined;
	/** Custom fetch when failover is active; undefined preserves legacy behaviour. */
	fetch: EmbeddingFetch | undefined;
}

export type EmbeddingClientMode = 'index' | 'query';

interface EndpointState {
	url: string;
	label: string;
	/** Epoch ms before which this endpoint is skipped after a transport/5xx failure. */
	disabledUntil: number;
	/** Permanent for the process: the endpoint serves another vector space. */
	incompatible: string | null;
	lastError: string | null;
}

export interface EmbeddingFailoverOptions {
	endpoints: string[];
	/** The first list entry. Requests for this base are rewritten per attempt. */
	canonicalBaseURL: string;
	/** Ceiling for ONE endpoint attempt. */
	perAttemptTimeoutMs: number;
	/** Total ceiling across all endpoint attempts (interactive clients). */
	totalBudgetMs?: number;
	/** How long a transport/5xx failure keeps an endpoint out of rotation. */
	negativeCacheMs?: number;
	/** The dimension every endpoint must return. */
	expectedDimensions: number;
	/** Test seam; defaults to globalThis.fetch. */
	fetchImpl?: EmbeddingFetch;
	/** Test seam; defaults to Date.now. */
	now?: () => number;
	/** Test seam; defaults to console.warn. */
	warn?: (message: string) => void;
	/** Test seam; defaults to console.info. Info-level (not warn) so the fleet log
	 *  scanners do not turn a routine success line into a spawned agent (#4395 I2). */
	info?: (message: string) => void;
}

export class EmbeddingEndpointsUnavailableError extends Error {
	readonly endpointErrors: Array<{ endpoint: string; error: string }>;

	constructor(message: string, endpointErrors: Array<{ endpoint: string; error: string }>) {
		super(message);
		this.name = 'EmbeddingEndpointsUnavailableError';
		this.endpointErrors = endpointErrors;
	}
}

const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_QUERY_ATTEMPT_TIMEOUT_MS = 6000;
const DEFAULT_QUERY_BUDGET_MS = 12000;
const DEFAULT_NEGATIVE_CACHE_MS = 30000;

// #4395 (RX126): LAN-direct defaults. The fleet's canonical embedding endpoint
// is the public vhost, whose IIS hop carries the whole indexing load against a
// Windows 11 Pro 10-connection cap (41-51 s vs 14-33 ms direct, RX126). The
// LAN backend the vhost forwards to is tried FIRST; the vhost stays canonical.
const PUBLIC_VHOST_HOST = 'embeddings.myia.io';
const DEFAULT_LAN_DIRECT_URL = 'http://myia-po-2023:8004/v1';

function parseIntOr(value: string | undefined, fallback: number): number {
	const parsed = parseInt(value ?? '', 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Parse the dimension env the same way `getEmbeddingDimensions()` does. */
export function getEmbeddingDimensionSetting(env: NodeJS.ProcessEnv = process.env): number {
	return parseIntOr(env.EMBEDDING_DIMENSIONS, 1536);
}

function normaliseEndpoint(raw: string, source = 'EMBEDDING_API_BASE_URLS'): string {
	const trimmed = raw.trim();
	if (!trimmed) throw new Error(`${source} contains an empty endpoint`);
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		// Never echo the raw value: a malformed endpoint could still carry credentials.
		throw new Error(`Invalid embedding endpoint in ${source} (must be a valid http(s) URL; value redacted)`);
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new Error(`Embedding endpoint in ${source} must be http(s), got protocol ${url.protocol} for host ${url.host || '(unparseable)'}`);
	}
	// #4352 review (ai-01 06:26Z): refuse URL userinfo outright. Otherwise the
	// canonical `https://user:secret@host-A` credentials would be replayed to the
	// failover host B (rewriteEndpoint only rewrites protocol/host/port/path), and
	// B's own userinfo would be dropped. The fleet passes keys via EMBEDDING_API_KEY
	// (bearer), so there is no legitimate userinfo use to preserve. Host-only message.
	if (url.username || url.password) {
		throw new Error(`Embedding endpoint in ${source} must not carry URL userinfo (use EMBEDDING_API_KEY bearer auth instead): ${url.host}`);
	}
	return trimmed.replace(/\/+$/, '');
}

/**
 * Ordered endpoint list. `EMBEDDING_API_BASE_URLS` wins when set; the legacy
 * single `EMBEDDING_API_BASE_URL` is the one-entry form. An unset/empty list
 * returns `[]`, which the factories map to "unchanged".
 */
export function parseEmbeddingEndpoints(env: NodeJS.ProcessEnv = process.env): string[] {
	const rawList = env.EMBEDDING_API_BASE_URLS;
	if (rawList !== undefined && rawList.trim() !== '') {
		const seen = new Set<string>();
		const endpoints: string[] = [];
		for (const part of rawList.split(',')) {
			if (!part.trim()) continue;
			const endpoint = normaliseEndpoint(part);
			if (seen.has(endpoint)) continue;
			seen.add(endpoint);
			endpoints.push(endpoint);
		}
		if (endpoints.length === 0) {
			throw new Error('EMBEDDING_API_BASE_URLS is set but contains no usable endpoint');
		}
		return endpoints;
	}
	const legacy = env.EMBEDDING_API_BASE_URL;
	if (legacy && legacy.trim()) return [normaliseEndpoint(legacy)];
	return [];
}

/** Host-only label: safe to log, and enough to name which endpoint failed. */
function endpointLabel(endpoint: string): string {
	try {
		return new URL(endpoint).host;
	} catch {
		return 'invalid-endpoint';
	}
}

/** Host of the canonical endpoint, for the supplement sentinel fingerprint. */
export function getCanonicalEmbeddingBaseUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const endpoints = parseEmbeddingEndpoints(env);
	return endpoints[0];
}

/**
 * #4352 (deadep): the endpoints the `.env` FILE names, as opposed to whatever the
 * host process shadows them with. index.ts records them at startup and the hot
 * reload re-records them on every `.env` re-parse. Endpoints only — a key or any
 * other secret is never captured here.
 *
 * Measured on ai-01 (c.6478415645): the VS Code host carried
 * `EMBEDDING_API_BASE_URL=http://192.168.0.51:8004/v1` — po-2026's dead LAN
 * address — while User scope and both `.env` files said the public vhost. dotenv
 * never overrides (#2719, on purpose), so the dead value won, the plan had ONE
 * endpoint, no failover wrapper was armed, and every child of that host indexed
 * nothing (`263/263 sub-chunks without a vector — Connection error`).
 */
let embeddingFileEndpoints: string[] | null = null;

/** Record what the `.env` file says. A malformed value clears the record: the
 * effective env still rules, there is simply no canonical to fall back to. */
export function recordEmbeddingFileConfig(parsed: Record<string, string> | undefined): void {
	if (!parsed) return;
	try {
		embeddingFileEndpoints = parseEmbeddingEndpoints(parsed as NodeJS.ProcessEnv);
	} catch {
		embeddingFileEndpoints = null;
	}
}

/** Test-only: forget the file record and the once-per-episode warn state. */
export function resetEmbeddingFileConfigForTest(): void {
	embeddingFileEndpoints = null;
	lastShadowWarnKey = null;
}

const EMBEDDING_ENDPOINT_VARS = ['EMBEDDING_API_BASE_URLS', 'EMBEDDING_API_BASE_URL'] as const;

/**
 * Name the layer the shadowing value came from, as far as the child can tell.
 * `RSM_HOST_ENV_KEYS` (#2719) says the host set the name; process inheritance,
 * a User scope and the MCP `env` block are indistinguishable from inside the
 * child, and the message says so instead of guessing one.
 */
function describeShadowingLayer(env: NodeJS.ProcessEnv): string {
	const hostKeys = getHostEnvKeys();
	const sources = EMBEDDING_ENDPOINT_VARS.filter((name) => env[name] !== undefined && hostKeys?.has(name));
	if (sources.length > 0) {
		return `the host process env (${sources.join(', ')} — process, User scope and MCP env block are indistinguishable from the child; not the .env)`;
	}
	return 'a non-.env source (the value differs and no host-set marker was recorded)';
}

/** Once per shadowing episode: re-arms when the configured/file pair changes. */
let lastShadowWarnKey: string | null = null;

function warnShadowingOnce(configured: string[], fileCanonical: string, env: NodeJS.ProcessEnv): void {
	const key = `${configured.join('|')}=>${fileCanonical}`;
	if (lastShadowWarnKey === key) return;
	lastShadowWarnKey = key;
	console.warn(
		`[embedding-endpoints] configured endpoint differs from the .env canonical (${endpointLabel(fileCanonical)}); shadowed by ${describeShadowingLayer(env)}. `
		+ `The .env canonical is armed as the LAST failover entry: a connection-level failure on the configured endpoint falls back to it (#4352).`,
	);
}

/** Health-view signal: the endpoint gap, or null when nothing is shadowed. */
export interface EmbeddingShadowingStatus {
	/** Host-only labels — never a full URL. */
	configuredHost: string;
	fileCanonicalHost: string;
	/** Where the shadowing value came from, as far as the child can tell. */
	layer: string;
}

export function getEmbeddingShadowingStatus(env: NodeJS.ProcessEnv = process.env): EmbeddingShadowingStatus | null {
	const configured = parseEmbeddingEndpoints(env);
	const fileCanonical = embeddingFileEndpoints?.[0];
	if (configured.length === 0 || fileCanonical === undefined || configured.includes(fileCanonical)) {
		return null;
	}
	return {
		configuredHost: endpointLabel(configured[0]),
		fileCanonicalHost: endpointLabel(fileCanonical),
		layer: describeShadowingLayer(env),
	};
}

export function getEmbeddingClientModeSettings(
	mode: EmbeddingClientMode,
	env: NodeJS.ProcessEnv = process.env,
): { perAttemptTimeoutMs: number; totalBudgetMs?: number; negativeCacheMs: number } {
	const negativeCacheMs = parseIntOr(env.EMBEDDING_NEGATIVE_CACHE_MS, DEFAULT_NEGATIVE_CACHE_MS);
	if (mode === 'query') {
		return {
			perAttemptTimeoutMs: parseIntOr(env.EMBEDDING_QUERY_ATTEMPT_TIMEOUT_MS, DEFAULT_QUERY_ATTEMPT_TIMEOUT_MS),
			totalBudgetMs: parseIntOr(env.EMBEDDING_QUERY_BUDGET_MS, DEFAULT_QUERY_BUDGET_MS),
			negativeCacheMs,
		};
	}
	return {
		perAttemptTimeoutMs: parseIntOr(env.EMBEDDING_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
		negativeCacheMs,
	};
}

/** SDK-level timeout: must outlive every endpoint attempt, or the second never runs. */
export function getEmbeddingClientTimeoutMs(
	mode: EmbeddingClientMode,
	endpointCount: number,
	env: NodeJS.ProcessEnv = process.env,
): number {
	const settings = getEmbeddingClientModeSettings(mode, env);
	if (mode === 'query') return (settings.totalBudgetMs ?? settings.perAttemptTimeoutMs) + 2000;
	return settings.perAttemptTimeoutMs * Math.max(1, endpointCount) + 5000;
}

/** True when the endpoint's host is the public vhost the fleet embeds through. */
function isPublicVhostEndpoint(endpoint: string): boolean {
	try {
		return new URL(endpoint).hostname === PUBLIC_VHOST_HOST;
	} catch {
		return false;
	}
}

/** `EMBEDDING_LAN_DIRECT=0` is the only kill-switch; any other value is on. */
function isLanDirectDisabled(env: NodeJS.ProcessEnv): boolean {
	return env.EMBEDDING_LAN_DIRECT === '0';
}

/**
 * `EMBEDDING_LAN_DIRECT_URL` overrides the default LAN target. A malformed
 * override must NOT take down the vhost path: it is caught and the default LAN
 * target is used instead (NOT public-only), with a warn naming the variable.
 */
function resolveLanDirectUrl(env: NodeJS.ProcessEnv): string {
	const override = env.EMBEDDING_LAN_DIRECT_URL;
	if (!override || !override.trim()) return DEFAULT_LAN_DIRECT_URL;
	try {
		return normaliseEndpoint(override, 'EMBEDDING_LAN_DIRECT_URL');
	} catch {
		console.warn('[embedding-endpoints] EMBEDDING_LAN_DIRECT_URL is invalid; falling back to the default LAN target');
		return DEFAULT_LAN_DIRECT_URL;
	}
}

/**
 * #4395 (RX126): when the CANONICAL endpoint is the public vhost, put the
 * LAN-direct backend FIRST in the try order. The insertion is transport-only:
 * the caller keeps `canonical` as the SDK `baseURL` and the fingerprint, so no
 * collection is rebuilt. A list that already carries the LAN target keeps its
 * own order (no duplicate); any other canonical is left untouched. Returns a
 * new array — the configured list is never mutated.
 */
function withLanDirectFirst(
	configured: string[],
	canonical: string,
	env: NodeJS.ProcessEnv,
): string[] {
	if (isLanDirectDisabled(env)) return configured;
	if (!isPublicVhostEndpoint(canonical)) return configured;
	const lan = resolveLanDirectUrl(env);
	if (configured.includes(lan)) return configured;
	return [lan, ...configured];
}

/**
 * Plan consumed by both factories. `fetch` is only attached when there is more
 * than one endpoint: a one-entry list is the legacy base URL with extra config,
 * not a reason to change timeout or retry semantics.
 *
 * #4395 (RX126): the SDK `baseURL` and the supplement fingerprint are named by
 * the CANONICAL entry of the CONFIGURED list. The LAN-direct insertion may put
 * a LAN entry first in the try order, but it must never move the canonical —
 * that is what keeps an existing collection's vector space valid.
 */
export function getEmbeddingEndpointPlan(
	mode: EmbeddingClientMode,
	env: NodeJS.ProcessEnv = process.env,
): EmbeddingEndpointPlan {
	const configured = parseEmbeddingEndpoints(env);
	if (configured.length === 0) {
		return { endpoints: configured, baseURL: undefined, fetch: undefined };
	}
	// #4352 (deadep): a host-set endpoint can shadow the `.env` canonical (dotenv
	// never overrides — #2719, deliberately). When the configured list does not
	// carry the file canonical, append it as the LAST failover entry: a
	// transport-level failure on the shadowing endpoint (the ai-01 case: a dead
	// LAN address inherited from the VS Code host, single endpoint, no wrapper)
	// then reaches the canonical instead of indexing nothing. A HEALTHY
	// configured endpoint answers first and is never replaced; a 4xx from it is
	// an answer and surfaces, per the a5 contract above.
	const fileCanonical = embeddingFileEndpoints?.[0];
	let tryOrder = configured;
	if (fileCanonical !== undefined && !configured.includes(fileCanonical)) {
		tryOrder = [...configured, fileCanonical];
		warnShadowingOnce(configured, fileCanonical, env);
	}
	const canonical = configured[0];
	const endpoints = withLanDirectFirst(tryOrder, canonical, env);
	if (endpoints.length === 1) {
		return { endpoints, baseURL: canonical, fetch: undefined };
	}
	const settings = getEmbeddingClientModeSettings(mode, env);
	return {
		endpoints,
		baseURL: canonical,
		fetch: createEmbeddingFailoverFetch({
			endpoints,
			canonicalBaseURL: canonical,
			perAttemptTimeoutMs: settings.perAttemptTimeoutMs,
			totalBudgetMs: settings.totalBudgetMs,
			negativeCacheMs: settings.negativeCacheMs,
			expectedDimensions: getEmbeddingDimensionSetting(env),
		}),
	};
}

/** Rewrite the canonical base prefix to another endpoint, preserving path/query. */
function rewriteEndpoint(requestUrl: string, fromBase: string, toBase: string): string {
	const from = new URL(fromBase);
	const to = new URL(toBase);
	const url = new URL(requestUrl);
	const fromPath = from.pathname.replace(/\/+$/, '');
	const toPath = to.pathname.replace(/\/+$/, '');
	if (url.origin !== from.origin || !url.pathname.startsWith(fromPath)) {
		// The SDK built a URL from something other than the canonical base. Do not
		// guess: keep it as-is for this endpoint attempt.
		return requestUrl;
	}
	url.protocol = to.protocol;
	// Hostname and port are set SEPARATELY on purpose: assigning `url.host` left the
	// source port in place when the target URL had none (`lan:8004` → `proxy:8004`,
	// measured), which would send every failover to the wrong port.
	url.hostname = to.hostname;
	url.port = to.port;
	url.pathname = `${toPath}${url.pathname.slice(fromPath.length)}` || '/';
	return url.toString();
}

function requestUrlOf(input: string | URL | Request): string {
	if (typeof input === 'string') return input;
	if (input instanceof URL) return input.toString();
	return input.url;
}

function describeError(error: unknown): string {
	if (error instanceof Error) return error.message || error.name;
	if (typeof error === 'string') return error;
	try {
		return JSON.stringify(error);
	} catch {
		return 'unknown error';
	}
}

function hasCallerAborted(signal: AbortSignal | null | undefined): boolean {
	return Boolean(signal?.aborted);
}

interface AttemptResult {
	response?: Response;
	error?: unknown;
	timedOut: boolean;
}

async function fetchOneEndpoint(
	url: string,
	init: RequestInit,
	timeoutMs: number,
	fetchImpl: EmbeddingFetch,
): Promise<AttemptResult> {
	const controller = new AbortController();
	let timedOut = false;
	const callerSignal = init.signal ?? undefined;
	const onCallerAbort = () => controller.abort();
	if (callerSignal) {
		if (callerSignal.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
		callerSignal.addEventListener('abort', onCallerAbort, { once: true });
	}
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	try {
		const response = await fetchImpl(url, { ...init, signal: controller.signal });
		return { response, timedOut: false };
	} catch (error) {
		if (hasCallerAborted(callerSignal)) throw error;
		return { error, timedOut };
	} finally {
		clearTimeout(timer);
		callerSignal?.removeEventListener('abort', onCallerAbort);
	}
}

/**
 * Close a discarded response body. Not awaiting it keeps failover latency down;
 * the rejection is swallowed because the endpoint is already being abandoned.
 */
function discardResponse(response: Response): void {
	try {
		void response.body?.cancel().catch(() => undefined);
	} catch {
		/* body already consumed or locked — nothing to release */
	}
}

/** True only when another endpoint is worth trying. 4xx never is. */
function shouldFailOver(response: Response): boolean {
	return response.status >= 500;
}

/**
 * Decode `data[0].embedding` into a dimension, for BOTH wire shapes.
 *
 * #4352 review (ai-01 06:03Z): the OpenAI SDK sends `encoding_format: 'base64'`
 * by default and only decodes AFTER this wrapper returns the response, so on
 * the real production path `data[0].embedding` is a base64 **string**, not a
 * float array — `Array.isArray(first)` was always false and the dimension guard
 * never fired. Measured on embeddings.myia.io: base64 → String of 13,656 chars
 * (10,240 bytes / 4 = 2,560 = EMBEDDING_DIMENSIONS), float → Array of 2,560.
 * base64 length decodes as bytes/4 (float32). Anything else stays unclassified
 * (null) and is left to the SDK/VectorIndexer's own dimension checks.
 */
function dimensionFromEmbedding(embedding: unknown): number | null {
	if (Array.isArray(embedding)) return embedding.length;
	if (typeof embedding === 'string' && embedding.length > 0) {
		try {
			const bytes = Buffer.from(embedding, 'base64').byteLength;
			if (bytes % 4 === 0) return bytes / 4;
		} catch {
			return null;
		}
	}
	return null;
}

async function dimensionOf(response: Response): Promise<number | null> {
	try {
		const payload = await response.clone().json() as { data?: Array<{ embedding?: unknown }> };
		return dimensionFromEmbedding(payload?.data?.[0]?.embedding);
	} catch {
		// The SDK will report a malformed body; failover cannot classify it.
		return null;
	}
}

/**
 * Build the failover fetch. Exported for tests and for both factories, so the
 * two cannot drift on ordering, classification or negative-cache semantics.
 */
export function createEmbeddingFailoverFetch(options: EmbeddingFailoverOptions): EmbeddingFetch {
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	if (typeof fetchImpl !== 'function') {
		throw new Error('No fetch implementation available for embedding failover');
	}
	const now = options.now ?? Date.now;
	const warn = options.warn ?? ((message: string) => console.warn(message));
	const info = options.info ?? ((message: string) => console.info(message));
	const negativeCacheMs = options.negativeCacheMs ?? DEFAULT_NEGATIVE_CACHE_MS;
	const states: EndpointState[] = options.endpoints.map((url) => ({
		url,
		label: endpointLabel(url),
		disabledUntil: 0,
		incompatible: null,
		lastError: null,
	}));
	// #4395 (RX126): the acceptance line each LAN seat posts names which
	// endpoint served. Logged once per client, on the first successful call.
	let servedLogged = false;

	return async function embeddingFailoverFetch(input, init = {}): Promise<Response> {
		const originalUrl = requestUrlOf(input);
		const startedAt = now();
		const endpointErrors: Array<{ endpoint: string; error: string }> = [];
		const skipped: string[] = [];

		for (const state of states) {
			if (state.incompatible) {
				skipped.push(`${state.label} (incompatible: ${state.incompatible})`);
				continue;
			}
			const current = now();
			if (state.disabledUntil > current) {
				skipped.push(`${state.label} (negative-cached ${Math.ceil((state.disabledUntil - current) / 1000)}s)`);
				continue;
			}

			const elapsed = current - startedAt;
			const remaining = options.totalBudgetMs === undefined
				? Number.POSITIVE_INFINITY
				: options.totalBudgetMs - elapsed;
			if (remaining <= 0) {
				skipped.push(`${state.label} (query budget exhausted)`);
				break;
			}
			const attemptTimeout = Math.max(1, Math.min(options.perAttemptTimeoutMs, remaining));
			const targetUrl = rewriteEndpoint(originalUrl, options.canonicalBaseURL, state.url);

			let result: AttemptResult;
			try {
				result = await fetchOneEndpoint(targetUrl, init, attemptTimeout, fetchImpl);
			} catch (error) {
				// Caller abort: never start another endpoint behind the caller's back.
				if (hasCallerAborted(init.signal)) throw error;
				result = { error, timedOut: false };
			}

			if (result.response) {
				const response = result.response;
				if (shouldFailOver(response)) {
					state.lastError = `HTTP ${response.status}`;
					state.disabledUntil = now() + negativeCacheMs;
					discardResponse(response);
					endpointErrors.push({ endpoint: state.label, error: state.lastError });
					warn(`[embedding-failover] ${state.label} answered ${response.status}; trying the next endpoint`);
					continue;
				}
				if (response.status >= 400) {
					// 4xx is an answer about the request/key, not an outage.
					state.lastError = null;
					state.disabledUntil = 0;
					return response;
				}

				const dimension = await dimensionOf(response);
				if (dimension !== null && dimension !== options.expectedDimensions) {
					const mismatch = `dimension ${dimension} != ${options.expectedDimensions}`;
					state.incompatible = mismatch;
					state.lastError = mismatch;
					discardResponse(response);
					endpointErrors.push({ endpoint: state.label, error: mismatch });
					warn(`[embedding-failover] ${state.label} serves ${mismatch}; refusing it (vector space guard)`);
					continue;
				}

				state.lastError = null;
				state.disabledUntil = 0;
				// #4395 (RX126): name which endpoint served the first successful
				// call, once per client. Host only — never a key. Emitted at INFO,
				// not warn: a routine success line must not become a spawned agent
				// in the fleet log scanners (#4395 I2).
				if (!servedLogged) {
					servedLogged = true;
					info(`[embedding-failover] first successful call served by ${state.label}`);
				}
				return response;
			}

			const message = result.timedOut
				? `timeout after ${attemptTimeout}ms`
				: describeError(result.error);
			state.lastError = message;
			state.disabledUntil = now() + negativeCacheMs;
			endpointErrors.push({ endpoint: state.label, error: message });
			warn(`[embedding-failover] ${state.label} failed (${message}); trying the next endpoint`);
		}

		const detail = endpointErrors.length > 0
			? endpointErrors.map((e) => `${e.endpoint}: ${e.error}`).join('; ')
			: skipped.join('; ') || 'no endpoint configured';
		throw new EmbeddingEndpointsUnavailableError(
			`All embedding endpoints unavailable (${detail})`,
			endpointErrors.length > 0 ? endpointErrors : [{ endpoint: 'all', error: detail }],
		);
	};
}
