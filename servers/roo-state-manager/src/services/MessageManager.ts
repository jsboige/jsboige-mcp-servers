/**
 * Service de gestion de messagerie inter-agents RooSync
 * 
 * Gère l'envoi, la réception et l'archivage de messages structurés
 * au format JSON entre machines dans l'écosystème RooSync.
 * 
 * @module MessageManager
 * @version 1.0.0
 */

import { existsSync, promises as fs } from 'fs';
import { join } from 'path';

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
          require('fs').mkdirSync(dir, { recursive: true });
          console.error(`✅ [MessageManager] Répertoire créé: ${dir}`);
        } catch (error) {
          console.error(`❌ [MessageManager] Erreur création répertoire ${dir}:`, error);
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
    console.error('🚀 [MessageManager] Sending message from', from, 'to', to);

    // CORRECTION ROOSYNC PHASE 3 : Validation anti-auto-messages
    // Empêcher une machine d'envoyer des messages à elle-même
    if (from === to) {
      throw new Error(`Auto-message interdit : une machine (${from}) ne peut pas envoyer de message à elle-même (${to})`);
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
      console.error(`✅ [MessageManager] Message saved to inbox: ${inboxFile}`);

      // Sauvegarder dans sent de l'expéditeur
      const sentFile = join(this.sentPath, `${message.id}.json`);
      await fs.writeFile(sentFile, JSON.stringify(message, null, 2), 'utf-8');
      console.error(`✅ [MessageManager] Message saved to sent: ${sentFile}`);

      console.error('✅ [MessageManager] Message sent successfully:', message.id);
      return message;
    } catch (error) {
      console.error('❌ [MessageManager] Error sending message:', error);
      throw error;
    }
  }

  /**
   * Lit la boîte de réception d'une machine
   * 
   * Filtre les messages par destinataire et statut, puis les trie
   * par ordre chronologique décroissant (plus récents en premier).
   * 
   * @param machineId ID de la machine destinataire
   * @param status Filtrer par statut (unread, read, all)
   * @param limit Nombre maximum de messages à retourner
   * @returns Liste des messages correspondants
   */
  async readInbox(
    machineId: string,
    status?: 'unread' | 'read' | 'all',
    limit?: number
  ): Promise<MessageListItem[]> {
    console.error('📬 [MessageManager] Reading inbox for:', machineId);

    if (!existsSync(this.inboxPath)) {
      console.error('⚠️ [MessageManager] Inbox path does not exist:', this.inboxPath);
      return [];
    }

    try {
      const files = (await fs.readdir(this.inboxPath)).filter(f => f.endsWith('.json'));
      console.error(`📋 [MessageManager] Found ${files.length} message files`);

      const messages: MessageListItem[] = [];

      for (const file of files) {
        try {
          const content = await fs.readFile(join(this.inboxPath, file), 'utf-8');
          const message: Message = JSON.parse(content);

          // Filtrer par destinataire (supporte "All" et "all" pour les messages broadcast)
          if (message.to !== machineId && message.to !== 'All' && message.to !== 'all') {
            continue;
          }

          // Filtrer par status
          if (status && status !== 'all' && message.status !== status) {
            continue;
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
          console.error(`⚠️ [MessageManager] Error reading message ${file}:`, error);
        }
      }

      // Trier par timestamp décroissant (plus récents en premier)
      messages.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

      // Limiter le nombre de résultats
      const result = limit ? messages.slice(0, limit) : messages;
      console.error(`✅ [MessageManager] Returning ${result.length} messages`);

      return result;
    } catch (error) {
      console.error('❌ [MessageManager] Error reading inbox:', error);
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
    console.error('🔍 [MessageManager] Getting message:', messageId);

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
          console.error('✅ [MessageManager] Message found in:', filePath);
          return message;
        } catch (error) {
          console.error(`⚠️ [MessageManager] Error reading message from ${filePath}:`, error);
        }
      }
    }

    console.error('⚠️ [MessageManager] Message not found:', messageId);
    return null;
  }

  /**
   * Marque un message comme lu
   * 
   * Met à jour le statut du message dans l'inbox.
   * 
   * @param messageId ID du message à marquer comme lu
   * @returns true si succès, false sinon
   */
  async markAsRead(messageId: string): Promise<boolean> {
    console.error('✉️ [MessageManager] Marking message as read:', messageId);

    const filePath = join(this.inboxPath, `${messageId}.json`);
    if (!existsSync(filePath)) {
      console.error('⚠️ [MessageManager] Message not found in inbox:', messageId);
      return false;
    }

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const message: Message = JSON.parse(content);
      message.status = 'read';

      await fs.writeFile(filePath, JSON.stringify(message, null, 2), 'utf-8');
      
      // Also update sent/ directory if message was sent from this machine
      const sentPath = join(this.sentPath, `${messageId}.json`);
      if (existsSync(sentPath)) {
        await fs.writeFile(sentPath, JSON.stringify(message, null, 2), 'utf-8');
        console.error('✅ [MessageManager] Message also marked as read in sent/');
      }
      
      console.error('✅ [MessageManager] Message marked as read');
      return true;
    } catch (error) {
      console.error('❌ [MessageManager] Error marking message as read:', error);
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
    console.error('📦 [MessageManager] Archiving message:', messageId);

    const inboxFile = join(this.inboxPath, `${messageId}.json`);
    if (!existsSync(inboxFile)) {
      console.error('⚠️ [MessageManager] Message not found in inbox:', messageId);
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
        console.error('✅ [MessageManager] Message also archived in sent/');
      }

      console.error('✅ [MessageManager] Message archived');
      return true;
    } catch (error) {
      console.error('❌ [MessageManager] Error archiving message:', error);
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
    console.error('✏️ [MessageManager] Amending message:', messageId);

    // Rechercher le message dans sent/
    const sentFile = join(this.sentPath, `${messageId}.json`);
    
    if (!existsSync(sentFile)) {
      throw new Error(`Message non trouvé dans sent/ : ${messageId}. Seuls les messages envoyés peuvent être amendés.`);
    }

    try {
      // Lire le message actuel
      const content = await fs.readFile(sentFile, 'utf-8');
      const message: Message = JSON.parse(content);

      // Validation : Vérifier que le message n'est pas lu/archivé (en premier)
      if (message.status !== 'unread') {
        throw new Error(`Impossible d'amender un message déjà lu ou archivé (status: ${message.status}).`);
      }

      // Validation : Vérifier que l'émetteur correspond
      if (message.from !== senderId) {
        throw new Error(`Permission refusée : seul l'émetteur (${message.from}) peut amender ce message.`);
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
        console.error('✅ [MessageManager] Message updated in inbox as well');
      }

      console.error('✅ [MessageManager] Message amended successfully');
      
      return {
        success: true,
        message_id: message.id,
        amended_at: message.metadata.amendment_timestamp!,
        reason: message.metadata.amendment_reason!,
        original_content_preserved: !!message.metadata.original_content
      };
    } catch (error) {
      console.error('❌ [MessageManager] Error amending message:', error);
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
   * @returns Liste des messages non lus
   */
  async checkNewMessages(machineId: string): Promise<MessageListItem[]> {
    console.error('🔔 [MessageManager] Checking for new messages for:', machineId);
    return await this.readInbox(machineId, 'unread');
  }
}