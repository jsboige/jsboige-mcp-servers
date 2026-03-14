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
import { recordRooSyncActivityAsync } from './heartbeat-activity.js';
import {
  formatDate,
  formatDateFull,
  getPriorityIcon,
  getStatusIcon,
  getLocalMachineId,
  getLocalWorkspaceId
} from '../../utils/message-helpers.js';
import { getRooSyncService } from '../../services/RooSyncService.js';
import { AttachmentManager } from '../../services/roosync/AttachmentManager.js';

// Logger instance for read tool
const logger: Logger = createLogger('RooSyncReadTool');

// Throttle fire-and-forget cleanup tasks: run at most once every 5 minutes
const CLEANUP_THROTTLE_MS = 5 * 60 * 1000;
let lastCleanupRunAt = 0;

/**
 * Arguments de l'outil roosync_read
 */
interface RooSyncReadArgs {
  /** Mode de lecture : 'inbox', 'message', ou 'attachments' */
  mode: 'inbox' | 'message' | 'attachments';

  // Pour mode 'inbox'
  /** Filtrer par status (défaut: all) */
  status?: 'unread' | 'read' | 'all';

  /** Nombre maximum de messages à retourner */
  limit?: number;

  /** Page number for pagination (1-based, requires per_page) */
  page?: number;

  /** Messages per page (requires page) */
  per_page?: number;

  // Pour mode 'message' et 'attachments'
  /** ID du message à récupérer (requis si mode='message' ou 'attachments') */
  message_id?: string;

  /** Marquer automatiquement comme lu (défaut: false, mode 'message' uniquement) */
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
  const page = args.page;
  const perPage = args.per_page;

  logger.info('📬 Reading inbox', { machineId: localMachineId, workspaceId: localWorkspaceId, status, limit, page, perPage });

  // Get counts from cache (single scan, no double-read — #638 perf fix)
  const counts = await messageManager.getFilteredCount(localMachineId, 'all', localWorkspaceId);

  // Read messages with pagination
  const messages = await messageManager.readInbox(
    localMachineId, status, limit, localWorkspaceId, page, perPage
  );

  // Fire-and-forget heartbeat update
  getRooSyncService().getHeartbeatService()
    .registerHeartbeat(localMachineId, { lastActivity: 'roosync_read_inbox', messageCount: messages.length })
    .catch(err => logger.debug('Heartbeat update skipped (non-critical)', { error: String(err) }));

  // Throttled fire-and-forget cleanup tasks (run at most once every 5 min)
  const now = Date.now();
  if (now - lastCleanupRunAt > CLEANUP_THROTTLE_MS) {
    lastCleanupRunAt = now;

    // Auto-archive old read messages (#638 Phase 3)
    messageManager.autoArchiveOld(30, true)
      .then(n => { if (n > 0) logger.info(`Auto-archived ${n} old messages`); })
      .catch(err => logger.debug('Auto-archive skipped (non-critical)', { error: String(err) }));

    // Cleanup expired auto-destruct messages (#629)
    messageManager.cleanupExpiredMessages()
      .then(n => { if (n > 0) logger.info(`Destroyed ${n} expired auto-destruct messages`); })
      .catch(err => logger.debug('Auto-destruct cleanup skipped (non-critical)', { error: String(err) }));

    // Expiry reminders for approaching TTL (#629)
    messageManager.sendExpiryReminders()
      .then(n => { if (n > 0) logger.info(`Sent ${n} expiry reminders`); })
      .catch(err => logger.debug('Expiry reminders skipped (non-critical)', { error: String(err) }));
  }

  // Cas : aucun message
  if (messages.length === 0 && counts.total === 0) {
    return `📭 **Aucun message dans votre boîte de réception (${status})**

Votre inbox est vide pour le moment.

**Machine :** ${localMachineId}
**Filtre :** ${status}`;
  }

  // Formater la liste
  let result = `📬 **Boîte de Réception** - ${localMachineId}\n\n`;
  result += `**Total :** ${counts.total} message${counts.total > 1 ? 's' : ''} | `;
  result += `🆕 ${counts.unread} non-lu${counts.unread > 1 ? 's' : ''} | `;
  result += `✅ ${counts.read} lu${counts.read > 1 ? 's' : ''}\n`;

  // Pagination info
  if (page !== undefined && perPage !== undefined) {
    const totalPages = Math.ceil(counts.total / perPage);
    result += `**Page :** ${page}/${totalPages} (${perPage}/page)\n`;
  }
  result += '\n';

  if (messages.length === 0) {
    result += `_Aucun message pour le filtre "${status}" sur cette page._\n`;
    return result;
  }

  // Tableau des messages
  result += `| ID | De | Sujet | Priorité | Status | Date |\n`;
  result += `|----|----|----|----------|--------|------|\n`;

  for (const msg of messages) {
    const fullId = msg.id;
    const maxSubjectLength = 25;
    let shortSubject = msg.subject.length > maxSubjectLength ? msg.subject.substring(0, maxSubjectLength) + '...' : msg.subject;
    // Auto-destruct indicator (#629)
    if ((msg as any).destroyed_at) {
      shortSubject = `💀 ${shortSubject}`;
    } else if ((msg as any).auto_destruct) {
      shortSubject = `⏳ ${shortSubject}`;
    }
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
    result += `**Aperçu :** ${latest.preview}\n\n`;
  }

  result += `---\n\n`;
  result += `**💡 Actions disponibles :**\n`;
  result += `- \`roosync_read\` avec \`mode: "message"\` et l'ID pour lire un message complet\n`;
  result += `- \`roosync_read\` avec \`status: "unread"\` pour voir uniquement les non-lus\n`;
  result += `- \`roosync_read\` avec \`page: 1, per_page: 20\` pour paginer les résultats`;

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

  // Marquer comme lu si demandé (avec tracking per-machine #629)
  if (markAsRead && message.status === 'unread') {
    await messageManager.markAsRead(messageId, getLocalMachineId());
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

  // Auto-destruct info (#629)
  if ((message as any).auto_destruct) {
    result += `\n**🔥 Auto-destruct :** OUI`;
    if ((message as any).destruct_after_read_by?.length) {
      result += ` (après lecture par: ${(message as any).destruct_after_read_by.join(', ')})`;
    }
    if ((message as any).expires_at) {
      const expiresAt = new Date((message as any).expires_at);
      const isExpired = expiresAt.getTime() < Date.now();
      result += `\n**⏰ Expiration :** ${formatDateFull((message as any).expires_at)}${isExpired ? ' ⚠️ EXPIRÉ' : ''}`;
    }
    if ((message as any).destroyed_at) {
      result += `\n**💀 Détruit :** ${formatDateFull((message as any).destroyed_at)} (raison: ${(message as any).destroyed_reason || 'inconnue'})`;
    }
    result += `\n`;
  }

  // Multi-reader tracking (#629)
  if ((message as any).read_by?.length) {
    const readBy = (message as any).read_by as string[];
    const ackAt = (message as any).acknowledged_at as Record<string, string> | undefined;
    result += `\n**👁️ Lu par :** ${readBy.map(m => {
      const ts = ackAt?.[m];
      return ts ? `${m} (${formatDate(ts)})` : m;
    }).join(', ')}\n`;
  }

  result += `\n---\n\n`;
  result += `## 📄 Contenu\n\n`;
  // Show destroyed placeholder or actual body (#629)
  if ((message as any).destroyed_at) {
    result += `_💀 Ce message a été détruit le ${formatDateFull((message as any).destroyed_at)}. Le contenu n'est plus disponible._`;
  } else {
    result += message.body;
  }
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
 * Lit les pièces jointes d'un message
 *
 * @param args Arguments validés pour le mode attachments
 * @returns Contenu formaté des pièces jointes
 */
async function readAttachmentsMode(args: RooSyncReadArgs): Promise<string> {
  const messageId = args.message_id!;

  logger.info('📎 Reading attachments for message', { messageId });

  // Initialiser l'AttachmentManager
  const sharedStatePath = getSharedStatePath();
  const attachmentManager = new AttachmentManager(sharedStatePath);

  // Lister les attachments pour ce message
  const attachments = await attachmentManager.listAttachments(messageId);

  // Cas : aucun attachment
  if (attachments.length === 0) {
    return `📎 **Pièces Jointes** - Message ${messageId}

Aucune pièce jointe pour ce message.

**💡 Actions disponibles :**
- Utilisez \`roosync_send\` avec le paramètre \`attachments\` pour ajouter des fichiers à vos messages
- Utilisez \`roosync_list_attachments\` pour lister toutes les pièces jointes disponibles`;
  }

  // Formatter la liste des attachments
  let result = `📎 **Pièces Jointes** - Message ${messageId}\n\n`;
  result += `**Total :** ${attachments.length} pièce${attachments.length > 1 ? 's' : ''} jointe${attachments.length > 1 ? 's' : ''}\n\n`;

  result += `| UUID | Nom | Taille | Type | Uploadé par | Date |\n`;
  result += `|------|-----|--------|------|-------------|------|\n`;

  for (const att of attachments) {
    const sizeKB = att.sizeBytes < 1024
      ? `${att.sizeBytes} B`
      : att.sizeBytes < 1024 * 1024
      ? `${(att.sizeBytes / 1024).toFixed(1)} KB`
      : `${(att.sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
    result += `| \`${att.uuid}\` | ${att.originalName} | ${sizeKB} | ${att.mimeType} | ${att.uploaderMachineId} | ${formatDate(att.uploadedAt)} |\n`;
  }

  result += `\n---\n\n`;
  result += `**💡 Actions disponibles :**\n`;
  result += `- 📥 **Télécharger** : Utilisez \`roosync_get_attachment\` avec l'UUID et un \`targetPath\`\n`;
  result += `- 🗑️ **Supprimer** : Utilisez \`roosync_delete_attachment\` avec l'UUID\n`;
  result += `- 📋 **Voir détails message** : Utilisez \`roosync_read\` avec \`mode: "message"\` et l'ID du message`;

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
  description: 'Lire la boîte de réception des messages RooSync, obtenir les détails complets d\'un message spécifique, ou lister les pièces jointes d\'un message',
  inputSchema: {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        enum: ['inbox', 'message', 'attachments'],
        description: 'Mode de lecture : inbox (liste des messages), message (détails d\'un message), ou attachments (pièces jointes d\'un message)'
      },
      status: {
        type: 'string',
        enum: ['unread', 'read', 'all'],
        description: 'Filtrer par status (mode inbox, défaut: all)'
      },
      limit: {
        type: 'number',
        description: 'Nombre maximum de messages à retourner (mode inbox). Use page/per_page for pagination instead.'
      },
      page: {
        type: 'number',
        description: 'Page number (1-based) for pagination. Requires per_page.'
      },
      per_page: {
        type: 'number',
        description: 'Messages per page. Requires page. Recommended: 20.'
      },
      message_id: {
        type: 'string',
        description: 'ID du message à récupérer (requis pour mode=message ou mode=attachments)'
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

    if (args.mode !== 'inbox' && args.mode !== 'message' && args.mode !== 'attachments') {
      throw new MessageManagerError(
        `Mode invalide : "${args.mode}". Attendu : "inbox", "message" ou "attachments"`,
        MessageManagerErrorCode.INVALID_MESSAGE_FORMAT,
        { invalidMode: args.mode }
      );
    }

    // Validation spécifique au mode 'message' et 'attachments'
    if ((args.mode === 'message' || args.mode === 'attachments') && !args.message_id) {
      throw new MessageManagerError(
        `Paramètre "message_id" requis pour le mode "${args.mode}"`,
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
    } else if (args.mode === 'message') {
      result = await readMessage(args, messageManager);
    } else {
      result = await readAttachmentsMode(args);
    }

    logger.info('✅ roosync_read operation completed', { mode: args.mode });

    // Enregistrer l'activité comme preuve de vie heartbeat (#501)
    recordRooSyncActivityAsync('read', { mode: args.mode });

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
- Le mode est-il correct ("inbox", "message" ou "attachments") ?
- Si mode="message" ou mode="attachments", l'ID du message est-il fourni ?`
      }]
    };
  }
}
