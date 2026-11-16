/**
 * #4736 P4 — the post-commit refresh loop and its observability.
 *
 * Issue criterion, verbatim: "après un commit, une requête de référence rend le
 * nouveau symbole dans `codebase_search`, et les résultats périmés disparaissent,
 * dans un délai annoncé."
 *
 * P3 delivered the guarded incremental writer (`runWsIndexWriter`) but nothing
 * RUNS it: a ws-* collection only refreshes when a human calls index_code_ws.
 * This module is the missing trigger — a background loop on the writer seat
 * that polls the workspace's git HEAD and runs one incremental writer pass each
 * time it changes. The delta work itself is the writer's (hash-cache skip,
 * purge-before-upsert, deleted-file GC), so a refresh costs only the changed
 * files' embeddings, never the corpus.
 *
 * Design decisions (all mirroring the reconcile daemons the host already runs):
 *
 *  - TRIGGER = HEAD change only. Uncommitted edits are intentionally NOT a
 *    trigger: the criterion says "après un commit", and polling the working
 *    tree would re-embed on every save. A dirty tree is picked up by the next
 *    commit (or a manual index_code_ws run).
 *  - OPT-IN per seat: the loop starts ONLY when the host env arms it
 *    (WS_INDEX_REFRESH_WORKSPACE etc.). Exactly one seat is the writer — the
 *    sentinel already refuses a second one, and the loop must not even try.
 *  - FAILURE ≠ DEATH: a refused run (foreign writer, embedding outage, wrong
 *    prefix) records the error, does NOT advance `indexed_head`, and backs off
 *    exponentially — the next tick retries the same commit, which is cheap:
 *    files whose blocks all landed are cached and skipped.
 *  - 'partial' runs do NOT advance `indexed_head` either: a partially-written
 *    commit is not "served", and the retry only re-embeds the missing batches.
 *  - ANNOUNCED DELAY: the SLO is derived, never declared out of thin air —
 *    `announced_delay_s = poll_seconds + ceil(last successful run seconds)`.
 *    A commit becomes served at worst one poll after it lands, plus one
 *    incremental run. `last_refresh_ms` measures detection→served so the SLO
 *    is checkable against reality.
 *  - STATE = a local JSON file (atomic tmp+rename), per seat: the loop only
 *    runs on the writer seat, and the observability read (`ws_refresh_status`)
 *    is served by that seat's host. It survives host restarts.
 *  - ONE LOOP PER HOST (review ms#1782, blocker B2): the module singleton only
 *    bounds one PROCESS, and a machine runs N RSM host processes (one per
 *    Claude session) — each would start a loop with the SAME writer string,
 *    which the sentinel cannot tell apart. A machine-level file lease
 *    (PID + heartbeat, fail-closed, stale takeover — same shape as the Worker
 *    A leader lock #3661/#4352) closes that: the first starter holds it, the
 *    others refuse to start, a dead holder is stolen by PID probe, and a loop
 *    that loses the lease mid-flight self-disarms instead of writing alongside.
 */
import { execFile } from 'child_process';
import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync, statSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { isProcessAlive } from '../pid-liveness.js';
import type { WsIndexWriterReport } from './ws-index-writer.js';

// ── State ─────────────────────────────────────────────────────────────────────

export interface WsRefreshRunRecord {
	started_at: string;
	finished_at: string;
	/** The commit this run indexed. */
	head: string;
	status: 'success' | 'partial' | 'failed';
	files_indexed: number;
	files_removed: number;
	points_written: number;
	points_deleted: number;
	elapsed_ms: number;
	error?: string;
}

export interface WsRefreshState {
	workspace_root: string;
	writer: string;
	poll_seconds: number;
	/** The commit currently indexed (null = none yet). Advances ONLY on a full success. */
	indexed_head: string | null;
	last_run: WsRefreshRunRecord | null;
	last_error: string | null;
	consecutive_failures: number;
	/** Epoch-ms before which the loop must not retry (backoff), 0 = immediate. */
	retry_not_before_ms: number;
	/** The SLO: poll_seconds + ceil(last successful run seconds). Derived each run. */
	announced_delay_s: number | null;
	/** detection→served of the last successful refresh, in ms. */
	last_refresh_ms: number | null;
	updated_at: string;
}

export function defaultWsRefreshStatePath(): string {
	return join(homedir(), '.roo-state-manager', 'ws-refresh-state.json');
}

export function readWsRefreshState(statePath: string): WsRefreshState | null {
	try {
		const raw = readFileSync(statePath, 'utf8');
		const parsed = JSON.parse(raw);
		if (typeof parsed?.workspace_root !== 'string') return null;
		return parsed as WsRefreshState;
	} catch {
		return null; // absent or unreadable → no state yet, not an error
	}
}

/** Atomic write (tmp + rename) — a torn state file must never replace a good one. */
function writeWsRefreshState(statePath: string, state: WsRefreshState): void {
	mkdirSync(dirname(statePath), { recursive: true });
	const tmp = `${statePath}.tmp`;
	writeFileSync(tmp, JSON.stringify(state, null, '\t'), 'utf8');
	renameSync(tmp, statePath);
}

// ── Backoff ───────────────────────────────────────────────────────────────────

/**
 * Exponential, capped: poll × 2^min(failures, 4), never past 1 h. One failed
 * run doubles the wait, five quadruple×16 — a persistent outage (embedding
 * endpoint down, foreign writer) then retries hourly instead of every poll.
 */
export function wsRefreshBackoffSeconds(consecutiveFailures: number, pollSeconds: number): number {
	if (consecutiveFailures <= 0) return 0;
	const exp = Math.min(consecutiveFailures, 4);
	return Math.min(pollSeconds * 2 ** exp, 3600);
}

// ── Host lease (review ms#1782, blocker B2) ──────────────────────────────────

/**
 * Machine-level lease so "one loop per host" means per HOST, not per Node
 * process. Same contention shape as the Worker A leader lock (#3661): file
 * under the state dir, `{pid, timestamp}`, renewed on every tick (the tick IS
 * the heartbeat — the next poll is armed only after the previous check
 * settled, so the renewal gap is one poll plus one run), fail-closed on any
 * unexpected error, dead-holder steal by PID probe (accelerator) and
 * stale-threshold steal (the net — a recycled PID never proves identity).
 *
 * SYNC fs on purpose: the whole loop module writes its state synchronously,
 * and `stop()` must release the lease before process.exit() in the shutdown
 * path — a fire-and-forget async unlink would race it.
 */
export const WS_REFRESH_LEASE_STALE_MS = 15 * 60 * 1000;

export function defaultWsRefreshLeasePath(): string {
	return join(homedir(), '.roo-state-manager', 'ws-refresh-loop.lock');
}

interface WsRefreshLeaseFile {
	pid: number;
	timestamp: number;
}

/** Sync twin of lock-atomicity's readLockForAtomicity (#4352 W1 semantics). */
function readLeaseForAtomicity(leasePath: string): { pid: number } | null {
	try {
		const parsed = JSON.parse(readFileSync(leasePath, 'utf8'));
		return typeof parsed?.pid === 'number' ? parsed : null;
	} catch {
		return null;
	}
}

export interface WsRefreshLeaseOptions {
	/** Default `~/.roo-state-manager/ws-refresh-loop.lock`. */
	leasePath?: string;
	/** Tests tighten it; production uses WS_REFRESH_LEASE_STALE_MS. */
	staleMs?: number;
}

/**
 * Acquire-or-renew the host lease. Returns false WITHOUT taking over when the
 * file names a live foreign holder; steals a dead or stale holder, then
 * re-reads — whoever's pid the file carries after the overwrite wins (the
 * steal is not atomic; two contenders can both overwrite, #4352 W1).
 */
export function tryAcquireWsRefreshLease(options: WsRefreshLeaseOptions = {}): boolean {
	const leasePath = options.leasePath ?? defaultWsRefreshLeasePath();
	const staleMs = options.staleMs ?? WS_REFRESH_LEASE_STALE_MS;
	const payload: WsRefreshLeaseFile = { pid: process.pid, timestamp: Date.now() };
	const write = JSON.stringify(payload);
	try {
		mkdirSync(dirname(leasePath), { recursive: true });
		// 'wx' — the single atomic serialization point of the election.
		writeFileSync(leasePath, write, { flag: 'wx' });
		return true;
	} catch (error: any) {
		if (error?.code !== 'EEXIST') return false; // unreadable dir etc. — fail-closed
	}
	let existing: WsRefreshLeaseFile | null = null;
	try {
		const parsed = JSON.parse(readFileSync(leasePath, 'utf8'));
		if (typeof parsed?.pid === 'number') existing = parsed;
	} catch {
		/* unparseable — handled below by the mtime net */
	}
	if (existing) {
		if (existing.pid === process.pid) {
			// Our own lease from the previous tick → renew (the heartbeat).
			try {
				writeFileSync(leasePath, write);
				return true;
			} catch {
				return false;
			}
		}
		const age = Date.now() - existing.timestamp;
		const holderDead = !isProcessAlive(existing.pid);
		if (!holderDead && age <= staleMs) return false; // a live, fresh foreign loop
		// Dead holder (steal before the threshold — ai-01's #4352 fix) or stale
		// one (the net for recycled PIDs). Steal + read-back arbitration.
		try {
			writeFileSync(leasePath, write);
		} catch {
			return false;
		}
		const stolen = readLeaseForAtomicity(leasePath);
		return stolen === null || stolen.pid === process.pid;
	}
	// Unparseable content: either a holder between its O_EXCL and its write, or
	// an abandoned file. Only an old-enough file is treated as abandoned — the
	// same deliberate one-stale-window self-heal as worker-a-lock.
	try {
		const stat = existsSync(leasePath) ? statSync(leasePath) : null;
		if (stat && Date.now() - stat.mtimeMs > staleMs) {
			writeFileSync(leasePath, write);
			const stolen = readLeaseForAtomicity(leasePath);
			return stolen === null || stolen.pid === process.pid;
		}
	} catch {
		/* fall through, fail-closed */
	}
	return false;
}

/** Release on clean stop, only if the lease carries OUR pid — never throws. */
export function releaseWsRefreshLeaseIfOurs(options: WsRefreshLeaseOptions = {}): boolean {
	const leasePath = options.leasePath ?? defaultWsRefreshLeasePath();
	try {
		const parsed = JSON.parse(readFileSync(leasePath, 'utf8'));
		if (typeof parsed?.pid !== 'number' || parsed.pid !== process.pid) return false;
		unlinkSync(leasePath);
		return true;
	} catch {
		return false;
	}
}

// ── HEAD reading ──────────────────────────────────────────────────────────────

/** `git rev-parse HEAD` of the workspace — null when git fails (no repo, no git). */
export function readGitHead(workspaceRoot: string): Promise<string | null> {
	return new Promise((resolve) => {
		execFile(
			'git',
			['-C', workspaceRoot, 'rev-parse', 'HEAD'],
			{ timeout: 10_000, windowsHide: true },
			(err, stdout) => resolve(err ? null : String(stdout).trim() || null),
		);
	});
}

// ── One check ─────────────────────────────────────────────────────────────────

export interface WsRefreshCheckDeps {
	workspaceRoot: string;
	writer: string;
	hashPathPrefix: string;
	pollSeconds: number;
	/**
	 * One guarded writer pass over the workspace. Injected by the host so this
	 * module stays free of the qdrant/embedding chains (same pattern as the
	 * dashboard reconcile daemon, which cannot import the tool module either).
	 */
	runWriter: () => Promise<WsIndexWriterReport>;
	statePath?: string;
	readHead?: (workspaceRoot: string) => Promise<string | null>;
	now?: () => { iso: string; ms: number };
	log?: (message: string) => void;
}

export interface WsRefreshCheckResult {
	ran: boolean;
	reason: 'no-head' | 'unchanged' | 'backoff' | 'refreshed' | 'run-failed';
	head: string | null;
	state: WsRefreshState;
}

export async function checkWsRefreshOnce(deps: WsRefreshCheckDeps): Promise<WsRefreshCheckResult> {
	const statePath = deps.statePath ?? defaultWsRefreshStatePath();
	const readHead = deps.readHead ?? readGitHead;
	const now = deps.now ?? (() => ({ iso: new Date().toISOString(), ms: Date.now() }));
	const log = deps.log ?? (() => {});

	const persisted = readWsRefreshState(statePath);
	const state: WsRefreshState = persisted ?? {
		workspace_root: deps.workspaceRoot,
		writer: deps.writer,
		poll_seconds: deps.pollSeconds,
		indexed_head: null,
		last_run: null,
		last_error: null,
		consecutive_failures: 0,
		retry_not_before_ms: 0,
		announced_delay_s: null,
		last_refresh_ms: null,
		updated_at: now().iso,
	};
	// Config drift (poll cadence) must not outlive the file it was written with.
	state.workspace_root = deps.workspaceRoot;
	state.writer = deps.writer;
	state.poll_seconds = deps.pollSeconds;

	const head = await readHead(deps.workspaceRoot);
	if (head === null) {
		const message = `cannot read HEAD of ${deps.workspaceRoot} (no git repo / git unavailable) — loop stays idle`;
		if (state.last_error !== message) {
			state.last_error = message;
			state.updated_at = now().iso;
			writeWsRefreshState(statePath, state);
			log(`[WsRefresh] ${message}`);
		}
		return { ran: false, reason: 'no-head', head: null, state };
	}

	if (state.indexed_head === head) {
		return { ran: false, reason: 'unchanged', head, state };
	}

	const nowMs = now().ms;
	if (state.retry_not_before_ms > nowMs) {
		return { ran: false, reason: 'backoff', head, state };
	}

	const detectedMs = nowMs;
	const startedIso = now().iso;
	log(`[WsRefresh] HEAD ${head.slice(0, 10)} != indexed ${state.indexed_head?.slice(0, 10) ?? 'none'} — incremental run`);
	try {
		const report = await deps.runWriter();
		const finished = now();
		const run: WsRefreshRunRecord = {
			started_at: startedIso,
			finished_at: finished.iso,
			head,
			// 'dry_run' cannot come from the loop (dryRun: false) but a
			// miswired injected writer returning one has written NOTHING —
			// the commit is not served, so it counts as a failure here.
			status: report.status === 'success' || report.status === 'partial' ? report.status : 'failed',
			files_indexed: report.files_indexed ?? 0,
			files_removed: report.files_removed ?? 0,
			points_written: report.points_written ?? 0,
			points_deleted: report.points_deleted ?? 0,
			elapsed_ms: report.elapsed_ms ?? 0,
		};
		state.last_run = run;
		if (report.status === 'success') {
			// Only a full success advances the indexed HEAD — partial keeps the
			// commit "not served", and the retry only re-embeds the missing
			// batches (files whose blocks all landed are hash-cached).
			state.indexed_head = head;
			state.consecutive_failures = 0;
			state.retry_not_before_ms = 0;
			state.last_error = null;
			state.last_refresh_ms = finished.ms - detectedMs;
			state.announced_delay_s = deps.pollSeconds + Math.ceil((report.elapsed_ms ?? 0) / 1000);
			state.updated_at = finished.iso;
			writeWsRefreshState(statePath, state);
			log(
				`[WsRefresh] ${head.slice(0, 10)} served in ${state.last_refresh_ms} ms ` +
				`(${run.files_indexed} file(s) indexed, ${run.points_deleted} stale point(s) purged) — ` +
				`announced delay now ${state.announced_delay_s} s`
			);
			return { ran: true, reason: 'refreshed', head, state };
		}
		// 'partial' or 'failed' — do NOT advance indexed_head.
		state.consecutive_failures += 1;
		state.retry_not_before_ms = now().ms + wsRefreshBackoffSeconds(state.consecutive_failures, deps.pollSeconds) * 1000;
		state.last_error = `run ${report.status}: ${report.files_failed?.map((f) => `${f.path} (${f.error})`).join('; ') || report.warnings?.slice(0, 3).join('; ') || 'no detail'}`;
		state.updated_at = finished.iso;
		writeWsRefreshState(statePath, state);
		log(`[WsRefresh] run ${report.status} on ${head.slice(0, 10)} — retry in ${wsRefreshBackoffSeconds(state.consecutive_failures, deps.pollSeconds)} s`);
		return { ran: true, reason: 'run-failed', head, state };
	} catch (error) {
		const finished = now();
		const message = error instanceof Error ? error.message : String(error);
		state.consecutive_failures += 1;
		state.retry_not_before_ms = finished.ms + wsRefreshBackoffSeconds(state.consecutive_failures, deps.pollSeconds) * 1000;
		state.last_error = message;
		state.updated_at = finished.iso;
		writeWsRefreshState(statePath, state);
		log(`[WsRefresh] run refused/failed on ${head.slice(0, 10)}: ${message} — retry in ${wsRefreshBackoffSeconds(state.consecutive_failures, deps.pollSeconds)} s`);
		return { ran: true, reason: 'run-failed', head, state };
	}
}

// ── The loop ──────────────────────────────────────────────────────────────────

let activeLoop: { stop: () => void } | null = null;

/** Whether a refresh loop runs in this host — surfaced by ws_refresh_status. */
export function isWsRefreshLoopRunning(): boolean {
	return activeLoop !== null;
}

export interface WsRefreshLoopConfig extends WsRefreshCheckDeps {
	/** First check delay (default 30 s) — do not race host startup. */
	initialDelayMs?: number;
	/** Test seam isolating the lease from any real loop on the machine. */
	leasePath?: string;
	/** Test seam for the stale threshold (production: WS_REFRESH_LEASE_STALE_MS). */
	leaseStaleMs?: number;
	/** Test seams for the one-shot scheduler. */
	schedule?: (fn: () => void, ms: number) => any;
	cancel?: (handle: any) => void;
}

/**
 * Starts the poll loop. One loop per HOST, enforced at TWO levels:
 *
 *  - in-process: the module singleton refuses a second start;
 *  - per-host: the file lease (review ms#1782, B2) — N RSM host processes on
 *    one machine each see only their own `activeLoop`, so the singleton alone
 *    would let all of them poll and run the writer with the SAME writer
 *    string, which the sentinel cannot refuse. The lease is acquired here and
 *    renewed at the TOP of every tick (the tick IS the heartbeat); a renewal
 *    failure (another live process owns it) self-disarms this loop instead of
 *    writing alongside it.
 *
 * Self-scheduling on purpose, NOT setInterval: a refresh run can take minutes
 * (embedding batches), and a fixed interval would pile overlapping runs on the
 * shared endpoint. The next poll is armed only after the previous check — run
 * included — has settled.
 */
export function startWsRefreshLoop(config: WsRefreshLoopConfig): { stop: () => void } {
	if (activeLoop !== null) {
		throw new Error('a ws refresh loop is already active in this host — one loop per host (#4736 P4)');
	}
	const leaseOptions: WsRefreshLeaseOptions = { leasePath: config.leasePath, staleMs: config.leaseStaleMs };
	if (!tryAcquireWsRefreshLease(leaseOptions)) {
		throw new Error(
			`the ws-refresh HOST lease is held by another process on this machine ` +
			`(${config.leasePath ?? defaultWsRefreshLeasePath()}) — only one loop per HOST (#4736 P4, review B2)`
		);
	}
	const schedule = config.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
	const cancel = config.cancel ?? ((handle: any) => clearTimeout(handle));
	const pollMs = Math.max(10_000, config.pollSeconds * 1000);
	let stopped = false;
	let handle: any = null;
	const loop: { stop: () => void } = {
		stop: () => {
			stopped = true;
			if (handle !== null) cancel(handle);
			releaseWsRefreshLeaseIfOurs(leaseOptions);
			// Stopping through the returned handle clears the singleton too —
			// a later start must not be refused by a dead loop's ghost.
			if (activeLoop === loop) activeLoop = null;
		},
	};
	const tick = async () => {
		if (stopped) return;
		// Lease renewal = the heartbeat. A failure means another live process
		// owns the loop seat: disarm THIS one rather than double-polling. The
		// lease is NOT released here — it is no longer ours to release.
		if (!tryAcquireWsRefreshLease(leaseOptions)) {
			config.log?.('[WsRefresh] host lease lost to another process — this loop disarms itself');
			stopped = true;
			if (handle !== null) cancel(handle);
			if (activeLoop === loop) activeLoop = null;
			return;
		}
		try {
			await checkWsRefreshOnce(config);
		} catch (error) {
			// checkWsRefreshOnce already catches its own writer errors; this
			// belt is for the seams themselves (state file unwritable…).
			config.log?.(`[WsRefresh] tick crashed: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (!stopped) handle = schedule(tick, pollMs);
	};
	handle = schedule(tick, config.initialDelayMs ?? 30_000);
	activeLoop = loop;
	return loop;
}

/** Stops the loop (host shutdown). Safe when not running. */
export function stopWsRefreshLoop(): void {
	if (activeLoop) {
		activeLoop.stop();
		activeLoop = null;
	}
}
