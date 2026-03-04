/**
 * Helpers pour la mise à jour automatique du dashboard RooSync
 *
 * @module utils/dashboard-helpers
 * @version 1.0.0
 * @issue #546 Phase 2
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { getSharedStatePath } from './server-helpers.js';
import { getLocalMachineId } from './message-helpers.js';
import { createLogger, Logger } from './logger.js';

const logger: Logger = createLogger('DashboardHelpers');

/**
 * Met à jour la section machine du dashboard avec une activité récente
 *
 * Cette fonction est conçue pour être appelée en fire-and-forget
 * (non bloquante) après les opérations RooSync.
 *
 * @param activity Description de l'activité (ex: "Message envoyé à myia-ai-01")
 * @param details Détails additionnels optionnels (ex: ID du message, sujet)
 */
export async function updateDashboardActivityAsync(
  activity: string,
  details?: { messageId?: string; subject?: string; [key: string]: any }
): Promise<void> {
  try {
    const sharedStatePath = getSharedStatePath();
    const dashboardPath = path.join(sharedStatePath, 'DASHBOARD.md');

    // Vérifier que le dashboard existe
    try {
      await fs.access(dashboardPath);
    } catch {
      // Le dashboard n'existe pas encore, silencieux
      logger.debug('Dashboard does not exist yet, skipping update');
      return;
    }

    const machineId = getLocalMachineId();
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

    // Construire le contenu markdown de l'activité
    const content = `#### Dernière activité (${now})
- **Action :** ${activity}
${details?.messageId ? `- **Message ID :** \`${details.messageId}\`` : ''}
${details?.subject ? `- **Sujet :** ${details.subject}` : ''}
`;

    // Lire le dashboard actuel
    const dashboardContent = await fs.readFile(dashboardPath, 'utf8');
    const lines = dashboardContent.split('\n');

    // Trouver la section de la machine
    const machineHeaderIndex = lines.findIndex(line =>
      line.includes(`### ${machineId}`)
    );

    if (machineHeaderIndex === -1) {
      // Section machine non trouvée, silencieux
      logger.debug('Machine section not found in dashboard', { machineId });
      return;
    }

    // Trouver la sous-section "roo-extensions" ou la créer après la ligne du header
    const workspace = 'roo-extensions';
    const workspaceHeaderIndex = lines.findIndex((line, idx) =>
      idx > machineHeaderIndex && line.trim().startsWith('####') && line.toLowerCase().includes(workspace.toLowerCase())
    );

    let insertIndex: number;

    if (workspaceHeaderIndex !== -1) {
      // Remplacer le contenu de la sous-section workspace
      insertIndex = workspaceHeaderIndex;
      // Supprimer les lignes existantes de la sous-section jusqu'au prochain #### ou ###
      let deleteCount = 1;
      while (
        insertIndex + deleteCount < lines.length &&
        !lines[insertIndex + deleteCount].trim().startsWith('###') &&
        !lines[insertIndex + deleteCount].trim().startsWith('##')
      ) {
        deleteCount++;
      }
      lines.splice(insertIndex, deleteCount);
    } else {
      // Créer la sous-section après le header machine
      insertIndex = machineHeaderIndex + 1;
      // Insérer un saut de ligne si nécessaire
      if (insertIndex < lines.length && lines[insertIndex].trim() !== '') {
        lines.splice(insertIndex, 0, '');
        insertIndex++;
      }
    }

    // Insérer le nouveau contenu
    lines.splice(insertIndex, 0, content);

    // Mettre à jour l'horodatage global du dashboard
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('Dernière mise à jour:')) {
        lines[i] = `**Dernière mise à jour:** ${now} par ${machineId}:${workspace}`;
        break;
      }
    }

    // Écrire le dashboard mis à jour
    await fs.writeFile(dashboardPath, lines.join('\n'), 'utf8');

    logger.debug('Dashboard activity updated', { activity, machineId });
  } catch (error) {
    // Fire-and-forget : ne pas propager l'erreur
    logger.debug('Dashboard update failed (non-critical)', { error: String(error) });
  }
}
