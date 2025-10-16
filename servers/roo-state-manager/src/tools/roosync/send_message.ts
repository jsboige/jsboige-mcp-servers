/**
 * Outil MCP : roosync_send_message
 * 
 * Envoie un message structuré à une autre machine via RooSync
 * 
 * @module roosync/send_message
 */

import { MessageManager } from '../../services/MessageManager.js';
import { getSharedStatePath } from '../../utils/server-helpers.js';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * Arguments de l'outil roosync_send_message
 */
interface SendMessageArgs {
  /** ID de la machine destinataire (ex: myia-ai-01) */
  to: string;
  
  /** Sujet du message */
  subject: string;
  
  /** Corps du message (markdown supporté) */
  body: string;
  
  /** Priorité du message (défaut: MEDIUM) */
  priority?: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
  
  /** Tags optionnels pour catégoriser le message */
  tags?: string[];
  
  /** ID du thread pour regrouper les messages */
  thread_id?: string;
  
  /** ID du message auquel on répond */
  reply_to?: string;
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
 * Envoie un message structuré à une autre machine
 * 
 * @param args Arguments de l'outil
 * @returns Résultat de l'envoi
 */
export async function sendMessage(
  args: SendMessageArgs
): Promise<{ content: Array<{ type: string; text: string }> }> {
  console.error('🚀 [send_message] Starting...');

  try {
    // Validation des paramètres requis
    if (!args.to) {
      throw new Error('Paramètre "to" requis : ID de la machine destinataire');
    }
    
    if (!args.subject) {
      throw new Error('Paramètre "subject" requis : Sujet du message');
    }
    
    if (!args.body) {
      throw new Error('Paramètre "body" requis : Corps du message');
    }

    // Initialiser le MessageManager
    const sharedStatePath = getSharedStatePath();
    const messageManager = new MessageManager(sharedStatePath);

    // Obtenir l'ID de la machine locale
    const from = getLocalMachineId(sharedStatePath);
    console.error(`📍 [send_message] From: ${from}, To: ${args.to}`);

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
**Priorité :** ${message.priority}
**Timestamp :** ${message.timestamp}

${args.tags && args.tags.length > 0 ? `**Tags :** ${args.tags.join(', ')}\n` : ''}${args.thread_id ? `**Thread :** ${args.thread_id}\n` : ''}${args.reply_to ? `**En réponse à :** ${args.reply_to}\n` : ''}
Le message a été livré dans l'inbox de **${args.to}**.

📁 **Fichiers créés :**
- \`messages/inbox/${message.id}.json\` (destinataire)
- \`messages/sent/${message.id}.json\` (expéditeur)`;

    console.error('✅ [send_message] Success');
    return {
      content: [{ type: 'text', text: result }]
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('❌ [send_message] Error:', errorMessage);
    
    return {
      content: [{
        type: 'text',
        text: `❌ **Erreur lors de l'envoi du message**

**Message d'erreur :** ${errorMessage}

**Vérifications :**
- Le répertoire .shared-state est-il accessible ?
- Le fichier sync-config.json existe-t-il ?
- Les permissions d'écriture sont-elles correctes ?`
      }]
    };
  }
}