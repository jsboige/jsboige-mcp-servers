/**
 * Tests for dashboard-derived machine status utility (#1953)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { extractMachineActivity, isRecentlyActive, crossCheckWithDashboard } from '../dashboard-activity.js';

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
			expect(isRecentlyActive('2026-05-03T19:30:00Z')).toBe(true); // 30 min ago
		});

		it('should return false for old timestamp with default threshold', () => {
			expect(isRecentlyActive('2026-05-03T18:00:00Z')).toBe(false); // 2h ago, default 60min
		});

		it('should respect custom threshold', () => {
			expect(isRecentlyActive('2026-05-03T18:00:00Z', 3 * 60 * 60 * 1000)).toBe(true); // 2h ago, threshold 3h
		});

		it('should return false for invalid timestamp', () => {
			expect(isRecentlyActive('invalid')).toBe(false);
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

		it('should override OFFLINE to ONLINE when dashboard shows recent activity', () => {
			const heartbeatState = {
				onlineMachines: ['myia-po-2023'],
				offlineMachines: ['myia-po-2024'],
				warningMachines: [],
			};
			const dashboardContent = '### [2026-05-03T19:30:00Z] myia-po-2024|roo-extensions\nRecent message';

			const result = crossCheckWithDashboard(heartbeatState, dashboardContent);
			expect(result.onlineMachines).toContain('myia-po-2024');
			expect(result.offlineMachines).not.toContain('myia-po-2024');
			expect(result.overrides).toContain('myia-po-2024');
		});

		it('should override WARNING to ONLINE when dashboard shows recent activity', () => {
			const heartbeatState = {
				onlineMachines: [],
				offlineMachines: [],
				warningMachines: ['myia-web1'],
			};
			const dashboardContent = '### [2026-05-03T19:45:00Z] myia-web1|roo-extensions\nRecent message';

			const result = crossCheckWithDashboard(heartbeatState, dashboardContent);
			expect(result.onlineMachines).toContain('myia-web1');
			expect(result.warningMachines).not.toContain('myia-web1');
			expect(result.overrides).toContain('myia-web1');
		});

		it('should NOT override when dashboard activity is too old', () => {
			const heartbeatState = {
				onlineMachines: [],
				offlineMachines: ['myia-po-2025'],
				warningMachines: [],
			};
			const dashboardContent = '### [2026-05-03T10:00:00Z] myia-po-2025|roo-extensions\nOld message';

			const result = crossCheckWithDashboard(heartbeatState, dashboardContent);
			expect(result.offlineMachines).toContain('myia-po-2025');
			expect(result.overrides).toHaveLength(0);
		});

		it('should handle multiple overrides', () => {
			const heartbeatState = {
				onlineMachines: [],
				offlineMachines: ['myia-po-2024', 'myia-po-2025'],
				warningMachines: ['myia-web1'],
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
				offlineMachines: [],
				warningMachines: [],
			};
			const dashboardContent = '### [2026-05-03T19:50:00Z] myia-ai-01|roo-extensions\nMessage';

			const result = crossCheckWithDashboard(heartbeatState, dashboardContent);
			expect(result.overrides).toHaveLength(0);
			expect(result.onlineMachines).toEqual(['myia-ai-01']);
		});
	});
});
