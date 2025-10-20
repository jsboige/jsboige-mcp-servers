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
 * Récupère l'ID de la machine locale depuis sync-config.json
 * 
 * @param sharedStatePath Chemin vers .shared-state
 * @returns ID de la machine locale
 */
function getLocalMachineId(sharedStatePath: string): string {
  const configPath = join(sharedStatePath, 'sync-config.json');
  
  if (!existsSync(configPath)) {
    throw new Error(`Fichier sync-config.json introuvable à : ${configPath}`);
  }
  
  try {
    const configContent = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(configContent);
    
    if (!config.machineId) {
      throw new Error('machineId absent dans sync-config.json');
    }
    
    return config.machineId;
  } catch (error) {
    throw new Error(`Erreur lecture sync-config.json : ${error instanceof Error ? error.message : String(error)}`);
  }
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
  console.error('✏️ [amend_message] Starting...');

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
    const senderId = getLocalMachineId(sharedStatePath);
    console.error(`🔐 [amend_message] Sender ID: ${senderId}`);

    // Amender le message via MessageManager
    console.error(`✏️ [amend_message] Amending message: ${args.message_id}`);
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

    console.error('✅ [amend_message] Success');
    return {
      content: [{ type: 'text', text: successMessage }]
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('❌ [amend_message] Error:', errorMessage);
    
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