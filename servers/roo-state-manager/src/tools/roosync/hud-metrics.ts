/**
 * Outil MCP : roosync_hud_metrics
 *
 * Endpoint léger pour le HUD statusline RooSync.
 * Retourne les métriques temps-réel agrégées : machines, inbox, indexing, santé système.
 *
 * @module tools/roosync/hud-metrics
 * @version 1.0.0 — #1855
 */

import { z } from 'zod';
import { getRooSyncService } from '../../services/lazy-roosync.js';
import { getMessageManager } from '../../services/MessageManager.js';
import { getSharedStatePath } from '../../utils/shared-state-path.js';
import { join } from 'path';
import { readdirSync, statSync } from 'fs';
import { hostname } from 'os';

// ====================================================================
// SCHEMAS
// ====================================================================

export const HudMetricsArgsSchema = z.object({
	includeDetails: z.boolean().optional()
		.describe('Inclure les détails par machine (défaut: false)'),
	includeIndexing: z.boolean().optional()
		.describe('Inclure les métriques d\'indexation Qdrant (défaut: false)')
});

export type HudMetricsArgs = z.infer<typeof HudMetricsArgsSchema>;

export const HudMetricsResultSchema = z.object({
	timestamp: z.string(),
	machine: z.object({
		id: z.string(),
		hostname: z.string()
	}),
	system: z.object({
		status: z.enum(['HEALTHY', 'WARNING', 'CRITICAL']),
		uptime: z.number()
	}),
	machines: z.object({
		online: z.number(),
		offline: z.number(),
		total: z.number(),
		details: z.array(z.object({
			id: z.string(),
			status: z.enum(['online', 'offline', 'warning']),
			lastHeartbeat: z.string().optional()
		})).optional()
	}),
	inbox: z.object({
		unread: z.number(),
		urgent: z.number()
	}),
	decisions: z.object({
		pending: z.number()
	}),
	dashboards: z.object({
		active: z.number()
	}),
	indexing: z.object({
		queueSize: z.number(),
		enabled: z.boolean(),
		lastIndexAt: z.string().optional()
	}).optional(),
	flags: z.array(z.string())
});

export type HudMetricsResult = z.infer<typeof HudMetricsResultSchema>;

// ====================================================================
// METADATA
// ====================================================================

export const hudMetricsToolMetadata = {
	name: 'roosync_hud_metrics',
	description: 'Endpoint léger pour le HUD statusline RooSync. Retourne les métriques temps-réel : machines online/offline, inbox, décisions, dashboards actifs, indexing. Optimisé pour un polling fréquent.',
	inputSchema: {
		type: 'object',
		properties: {
			includeDetails: { type: 'boolean', description: 'Inclure les détails par machine (défaut: false)' },
			includeIndexing: { type: 'boolean', description: 'Inclure les métriques d\'indexation Qdrant (défaut: false)' }
		},
		additionalProperties: false
	}
};

// ====================================================================
// IMPLEMENTATION
// ====================================================================

const SERVER_START_TIME = Date.now();

/**
 * Check if a machine ID is a real production machine (not a test artifact).
 */
function isKnownMachine(machineId: string): boolean {
	return machineId.toLowerCase().startsWith('myia-');
}

/**
 * Collecte les métriques HUD — optimisé pour un appel rapide et fréquent.
 */
export async function roosyncHudMetrics(
	args: HudMetricsArgs,
	indexingMetrics?: { queueSize: number; enabled: boolean; lastIndexAt?: number }
): Promise<HudMetricsResult> {
	const now = new Date().toISOString();
	const machineId = process.env.ROOSYNC_MACHINE_ID || hostname();

	// Collecte parallèle
	const [heartbeatState, inboxStats, pendingDecisions, activeDashboards] = await Promise.all([
		(async () => {
			try {
				const service = await getRooSyncService();
				const heartbeatService = service.getHeartbeatService();
				await heartbeatService.checkHeartbeats();
				return heartbeatService.getState();
			} catch {
				return { onlineMachines: [] as string[], offlineMachines: [] as string[], warningMachines: [] as string[] };
			}
		})(),
		(async () => {
			try {
				const service = await getRooSyncService();
				const config = service.getConfig();
				const messageManager = getMessageManager();
				const stats = await messageManager.getInboxStats(config.machineId);
				return {
					unread: stats.unread,
					urgent: stats.by_priority?.URGENT ?? 0
				};
			} catch {
				return { unread: 0, urgent: 0 };
			}
		})(),
		(async () => {
			try {
				const service = await getRooSyncService();
				const decisions = await service.loadPendingDecisions();
				return decisions.length;
			} catch {
				return 0;
			}
		})(),
		(async () => {
			try {
				const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
				const dashboardsDir = join(getSharedStatePath(), 'dashboards');
				const files = readdirSync(dashboardsDir);
				let count = 0;
				for (const file of files) {
					if (file.endsWith('.md') && !file.endsWith('.tmp')) {
						const filePath = join(dashboardsDir, file);
						const stat = statSync(filePath);
						if (stat.mtimeMs > oneDayAgo) count++;
					}
				}
				return count;
			} catch {
				return 0;
			}
		})()
	]);

	// Filter to known machines only
	const onlineKnown = heartbeatState.onlineMachines.filter(isKnownMachine);
	const offlineKnown = heartbeatState.offlineMachines.filter(isKnownMachine);
	const warningKnown = heartbeatState.warningMachines.filter(isKnownMachine);
	const totalKnown = onlineKnown.length + offlineKnown.length;

	// Build flags
	const flags: string[] = [];
	for (const m of offlineKnown) flags.push(`OFFLINE:${m}`);
	for (const m of warningKnown) flags.push(`HEARTBEAT_STALE:${m}`);
	if (inboxStats.urgent > 0) flags.push(`INBOX_URGENT:${inboxStats.urgent}`);
	if (inboxStats.unread > 10) flags.push(`INBOX_OVERFLOW:${inboxStats.unread}`);
	if (pendingDecisions > 0) flags.push(`DECISIONS_PENDING:${pendingDecisions}`);

	// Determine overall status
	let status: 'HEALTHY' | 'WARNING' | 'CRITICAL' = 'HEALTHY';
	if (offlineKnown.length > 0 || inboxStats.urgent > 0) status = 'WARNING';
	if (offlineKnown.length >= Math.ceil(totalKnown / 2)) status = 'CRITICAL';

	// Machine details (optional)
	const machinesDetails = args.includeDetails ? [
		...onlineKnown.map(id => ({ id, status: 'online' as const })),
		...offlineKnown.map(id => ({ id, status: 'offline' as const })),
		...warningKnown.map(id => ({ id, status: 'warning' as const }))
	] : undefined;

	// Indexing metrics (optional)
	const indexingData = args.includeIndexing && indexingMetrics ? {
		queueSize: indexingMetrics.queueSize,
		enabled: indexingMetrics.enabled,
		lastIndexAt: indexingMetrics.lastIndexAt ? new Date(indexingMetrics.lastIndexAt).toISOString() : undefined
	} : undefined;

	return {
		timestamp: now,
		machine: {
			id: machineId,
			hostname: hostname()
		},
		system: {
			status,
			uptime: Math.floor((Date.now() - SERVER_START_TIME) / 1000)
		},
		machines: {
			online: onlineKnown.length,
			offline: offlineKnown.length,
			total: totalKnown,
			details: machinesDetails
		},
		inbox: inboxStats,
		decisions: { pending: pendingDecisions },
		dashboards: { active: activeDashboards },
		indexing: indexingData,
		flags
	};
}
