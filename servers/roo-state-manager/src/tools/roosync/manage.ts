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
import { recordRooSyncActivityAsync } from './heartbeat-activity.js';
import {
  formatDate,
  formatDateFull,
  getLocalMachineId,
  parseMachineWorkspace
} from '../../utils/message-helpers.js';
import { getRooSyncService } from '../../services/RooSyncService.js';

// Logger instance for manage tool
const logger: Logger = createLogger('RooSyncManageTool');

/**
 * Arguments de l'outil roosync_manage
 */
interface RooSyncManageArgs {
  /** Action à effectuer */
  action: 'mark_read' | 'archive' | 'bulk_mark_read' | 'bulk_archive' | 'cleanup' | 'stats';

  /** ID du message à traiter (required for mark_read/archive) */
  message_id?: string;

  // Bulk operation filters (for bulk_mark_read, bulk_archive, cleanup)
  /** Filter by sender machine ID (substring match) */
  from?: string;
  /** Filter by priority level */
  priority?: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
  /** Filter messages older than this date (ISO-8601 or YYYY-MM-DD) */
  before_date?: string;
  /** Filter by subject substring (case-insensitive) */
  subject_contains?: string;
  /** Filter by tag */
  tag?: string;
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

  // Vérifier si déjà lu (per-machine for broadcasts #629)
  const localMachine = getLocalMachineId();
  const isBroadcast = message.to === 'all' || message.to === 'All';
  const alreadyReadByMe = isBroadcast
    ? (message.read_by?.includes(parseMachineWorkspace(localMachine).machineId) ?? false)
    : message.status === 'read';

  if (alreadyReadByMe) {
    return `ℹ️ **Message déjà marqué comme lu**

**ID :** \`${args.message_id}\`
**Sujet :** ${message.subject}
**De :** ${message.from}
**À :** ${message.to}
**Date :** ${formatDateFull(message.timestamp)}
**Statut actuel :** ✅ READ${isBroadcast && message.read_by ? ` (lu par ${message.read_by.length} machine(s): ${message.read_by.join(', ')})` : ''}

Le message était déjà marqué comme lu. Aucune modification nécessaire.`;
  }

  // Marquer comme lu (avec tracking per-machine #629)
  logger.info('✉️ Marking message as read');
  await messageManager.markAsRead(args.message_id, localMachine);

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
 * Performs a bulk mark_read or bulk_archive operation with filters
 */
async function bulkOperationHandler(
  args: RooSyncManageArgs,
  messageManager: MessageManager,
  operation: 'mark_read' | 'archive'
): Promise<string> {
  const opName = operation === 'mark_read' ? 'marquer comme lus' : 'archiver';
  logger.info(`🔄 Starting bulk ${operation}`, { filters: { from: args.from, priority: args.priority, before_date: args.before_date, subject_contains: args.subject_contains, tag: args.tag } });

  const result = await messageManager.bulkOperation(
    getLocalMachineId(),
    operation,
    {
      from: args.from,
      priority: args.priority,
      before_date: args.before_date,
      subject_contains: args.subject_contains,
      tag: args.tag,
      status: operation === 'mark_read' ? 'unread' : undefined
    }
  );

  const filtersDesc: string[] = [];
  if (args.from) filtersDesc.push(`de: ${args.from}`);
  if (args.priority) filtersDesc.push(`priorité: ${args.priority}`);
  if (args.before_date) filtersDesc.push(`avant: ${args.before_date}`);
  if (args.subject_contains) filtersDesc.push(`sujet contient: "${args.subject_contains}"`);
  if (args.tag) filtersDesc.push(`tag: ${args.tag}`);

  return `✅ **Opération bulk terminée : ${opName}**

---

**Filtres appliqués :** ${filtersDesc.length > 0 ? filtersDesc.join(', ') : 'aucun (tous les messages)'}
**Messages trouvés :** ${result.matched}
**Messages traités :** ${result.processed}
**Erreurs :** ${result.errors}

${result.message_ids.length > 0 ? `**IDs traités :** ${result.message_ids.slice(0, 10).map(id => `\`${id}\``).join(', ')}${result.message_ids.length > 10 ? ` ... et ${result.message_ids.length - 10} autres` : ''}` : '**Aucun message ne correspond aux filtres.**'}`;
}

/**
 * Cleanup action: auto-mark test messages and old LOW priority messages
 */
async function cleanupMessages(
  args: RooSyncManageArgs,
  messageManager: MessageManager
): Promise<string> {
  logger.info('🧹 Starting cleanup operation');
  const machineId = getLocalMachineId();
  const results: string[] = [];

  // 1. Mark test messages as read
  const testResult = await messageManager.bulkOperation(
    machineId, 'mark_read',
    { from: 'test', status: 'unread' }
  );
  if (testResult.processed > 0) {
    results.push(`- 🧪 Messages de test marqués lus : **${testResult.processed}**`);
  }

  // 2. Archive old read messages (>30 days)
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const oldReadResult = await messageManager.bulkOperation(
    machineId, 'archive',
    { before_date: thirtyDaysAgo.toISOString(), status: 'read' }
  );
  if (oldReadResult.processed > 0) {
    results.push(`- 📦 Messages lus >30j archivés : **${oldReadResult.processed}**`);
  }

  // 3. Mark old LOW priority messages as read (>7 days)
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const oldLowResult = await messageManager.bulkOperation(
    machineId, 'mark_read',
    { before_date: sevenDaysAgo.toISOString(), priority: 'LOW', status: 'unread' }
  );
  if (oldLowResult.processed > 0) {
    results.push(`- 📭 Messages LOW >7j marqués lus : **${oldLowResult.processed}**`);
  }

  // 4. Get current stats
  const stats = await messageManager.getInboxStats(machineId);

  return `🧹 **Cleanup terminé**

---

${results.length > 0 ? `### Actions effectuées\n${results.join('\n')}` : '### Aucune action nécessaire\nTous les messages sont déjà dans un état propre.'}

### État de la boîte après cleanup

| Métrique | Valeur |
|----------|--------|
| **Total inbox** | ${stats.total} |
| **Non-lus** | ${stats.unread} |
| **Lus** | ${stats.read} |
${stats.oldest_unread ? `| **Plus ancien non-lu** | ${formatDate(stats.oldest_unread)} |` : ''}

### Par priorité
${Object.entries(stats.by_priority).map(([p, c]) => `- ${p}: ${c}`).join('\n') || '- (vide)'}

### Par expéditeur (top 5)
${Object.entries(stats.by_sender).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([s, c]) => `- ${s}: ${c}`).join('\n') || '- (vide)'}`;
}

/**
 * Stats action: show inbox statistics
 */
async function showStats(
  messageManager: MessageManager
): Promise<string> {
  logger.info('📊 Getting inbox stats');
  const machineId = getLocalMachineId();
  const stats = await messageManager.getInboxStats(machineId);

  return `📊 **Statistiques inbox - ${machineId}**

---

| Métrique | Valeur |
|----------|--------|
| **Total** | ${stats.total} |
| **Non-lus** | ${stats.unread} |
| **Lus** | ${stats.read} |
${stats.oldest_unread ? `| **Plus ancien non-lu** | ${formatDate(stats.oldest_unread)} |` : ''}

### Par priorité
${Object.entries(stats.by_priority).map(([p, c]) => `| ${p} | ${c} |`).join('\n') || '(aucun)'}

### Par expéditeur
${Object.entries(stats.by_sender).sort((a, b) => b[1] - a[1]).map(([s, c]) => `| ${s} | ${c} |`).join('\n') || '(aucun)'}

---

**Actions disponibles :**
- \`roosync_manage(action: "cleanup")\` - Nettoyage automatique
- \`roosync_manage(action: "bulk_mark_read", from: "test")\` - Marquer test messages
- \`roosync_manage(action: "bulk_archive", before_date: "2026-02-01")\` - Archiver anciens`;
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
  description: 'Gérer le cycle de vie des messages RooSync : marquer lu, archiver, opérations bulk, cleanup automatique, statistiques inbox',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['mark_read', 'archive', 'bulk_mark_read', 'bulk_archive', 'cleanup', 'stats'],
        description: 'Action: mark_read/archive (un message), bulk_mark_read/bulk_archive (avec filtres), cleanup (auto-nettoyage), stats (statistiques inbox)'
      },
      message_id: {
        type: 'string',
        description: 'ID du message (requis pour mark_read/archive)'
      },
      from: {
        type: 'string',
        description: 'Filtre par expéditeur (substring, pour bulk/cleanup)'
      },
      priority: {
        type: 'string',
        enum: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'],
        description: 'Filtre par priorité (pour bulk)'
      },
      before_date: {
        type: 'string',
        description: 'Filtre messages avant cette date ISO-8601 (pour bulk)'
      },
      subject_contains: {
        type: 'string',
        description: 'Filtre par sujet contenant ce texte (pour bulk)'
      },
      tag: {
        type: 'string',
        description: 'Filtre par tag (pour bulk)'
      }
    },
    required: ['action']
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
        if (!args.message_id) {
          throw new MessageManagerError(
            'Paramètre "message_id" requis pour mark_read',
            MessageManagerErrorCode.INVALID_MESSAGE_FORMAT,
            { missingParam: 'message_id' }
          );
        }
        result = await markMessageAsRead(args as RooSyncManageArgs & { message_id: string }, messageManager);
        break;

      case 'archive':
        if (!args.message_id) {
          throw new MessageManagerError(
            'Paramètre "message_id" requis pour archive',
            MessageManagerErrorCode.INVALID_MESSAGE_FORMAT,
            { missingParam: 'message_id' }
          );
        }
        result = await archiveMessageFunc(args as RooSyncManageArgs & { message_id: string }, messageManager);
        break;

      case 'bulk_mark_read':
        result = await bulkOperationHandler(args, messageManager, 'mark_read');
        break;

      case 'bulk_archive':
        result = await bulkOperationHandler(args, messageManager, 'archive');
        break;

      case 'cleanup':
        result = await cleanupMessages(args, messageManager);
        break;

      case 'stats':
        result = await showStats(messageManager);
        break;

      default:
        throw new MessageManagerError(
          `Action non reconnue : ${args.action}. Actions valides : mark_read, archive, bulk_mark_read, bulk_archive, cleanup, stats`,
          MessageManagerErrorCode.INVALID_MESSAGE_FORMAT,
          { action: args.action }
        );
    }

    // Enregistrer l'activité comme preuve de vie heartbeat (#501)
    recordRooSyncActivityAsync('manage', { action: args.action });

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
- Vérifiez que l'action est correcte (mark_read, archive, bulk_mark_read, bulk_archive, cleanup, stats)
- Pour \`mark_read\` / \`archive\` : message_id est requis
- Pour \`bulk_mark_read\` / \`bulk_archive\` : utilisez les filtres (from, priority, before_date, subject_contains, tag)
- Pour \`cleanup\` : nettoyage automatique (test messages, anciens messages LOW)
- Pour \`stats\` : aucun paramètre requis`
      }]
    };
  }
}
