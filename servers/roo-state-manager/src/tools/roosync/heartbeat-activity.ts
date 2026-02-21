/**
 * Helper pour enregistrer l'activité RooSync comme preuve de vie heartbeat
 *
 * Fix pour #501 : Les machines actives sur RooSync doivent être marquées online
 * même si le service heartbeat explicite n'est pas démarré.
 *
 * @module tools/roosync/heartbeat-activity
 */

import { getRooSyncService } from '../../services/RooSyncService.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('HeartbeatActivity');

/**
 * Enregistre une activité RooSync comme preuve de vie
 *
 * Appelé automatiquement par les outils de messagerie (send, read, manage)
 * pour maintenir le statut "online" de la machine.
 *
 * Fire-and-forget : ne bloque pas l'opération appelante en cas d'échec.
 *
 * @param activityType Type d'activité (ex: 'send', 'read', 'manage')
 * @param metadata Métadonnées optionnelles
 */
export async function recordRooSyncActivity(
	activityType: string,
	metadata?: Record<string, unknown>
): Promise<void> {
	try {
		const service = getRooSyncService();
		await service.registerHeartbeat({
			activityType,
			...metadata,
			recordedAt: new Date().toISOString()
		});
		logger.debug(`Activité RooSync enregistrée: ${activityType}`);
	} catch (error) {
		// Ne pas bloquer l'opération principale si le heartbeat échoue
		logger.warn(`Échec enregistrement activité heartbeat: ${(error as Error).message}`);
	}
}

/**
 * Version synchrone fire-and-forget
 *
 * Lance l'enregistrement sans attendre le résultat.
 * Utile pour les opérations rapides où on ne veut pas attendre.
 */
export function recordRooSyncActivityAsync(
	activityType: string,
	metadata?: Record<string, unknown>
): void {
	// Fire-and-forget: on n'attend pas le résultat
	recordRooSyncActivity(activityType, metadata).catch(err => {
		logger.debug(`Activité heartbeat en arrière-plan échouée: ${err.message}`);
	});
}
