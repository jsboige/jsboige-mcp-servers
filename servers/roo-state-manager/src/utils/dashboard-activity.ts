/**
 * Dashboard-derived machine status utility (#1953)
 *
 * Parses dashboard message timestamps to determine last-seen time per machine.
 * Used as a cross-check against heartbeat files to prevent false OFFLINE detection
 * caused by GDrive propagation latency.
 *
 * Dashboard messages embed timestamps INSIDE the content (written by the posting machine),
 * which are immune to GDrive file modification time delays.
 *
 * Message format: ### [2026-05-03T20:08:15.436Z] myia-po-2024|roo-extensions
 *
 * @module utils/dashboard-activity
 * @version 1.0.0
 */

import { createLogger } from './logger.js';

const logger = createLogger('DashboardActivity');

const DASHBOARD_MSG_PATTERN = /^###\s*\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]\s*(\S+)/gm;

/**
 * Extract last-seen timestamp per machine from dashboard content.
 *
 * @param dashboardContent - Raw dashboard markdown content
 * @returns Map of machineId → last-seen ISO timestamp
 */
export function extractMachineActivity(dashboardContent: string): Map<string, string> {
	const activity = new Map<string, string>();

	if (!dashboardContent) return activity;

	let match: RegExpExecArray | null;
	const pattern = new RegExp(DASHBOARD_MSG_PATTERN.source, 'gm');

	while ((match = pattern.exec(dashboardContent)) !== null) {
		const timestamp = match[1];
		const authorField = match[2];

		const machineId = authorField.split('|')[0].toLowerCase().trim();
		if (!machineId.startsWith('myia-')) continue;

		const existing = activity.get(machineId);
		if (!existing || timestamp > existing) {
			activity.set(machineId, timestamp);
		}
	}

	logger.debug(`Dashboard activity extracted: ${activity.size} machines seen`);
	return activity;
}

/**
 * Determine if a machine should be considered ONLINE based on dashboard activity.
 *
 * @param lastSeen - ISO timestamp of last dashboard message from the machine
 * @param thresholdMs - How far back to consider "recent" (default: 60 min)
 * @returns true if machine posted within the threshold
 */
export function isRecentlyActive(lastSeen: string, thresholdMs: number = 60 * 60 * 1000): boolean {
	const lastSeenMs = new Date(lastSeen).getTime();
	if (isNaN(lastSeenMs)) return false;
	return Date.now() - lastSeenMs < thresholdMs;
}

/**
 * Cross-check heartbeat-derived status against dashboard activity.
 *
 * For machines marked "offline" or "warning" by heartbeat files,
 * if dashboard shows recent activity, override the status to "online".
 *
 * @param heartbeatState - State from HeartbeatService.checkHeartbeats()
 * @param dashboardContent - Raw dashboard markdown content
 * @param thresholdMs - Dashboard activity threshold (default: 60 min)
 * @returns Updated lists of online/offline/warning machines
 */
export function crossCheckWithDashboard(
	heartbeatState: {
		onlineMachines: string[];
		offlineMachines: string[];
		warningMachines: string[];
	},
	dashboardContent: string,
	thresholdMs: number = 60 * 60 * 1000
): {
	onlineMachines: string[];
	offlineMachines: string[];
	warningMachines: string[];
	overrides: string[];
} {
	const activity = extractMachineActivity(dashboardContent);
	const overrides: string[] = [];

	const offlineMachines = [...heartbeatState.offlineMachines];
	const warningMachines = [...heartbeatState.warningMachines];
	const onlineMachines = [...heartbeatState.onlineMachines];

	for (let i = offlineMachines.length - 1; i >= 0; i--) {
		const machineId = offlineMachines[i];
		const lastSeen = activity.get(machineId);
		if (lastSeen && isRecentlyActive(lastSeen, thresholdMs)) {
			offlineMachines.splice(i, 1);
			onlineMachines.push(machineId);
			overrides.push(machineId);
			logger.info(`Dashboard override: ${machineId} OFFLINE→ONLINE (last seen ${lastSeen})`);
		}
	}

	for (let i = warningMachines.length - 1; i >= 0; i--) {
		const machineId = warningMachines[i];
		const lastSeen = activity.get(machineId);
		if (lastSeen && isRecentlyActive(lastSeen, thresholdMs)) {
			warningMachines.splice(i, 1);
			onlineMachines.push(machineId);
			overrides.push(machineId);
			logger.info(`Dashboard override: ${machineId} WARNING→ONLINE (last seen ${lastSeen})`);
		}
	}

	return { onlineMachines, offlineMachines, warningMachines, overrides };
}
