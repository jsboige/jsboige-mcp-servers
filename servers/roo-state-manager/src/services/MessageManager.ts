/**
 * Service de gestion de messagerie inter-agents RooSync
 * 
 * Gère l'envoi, la réception et l'archivage de messages structurés
 * au format JSON entre machines dans l'écosystème RooSync.
 * 
 * @module MessageManager
 * @version 1.0.0
 */

import { existsSync, promises as fs, mkdirSync } from 'fs';
import { join } from 'path';
import { createLogger } from '../utils/logger.js';
import { MessageManagerError, MessageManagerErrorCode } from '../types/errors.js';
import { parseMachineWorkspace, matchesRecipient, getLocalWorkspaceId } from '../utils/message-helpers.js';

const logger = createLogger('MessageManager');

/**
 * Interface d'un message RooSync
 */
export interface Message {
  /** ID unique du message */
  id: string;
  
  /** ID de la machine émettrice */
  from: string;
  
  /** ID de la machine destinataire */
  to: string;
  
  /** Sujet du message */
  subject: string;
  
  /** Corps du message (markdown supporté) */
  body: string;
  
  /** Priorité du message */
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
  
  /** Timestamp ISO-8601 de création */
  timestamp: string;
  
  /** Statut du message */
  status: 'unread' | 'read' | 'archived';

  /** Tags optionnels */
  tags?: string[];

  /** ID de thread pour regrouper les conversations */
  thread_id?: string;

  /** ID du message auquel on répond */
  reply_to?: string;

  /** Machines/workspaces ayant lu ce message (tracking multi-lecteurs #629) */
  read_by?: string[];

  /** Timestamps de lecture par machine (machineId → ISO timestamp) */
  acknowledged_at?: Record<string, string>;

  /** Métadonnées optionnelles (amendements, etc.) */
  metadata?: {
    amended?: boolean;
    original_content?: string;
    amendment_reason?: string;
    amendment_timestamp?: string;
  };
}

/**
 * Interface d'un élément de liste de messages (vue condensée)
 */
export interface MessageListItem {
  /** ID unique du message */
  id: string;
  
  /** ID de la machine émettrice */
  from: string;
  
  /** ID de la machine destinataire */
  to: string;
  
  /** Sujet du message */
  subject: string;
  
  /** Priorité du message */
  priority: string;
  
  /** Timestamp ISO-8601 de création */
  timestamp: string;
  
  /** Statut du message */
  status: string;
  
  /** Aperçu des premiers caractères du corps */
  preview: string;
}

/**
 * Gestionnaire de messagerie RooSync
 * 
 * Responsabilités :
 * - Création et envoi de messages structurés
 * - Lecture de la boîte de réception
 * - Gestion du statut des messages (lu/non-lu)
 * - Archivage des messages
 */
export class MessageManager {
  private sharedStatePath: string;
  private messagesPath: string;
  private inboxPath: string;
  private sentPath: string;
  private archivePath: string;

  /**
   * Constructeur du MessageManager
   * 
   * @param sharedStatePath Chemin vers le répertoire .shared-state
   */
  constructor(sharedStatePath: string) {
    this.sharedStatePath = sharedStatePath;
    this.messagesPath = join(sharedStatePath, 'messages');
    this.inboxPath = join(this.messagesPath, 'inbox');
    this.sentPath = join(this.messagesPath, 'sent');
    this.archivePath = join(this.messagesPath, 'archive');

    // Créer les répertoires si nécessaires
    this.ensureDirectories();
  }

  /**
   * Crée les répertoires de messagerie s'ils n'existent pas
   * @private
   */
  private ensureDirectories(): void {
    const dirs = [
      this.messagesPath,
      this.inboxPath,
      this.sentPath,
      this.archivePath
    ];
    
    for (const dir of dirs) {
      if (!existsSync(dir)) {
        try {
          mkdirSync(dir, { recursive: true });
          logger.info(`Répertoire créé: ${dir}`);
        } catch (error) {
          logger.error(`Erreur création répertoire ${dir}`, error);
        }
      }
    }
  }

  /**
   * Génère un ID unique pour un message
   * Format: msg-YYYYMMDDHHMMSS-{random}
   * 
   * @returns ID unique du message
   * @private
   */
  private generateMessageId(): string {
    const timestamp = new Date()
      .toISOString()
      .replace(/[-:.]/g, '')
      .slice(0, 15); // YYYYMMDDHHmmssS
    const random = Math.random().toString(36).substring(2, 8);
    return `msg-${timestamp}-${random}`;
  }

  /**
   * Envoie un message à une autre machine
   * 
   * Crée le message dans l'inbox du destinataire et dans
   * le répertoire sent de l'expéditeur.
   * 
   * @param from ID de la machine émettrice
   * @param to ID de la machine destinataire
   * @param subject Sujet du message
   * @param body Corps du message (markdown supporté)
   * @param priority Priorité du message (défaut: MEDIUM)
   * @param tags Tags optionnels
   * @param threadId ID du thread de conversation
   * @param replyTo ID du message auquel on répond
   * @returns Le message créé
   */
  async sendMessage(
    from: string,
    to: string,
    subject: string,
    body: string,
    priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT' = 'MEDIUM',
    tags?: string[],
    threadId?: string,
    replyTo?: string
  ): Promise<Message> {
    logger.info(`Sending message from ${from} to ${to}`);

    // Validation anti-auto-messages (workspace-aware)
    // Same machine + same workspace = blocked
    // Same machine + different workspace = allowed
    const fromParsed = parseMachineWorkspace(from);
    const toParsed = parseMachineWorkspace(to);
    if (fromParsed.machineId === toParsed.machineId &&
        fromParsed.workspaceId === toParsed.workspaceId) {
      throw new MessageManagerError(
        `Auto-message interdit : ${from} ne peut pas envoyer de message à ${to}`,
        MessageManagerErrorCode.INVALID_RECIPIENT,
        { from, to, type: 'self-message' }
      );
    }

    const message: Message = {
      id: this.generateMessageId(),
      from,
      to,
      subject,
      body,
      priority,
      timestamp: new Date().toISOString(),
      status: 'unread',
      tags,
      thread_id: threadId,
      reply_to: replyTo
    };

    try {
      // Sauvegarder dans inbox du destinataire
      const inboxFile = join(this.inboxPath, `${message.id}.json`);
      await fs.writeFile(inboxFile, JSON.stringify(message, null, 2), 'utf-8');
      logger.info(`Message saved to inbox: ${inboxFile}`);

      // Sauvegarder dans sent de l'expéditeur
      const sentFile = join(this.sentPath, `${message.id}.json`);
      await fs.writeFile(sentFile, JSON.stringify(message, null, 2), 'utf-8');
      logger.info(`Message saved to sent: ${sentFile}`);

      logger.info(`Message sent successfully: ${message.id}`);
      return message;
    } catch (error) {
      logger.error('Error sending message', error);
      throw error;
    }
  }

  /**
   * Lit la boîte de réception d'une machine
   *
   * Filtre les messages par destinataire et statut, puis les trie
   * par ordre chronologique décroissant (plus récents en premier).
   *
   * Supporte le format workspace: "machineId:workspaceId"
   * - Messages à "machineId" (sans workspace) → visibles par tous les workspaces
   * - Messages à "machineId:workspaceId" → visibles uniquement par ce workspace
   * - Messages à "all" → visibles par tous
   *
   * @param machineId ID de la machine destinataire
   * @param status Filtrer par statut (unread, read, all)
   * @param limit Nombre maximum de messages à retourner
   * @param workspaceId ID optionnel du workspace pour filtrage
   * @returns Liste des messages correspondants
   */
  async readInbox(
    machineId: string,
    status?: 'unread' | 'read' | 'all',
    limit?: number,
    workspaceId?: string
  ): Promise<MessageListItem[]> {
    // Auto-détection du workspace si non fourni
    const effectiveWorkspaceId = workspaceId || getLocalWorkspaceId();
    logger.info(`Reading inbox for: ${machineId}:${effectiveWorkspaceId}`);

    if (!existsSync(this.inboxPath)) {
      logger.warn(`Inbox path does not exist: ${this.inboxPath}`);
      return [];
    }

    try {
      const files = (await fs.readdir(this.inboxPath)).filter(f => f.endsWith('.json'));
      logger.info(`Found ${files.length} message files`);

      const messages: MessageListItem[] = [];

      for (const file of files) {
        try {
          const content = await fs.readFile(join(this.inboxPath, file), 'utf-8');
          const message: Message = JSON.parse(content);

          // Filtrer par destinataire (workspace-aware)
          if (!matchesRecipient(message.to, machineId, effectiveWorkspaceId)) {
            continue;
          }

          // Filtrer par status — per-machine for broadcasts (#629)
          if (status && status !== 'all') {
            const isBroadcast = message.to === 'all' || message.to === 'All';
            if (isBroadcast && message.read_by) {
              // For broadcasts, check per-machine read_by instead of global status
              const readerMachineId = parseMachineWorkspace(machineId).machineId;
              const hasRead = message.read_by.includes(readerMachineId);
              if (status === 'unread' && hasRead) continue;
              if (status === 'read' && !hasRead) continue;
            } else {
              // For targeted messages or broadcasts without read_by, use global status
              if (message.status !== status) continue;
            }
          }

          messages.push({
            id: message.id,
            from: message.from,
            to: message.to,
            subject: message.subject,
            priority: message.priority,
            timestamp: message.timestamp,
            status: message.status,
            preview: message.body.substring(0, 100) + (message.body.length > 100 ? '...' : '')
          });
        } catch (error) {
          logger.error(`Error reading message ${file}`, error);
        }
      }

      // Trier par timestamp décroissant (plus récents en premier)
      messages.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

      // Limiter le nombre de résultats
      const result = limit ? messages.slice(0, limit) : messages;
      logger.info(`Returning ${result.length} messages`);

      return result;
    } catch (error) {
      logger.error('Error reading inbox', error);
      return [];
    }
  }

  /**
   * Obtient un message spécifique par son ID
   * 
   * Cherche dans inbox, sent, puis archive.
   * 
   * @param messageId ID du message à récupérer
   * @returns Le message complet ou null si introuvable
   */
  async getMessage(messageId: string): Promise<Message | null> {
    logger.info(`Getting message: ${messageId}`);

    const searchPaths = [
      join(this.inboxPath, `${messageId}.json`),
      join(this.sentPath, `${messageId}.json`),
      join(this.archivePath, `${messageId}.json`)
    ];

    for (const filePath of searchPaths) {
      if (existsSync(filePath)) {
        try {
          const content = await fs.readFile(filePath, 'utf-8');
          const message: Message = JSON.parse(content);
          logger.info(`Message found in: ${filePath}`);
          return message;
        } catch (error) {
          logger.error(`Error reading message from ${filePath}`, error);
        }
      }
    }

    logger.warn(`Message not found: ${messageId}`);
    return null;
  }

  /**
   * Marque un message comme lu par une machine spécifique.
   *
   * Pour les messages broadcast (to: "all"), utilise le tracking per-machine
   * via read_by[]. Le status global ne passe à 'read' que quand la machine
   * spécifiée a lu (pour les messages ciblés) ou reste 'unread' pour les
   * broadcasts tant que d'autres machines ne l'ont pas lu.
   *
   * @param messageId ID du message à marquer comme lu
   * @param readerId ID de la machine qui lit (optionnel, défaut: machine locale)
   * @returns true si succès, false sinon
   */
  async markAsRead(messageId: string, readerId?: string): Promise<boolean> {
    logger.info(`Marking message as read: ${messageId}${readerId ? ` by ${readerId}` : ''}`);

    const filePath = join(this.inboxPath, `${messageId}.json`);
    if (!existsSync(filePath)) {
      logger.warn(`Message not found in inbox: ${messageId}`);
      return false;
    }

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const message: Message = JSON.parse(content);

      // Track per-machine read status (#629)
      if (readerId) {
        const readerMachineId = parseMachineWorkspace(readerId).machineId;
        if (!message.read_by) {
          message.read_by = [];
        }
        if (!message.read_by.includes(readerMachineId)) {
          message.read_by.push(readerMachineId);
        }
        if (!message.acknowledged_at) {
          message.acknowledged_at = {};
        }
        if (!message.acknowledged_at[readerMachineId]) {
          message.acknowledged_at[readerMachineId] = new Date().toISOString();
        }
        logger.info(`Reader ${readerMachineId} tracked in read_by (${message.read_by.length} readers)`);
      }

      // For targeted messages (not broadcast), set global status to 'read'
      // For broadcasts (to: "all"/"All"), keep status as-is — per-machine filtering uses read_by
      const isBroadcast = message.to === 'all' || message.to === 'All';
      if (!isBroadcast) {
        message.status = 'read';
      }

      await fs.writeFile(filePath, JSON.stringify(message, null, 2), 'utf-8');

      // Also update sent/ directory if message was sent from this machine
      const sentPath = join(this.sentPath, `${messageId}.json`);
      if (existsSync(sentPath)) {
        await fs.writeFile(sentPath, JSON.stringify(message, null, 2), 'utf-8');
        logger.info('Message also updated in sent/');
      }

      logger.info('Message marked as read');
      return true;
    } catch (error) {
      logger.error('Error marking message as read', error);
      return false;
    }
  }

  /**
   * Archive un message
   * 
   * Déplace le message de l'inbox vers le répertoire archive
   * et met à jour son statut.
   * 
   * @param messageId ID du message à archiver
   * @returns true si succès, false sinon
   */
  async archiveMessage(messageId: string): Promise<boolean> {
    logger.info(`Archiving message: ${messageId}`);

    const inboxFile = join(this.inboxPath, `${messageId}.json`);
    if (!existsSync(inboxFile)) {
      logger.warn(`Message not found in inbox: ${messageId}`);
      return false;
    }

    try {
      const content = await fs.readFile(inboxFile, 'utf-8');
      const message: Message = JSON.parse(content);
      message.status = 'archived';

      // Déplacer vers archive
      const archiveFile = join(this.archivePath, `${messageId}.json`);
      await fs.writeFile(archiveFile, JSON.stringify(message, null, 2), 'utf-8');

      // Supprimer de inbox
      await fs.unlink(inboxFile);
      
      // Also update sent/ directory if message was sent from this machine
      const sentPath = join(this.sentPath, `${messageId}.json`);
      if (existsSync(sentPath)) {
        await fs.writeFile(sentPath, JSON.stringify(message, null, 2), 'utf-8');
        logger.info('Message also archived in sent/');
      }

      logger.info('Message archived');
      return true;
    } catch (error) {
      logger.error('Error archiving message', error);
      return false;
    }
  }
  /**
   * Modifie le contenu d'un message envoyé (avant lecture)
   *
   * Permet de corriger un message non lu en préservant le contenu original
   * dans les métadonnées pour traçabilité. Restreint à l'émetteur uniquement.
   *
   * @param messageId ID du message à modifier
   * @param senderId ID de la machine émettrice (pour validation permissions)
   * @param newContent Nouveau contenu du message
   * @param reason Raison de l'amendement (optionnel)
   * @returns Résultat de l'amendement avec métadonnées
   */
  async amendMessage(
    messageId: string,
    senderId: string,
    newContent: string,
    reason?: string
  ): Promise<{
    success: boolean;
    message_id: string;
    amended_at: string;
    reason: string;
    original_content_preserved: boolean;
  }> {
    logger.info(`Amending message: ${messageId}`);

    // Rechercher le message dans sent/
    const sentFile = join(this.sentPath, `${messageId}.json`);
    
    if (!existsSync(sentFile)) {
      throw new MessageManagerError(
        `Message non trouvé dans sent/ : ${messageId}. Seuls les messages envoyés peuvent être amendés.`,
        MessageManagerErrorCode.MESSAGE_NOT_FOUND,
        { messageId, location: 'sent', action: 'amend' }
      );
    }

    try {
      // Lire le message actuel
      const content = await fs.readFile(sentFile, 'utf-8');
      const message: Message = JSON.parse(content);

      // Validation : Vérifier que le message n'est pas lu/archivé (en premier)
      if (message.status !== 'unread') {
        throw new MessageManagerError(
          `Impossible d'amender un message déjà lu ou archivé (status: ${message.status}).`,
          MessageManagerErrorCode.INVALID_MESSAGE_FORMAT,
          { messageId, status: message.status, expectedStatus: 'unread', action: 'amend' }
        );
      }

      // Validation : Vérifier que l'émetteur correspond (comparaison par machineId uniquement)
      // The sender may use a different workspace suffix (e.g., worktree vs main workspace)
      // so we compare at the machine level, not the full "machine:workspace" string
      const messageSender = parseMachineWorkspace(message.from);
      const currentSender = parseMachineWorkspace(senderId);
      if (messageSender.machineId !== currentSender.machineId) {
        throw new MessageManagerError(
          `Permission refusée : seul l'émetteur (${message.from}) peut amender ce message.`,
          MessageManagerErrorCode.MESSAGE_SEND_FAILED,
          { messageId, expectedSender: message.from, actualSender: currentSender.machineId, action: 'amend' }
        );
      }

      // Préserver le contenu original si c'est le premier amendement
      const isFirstAmendment = !message.metadata?.amended;
      
      if (isFirstAmendment) {
        message.metadata = {
          ...message.metadata,
          amended: true,
          original_content: message.body
        };
      }

      // Mettre à jour le contenu et les métadonnées d'amendement
      message.body = newContent;
      message.metadata = {
        ...message.metadata,
        amendment_reason: reason || 'Aucune raison fournie',
        amendment_timestamp: new Date().toISOString()
      };

      // Sauvegarder le message modifié dans sent/
      await fs.writeFile(sentFile, JSON.stringify(message, null, 2), 'utf-8');

      // Également mettre à jour dans inbox/ si le message y est présent
      const inboxFile = join(this.inboxPath, `${messageId}.json`);
      if (existsSync(inboxFile)) {
        await fs.writeFile(inboxFile, JSON.stringify(message, null, 2), 'utf-8');
        logger.info('Message updated in inbox as well');
      }

      logger.info('Message amended successfully');
      
      return {
        success: true,
        message_id: message.id,
        amended_at: message.metadata.amendment_timestamp!,
        reason: message.metadata.amendment_reason!,
        original_content_preserved: !!message.metadata.original_content
      };
    } catch (error) {
      logger.error('Error amending message', error);
      throw error;
    }
  }

  /**
   * Vérifie et retourne les nouveaux messages non lus
   *
   * Wrapper de convenance pour obtenir rapidement les messages
   * non lus pour une machine donnée. Utilisé par le système
   * de notifications push.
   *
   * @param machineId ID de la machine destinataire
   * @param workspaceId ID optionnel du workspace pour filtrage
   * @returns Liste des messages non lus
   */
  async checkNewMessages(machineId: string, workspaceId?: string): Promise<MessageListItem[]> {
    logger.info(`Checking for new messages for: ${machineId}${workspaceId ? ':' + workspaceId : ''}`);
    return await this.readInbox(machineId, 'unread', undefined, workspaceId);
  }

  /**
   * Performs a bulk operation (mark_read or archive) on messages matching filter criteria.
   *
   * All filter criteria are ANDed together. Only messages matching ALL criteria are affected.
   *
   * @param machineId ID of the receiving machine
   * @param operation Operation to perform: 'mark_read' or 'archive'
   * @param filters Filter criteria
   * @param workspaceId Optional workspace ID for recipient filtering
   * @returns Summary of the operation
   */
  async bulkOperation(
    machineId: string,
    operation: 'mark_read' | 'archive',
    filters: {
      /** Filter by sender machine ID (substring match) */
      from?: string;
      /** Filter by priority level */
      priority?: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
      /** Filter by messages older than this ISO date */
      before_date?: string;
      /** Filter by subject substring (case-insensitive) */
      subject_contains?: string;
      /** Filter by tag */
      tag?: string;
      /** Only affect messages with this status */
      status?: 'unread' | 'read';
    },
    workspaceId?: string
  ): Promise<{
    operation: string;
    matched: number;
    processed: number;
    errors: number;
    message_ids: string[];
  }> {
    const effectiveWorkspaceId = workspaceId || getLocalWorkspaceId();
    logger.info(`Bulk ${operation} for ${machineId}:${effectiveWorkspaceId}`, { filters });

    if (!existsSync(this.inboxPath)) {
      return { operation, matched: 0, processed: 0, errors: 0, message_ids: [] };
    }

    const files = (await fs.readdir(this.inboxPath)).filter(f => f.endsWith('.json'));
    const matchedIds: string[] = [];
    let errors = 0;

    for (const file of files) {
      try {
        const content = await fs.readFile(join(this.inboxPath, file), 'utf-8');
        const message: Message = JSON.parse(content);

        // Check recipient match
        if (!matchesRecipient(message.to, machineId, effectiveWorkspaceId)) {
          continue;
        }

        // Apply filters (AND logic)
        if (filters.from && !message.from.toLowerCase().includes(filters.from.toLowerCase())) {
          continue;
        }
        if (filters.priority && message.priority !== filters.priority) {
          continue;
        }
        if (filters.before_date && new Date(message.timestamp) >= new Date(filters.before_date)) {
          continue;
        }
        if (filters.subject_contains && !message.subject.toLowerCase().includes(filters.subject_contains.toLowerCase())) {
          continue;
        }
        if (filters.tag && (!message.tags || !message.tags.includes(filters.tag))) {
          continue;
        }
        if (filters.status) {
          const isBroadcast = message.to === 'all' || message.to === 'All';
          if (isBroadcast && message.read_by) {
            const readerMachineId = parseMachineWorkspace(machineId).machineId;
            const hasRead = message.read_by.includes(readerMachineId);
            if (filters.status === 'unread' && hasRead) continue;
            if (filters.status === 'read' && !hasRead) continue;
          } else {
            if (message.status !== filters.status) continue;
          }
        }

        matchedIds.push(message.id);
      } catch (error) {
        logger.error(`Error reading message ${file}`, error);
        errors++;
      }
    }

    // Apply the operation to matched messages
    let processed = 0;
    for (const id of matchedIds) {
      try {
        if (operation === 'mark_read') {
          const success = await this.markAsRead(id, machineId);
          if (success) processed++;
          else errors++;
        } else if (operation === 'archive') {
          const success = await this.archiveMessage(id);
          if (success) processed++;
          else errors++;
        }
      } catch (error) {
        logger.error(`Error processing message ${id}`, error);
        errors++;
      }
    }

    logger.info(`Bulk ${operation} complete: ${processed}/${matchedIds.length} processed`);
    return {
      operation,
      matched: matchedIds.length,
      processed,
      errors,
      message_ids: matchedIds
    };
  }

  /**
   * Returns inbox statistics for a machine
   *
   * @param machineId ID of the receiving machine
   * @param workspaceId Optional workspace ID
   * @returns Inbox statistics
   */
  async getInboxStats(
    machineId: string,
    workspaceId?: string
  ): Promise<{
    total: number;
    unread: number;
    read: number;
    by_priority: Record<string, number>;
    by_sender: Record<string, number>;
    oldest_unread: string | null;
  }> {
    const effectiveWorkspaceId = workspaceId || getLocalWorkspaceId();
    logger.info(`Getting inbox stats for ${machineId}:${effectiveWorkspaceId}`);

    const stats = {
      total: 0,
      unread: 0,
      read: 0,
      by_priority: {} as Record<string, number>,
      by_sender: {} as Record<string, number>,
      oldest_unread: null as string | null
    };

    if (!existsSync(this.inboxPath)) {
      return stats;
    }

    const files = (await fs.readdir(this.inboxPath)).filter(f => f.endsWith('.json'));
    let oldestUnreadDate: Date | null = null;

    for (const file of files) {
      try {
        const content = await fs.readFile(join(this.inboxPath, file), 'utf-8');
        const message: Message = JSON.parse(content);

        if (!matchesRecipient(message.to, machineId, effectiveWorkspaceId)) {
          continue;
        }

        stats.total++;

        // Per-machine read status for broadcasts (#629)
        const isBroadcast = message.to === 'all' || message.to === 'All';
        let isUnreadForThisMachine: boolean;
        if (isBroadcast && message.read_by) {
          const readerMachineId = parseMachineWorkspace(machineId).machineId;
          isUnreadForThisMachine = !message.read_by.includes(readerMachineId);
        } else {
          isUnreadForThisMachine = message.status === 'unread';
        }

        if (isUnreadForThisMachine) {
          stats.unread++;
          const msgDate = new Date(message.timestamp);
          if (!oldestUnreadDate || msgDate < oldestUnreadDate) {
            oldestUnreadDate = msgDate;
            stats.oldest_unread = message.timestamp;
          }
        } else {
          stats.read++;
        }

        // Count by priority
        const prio = message.priority || 'MEDIUM';
        stats.by_priority[prio] = (stats.by_priority[prio] || 0) + 1;

        // Count by sender (machine ID only)
        const sender = parseMachineWorkspace(message.from).machineId;
        stats.by_sender[sender] = (stats.by_sender[sender] || 0) + 1;
      } catch (error) {
        logger.error(`Error reading message ${file}`, error);
      }
    }

    return stats;
  }
}