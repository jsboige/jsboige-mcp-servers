/**
 * Détecteur automatique du stockage Roo
 * Identifie et analyse les emplacements de stockage des conversations Roo
 */

import * as fs from 'fs/promises';
import { createReadStream, Stats, existsSync } from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import { glob } from 'glob';
import {
    RooStorageLocation,
    ConversationSummary,
    RooStorageDetectionResult,
    TaskMetadata,
    RooStorageError,
    InvalidStoragePathError,
    StorageStats,
    ConversationSkeleton,
    MessageSkeleton,
    ActionMetadata,
} from '../types/conversation.js';
import { globalCacheManager } from './cache-manager.js';

export class RooStorageDetector {
  private static readonly COMMON_ROO_PATHS = [
    // Chemins VSCode typiques
    path.join(os.homedir(), '.vscode', 'extensions'),
    path.join(os.homedir(), '.vscode-insiders', 'extensions'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'Code', 'User', 'globalStorage'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'Code - Insiders', 'User', 'globalStorage'),
    // Chemins Linux/Mac
    path.join(os.homedir(), '.config', 'Code', 'User', 'globalStorage'),
    path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'globalStorage'),
  ];

  private static readonly ROO_EXTENSION_PATTERNS = [
    '**/saoudrizwan.claude-dev-*',
    '**/claude-dev*',
    '**/roo*',
    '**/cline*'
  ];

  /**
   * Détecte les chemins de stockage Roo et les met en cache.
   * Ne retourne qu'une liste de chemins vers les répertoires 'tasks'.
   * Rapide et léger.
   */
  public static async detectStorageLocations(): Promise<string[]> {
    const cacheKey = 'storage_locations';
    const cachedLocations = await globalCacheManager.get<string[]>(cacheKey);
    if (cachedLocations) {
      return cachedLocations;
    }

    const potentialLocations = await this.findPotentialStorageLocations();
    const validatedPaths: string[] = [];

    for (const locationPath of potentialLocations) {
      try {
        const isValid = await this.validateCustomPath(locationPath);
        if (isValid) {
          validatedPaths.push(path.join(locationPath, 'tasks'));
        }
      } catch (error) {
        // Ignorer les erreurs de validation pour un seul chemin
      }
    }
    
    // Garder en cache pendant 5 minutes
    await globalCacheManager.set(cacheKey, validatedPaths);
    
    return validatedPaths;
  }

  /**
   * Scanne un répertoire de tâches pour en extraire des statistiques agrégées.
   * Ne lit pas le contenu complet des fichiers, se base sur fs.stat.
   */
  public static async getStatsForPath(storagePath: string): Promise<StorageStats> {
    let count = 0;
    let totalSize = 0;
    let lastActivity: Date | null = null;
    
    const entries = await fs.readdir(storagePath, { withFileTypes: true });

    for (const entry of entries) {
        if (entry.isDirectory()) {
            const taskPath = path.join(storagePath, entry.name);
            try {
                const stats = await fs.stat(taskPath); // stat sur le répertoire
                count++;
                totalSize += stats.size; // Taille approximative
                if (!lastActivity || stats.mtime > lastActivity) {
                    lastActivity = stats.mtime;
                }
            } catch (e) {
                // ignorer
            }
        }
    }
    return { conversationCount: count, totalSize, fileTypes: {} };
  }
  
  /**
   * Scanne un répertoire de tâches et retourne une liste paginée de métadonnées de conversation.
   * Le scan du contenu est limité au strict nécessaire (ex: task_metadata.json).
   */
    public static async scanConversationsMetadata(
        storagePath: string,
        options: { limit: number; offset: number; sortBy: string; sortOrder: 'asc'|'desc' }
    ): Promise<ConversationSummary[]> {
        const conversations: ConversationSummary[] = [];
        const taskDirs = await fs.readdir(storagePath);

        // Cette implémentation reste basique, une future optimisation pourrait trier avant de lire.
        for (const taskId of taskDirs) {
            const taskPath = path.join(storagePath, taskId);
            const stats = await fs.stat(taskPath);
            if (!stats.isDirectory()) continue;

            // Note: analyzeConversation retourne maintenant un ConversationSkeleton,
            // mais l'ancienne interface ConversationSummary est toujours utilisée ici.
            // Ceci devra être adapté dans une tâche future.
            const skeleton = await this.analyzeConversation(taskId, taskPath);
            if (skeleton) {
                // Conversion pour l'ancienne interface
                const summary: ConversationSummary = {
                    taskId: skeleton.taskId,
                    path: taskPath, // Le path n'est pas dans le squelette
                    metadata: { // On ne garde que les métadonnées de base
                        title: skeleton.metadata.title,
                        prompt: { task: '' } // Le prompt n'est plus directement dans les métadonnées de haut niveau
                    },
                    messageCount: skeleton.metadata.messageCount,
                    lastActivity: skeleton.metadata.lastActivity,
                    hasApiHistory: skeleton.metadata.totalSize > 0, // Approximation
                    hasUiMessages: skeleton.metadata.totalSize > 0, // Approximation
                    size: skeleton.metadata.totalSize,
                    prompt: skeleton.metadata?.title || 'No prompt'
                };
                conversations.push(summary);
            }
        }

        // Tri
        conversations.sort((a, b) => {
            let comparison = 0;
            switch (options.sortBy) {
                case 'lastActivity':
                comparison = new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime();
                break;
                case 'messageCount':
                comparison = b.messageCount - a.messageCount;
                break;
            }
            return options.sortOrder === 'asc' ? -comparison : comparison;
        });

        return conversations.slice(options.offset, options.offset + options.limit);
    }
  
  /**
   * Trouve et analyse une seule conversation par son ID.
   * C'est la méthode la plus efficace pour obtenir les détails d'une conversation.
   */
  public static async findConversationById(taskId: string): Promise<ConversationSummary | null> {
      const storageLocations = await this.detectStorageLocations();
      for (const storagePath of storageLocations) {
          const taskPath = path.join(storagePath, taskId);
          try {
              const stats = await fs.stat(taskPath);
              if (stats.isDirectory()) {
                  const skeleton = await this.analyzeConversation(taskId, taskPath);
                  if (!skeleton) return null;
                  
                  // Conversion pour l'ancienne interface
                  return {
                      taskId: skeleton.taskId,
                      path: taskPath,
                      metadata: {
                          title: skeleton.metadata.title,
                          prompt: { task: '' }
                      },
                      messageCount: skeleton.metadata.messageCount,
                      lastActivity: skeleton.metadata.lastActivity,
                      hasApiHistory: skeleton.metadata.totalSize > 0,
                      hasUiMessages: skeleton.metadata.totalSize > 0,
                      size: skeleton.metadata.totalSize,
                      prompt: skeleton.metadata?.title || 'No prompt'
                  };
              }
          } catch (e) {
              // N'existe pas dans cet emplacement, on continue
          }
      }
      return null;
  }
  
  // Méthodes dépréciées ou internes
  /**
   * @deprecated Utiliser `detectStorageLocations` à la place.
   */
   public static async detectRooStorage(): Promise<RooStorageDetectionResult> {
    const locations = await this.detectStorageLocations();
    const result: RooStorageDetectionResult = {
        locations: locations.map(loc => ({
            path: loc,
            type: 'local',
        })),
    };
    return result;
}

  
  /**
   * Recherche les emplacements potentiels de stockage Roo
   */
  private static async findPotentialStorageLocations(): Promise<string[]> {
    const locations: string[] = [];

    // Recherche dans les chemins communs
    for (const basePath of this.COMMON_ROO_PATHS) {
      try {
        await fs.access(basePath);
        // Recherche des extensions Roo/Claude
        for (const pattern of this.ROO_EXTENSION_PATTERNS) {
          try {
            const matches = await glob(pattern, {
              cwd: basePath,
              absolute: true,
            });
            // Filtrer pour ne garder que les répertoires
            for (const match of matches) {
              try {
                const stats = await fs.stat(match);
                if (stats.isDirectory()) {
                  locations.push(match);
                }
              } catch (error) {
                // Ignore les erreurs d'accès aux fichiers individuels
              }
            }
          } catch (error) {
            // Ignore les erreurs de pattern glob
          }
        }
      } catch (error) {
        // Ignore les erreurs si le basePath n'existe pas
      }
    }
    return [...new Set(locations)]; // Supprime les doublons
  }

  /**
   * Valide un emplacement de stockage potentiel
   */
  // Cette fonction est devenue redondante avec validateCustomPath, on la supprime pour éviter la confusion.

  /**
   * Scanne les conversations dans un répertoire de tâches
   */
  private static async scanConversations(tasksPath: string): Promise<ConversationSummary[]> {
    const conversations: ConversationSummary[] = [];

    try {
      const taskDirs = await fs.readdir(tasksPath);
      
      for (const taskId of taskDirs) {
        const taskPath = path.join(tasksPath, taskId);
        
        try {
          const stats = await fs.stat(taskPath);
          if (!stats.isDirectory()) continue;

          const skeleton = await this.analyzeConversation(taskId, taskPath);
          if (skeleton) {
               const summary: ConversationSummary = {
                   taskId: skeleton.taskId,
                   path: taskPath,
                   metadata: {
                       title: skeleton.metadata.title,
                       prompt: { task: '' }
                   },
                   messageCount: skeleton.metadata.messageCount,
                   lastActivity: skeleton.metadata.lastActivity,
                   hasApiHistory: skeleton.metadata.totalSize > 0,
                   hasUiMessages: skeleton.metadata.totalSize > 0,
                   size: skeleton.metadata.totalSize,
                   prompt: skeleton.metadata?.title || 'No prompt'
               };
               conversations.push(summary);
          }
        } catch (error) {
          // Ignore les erreurs pour des tâches individuelles
        }
      }
    } catch (error) {
      throw new RooStorageError(`Impossible de lire le répertoire des tâches: ${error instanceof Error ? error.message : String(error)}`, 'TASKS_READ_ERROR');
    }

    return conversations;
  }

  /**
   * Analyse une conversation et la transforme en une structure "squelette" légère.
   */
  public static async analyzeConversation(taskId: string, taskPath: string): Promise<ConversationSkeleton | null> {
    const metadataPath = path.join(taskPath, 'task_metadata.json');
    const apiHistoryPath = path.join(taskPath, 'api_conversation_history.json');
    const uiMessagesPath = path.join(taskPath, 'ui_messages.json');

    try {
        const [metadataStats, apiHistoryStats, uiMessagesStats] = await Promise.all([
            fs.stat(metadataPath).catch(() => null),
            fs.stat(apiHistoryPath).catch(() => null),
            fs.stat(uiMessagesPath).catch(() => null)
        ]);

        if (!apiHistoryStats && !uiMessagesStats) return null;

        let metadataContent = metadataStats ? await fs.readFile(metadataPath, 'utf-8') : '{}';
        // Nettoyage explicite du BOM (Byte Order Mark) qui peut faire planter JSON.parse
        if (metadataContent.charCodeAt(0) === 0xFEFF) {
            metadataContent = metadataContent.slice(1);
        }
        let rawMetadata: TaskMetadata;
        try {
            rawMetadata = JSON.parse(metadataContent) as TaskMetadata;
        } catch (error) {
            // Si le parsing échoue, on continue avec des métadonnées vides pour ne pas planter.
            // On pourrait logguer l'erreur ici pour investigation.
            console.error(`[analyzeConversation] Failed to parse metadata for task ${taskId}:`, error);
            rawMetadata = {} as TaskMetadata; // Fallback to an empty object
        }

        if (!rawMetadata.parentTaskId) {
            // console.error(`[analyzeConversation] Task ${taskId} has no parentTaskId.`);
        }
        const sequence = await this.buildSequenceFromFiles(apiHistoryPath, uiMessagesPath);
        
        const messageCount = sequence.filter(s => 'role' in s).length;
        const actionCount = sequence.length - messageCount;
        const totalSize = (metadataStats?.size || 0) + (apiHistoryStats?.size || 0) + (uiMessagesStats?.size || 0);

        const lastActivity = [metadataStats, apiHistoryStats, uiMessagesStats]
            .filter((s): s is Stats => s !== null)
            .reduce((latest, s) => (s.mtime > latest ? s.mtime : latest), new Date(0))
            .toISOString();

        const skeleton: ConversationSkeleton = {
            taskId,
            parentTaskId: rawMetadata.parentTaskId || rawMetadata.parent_task_id, // Support pour les anciens formats
            sequence,
            metadata: {
                title: rawMetadata.title,
                createdAt: rawMetadata.createdAt || new Date(0).toISOString(),
                lastActivity,
                mode: rawMetadata.mode,
                messageCount,
                actionCount,
                totalSize,
            },
        };

        await globalCacheManager.set(`conversation-skeleton:${taskId}`, skeleton);
        return skeleton;

    } catch (error) {
        console.error(`[analyzeConversation] Erreur critique lors de l'analyse de ${taskId}:`, error);
        return null;
    }
  }

  /**
   * Construit une séquence triée de messages et d'actions à partir des fichiers d'historique.
   * Lit les fichiers ligne par ligne pour minimiser l'utilisation de la mémoire.
   */
  private static async buildSequenceFromFiles(
    apiHistoryPath: string,
    uiMessagesPath: string
  ): Promise<(MessageSkeleton | ActionMetadata)[]> {
    let combinedItems: any[] = [];
    const MAX_CONTENT_LENGTH = 400;

    // Helper pour lire et parser un fichier JSON en toute sécurité
    const readJsonFile = async (filePath: string): Promise<any[]> => {
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        const data = JSON.parse(content);
        // Les fichiers peuvent avoir les messages dans une propriété "messages" ou être un tableau à la racine
        return Array.isArray(data) ? data : (data?.messages || []);
      } catch (e) {
        return []; // Retourne un tableau vide en cas d'erreur
      }
    };

    const apiItems = await readJsonFile(apiHistoryPath);
    const uiItems = await readJsonFile(uiMessagesPath);
    combinedItems = [...apiItems, ...uiItems];

    let sequence: (MessageSkeleton | ActionMetadata)[] = [];

    for (const item of combinedItems) {
      const timestamp = item.timestamp || new Date(0).toISOString();
      const role = item.role || (item.type === 'ask' ? 'user' : 'assistant');
      const type = item.type;

      // Traitement des messages (user/assistant/say)
      if (['user', 'assistant'].includes(role) || type === 'say') {
        let content = item.content ?? item.text ?? '';
        let isTruncated = false;

        // Si le contenu est un tableau (par exemple, pour les messages complexes de Claude)
        if (Array.isArray(content)) {
          content = content.find((c: any) => c.type === 'text')?.text || '[contenu non textuel]';
        }
        
        // Sécurité pour éviter la récursion : si le contenu ressemble à un squelette, on l'ignore.
        if (typeof content === 'string' && (content.includes('"sequence"') || content.includes('"taskId"'))) {
            content = '[Contenu suspect ignoré pour éviter une boucle]';
        } else if (typeof content !== 'string') {
            // Si le contenu n'est pas une chaîne, on le sérialise de manière sûre.
            content = JSON.stringify(content);
        }

        if (content.length > MAX_CONTENT_LENGTH) {
            content = `${content.substring(0, MAX_CONTENT_LENGTH / 2)}...${content.substring(content.length - MAX_CONTENT_LENGTH / 2)}`;
            isTruncated = true;
        }
        sequence.push({
          role: role,
          content,
          isTruncated,
          timestamp,
        });
      }
      // Traitement des actions (tool/command/tool_use/tool_result)
      else if (['tool', 'command', 'tool_use', 'tool_result'].includes(type)) {
        const action: ActionMetadata = {
            type: (type === 'tool_use' || type === 'tool_result') ? 'tool' : type,
            name: item.tool || item.name || 'unknown_action',
            status: item.isError ? 'failure' : (item.toolResult ? 'success' : 'in_progress'),
            parameters: item.toolInput || item.parameters || {},
            timestamp,
        };

        const input = item.toolInput || item.parameters || {};
        const result = item.toolResult || {};

        if (input.path) action.file_path = input.path;
        
        if (result.line_count) action.line_count = result.line_count;
        else if (input.content) action.line_count = String(input.content).split('\n').length;

        if (result.content_size) action.content_size = result.content_size;
        else if (item.toolResult) action.content_size = JSON.stringify(item.toolResult).length;
        else if (input.content) action.content_size = String(input.content).length;
        
        sequence.push(action);
      }
    }
    
    sequence.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    return sequence;
  }

  /**
   * Recherche une conversation spécifique par ID
   */
  public static async findConversation(taskId: string): Promise<ConversationSummary | null> {
    return this.findConversationById(taskId);
  }

  /**
   * Obtient les statistiques de stockage Roo
   */
  public static async getStorageStats(): Promise<{
    totalLocations: number;
    totalConversations: number;
    totalSize: number;
  }> {
    const locations = await this.detectStorageLocations();
    let totalConversations = 0;
    let totalSize = 0;

    for (const loc of locations) {
        const stats = await this.getStatsForPath(loc);
        totalConversations += stats.conversationCount;
        totalSize += stats.totalSize;
    }

    return {
      totalLocations: locations.length,
      totalConversations,
      totalSize,
    };
  }

  /**
   * Valide un chemin de stockage personnalisé
   */
  public static async validateCustomPath(customPath: string): Promise<boolean> {
    try {
      const normalizedPath = path.resolve(customPath);
      const tasksPath = path.join(normalizedPath, 'tasks');
      
      return existsSync(tasksPath);
    } catch (error) {
      return false;
    }
  }
}