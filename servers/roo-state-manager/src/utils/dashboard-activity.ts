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
 * @version 3.0.0 (#1953 Phase 4: dashboard discovery of absent machines)
 */

import { createLogger } from './logger.js';

const logger = createLogger('DashboardActivity');

const DASHBOARD_MSG_PATTERN = /^###\s*\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]\s*(\S+)/gm;

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

			const machineId = authorField.split('|')[0].toLowerCase().trim();
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
