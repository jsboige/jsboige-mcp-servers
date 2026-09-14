/**
 * Outil MCP : roosync_send
 *
 * Envoi, réponse, et amendement de messages RooSync.
 *
 * @module roosync/send
 * @version 1.0.0
 */

import { MessageManager, getMessageManager } from '../../services/MessageManager.js';
import { AttachmentManager } from '../../services/roosync/AttachmentManager.js';
import { getSharedStatePath } from '../../utils/shared-state-path.js';
import { createLogger, Logger } from '../../utils/logger.js';
import { recordRooSyncActivityAsync } from './heartbeat-activity.js';
import { MessageManagerError, MessageManagerErrorCode } from '../../types/errors.js';
import {
  formatDate,
  formatDateFull,
  getPriorityIcon,
  getStatusIcon,
  getLocalMachineId,
  resolveCallerIdentity
} from '../../utils/message-helpers.js';
import { getRooSyncService } from '../../services/lazy-roosync.js';
import { updateDashboardActivityAsync } from '../../utils/dashboard-helpers.js';

// Logger instance for send tool
const logger: Logger = createLogger('RooSyncSendTool');

/**
 * Tronque un body pour l'aperçu dans la sortie MCP.
 * Montre les 2 premières et 2 dernières lignes non-vides.
 * Utile car Claude Code (VS Code) n'affiche pas les paramètres d'input.
 */
function truncateBodyPreview(body: string, headLines: number = 2, tailLines: number = 2): string {
  const lines = body.split('\n').filter(l => l.trim().length > 0);
  if (lines.length <= headLines + tailLines) {
    return lines.join('\n');
  }
  const head = lines.slice(0, headLines).join('\n');
  const tail = lines.slice(-tailLines).join('\n');
  return `${head}\n[... ${lines.length - headLines - tailLines} lignes masquées ...]\n${tail}`;
}

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

  // Auto-destruction (#629)
  auto_destruct?: boolean;
  destruct_after_read_by?: string[];
  destruct_after?: string;

  // Pièces jointes (#674)
  attachments?: Array<{
    path: string;
    filename?: string;
  }>;

  /** #3591: asserted caller identity (gateway seats) — canonicalized + gate-checked in resolveCallerIdentity (single choke point) */
  as?: string;

  // #3654 — clé d'idempotence optionnelle pour action="send". Si un message
  // du même expéditeur porte déjà exactement cet id, la 2e écriture est
  // absorbée (skip) et le retour contient `deduplicated: true` + l'id existant
  // + son timestamp. Permet au caller de distinguer « landé en >timeout client »
  // de « jamais landé » quand un send timeout (sans clé, le retry sur timeout
  // fabrique un jumeau, comme sur po-2025 14/09 16:05Z).
  messageId?: string;
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

  // Obtenir l'ID complet local (machine + workspace si configuré).
  // #3591 : un siège gateway asserte son identité réelle via `as` (gate
  // ROOSYNC_TRUSTED_CALLER_IDS dans resolveCallerIdentity, appelée ici) —
  // sinon le from hérite de l'hôte proxy et les réponses arrivent dans la
  // mauvaise mailbox.
  const from = resolveCallerIdentity(args.as).fullId;
  logger.debug('📍 Message routing', { from, to: args.to });

  // #3654 — idempotence sur action="send" : si le caller a passé un messageId
  // explicite, on regarde d'abord si un message existe déjà avec cet id.
  // Si oui, on absorbe la 2e écriture (pas de sendMessage, pas de pièce jointe,
  // pas de heartbeat parasite) et on retourne un résultat qui annonce
  // `deduplicated: true` + `existingTimestamp` — c'est exactement ce qui
  // manque au caller pour distinguer « landé en >timeout client » de
  // « jamais landé » quand un send timeout (po-2025 14/09 16:05Z, HIGH DM,
  // 120 s timeout, livraison incertaine → retry = jumeau sans cette clé).
  //
  // Miroir de l'idempotence messageId du dashboard append (#3276) :
  // déterministe, opts-in (id auto-généré = jamais de collision possible
  // sur 2 appels successifs, et `deduplicated: true` n'apparaît que sur
  // les résultats où le caller a explicitement opté pour la clé).
  //
  // NB : on ne vérifie que les chemins où l'expéditeur « détient » le
  // message — sa `inbox/` (reçu en miroir d'un send où il est aussi `to`)
  // et sa `sent/`. Si un autre expéditeur a utilisé le même id, ce n'est
  // PAS notre problème (#3654 demande « mon propre message réémis »).
  if (args.messageId) {
    const dedupStart = Date.now();
    const existing = await messageManager.getMessage(args.messageId, from);
    const dedupMs = Date.now() - dedupStart;
    if (existing) {
      // Garde-fou cohérence : si l'existant n'est PAS du même expéditeur,
      // c'est une collision d'id (un autre seat a utilisé le même messageId).
      // On n'absorbe pas, on log un warning, et on laisse le sendMessage
      // partir — il va de toute façon générer un id différent côté MessageManager
      // (le path de génération est distinct, voir MessageManager.sendMessage).
      // Le warning permet au caller de comprendre pourquoi sa clé a été
      // ignorée sans pour autant bloquer l'envoi.
      if (existing.from && existing.from !== from) {
        logger.warn('[#3654] messageId collision — id already used by a different sender, send proceeds with auto-generated id', {
          messageId: args.messageId,
          existingFrom: existing.from,
          callerFrom: from,
          to: args.to
        });
      } else {
        logger.info('[#3654] Send deduplicated — explicit messageId already present', {
          messageId: args.messageId,
          existingTimestamp: existing.timestamp,
          dedupMs
        });
        const contentMismatch = (existing.body ?? '') !== (args.body ?? '');
        return `♻️ **Message absorbé par idempotence (#3654)** — un message avec l'id \`${args.messageId}\` existe déjà (envoyé le ${formatDateFull(existing.timestamp)}, depuis \`${existing.from}\`). La réémission a été ignorée.

**ID :** \`${existing.id}\`
**De :** ${existing.from}
**À :** ${existing.to}
**Sujet :** ${existing.subject}
**Priorité :** ${getPriorityIcon(existing.priority)} ${existing.priority}
**Timestamp :** ${formatDate(existing.timestamp)}${contentMismatch ? `\n\n⚠️ **Avertissement :** le \`body\` du nouvel appel diffère de l'existant — l'entrée existante est conservée (${existing.timestamp}). Si l'intention est de remplacer le contenu, utilisez \`action: "amend"\` à la place.` : ''}

---

💡 **Pourquoi ce retour existe.** Un timeout client (cf. \`#2267\`) sur un send ne signifie PAS que l'envoi a échoué : la persistance GDrive peut continuer après que la course contre le timer ait été perdue. Sans clé d'idempotence, tout retry sur timeout fabrique un **jumeau**. Avec \`messageId\` explicite, le 2e appel détecte l'entrée existante et absorbe — le caller peut alors conclure « landé en >timeout » sans dupliquer.`;
      }
    }
    logger.debug('[#3654] messageId not found locally, proceeding with send', {
      messageId: args.messageId,
      lookupMs: dedupMs
    });
  }

  // Build auto-destruct options (#629)
  const autoDestructOpts = args.auto_destruct ? {
    auto_destruct: true,
    destruct_after_read_by: args.destruct_after_read_by,
    destruct_after: args.destruct_after
  } : undefined;

  // #3654 — instrumentation côté serveur : mesurer la durée RÉELLE du write
  // (sendMessage = persistance GDrive + miroir PG, ce qui pend en cas de
  // timeout client). Cette durée est loggée avec le résultat succès et
  // ajoutée au résultat retourné au caller via une ligne dédiée, pour qu'un
  // timeout client (cf. #2267) suivi d'un retour retry ne fasse plus jamais
  // fabriquer un jumeau dans l'ignorance : si le log serveur dit
  // `writeMs: 45000` ET un send ultérieur absorbe (idempotence messageId),
  // le caller peut conclure « landé en 45 s, le timeout client était trop
  // court » ; si le log serveur ne montre pas de send passé, c'est que le
  // write a été tué avant d'atterrir et le retry est légitime.
  const writeStart = Date.now();
  // Envoyer le message
  const message = await messageManager.sendMessage(
    from,
    args.to,
    args.subject,
    args.body,
    args.priority || 'MEDIUM',
    args.tags,
    args.thread_id,
    args.reply_to,
    autoDestructOpts
  );
  const writeMs = Date.now() - writeStart;

  // Traiter les pièces jointes (#674)
  let attachmentRefs: Array<{ uuid: string; filename: string; sizeBytes: number }> = [];
  let refsPersisted = true;
  if (args.attachments && args.attachments.length > 0) {
    const sharedStatePath = getSharedStatePath();
    const attachmentManager = new AttachmentManager(sharedStatePath);
    const uploaderMachineId = from;

    for (const att of args.attachments) {
      try {
        const ref = await attachmentManager.uploadAttachment(att.path, uploaderMachineId, att.filename, message.id);
        attachmentRefs.push(ref);
        logger.info('📎 Attachment uploaded for message', { uuid: ref.uuid, filename: ref.filename, messageId: message.id });
      } catch (err) {
        logger.warn('⚠️ Failed to upload attachment (non-fatal)', { path: att.path, error: String(err) });
      }
    }

    // Mettre à jour le message JSON avec les refs d'attachments.
    // #3270 — le rapport ci-dessous dérive de l'issue de cette persistance,
    // pas du tableau local : sous PG-primary un échec d'écriture des refs
    // rend les blobs introuvables côté destinataire (source de vérité
    // depuis #3256 : attachments_list lit Message.attachments[]).
    if (attachmentRefs.length > 0) {
      message.attachments = attachmentRefs;
      // Re-sauvegarder le message avec les attachments
      refsPersisted = await messageManager.updateMessageAttachments(message.id, attachmentRefs);
    }
  }

  // Formater le résultat
  const autoDestructInfo = message.auto_destruct
    ? `\n**🔥 Auto-destruction :** Activée${message.destruct_after ? ` (TTL: ${message.destruct_after})` : ''}${message.destruct_after_read_by ? ` (après lecture par: ${message.destruct_after_read_by.join(', ')})` : ' (après lecture par destinataire)'}${message.expires_at ? `\n**⏰ Expire :** ${formatDateFull(message.expires_at)}` : ''}`
    : '';
  const attachmentDetail = attachmentRefs
    .map(a => `  - \`${a.uuid}\` → ${a.filename} (${a.sizeBytes} octets)`)
    .join('\n');
  const attachmentInfo = attachmentRefs.length > 0
    ? (refsPersisted
      ? `\n**📎 Pièces jointes :** ${attachmentRefs.length} fichier(s) attaché(s)\n${attachmentDetail}`
      : `\n**⚠️ Pièces jointes :** ${attachmentRefs.length} fichier(s) uploadé(s), mais la persistance des RÉFÉRENCES a échoué — le destinataire ne pourra PAS les retrouver (la liste des pièces jointes sera vide pour ce message). Vérifiez la disponibilité du store principal puis renvoyez le message avec ses pièces jointes.\n${attachmentDetail}`)
    : '';
  const result = `✅ **Message envoyé avec succès**

**ID :** ${message.id}
**De :** ${message.from}
**À :** ${message.to}
**Sujet :** ${message.subject}
**Priorité :** ${getPriorityIcon(message.priority)} ${message.priority}
**Timestamp :** ${formatDate(message.timestamp)}
${args.tags && args.tags.length > 0 ? `**Tags :** ${args.tags.join(', ')}\n` : ''}${args.thread_id ? `**Thread :** ${args.thread_id}\n` : ''}${args.reply_to ? `**En réponse à :** ${args.reply_to}\n` : ''}${autoDestructInfo}${attachmentInfo}
Le message a été livré dans l'inbox de **${args.to}**.
${writeMs > 1000 ? `\n⏱️ **Durée réelle du write côté serveur (#3654) :** ${writeMs} ms — c'est ce que la persistance GDrive+PG a pris ; un timeout client >cette valeur mais <quelques minutes peut quand même laisser le write atterrir (cf. po-2025 14/09 : writeMs≈63s, timeout client 120s, messageId absorbé au retry).` : ''}

---

## 📄 Aperçu du contenu envoyé

${truncateBodyPreview(args.body!)}

---

## 💡 Actions disponibles

- 📋 **Voir le message** : Utilisez \`roosync_messages\` avec \`action: "message"\` et \`message_id: ${message.id}\`
- 📬 **Lire l'inbox** : Utilisez \`roosync_messages\` avec \`action: "inbox"\` pour voir les messages reçus
- 📤 **Répondre** : Utilisez \`roosync_messages\` avec \`action: "reply"\` et \`message_id: ${message.id}\``;

  logger.info('✅ Message sent successfully', { messageId: message.id, to: args.to, writeMs, from });
  // Fire-and-forget heartbeat update: sending a message proves the machine is active
  (await getRooSyncService()).getHeartbeatService()
    .registerHeartbeat(getLocalMachineId(), { lastActivity: 'roosync_send', messageId: message.id })
    .catch(err => logger.debug('Heartbeat update skipped (non-critical)', { error: String(err) }));
  // Fire-and-forget dashboard update: track last activity (#546 Phase 2)
  updateDashboardActivityAsync(`Message envoyé à ${args.to}`, { messageId: message.id, subject: args.subject })
    .catch(err => logger.debug('Dashboard update skipped (non-critical)', { error: String(err) }));
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
      // #3029: Message d'erreur informatif — redirige l'agent vers le bon paramètre.
      // reply_to est l'alias sémantique naturel ("le message auquel je réponds") mais
      // le champ runtime est message_id (consistance avec mark_read/archive/message/etc.).
      'Paramètre "message_id" requis : ID du message auquel répondre. ' +
      'Note : "reply_to" est réservé à action="send" (pour threader un nouveau message). ' +
      'Pour action="reply"/"amend"/"mark_read"/"archive", utiliser "message_id".',
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
- Utilisez \`roosync_messages\` avec \`action: "inbox"\` pour lister les messages disponibles`;
  }

  // Construire la réponse
  logger.debug('💬 Building reply message');

  // Inversion from/to pour la réponse
  // replyFrom = la machine locale (celle qui répond), pas originalMessage.to
  // car si originalMessage.to = "all", on ne veut pas "all" comme expéditeur
  // #3591 : `as` fait foi pour un siège gateway (gate dans resolveCallerIdentity, single choke point).
  const replyFrom = resolveCallerIdentity(args.as).fullId;
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

## 📄 Aperçu du contenu envoyé

${truncateBodyPreview(args.body!)}

---

## 💡 Actions disponibles

- 📋 **Voir la réponse** : Utilisez \`roosync_messages\` avec \`action: "message"\` et \`message_id: ${replyMessageObj.id}\`
- 🔗 **Voir le thread** : Filtrez par thread_id \`${threadId}\` dans \`roosync_messages\` avec \`action: "inbox"\`
- 📦 **Archiver l'original** : Utilisez \`roosync_messages\` avec \`action: "archive"\` et \`message_id: ${originalMessage.id}\``;

  logger.info('✅ Reply sent successfully', { replyId: replyMessageObj.id, threadId });
  // Fire-and-forget heartbeat update: sending a reply proves the machine is active
  (await getRooSyncService()).getHeartbeatService()
    .registerHeartbeat(getLocalMachineId(), { lastActivity: 'roosync_reply', messageId: replyMessageObj.id })
    .catch(err => logger.debug('Heartbeat update skipped (non-critical)', { error: String(err) }));
  // Fire-and-forget dashboard update: track last activity (#546 Phase 2)
  updateDashboardActivityAsync(`Réponse envoyée à ${replyTo}`, { messageId: replyMessageObj.id, subject: replySubject })
    .catch(err => logger.debug('Dashboard update skipped (non-critical)', { error: String(err) }));
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
  // #3591 : `as` fait foi pour un siège gateway (gate dans resolveCallerIdentity, single choke point).
  const senderId = resolveCallerIdentity(args.as).fullId;
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

## 📄 Aperçu du nouveau contenu

${truncateBodyPreview(args.new_content!)}

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

- 📋 **Voir le message** : Utilisez \`roosync_messages\` avec \`action: "message"\` et \`message_id: ${result.message_id}\`
- 📬 **Lire l'inbox** : Utilisez \`roosync_messages\` avec \`action: "inbox"\` pour voir les messages reçus`;

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

    // Initialiser le MessageManager (singleton)
    const messageManager = getMessageManager();

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

    // Enregistrer l'activité comme preuve de vie heartbeat (#501)
    recordRooSyncActivityAsync('send', { action: args.action });

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
