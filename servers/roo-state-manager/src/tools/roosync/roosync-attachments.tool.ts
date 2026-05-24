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

import { AttachmentManager } from '../../services/roosync/AttachmentManager.js';
import { getSharedStatePath } from '../../utils/shared-state-path.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('RooSyncAttachmentTools');

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
    const attachments = await manager.listAttachments(args.message_id);

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

    const text = `## 📎 Pièces Jointes — ${scopeLabel}

**Total :** ${attachments.length}

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
  args: { uuid: string; targetPath: string }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  logger.info('📥 roosync_get_attachment called', { uuid: args.uuid, targetPath: args.targetPath });

  if (!args.uuid) {
    return { content: [{ type: 'text', text: '❌ Paramètre `uuid` requis.' }] };
  }
  if (!args.targetPath) {
    return { content: [{ type: 'text', text: '❌ Paramètre `targetPath` requis.' }] };
  }

  try {
    const sharedStatePath = getSharedStatePath();
    const manager = new AttachmentManager(sharedStatePath);
    const meta = await manager.getAttachment(args.uuid, args.targetPath);

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
- L'UUID \`${args.uuid}\` est-il correct ?
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
  args: { action: 'list' | 'get' | 'delete'; message_id?: string; uuid?: string; targetPath?: string }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  logger.info('📎 roosync_attachments called', { action: args.action, uuid: args.uuid });

  switch (args.action) {
    case 'list':
      return roosyncListAttachments({ message_id: args.message_id });

    case 'get':
      if (!args.uuid) return { content: [{ type: 'text', text: '❌ Paramètre `uuid` requis pour action=get.' }] };
      if (!args.targetPath) return { content: [{ type: 'text', text: '❌ Paramètre `targetPath` requis pour action=get.' }] };
      return roosyncGetAttachment({ uuid: args.uuid, targetPath: args.targetPath });

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
