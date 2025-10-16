/**
 * Outil MCP : roosync_archive_message
 * 
 * Archive un message en le déplaçant de inbox/ vers archive/
 * 
 * @module roosync/archive_message
 */

import { MessageManager } from '../../services/MessageManager.js';
import { getSharedStatePath } from '../../utils/server-helpers.js';

/**
 * Arguments de l'outil roosync_archive_message
 */
interface ArchiveMessageArgs {
  /** ID du message à archiver */
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
 * Archive un message
 * 
 * @param args Arguments de l'outil
 * @returns Résultat de l'opération
 */
export async function archiveMessage(
  args: ArchiveMessageArgs
): Promise<{ content: Array<{ type: string; text: string }> }> {
  console.error('📦 [archive_message] Starting...');

  try {
    // Validation des paramètres requis
    if (!args.message_id) {
      throw new Error('Paramètre "message_id" requis : ID du message à archiver');
    }

    // Initialiser le MessageManager
    const sharedStatePath = getSharedStatePath();
    const messageManager = new MessageManager(sharedStatePath);

    // Vérifier existence du message
    console.error(`🔍 [archive_message] Checking message: ${args.message_id}`);
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

    // Vérifier si déjà archivé
    if (message.status === 'archived') {
      return {
        content: [{
          type: 'text',
          text: `ℹ️ **Message déjà archivé**

**ID :** \`${args.message_id}\`
**Sujet :** ${message.subject}
**De :** ${message.from}
**À :** ${message.to}
**Date :** ${formatDate(message.timestamp)}
**Statut actuel :** 📦 ARCHIVED

Le message est déjà archivé. Il se trouve dans le dossier \`messages/archive/\`.

**Actions disponibles :**
- 📋 Utilisez \`roosync_get_message\` pour voir le contenu complet`
        }]
      };
    }

    // Archiver le message
    console.error('📦 [archive_message] Archiving...');
    await messageManager.archiveMessage(args.message_id);
    
    // Récupérer le message archivé
    const archivedMessage = await messageManager.getMessage(args.message_id);
    const archivedAt = new Date().toISOString();

    // Formater le résultat
    let result = `✅ **Message archivé avec succès**\n\n`;
    result += `---\n\n`;
    result += `**ID :** \`${args.message_id}\`\n`;
    result += `**Sujet :** ${message.subject}\n`;
    result += `**De :** ${message.from}\n`;
    result += `**À :** ${message.to}\n`;
    result += `**Date d'envoi :** ${formatDate(message.timestamp)}\n`;
    result += `**Date d'archivage :** ${formatDate(archivedAt)}\n`;
    result += `**Statut :** ${message.status === 'read' ? '✅ READ' : '🆕 UNREAD'} → 📦 ARCHIVED\n`;
    result += `\n---\n\n`;
    result += `## 📁 Emplacement\n\n`;
    result += `Le message a été déplacé vers :\n`;
    result += `\`messages/archive/${args.message_id}.json\`\n\n`;
    result += `Il n'apparaîtra plus dans la boîte de réception (\`roosync_read_inbox\`).\n\n`;
    result += `---\n\n`;
    result += `## 💡 Actions disponibles\n\n`;
    result += `- 📋 **Voir détails** : Utilisez \`roosync_get_message\` pour voir le contenu complet\n`;
    
    if (message.thread_id) {
      result += `- 🔗 **Voir le thread** : Utilisez \`roosync_read_inbox\` puis filtrez par thread_id\n`;
    }

    console.error('✅ [archive_message] Message archived successfully');
    return {
      content: [{ type: 'text', text: result }]
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('❌ [archive_message] Error:', errorMessage);
    
    return {
      content: [{
        type: 'text',
        text: `❌ **Erreur lors de l'archivage du message**

**Message d'erreur :** ${errorMessage}

**Vérifications :**
- Le répertoire .shared-state est-il accessible ?
- L'ID du message est-il correct ?
- Le message existe-t-il dans inbox/ ou sent/ ?
- Les permissions d'écriture sont-elles correctes ?`
      }]
    };
  }
}