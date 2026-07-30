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
 * Per-read timeout for attachment metadata/files.
 *
 * On GDrive Files On-Demand (the RooSync shared-state backing store), a file
 * whose content is "cloud-only" makes `fs.readFile`/`fs.copyFile` block while
 * GDrive tries to fetch it — observed hanging past the 120s MCP tool timeout,
 * wedging `attachments_list` (#2267 residual). This cap lets `listAttachments`
 * skip a hung entry and return a partial result instead of blocking forever.
 */
const ATTACHMENT_READ_TIMEOUT_MS = 10_000;

/**
 * Max concurrent metadata reads in `listAttachments`.
 *
 * The per-read cap above bounds each read but NOT their sum. Read sequentially,
 * a shared folder holding N cloud-only attachments costs
 * N × ATTACHMENT_READ_TIMEOUT_MS: at the 153 attachments observed on the fleet
 * share that is ~25 min, far past both MCP tool timeouts (120s / 300s), so the
 * tool always died before returning — and worse, the cost grows with fleet
 * history, so it can only get further out of reach.
 *
 * With bounded concurrency the worst case becomes ceil(N / C) × timeout:
 * 153 entries at C=32 is ~50s, which fits under the tool timeout. Bounded
 * rather than unbounded so we never open N handles at once against the GDrive
 * FUSE mount.
 */
const ATTACHMENT_LIST_CONCURRENCY = 32;

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
 * Compteur des entrées omises par `listAttachments`, ventilé par cause.
 *
 * `listAttachments` lit chaque `metadata.json` et peut skipper un slot pour
 * trois raisons distinctes — fichier absent, lecture expirée (cloud-only
 * GDrive), JSON invalide. L'ancien chemin les confondait avec le filtre
 * `messageId` voulu via `.filter(meta => meta !== undefined)`, laissant
 * l'appelant sans signal qu'une partie de la liste avait été silencieusement
 * tronquée (#3013).
 *
 * Le filtre `messageId` est intentionnel et n'est PAS compté ici — l'agréger
 * aux pertes rendrait le signal inutilisable (un appel par `messageId` aurait
 * toujours N-1 "pertes" pour N attachments total).
 *
 * Le paramètre est optionnel : un appelant qui ne le passe pas reçoit le
 * comportement historique (table tronquée, aucun signal). Seul le surface
 * outil (`attachments_list`) le peuple aujourd'hui et traduit le total en
 * ligne d'avertissement.
 */
export interface AttachmentListStats {
  /** UUID dir présente mais `metadata.json` absent (upload interrompu ?). */
  missingMetadata: number;
  /** `readFile` a expiré (cloud-only GDrive, #2267 residual). */
  readTimeout: number;
  /** `JSON.parse` a échoué sur un metadata.json illisible. */
  parseError: number;
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
 * Race a promise against a timeout. Resolves to `null` on timeout (caller
 * decides whether to skip or throw), never rejects from the timeout side.
 * Used to defend `listAttachments` against GDrive cloud-only files that hang
 * `fs.readFile` indefinitely (#2267 residual).
 */
function withReadTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      logger.warn('⏱️ Attachment read timed out (cloud-only file?)', { label, ms });
      resolve(null);
    }, ms);
    // `.unref()` so a hung read (timer the only pending work) doesn't keep a
    // short-lived process alive for `ms` — the timer still fires as long as the
    // event loop is alive (it just doesn't *keep* it alive). The `.finally`
    // clearTimeout below covers the resolved-before-timeout path.
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Service de gestion des pièces jointes RooSync
 */
export class AttachmentManager {
  private attachmentsPath: string;
  private readonly readTimeoutMs: number;

  constructor(sharedStatePath: string, readTimeoutMs: number = ATTACHMENT_READ_TIMEOUT_MS) {
    this.attachmentsPath = join(sharedStatePath, 'attachments');
    this.readTimeoutMs = readTimeoutMs;
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
   * @param stats Compteur optionnel des entrées omises, ventilé par cause
   *   (`missingMetadata`, `readTimeout`, `parseError`). Pass-by-reference :
   *   l'appelant alloue l'objet, la méthode le peuple. Voir `AttachmentListStats`.
   * @returns Liste des métadonnées d'attachments
   */
  async listAttachments(
    messageId?: string,
    stats?: AttachmentListStats,
  ): Promise<AttachmentMetadata[]> {
    if (!existsSync(this.attachmentsPath)) {
      return [];
    }

    const entries = await fs.readdir(this.attachmentsPath, { withFileTypes: true });
    const dirs = entries.filter((entry) => entry.isDirectory());

    // Slot-indexed so the result keeps readdir order regardless of which reads
    // finish first — callers saw a stable order before this became concurrent.
    const slots: (AttachmentMetadata | undefined)[] = new Array(dirs.length);

    // Worker pool draining a shared cursor: exactly ATTACHMENT_LIST_CONCURRENCY
    // reads stay in flight, so one hung (cloud-only) entry stalls its own worker
    // and nothing else — the entries behind it are already being read by peers.
    let cursor = 0;
    const drain = async (): Promise<void> => {
      while (cursor < dirs.length) {
        const index = cursor++;
        const entry = dirs[index];

        const metadataPath = join(this.attachmentsPath, entry.name, 'metadata.json');
        if (!existsSync(metadataPath)) {
          // Cause #1: UUID dir exists but metadata.json is missing (interrupted
          // upload, manual deletion). Surfaced via `stats.missingMetadata` when
          // the caller wants to distinguish a partial list from a complete one
          // (#3013) — the historical behavior was a silent `continue`.
          if (stats) stats.missingMetadata++;
          continue;
        }

        try {
          const raw = await withReadTimeout(
            fs.readFile(metadataPath, 'utf-8'),
            this.readTimeoutMs,
            `metadata:${entry.name}`,
          );
          // Skip entries whose metadata read timed out (GDrive cloud-only hang, #2267 residual).
          // Keeps `attachments_list` responsive by returning a partial result.
          if (raw === null) {
            // Cause #2: per-read timeout. The warn log fires inside `withReadTimeout`
            // (diagnosable at tool level); here we count it so the response can say
            // *how many* were dropped instead of leaving the caller to guess (#3013).
            if (stats) stats.readTimeout++;
            continue;
          }

          const meta: AttachmentMetadata = JSON.parse(raw);

          // Filter `messageId` is intentional — NOT counted as a loss. Aggregating
          // it would make the signal unusable (a per-message call always drops N-1
          // of N attachments). See `AttachmentListStats` doc.
          if (!messageId || meta.messageId === messageId) {
            slots[index] = meta;
          }
        } catch (err) {
          // Cause #3: JSON.parse failed on an unreadable metadata.json.
          logger.warn('Failed to parse attachment metadata', { uuid: entry.name, error: String(err) });
          if (stats) stats.parseError++;
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(ATTACHMENT_LIST_CONCURRENCY, dirs.length) }, drain),
    );

    return slots.filter((meta): meta is AttachmentMetadata => meta !== undefined);
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
      const raw = await withReadTimeout(
        fs.readFile(metadataPath, 'utf-8'),
        this.readTimeoutMs,
        `metadata:${uuid}`,
      );
      // Cloud-only hang timed out (#2267 residual, #818 follow-up): treat as
      // unavailable rather than blocking the caller. Null propagates to
      // getAttachment() which throws "introuvable"; the warn log surfaces the
      // real cause (cloud-only) above the generic not-found semantics.
      if (raw === null) return null;
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

    // copyFile of a cloud-only source hangs the same way readFile does (#818
    // follow-up). copyFile can't yield a partial file — surface a fast, explicit
    // error instead of leaving a half-written target or blocking past 120s.
    const copied = await withReadTimeout(
      fs.copyFile(sourceFile, targetPath),
      this.readTimeoutMs,
      `content:${uuid}`,
    );
    if (copied === null) {
      throw new Error(`Attachment content indisponible (cloud-only?): ${uuid}/${meta.originalName}`);
    }
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
        const raw = await withReadTimeout(
          fs.readFile(metadataPath, 'utf-8'),
          this.readTimeoutMs,
          `metadata:${entry.name}`,
        );
        // Cloud-only hang timed out: skip this entry (cf. listAttachments #818)
        // so cleanup stays responsive instead of blocking on one cloud-only dir.
        if (raw === null) continue;
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
