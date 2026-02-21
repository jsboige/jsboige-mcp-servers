/**
 * Outil MCP : roosync_send
 *
 * Envoi, réponse, et amendement de messages RooSync.
 *
 * @module roosync/send
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
  getLocalFullId
} from '../../utils/message-helpers.js';
import { getRooSyncService } from '../../services/RooSyncService.js';

// Logger instance for send tool
const logger: Logger = createLogger('RooSyncSendTool');

/**
 * Arguments de l'outil roosync_send
 */
interface RooSyncSendArgs {
  /** Mode d'envoi : 'send', 'reply', ou 'amend' */
  action: 'send' | 'reply' | 'amend';

  // Pour action 'send'
  to?: string;
  subject?: string;
  body?: string;
  priority?: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
  tags?: string[];
  thread_id?: string;
  reply_to?: string;

  // Pour action 'reply'
  message_id?: string;

  // Pour action 'amend'
  new_content?: string;
  reason?: string;
}

/**
 * Envoie un nouveau message à une autre machine
 *
 * @param args Arguments de l'outil
 * @param messageManager Instance de MessageManager
 * @returns Résultat de l'envoi
 */
async function sendNewMessage(
  args: RooSyncSendArgs,
  messageManager: MessageManager
): Promise<string> {
  logger.info('🚀 Starting send message operation');

  // Validation des paramètres requis
  if (!args.to) {
    throw new MessageManagerError(
      'Paramètre "to" requis : ID de la machine destinataire',
      MessageManagerErrorCode.INVALID_MESSAGE_FORMAT,
      { missingParam: 'to', providedArgs: Object.keys(args) }
    );
  }

  if (!args.subject) {
    throw new MessageManagerError(
      'Paramètre "subject" requis : Sujet du message',
      MessageManagerErrorCode.INVALID_MESSAGE_FORMAT,
      { missingParam: 'subject', providedArgs: Object.keys(args) }
    );
  }

  if (!args.body) {
    throw new MessageManagerError(
      'Paramètre "body" requis : Corps du message',
      MessageManagerErrorCode.INVALID_MESSAGE_FORMAT,
      { missingParam: 'body', providedArgs: Object.keys(args) }
    );
  }

  // Obtenir l'ID complet local (machine + workspace si configuré)
  const from = getLocalFullId();
  logger.debug('📍 Message routing', { from, to: args.to });

  // Envoyer le message
  const message = await messageManager.sendMessage(
    from,
    args.to,
    args.subject,
    args.body,
    args.priority || 'MEDIUM',
    args.tags,
    args.thread_id,
    args.reply_to
  );

  // Formater le résultat
  const result = `✅ **Message envoyé avec succès**

**ID :** ${message.id}
**De :** ${message.from}
**À :** ${message.to}
**Sujet :** ${message.subject}
**Priorité :** ${getPriorityIcon(message.priority)} ${message.priority}
**Timestamp :** ${formatDate(message.timestamp)}
${args.tags && args.tags.length > 0 ? `**Tags :** ${args.tags.join(', ')}\n` : ''}${args.thread_id ? `**Thread :** ${args.thread_id}\n` : ''}${args.reply_to ? `**En réponse à :** ${args.reply_to}\n` : ''}Le message a été livré dans l'inbox de **${args.to}**.

---

📁 **Fichiers créés :**
- \`messages/inbox/${message.id}.json\` (destinataire)
- \`messages/sent/${message.id}.json\` (expéditeur)

---

## 💡 Actions disponibles

- 📋 **Voir le message** : Utilisez \`roosync_get_message\` avec l'ID \`${message.id}\`
- 📬 **Lire l'inbox** : Utilisez \`roosync_read_inbox\` pour voir les messages reçus
- 📤 **Répondre** : Utilisez \`roosync_send\` avec \`action: reply\` et \`message_id: ${message.id}\``;

  logger.info('✅ Message sent successfully', { messageId: message.id, to: args.to });
  // Fire-and-forget heartbeat update: sending a message proves the machine is active
  getRooSyncService().getHeartbeatService()
    .registerHeartbeat(getLocalMachineId(), { lastActivity: 'roosync_send', messageId: message.id })
    .catch(err => logger.debug('Heartbeat update skipped (non-critical)', { error: String(err) }));
  return result;
}

/**
 * Répond à un message existant
 *
 * @param args Arguments de l'outil
 * @param messageManager Instance de MessageManager
 * @returns Résultat de la réponse
 */
async function replyToMessage(
  args: RooSyncSendArgs,
  messageManager: MessageManager
): Promise<string> {
  logger.info('💬 Starting reply message operation');

  // Validation des paramètres requis
  if (!args.message_id) {
    throw new MessageManagerError(
      'Paramètre "message_id" requis : ID du message auquel répondre',
      MessageManagerErrorCode.INVALID_MESSAGE_FORMAT,
      { missingParam: 'message_id', providedArgs: Object.keys(args) }
    );
  }

  if (!args.body) {
    throw new MessageManagerError(
      'Paramètre "body" requis : Corps de la réponse',
      MessageManagerErrorCode.INVALID_MESSAGE_FORMAT,
      { missingParam: 'body', providedArgs: Object.keys(args) }
    );
  }

  // Récupérer le message original
  logger.debug('🔍 Fetching original message', { messageId: args.message_id });
  const originalMessage = await messageManager.getMessage(args.message_id);

  // Cas : message introuvable
  if (!originalMessage) {
    return `❌ **Message original introuvable**

**ID recherché :** ${args.message_id}

Impossible de répondre car le message original n'a pas été trouvé dans :
- ❌ messages/inbox/
- ❌ messages/sent/
- ❌ messages/archive/

**Suggestions :**
- Vérifiez que l'ID du message est correct
- Le message a peut-être été supprimé
- Utilisez \`roosync_read_inbox\` pour lister les messages disponibles`;
  }

  // Construire la réponse
  logger.debug('💬 Building reply message');

  // Inversion from/to pour la réponse
  const replyFrom = originalMessage.to;
  const replyTo = originalMessage.from;

  // Sujet avec préfixe "Re: "
  const replySubject = originalMessage.subject.startsWith('Re: ')
    ? originalMessage.subject
    : `Re: ${originalMessage.subject}`;

  // Thread ID : utiliser le thread existant ou créer avec l'ID original
  const threadId = originalMessage.thread_id || originalMessage.id;

  // Priorité : utiliser celle fournie ou reprendre celle de l'original
  const priority = args.priority || originalMessage.priority || 'MEDIUM';

  // Tags : ajouter "reply" aux tags fournis
  const replyTags = args.tags ? [...args.tags, 'reply'] : ['reply'];

  // Envoyer la réponse
  logger.info('📤 Sending reply message');
  const replyMessageObj = await messageManager.sendMessage(
    replyFrom,
    replyTo,
    replySubject,
    args.body,
    priority,
    replyTags,
    threadId,
    args.message_id  // reply_to pointe vers l'original
  );

  // Icônes pour le formatage
  const originalPriorityIcon = getPriorityIcon(originalMessage.priority);
  const replyPriorityIcon = getPriorityIcon(priority);

  // Formater le résultat
  let result = `✅ **Réponse envoyée avec succès**

---

## 📨 Message Original

**ID :** \`${originalMessage.id}\`
**Sujet :** ${originalMessage.subject}
**De :** ${originalMessage.from}
**À :** ${originalMessage.to}
**Date :** ${formatDateFull(originalMessage.timestamp)}
**Priorité :** ${originalPriorityIcon} ${originalMessage.priority}`;

  if (originalMessage.tags && originalMessage.tags.length > 0) {
    result += `\n**Tags :** ${originalMessage.tags.map(t => `\`${t}\``).join(', ')}`;
  }

  result += `

---

## 💬 Votre Réponse

**ID :** \`${replyMessageObj.id}\`
**Sujet :** ${replySubject}
**De :** ${replyFrom} *(inversé)*
**À :** ${replyTo} *(inversé)*
**Date :** ${formatDateFull(replyMessageObj.timestamp)}
**Priorité :** ${replyPriorityIcon} ${priority}
**Tags :** ${replyTags.map(t => `\`${t}\``).join(', ')}
**Thread ID :** \`${threadId}\`
**En réponse à :** \`${args.message_id}\`

---

## 📄 Contenu de la Réponse

${args.body}

---

## 💡 Actions disponibles

- 📋 **Voir la réponse** : Utilisez \`roosync_get_message\` avec l'ID \`${replyMessageObj.id}\`
- 🔗 **Voir le thread** : Filtrez par thread_id \`${threadId}\` dans \`roosync_read_inbox\`
- 📦 **Archiver l'original** : Utilisez \`roosync_archive_message\` avec l'ID \`${originalMessage.id}\``;

  logger.info('✅ Reply sent successfully', { replyId: replyMessageObj.id, threadId });
  // Fire-and-forget heartbeat update: sending a reply proves the machine is active
  getRooSyncService().getHeartbeatService()
    .registerHeartbeat(getLocalMachineId(), { lastActivity: 'roosync_reply', messageId: replyMessageObj.id })
    .catch(err => logger.debug('Heartbeat update skipped (non-critical)', { error: String(err) }));
  return result;
}

/**
 * Amende le contenu d'un message envoyé
 *
 * @param args Arguments de l'outil
 * @param messageManager Instance de MessageManager
 * @returns Résultat de l'amendement
 */
async function amendMessage(
  args: RooSyncSendArgs,
  messageManager: MessageManager
): Promise<string> {
  logger.info('✏️ Starting amend message operation');

  // Validation des paramètres requis
  if (!args.message_id) {
    throw new MessageManagerError(
      'Paramètre "message_id" requis : ID du message à modifier',
      MessageManagerErrorCode.INVALID_MESSAGE_FORMAT,
      { missingParam: 'message_id', providedArgs: Object.keys(args) }
    );
  }

  if (!args.new_content) {
    throw new MessageManagerError(
      'Paramètre "new_content" requis : Nouveau contenu du message',
      MessageManagerErrorCode.INVALID_MESSAGE_FORMAT,
      { missingParam: 'new_content', providedArgs: Object.keys(args) }
    );
  }

  // Obtenir l'ID complet local (émetteur, inclut workspace si configuré)
  const senderId = getLocalFullId();
  logger.debug('🔐 Sender ID identified', { senderId });

  // Amender le message via MessageManager
  logger.info('✏️ Amending message', { messageId: args.message_id });
  const result = await messageManager.amendMessage(
    args.message_id,
    senderId,
    args.new_content,
    args.reason
  );

  // Formater le résultat
  const successMessage = `✅ **Message amendé avec succès**

**ID :** \`${result.message_id}\`
**Amendé le :** ${formatDateFull(result.amended_at)}
**Raison :** ${result.reason || 'Non spécifiée'}

📋 **Contenu original préservé :** ${result.original_content_preserved ? '✅ Oui (sauvegardé dans metadata)' : '❌ Non'}

---

## 📝 Informations importantes

Le message a été mis à jour dans :
- ✅ \`messages/sent/${result.message_id}.json\` (expéditeur)
- ✅ \`messages/inbox/${result.message_id}.json\` (destinataire, si présent)

Le destinataire verra le **nouveau contenu** lorsqu'il lira le message.

Le **contenu original** est préservé dans \`metadata.original_content\` pour traçabilité.

---

## ⚠️ Contraintes

- ❌ Impossible d'amender un message déjà lu
- ❌ Impossible d'amender un message archivé
- ✅ Seul l'émetteur peut amender ses messages
- ✅ Amendements multiples possibles (original toujours préservé)

---

## 💡 Actions disponibles

- 📋 **Voir le message** : Utilisez \`roosync_get_message\` avec l'ID \`${result.message_id}\`
- 📬 **Lire l'inbox** : Utilisez \`roosync_read_inbox\` pour voir les messages reçus`;

  logger.info('✅ Message amended successfully', { messageId: args.message_id });
  return successMessage;
}

/**
 * Fonction principale de l'outil roosync_send
 *
 * Route vers la fonction appropriée selon l'action demandée
 *
 * @param args Arguments de l'outil
 * @returns Résultat de l'opération
 */
/**
 * Métadonnées de l'outil roosync_send pour enregistrement MCP
 */
export const sendToolMetadata = {
  name: 'roosync_send',
  description: 'Envoyer un message structuré, répondre à un message existant, ou amender un message envoyé via RooSync',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['send', 'reply', 'amend'],
        description: 'Action à effectuer : send (nouveau message), reply (répondre), amend (modifier)'
      },
      to: {
        type: 'string',
        description: 'Destinataire : machine (ex: myia-ai-01) ou machine:workspace (ex: myia-ai-01:roo-extensions). Requis pour action=send'
      },
      subject: {
        type: 'string',
        description: 'Sujet du message. Requis pour action=send'
      },
      body: {
        type: 'string',
        description: 'Corps du message (markdown supporté). Requis pour action=send et reply'
      },
      priority: {
        type: 'string',
        enum: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'],
        description: 'Priorité du message (défaut: MEDIUM)'
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Tags optionnels pour catégoriser le message'
      },
      thread_id: {
        type: 'string',
        description: 'ID du thread pour regrouper les messages'
      },
      reply_to: {
        type: 'string',
        description: 'ID du message auquel on répond (pour action=send)'
      },
      message_id: {
        type: 'string',
        description: 'ID du message (requis pour action=reply et amend)'
      },
      new_content: {
        type: 'string',
        description: 'Nouveau contenu du message (requis pour action=amend)'
      },
      reason: {
        type: 'string',
        description: 'Raison de l\'amendement (optionnel, pour action=amend)'
      }
    },
    required: ['action']
  }
};

export async function roosyncSend(
  args: RooSyncSendArgs
): Promise<{ content: Array<{ type: string; text: string }> }> {
  logger.info('🚀 RooSync Send tool called', { action: args.action });

  try {
    // Validation du mode
    if (!args.action) {
      throw new MessageManagerError(
        'Paramètre "action" requis : send, reply, ou amend',
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
      case 'send':
        result = await sendNewMessage(args, messageManager);
        break;

      case 'reply':
        result = await replyToMessage(args, messageManager);
        break;

      case 'amend':
        result = await amendMessage(args, messageManager);
        break;

      default:
        throw new MessageManagerError(
          `Action non reconnue : ${args.action}. Actions valides : send, reply, amend`,
          MessageManagerErrorCode.INVALID_MESSAGE_FORMAT,
          { action: args.action }
        );
    }

    return {
      content: [{ type: 'text', text: result }]
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('❌ RooSync Send error', error instanceof Error ? error : new Error(errorMessage));

    return {
      content: [{
        type: 'text',
        text: `❌ **Erreur lors de l'opération RooSync Send**

**Action :** ${args.action}
**Message d'erreur :** ${errorMessage}

**Vérifications :**
- Le répertoire .shared-state est-il accessible ?
- Le fichier sync-config.json existe-t-il ?
- Les permissions d'écriture sont-elles correctes ?
- Les paramètres fournis sont-ils valides ?

**Suggestions :**
- Vérifiez que l'action est correcte (send, reply, amend)
- Pour \`send\` : to, subject, body sont requis
- Pour \`reply\` : message_id, body sont requis
- Pour \`amend\` : message_id, new_content sont requis`
      }]
    };
  }
}
