/**
 * Outil MCP : roosync_read_inbox
 * 
 * Lit la boîte de réception des messages RooSync
 * 
 * @module roosync/read_inbox
 */

import { MessageManager } from '../../services/MessageManager.js';
import { getSharedStatePath } from '../../utils/server-helpers.js';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import os from 'os';

/**
 * Arguments de l'outil roosync_read_inbox
 */
interface ReadInboxArgs {
  /** Filtrer par status (défaut: all) */
  status?: 'unread' | 'read' | 'all';
  
  /** Nombre maximum de messages à retourner */
  limit?: number;
}

/**
 * Récupère l'ID de la machine locale depuis le hostname OS
 *
 * @returns ID de la machine locale (hostname normalisé)
 */
function getLocalMachineId(): string {
  return os.hostname().toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

/**
 * Formatte la date en format français lisible
 * 
 * @param isoDate Date au format ISO-8601
 * @returns Date formatée
 */
function formatDate(isoDate: string): string {
  const date = new Date(isoDate);
  return date.toLocaleString('fr-FR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

/**
 * Obtient l'icône correspondant à la priorité
 * 
 * @param priority Priorité du message
 * @returns Emoji représentant la priorité
 */
function getPriorityIcon(priority: string): string {
  switch (priority) {
    case 'URGENT': return '🔥';
    case 'HIGH': return '⚠️';
    case 'MEDIUM': return '📝';
    case 'LOW': return '📋';
    default: return '📝';
  }
}

/**
 * Obtient l'icône correspondant au statut
 * 
 * @param status Statut du message
 * @returns Emoji représentant le statut
 */
function getStatusIcon(status: string): string {
  switch (status) {
    case 'unread': return '🆕';
    case 'read': return '✅';
    case 'archived': return '📦';
    default: return '📧';
  }
}

/**
 * Lit la boîte de réception de messages
 * 
 * @param args Arguments de l'outil
 * @returns Liste des messages
 */
export async function readInbox(
  args: ReadInboxArgs = {}
): Promise<{ content: Array<{ type: string; text: string }> }> {
  console.error('📬 [read_inbox] Starting...');

  try {
    // Initialiser le MessageManager
    const sharedStatePath = getSharedStatePath();
    const messageManager = new MessageManager(sharedStatePath);

    // Obtenir l'ID de la machine locale
    const machineId = getLocalMachineId();
    console.error(`📍 [read_inbox] Machine ID: ${machineId}`);

    // Lire les messages
    const messages = await messageManager.readInbox(
      machineId,
      args.status || 'all',
      args.limit
    );

    // Cas : aucun message
    if (messages.length === 0) {
      const statusFilter = args.status && args.status !== 'all' ? ` (${args.status})` : '';
      return {
        content: [{
          type: 'text',
          text: `📭 **Aucun message dans votre boîte de réception${statusFilter}**

Votre inbox est vide pour le moment.

**Machine :** ${machineId}
${args.status ? `**Filtre :** ${args.status}` : '**Filtre :** tous les messages'}`
        }]
      };
    }

    // Calculer les statistiques
    const unreadCount = messages.filter(m => m.status === 'unread').length;
    const readCount = messages.filter(m => m.status === 'read').length;

    // Formater le résultat sous forme de tableau
    let result = `📬 **Boîte de Réception** - ${machineId}\n\n`;
    result += `**Total :** ${messages.length} message${messages.length > 1 ? 's' : ''}`;
    result += ` | 🆕 ${unreadCount} non-lu${unreadCount > 1 ? 's' : ''}`;
    result += ` | ✅ ${readCount} lu${readCount > 1 ? 's' : ''}\n\n`;
    
    result += `| ID | De | Sujet | Priorité | Status | Date |\n`;
    result += `|----|----|----|----------|--------|------|\n`;

    for (const msg of messages) {
      const statusIcon = getStatusIcon(msg.status);
      const priorityIcon = getPriorityIcon(msg.priority);
      const date = formatDate(msg.timestamp);
      const shortId = msg.id.substring(0, 12) + '...';
      
      // Tronquer le sujet si trop long
      const maxSubjectLength = 25;
      const truncatedSubject = msg.subject.length > maxSubjectLength
        ? msg.subject.substring(0, maxSubjectLength) + '...'
        : msg.subject;

      result += `| ${shortId} | ${msg.from} | ${truncatedSubject} | ${priorityIcon} ${msg.priority} | ${statusIcon} ${msg.status} | ${date} |\n`;
    }

    result += `\n---\n\n`;
    
    // Aperçu du premier message
    if (messages.length > 0) {
      result += `**📋 Aperçu du message le plus récent :**\n\n`;
      result += `**De :** ${messages[0].from}\n`;
      result += `**Sujet :** ${messages[0].subject}\n`;
      result += `**Priorité :** ${getPriorityIcon(messages[0].priority)} ${messages[0].priority}\n`;
      result += `**Aperçu :** ${messages[0].preview}\n\n`;
    }

    result += `---\n\n`;
    result += `**💡 Actions disponibles :**\n`;
    result += `- \`roosync_get_message\` avec l'ID pour lire un message complet\n`;
    result += `- \`roosync_read_inbox\` avec \`status: "unread"\` pour voir uniquement les non-lus\n`;
    result += `- \`roosync_read_inbox\` avec \`limit: 5\` pour limiter le nombre de résultats`;

    console.error(`✅ [read_inbox] Returning ${messages.length} messages`);
    return {
      content: [{ type: 'text', text: result }]
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('❌ [read_inbox] Error:', errorMessage);
    
    return {
      content: [{
        type: 'text',
        text: `❌ **Erreur lors de la lecture de l'inbox**

**Message d'erreur :** ${errorMessage}

**Vérifications :**
- Le répertoire .shared-state est-il accessible ?
- Le fichier sync-config.json existe-t-il ?
- Le répertoire messages/inbox/ existe-t-il ?`
      }]
    };
  }
}