/**
 * Outil MCP : roosync_manage
 *
 * Gestion du cycle de vie des messages RooSync (marquer lu, archiver).
 *
 * @module roosync/manage
 * @version 1.0.0
 */

import { MessageManager, getMessageManager } from '../../services/MessageManager.js';
import { createLogger, Logger } from '../../utils/logger.js';
import { MessageManagerError, MessageManagerErrorCode } from '../../types/errors.js';
import { recordRooSyncActivityAsync } from './heartbeat-activity.js';
import {
  formatDate,
  formatDateFull,
  getLocalMachineId,
  getLocalFullId,
  parseMachineWorkspace,
  perReaderStatus
} from '../../utils/message-helpers.js';
import { getRooSyncService } from '../../services/lazy-roosync.js';

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
  /** Output format for stats action: "json" returns structured data, "markdown" returns formatted table */
  format?: 'json' | 'markdown';
}

/**
 * Mark a message as read
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
  const message = await messageManager.getMessage(args.message_id, getLocalFullId());

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
- Utilisez \`roosync_messages\` avec \`action: "inbox"\` pour lister les messages disponibles`;
  }

  // #2307 Phase 4: Message was auto-archived between listing and this call
  if (message.status === 'archived') {
    return `ℹ️ **Message déjà archivé**

**ID :** \`${args.message_id}\`
**Sujet :** ${message.subject}
**De :** ${message.from}
**À :** ${message.to}
**Date :** ${formatDateFull(message.timestamp)}

Ce message a été automatiquement archivé entre le moment où il a été listé et maintenant. Aucune action nécessaire.`;
  }

  // Vérifier si déjà lu. Deux classes suivent leurs lecteurs individuellement
  // (broadcasts #629 par machine, cibles machine-larges par workspace) et
  // gardent donc `status: 'unread'` : calculer `status === 'read'` ici
  // annoncerait "non lu" un message que CE workspace a déjà lu, et le
  // réécrirait pour rien. perReaderStatus (message-helpers) est la source unique.
  const localMachine = getLocalMachineId();
  const localWorkspace = parseMachineWorkspace(getLocalFullId()).workspaceId;
  const isBroadcast = message.to === 'all' || message.to === 'All';
  const perReader = perReaderStatus(message, localMachine, localWorkspace);
  const alreadyReadByMe =
    perReader !== null ? perReader === 'read' : message.status === 'read';
  const readersSuffix = isBroadcast && message.read_by?.length
    ? ` (lu par ${message.read_by.length} machine(s): ${message.read_by.join(', ')})`
    : message.read_by_workspace?.length
      ? ` (lu par ${message.read_by_workspace.length} workspace(s): ${message.read_by_workspace.join(', ')})`
      : '';

  if (alreadyReadByMe) {
    return `ℹ️ **Message déjà marqué comme lu**

**ID :** \`${args.message_id}\`
**Sujet :** ${message.subject}
**De :** ${message.from}
**À :** ${message.to}
**Date :** ${formatDateFull(message.timestamp)}
**Statut actuel :** ✅ READ${readersSuffix}

Le message était déjà marqué comme lu. Aucune modification nécessaire.`;
  }

  // Marquer comme lu (avec tracking per-machine #629, workspace-aware #2287)
  logger.info('✉️ Marking message as read');
  const marked = await messageManager.markAsRead(args.message_id, getLocalFullId());

  // #1017: surface le retour de markAsRead. Un retour `false` (strict) =
  // le write n'a pas atterri (workspace guard #2287, message introuvable,
  // PG update raté sans fallback GDrive). On teste `=== false` strict
  // plutôt que `!marked` pour rester compatible avec les implémentations
  // et mocks existants qui retournent `undefined` (legacy).
  if (marked === false) {
    logger.warn('❌ markAsRead returned false — write non persistant', {
      messageId: args.message_id,
      reader: getLocalFullId(),
    });
    return `❌ **Échec du marquage comme lu**

**ID :** \`${args.message_id}\`
**Sujet :** ${message.subject}
**De :** ${message.from}
**À :** ${message.to}

Le write n'a **pas** été persisté. Causes probables :
- Workspace mismatch (#2287) : le reader (\`${getLocalFullId()}\`) ne couvre pas le destinataire du message
- Message introuvable dans inbox/ ET archive/ (phantom ou auto-détruit)
- PG update raté sans fallback GDrive (#1017)

**Action recommandée** : vérifiez le destinataire, ré-essayez avec \`action: "message"\` pour confirmer l'état, ou ré-essayez après quelques secondes si le PG est temporairement indisponible.`;
  }

  // Fire-and-forget heartbeat update: marking a message read proves the machine is active
  (await getRooSyncService()).getHeartbeatService()
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

- 📦 **Archiver** : Utilisez \`roosync_messages\` avec \`action: "archive"\`
- 💬 **Répondre** : Utilisez \`roosync_messages\` avec \`action: "reply"\`
- 📋 **Voir détails** : Utilisez \`roosync_messages\` avec \`action: "message"\``;

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
  const message = await messageManager.getMessage(args.message_id, getLocalFullId());

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
- Utilisez \`roosync_messages\` avec \`action: "inbox"\` pour lister les messages disponibles`;
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
- 📋 Utilisez \`roosync_messages\` avec \`action: "message"\` pour voir le contenu complet`;
  }

  // Archiver le message
  logger.info('📦 Archiving message');
  await messageManager.archiveMessage(args.message_id);

  // Fire-and-forget heartbeat update: archiving a message proves the machine is active
  (await getRooSyncService()).getHeartbeatService()
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

Il n'apparaîtra plus dans la boîte de réception (\`roosync_messages\` avec \`action: "inbox"\`).

---

## 💡 Actions disponibles

- 📋 **Voir détails** : Utilisez \`roosync_messages\` avec \`action: "message"\` et \`message_id: ${args.message_id}\``;

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

  // #2307 Phase 2: Guard against destructive bulk_archive without filters
  // bulk_archive without any filter would archive the ENTIRE inbox — dangerous.
  // bulk_mark_read is non-destructive and allowed without filters.
  if (operation === 'archive') {
    const hasAnyFilter = !!(args.from || args.priority || args.before_date || args.subject_contains || args.tag);
    if (!hasAnyFilter) {
      throw new MessageManagerError(
        'bulk_archive requires at least one filter (from, priority, before_date, subject_contains, tag) to prevent accidental inbox-wide deletion. Use cleanup action for controlled auto-cleanup.',
        MessageManagerErrorCode.BULK_OPERATION_NO_FILTER
      );
    }
  }

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

  const failedIds = result.failed_ids ?? [];
  const failedReasons = (result as any).failed_reasons as Record<string, string> | undefined;
  const failedSection = failedIds.length > 0
    ? `\n\n**IDs en échec (${failedIds.length}) :** ${failedIds.slice(0, 10).map(id => {
      const reason = failedReasons?.[id];
      return reason ? `❌ \`${id}\` (${reason})` : `❌ \`${id}\``;
    }).join(', ')}${failedIds.length > 10 ? ` ... et ${failedIds.length - 10} autres` : ''}`
    : '';

  return `✅ **Opération bulk terminée : ${opName}**

---

**Filtres appliqués :** ${filtersDesc.length > 0 ? filtersDesc.join(', ') : 'aucun (tous les messages)'}
**Messages trouvés :** ${result.matched}
**Messages traités :** ${result.processed}
**Erreurs :** ${result.errors}${failedSection}

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
  const allFailedIds: string[] = [];
  const allFailedReasons: Record<string, string> = {};

  // 0a. Cleanup expired auto-destruct messages (#629)
  try {
    const expiredCount = await messageManager.cleanupExpiredMessages();
    if (expiredCount > 0) {
      results.push(`- 💀 Messages auto-destruct expirés détruits : **${expiredCount}**`);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    results.push(`- 💀 Auto-destruct cleanup échoué : ${msg}`);
    logger.error('Auto-destruct cleanup failed', error);
  }

  // 0b. Send expiry reminders for approaching TTL (#629)
  try {
    const remindersCount = await messageManager.sendExpiryReminders();
    if (remindersCount > 0) {
      results.push(`- ⏰ Rappels d'expiration envoyés : **${remindersCount}**`);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    results.push(`- ⏰ Envoi rappels échoué : ${msg}`);
    logger.error('Expiry reminders failed', error);
  }

  // 0c. PG retention purge (#3151 Phase D) — opt-in, UNIFIED_STORE_CHANNEL_RETENTION_DAYS.
  // GDrive n'est jamais touché (archive legacy en lecture seule).
  const retentionDays = Number(process.env.UNIFIED_STORE_CHANNEL_RETENTION_DAYS ?? '0');
  if (retentionDays > 0) {
    try {
      const purged = await messageManager.purgeArchivedFromStore(retentionDays);
      results.push(`- 🗄️ Rétention PG : **${purged}** message(s) archivé(s) purgé(s) (> ${retentionDays} j, attachments inclus)`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      results.push(`- 🗄️ Rétention PG échouée : ${msg}`);
      logger.error('PG retention purge failed', error);
    }
  }

  // 1. Mark test messages as read
  const testResult = await messageManager.bulkOperation(
    machineId, 'mark_read',
    { from: 'test', status: 'unread' }
  );
  if (testResult.processed > 0) {
    results.push(`- 🧪 Messages de test marqués lus : **${testResult.processed}**`);
  }
  if (testResult.failed_ids.length > 0) {
    results.push(`- ⚠️ Échecs test mark_read : ${testResult.failed_ids.length} (${testResult.failed_ids.slice(0, 5).join(', ')}${testResult.failed_ids.length > 5 ? '…' : ''})`);
    allFailedIds.push(...testResult.failed_ids);
    Object.assign(allFailedReasons, testResult.failed_reasons || {});
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
  if (oldReadResult.failed_ids.length > 0) {
    results.push(`- ⚠️ Échecs archive >30j : ${oldReadResult.failed_ids.length} (${oldReadResult.failed_ids.slice(0, 5).join(', ')}${oldReadResult.failed_ids.length > 5 ? '…' : ''})`);
    allFailedIds.push(...oldReadResult.failed_ids);
    Object.assign(allFailedReasons, oldReadResult.failed_reasons || {});
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
  if (oldLowResult.failed_ids.length > 0) {
    results.push(`- ⚠️ Échecs LOW mark_read : ${oldLowResult.failed_ids.length} (${oldLowResult.failed_ids.slice(0, 5).join(', ')}${oldLowResult.failed_ids.length > 5 ? '…' : ''})`);
    allFailedIds.push(...oldLowResult.failed_ids);
    Object.assign(allFailedReasons, oldLowResult.failed_reasons || {});
  }

  // 4. Get current stats
  const stats = await messageManager.getInboxStats(machineId);

  const errorSection = allFailedIds.length > 0
    ? `\n\n### Échecs (${allFailedIds.length} messages)\n${allFailedIds.slice(0, 10).map(id => {
      const reason = allFailedReasons[id];
      return reason ? `- \`${id}\` — ${reason}` : `- \`${id}\``;
    }).join('\n')}${allFailedIds.length > 10 ? `\n… et ${allFailedIds.length - 10} autres` : ''}`
    : '';

  return `🧹 **Cleanup terminé**

---

${results.length > 0 ? `### Actions effectuées\n${results.join('\n')}` : '### Aucune action nécessaire\nTous les messages sont déjà dans un état propre.'}${errorSection}

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
  messageManager: MessageManager,
  format?: 'json' | 'markdown'
): Promise<string> {
  logger.info('📊 Getting inbox stats', { format });
  const machineId = getLocalMachineId();
  const stats = await messageManager.getInboxStats(machineId);

  // #3292: pool partagé + rotation. Rend visible ce qui ne l'était pas — le
  // daemon d'auto-archive tourne depuis #809/#3150 mais était invisible, et
  // l'issue a diagnostiqué le pool comme "jamais tourné" alors que la live
  // montrait 0 fichier au-delà de la voie 90 j.
  const pool = await messageManager.getInboxPoolAges();
  const rotation = messageManager.getAutoArchiveStatus();
  // #3292: reconcile GDrive→PG — même motif d'observabilité que la rotation :
  // un daemon invisible est un daemon diagnostiqué "jamais tourné".
  const reconcile = messageManager.getChannelReconcileStatus();

  if (format === 'json') {
    return JSON.stringify({
      machine_id: machineId,
      total: stats.total,
      unread: stats.unread,
      read: stats.read,
      oldest_unread: stats.oldest_unread || null,
      by_priority: stats.by_priority,
      by_sender: stats.by_sender,
      pool_files: pool,
      rotation,
      channel_reconcile: reconcile
    }, null, 2);
  }

  const rotationLine = rotation.config
    ? `${rotation.running ? '✅ active' : '⚠️ inactive'} — lus >${rotation.config.maxAgeDays} j, non-lus >${rotation.config.unreadMaxAgeDays} j, toutes les ${rotation.config.intervalHours} h`
    : '⚠️ jamais démarrée sur ce process';
  const lastRunLine = rotation.lastRun
    ? `Dernier passage : ${formatDate(rotation.lastRun.at)} — ${rotation.lastRun.archived} archivés en ${rotation.lastRun.durationMs} ms${rotation.lastRun.error ? ` (erreur : ${rotation.lastRun.error})` : ''}`
    : `Aucun passage depuis le démarrage de ce process${rotation.config ? ` (1er run 30 s après boot, puis toutes les ${rotation.config.intervalHours} h)` : ''}`;

  const reconcileLine = reconcile.config
    ? `${reconcile.running ? '✅ actif' : '⚠️ inactif'} — lookback ${reconcile.config.lookbackDays} j, toutes les ${reconcile.config.intervalHours} h`
    : process.env.UNIFIED_STORE_DUAL_WRITE === '1' && process.env.UNIFIED_STORE_PG_URL
      ? '⚠️ jamais démarré sur ce process (dual-write armé — attendu sur un process non redémarré)'
      : '— (dual-write désarmé sur ce process)';
  const reconcileLastRunLine = reconcile.lastRun
    ? (reconcile.lastRun.error
        ? `Dernier reconcile : ${formatDate(reconcile.lastRun.at)} — erreur : ${reconcile.lastRun.error}`
        : `Dernier reconcile : ${formatDate(reconcile.lastRun.at)} — ${reconcile.lastRun.result?.status === 'skipped-not-armed' ? 'gate dual-write fermée' : `${reconcile.lastRun.result?.reconciled ?? 0} row(s) réimportée(s) sur ${reconcile.lastRun.result?.candidateIds ?? 0} id(s) fenêtre, ${reconcile.lastRun.result?.errors ?? 0} erreur(s)`} en ${reconcile.lastRun.result?.durationMs ?? 0} ms`)
    : '';

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

### Pool partagé & rotation (#3292)

Âge des fichiers \`messages/inbox/\` (pool commun à toute la flotte, toutes machines) :

| Âge | Fichiers | Voie de rotation |
|----------|--------|------------------|
| 0-7 j | ${pool.d0_7} | grâce lus 7 j (archivage opportuniste à la lecture) |
| 7-30 j | ${pool.d7_30} | survie morte (lus partis, restent les non-lus) |
| 30-90 j | ${pool.d30_90} | dead-letter en attente de la voie 90 j |
| >90 j | ${pool.d90_plus} | doit être 0 (daemon #3150) |
| non datés | ${pool.undated} | noms sans horodatage msg-YYYYMMDDTHHMMSS |
| **Total** | **${pool.total}** | |

Rotation : ${rotationLine}
${lastRunLine}

Reconcile PG : ${reconcileLine}
${reconcileLastRunLine}

---

**Actions disponibles :**
- \`roosync_messages(action: "cleanup")\` - Nettoyage automatique
- \`roosync_messages(action: "bulk_mark_read", from: "test")\` - Marquer test messages
- \`roosync_messages(action: "bulk_archive", before_date: "2026-02-01")\` - Archiver anciens`;
}

/**
 * Fonction principale de l'outil roosync_manage
 *
 * Route vers la fonction appropriée selon l'action demandée
 *
 * @param args Arguments de l'outil
 * @returns Résultat de l'opération
 */
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

    // Initialiser le MessageManager (singleton)
    const messageManager = getMessageManager();

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
        result = await showStats(messageManager, args.format);
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
