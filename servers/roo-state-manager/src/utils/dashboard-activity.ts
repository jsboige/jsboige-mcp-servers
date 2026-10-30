/**
 * Dashboard-derived machine status utility (#1953, #2016)
 *
 * Parses dashboard message timestamps to determine last-seen time per machine.
 * Used as a cross-check against heartbeat files to prevent false UNKNOWN/IDLE detection
 * caused by GDrive propagation latency or activity on workspaces other than the caller's.
 *
 * Dashboard messages embed timestamps INSIDE the content (written by the posting machine),
 * which are immune to GDrive file modification time delays.
 *
 * Message format: ### [2026-05-03T20:08:15.436Z] myia-po-2024|roo-extensions
 *
 * @module utils/dashboard-activity
 * @version 3.5.0 (#4344 residual: STALE classification by code — a concluded
 *               machine older than the STALE threshold pays ZERO archive
 *               reads on later calls (verdict cache, 24h re-verify), and a
 *               platform-suffixed ghost (-win32-x64) is attached to its host)
 * @version 3.4.0 (#4344 residual: per-machine attempt ceilings — one dead
 *               machine no longer taxes every health call, a no-live-line
 *               machine is concluded fast instead of paying the whole budget)
 * @version 3.3.0 (#4344 re-review, ms#1532: per-call ceiling on archive file
 *               reads — G: is the fleet SPOF (#4131), per-request tool paths
 *               must not spend unbounded seconds in the archive walk)
 * @version 3.2.0 (#4344: archive recovery widened beyond fully-archived
 *               machines, bounded by each machine's live lastSeen)
 * @version 3.1.0 (#3695: machine-id normalization for old `machine:workspace|path`
 *               headers + lazy archive lookup for fully-archived machines)
 */

import { createLogger } from './logger.js';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const logger = createLogger('DashboardActivity');

const DASHBOARD_MSG_PATTERN = /^###\s*\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]\s*(\S+)/gm;

/**
 * #4344 re-review (ms#1532): per-call ceiling on archive FILE reads in
 * `lookupMachineActivityInArchives`, as the DEFAULT — no opt-in flag.
 *
 * The lookup runs from 3 per-request tool paths (get-status, inventory,
 * health-view). Measured on the prod mirror (2026-10-27): 12,748 archives,
 * one stale-floor machine had 1,915 files newer than its floor ≈ 65 s of
 * serial G: reads on a single call — and GDrive is the fleet's measured
 * single point of failure this week (#4131). The walk is NEWEST FIRST, so
 * this bound only ever drops the oldest tail: the typical recovery (a
 * machine whose recent messages were just condensed) resolves within a
 * handful of files, while a machine offline for weeks keeps its bounded
 * best — the stale live floor, an honest lower bound (#3160) — instead of
 * spending unbounded seconds.
 *
 * The budget counts ATTEMPTS, not successes (ms#1532 r3): a read that throws
 * consumes one unit, so an unreadable archive directory cannot re-arm the walk.
 */
export const MAX_ARCHIVE_READS_PER_CALL = 200;

/**
 * #4344 residual (dispatch ai-01 28/10, from po-2027's cost verdict): the
 * per-call ceiling alone let ONE dead machine tax every health call. Two
 * per-machine DEFAULTS now bound the walk for each machine independently:
 *
 * - a machine WITH a live floor (e.g. myia-po-2026, floor 09/10, dead since)
 *   walks at most MAX_ARCHIVE_READS_PER_MACHINE files newer than its floor —
 *   measured ~11.7 s burned per health call on that machine alone, every call;
 * - a machine with NO live line can only ever be resolved by a HIT (the date
 *   rule needs a `best`, which is empty), so it paid the ENTIRE per-call
 *   budget before the honest #3160 null — 108 s measured. The typical #3695
 *   recovery (recently condensed out while alive) sits in the newest handful
 *   of files, so MAX_ARCHIVE_READS_NO_FLOOR newest-first attempts cover it;
 *   beyond that its lastSeen predates every actionable threshold anyway.
 *
 * Like the per-call ceiling, these count ATTEMPTS, not successes (ms#1532 r3).
 * A machine dropped at its ceiling keeps its bounded best (#3160) — the stale
 * live floor for a floor-carrying machine, the honest null for a no-floor one.
 */
export const MAX_ARCHIVE_READS_PER_MACHINE = 50;
export const MAX_ARCHIVE_READS_NO_FLOOR = 25;

/**
 * #4344 residual (arbitration ai-01 28/10, "STALE par le code"): a machine
 * whose CONCLUDED best lastSeen (live floor ∪ archives, after a bounded walk)
 * is older than this threshold is STALE — later calls pay ZERO archive reads
 * for it instead of re-burning its per-machine budget on every health call.
 *
 * The threshold is deliberately far above the #4344 founding case (a live
 * line frozen for 4-8 days while the machine kept posting, resolved by the
 * archive walk): staleness NEVER gates the first walk, only the verdict cache
 * does, and a machine coming back live refreshes its floor and clears the
 * verdict on the same call. 7 days = a machine absent from live AND archives
 * for a week while every fleet cadence is ≤12h.
 */
export const STALE_MACHINE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * #4344 residual: a STALE verdict is re-verified at most this often — the
 * cache must not freeze forever (an eventually-consistent G: mirror could
 * surface newer truth), but re-verifying a dead machine on every per-request
 * call is exactly the tax this verdict exists to remove.
 */
export const STALE_VERDICT_REVERIFY_MS = 24 * 60 * 60 * 1000;

/**
 * #4344 residual: platform-suffixed roster ghosts (e.g. myia-po-2025-win32-x64,
 * from a VS Code extension build registering a qualified machine id). The
 * registry is shared state and is NOT edited here (arbitration) — the ghost
 * is attached to its host by code: its activity is folded into the host's and
 * it inherits the host's lastSeen.
 */
const PLATFORM_SUFFIX_RE = /-(win32|linux|darwin)-(x64|arm64)$/;

export function machineBaseId(machineId: string): string {
	return machineId.toLowerCase().replace(PLATFORM_SUFFIX_RE, '');
}

/**
 * #4344 residual: the third classification bucket. Online = activity within
 * the 8h window; STALE = a KNOWN (non-null) lastSeen older than
 * STALE_MACHINE_MS; unknown = everything between (including the honest #3160
 * null — absence of signal, never a confirmed outage).
 */
export function isStaleMachine(lastSeen: string | null | undefined): boolean {
	if (!lastSeen) return false;
	const ms = new Date(lastSeen).getTime();
	if (isNaN(ms)) return false;
	return Date.now() - ms >= STALE_MACHINE_MS;
}

/**
 * #4344 residual: per-process verdict cache, machineId (lowercase) -> the
 * concluded best of a past bounded walk. In-memory ONLY: no G: write, no
 * registry edit (arbitration). `concludedAt` bounds how long a verdict skips
 * reads; `best` older than STALE_MACHINE_MS is what makes it a STALE skip.
 */
const machineVerdicts = new Map<string, { best: string; concludedAt: number }>();

export function clearMachineVerdictsForTests(): void {
	machineVerdicts.clear();
}

/**
 * Default activity threshold (8 hours).
 *
 * Aligned with the coordinator scheduler interval (480 min). A machine that ran its
 * last scheduled cycle within the last 8h is considered ONLINE regardless of
 * heartbeat file modification time, which can lag due to GDrive sync.
 */
export const DEFAULT_ACTIVITY_THRESHOLD_MS = 8 * 60 * 60 * 1000;

/**
 * Extract last-seen timestamp per machine from one or more dashboard contents.
 *
 * @param dashboardContent - A single dashboard string OR a list of dashboard strings
 *                          (typically one per workspace/machine/global dashboard file).
 * @returns Map of machineId -> most recent ISO timestamp seen across all inputs.
 */
export function extractMachineActivity(dashboardContent: string | string[]): Map<string, string> {
	const activity = new Map<string, string>();
	const inputs = Array.isArray(dashboardContent) ? dashboardContent : [dashboardContent];

	for (const content of inputs) {
		if (!content) continue;

		const pattern = new RegExp(DASHBOARD_MSG_PATTERN.source, 'gm');
		let match: RegExpExecArray | null;

		while ((match = pattern.exec(content)) !== null) {
			const timestamp = match[1];
			const authorField = match[2];

			// #3695: old header format `machine:workspace|path` (pre-v3 authors,
			// fossilized on dashboards like workspace-c--dev-CoursIA-2, 30/08)
			// must not create phantom `machine:workspace` activity keys that the
			// current format never updates — normalize to the bare machine id.
			const machineId = authorField.split('|')[0].split(':')[0].toLowerCase().trim();
			if (!machineId.startsWith('myia-')) continue;

			const existing = activity.get(machineId);
			if (!existing || timestamp > existing) {
				activity.set(machineId, timestamp);
			}
		}
	}

	logger.debug(`Dashboard activity extracted: ${activity.size} machines seen across ${inputs.length} dashboard(s)`);
	return activity;
}

/**
 * Determine if a machine should be considered ONLINE based on dashboard activity.
 *
 * @param lastSeen - ISO timestamp of last dashboard message from the machine
 * @param thresholdMs - How far back to consider "recent" (default: 8h)
 * @returns true if machine posted within the threshold
 */
export function isRecentlyActive(lastSeen: string, thresholdMs: number = DEFAULT_ACTIVITY_THRESHOLD_MS): boolean {
	const lastSeenMs = new Date(lastSeen).getTime();
	if (isNaN(lastSeenMs)) return false;
	return Date.now() - lastSeenMs < thresholdMs;
}

/**
 * #4131 G-B lot 2 (B4) — render the activity-bearing markdown of a dashboard
 * held as data (PG journal rows mapped by mapRowsToDashboard), in the exact
 * message-header format the file writer emits (dashboard.ts `### [ts]
 * machine|workspace`) so extractMachineActivity parses it identically to a
 * GDrive file. Only the `### [ts] author` lines carry activity — the body
 * content is included for debuggability, the `[msg: id]` line is not needed.
 */
export function renderDashboardActivityMarkdown(dashboard: {
	status: { markdown: string };
	intercom: { messages: Array<{ timestamp: string; content: string; author: { machineId: string; workspace: string } }> };
}): string {
	const messages = dashboard.intercom.messages
		// #1123 (échappement Hermes #2, ms#1432 review) — le writer de fichier
		// échappe les « ### [ » en début de ligne du CORPS (dashboard.ts) pour
		// que le split d'extraction ne fabrique pas de faux blocs message : le
		// render doit émettre le MÊME format, pas un corps brut. Une ligne
		// « ### [ts] machine|ws » dans un corps produirait sinon une activité
		// fantôme dans extractMachineActivity.
		.map(m => `### [${m.timestamp}] ${m.author.machineId}|${m.author.workspace}\n${m.content.replace(/^### \[/gm, '\\#\\#\\# [')}`)
		.join('\n\n');
	return `${dashboard.status.markdown}\n${messages}`;
}

/**
 * Cross-check heartbeat-derived status against dashboard activity.
 *
 * For machines marked UNKNOWN (heartbeat stale) or IDLE by HeartbeatService,
 * if any dashboard shows recent activity, override the status to ONLINE.
 *
 * Additionally, machines discovered from dashboard activity that are NOT in any
 * heartbeat list (never called this MCP server instance) are added as ONLINE.
 * This handles the ADR 008 in-memory model where each MCP server only tracks
 * its own tool calls — other machines are discovered via shared dashboards.
 *
 * @param heartbeatState - State from HeartbeatService.checkHeartbeats()
 * @param dashboardContent - One or more dashboard contents (string or string[]).
 *                          When passing string[], activity is merged across all.
 * @param thresholdMs - Dashboard activity threshold (default: 8h)
 * @returns Updated lists with overrides applied.
 */
export function crossCheckWithDashboard(
	heartbeatState: {
		onlineMachines: string[];
		unknownMachines: string[];
		idleMachines: string[];
	},
	dashboardContent: string | string[],
	thresholdMs: number = DEFAULT_ACTIVITY_THRESHOLD_MS
): {
	onlineMachines: string[];
	unknownMachines: string[];
	idleMachines: string[];
	overrides: string[];
} {
	const activity = extractMachineActivity(dashboardContent);
	const overrides: string[] = [];

	const unknownMachines = [...heartbeatState.unknownMachines];
	const idleMachines = [...heartbeatState.idleMachines];
	const onlineMachines = [...heartbeatState.onlineMachines];

	const knownSet = new Set([
		...onlineMachines.map(m => m.toLowerCase()),
		...unknownMachines.map(m => m.toLowerCase()),
		...idleMachines.map(m => m.toLowerCase()),
	]);

	// Override existing UNKNOWN → ONLINE
	for (let i = unknownMachines.length - 1; i >= 0; i--) {
		const machineId = unknownMachines[i];
		const lastSeen = activity.get(machineId);
		if (lastSeen && isRecentlyActive(lastSeen, thresholdMs)) {
			unknownMachines.splice(i, 1);
			onlineMachines.push(machineId);
			overrides.push(machineId);
			logger.info(`Dashboard override: ${machineId} UNKNOWN->ONLINE (last seen ${lastSeen})`);
		}
	}

	// Override existing IDLE → ONLINE
	for (let i = idleMachines.length - 1; i >= 0; i--) {
		const machineId = idleMachines[i];
		const lastSeen = activity.get(machineId);
		if (lastSeen && isRecentlyActive(lastSeen, thresholdMs)) {
			idleMachines.splice(i, 1);
			onlineMachines.push(machineId);
			overrides.push(machineId);
			logger.info(`Dashboard override: ${machineId} IDLE->ONLINE (last seen ${lastSeen})`);
		}
	}

	// #1953 Phase 4: Add machines discovered from dashboard that aren't in any heartbeat list.
	// Each MCP server instance only tracks its own tool calls (ADR 008 in-memory model).
	// Other machines are discovered via shared dashboard messages on GDrive.
	for (const [machineId, lastSeen] of activity.entries()) {
		if (!knownSet.has(machineId.toLowerCase()) && isRecentlyActive(lastSeen, thresholdMs)) {
			onlineMachines.push(machineId);
			overrides.push(machineId);
			knownSet.add(machineId.toLowerCase());
			logger.info(`Dashboard discovery: ${machineId} added as ONLINE (last seen ${lastSeen})`);
		}
	}

	return { onlineMachines, unknownMachines, idleMachines, overrides };
}

/**
 * #3695: recover last-seen timestamps for machines whose every message was
 * archived out of the current dashboard files by auto-condensation.
 *
 * Archives preserve the exact `### [ts] machine|workspace` headers, but a
 * mature shared state carries thousands of them (8k+ files / 164 MB on the
 * prod mirror, 2026-09) — an eager full read per status call is not
 * affordable. This lookup scans archive files NEWEST FIRST (archive filenames
 * embed the condensation ISO date) and stops once every requested machine was
 * found, so a machine archived recently resolves in a handful of reads, and a
 * machine truly never seen still ends at the honest `null` of #3160 after a
 * full scan (the pathological case only — it means "verify your mirror").
 *
 * #4344: recovery must not be limited to machines missing from the live files.
 * ONE old live line used to freeze `lastSeen` while the machine kept posting —
 * newer messages were already condensed into `archive/` and never consulted.
 * Callers therefore pass `floors` (each machine's live timestamp). An archive
 * file can only carry messages older than its own condensation date, so a
 * machine whose best timestamp already reaches the current file's date is
 * resolved and dropped. That bounds the widening: no FILE is read while the
 * live values beat the newest archive, and the scan stops as soon as every
 * machine is resolved.
 *
 * Honest residuals (review ms#1532 + #4344 residual fix, 28/10):
 * - the archive DIRECTORY LISTING is now paid on every call (the guard went
 *   from "some machine missing from live" to "registry non-empty") — zero
 *   file read is not zero cost, only the cheapest possible probe;
 * - a machine PRESENT in live (has a floor) but appearing in NO archive is
 *   never resolved by the date rule: the date bound can only prove "nothing
 *   newer exists above the floor", it cannot prove "nothing anywhere below"
 *   without reading. Its walk is now cut at its OWN ceiling
 *   (MAX_ARCHIVE_READS_PER_MACHINE), not the per-call budget — one dead
 *   machine cannot tax the whole call — and it keeps its bounded best (the
 *   stale live floor, an honest lower bound #3160). A machine with NO live
 *   line, resolvable only by a hit, is concluded after
 *   MAX_ARCHIVE_READS_NO_FLOOR attempts (the typical #3695 recovery sits in
 *   the newest handful of files) — never unbounded G: seconds on a
 *   per-request path.
 *
 * Phantom headers: bodies quoting a `### [ts] machine|ws` line are escaped by
 * the writers (FIX #1123 live, #4344 archive) so the header regex below never
 * matches them. Archives written BEFORE the archive-side escape may still
 * carry unescaped quotes — that pre-existing exposure is amplified by this
 * widening (any registry machine, not just missing ones) and is also left to
 * the RX123 cap: the parser cannot tell a quoted header from a real one.
 *
 * #4344 residual "STALE par le code" (arbitration ai-01 28/10): a machine
 * whose CONCLUDED best (a past bounded walk's result, in the per-process
 * verdict cache) is older than STALE_MACHINE_MS pays ZERO reads here, until
 * the verdict is STALE_VERDICT_REVERIFY_MS old. The skip never triggers on a
 * stale live floor ALONE — only a concluded verdict can skip, so the founding
 * frozen-floor case (fresh truth in archives) keeps its walk. Platform-suffixed
 * ghosts (-win32-x64) whose host is in the same request are attached to it:
 * folded floor, headers credited to the host, host's result inherited, and
 * they never walk on their own.
 *
 * @param dashboardsDir - The dashboards/ directory (archive/ lives inside it).
 * @param machineIds - Machine IDs to look for (case-insensitive).
 * @param floors - Optional machineId (lowercase) -> live timestamp already
 *                 known: only an archived timestamp above it is worth a read.
 *                 Absent/empty means "recover from scratch" (#3695 behaviour).
 * @returns Map of machineId (lowercase) -> most recent ISO timestamp found in archives.
 */
export function lookupMachineActivityInArchives(
	dashboardsDir: string,
	machineIds: string[],
	floors?: ReadonlyMap<string, string>
): Map<string, string> {
	const requested = machineIds.map(m => m.toLowerCase());
	const wanted = new Set(requested);
	const found = new Map<string, string>();
	if (wanted.size === 0) return found;

	const now = Date.now();
	const walkFloors = new Map<string, string>(floors ?? []);

	// #4344 residual (arbitration 28/10): platform-suffixed ghosts are
	// ATTACHED TO THEIR HOST when the host is part of the same request — the
	// ghost never walks on its own (it was paying 25 attempts per call on the
	// prod mirror for a 52-day-old lastSeen). Its floor folds into the host's,
	// its archived headers credit the host, and it inherits the host's result.
	// A ghost whose host is NOT requested keeps walking alone (the host may
	// simply be outside this request's scope) and is then subject to the same
	// STALE verdict as any machine.
	const ghostToHost = new Map<string, string>();
	for (const id of [...wanted]) {
		const base = machineBaseId(id);
		if (base !== id && wanted.has(base)) {
			ghostToHost.set(id, base);
			wanted.delete(id);
			const ghostFloor = walkFloors.get(id);
			const hostFloor = walkFloors.get(base) ?? '';
			if (ghostFloor && ghostFloor > hostFloor) walkFloors.set(base, ghostFloor);
		}
	}

	// #4344 residual ("STALE par le code"): a machine whose CONCLUDED best
	// (past walk) is older than STALE_MACHINE_MS pays ZERO reads now, provided
	// the verdict is younger than STALE_VERDICT_REVERIFY_MS. Never skip on the
	// stale floor ALONE — the founding case of this issue was a frozen floor
	// with fresh truth sitting in the archives; only a concluded verdict can
	// skip, and a machine back live refreshes its floor past the threshold on
	// this very call (no skip, normal walk).
	const skipped = new Set<string>();
	for (const id of [...wanted]) {
		const verdict = machineVerdicts.get(id);
		if (!verdict) continue;
		const floor = walkFloors.get(id) ?? '';
		const best = verdict.best > floor ? verdict.best : floor;
		if (!best) continue;
		const age = now - new Date(best).getTime();
		if (age >= STALE_MACHINE_MS && now - verdict.concludedAt < STALE_VERDICT_REVERIFY_MS) {
			found.set(id, best);
			wanted.delete(id);
			// #1569: a skipped machine was NOT walked on this call. It must not
			// renew the very window that allows the skip, or the walk never
			// returns — `concludedAt` keeps the stamp of the walk that produced
			// this verdict (see recordVerdicts).
			skipped.add(id);
			logger.debug(
				`Archive lookup skipped ${id} (STALE verdict ${best}, re-verified in ${Math.round((STALE_VERDICT_REVERIFY_MS - (now - verdict.concludedAt)) / 60000)} min) - zero reads (#4344)`
			);
		}
	}
	if (wanted.size === 0) {
		emitGhostResults(ghostToHost, walkFloors, found);
		recordVerdicts(requested, ghostToHost, walkFloors, found, now, skipped);
		return found;
	}

	let archiveFiles: string[];
	try {
		archiveFiles = readdirSync(join(dashboardsDir, 'archive')).filter(f => f.endsWith('.md'));
	} catch {
		emitGhostResults(ghostToHost, walkFloors, found);
		recordVerdicts(requested, ghostToHost, walkFloors, found, now, skipped);
		return found; // no archive dir yet — nothing was ever condensed
	}

	// Newest first: the machine being looked for was usually archived recently.
	// Some legacy names embed several dates (e.g. `...-pre-delete-<iso>`) — take
	// the max so the sort key is always the most recent date in the name.
	const dateOf = (name: string): string => {
		let latest = '';
		for (const m of name.matchAll(/(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})/g)) {
			if (m[1] > latest) latest = m[1];
		}
		return latest;
	};
	archiveFiles.sort((a, b) => dateOf(b).localeCompare(dateOf(a)));

	// Archive names embed the ISO condensation date with `:` replaced by `-`.
	const isoOf = (name: string): string => {
		const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})$/.exec(dateOf(name));
		return m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}Z` : '';
	};

	let filesRead = 0;
	// #4344 residual (dispatch 28/10): the budget is bounded PER MACHINE. A
	// single dead machine (stale floor, ~1 900 archives newer than it) used to
	// consume the whole per-call budget on every health call (~11.7 s measured),
	// and a machine with NO live line — resolvable only by a hit, since the
	// date rule needs a `best` — paid the entire budget before the honest
	// #3160 null (108 s measured). Each machine now gets its own attempt
	// ceiling: MAX_ARCHIVE_READS_PER_MACHINE when it carries a live floor,
	// MAX_ARCHIVE_READS_NO_FLOOR when it does not (the typical #3695 recovery
	// sits in the newest handful of files). Attempts count (ms#1532 r3), so an
	// unreadable G: cannot re-arm a machine's walk either. A dropped machine
	// keeps its bounded best; the walk continues for the others.
	const attemptsPerMachine = new Map<string, number>();
	const machineBudget = (machineId: string): number =>
		walkFloors.get(machineId) ? MAX_ARCHIVE_READS_PER_MACHINE : MAX_ARCHIVE_READS_NO_FLOOR;

	for (const file of archiveFiles) {
		if (wanted.size === 0) break;

		// #4344: an archive file carries only messages older than its own
		// condensation date. Resolve (and stop tracking) every machine whose
		// best timestamp — live floor or already-found — reaches that date.
		const fileIso = isoOf(file);
		if (fileIso) {
			for (const machineId of [...wanted]) {
				const floor = walkFloors.get(machineId) ?? '';
				const best = (found.get(machineId) ?? '') > floor ? found.get(machineId)! : floor;
				if (best && best >= fileIso) wanted.delete(machineId);
			}
			if (wanted.size === 0) break;
		}

		// #4344 re-review (ms#1532): per-call read ceiling, default behaviour.
		// Newest-first, so hitting it only drops the OLDEST tail (see
		// MAX_ARCHIVE_READS_PER_CALL).
		if (filesRead >= MAX_ARCHIVE_READS_PER_CALL) {
			logger.warn(
				`Archive lookup hit its read budget (${MAX_ARCHIVE_READS_PER_CALL} files) with ${wanted.size} machine(s) unresolved - keeping their bounded best (#4344, cf. #4131)`
			);
			break;
		}

		// #4344 residual: spend this attempt on every still-wanted machine and
		// drop each one whose OWN ceiling is exhausted — before the fold, so a
		// dropped machine cannot benefit from the read that dropped it.
		for (const machineId of [...wanted]) {
			const spent = (attemptsPerMachine.get(machineId) ?? 0) + 1;
			attemptsPerMachine.set(machineId, spent);
			const budget = machineBudget(machineId);
			if (spent > budget) {
				wanted.delete(machineId);
				logger.warn(
					`Archive lookup exhausted the per-machine read budget (${budget} files) for ${machineId} - keeping its bounded best (#4344)`
				);
			}
		}
		if (wanted.size === 0) break;

		// Count the ATTEMPT, not the successful read (ms#1532 r3). A throwing
		// read — unstable G:, the very failure mode the budget exists for
		// (#4131) — must consume one attempt: counting only successes left
		// `filesRead` at 0 while every failure `continue`d, so an unreadable
		// archive directory re-armed the full ~12.7k-open walk on every call.
		filesRead++;
		let content: string;
		try {
			content = readFileSync(join(dashboardsDir, 'archive', file), 'utf-8');
		} catch {
			continue;
		}
		for (const [headerId, ts] of extractMachineActivity(content)) {
			// #4344 residual: a ghost's archived headers credit its host.
			const machineId = ghostToHost.get(headerId) ?? headerId;
			if (!wanted.has(machineId)) continue;
			const existing = found.get(machineId);
			if (!existing || ts > existing) found.set(machineId, ts);
		}
	}

	emitGhostResults(ghostToHost, walkFloors, found);
	recordVerdicts(requested, ghostToHost, walkFloors, found, now, skipped);
	return found;
}

/** #4344 residual: a ghost inherits its host's resolved best (attach). */
function emitGhostResults(
	ghostToHost: ReadonlyMap<string, string>,
	floors: ReadonlyMap<string, string>,
	found: Map<string, string>
): void {
	for (const [ghost, host] of ghostToHost) {
		const hostBest = found.get(host) ?? floors.get(host) ?? '';
		if (hostBest) found.set(ghost, hostBest);
	}
}

/**
 * #4344 residual: record each requested machine's concluded best as a verdict.
 * Fresh machines get a verdict too — harmless, the STALE skip only triggers
 * on a best older than the threshold; recording it means a machine that goes
 * quiet starts skipping reads 24h after its best crossed the threshold,
 * without any first-call tax change.
 *
 * #1569: `skipped` carries the machines the STALE gate served from the cache
 * instead of walking them. Those were NOT re-verified on this call, so their
 * `concludedAt` must keep the stamp of the walk that produced the verdict —
 * refreshing it here renewed the 24h window on every call, so the walk could
 * never come back and the archives were never re-read.
 */
function recordVerdicts(
	requested: readonly string[],
	ghostToHost: ReadonlyMap<string, string>,
	floors: ReadonlyMap<string, string>,
	found: ReadonlyMap<string, string>,
	now: number,
	skipped: ReadonlySet<string>
): void {
	for (const id of requested) {
		if (ghostToHost.has(id)) continue; // attached ghosts never walk, never verdict
		const floor = floors.get(id) ?? '';
		const hit = found.get(id) ?? '';
		const best = hit > floor ? hit : floor;
		if (!best) continue; // honest #3160 null — nothing to conclude
		const previous = machineVerdicts.get(id);
		const skippedThisCall = skipped.has(id);
		if (!previous || best > previous.best) {
			// A skipped machine's `best` came from the cache (or a stale floor),
			// not from a walk: record the improved best but keep the walk stamp,
			// so the next call is free to verify it.
			machineVerdicts.set(id, {
				best,
				concludedAt: skippedThisCall && previous ? previous.concludedAt : now,
			});
		} else if (!skippedThisCall) {
			previous.concludedAt = now; // same best re-concluded: refresh the re-verify window
		}
	}
}
