/**
 * Outils MCP pour la gestion des pièces jointes RooSync (#674)
 *
 * - roosync_list_attachments : Lister les attachments d'un message
 * - roosync_get_attachment   : Récupérer un attachment (copie locale)
 * - roosync_delete_attachment: Supprimer un attachment
 *
 * @module tools/roosync/roosync-attachments
 * @version 1.0.0
 */

import { AttachmentManager, type AttachmentListStats } from '../../services/roosync/AttachmentManager.js';
import { getMessageManager } from '../../services/MessageManager.js';
import { getSharedStatePath } from '../../utils/shared-state-path.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('RooSyncAttachmentTools');

/**
 * #3256 — Résout les refs d'attachments d'un message SANS parcourir le store.
 *
 * `getMessage` cherche en O(1) (PG si gate + caller fourni, sinon inbox → sent
 * → archive → cache) et le message porte ses refs (`attachments[]`, maintenues
 * par `updateMessageAttachments`). Retourne :
 *   - `null` quand le message est introuvable — l'appelant retombe alors sur
 *     le scan complet `listAttachments(messageId)` (comportement historique,
 *     seul chemin pour un id inconnu) ;
 *   - `[]` quand le message existe mais n'a aucune pièce jointe — miss
 *     définitif, répondable sans toucher au store du tout.
 */
async function resolveMessageAttachmentRefs(
  messageId: string,
): Promise<Array<{ uuid: string; filename: string; sizeBytes: number }> | null> {
  const message = await getMessageManager().getMessage(messageId);
  if (!message) return null;
  return message.attachments ?? [];
}

// ============================================================
// roosync_list_attachments
// ============================================================

export async function roosyncListAttachments(
  args: { message_id?: string }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  logger.info('📎 roosync_list_attachments called', { messageId: args.message_id });

  try {
    const sharedStatePath = getSharedStatePath();
    const manager = new AttachmentManager(sharedStatePath);
    // Pass-by-reference accumulator so the tool response can say *how many*
    // entries were dropped and *why* — distinguishing a partial list from a
    // complete one (#3013). Filter `messageId` is NOT aggregated here.
    const stats: AttachmentListStats = { missingMetadata: 0, readTimeout: 0, parseError: 0 };

    // #3256 — chemin ciblé : un message trouvé répond depuis SES refs en O(k),
    // jamais depuis un parcours du store (O(N_flotte), 17,9 s mesurés pour un
    // miss). `null` (message inconnu) seul retombe sur le scan historique.
    let attachments;
    if (args.message_id) {
      const refs = await resolveMessageAttachmentRefs(args.message_id);
      attachments = refs === null
        ? await manager.listAttachments(args.message_id, stats)
        : await manager.listAttachmentsByRefs(refs.map((r) => r.uuid), stats);
    } else {
      attachments = await manager.listAttachments(undefined, stats);
    }

    if (attachments.length === 0) {
      const scopeLabel = args.message_id ? `le message \`${args.message_id}\`` : 'le stockage partagé';
      return {
        content: [{
          type: 'text',
          text: `📭 **Aucune pièce jointe trouvée** pour ${scopeLabel}.`
        }]
      };
    }

    const rows = attachments.map(a =>
      `| \`${a.uuid}\` | ${a.originalName} | ${formatSize(a.sizeBytes)} | ${a.mimeType} | ${a.uploadedAt.slice(0, 10)} | ${a.uploaderMachineId} | ${a.messageId || '—'} |`
    ).join('\n');

    const scopeLabel = args.message_id
      ? `Message \`${args.message_id}\``
      : 'Tous les attachments';

    // Silent in normal regime (total = 0). When entries were dropped, the line
    // tells the caller how many are missing and the cause breakdown — the
    // principle violated by the historical per-read path: a diagnosable signal
    // beats a silently truncated list (#3013).
    const totalSkipped = stats.readTimeout + stats.missingMetadata + stats.parseError;
    const skipLine = totalSkipped > 0
      ? `\n\n⚠️ **${totalSkipped} entrée(s) omise(s)** — timeout ${stats.readTimeout} · metadata absente ${stats.missingMetadata} · parse ${stats.parseError}`
      : '';

    const text = `## 📎 Pièces Jointes — ${scopeLabel}

**Total :** ${attachments.length}
${skipLine}
| UUID | Fichier | Taille | Type | Date | Machine | Message |
|------|---------|--------|------|------|---------|---------|
${rows}

---

💡 **Actions :**
- **Récupérer :** \`roosync_get_attachment\` avec \`uuid\` et \`targetPath\`
- **Supprimer :** \`roosync_delete_attachment\` avec \`uuid\``;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error('❌ roosync_list_attachments error', error instanceof Error ? error : new Error(msg));
    return {
      content: [{
        type: 'text',
        text: `❌ **Erreur roosync_list_attachments :** ${msg}`
      }]
    };
  }
}

// ============================================================
// roosync_get_attachment
// ============================================================

export async function roosyncGetAttachment(
  args: { uuid?: string; targetPath: string; message_id?: string; filename?: string }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  logger.info('📥 roosync_get_attachment called', { uuid: args.uuid, targetPath: args.targetPath });

  // #3256 — breaker de la boucle fermée : l'UUID n'est découvrable que par
  // `attachments_list`, qui timeout sur les stores saturés. `(message_id,
  // filename)` le résout en O(1) depuis les refs du message, sans listing.
  let uuid = args.uuid;
  if (!uuid) {
    if (!args.message_id || !args.filename) {
      return { content: [{ type: 'text', text: '❌ Paramètre `uuid` requis (ou `message_id` + `filename` — #3256).' }] };
    }
    const refs = await resolveMessageAttachmentRefs(args.message_id);
    if (refs === null) {
      return { content: [{ type: 'text', text: `❌ Message introuvable : \`${args.message_id}\` — impossible de résoudre \`filename\` sans UUID.` }] };
    }
    if (refs.length === 0) {
      return { content: [{ type: 'text', text: `❌ Le message \`${args.message_id}\` n'a aucune pièce jointe.` }] };
    }
    const ref = refs.find((r) => r.filename === args.filename);
    if (!ref) {
      const available = refs.map((r) => `\`${r.filename}\``).join(', ');
      return { content: [{ type: 'text', text: `❌ Aucune pièce jointe nommée \`${args.filename}\` sur \`${args.message_id}\`. Disponibles : ${available}` }] };
    }
    uuid = ref.uuid;
  }
  if (!args.targetPath) {
    return { content: [{ type: 'text', text: '❌ Paramètre `targetPath` requis.' }] };
  }

  try {
    const sharedStatePath = getSharedStatePath();
    const manager = new AttachmentManager(sharedStatePath);
    const meta = await manager.getAttachment(uuid, args.targetPath);

    const text = `✅ **Pièce jointe récupérée**

| Champ | Valeur |
|-------|--------|
| **UUID** | \`${meta.uuid}\` |
| **Fichier** | ${meta.originalName} |
| **Taille** | ${formatSize(meta.sizeBytes)} |
| **Type** | ${meta.mimeType} |
| **Uploadé le** | ${meta.uploadedAt} |
| **Par** | ${meta.uploaderMachineId} |
| **Message lié** | ${meta.messageId || '—'} |

📁 **Copié vers :** \`${args.targetPath}\``;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error('❌ roosync_get_attachment error', error instanceof Error ? error : new Error(msg));
    return {
      content: [{
        type: 'text',
        text: `❌ **Erreur roosync_get_attachment :** ${msg}

**Vérifications :**
- L'UUID \`${uuid}\` est-il correct ?
- Le répertoire cible \`${args.targetPath}\` est-il accessible en écriture ?
- Utilisez \`roosync_list_attachments\` pour voir les UUIDs disponibles.`
      }]
    };
  }
}

// ============================================================
// roosync_delete_attachment
// ============================================================

export async function roosyncDeleteAttachment(
  args: { uuid: string }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  logger.info('🗑️ roosync_delete_attachment called', { uuid: args.uuid });

  if (!args.uuid) {
    return { content: [{ type: 'text', text: '❌ Paramètre `uuid` requis.' }] };
  }

  try {
    const sharedStatePath = getSharedStatePath();
    const manager = new AttachmentManager(sharedStatePath);

    // Read metadata before deleting (for confirmation output)
    const meta = await manager.getAttachmentMetadata(args.uuid);
    if (!meta) {
      return {
        content: [{
          type: 'text',
          text: `❌ **Attachment introuvable :** \`${args.uuid}\`

Utilisez \`roosync_list_attachments\` pour voir les UUIDs disponibles.`
        }]
      };
    }

    await manager.deleteAttachment(args.uuid);

    return {
      content: [{
        type: 'text',
        text: `✅ **Pièce jointe supprimée**

| Champ | Valeur |
|-------|--------|
| **UUID** | \`${meta.uuid}\` |
| **Fichier supprimé** | ${meta.originalName} |
| **Taille libérée** | ${formatSize(meta.sizeBytes)} |
| **Message lié** | ${meta.messageId || '—'} |

⚠️ Cette action est irréversible.`
      }]
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error('❌ roosync_delete_attachment error', error instanceof Error ? error : new Error(msg));
    return {
      content: [{
        type: 'text',
        text: `❌ **Erreur roosync_delete_attachment :** ${msg}`
      }]
    };
  }
}

// ============================================================
// CONS-7: Outil consolidé roosync_attachments (list + get + delete → 1)
// ============================================================

export async function roosyncAttachments(
  args: { action: 'list' | 'get' | 'delete'; message_id?: string; uuid?: string; filename?: string; targetPath?: string }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  logger.info('📎 roosync_attachments called', { action: args.action, uuid: args.uuid });

  switch (args.action) {
    case 'list':
      return roosyncListAttachments({ message_id: args.message_id });

    case 'get':
      // #3256 — uuid OU (message_id + filename) ; la résolution vit dans
      // roosyncGetAttachment pour un seul point de vérité.
      if (!args.uuid && !(args.message_id && args.filename)) {
        return { content: [{ type: 'text', text: '❌ Paramètre `uuid` requis pour action=get (ou `message_id` + `filename` — #3256).' }] };
      }
      if (!args.targetPath) return { content: [{ type: 'text', text: '❌ Paramètre `targetPath` requis pour action=get.' }] };
      return roosyncGetAttachment({
        uuid: args.uuid,
        targetPath: args.targetPath,
        message_id: args.message_id,
        filename: args.filename,
      });

    case 'delete':
      if (!args.uuid) return { content: [{ type: 'text', text: '❌ Paramètre `uuid` requis pour action=delete.' }] };
      return roosyncDeleteAttachment({ uuid: args.uuid });

    default:
      return { content: [{ type: 'text', text: `❌ Action inconnue : ${(args as any).action}. Valeurs valides : list, get, delete.` }] };
  }
}

// ============================================================
// Helper
// ============================================================

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
