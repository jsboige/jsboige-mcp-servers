/**
 * Tests for dashboard-derived machine status utility (#1953, #2016)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { extractMachineActivity, isRecentlyActive, crossCheckWithDashboard, renderDashboardActivityMarkdown, lookupMachineActivityInArchives, DEFAULT_ACTIVITY_THRESHOLD_MS, MAX_ARCHIVE_READS_PER_CALL, MAX_ARCHIVE_READS_PER_MACHINE, MAX_ARCHIVE_READS_NO_FLOOR } from '../dashboard-activity.js';

describe('dashboard-activity', () => {
	describe('extractMachineActivity', () => {
		it('should extract machine activity from valid dashboard content', () => {
			const content = [
				'### [2026-05-03T20:08:15.436Z] myia-po-2024|roo-extensions',
				'Some message content',
				'### [2026-05-03T20:10:00.000Z] myia-po-2023|roo-extensions',
				'Another message',
			].join('\n');

			const activity = extractMachineActivity(content);
			expect(activity.size).toBe(2);
			expect(activity.get('myia-po-2024')).toBe('2026-05-03T20:08:15.436Z');
			expect(activity.get('myia-po-2023')).toBe('2026-05-03T20:10:00.000Z');
		});

		it('should keep the most recent timestamp per machine', () => {
			const content = [
				'### [2026-05-03T18:00:00.000Z] myia-po-2024|roo-extensions',
				'Old message',
				'### [2026-05-03T20:00:00.000Z] myia-po-2024|roo-extensions',
				'New message',
			].join('\n');

			const activity = extractMachineActivity(content);
			expect(activity.get('myia-po-2024')).toBe('2026-05-03T20:00:00.000Z');
		});

		it('should ignore non-myia machines', () => {
			const content = [
				'### [2026-05-03T20:00:00.000Z] test-machine|roo-extensions',
				'### [2026-05-03T20:00:00.000Z] some-other|roo-extensions',
			].join('\n');

			const activity = extractMachineActivity(content);
			expect(activity.size).toBe(0);
		});

		it('should return empty map for empty content', () => {
			expect(extractMachineActivity('').size).toBe(0);
			expect(extractMachineActivity('no matching content').size).toBe(0);
		});

		it('should aggregate activity across multiple dashboards (#2016)', () => {
			const wsRooExt = '### [2026-05-03T18:00:00.000Z] myia-po-2024|roo-extensions\nOld';
			const wsCoursIA = '### [2026-05-03T20:00:00.000Z] myia-po-2024|coursia\nNew';

			const activity = extractMachineActivity([wsRooExt, wsCoursIA]);
			expect(activity.get('myia-po-2024')).toBe('2026-05-03T20:00:00.000Z');
		});

		it('should merge distinct machines from multiple dashboards (#2016)', () => {
			const wsA = '### [2026-05-03T20:00:00.000Z] myia-po-2024|workspace-a';
			const wsB = '### [2026-05-03T20:01:00.000Z] myia-web1|workspace-b';

			const activity = extractMachineActivity([wsA, wsB]);
			expect(activity.size).toBe(2);
			expect(activity.get('myia-po-2024')).toBe('2026-05-03T20:00:00.000Z');
			expect(activity.get('myia-web1')).toBe('2026-05-03T20:01:00.000Z');
		});
	});

	describe('lookupMachineActivityInArchives + floors (#4344)', () => {
		let tmpDir: string;
		let dashboardsDir: string;
		let archiveDir: string;

		const archive = (name: string, body: string) =>
			writeFileSync(join(archiveDir, name), body, 'utf-8');

		beforeEach(() => {
			tmpDir = mkdtempSync(join(tmpdir(), 'archives-4344-'));
			dashboardsDir = join(tmpDir, 'dashboards');
			archiveDir = join(dashboardsDir, 'archive');
			mkdirSync(archiveDir, { recursive: true });
		});

		afterEach(() => {
			rmSync(tmpDir, { recursive: true, force: true });
		});

		it('recovers a machine whose every message was archived (regression #3695, no floor)', () => {
			archive('workspace-ws-2026-09-10T10-00-00.md', '### [2026-09-10T09:00:00.000Z] myia-silent-01|ws\nmsg');
			const found = lookupMachineActivityInArchives(dashboardsDir, ['myia-silent-01']);
			expect(found.get('myia-silent-01')).toBe('2026-09-10T09:00:00.000Z');
		});

		it('beats a stale live lastSeen when a newer message sits in an archive (#4344)', () => {
			// The live dashboard still carries one old line (20/10 19:17Z) — the
			// exact web2 shape; newer [DONE]s were condensed away.
			archive('workspace-ws-2026-10-26T21-07-47.md', '### [2026-10-26T20:30:00.000Z] myia-web2|roo-extensions\nDONE');
			const floors = new Map([['myia-web2', '2026-10-20T19:17:13.000Z']]);

			const found = lookupMachineActivityInArchives(dashboardsDir, ['myia-web2'], floors);

			expect(found.get('myia-web2')).toBe('2026-10-26T20:30:00.000Z');
		});

		it('reads nothing when the live timestamp already beats the newest archive', () => {
			archive('workspace-ws-2026-09-10T10-00-00.md', '### [2026-09-10T09:00:00.000Z] myia-web2|ws\nold');
			const floors = new Map([['myia-web2', '2026-10-27T08:00:00.000Z']]);

			expect(lookupMachineActivityInArchives(dashboardsDir, ['myia-web2'], floors).size).toBe(0);
		});

		it('does not look below the floor: an older archive cannot improve the live value', () => {
			archive('workspace-ws-2026-10-20T18-00-00.md', '### [2026-10-20T17:00:00.000Z] myia-web2|ws\nolder than live');
			archive('workspace-ws-2026-10-26T21-00-00.md', '### [2026-10-26T20:00:00.000Z] myia-other-01|ws\nother machine');
			const floors = new Map([['myia-web2', '2026-10-20T19:17:13.000Z']]);

			const found = lookupMachineActivityInArchives(dashboardsDir, ['myia-web2'], floors);

			expect(found.has('myia-web2')).toBe(false);
		});

		it('keeps scanning while an older file can still beat the best found so far', () => {
			// Newest file carries an OLD message for the machine; the next one
			// carries a newer one — a first-hit-wins scan would under-report.
			archive('workspace-ws-2026-10-27T06-00-00.md', '### [2026-10-21T08:00:00.000Z] myia-web2|ws\nlate-archived old msg');
			archive('workspace-ws-2026-10-26T20-00-00.md', '### [2026-10-26T19:00:00.000Z] myia-web2|ws\nreal newest');
			const floors = new Map([['myia-web2', '2026-10-20T19:17:13.000Z']]);

			const found = lookupMachineActivityInArchives(dashboardsDir, ['myia-web2'], floors);

			expect(found.get('myia-web2')).toBe('2026-10-26T19:00:00.000Z');
		});

		it('#4344 — a quoted header ESCAPED by the archive writer is not parsed as activity (no phantom)', () => {
			// Post-fix shape: the body quotes a dashboard line, the writer
			// escapes it (FIX #1123 idiom, extended to archives by ms#1532).
			// The quoted machine (po-2026, silent, stale floor) must NOT be
			// resurrected by the quote — the mirror image of the #4344 freeze.
			archive(
				'workspace-ws-2026-10-26T21-00-00.md',
				'### [2026-10-26T20:00:00.000Z] myia-web2|roo-extensions\n' +
					'[msg: msg-quote-1]\n\n' +
					'incident report, citing:\n' +
					'\\#\\#\\# [2026-10-26T20:45:00.000Z] myia-po-2026|CoursIA\n' +
					'end of quote.'
			);
			const floors = new Map([['myia-po-2026', '2026-10-01T00:00:00.000Z']]);

			const found = lookupMachineActivityInArchives(dashboardsDir, ['myia-po-2026'], floors);

			expect(found.has('myia-po-2026')).toBe(false);
		});

		it('#4344 — legacy archive with an UNESCAPED quoted header still yields the phantom (documented exposure)', () => {
			// Pre-fix archives (written before the archive-side escape) keep
			// raw quoted headers; the parser cannot tell a quote from a real
			// header. This pins TODAY'S honest behaviour on legacy files: the
			// phantom IS attributed — the reason the writers escape, and the
			// residual the future RX123 archive cap owns (see the util's doc).
			archive(
				'workspace-ws-2026-10-26T21-00-00.md',
				'### [2026-10-26T20:00:00.000Z] myia-web2|roo-extensions\n' +
					'[msg: msg-quote-2]\n\n' +
					'incident report, citing:\n' +
					'### [2026-10-26T20:45:00.000Z] myia-po-2026|CoursIA\n' +
					'end of quote.'
			);
			const floors = new Map([['myia-po-2026', '2026-10-01T00:00:00.000Z']]);

			const found = lookupMachineActivityInArchives(dashboardsDir, ['myia-po-2026'], floors);

			expect(found.get('myia-po-2026')).toBe('2026-10-26T20:45:00.000Z');
		});

		it('#4344 re-review — per-call read bound: realistic mirror, machine beyond the budget is NOT recovered', () => {
			// Shape measured on the prod mirror (ms#1532 re-review): thousands
			// of archives, one machine with a weeks-old floor whose only
			// message sits DEEP (position ~bound+2300 by newness) — it would
			// be found by an unbounded walk (1,915 reads / ~65 s measured on
			// po-2026). The default budget must cut the walk long before:
			// the deep machine keeps its stale floor (not found), while a
			// machine in the newest files is still recovered.
			const N = MAX_ARCHIVE_READS_PER_CALL;
			const total = N + 2_300;
			const base = Date.parse('2026-10-27T00:00:00Z');
			const condenseAt = (i: number) => new Date(base - i * 61_000);
			const nameOf = (i: number) =>
				`workspace-ws-${condenseAt(i).toISOString().slice(0, 19).replace(/:/g, '-')}.md`;
			for (let i = 0; i < total; i++) {
				if (i === 2) {
					// Third-newest file: the typical #4344 recovery.
					const ts = new Date(condenseAt(i).getTime() - 60_000).toISOString();
					archive(nameOf(i), `### [${ts}] myia-fresh-01|ws\njust condensed [DONE]`);
				} else if (i === N + 2_300 - 1) {
					// Oldest file: deep machine's only message (newer than its
					// weeks-old floor, older than its file's condensation date).
					const ts = new Date(condenseAt(i).getTime() - 60_000).toISOString();
					archive(nameOf(i), `### [${ts}] myia-deep-01|ws\nlast message before weeks of silence`);
				} else {
					archive(nameOf(i), 'condensed bodies, no machine headers');
				}
			}
			const floors = new Map([['myia-deep-01', '2026-09-01T00:00:00.000Z']]);

			const found = lookupMachineActivityInArchives(dashboardsDir, ['myia-deep-01', 'myia-fresh-01'], floors);

			// Inside the budget: recovered.
			const freshTs = new Date(condenseAt(2).getTime() - 60_000).toISOString();
			expect(found.get('myia-fresh-01')).toBe(freshTs);
			// Beyond the budget: the walk stopped, the stale floor stands.
			expect(found.has('myia-deep-01')).toBe(false);
		});

		it('#4344 residual — the walk reads UP TO the MACHINE ceiling: a message just inside is found', () => {
			// Re-pinned 28/10 (dispatch ai-01): the binding ceiling for a
			// floor-carrying machine is now MAX_ARCHIVE_READS_PER_MACHINE, not
			// MAX_ARCHIVE_READS_PER_CALL — one dead machine must not tax the
			// whole call (measured ~11.7 s/health call on myia-po-2026). The
			// original ms#1532 intent (the walk reads up to the ceiling, not
			// less) is preserved at the new boundary.
			const M = MAX_ARCHIVE_READS_PER_MACHINE;
			const total = M + 500;
			const base = Date.parse('2026-10-27T00:00:00Z');
			const condenseAt = (i: number) => new Date(base - i * 61_000);
			const nameOf = (i: number) =>
				`workspace-ws-${condenseAt(i).toISOString().slice(0, 19).replace(/:/g, '-')}.md`;
			const insideIdx = M - 10;
			const deepTs = new Date(condenseAt(insideIdx).getTime() - 60_000).toISOString();
			for (let i = 0; i < total; i++) {
				if (i === insideIdx) {
					archive(nameOf(i), `### [${deepTs}] myia-deep-01|ws\njust inside the budget`);
				} else {
					archive(nameOf(i), 'condensed bodies, no machine headers');
				}
			}
			const floors = new Map([['myia-deep-01', '2026-09-01T00:00:00.000Z']]);

			const found = lookupMachineActivityInArchives(dashboardsDir, ['myia-deep-01'], floors);

			expect(found.get('myia-deep-01')).toBe(deepTs);
		});

		it('#4344 re-review r3 — the budget counts ATTEMPTS: 2 500 unreadable entries stop the walk at 200', () => {
			// ms#1532 r3: a throwing read used to `continue` BEFORE filesRead++,
			// so an unreadable archive directory (unstable G:, #4131) left the
			// counter at 0 and walked all ~12.7k entries on every call. Shape
			// here: entries that LOOK like archives but are directories, so
			// readFileSync throws EISDIR; a REAL file carrying the machine's
			// message sits at position 201. With attempts counted, the budget
			// is exhausted by the 200 unreadable entries and that file is never
			// opened; if only successes were counted, the walk would sail past
			// all of them and find the message.
			const N = MAX_ARCHIVE_READS_PER_CALL;
			const total = 2_500;
			const base = Date.parse('2026-10-27T00:00:00Z');
			const condenseAt = (i: number) => new Date(base - i * 61_000);
			const nameOf = (i: number) =>
				`workspace-ws-${condenseAt(i).toISOString().slice(0, 19).replace(/:/g, '-')}.md`;
			const deepTs = new Date(condenseAt(N).getTime() - 60_000).toISOString();
			for (let i = 0; i < total; i++) {
				if (i === N) {
					// 201st entry: a readable archive that WOULD resolve the machine.
					archive(nameOf(i), `### [${deepTs}] myia-unreachable-01|ws\nafter the budget`);
				} else {
					// Unreadable: a directory where an archive file is expected.
					mkdirSync(join(archiveDir, nameOf(i)));
				}
			}
			const floors = new Map([['myia-unreachable-01', '2026-09-01T00:00:00.000Z']]);

			const found = lookupMachineActivityInArchives(dashboardsDir, ['myia-unreachable-01'], floors);

			// The 201st attempt never happens: attempts — not successes — exhausted the budget.
			expect(found.has('myia-unreachable-01')).toBe(false);
		});

		it('#4344 residual — per-machine budget: a floor-carrying machine is dropped at its OWN ceiling', () => {
			// myia-po-2026 shape (po-2027 cost verdict, 28/10): floor 09/10,
			// dead since — every archive is NEWER than the floor, so the date
			// rule can never resolve it, and under the per-call-only budget it
			// burned the full 200 reads (~11.7 s) on EVERY health call. The
			// walk now drops it at MAX_ARCHIVE_READS_PER_MACHINE attempts: a
			// message at position M+10 — inside the per-call budget, beyond
			// the machine's own — is not chased.
			const M = MAX_ARCHIVE_READS_PER_MACHINE;
			const total = M + 500;
			const base = Date.parse('2026-10-27T00:00:00Z');
			const condenseAt = (i: number) => new Date(base - i * 61_000);
			const nameOf = (i: number) =>
				`workspace-ws-${condenseAt(i).toISOString().slice(0, 19).replace(/:/g, '-')}.md`;
			const hitIdx = M + 10;
			const lateTs = new Date(condenseAt(hitIdx).getTime() - 60_000).toISOString();
			for (let i = 0; i < total; i++) {
				if (i === hitIdx) {
					archive(nameOf(i), `### [${lateTs}] myia-late-01|ws\nmessage beyond the machine ceiling`);
				} else {
					archive(nameOf(i), 'condensed bodies, no machine headers');
				}
			}
			const floors = new Map([['myia-late-01', '2026-09-01T00:00:00.000Z']]);

			const found = lookupMachineActivityInArchives(dashboardsDir, ['myia-late-01'], floors);

			expect(found.has('myia-late-01')).toBe(false);
		});

		it('#4344 residual — per-machine budget: a message just inside the machine ceiling is still found', () => {
			// Companion boundary: the machine keeps the full benefit of its
			// own 50 attempts — a hit 5 files inside the ceiling resolves it.
			const M = MAX_ARCHIVE_READS_PER_MACHINE;
			const total = M + 500;
			const base = Date.parse('2026-10-27T00:00:00Z');
			const condenseAt = (i: number) => new Date(base - i * 61_000);
			const nameOf = (i: number) =>
				`workspace-ws-${condenseAt(i).toISOString().slice(0, 19).replace(/:/g, '-')}.md`;
			const hitIdx = M - 5;
			const lateTs = new Date(condenseAt(hitIdx).getTime() - 60_000).toISOString();
			for (let i = 0; i < total; i++) {
				if (i === hitIdx) {
					archive(nameOf(i), `### [${lateTs}] myia-late-01|ws\nmessage inside the machine ceiling`);
				} else {
					archive(nameOf(i), 'condensed bodies, no machine headers');
				}
			}
			const floors = new Map([['myia-late-01', '2026-09-01T00:00:00.000Z']]);

			const found = lookupMachineActivityInArchives(dashboardsDir, ['myia-late-01'], floors);

			expect(found.get('myia-late-01')).toBe(lateTs);
		});

		it('#4344 residual — no live line: concluded fast, without waiting for the call budget', () => {
			// A machine absent from every live file can ONLY be resolved by a
			// hit (the date rule needs a best, which is empty). Under the
			// per-call-only budget it walked all 200 files before the honest
			// #3160 null — 108 s measured (po-2027 verdict). It now gets
			// MAX_ARCHIVE_READS_NO_FLOOR newest-first attempts — the typical
			// #3695 recovery sits in the newest handful of files — and is
			// concluded beyond that.
			const F = MAX_ARCHIVE_READS_NO_FLOOR;
			const total = 100;
			const base = Date.parse('2026-10-27T00:00:00Z');
			const condenseAt = (i: number) => new Date(base - i * 61_000);
			const nameOf = (i: number) =>
				`workspace-ws-${condenseAt(i).toISOString().slice(0, 19).replace(/:/g, '-')}.md`;
			const hitIdx = F + 5;
			const absentTs = new Date(condenseAt(hitIdx).getTime() - 60_000).toISOString();
			for (let i = 0; i < total; i++) {
				if (i === hitIdx) {
					archive(nameOf(i), `### [${absentTs}] myia-absent-01|ws\nburied too deep for a no-floor lookup`);
				} else {
					archive(nameOf(i), 'condensed bodies, no machine headers');
				}
			}

			const found = lookupMachineActivityInArchives(dashboardsDir, ['myia-absent-01']);

			expect(found.has('myia-absent-01')).toBe(false);
		});

		it('#4344 residual — no live line: the #3695 recovery near the head is unaffected', () => {
			// Companion boundary: a fully-archived machine whose newest
			// message sits a handful of files deep is still recovered — the
			// no-floor budget must not regress #3695's use case.
			const F = MAX_ARCHIVE_READS_NO_FLOOR;
			const total = 100;
			const base = Date.parse('2026-10-27T00:00:00Z');
			const condenseAt = (i: number) => new Date(base - i * 61_000);
			const nameOf = (i: number) =>
				`workspace-ws-${condenseAt(i).toISOString().slice(0, 19).replace(/:/g, '-')}.md`;
			const hitIdx = F - 5;
			const silentTs = new Date(condenseAt(hitIdx).getTime() - 60_000).toISOString();
			for (let i = 0; i < total; i++) {
				if (i === hitIdx) {
					archive(nameOf(i), `### [${silentTs}] myia-silent-01|ws\njust condensed [DONE]`);
				} else {
					archive(nameOf(i), 'condensed bodies, no machine headers');
				}
			}

			const found = lookupMachineActivityInArchives(dashboardsDir, ['myia-silent-01']);

			expect(found.get('myia-silent-01')).toBe(silentTs);
		});

		it('#4344 residual — one dead machine hitting its ceiling does not take the others down', () => {
			// DEAD (floor-carrying, never present) exhausts its per-machine
			// budget mid-walk; FRESH (no floor, hit at position 3) must still
			// be recovered — a per-machine drop is not a global abort.
			const total = 100;
			const base = Date.parse('2026-10-27T00:00:00Z');
			const condenseAt = (i: number) => new Date(base - i * 61_000);
			const nameOf = (i: number) =>
				`workspace-ws-${condenseAt(i).toISOString().slice(0, 19).replace(/:/g, '-')}.md`;
			const freshTs = new Date(condenseAt(3).getTime() - 60_000).toISOString();
			for (let i = 0; i < total; i++) {
				if (i === 3) {
					archive(nameOf(i), `### [${freshTs}] myia-fresh-01|ws\njust condensed [DONE]`);
				} else {
					archive(nameOf(i), 'condensed bodies, no machine headers');
				}
			}
			const floors = new Map([['myia-dead-01', '2026-09-01T00:00:00.000Z']]);

			const found = lookupMachineActivityInArchives(dashboardsDir, ['myia-dead-01', 'myia-fresh-01'], floors);

			expect(found.get('myia-fresh-01')).toBe(freshTs);
			expect(found.has('myia-dead-01')).toBe(false);
		});

		it('buildArchiveFloors equivalent: only machines with a live value get a floor', () => {
			const floors = new Map<string, string>();
			const activity = new Map([['myia-web2', '2026-10-20T19:17:13.000Z']]);
			for (const mid of ['myia-web2', 'myia-silent-01']) {
				const live = activity.get(mid.toLowerCase());
				if (live) floors.set(mid.toLowerCase(), live);
			}
			expect(floors.get('myia-web2')).toBe('2026-10-20T19:17:13.000Z');
			expect(floors.has('myia-silent-01')).toBe(false);
		});
	});

	describe('isRecentlyActive', () => {
		beforeEach(() => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date('2026-05-03T20:00:00Z'));
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it('should return true for recent timestamp', () => {
			expect(isRecentlyActive('2026-05-03T19:30:00Z')).toBe(true);
		});

		it('should return true within the new 8h default threshold (#2016)', () => {
			expect(isRecentlyActive('2026-05-03T18:00:00Z')).toBe(true);
		});

		it('should return false beyond the 8h default threshold', () => {
			expect(isRecentlyActive('2026-05-03T10:00:00Z')).toBe(false);
		});

		it('should respect custom threshold', () => {
			expect(isRecentlyActive('2026-05-03T10:00:00Z', 12 * 60 * 60 * 1000)).toBe(true);
		});

		it('should return false for invalid timestamp', () => {
			expect(isRecentlyActive('invalid')).toBe(false);
		});

		it('should expose default threshold as 8h', () => {
			expect(DEFAULT_ACTIVITY_THRESHOLD_MS).toBe(8 * 60 * 60 * 1000);
		});
	});

	describe('crossCheckWithDashboard', () => {
		beforeEach(() => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date('2026-05-03T20:00:00Z'));
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it('should override UNKNOWN to ONLINE when dashboard shows recent activity', () => {
			const heartbeatState = {
				onlineMachines: ['myia-po-2023'],
				unknownMachines: ['myia-po-2024'],
				idleMachines: [],
			};
			const dashboardContent = '### [2026-05-03T19:30:00Z] myia-po-2024|roo-extensions\nRecent message';

			const result = crossCheckWithDashboard(heartbeatState, dashboardContent);
			expect(result.onlineMachines).toContain('myia-po-2024');
			expect(result.unknownMachines).not.toContain('myia-po-2024');
			expect(result.overrides).toContain('myia-po-2024');
		});

		it('should override IDLE to ONLINE when dashboard shows recent activity', () => {
			const heartbeatState = {
				onlineMachines: [],
				unknownMachines: [],
				idleMachines: ['myia-web1'],
			};
			const dashboardContent = '### [2026-05-03T19:45:00Z] myia-web1|roo-extensions\nRecent message';

			const result = crossCheckWithDashboard(heartbeatState, dashboardContent);
			expect(result.onlineMachines).toContain('myia-web1');
			expect(result.idleMachines).not.toContain('myia-web1');
			expect(result.overrides).toContain('myia-web1');
		});

		it('should NOT override when dashboard activity is older than threshold', () => {
			const heartbeatState = {
				onlineMachines: [],
				unknownMachines: ['myia-po-2025'],
				idleMachines: [],
			};
			const dashboardContent = '### [2026-05-03T08:00:00Z] myia-po-2025|roo-extensions\nOld message';

			const result = crossCheckWithDashboard(heartbeatState, dashboardContent);
			expect(result.unknownMachines).toContain('myia-po-2025');
			expect(result.overrides).toHaveLength(0);
		});

		it('should override using activity from any of multiple dashboards (#2016)', () => {
			const heartbeatState = {
				onlineMachines: [],
				unknownMachines: ['myia-po-2024'],
				idleMachines: [],
			};
			const dashboards = [
				'### [2026-05-03T05:00:00Z] myia-po-2024|roo-extensions\nStale',
				'### [2026-05-03T19:30:00Z] myia-po-2024|coursia\nRecent',
			];

			const result = crossCheckWithDashboard(heartbeatState, dashboards);
			expect(result.onlineMachines).toContain('myia-po-2024');
			expect(result.unknownMachines).not.toContain('myia-po-2024');
			expect(result.overrides).toContain('myia-po-2024');
		});

		it('should handle multiple overrides', () => {
			const heartbeatState = {
				onlineMachines: [],
				unknownMachines: ['myia-po-2024', 'myia-po-2025'],
				idleMachines: ['myia-web1'],
			};
			const dashboardContent = [
				'### [2026-05-03T19:50:00Z] myia-po-2024|roo-extensions',
				'Message 1',
				'### [2026-05-03T19:55:00Z] myia-po-2025|roo-extensions',
				'Message 2',
				'### [2026-05-03T19:40:00Z] myia-web1|roo-extensions',
				'Message 3',
			].join('\n');

			const result = crossCheckWithDashboard(heartbeatState, dashboardContent);
			expect(result.onlineMachines).toHaveLength(3);
			expect(result.overrides).toHaveLength(3);
		});

		it('should not modify already online machines', () => {
			const heartbeatState = {
				onlineMachines: ['myia-ai-01'],
				unknownMachines: [],
				idleMachines: [],
			};
			const dashboardContent = '### [2026-05-03T19:50:00Z] myia-ai-01|roo-extensions\nMessage';

			const result = crossCheckWithDashboard(heartbeatState, dashboardContent);
			expect(result.overrides).toHaveLength(0);
			expect(result.onlineMachines).toEqual(['myia-ai-01']);
		});

		it('should ADD machines from dashboard that are not in any heartbeat list (#1953 Phase 4)', () => {
			// ADR 008 in-memory model: each MCP server only sees its own tool calls.
			// Other machines are discovered via shared dashboard messages.
			const heartbeatState = {
				onlineMachines: ['myia-po-2026'],
				unknownMachines: [],
				idleMachines: [],
			};
			const dashboardContent = [
				'### [2026-05-03T19:50:00Z] myia-po-2023|roo-extensions',
				'Active machine not in heartbeat map',
				'### [2026-05-03T19:55:00Z] myia-web1|roo-extensions',
				'Another active machine',
			].join('\n');

			const result = crossCheckWithDashboard(heartbeatState, dashboardContent);
			expect(result.onlineMachines).toContain('myia-po-2026'); // self stays
			expect(result.onlineMachines).toContain('myia-po-2023'); // discovered
			expect(result.onlineMachines).toContain('myia-web1'); // discovered
			expect(result.overrides).toContain('myia-po-2023');
			expect(result.overrides).toContain('myia-web1');
		});

		it('should NOT add dashboard machines with stale activity', () => {
			const heartbeatState = {
				onlineMachines: ['myia-po-2026'],
				unknownMachines: [],
				idleMachines: [],
			};
			const dashboardContent = '### [2026-05-03T08:00:00Z] myia-po-2023|roo-extensions\nOld message';

			const result = crossCheckWithDashboard(heartbeatState, dashboardContent);
			expect(result.onlineMachines).toEqual(['myia-po-2026']);
			expect(result.overrides).toHaveLength(0);
		});

		it('should handle mixed scenario: override existing + discover new', () => {
			const heartbeatState = {
				onlineMachines: ['myia-po-2026'],
				unknownMachines: ['myia-po-2024'],
				idleMachines: [],
			};
			const dashboardContent = [
				'### [2026-05-03T19:50:00Z] myia-po-2023|roo-extensions',
				'Discovered machine',
				'### [2026-05-03T19:55:00Z] myia-po-2024|roo-extensions',
				'Override UNKNOWN',
			].join('\n');

			const result = crossCheckWithDashboard(heartbeatState, dashboardContent);
			expect(result.onlineMachines).toContain('myia-po-2026'); // original
			expect(result.onlineMachines).toContain('myia-po-2023'); // discovered
			expect(result.onlineMachines).toContain('myia-po-2024'); // overridden
			expect(result.unknownMachines).toHaveLength(0);
			expect(result.overrides).toHaveLength(2);
		});
	});

	describe('renderDashboardActivityMarkdown (#4131 G-B lot 2 B4)', () => {
		it('should render headers extractMachineActivity parses identically to a file', () => {
			const dashboard = {
				status: { markdown: '# Status section\nsome status text' },
				intercom: {
					messages: [
						{
							timestamp: '2026-10-14T18:22:31.000Z',
							content: 'Cycle done',
							author: { machineId: 'myia-po-2024', workspace: 'CoursIA' },
						},
						{
							timestamp: '2026-10-14T18:25:02.500Z',
							content: 'Ack',
							author: { machineId: 'myia-po-2025', workspace: 'CoursIA-2' },
						},
					],
				},
			};

			const rendered = renderDashboardActivityMarkdown(dashboard);
			const activity = extractMachineActivity(rendered);

			expect(activity.size).toBe(2);
			expect(activity.get('myia-po-2024')).toBe('2026-10-14T18:22:31.000Z');
			expect(activity.get('myia-po-2025')).toBe('2026-10-14T18:25:02.500Z');
		});

		it('should keep the most recent timestamp per machine across dashboards', () => {
			const older = {
				status: { markdown: '' },
				intercom: { messages: [{ timestamp: '2026-10-13T08:00:00.000Z', content: 'x', author: { machineId: 'myia-ai-01', workspace: 'CoursIA' } }] },
			};
			const newer = {
				status: { markdown: '' },
				intercom: { messages: [{ timestamp: '2026-10-14T09:30:00.000Z', content: 'y', author: { machineId: 'myia-ai-01', workspace: 'roo-extensions' } }] },
			};

			const activity = extractMachineActivity([
				renderDashboardActivityMarkdown(older),
				renderDashboardActivityMarkdown(newer),
			]);

			expect(activity.get('myia-ai-01')).toBe('2026-10-14T09:30:00.000Z');
		});

		it('should produce an empty activity map for a dashboard without messages', () => {
			const dashboard = { status: { markdown: '# empty' }, intercom: { messages: [] } };
			expect(extractMachineActivity(renderDashboardActivityMarkdown(dashboard)).size).toBe(0);
		});

		// ms#1432 review (Hermes #2 / #1123) — un CORPS de message contenant une
		// ligne « ### [ts] machine|ws » ne doit pas fabriquer une activité fantôme
		// dans extractMachineActivity : le render échappe au même format que le
		// writer de fichier (dashboard.ts #1123).
		it('should not let a header-shaped line inside a message body create phantom activity (#1123)', () => {
			const dashboard = {
				status: { markdown: '' },
				intercom: {
					messages: [
						{
							timestamp: '2026-10-15T08:00:00.000Z',
							content: 'citation d\'un autre message :\n### [2020-01-01T00:00:00.000Z] ghost-machine|ghost-ws\nfin de citation',
							author: { machineId: 'myia-po-2024', workspace: 'roo-extensions' },
						},
					],
				},
			};

			const rendered = renderDashboardActivityMarkdown(dashboard);
			// Le corps échappé est présent (débogabilité conservée)…
			expect(rendered).toContain('\\#\\#\\# [2020-01-01T00:00:00.000Z] ghost-machine|ghost-ws');
			const activity = extractMachineActivity(rendered);
			// …mais la seule activité est celle de l'auteur RÉEL.
			expect(activity.size).toBe(1);
			expect(activity.get('myia-po-2024')).toBe('2026-10-15T08:00:00.000Z');
			expect(activity.has('ghost-machine')).toBe(false);
		});
	});
});
