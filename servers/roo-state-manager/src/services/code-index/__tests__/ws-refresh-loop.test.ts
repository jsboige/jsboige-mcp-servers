/**
 * #4736 P4 — the post-commit refresh loop (services/code-index/ws-refresh-loop.ts).
 *
 * The issue's acceptance criterion, verbatim: "après un commit, une requête de
 * référence rend le nouveau symbole dans `codebase_search`, et les résultats
 * périmés disparaissent, dans un délai annoncé."
 *
 * The criterion test runs the REAL chain end-to-end minus Qdrant/embedding:
 * a real throwaway git repo, real commits, the real `git rev-parse HEAD`, the
 * real `listGitVisiblePaths`, and the real P3 writer (`runWsIndexWriter`) over
 * an in-memory Qdrant. The "reference query" is the reader's access path to a
 * ws- collection: a filtered scroll on filePath, then the payload contents.
 *
 * The unit tests below pin the loop's own bookkeeping — each has a mutation
 * check (flip the behaviour, the test fails):
 *
 *  - UNCHANGED HEAD → the writer is never run (the poll costs one rev-parse);
 *  - SUCCESS advances indexed_head and derives the announced delay;
 *  - REFUSED/THROWN runs do NOT advance it — the commit is not "served", and
 *    the backoff keeps the same commit queued for a cheap retry;
 *  - PARTIAL runs do not advance it either (missing batches stay un-served);
 *  - BACKOFF caps at 1 h and is monotone in failures;
 *  - the LOOP self-schedules: the next poll arms only after the previous
 *    check settles — no overlapping runs on the shared embedding endpoint;
 *  - the LEASE stays fresh through a pass longer than the steal window
 *    (mid-run renewal), and a mid-run steal disarms the loop at pass settle.
 */
import { describe, test, expect, afterAll, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import type { QdrantLike } from '../supplement-index.js';
import type { WsIndexWriterReport } from '../ws-index-writer.js';
import {
	checkWsRefreshOnce,
	readWsRefreshState,
	readGitHead,
	startWsRefreshLoop,
	stopWsRefreshLoop,
	isWsRefreshLoopRunning,
	wsRefreshBackoffSeconds,
	tryAcquireWsRefreshLease,
	releaseWsRefreshLeaseIfOurs,
	type WsRefreshCheckDeps,
} from '../ws-refresh-loop.js';

const PREFIX = 'd:\\test\\ws';
const COLLECTION = 'ws-bbbbbbbbbbbbbbbb';

// ── Minimal in-memory Qdrant (same shape as ws-index-writer.test.ts) ─────────

class FakeQdrant implements QdrantLike {
	points = new Map<string, { vector: number[]; payload: any }>();
	upsertCalls = 0;
	deleteCalls = 0;
	constructor(public size = 4, public distance = 'Cosine') {}

	async getCollection() {
		return {
			points_count: this.points.size,
			config: { params: { vectors: { size: this.size, distance: this.distance } } },
		};
	}
	async getCollections() {
		return { collections: [{ name: COLLECTION }] };
	}
	async retrieve(_name: string, body: any) {
		const ids: string[] = body?.ids ?? [];
		return { points: ids.filter((id) => this.points.has(id)).map((id) => ({ id, payload: this.points.get(id)!.payload })) };
	}
	async scroll(_name: string, body: any) {
		const must: any[] = body?.filter?.must ?? [];
		const mustNot: any[] = body?.filter?.must_not ?? [];
		const hasId: string[] | null = must.find((m: any) => Array.isArray(m?.has_id))?.has_id ?? null;
		const matches = (payload: any) =>
			must.every((m: any) => Array.isArray(m?.has_id) || String(payload?.[m.key]) === String(m.match?.value))
			&& mustNot.every((m: any) => String(payload?.[m.key]) !== String(m.match?.value));
		const points = [...this.points.entries()]
			.filter(([id]) => !hasId || hasId.includes(id))
			.filter(([, p]) => matches(p.payload))
			.map(([id, p]) => ({ id, payload: p.payload }));
		return { points: points.slice(0, body?.limit ?? 1000), next_page_offset: null };
	}
	async upsert(_name: string, body: any) {
		this.upsertCalls++;
		for (const p of body?.points ?? []) this.points.set(String(p.id), { vector: p.vector, payload: p.payload });
	}
	/** #4938 — a cache hit is verified against real content (SDK-shaped `{ count }`). */
	async count(_name: string, body: any) {
		const must: any[] = body?.filter?.must ?? [];
		const mustNot: any[] = body?.filter?.must_not ?? [];
		const matches = (payload: any) =>
			must.every((m: any) => String(payload?.[m.key]) === String(m.match?.value))
			&& mustNot.every((m: any) => String(payload?.[m.key]) !== String(m.match?.value));
		return { count: [...this.points.values()].filter((p) => matches(p.payload)).length };
	}
	async delete(_name: string, body: any) {
		this.deleteCalls++;
		for (const id of body?.points ?? []) this.points.delete(String(id));
	}
}

/** The reference query: every content payload stored for a filePath. */
async function blocksOf(fake: FakeQdrant, relNative: string): Promise<string[]> {
	const res: any = await fake.scroll(COLLECTION, {
		filter: { must: [{ key: 'filePath', match: { value: relNative } }], must_not: [{ key: 'type', match: { value: 'metadata' } }] },
		with_payload: true,
	});
	return res.points.map((p: any) => String(p.payload?.codeChunk ?? ''));
}

// ── Real git fixture ──────────────────────────────────────────────────────────

const tempDirs: string[] = [];

function git(root: string, ...args: string[]) {
	return execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	});
}

function makeGitRepo(): string {
	const root = mkdtempSync(join(tmpdir(), 'ws-refresh-'));
	tempDirs.push(root);
	git(root, 'init', '-q');
	return root;
}

const DOC_V1 = '# Guide\n\n' + 'alpha symbol of the first section\n'.repeat(8)
	+ '## Suite\n\n' + 'beta symbol of the second section\n'.repeat(8);
const DOC_V2 = '# Guide (edited)\n\n' + 'alpha symbol REWRITTEN for the first section\n'.repeat(8)
	+ '## Suite\n\n' + 'beta symbol REWRITTEN for the second section\n'.repeat(8)
	+ '## New\n\n' + 'gamma symbol of the brand new third section\n'.repeat(8);

// ── The criterion, end-to-end ─────────────────────────────────────────────────

describe('ws-refresh-loop — THE ISSUE CRITERION (#4736 P4)', () => {
	test('after a commit, the reference query returns the new symbol, stale results are gone, within an announced delay', async () => {
		const { runWsIndexWriter } = await import('../ws-index-writer.js');
		const root = makeGitRepo();
		const statePath = join(root, '..', `${Math.random().toString(36).slice(2)}-state.json`);
		const fake = new FakeQdrant();
		const embed = async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3, 0.4]);
		const baseDeps = {
			client: fake as unknown as QdrantLike,
			workspaceRoot: root,
			writer: 'web1:roo-extensions',
			hashPathPrefix: PREFIX,
			collection: COLLECTION,
			// The loop contract: the injected writer runs LIVE — dry_run would
			// write nothing and the loop rightly counts the commit un-served.
			dryRun: false,
			embeddingModelId: 'test-model',
			embeddingEndpoint: 'embed.internal',
			embed,
			sleep: async () => {},
		};
		const deps: WsRefreshCheckDeps = {
			workspaceRoot: root,
			writer: 'web1:roo-extensions',
			hashPathPrefix: PREFIX,
			pollSeconds: 120,
			statePath,
			runWriter: () => runWsIndexWriter(baseDeps),
		};

		// Commit A lands.
		writeFileSync(join(root, 'doc.md'), DOC_V1);
		git(root, 'add', '-A');
		git(root, 'commit', '-q', '-m', 'A');
		const headA = (await readGitHead(root))!;

		const first = await checkWsRefreshOnce(deps);
		expect(first.reason).toBe('refreshed');
		expect(first.state.indexed_head).toBe(headA);
		// The reference query finds commit A's symbols…
		const servedA = await blocksOf(fake, 'doc.md');
		expect(servedA.some((c) => c.includes('alpha symbol of the first section'))).toBe(true);
		const idsA = [...fake.points.entries()];

		// Commit B lands: one file rewritten, one new file.
		writeFileSync(join(root, 'doc.md'), DOC_V2);
		writeFileSync(join(root, 'new.md'), '# Fresh\n\n' + 'delta symbol of the fresh file\n'.repeat(8));
		git(root, 'add', '-A');
		git(root, 'commit', '-q', '-m', 'B');
		const headB = (await readGitHead(root))!;
		expect(headB).not.toBe(headA);

		const second = await checkWsRefreshOnce(deps);
		expect(second.reason).toBe('refreshed');
		expect(second.state.indexed_head).toBe(headB);

		// …the NEW symbols are served…
		const servedB = await blocksOf(fake, 'doc.md');
		expect(servedB.some((c) => c.includes('gamma symbol of the brand new third section'))).toBe(true);
		expect(servedB.some((c) => c.includes('alpha symbol REWRITTEN'))).toBe(true);
		const servedNew = await blocksOf(fake, 'new.md');
		expect(servedNew.some((c) => c.includes('delta symbol of the fresh file'))).toBe(true);
		// …and the STALE results are gone: every V1 content id has been purged
		// (the purge is by filePath, then V2 ids replace them). Metadata points
		// (sentinel, cache) legitimately survive — they are not results.
		const staleIds = idsA.filter(([, p]) => p.payload?.type !== 'metadata');
		expect(staleIds.length).toBeGreaterThan(0);
		for (const [id] of staleIds) expect(fake.points.has(id)).toBe(false);
		// The criterion's "requête de référence rend le nouveau symbole" — the
		// old symbol must NOT be served anymore.
		expect(servedB.some((c) => c.includes('alpha symbol of the first section'))).toBe(false);

		// …dans un délai ANNOUNCÉ: the SLO is derived and recorded, and the
		// measured detection→served latency is available to check it against.
		expect(second.state.announced_delay_s).not.toBeNull();
		expect(second.state.announced_delay_s!).toBeGreaterThanOrEqual(120);
		expect(second.state.last_refresh_ms).not.toBeNull();

		// The state survives on disk — the next host resumes from indexed_head.
		const persisted = readWsRefreshState(statePath);
		expect(persisted?.indexed_head).toBe(headB);
	});
});

// ── Unit: the loop's bookkeeping ──────────────────────────────────────────────

function syntheticReport(overrides: Partial<WsIndexWriterReport> = {}): WsIndexWriterReport {
	return {
		status: 'success',
		collection: COLLECTION,
		resolved_by: 'explicit',
		writer: 'web1:roo-extensions',
		dry_run: false,
		vector_config: { size: 4, distance: 'Cosine' },
		prefix_validation: { sampled: 0, verified: 0, read_error: null } as any,
		writer_guard: { ok: true, previous_writer: null },
		files_considered: 1,
		files_skipped_unchanged: 0,
		files_to_index: 1,
		files_indexed: 1,
		files_failed: [],
		files_removed: 0,
		points_deleted: 2,
		points_written: 3,
		chunks_embedded: 3,
		batches: 1,
		batches_failed: 0,
		truncated: false,
		elapsed_ms: 5_000,
		warnings: [],
		...overrides,
	};
}

function unitFixture(overrides: Partial<WsRefreshCheckDeps> & { head?: string | null } = {}) {
	const root = mkdtempSync(join(tmpdir(), 'ws-refresh-unit-'));
	tempDirs.push(root);
	const statePath = join(root, 'state.json');
	let head: string | null = overrides.head !== undefined ? overrides.head : 'a'.repeat(40);
	const logs: string[] = [];
	const deps: WsRefreshCheckDeps = {
		workspaceRoot: root,
		writer: 'web1:roo-extensions',
		hashPathPrefix: PREFIX,
		pollSeconds: 120,
		statePath,
		readHead: async () => head,
		runWriter: overrides.runWriter ?? (async () => syntheticReport()),
		log: (m) => logs.push(m),
	};
	return { deps, logs, statePath, setHead: (h: string | null) => { head = h; } };
}

describe('checkWsRefreshOnce — bookkeeping', () => {
	test('unchanged HEAD never runs the writer', async () => {
		const fx = unitFixture();
		let calls = 0;
		const tracked: WsRefreshCheckDeps = { ...fx.deps, runWriter: async () => { calls++; return syntheticReport(); } };
		await checkWsRefreshOnce(tracked); // first run indexes head
		const second = await checkWsRefreshOnce(tracked);
		expect(second.ran).toBe(false);
		expect(second.reason).toBe('unchanged');
		expect(calls).toBe(1);
	});

	test('a new HEAD runs the writer, advances indexed_head and derives the announced delay', async () => {
		const fx = unitFixture({ head: 'a'.repeat(40) });
		const first = await checkWsRefreshOnce(fx.deps);
		expect(first.reason).toBe('refreshed');
		expect(first.state.indexed_head).toBe('a'.repeat(40));
		// poll 120 s + run 5 s
		expect(first.state.announced_delay_s).toBe(125);
		expect(first.state.last_refresh_ms).not.toBeNull();
		expect(first.state.consecutive_failures).toBe(0);
	});

	test('a REFUSED run (throw) does NOT advance indexed_head and arms the backoff', async () => {
		const fx = unitFixture({ head: 'a'.repeat(40) });
		const refused: WsRefreshCheckDeps = {
			...fx.deps,
			runWriter: async () => { throw new Error('collection ws-x is written by other-lane'); },
		};
		const result = await checkWsRefreshOnce(refused);
		expect(result.reason).toBe('run-failed');
		expect(result.state.indexed_head).toBeNull(); // NOT advanced
		expect(result.state.consecutive_failures).toBe(1);
		expect(result.state.last_error).toMatch(/other-lane/);
		expect(result.state.retry_not_before_ms).toBeGreaterThan(0);
		// The state file carries the failure.
		const persisted = readWsRefreshState(fx.statePath);
		expect(persisted?.last_error).toMatch(/other-lane/);
		// A second check on the SAME head is held by the backoff — no retry storm.
		const second = await checkWsRefreshOnce(refused);
		expect(second.reason).toBe('backoff');
		expect(second.ran).toBe(false);
	});

	test('a PARTIAL run does not advance indexed_head — the commit is not served', async () => {
		const fx = unitFixture({ head: 'a'.repeat(40) });
		const partial: WsRefreshCheckDeps = {
			...fx.deps,
			runWriter: async () => syntheticReport({
				status: 'partial',
				files_failed: [{ path: 'doc.md', error: 'batch 1/2 failed (embedding timeout)' }],
			}),
		};
		const result = await checkWsRefreshOnce(partial);
		expect(result.reason).toBe('run-failed');
		expect(result.state.indexed_head).toBeNull();
		expect(result.state.last_run?.status).toBe('partial');
		expect(result.state.last_error).toMatch(/doc\.md/);
	});

	test('no HEAD (not a git workspace) stays idle and never calls the writer', async () => {
		const fx = unitFixture({ head: null });
		let calls = 0;
		const deps: WsRefreshCheckDeps = { ...fx.deps, runWriter: async () => { calls++; return syntheticReport(); } };
		const result = await checkWsRefreshOnce(deps);
		expect(result.ran).toBe(false);
		expect(result.reason).toBe('no-head');
		expect(result.state.last_error).toMatch(/cannot read HEAD/);
		expect(calls).toBe(0);
		// Persisted once — a second idle check does not rewrite the file.
		const before = readWsRefreshState(fx.statePath);
		await checkWsRefreshOnce(deps);
		const after = readWsRefreshState(fx.statePath);
		expect(after?.updated_at).toBe(before?.updated_at);
	});

	test('state reloads across hosts: a fresh process resumes from the persisted head', async () => {
		const fx = unitFixture({ head: 'a'.repeat(40) });
		await checkWsRefreshOnce(fx.deps); // indexes head A
		// Simulate a host restart: same statePath, new check deps (in-memory
		// state gone), same head — no re-index needed.
		let calls = 0;
		const restarted: WsRefreshCheckDeps = {
			...fx.deps,
			runWriter: async () => { calls++; return syntheticReport(); },
		};
		const result = await checkWsRefreshOnce(restarted);
		expect(result.ran).toBe(false);
		expect(result.reason).toBe('unchanged');
		expect(calls).toBe(0);
	});
});

describe('wsRefreshBackoffSeconds', () => {
	test('doubles per failure up to 16× poll, capped at 1 h', () => {
		expect(wsRefreshBackoffSeconds(0, 120)).toBe(0);
		expect(wsRefreshBackoffSeconds(1, 120)).toBe(240);
		expect(wsRefreshBackoffSeconds(2, 120)).toBe(480);
		expect(wsRefreshBackoffSeconds(3, 120)).toBe(960);
		expect(wsRefreshBackoffSeconds(4, 120)).toBe(1920);
		expect(wsRefreshBackoffSeconds(5, 120)).toBe(1920); // plateau — bounded retry
		expect(wsRefreshBackoffSeconds(6, 120)).toBe(1920);
		// The 1 h cap binds once 16× poll exceeds it.
		expect(wsRefreshBackoffSeconds(4, 600)).toBe(3600);
		expect(wsRefreshBackoffSeconds(9, 3600)).toBe(3600);
	});
});

describe('startWsRefreshLoop — self-scheduling singleton', () => {
	afterEach(() => stopWsRefreshLoop());

	function tempStatePath() {
		const dir = mkdtempSync(join(tmpdir(), 'ws-refresh-loop-'));
		tempDirs.push(dir);
		return join(dir, 'state.json');
	}

	/** Tests NEVER touch the real ~/.roo-state-manager lease (ms#1782 B2). */
	function tempLeasePath() {
		const dir = mkdtempSync(join(tmpdir(), 'ws-refresh-lease-'));
		tempDirs.push(dir);
		return join(dir, 'loop.lock');
	}

	test('the next poll arms only AFTER the previous check settles', async () => {
		const queue: Array<() => void> = [];
		let ticks = 0;
		let inFlight = false;
		const overlaps: boolean[] = [];
		const head = 'a'.repeat(40);
		let resolveWriter: (() => void) | null = null;
		const loop = startWsRefreshLoop({
			workspaceRoot: 'C:\\fake',
			writer: 'web1:x',
			hashPathPrefix: PREFIX,
			pollSeconds: 120,
			statePath: tempStatePath(),
			leasePath: tempLeasePath(),
			runWriter: () => new Promise<WsIndexWriterReport>((resolve) => {
				if (inFlight) overlaps.push(true);
				inFlight = true;
				ticks++;
				resolveWriter = () => resolve(syntheticReport());
			}),
			readHead: async () => head,
			schedule: (fn) => { queue.push(fn); return queue.length; },
			cancel: () => {},
		});
		expect(isWsRefreshLoopRunning()).toBe(true);
		expect(overlaps).toEqual([]); // mutation guard: never two writers at once
		// Fire the first tick — the writer hangs until released.
		queue.shift()!();
		await new Promise((r) => setTimeout(r, 10));
		expect(ticks).toBe(1);
		expect(queue.length).toBe(0); // NO next poll while the run is in flight
		resolveWriter!();
		await new Promise((r) => setTimeout(r, 10));
		expect(queue.length).toBe(1); // armed only now
		loop.stop();
	});

	test('a second loop in the same host is refused', () => {
		startWsRefreshLoop({
			workspaceRoot: 'C:\\fake',
			writer: 'web1:x',
			hashPathPrefix: PREFIX,
			pollSeconds: 120,
			statePath: tempStatePath(),
			leasePath: tempLeasePath(),
			runWriter: async () => syntheticReport(),
			readHead: async () => 'a'.repeat(40),
			schedule: () => 0,
			cancel: () => {},
		});
		expect(() => startWsRefreshLoop({
			workspaceRoot: 'C:\\fake2',
			writer: 'other:x',
			hashPathPrefix: PREFIX,
			pollSeconds: 60,
			statePath: tempStatePath(),
			leasePath: tempLeasePath(),
			runWriter: async () => syntheticReport(),
			readHead: async () => 'a'.repeat(40),
			schedule: () => 0,
			cancel: () => {},
		})).toThrow(/one loop per host/);
	});

	test('stop() disarms: no further poll, running flag cleared', async () => {
		const queue: Array<() => void> = [];
		const loop = startWsRefreshLoop({
			workspaceRoot: 'C:\\fake',
			writer: 'web1:x',
			hashPathPrefix: PREFIX,
			pollSeconds: 120,
			statePath: tempStatePath(),
			leasePath: tempLeasePath(),
			runWriter: async () => syntheticReport(),
			readHead: async () => null,
			schedule: (fn) => { queue.push(fn); return queue.length; },
			cancel: () => {},
		});
		loop.stop();
		expect(isWsRefreshLoopRunning()).toBe(false);
		const queued = queue.length;
		queue.shift()?.(); // a late-armed tick must do nothing
		await new Promise((r) => setTimeout(r, 5));
		expect(queue.length).toBe(queued - 1); // no re-arm after stop
	});
});

describe('host lease — one loop per HOST, not per process (ms#1782 B2)', () => {
	afterEach(() => stopWsRefreshLoop());

	function tempLeasePath() {
		const dir = mkdtempSync(join(tmpdir(), 'ws-refresh-lease-'));
		tempDirs.push(dir);
		return join(dir, 'loop.lock');
	}

	function writeLease(leasePath: string, content: unknown) {
		writeFileSync(leasePath, typeof content === 'string' ? content : JSON.stringify(content));
	}

	/**
	 * A LIVE foreign pid: our own parent (the vitest worker spawner) is alive
	 * by construction and is not us — exactly what a second RSM host process
	 * on the machine looks like to the first.
	 */
	function foreignLivePid(): number {
		return process.ppid;
	}

	test('acquire → second acquire renews (same pid heartbeat)', () => {
		const leasePath = tempLeasePath();
		expect(tryAcquireWsRefreshLease({ leasePath })).toBe(true);
		expect(tryAcquireWsRefreshLease({ leasePath })).toBe(true); // renew
		expect(releaseWsRefreshLeaseIfOurs({ leasePath })).toBe(true);
		expect(existsSync(leasePath)).toBe(false);
	});

	test('a live foreign holder blocks the acquire — the second PROCESS does not start', () => {
		const leasePath = tempLeasePath();
		writeLease(leasePath, { pid: foreignLivePid(), timestamp: Date.now() });
		expect(tryAcquireWsRefreshLease({ leasePath, staleMs: 60_000 })).toBe(false);
	});

	test('a DEAD holder is stolen before the stale threshold (PID probe accelerator)', () => {
		const leasePath = tempLeasePath();
		// 4194303 = pid_max-ish, nobody alive holds it; if the platform ever
		// recycles it, the stale path below still covers the case.
		writeLease(leasePath, { pid: 4194303, timestamp: Date.now() });
		expect(tryAcquireWsRefreshLease({ leasePath, staleMs: 60_000 })).toBe(true);
		expect(releaseWsRefreshLeaseIfOurs({ leasePath })).toBe(true);
	});

	test('a STALE holder (alive but silent past the threshold) is stolen, with read-back', () => {
		const leasePath = tempLeasePath();
		writeLease(leasePath, { pid: foreignLivePid(), timestamp: Date.now() - 120_000 });
		expect(tryAcquireWsRefreshLease({ leasePath, staleMs: 60_000 })).toBe(true);
		// The steal re-wrote the holder — it is ours now.
		const holder = JSON.parse(readFileSync(leasePath, 'utf8'));
		expect(holder.pid).toBe(process.pid);
	});

	test('an unparseable lease is abandoned only past the threshold (fail-closed under it)', () => {
		const freshPath = tempLeasePath();
		writeLease(freshPath, 'not json');
		expect(tryAcquireWsRefreshLease({ leasePath: freshPath, staleMs: 60_000 })).toBe(false);
		expect(readFileSync(freshPath, 'utf8')).toBe('not json'); // untouched — fail-closed
		const oldPath = tempLeasePath();
		writeLease(oldPath, '');
		utimesSync(oldPath, new Date(Date.now() - 120_000), new Date(Date.now() - 120_000));
		expect(tryAcquireWsRefreshLease({ leasePath: oldPath, staleMs: 60_000 })).toBe(true);
	});

	test('TWO LOOP INSTANCES sharing one lease: first runs, second PROCESS refused, release→third runs', () => {
		const leasePath = tempLeasePath();
		const base = {
			workspaceRoot: 'C:\\fake',
			writer: 'web1:x',
			hashPathPrefix: PREFIX,
			pollSeconds: 120,
			statePath: join(dirname(leasePath), 'state.json'),
			leasePath,
			runWriter: async () => syntheticReport(),
			readHead: async () => 'a'.repeat(40),
			schedule: () => 0,
			cancel: () => {},
		};
		// Instance 1 (this process) starts and holds the host lease.
		const first = startWsRefreshLoop({ ...base });
		expect(isWsRefreshLoopRunning()).toBe(true);
		// A second PROCESS appears: it seizes the lease file (live foreign
		// holder, fresh heartbeat)…
		writeLease(leasePath, { pid: foreignLivePid(), timestamp: Date.now() });
		// …and our loop stops cleanly. stop() must NOT release the lease —
		// it no longer carries our pid (releaseWsRefreshLeaseIfOurs contract).
		first.stop();
		expect(isWsRefreshLoopRunning()).toBe(false);
		expect(JSON.parse(readFileSync(leasePath, 'utf8')).pid).toBe(foreignLivePid());
		// Now a genuine second instance (singleton cleared) tries to start on
		// the SAME lease: refused by the HOST lease, not silently started —
		// the per-process singleton alone cannot see the other process.
		expect(() => startWsRefreshLoop({ ...base, workspaceRoot: 'C:\\fake2' }))
			.toThrow(/HOST lease/);
		// The foreign holder goes away → the same lease admits a third start.
		rmSync(leasePath, { force: true });
		const third = startWsRefreshLoop({ ...base });
		expect(isWsRefreshLoopRunning()).toBe(true);
		third.stop();
		expect(existsSync(leasePath)).toBe(false); // released by OUR stop
	});

	test('a RUNNING loop that loses the lease self-disarms instead of double-writing', async () => {
		const leasePath = tempLeasePath();
		const queue: Array<() => void> = [];
		const logs: string[] = [];
		let writerCalls = 0;
		startWsRefreshLoop({
			workspaceRoot: 'C:\\fake',
			writer: 'web1:x',
			hashPathPrefix: PREFIX,
			pollSeconds: 120,
			statePath: join(dirname(leasePath), 'state.json'),
			leasePath,
			runWriter: async () => { writerCalls++; return syntheticReport(); },
			readHead: async () => 'a'.repeat(40),
			schedule: (fn) => { queue.push(fn); return queue.length; },
			cancel: () => {},
			log: (m) => logs.push(m),
		});
		// Tick 1: healthy — lease ours, writer runs.
		queue.shift()!();
		await new Promise((r) => setTimeout(r, 10));
		expect(writerCalls).toBe(1);
		// Another process steals the lease (live foreign holder, fresh).
		writeLease(leasePath, { pid: foreignLivePid(), timestamp: Date.now() });
		// Tick 2: renewal fails → self-disarm, no writer call, no re-arm.
		queue.shift()!();
		await new Promise((r) => setTimeout(r, 10));
		expect(writerCalls).toBe(1);
		expect(isWsRefreshLoopRunning()).toBe(false);
		expect(queue.length).toBe(0);
		expect(logs.some((m) => m.includes('disarms itself'))).toBe(true);
		// The foreign lease must survive us — it is not ours to release.
		expect(JSON.parse(readFileSync(leasePath, 'utf8')).pid).toBe(foreignLivePid());
	});
});

describe('host lease — mid-run renewal (ms#1782 review follow-up: a pass can outlive the steal window)', () => {
	afterEach(() => stopWsRefreshLoop());

	function tempLeasePath() {
		const dir = mkdtempSync(join(tmpdir(), 'ws-refresh-lease-'));
		tempDirs.push(dir);
		return join(dir, 'loop.lock');
	}

	function writeLease(leasePath: string, content: unknown) {
		writeFileSync(leasePath, typeof content === 'string' ? content : JSON.stringify(content));
	}

	function foreignLivePid(): number {
		return process.ppid;
	}

	test('a pass longer than the steal window keeps the lease fresh — renewed every staleMs/3', async () => {
		const leasePath = tempLeasePath();
		const pollQ: Array<() => void> = [];
		const renewQ: Array<() => void> = [];
		const renewDelays: number[] = [];
		let resolveWriter: (() => void) | null = null;
		startWsRefreshLoop({
			workspaceRoot: 'C:\\fake',
			writer: 'web1:x',
			hashPathPrefix: PREFIX,
			pollSeconds: 120,
			statePath: join(dirname(leasePath), 'state.json'),
			leasePath,
			leaseStaleMs: 60_000,
			runWriter: () => new Promise<WsIndexWriterReport>((resolve) => {
				resolveWriter = () => resolve(syntheticReport());
			}),
			readHead: async () => 'a'.repeat(40),
			schedule: (fn) => { pollQ.push(fn); return pollQ.length; },
			cancel: () => {},
			renewalSchedule: (fn, ms) => { renewDelays.push(ms); renewQ.push(fn); return renewQ.length; },
			renewalCancel: () => {},
		});
		const before = Date.now();
		pollQ.shift()!(); // tick 1 — the writer hangs, the pass "lasts" the whole test
		await new Promise((r) => setTimeout(r, 10));
		// The renewal cadence is a THIRD of the steal threshold (mutation guard).
		expect(renewDelays).toEqual([20_000]);
		// "Time passes" far past the 60 s steal window: each fired renewal must
		// refresh the timestamp a contender would read — without them, the lease
		// would be stale-stealable after tick+60 s of silent pass.
		for (let i = 0; i < 4; i++) {
			renewQ.shift()!();
			await new Promise((r) => setTimeout(r, 5));
			const holder = JSON.parse(readFileSync(leasePath, 'utf8'));
			expect(holder.pid).toBe(process.pid);
			expect(holder.timestamp).toBeGreaterThanOrEqual(before);
		}
		// Still self-re-arming while the pass runs.
		expect(renewQ.length).toBe(1);
		resolveWriter!();
		await new Promise((r) => setTimeout(r, 10));
		// Pass settled: the pending renewal was cancelled at settle, and a
		// late-fired one (cancel is a no-op seam here) stays inert — no re-arm.
		renewQ.shift()!();
		await new Promise((r) => setTimeout(r, 5));
		expect(renewQ.length).toBe(0);
	});

	test('a lease stolen MID-RUN disarms the loop at pass settle — pass result stands, no next poll', async () => {
		const leasePath = tempLeasePath();
		const pollQ: Array<() => void> = [];
		const renewQ: Array<() => void> = [];
		const logs: string[] = [];
		let writerCalls = 0;
		let resolveWriter: (() => void) | null = null;
		startWsRefreshLoop({
			workspaceRoot: 'C:\\fake',
			writer: 'web1:x',
			hashPathPrefix: PREFIX,
			pollSeconds: 120,
			statePath: join(dirname(leasePath), 'state.json'),
			leasePath,
			leaseStaleMs: 60_000,
			runWriter: () => new Promise<WsIndexWriterReport>((resolve) => {
				writerCalls++;
				resolveWriter = () => resolve(syntheticReport());
			}),
			readHead: async () => 'a'.repeat(40),
			schedule: (fn) => { pollQ.push(fn); return pollQ.length; },
			cancel: () => {},
			renewalSchedule: (fn) => { renewQ.push(fn); return renewQ.length; },
			renewalCancel: () => {},
			log: (m) => logs.push(m),
		});
		pollQ.shift()!(); // tick 1 — the writer hangs
		await new Promise((r) => setTimeout(r, 10));
		expect(writerCalls).toBe(1);
		// A second process takes the lease while the pass runs (live foreign pid, fresh).
		writeLease(leasePath, { pid: foreignLivePid(), timestamp: Date.now() });
		renewQ.shift()!(); // the mid-run renewal sees the foreign holder
		await new Promise((r) => setTimeout(r, 5));
		expect(logs.some((m) => m.includes('lost mid-run'))).toBe(true);
		// The running pass is NOT aborted — a run cannot be cancelled mid-flight.
		expect(isWsRefreshLoopRunning()).toBe(true);
		resolveWriter!();
		await new Promise((r) => setTimeout(r, 10));
		expect(writerCalls).toBe(1);
		// …but the loop disarms at settle and arms no next poll.
		expect(isWsRefreshLoopRunning()).toBe(false);
		expect(pollQ.length).toBe(0);
		expect(logs.some((m) => m.includes('loop disarmed'))).toBe(true);
		// The foreign lease must survive us — it is not ours to release.
		expect(JSON.parse(readFileSync(leasePath, 'utf8')).pid).toBe(foreignLivePid());
	});

	test('stop() during a pass: a late-fired renewal never re-takes the released lease', async () => {
		const leasePath = tempLeasePath();
		const pollQ: Array<() => void> = [];
		const renewQ: Array<() => void> = [];
		let resolveWriter: (() => void) | null = null;
		const loop = startWsRefreshLoop({
			workspaceRoot: 'C:\\fake',
			writer: 'web1:x',
			hashPathPrefix: PREFIX,
			pollSeconds: 120,
			statePath: join(dirname(leasePath), 'state.json'),
			leasePath,
			leaseStaleMs: 60_000,
			runWriter: () => new Promise<WsIndexWriterReport>((resolve) => {
				resolveWriter = () => resolve(syntheticReport());
			}),
			readHead: async () => 'a'.repeat(40),
			schedule: (fn) => { pollQ.push(fn); return pollQ.length; },
			cancel: () => {},
			renewalSchedule: (fn) => { renewQ.push(fn); return renewQ.length; },
			renewalCancel: () => {}, // deliberately inert — the late-fire path is the point
		});
		pollQ.shift()!(); // pass in flight, renewal armed
		await new Promise((r) => setTimeout(r, 10));
		loop.stop();
		expect(existsSync(leasePath)).toBe(false); // released by stop
		renewQ.shift()!(); // fires AFTER stop — must stay a no-op
		await new Promise((r) => setTimeout(r, 5));
		expect(existsSync(leasePath)).toBe(false); // NOT re-taken by a dead loop's ghost
		resolveWriter!();
		await new Promise((r) => setTimeout(r, 5));
	});
});

afterAll(() => {
	for (const dir of tempDirs) {
		try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
	}
});
