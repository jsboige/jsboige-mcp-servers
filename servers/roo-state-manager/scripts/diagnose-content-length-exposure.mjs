#!/usr/bin/env node
/**
 * #4823/#4824 fleet diagnostic — measures, from a live host-shaped process,
 * whether the OpenAI SDK POST paths are exposed to the doubled content-length
 * rejection, and which undici owns the process-global dispatcher slot.
 *
 * What it measures (all against a LOCAL mock endpoint — no real service is
 * contacted, no secret is used):
 *
 *  1. Slot ownership after loading the qdrant service (the full server's boot
 *     order). npm undici's setGlobalDispatcher defines BOTH registry symbols;
 *     Node v24's internal global.js defines only
 *     Symbol.for('undici.globalDispatcher.1') — so `.2` set ⇒ npm Agent owns
 *     the slot (the REJECTING state of #4823), `.2` empty ⇒ Node's internal
 *     Agent (tolerant). Importing `node:http` before the qdrant client flips
 *     the slot to the internal Agent (measured 17/11, Node 24.6.0 + 24.14.1)
 *     — which is why a fresh driver process could pass while the full server
 *     failed on ai-01.
 *  2. A chat POST through the primary condensation client.
 *  3. A chat POST through the cloud fallback client.
 *  4. An embeddings POST through the single-endpoint (legacy) plan.
 *
 * Expected on a healthy build: slot NPM or INTERNAL (either is fine — post
 * #4823/#4824 no client path is exposed), and all three probes SUCCESS with a
 * single digits-only content-length on the wire. A probe failing with
 * `UND_ERR_INVALID_ARG` (surfaced as "fetch failed") means the doubled
 * content-length reached the npm dispatcher — the #4823 failure mode.
 *
 * Usage (from the roo-state-manager package root):
 *   node scripts/diagnose-content-length-exposure.mjs [build-dir]
 *   (default: the newest build-16-hex directory)
 */
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');

// ---- mock endpoint branch (child) -------------------------------------------
// Imported dynamically: the parent branch must NOT import node:http, which
// would initialise Node's internal undici and flip the dispatcher slot.
if (process.env.DIAG_4824_MOCK_CHILD === '1') {
	const http = await import('node:http');
	const server = http.createServer((req, res) => {
		req.on('data', () => undefined);
		req.on('end', () => {
			console.log(`MOCK ${req.method} ${req.url} content-length=${JSON.stringify(req.headers['content-length'])}`);
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(req.url.includes('/embeddings')
				? JSON.stringify({ data: [{ embedding: [1, 2, 3], index: 0 }], model: 'diag', usage: { prompt_tokens: 1, total_tokens: 1 } })
				: JSON.stringify({
					id: 'chatcmpl-diag', object: 'chat.completion', created: (Date.now() / 1000) | 0, model: 'diag',
					choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
					usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
				}));
		});
	});
	await new Promise((r) => server.listen(0, '127.0.0.1', r));
	console.log(`PORT=${server.address().port}`);
	process.on('SIGTERM', () => server.close(() => process.exit(0)));
	// Stay alive until the parent kills us.
	setInterval(() => undefined, 60_000);
} else {
	// ---- driver branch (parent) ---------------------------------------------
	const buildArg = process.argv[2];
	function resolveBuildDir() {
		if (buildArg) return path.resolve(buildArg);
		const candidates = readdirSync(pkgRoot)
			.filter((d) => /^build-[0-9a-f]{16}$/.test(d))
			.sort();
		if (candidates.length === 0) {
			console.error('no build-<hash> directory found — run npm run build, or pass the build dir as argv[2]');
			process.exit(2);
		}
		return path.join(pkgRoot, candidates[candidates.length - 1]);
	}
	const buildDir = resolveBuildDir();
	console.log(`[diag] build: ${path.basename(buildDir)}`);

	const mock = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
		env: { ...process.env, DIAG_4824_MOCK_CHILD: '1' },
		stdio: ['ignore', 'pipe', 'inherit'],
	});
	mock.stdout.on('data', (d) => {
		for (const line of d.toString().split(/\r?\n/)) {
			// Forward the mock's wire log (on-wire content-length) as evidence.
			if (line.startsWith('MOCK ')) console.log(`[wire] ${line.slice(5)}`);
			if (line.startsWith('PORT=')) {
				const port = Number(line.slice(5));
				run(buildDir, port).finally(() => mock.kill('SIGTERM'));
				return;
			}
		}
	});

	async function run(dir, port) {
		const base = `http://127.0.0.1:${port}/v1`;
		process.env.VLLM_API_KEY_MEDIUM = 'diag-key';
		process.env.OPENAI_BASE_URL = base;
		process.env.ZAI_API_KEY = 'diag-key';
		process.env.ZAI_BASE_URL = base;
		process.env.EMBEDDING_API_KEY = 'diag-key';
		process.env.EMBEDDING_API_BASE_URLS = '';
		process.env.EMBEDDING_API_BASE_URL = base;
		process.env.EMBEDDING_MODEL = 'diag';
		process.env.EMBEDDING_DIMENSIONS = '3';

		// Full-server boot order: the qdrant service (→ npm undici) loads first.
		await import(`${pathToFileURL(path.join(dir, 'services', 'qdrant.js')).href}`);

		const s1 = globalThis[Symbol.for('undici.globalDispatcher.1')];
		const s2 = globalThis[Symbol.for('undici.globalDispatcher.2')];
		console.log(`[slot] owner: ${s2 ? 'NPM (rejecting state)' : s1 ? 'INTERNAL (tolerant state)' : 'EMPTY'}`);

		const openai = await import(`${pathToFileURL(path.join(dir, 'services', 'openai.js')).href}`);
		let failures = 0;
		async function probe(label, fn) {
			try {
				const detail = await fn();
				console.log(`[${label}] SUCCESS ${detail ?? ''}`);
			} catch (e) {
				failures++;
				console.log(`[${label}] FAILED: ${e.constructor.name} - ${e.message} | cause: ${e.cause?.code ?? e.cause?.message ?? 'none'}`);
			}
		}
		await probe('chat primary', async () => {
			openai.resetChatOpenAIClient();
			const r = await openai.getChatOpenAIClient().chat.completions.create({ model: 'diag', messages: [{ role: 'user', content: 'ping' }], max_tokens: 5 });
			return `content=${r.choices[0].message.content}`;
		});
		await probe('chat fallback', async () => {
			openai.resetFallbackChatOpenAIClient();
			const r = await openai.getFallbackChatOpenAIClient().chat.completions.create({ model: 'diag', messages: [{ role: 'user', content: 'ping' }], max_tokens: 5 });
			return `content=${r.choices[0].message.content}`;
		});
		await probe('embed single', async () => {
			openai.resetEmbeddingOpenAIClient();
			// encoding_format 'float': the SDK defaults to 'base64' and decodes
			// the embedding with toFloat32Array, which mangles a plain-array mock.
			const r = await openai.getEmbeddingQueryClient().embeddings.create({ model: 'diag', input: 'ping', encoding_format: 'float' });
			return `dim=${r.data[0].embedding.length}`;
		});
		console.log(`[verdict] ${failures === 0 ? 'ALL GREEN — no POST path exposed' : `${failures} FAILED`}`);
		process.exitCode = failures === 0 ? 0 : 1;
	}
}
