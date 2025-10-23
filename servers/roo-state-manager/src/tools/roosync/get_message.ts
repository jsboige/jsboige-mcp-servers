/**
 * Outil MCP : roosync_get_message
 * 
 * Obtient les détails complets d'un message spécifique
 * 
 * @module roosync/get_message
 */

import { MessageManager } from '../../services/MessageManager.js';
import { getSharedStatePath } from '../../utils/server-helpers.js';
import { createLogger, Logger } from '../../utils/logger.js';

// Logger instance for get_message tool
const logger: Logger = createLogger('GetMessageTool');

/**
 * Arguments de l'outil roosync_get_message
 */
interface GetMessageArgs {
  /** ID du message à récupérer */
  message_id: string;
  
  /** Marquer automatiquement comme lu (défaut: false) */
  mark_as_read?: boolean;
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
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
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
 * Obtient les détails complets d'un message
 * 
 * @param args Arguments de l'outil
 * @returns Message complet formaté
 */
export async function getMessage(
  args: GetMessageArgs
): Promise<{ content: Array<{ type: string; text: string }> }> {
  logger.info('🔍 Starting get message operation');

  try {
    // Validation des paramètres requis
    if (!args.message_id) {
      throw new Error('Paramètre "message_id" requis : ID du message à récupérer');
    }

    // Initialiser le MessageManager
    const sharedStatePath = getSharedStatePath();
    const messageManager = new MessageManager(sharedStatePath);

    // Récupérer le message
    logger.debug('🔍 Fetching message', { messageId: args.message_id });
    const message = await messageManager.getMessage(args.message_id);

    // Cas : message introuvable
    if (!message) {
      return {
        content: [{
          type: 'text',
          text: `❌ **Message introuvable**

**ID recherché :** ${args.message_id}

Le message n'a pas été trouvé dans :
- ❌ messages/inbox/
- ❌ messages/sent/
- ❌ messages/archive/

**Suggestions :**
- Vérifiez que l'ID du message est correct
- Le message a peut-être été supprimé
- Utilisez \`roosync_read_inbox\` pour lister les messages disponibles`
        }]
      };
    }

    // Marquer comme lu si demandé
    if (args.mark_as_read && message.status === 'unread') {
      logger.debug('✉️ Marking message as read');
      await messageManager.markAsRead(args.message_id);
      message.status = 'read';
    }

    // Icônes pour le formatage
    const statusIcon = getStatusIcon(message.status);
    const priorityIcon = getPriorityIcon(message.priority);

    // Formater le résultat
    let result = `# 📨 Message : ${message.subject}\n\n`;
    result += `---\n\n`;
    
    // Métadonnées principales
    result += `**Status :** ${statusIcon} ${message.status.toUpperCase()}\n`;
    result += `**Priorité :** ${priorityIcon} ${message.priority}\n`;
    result += `**De :** ${message.from}\n`;
    result += `**À :** ${message.to}\n`;
    result += `**Date :** ${formatDate(message.timestamp)}\n`;
    result += `**ID :** \`${message.id}\`\n`;

    // Métadonnées optionnelles
    if (message.tags && message.tags.length > 0) {
      result += `**Tags :** ${message.tags.map(t => `\`${t}\``).join(', ')}\n`;
    }

    if (message.thread_id) {
      result += `**Thread :** \`${message.thread_id}\`\n`;
    }

    if (message.reply_to) {
      result += `**En réponse à :** \`${message.reply_to}\`\n`;
    }

    result += `\n---\n\n`;
    
    // Corps du message
    result += `## 📄 Contenu\n\n`;
    result += `${message.body}\n\n`;
    
    result += `---\n\n`;
    
    // Actions disponibles
    result += `## 💡 Actions disponibles\n\n`;
    
    if (message.status === 'unread') {
      result += `- ✉️ **Marquer comme lu** : Utilisez \`roosync_get_message\` avec \`mark_as_read: true\`\n`;
    }
    
    if (message.status !== 'archived') {
      result += `- 📦 **Archiver** : Utilisez \`roosync_archive_message\` (Phase 2)\n`;
    }
    
    result += `- 💬 **Répondre** : Utilisez \`roosync_send_message\` avec \`reply_to: "${message.id}"\`\n`;
    
    if (message.thread_id) {
      result += `- 🔗 **Voir le thread** : Utilisez \`roosync_read_inbox\` puis filtrez par thread_id\n`;
    }

    logger.info('✅ Message retrieved successfully', { messageId: args.message_id, markedAsRead: args.mark_as_read });
    return {
      content: [{ type: 'text', text: result }]
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('❌ Get message error', error instanceof Error ? error : new Error(errorMessage));
    
    return {
      content: [{
        type: 'text',
        text: `❌ **Erreur lors de la récupération du message**

**Message d'erreur :** ${errorMessage}

**Vérifications :**
- Le répertoire .shared-state est-il accessible ?
- L'ID du message est-il correct ?
- Le message existe-t-il dans inbox/, sent/ ou archive/ ?`
      }]
    };
  }
}