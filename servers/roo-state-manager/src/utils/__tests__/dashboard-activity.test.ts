/**
 * Tests for dashboard-derived machine status utility (#1953, #2016)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { extractMachineActivity, isRecentlyActive, crossCheckWithDashboard, renderDashboardActivityMarkdown, lookupMachineActivityInArchives, DEFAULT_ACTIVITY_THRESHOLD_MS } from '../dashboard-activity.js';

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
