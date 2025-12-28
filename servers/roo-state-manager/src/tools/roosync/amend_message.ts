/**
 * Outil MCP : roosync_amend_message
 * 
 * Modifie le contenu d'un message envoyé avant qu'il ne soit lu
 * 
 * @module roosync/amend_message
 */

import { MessageManager } from '../../services/MessageManager.js';
import { getSharedStatePath } from '../../utils/server-helpers.js';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import os from 'os';
import { createLogger, Logger } from '../../utils/logger.js';

// Logger instance for amend_message tool
const logger: Logger = createLogger('AmendMessageTool');

/**
 * Arguments de l'outil roosync_amend_message
 */
interface AmendMessageArgs {
  /** ID du message à modifier */
  message_id: string;
  
  /** Nouveau contenu du message (remplace l'original) */
  new_content: string;
  
  /** Raison de l'amendement (optionnel, pour traçabilité) */
  reason?: string;
}

/**
 * Récupère l'ID de la machine locale depuis la variable d'environnement
 * ou depuis le hostname OS en fallback
 *
 * @returns ID de la machine locale (hostname normalisé)
 */
function getLocalMachineId(): string {
  // Priorité à la variable d'environnement (pour les tests)
  if (process.env.ROOSYNC_MACHINE_ID) {
    return process.env.ROOSYNC_MACHINE_ID;
  }
  
  // Fallback vers le hostname OS
  return os.hostname().toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

/**
 * Modifie le contenu d'un message envoyé (avant lecture)
 * 
 * @param args Arguments de l'outil
 * @returns Résultat de l'amendement
 */
export async function amendMessage(
  args: AmendMessageArgs
): Promise<{ content: Array<{ type: string; text: string }> }> {
  logger.info('✏️ Starting amend message operation');

  try {
    // Validation des paramètres requis
    if (!args.message_id) {
      throw new Error('Paramètre "message_id" requis : ID du message à modifier');
    }
    
    if (!args.new_content) {
      throw new Error('Paramètre "new_content" requis : Nouveau contenu du message');
    }

    // Initialiser le MessageManager
    const sharedStatePath = getSharedStatePath();
    const messageManager = new MessageManager(sharedStatePath);

    // Obtenir l'ID de la machine locale (émetteur)
    const senderId = getLocalMachineId();
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
**Amendé le :** ${new Date(result.amended_at).toLocaleString('fr-FR', {
  weekday: 'long',
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit'
})}
**Raison :** ${result.reason}

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
- ✅ Amendements multiples possibles (original toujours préservé)`;

    logger.info('✅ Message amended successfully', { messageId: args.message_id });
    return {
      content: [{ type: 'text', text: successMessage }]
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('❌ Amend message error', error instanceof Error ? error : new Error(errorMessage));
    
    return {
      content: [{
        type: 'text',
        text: `❌ **Erreur lors de l'amendement du message**

**Message d'erreur :** ${errorMessage}

**Vérifications :**
- Le message existe-t-il dans messages/sent/ ?
- Êtes-vous l'émetteur de ce message ?
- Le message est-il encore non lu (status: unread) ?
- Le message n'est-il pas archivé ?

**Suggestions :**
- Utilisez \`roosync_get_message\` pour vérifier le statut du message
- Vérifiez que l'ID du message est correct
- Si le message est déjà lu, vous ne pouvez plus le modifier`
      }]
    };
  }
}