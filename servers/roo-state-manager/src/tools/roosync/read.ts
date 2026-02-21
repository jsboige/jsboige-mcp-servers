/**
 * Outil MCP : roosync_read
 *
 * Lecture des messages RooSync (inbox, message spécifique).
 *
 * @module roosync/read
 * @version 1.0.0
 */

import { MessageManager } from '../../services/MessageManager.js';
import { getSharedStatePath } from '../../utils/server-helpers.js';
import { createLogger, Logger } from '../../utils/logger.js';
import { MessageManagerError, MessageManagerErrorCode } from '../../types/errors.js';
import {
  formatDate,
  formatDateFull,
  getPriorityIcon,
  getStatusIcon,
  getLocalMachineId,
  getLocalWorkspaceId
} from '../../utils/message-helpers.js';
import { getRooSyncService } from '../../services/RooSyncService.js';

// Logger instance for read tool
const logger: Logger = createLogger('RooSyncReadTool');

/**
 * Arguments de l'outil roosync_read
 */
interface RooSyncReadArgs {
  /** Mode de lecture : 'inbox' ou 'message' */
  mode: 'inbox' | 'message';

  // Pour mode 'inbox'
  /** Filtrer par status (défaut: all) */
  status?: 'unread' | 'read' | 'all';

  /** Nombre maximum de messages à retourner */
  limit?: number;

  // Pour mode 'message'
  /** ID du message à récupérer (requis si mode='message') */
  message_id?: string;

  /** Marquer automatiquement comme lu (défaut: false) */
  mark_as_read?: boolean;
}

/**
 * Lit la boîte de réception de messages
 *
 * @param args Arguments validés pour le mode inbox
 * @param messageManager Instance du MessageManager
 * @returns Contenu formaté de l'inbox
 */
async function readInboxMode(
  args: RooSyncReadArgs,
  messageManager: MessageManager
): Promise<string> {
  const localMachineId = getLocalMachineId();
  const localWorkspaceId = getLocalWorkspaceId();
  const status = args.status || 'all';
  const limit = args.limit;

  logger.info('📬 Reading inbox', { machineId: localMachineId, workspaceId: localWorkspaceId, status, limit });

  // Lire les messages via MessageManager (workspace-aware)
  const messages = await messageManager.readInbox(localMachineId, status, limit, localWorkspaceId);

  // Fire-and-forget heartbeat update: reading inbox proves the machine is active
  getRooSyncService().getHeartbeatService()
    .registerHeartbeat(localMachineId, { lastActivity: 'roosync_read_inbox', messageCount: messages.length })
    .catch(err => logger.debug('Heartbeat update skipped (non-critical)', { error: String(err) }));

  // Cas : aucun message
  if (messages.length === 0) {
    return `📭 **Aucun message dans votre boîte de réception (${status})**

Votre inbox est vide pour le moment.

**Machine :** ${localMachineId}
**Filtre :** ${status}`;
  }

  // Pour les compteurs, on doit refaire la requête sans filtre
  const allMessages = status !== 'all'
    ? await messageManager.readInbox(localMachineId, 'all', undefined, localWorkspaceId)
    : messages;

  const totalMessages = allMessages.length;
  const unreadMessages = allMessages.filter(msg => msg.status === 'unread').length;
  const readMessages = allMessages.filter(msg => msg.status === 'read').length;

  // Formater la liste
  let result = `📬 **Boîte de Réception** - ${localMachineId}\n\n`;
  result += `**Total :** ${totalMessages} message${totalMessages > 1 ? 's' : ''} | `;
  result += `🆕 ${unreadMessages} non-lu${unreadMessages > 1 ? 's' : ''} | `;
  result += `✅ ${readMessages} lu${readMessages > 1 ? 's' : ''}\n\n`;

  // Tableau des messages
  result += `| ID | De | Sujet | Priorité | Status | Date |\n`;
  result += `|----|----|----|----------|--------|------|\n`;

  for (const msg of messages) {
    // BUG FIX: Afficher l'ID complet (critique pour roosync_read mode message)
    const fullId = msg.id;
    const maxSubjectLength = 25;
    const shortSubject = msg.subject.length > maxSubjectLength ? msg.subject.substring(0, maxSubjectLength) + '...' : msg.subject;
    result += `| ${fullId} | ${msg.from} | ${shortSubject} | ${getPriorityIcon(msg.priority)} ${msg.priority} | ${getStatusIcon(msg.status)} ${msg.status} | ${formatDate(msg.timestamp)} |\n`;
  }

  result += `\n---\n\n`;

  // Aperçu du message le plus récent
  if (messages.length > 0) {
    const latest = messages[0];
    result += `**📋 Aperçu du message le plus récent :**\n\n`;
    result += `**De :** ${latest.from}\n`;
    result += `**Sujet :** ${latest.subject}\n`;
    result += `**Priorité :** ${getPriorityIcon(latest.priority)} ${latest.priority}\n`;

    // Tronquer le preview
    result += `**Aperçu :** ${latest.preview}\n\n`;
  }

  result += `---\n\n`;
  result += `**💡 Actions disponibles :**\n`;
  result += `- \`roosync_read\` avec \`mode: "message"\` et l'ID pour lire un message complet\n`;
  result += `- \`roosync_read\` avec \`status: "unread"\` pour voir uniquement les non-lus\n`;
  result += `- \`roosync_read\` avec \`limit: 5\` pour limiter le nombre de résultats`;

  return result;
}

/**
 * Obtient les détails complets d'un message spécifique
 *
 * @param args Arguments validés pour le mode message
 * @param messageManager Instance du MessageManager
 * @returns Contenu formaté du message
 */
async function readMessage(
  args: RooSyncReadArgs,
  messageManager: MessageManager
): Promise<string> {
  const messageId = args.message_id!;
  const markAsRead = args.mark_as_read || false;

  logger.info('🔍 Reading message', { messageId, markAsRead });

  // Récupérer le message
  const message = await messageManager.getMessage(messageId);

  // Cas : message introuvable
  if (!message) {
    return `❌ **Message introuvable**

**ID recherché :** ${messageId}

Le message n'a pas été trouvé dans :
- ❌ messages/inbox/
- ❌ messages/sent/
- ❌ messages/archive/

**Suggestions :**
- Vérifiez que l'ID du message est correct
- Le message a peut-être été supprimé
- Utilisez \`roosync_read\` avec \`mode: "inbox"\` pour lister les messages disponibles`;
  }

  // Marquer comme lu si demandé
  if (markAsRead && message.status === 'unread') {
    await messageManager.markAsRead(messageId);
    message.status = 'read';
  }

  // Formater le message complet
  let result = `# 📨 Message : ${message.subject}\n\n`;
  result += `---\n\n`;
  result += `**Status :** ${getStatusIcon(message.status)} ${message.status.toUpperCase()}\n`;
  result += `**Priorité :** ${getPriorityIcon(message.priority)} ${message.priority}\n`;
  result += `**De :** ${message.from}\n`;
  result += `**À :** ${message.to}\n`;
  result += `**Date :** ${formatDateFull(message.timestamp)}\n`;
  result += `**ID :** \`${message.id}\`\n`;

  // Tags
  if (message.tags && message.tags.length > 0) {
    result += `**Tags :** ${message.tags.join(', ')}\n`;
  }

  // Thread
  if (message.thread_id) {
    result += `**Thread :** ${message.thread_id}\n`;
  }

  // En réponse à
  if (message.reply_to) {
    result += `**En réponse à :** ${message.reply_to}\n`;
  }

  result += `\n---\n\n`;
  result += `## 📄 Contenu\n\n`;
  result += message.body;
  result += `\n\n---\n\n`;
  result += `## 💡 Actions disponibles\n\n`;

  if (message.status === 'unread') {
    result += `- ✉️ **Marquer comme lu** : Utilisez \`roosync_manage\` avec \`action: "mark_read"\`\n`;
  }

  result += `- 📦 **Archiver** : Utilisez \`roosync_manage\` avec \`action: "archive"\`\n`;
  result += `- 💬 **Répondre** : Utilisez \`roosync_send\` avec \`action: "reply"\` et \`message_id: "${message.id}"\`\n`;

  if (message.thread_id) {
    result += `- 🔗 **Voir le thread** : Utilisez \`roosync_read\` avec \`mode: "inbox"\` puis filtrez par thread_id\n`;
  }

  return result;
}

/**
 * Outil principal roosync_read
 *
 * @param args Arguments de l'outil
 * @returns Résultat formaté
 */
/**
 * Métadonnées de l'outil roosync_read pour enregistrement MCP
 */
export const readToolMetadata = {
  name: 'roosync_read',
  description: 'Lire la boîte de réception des messages RooSync ou obtenir les détails complets d\'un message spécifique',
  inputSchema: {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        enum: ['inbox', 'message'],
        description: 'Mode de lecture : inbox (liste des messages) ou message (détails d\'un message)'
      },
      status: {
        type: 'string',
        enum: ['unread', 'read', 'all'],
        description: 'Filtrer par status (mode inbox, défaut: all)'
      },
      limit: {
        type: 'number',
        description: 'Nombre maximum de messages à retourner (mode inbox)'
      },
      message_id: {
        type: 'string',
        description: 'ID du message à récupérer (requis pour mode=message)'
      },
      mark_as_read: {
        type: 'boolean',
        description: 'Marquer automatiquement comme lu (mode message, défaut: false)'
      }
    },
    required: ['mode']
  }
};

export async function roosyncRead(
  args: RooSyncReadArgs
): Promise<{ content: Array<{ type: string; text: string }> }> {
  logger.info('🔄 Starting roosync_read operation', { mode: args.mode });

  try {
    // Validation du mode
    if (!args.mode) {
      throw new MessageManagerError(
        'Paramètre "mode" requis : "inbox" ou "message"',
        MessageManagerErrorCode.INVALID_MESSAGE_FORMAT,
        { missingParam: 'mode', providedArgs: Object.keys(args) }
      );
    }

    if (args.mode !== 'inbox' && args.mode !== 'message') {
      throw new MessageManagerError(
        `Mode invalide : "${args.mode}". Attendu : "inbox" ou "message"`,
        MessageManagerErrorCode.INVALID_MESSAGE_FORMAT,
        { invalidMode: args.mode }
      );
    }

    // Validation spécifique au mode 'message'
    if (args.mode === 'message' && !args.message_id) {
      throw new MessageManagerError(
        'Paramètre "message_id" requis pour le mode "message"',
        MessageManagerErrorCode.INVALID_MESSAGE_FORMAT,
        { missingParam: 'message_id', mode: args.mode }
      );
    }

    // Initialiser le MessageManager
    const sharedStatePath = getSharedStatePath();
    const messageManager = new MessageManager(sharedStatePath);

    // Router selon le mode
    let result: string;
    if (args.mode === 'inbox') {
      result = await readInboxMode(args, messageManager);
    } else {
      result = await readMessage(args, messageManager);
    }

    logger.info('✅ roosync_read operation completed', { mode: args.mode });

    return {
      content: [{ type: 'text', text: result }]
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('❌ roosync_read error', error instanceof Error ? error : new Error(errorMessage));

    return {
      content: [{
        type: 'text',
        text: `❌ **Erreur lors de la lecture**

**Mode :** ${args.mode}
**Message d'erreur :** ${errorMessage}

**Vérifications :**
- Le répertoire .shared-state est-il accessible ?
- Le mode est-il correct ("inbox" ou "message") ?
- Si mode="message", l'ID du message est-il fourni ?`
      }]
    };
  }
}
