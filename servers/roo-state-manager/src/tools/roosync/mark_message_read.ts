/**
 * @deprecated Superseded by roosync_manage(action: 'mark_read'). Kept for backward compatibility in registry.ts.
 * Outil MCP : roosync_mark_message_read
 * 
 * Marque un message comme lu en mettant à jour son statut
 * 
 * @module roosync/mark_message_read
 */

import { MessageManager } from '../../services/MessageManager.js';
import { getSharedStatePath } from '../../utils/server-helpers.js';
import { createLogger, Logger } from '../../utils/logger.js';
import { MessageManagerError, MessageManagerErrorCode } from '../../types/errors.js';

// Logger instance for mark_message_read tool
const logger: Logger = createLogger('MarkMessageReadTool');

/**
 * Arguments de l'outil roosync_mark_message_read
 */
interface MarkMessageReadArgs {
  /** ID du message à marquer comme lu */
  message_id: string;
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
 * Marque un message comme lu
 * 
 * @param args Arguments de l'outil
 * @returns Résultat de l'opération
 */
export async function markMessageRead(
  args: MarkMessageReadArgs
): Promise<{ content: Array<{ type: string; text: string }> }> {
  logger.info('🔵 Starting mark message read operation');

  try {
    // Validation des paramètres requis
    if (!args.message_id) {
      throw new MessageManagerError(
        'Paramètre "message_id" requis : ID du message à marquer comme lu',
        MessageManagerErrorCode.INVALID_MESSAGE_FORMAT,
        { missingParam: 'message_id', providedArgs: Object.keys(args) }
      );
    }

    // Initialiser le MessageManager
    const sharedStatePath = getSharedStatePath();
    const messageManager = new MessageManager(sharedStatePath);

    // Vérifier existence du message
    logger.debug('🔍 Checking message existence', { messageId: args.message_id });
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

    // Vérifier si déjà lu
    if (message.status === 'read') {
      return {
        content: [{
          type: 'text',
          text: `ℹ️ **Message déjà marqué comme lu**

**ID :** \`${args.message_id}\`
**Sujet :** ${message.subject}
**De :** ${message.from}
**À :** ${message.to}
**Date :** ${formatDate(message.timestamp)}
**Statut actuel :** ✅ READ

Le message était déjà marqué comme lu. Aucune modification nécessaire.`
        }]
      };
    }

    // Marquer comme lu
    logger.info('✉️ Marking message as read');
    await messageManager.markAsRead(args.message_id);
    
    // Récupérer le message mis à jour
    const updatedMessage = await messageManager.getMessage(args.message_id);

    // Formater le résultat
    let result = `✅ **Message marqué comme lu**\n\n`;
    result += `---\n\n`;
    result += `**ID :** \`${args.message_id}\`\n`;
    result += `**Sujet :** ${message.subject}\n`;
    result += `**De :** ${message.from}\n`;
    result += `**À :** ${message.to}\n`;
    result += `**Date :** ${formatDate(message.timestamp)}\n`;
    result += `**Statut :** 🆕 UNREAD → ✅ READ\n`;
    result += `\n---\n\n`;
    result += `## 💡 Actions disponibles\n\n`;
    result += `- 📦 **Archiver** : Utilisez \`roosync_archive_message\` pour archiver ce message\n`;
    result += `- 💬 **Répondre** : Utilisez \`roosync_reply_message\` pour répondre à ce message\n`;
    result += `- 📋 **Voir détails** : Utilisez \`roosync_get_message\` pour voir le contenu complet\n`;

    logger.info('✅ Message marked as read successfully', { messageId: args.message_id });
    return {
      content: [{ type: 'text', text: result }]
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('❌ Mark message read error', error instanceof Error ? error : new Error(errorMessage));
    
    return {
      content: [{
        type: 'text',
        text: `❌ **Erreur lors du marquage du message**

**Message d'erreur :** ${errorMessage}

**Vérifications :**
- Le répertoire .shared-state est-il accessible ?
- L'ID du message est-il correct ?
- Le message existe-t-il dans inbox/, sent/ ou archive/ ?`
      }]
    };
  }
}