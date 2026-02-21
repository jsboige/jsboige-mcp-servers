/**
 * Outil MCP : roosync_manage
 *
 * Gestion du cycle de vie des messages RooSync (marquer lu, archiver).
 *
 * @module roosync/manage
 * @version 1.0.0
 */

import { MessageManager } from '../../services/MessageManager.js';
import { getSharedStatePath } from '../../utils/server-helpers.js';
import { createLogger, Logger } from '../../utils/logger.js';
import { MessageManagerError, MessageManagerErrorCode } from '../../types/errors.js';
import {
  formatDate,
  formatDateFull,
  getLocalMachineId
} from '../../utils/message-helpers.js';
import { getRooSyncService } from '../../services/RooSyncService.js';

// Logger instance for manage tool
const logger: Logger = createLogger('RooSyncManageTool');

/**
 * Arguments de l'outil roosync_manage
 */
interface RooSyncManageArgs {
  /** Action à effectuer : 'mark_read' ou 'archive' */
  action: 'mark_read' | 'archive';

  /** ID du message à traiter */
  message_id: string;
}

/**
 * Marque un message comme lu
 *
 * @param args Arguments de l'outil
 * @param messageManager Instance de MessageManager
 * @returns Résultat de l'opération
 */
async function markMessageAsRead(
  args: RooSyncManageArgs,
  messageManager: MessageManager
): Promise<string> {
  logger.info('🔵 Starting mark message read operation');

  // Validation des paramètres requis
  if (!args.message_id) {
    throw new MessageManagerError(
      'Paramètre "message_id" requis : ID du message à marquer comme lu',
      MessageManagerErrorCode.INVALID_MESSAGE_FORMAT,
      { missingParam: 'message_id', providedArgs: Object.keys(args) }
    );
  }

  // Vérifier existence du message
  logger.debug('🔍 Checking message existence', { messageId: args.message_id });
  const message = await messageManager.getMessage(args.message_id);

  // Cas : message introuvable
  if (!message) {
    return `❌ **Message introuvable**

**ID recherché :** ${args.message_id}

Le message n'a pas été trouvé dans :
- ❌ messages/inbox/
- ❌ messages/sent/
- ❌ messages/archive/

**Suggestions :**
- Vérifiez que l'ID du message est correct
- Le message a peut-être été supprimé
- Utilisez \`roosync_read\` avec \`action: inbox\` pour lister les messages disponibles`;
  }

  // Vérifier si déjà lu
  if (message.status === 'read') {
    return `ℹ️ **Message déjà marqué comme lu**

**ID :** \`${args.message_id}\`
**Sujet :** ${message.subject}
**De :** ${message.from}
**À :** ${message.to}
**Date :** ${formatDateFull(message.timestamp)}
**Statut actuel :** ✅ READ

Le message était déjà marqué comme lu. Aucune modification nécessaire.`;
  }

  // Marquer comme lu
  logger.info('✉️ Marking message as read');
  await messageManager.markAsRead(args.message_id);

  // Fire-and-forget heartbeat update: marking a message read proves the machine is active
  getRooSyncService().getHeartbeatService()
    .registerHeartbeat(getLocalMachineId(), { lastActivity: 'roosync_mark_read', messageId: args.message_id })
    .catch(err => logger.debug('Heartbeat update skipped (non-critical)', { error: String(err) }));

  // Formater le résultat
  const result = `✅ **Message marqué comme lu**

---

**ID :** \`${args.message_id}\`
**Sujet :** ${message.subject}
**De :** ${message.from}
**À :** ${message.to}
**Date :** ${formatDateFull(message.timestamp)}
**Statut :** 🆕 UNREAD → ✅ READ

---

## 💡 Actions disponibles

- 📦 **Archiver** : Utilisez \`roosync_manage\` avec \`action: archive\`
- 💬 **Répondre** : Utilisez \`roosync_send\` avec \`action: reply\`
- 📋 **Voir détails** : Utilisez \`roosync_read\` avec \`action: message\``;

  logger.info('✅ Message marked as read successfully', { messageId: args.message_id });
  return result;
}

/**
 * Archive un message
 *
 * @param args Arguments de l'outil
 * @param messageManager Instance de MessageManager
 * @returns Résultat de l'opération
 */
async function archiveMessageFunc(
  args: RooSyncManageArgs,
  messageManager: MessageManager
): Promise<string> {
  logger.info('📦 Starting archive message operation');

  // Validation des paramètres requis
  if (!args.message_id) {
    throw new MessageManagerError(
      'Paramètre "message_id" requis : ID du message à archiver',
      MessageManagerErrorCode.INVALID_MESSAGE_FORMAT,
      { missingParam: 'message_id', providedArgs: Object.keys(args) }
    );
  }

  // Vérifier existence du message
  logger.debug('🔍 Checking message existence', { messageId: args.message_id });
  const message = await messageManager.getMessage(args.message_id);

  // Cas : message introuvable
  if (!message) {
    return `❌ **Message introuvable**

**ID recherché :** ${args.message_id}

Le message n'a pas été trouvé dans :
- ❌ messages/inbox/
- ❌ messages/sent/
- ❌ messages/archive/

**Suggestions :**
- Vérifiez que l'ID du message est correct
- Le message a peut-être été supprimé
- Utilisez \`roosync_read\` avec \`action: inbox\` pour lister les messages disponibles`;
  }

  // Vérifier si déjà archivé
  if (message.status === 'archived') {
    return `ℹ️ **Message déjà archivé**

**ID :** \`${args.message_id}\`
**Sujet :** ${message.subject}
**De :** ${message.from}
**À :** ${message.to}
**Date :** ${formatDateFull(message.timestamp)}
**Statut actuel :** 📦 ARCHIVED

Le message est déjà archivé. Il se trouve dans le dossier \`messages/archive/\`.

**Actions disponibles :**
- 📋 Utilisez \`roosync_read\` avec \`action: message\` pour voir le contenu complet`;
  }

  // Archiver le message
  logger.info('📦 Archiving message');
  await messageManager.archiveMessage(args.message_id);

  // Fire-and-forget heartbeat update: archiving a message proves the machine is active
  getRooSyncService().getHeartbeatService()
    .registerHeartbeat(getLocalMachineId(), { lastActivity: 'roosync_archive', messageId: args.message_id })
    .catch(err => logger.debug('Heartbeat update skipped (non-critical)', { error: String(err) }));

  // Date d'archivage
  const archivedAt = new Date().toISOString();
  const previousStatus = message.status === 'read' ? '✅ READ' : '🆕 UNREAD';

  // Formater le résultat
  let result = `✅ **Message archivé avec succès**

---

**ID :** \`${args.message_id}\`
**Sujet :** ${message.subject}
**De :** ${message.from}
**À :** ${message.to}
**Date d'envoi :** ${formatDateFull(message.timestamp)}
**Date d'archivage :** ${formatDateFull(archivedAt)}
**Statut :** ${previousStatus} → 📦 ARCHIVED

---

## 📁 Emplacement

Le message a été déplacé vers :
\`messages/archive/${args.message_id}.json\`

Il n'apparaîtra plus dans la boîte de réception (\`roosync_read\`).

---

## 💡 Actions disponibles

- 📋 **Voir détails** : Utilisez \`roosync_read\` avec \`action: message\` et \`message_id: ${args.message_id}\``;

  if (message.thread_id) {
    result += `\n- 🔗 **Voir le thread** : Filtrez les messages par thread_id \`${message.thread_id}\``;
  }

  logger.info('✅ Message archived successfully', { messageId: args.message_id });
  return result;
}

/**
 * Fonction principale de l'outil roosync_manage
 *
 * Route vers la fonction appropriée selon l'action demandée
 *
 * @param args Arguments de l'outil
 * @returns Résultat de l'opération
 */
/**
 * Métadonnées de l'outil roosync_manage pour enregistrement MCP
 */
export const manageToolMetadata = {
  name: 'roosync_manage',
  description: 'Gérer le cycle de vie des messages RooSync : marquer comme lu ou archiver',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['mark_read', 'archive'],
        description: 'Action à effectuer sur le message'
      },
      message_id: {
        type: 'string',
        description: 'ID du message à traiter'
      }
    },
    required: ['action', 'message_id']
  }
};

export async function roosyncManage(
  args: RooSyncManageArgs
): Promise<{ content: Array<{ type: string; text: string }> }> {
  logger.info('🚀 RooSync Manage tool called', { action: args.action });

  try {
    // Validation du mode
    if (!args.action) {
      throw new MessageManagerError(
        'Paramètre "action" requis : mark_read ou archive',
        MessageManagerErrorCode.INVALID_MESSAGE_FORMAT,
        { missingParam: 'action', providedArgs: Object.keys(args) }
      );
    }

    // Initialiser le MessageManager
    const sharedStatePath = getSharedStatePath();
    const messageManager = new MessageManager(sharedStatePath);

    // Routing selon action
    let result: string;

    switch (args.action) {
      case 'mark_read':
        result = await markMessageAsRead(args, messageManager);
        break;

      case 'archive':
        result = await archiveMessageFunc(args, messageManager);
        break;

      default:
        throw new MessageManagerError(
          `Action non reconnue : ${args.action}. Actions valides : mark_read, archive`,
          MessageManagerErrorCode.INVALID_MESSAGE_FORMAT,
          { action: args.action }
        );
    }

    return {
      content: [{ type: 'text', text: result }]
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('❌ RooSync Manage error', error instanceof Error ? error : new Error(errorMessage));

    return {
      content: [{
        type: 'text',
        text: `❌ **Erreur lors de l'opération RooSync Manage**

**Action :** ${args.action}
**Message d'erreur :** ${errorMessage}

**Vérifications :**
- Le répertoire .shared-state est-il accessible ?
- L'ID du message est-il correct ?
- Le message existe-t-il ?
- Les permissions d'écriture sont-elles correctes ?

**Suggestions :**
- Vérifiez que l'action est correcte (mark_read, archive)
- Pour \`mark_read\` : message_id est requis
- Pour \`archive\` : message_id est requis`
      }]
    };
  }
}
