/**
 * Service de gestion des pièces jointes RooSync (#674)
 *
 * Permet de stocker et récupérer des fichiers attachés aux messages RooSync
 * dans le répertoire partagé .shared-state/attachments/.
 *
 * Structure de stockage:
 * .shared-state/attachments/
 *   +-- {UUID}/
 *   |   +-- original_filename.ext
 *   |   +-- metadata.json
 *
 * @module services/roosync/AttachmentManager
 * @version 1.0.0
 */

import { existsSync, promises as fs, mkdirSync } from 'fs';
import { join, basename } from 'path';
import { randomUUID } from 'crypto';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('AttachmentManager');

// Cleanup: delete attachments older than this many days
const DEFAULT_MAX_AGE_DAYS = 30;

/**
 * Métadonnées d'une pièce jointe stockée
 */
export interface AttachmentMetadata {
  /** UUID unique de la pièce jointe */
  uuid: string;
  /** Nom original du fichier */
  originalName: string;
  /** Type MIME (déterminé par extension) */
  mimeType: string;
  /** Taille en octets */
  sizeBytes: number;
  /** Timestamp ISO-8601 d'upload */
  uploadedAt: string;
  /** ID de la machine qui a uploadé */
  uploaderMachineId: string;
  /** Workspace de la machine qui a uploadé (optionnel) */
  uploaderWorkspace?: string;
  /** ID du message auquel cet attachment est lié (optionnel) */
  messageId?: string;
}

/**
 * Référence compacte à une pièce jointe (incluse dans le message JSON)
 */
export interface AttachmentRef {
  uuid: string;
  filename: string;
  sizeBytes: number;
}

/**
 * Correspondance extension → type MIME basique
 */
const MIME_TYPES: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.ts': 'text/typescript',
  '.js': 'text/javascript',
  '.html': 'text/html',
  '.css': 'text/css',
  '.xml': 'application/xml',
  '.csv': 'text/csv',
  '.log': 'text/plain',
  '.sh': 'text/x-shellscript',
  '.ps1': 'text/x-powershell',
};

function getMimeType(filename: string): string {
  const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

/**
 * Service de gestion des pièces jointes RooSync
 */
export class AttachmentManager {
  private attachmentsPath: string;

  constructor(sharedStatePath: string) {
    this.attachmentsPath = join(sharedStatePath, 'attachments');
  }

  /**
   * S'assure que le répertoire de base des attachments existe
   */
  private ensureAttachmentsDir(): void {
    if (!existsSync(this.attachmentsPath)) {
      mkdirSync(this.attachmentsPath, { recursive: true });
    }
  }

  /**
   * Upload un fichier local en tant que pièce jointe
   *
   * @param filePath Chemin local du fichier source
   * @param uploaderMachineId ID de la machine qui uploade
   * @param filename Nom optionnel (défaut: basename du path)
   * @param messageId ID du message auquel lier l'attachment (optionnel)
   * @returns Référence compacte vers la pièce jointe
   */
  async uploadAttachment(
    filePath: string,
    uploaderMachineId: string,
    filename?: string,
    messageId?: string
  ): Promise<AttachmentRef> {
    // Vérifier que le fichier source existe
    if (!existsSync(filePath)) {
      throw new Error(`Fichier source introuvable: ${filePath}`);
    }

    this.ensureAttachmentsDir();

    const resolvedFilename = filename || basename(filePath);
    const uuid = randomUUID();
    const attachmentDir = join(this.attachmentsPath, uuid);

    // Créer le répertoire UUID
    await fs.mkdir(attachmentDir, { recursive: true });

    // Copier le fichier
    const targetFilePath = join(attachmentDir, resolvedFilename);
    await fs.copyFile(filePath, targetFilePath);

    // Calculer la taille
    const stat = await fs.stat(targetFilePath);
    const sizeBytes = stat.size;

    // Créer les métadonnées
    const metadata: AttachmentMetadata = {
      uuid,
      originalName: resolvedFilename,
      mimeType: getMimeType(resolvedFilename),
      sizeBytes,
      uploadedAt: new Date().toISOString(),
      uploaderMachineId,
      ...(messageId && { messageId }),
    };

    const metadataPath = join(attachmentDir, 'metadata.json');
    await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf-8');

    logger.info('📎 Attachment uploaded', { uuid, filename: resolvedFilename, sizeBytes });

    return { uuid, filename: resolvedFilename, sizeBytes };
  }

  /**
   * Liste les pièces jointes, avec filtre optionnel par messageId
   *
   * @param messageId Filtre optionnel par ID de message
   * @returns Liste des métadonnées d'attachments
   */
  async listAttachments(messageId?: string): Promise<AttachmentMetadata[]> {
    if (!existsSync(this.attachmentsPath)) {
      return [];
    }

    const entries = await fs.readdir(this.attachmentsPath, { withFileTypes: true });
    const results: AttachmentMetadata[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const metadataPath = join(this.attachmentsPath, entry.name, 'metadata.json');
      if (!existsSync(metadataPath)) continue;

      try {
        const raw = await fs.readFile(metadataPath, 'utf-8');
        const meta: AttachmentMetadata = JSON.parse(raw);

        if (!messageId || meta.messageId === messageId) {
          results.push(meta);
        }
      } catch (err) {
        logger.warn('Failed to parse attachment metadata', { uuid: entry.name, error: String(err) });
      }
    }

    return results;
  }

  /**
   * Récupère les métadonnées d'un attachment par UUID
   *
   * @param uuid UUID de la pièce jointe
   * @returns Métadonnées ou null si introuvable
   */
  async getAttachmentMetadata(uuid: string): Promise<AttachmentMetadata | null> {
    const metadataPath = join(this.attachmentsPath, uuid, 'metadata.json');
    if (!existsSync(metadataPath)) {
      return null;
    }

    try {
      const raw = await fs.readFile(metadataPath, 'utf-8');
      return JSON.parse(raw) as AttachmentMetadata;
    } catch (err) {
      logger.warn('Failed to read attachment metadata', { uuid, error: String(err) });
      return null;
    }
  }

  /**
   * Copie un attachment vers un chemin cible local
   *
   * @param uuid UUID de la pièce jointe
   * @param targetPath Chemin de destination
   */
  async getAttachment(uuid: string, targetPath: string): Promise<AttachmentMetadata> {
    const meta = await this.getAttachmentMetadata(uuid);
    if (!meta) {
      throw new Error(`Attachment introuvable: ${uuid}`);
    }

    const sourceFile = join(this.attachmentsPath, uuid, meta.originalName);
    if (!existsSync(sourceFile)) {
      throw new Error(`Fichier attachment introuvable: ${uuid}/${meta.originalName}`);
    }

    await fs.copyFile(sourceFile, targetPath);
    logger.info('📥 Attachment downloaded', { uuid, targetPath });

    return meta;
  }

  /**
   * Supprime un attachment et son répertoire UUID
   *
   * @param uuid UUID de la pièce jointe à supprimer
   */
  async deleteAttachment(uuid: string): Promise<void> {
    const attachmentDir = join(this.attachmentsPath, uuid);
    if (!existsSync(attachmentDir)) {
      throw new Error(`Attachment introuvable: ${uuid}`);
    }

    await fs.rm(attachmentDir, { recursive: true, force: true });
    logger.info('🗑️ Attachment deleted', { uuid });
  }

  /**
   * Supprime les attachments plus anciens que maxAgeDays
   *
   * @param maxAgeDays Âge maximum en jours (défaut: 30)
   * @returns Nombre d'attachments supprimés
   */
  async cleanupOldAttachments(maxAgeDays: number = DEFAULT_MAX_AGE_DAYS): Promise<number> {
    if (!existsSync(this.attachmentsPath)) {
      return 0;
    }

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - maxAgeDays);

    const entries = await fs.readdir(this.attachmentsPath, { withFileTypes: true });
    let deletedCount = 0;

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const metadataPath = join(this.attachmentsPath, entry.name, 'metadata.json');
      if (!existsSync(metadataPath)) continue;

      try {
        const raw = await fs.readFile(metadataPath, 'utf-8');
        const meta: AttachmentMetadata = JSON.parse(raw);
        const uploadedAt = new Date(meta.uploadedAt);

        if (uploadedAt < cutoffDate) {
          const attachmentDir = join(this.attachmentsPath, entry.name);
          await fs.rm(attachmentDir, { recursive: true, force: true });
          deletedCount++;
          logger.info('🧹 Old attachment cleaned up', { uuid: entry.name, uploadedAt: meta.uploadedAt });
        }
      } catch (err) {
        logger.warn('Failed to process attachment during cleanup', { uuid: entry.name, error: String(err) });
      }
    }

    logger.info('🧹 Attachment cleanup complete', { deletedCount, maxAgeDays });
    return deletedCount;
  }
}
