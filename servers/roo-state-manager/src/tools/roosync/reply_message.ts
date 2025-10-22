/**
 * Outil MCP : roosync_reply_message
 * 
 * Répond à un message existant en créant un nouveau message lié
 * 
 * @module roosync/reply_message
 */

import { MessageManager } from '../../services/MessageManager.js';
import { getSharedStatePath } from '../../utils/server-helpers.js';

/**
 * Arguments de l'outil roosync_reply_message
 */
interface ReplyMessageArgs {
  /** ID du message auquel répondre */
  message_id: string;
  
  /** Corps de la réponse */
  body: string;
  
  /** Priorité de la réponse (optionnel) */
  priority?: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
  
  /** Tags supplémentaires (optionnel) */
  tags?: string[];
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
 * Répond à un message existant
 * 
 * @param args Arguments de l'outil
 * @returns Résultat de l'opération
 */
export async function replyMessage(
  args: ReplyMessageArgs
): Promise<{ content: Array<{ type: string; text: string }> }> {
  console.error('💬 [reply_message] Starting...');

  try {
    // Validation des paramètres requis
    if (!args.message_id) {
      throw new Error('Paramètre "message_id" requis : ID du message auquel répondre');
    }
    
    if (!args.body) {
      throw new Error('Paramètre "body" requis : Corps de la réponse');
    }

    // Initialiser le MessageManager
    const sharedStatePath = getSharedStatePath();
    const messageManager = new MessageManager(sharedStatePath);

    // Récupérer le message original
    console.error(`🔍 [reply_message] Fetching original message: ${args.message_id}`);
    const originalMessage = await messageManager.getMessage(args.message_id);

    // Cas : message introuvable
    if (!originalMessage) {
      return {
        content: [{
          type: 'text',
          text: `❌ **Message original introuvable**

**ID recherché :** ${args.message_id}

Impossible de répondre car le message original n'a pas été trouvé dans :
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

    // Construire la réponse
    console.error('💬 [reply_message] Building reply...');
    
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
    console.error('📤 [reply_message] Sending reply...');
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
    let result = `✅ **Réponse envoyée avec succès**\n\n`;
    result += `---\n\n`;
    result += `## 📨 Message Original\n\n`;
    result += `**ID :** \`${originalMessage.id}\`\n`;
    result += `**Sujet :** ${originalMessage.subject}\n`;
    result += `**De :** ${originalMessage.from}\n`;
    result += `**À :** ${originalMessage.to}\n`;
    result += `**Date :** ${formatDate(originalMessage.timestamp)}\n`;
    result += `**Priorité :** ${originalPriorityIcon} ${originalMessage.priority}\n`;
    
    if (originalMessage.tags && originalMessage.tags.length > 0) {
      result += `**Tags :** ${originalMessage.tags.map(t => `\`${t}\``).join(', ')}\n`;
    }
    
    result += `\n---\n\n`;
    result += `## 💬 Votre Réponse\n\n`;
    result += `**ID :** \`${replyMessageObj.id}\`\n`;
    result += `**Sujet :** ${replySubject}\n`;
    result += `**De :** ${replyFrom} *(inversé)*\n`;
    result += `**À :** ${replyTo} *(inversé)*\n`;
    result += `**Date :** ${formatDate(replyMessageObj.timestamp)}\n`;
    result += `**Priorité :** ${replyPriorityIcon} ${priority}\n`;
    result += `**Tags :** ${replyTags.map(t => `\`${t}\``).join(', ')}\n`;
    result += `**Thread ID :** \`${threadId}\`\n`;
    result += `**En réponse à :** \`${args.message_id}\`\n`;
    
    result += `\n---\n\n`;
    result += `## 📄 Contenu de la Réponse\n\n`;
    result += `${args.body}\n\n`;
    
    result += `---\n\n`;
    result += `## 💡 Actions disponibles\n\n`;
    result += `- 📋 **Voir la réponse** : Utilisez \`roosync_get_message\` avec l'ID \`${replyMessageObj.id}\`\n`;
    result += `- 🔗 **Voir le thread** : Filtrez par thread_id \`${threadId}\` dans \`roosync_read_inbox\`\n`;
    result += `- 📦 **Archiver l'original** : Utilisez \`roosync_archive_message\` avec l'ID \`${originalMessage.id}\`\n`;

    console.error('✅ [reply_message] Reply sent successfully');
    return {
      content: [{ type: 'text', text: result }]
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('❌ [reply_message] Error:', errorMessage);
    
    return {
      content: [{
        type: 'text',
        text: `❌ **Erreur lors de l'envoi de la réponse**

**Message d'erreur :** ${errorMessage}

**Vérifications :**
- Le répertoire .shared-state est-il accessible ?
- L'ID du message original est-il correct ?
- Le fichier sync-config.json existe-t-il ?
- Les permissions d'écriture sont-elles correctes ?`
      }]
    };
  }
}