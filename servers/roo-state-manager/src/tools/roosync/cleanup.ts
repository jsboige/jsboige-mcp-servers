/**
 * Outil MCP : roosync_cleanup_messages
 *
 * Effectue des opérations de cleanup en masse sur les messages RooSync.
 *
 * Cas d'usage :
 * - Marquer automatiquement les messages LOW comme lus
 * - Ignorer les messages de test (test-machine)
 * - Nettoyer les anciens messages non lus
 *
 * @module roosync/cleanup
 * @version 1.0.0 - Issue #613 ISS-1
 */

import { getMessageManager } from '../../services/MessageManager.js';
import { getLocalMachineId } from '../../utils/message-helpers.js';
import { createLogger, Logger } from '../../utils/logger.js';

const logger: Logger = createLogger('CleanupTool');

/**
 * Arguments de l'outil roosync_cleanup_messages
 */
export interface CleanupMessagesArgs {
  /**
   * Opération à effectuer
   * - mark_read: Marquer les messages comme lus
   * - archive: Archiver les messages
   */
  operation: 'mark_read' | 'archive';

  /**
   * Filtre par expéditeur (substring match)
   * Ex: "test-machine" pour ignorer les messages de test
   */
  from?: string;

  /**
   * Filtre par priorité
   * Ex: "LOW" pour marquer automatiquement les messages LOW
   */
  priority?: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';

  /**
   * Filtre par date (messages antérieurs à cette date)
   * Format ISO-8601: "2026-02-01T00:00:00Z"
   */
  before_date?: string;

  /**
   * Filtre par sujet (substring, case-insensitive)
   */
  subject_contains?: string;

  /**
   * Filtre par tag
   */
  tag?: string;

  /**
   * Ne traiter que les messages avec ce statut
   */
  status?: 'unread' | 'read';

  /**
   * Afficher les IDs des messages traités (défaut: true)
   */
  verbose?: boolean;
}

/**
 * Formatte le résultat d'une opération de cleanup
 */
function formatCleanupResult(result: {
  operation: string;
  matched: number;
  processed: number;
  errors: number;
  message_ids: string[];
}, verbose: boolean = true): string {
  let output = `## 🧹 Cleanup RooSync - ${result.operation}\n\n`;
  output += `**Messages correspondants :** ${result.matched}\n`;
  output += `**Messages traités :** ${result.processed}\n`;
  output += `**Erreurs :** ${result.errors}\n\n`;

  if (verbose && result.message_ids.length > 0) {
    const maxDisplay = 20;
    const displayed = result.message_ids.slice(0, maxDisplay);
    output += `**IDs traités** (${displayed.length}/${result.message_ids.length} affichés) :\n\n`;
    for (const id of displayed) {
      output += `- ${id}\n`;
    }
    if (result.message_ids.length > maxDisplay) {
      output += `\n_... et ${result.message_ids.length - maxDisplay} autres_\n`;
    }
  }

  return output;
}

/**
 * Effectue une opération de cleanup sur les messages
 *
 * @param args Arguments de l'outil
 * @returns Résultat de l'opération
 */
export async function cleanupMessages(
  args: CleanupMessagesArgs
): Promise<{ content: Array<{ type: string; text: string }> }> {
  logger.info('🧹 Starting cleanup operation', { operation: args.operation });

  try {
    // Initialiser le MessageManager (singleton)
    const messageManager = getMessageManager();

    // Obtenir l'ID de la machine locale
    const machineId = getLocalMachineId();
    logger.debug('📍 Machine ID identified', { machineId });

    // Préparer les filtres
    const filters: {
      from?: string;
      priority?: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
      before_date?: string;
      subject_contains?: string;
      tag?: string;
      status?: 'unread' | 'read';
    } = {};

    if (args.from) filters.from = args.from;
    if (args.priority) filters.priority = args.priority;
    if (args.before_date) filters.before_date = args.before_date;
    if (args.subject_contains) filters.subject_contains = args.subject_contains;
    if (args.tag) filters.tag = args.tag;
    if (args.status) filters.status = args.status;

    // Exécuter l'opération bulk
    const result = await messageManager.bulkOperation(
      machineId,
      args.operation,
      filters
    );

    logger.info('✅ Cleanup complete', {
      operation: result.operation,
      matched: result.matched,
      processed: result.processed,
      errors: result.errors
    });

    const verbose = args.verbose !== false;
    const formattedResult = formatCleanupResult(result, verbose);

    return {
      content: [{ type: 'text', text: formattedResult }]
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('❌ Cleanup error', error instanceof Error ? error : new Error(errorMessage));

    return {
      content: [{
        type: 'text',
        text: `❌ **Erreur lors du cleanup**

**Message d'erreur :** ${errorMessage}

**Vérifications :**
- Le répertoire .shared-state est-il accessible ?
- Les filtres sont-ils corrects ?`
      }]
    };
  }
}

/**
 * Métadonnées pour l'outil MCP roosync_cleanup_messages
 */
export const cleanupToolMetadata = {
  name: 'roosync_cleanup_messages',
  description: 'Effectue des opérations de cleanup en masse sur les messages RooSync. Cas d\'usage : marquer automatiquement les messages LOW comme lus, ignorer les messages de test (test-machine), nettoyer les anciens messages non lus.',
  inputSchema: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: ['mark_read', 'archive'],
        description: 'Opération à effectuer : mark_read (marquer comme lu) ou archive (archiver)'
      },
      from: {
        type: 'string',
        description: 'Filtre par expéditeur (substring match). Ex: "test-machine" pour ignorer les messages de test'
      },
      priority: {
        type: 'string',
        enum: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'],
        description: 'Filtre par priorité. Ex: "LOW" pour marquer automatiquement les messages LOW'
      },
      before_date: {
        type: 'string',
        description: 'Filtre par date (messages antérieurs à cette date). Format ISO-8601: "2026-02-01T00:00:00Z"'
      },
      subject_contains: {
        type: 'string',
        description: 'Filtre par sujet (substring, case-insensitive)'
      },
      tag: {
        type: 'string',
        description: 'Filtre par tag'
      },
      status: {
        type: 'string',
        enum: ['unread', 'read'],
        description: 'Ne traiter que les messages avec ce statut'
      },
      verbose: {
        type: 'boolean',
        description: 'Afficher les IDs des messages traités (défaut: true)'
      }
    },
    required: ['operation']
  }
};
