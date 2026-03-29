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
    NewTaskInstruction,
} from '../types/conversation.js';
import { globalCacheManager } from './cache-manager.js';
import { globalTaskInstructionIndex, computeInstructionPrefix } from './task-instruction-index.js';
import { MessageToSkeletonTransformer } from './message-to-skeleton-transformer.js';
import { HierarchyReconstructionEngine } from './hierarchy-reconstruction-engine.js';
import { SkeletonComparator } from './skeleton-comparator.js';
import { getParsingConfig, isComparisonMode, shouldUseNewParsing } from './parsing-config.js';
import { WorkspaceDetector } from './workspace-detector.js';

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

  // Override pour les tests unitaires (injection de dépendance)
  private static _coordinatorOverride: any = null;

  /**
   * Permet d'injecter un coordinateur mocké pour les tests
   */
  public static setCoordinatorOverride(coordinator: any) {
    this._coordinatorOverride = coordinator;
  }

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
          validatedPaths.push(locationPath);
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

    // Protection contre le bug de l'environnement Vitest où fs.readdir peut retourner undefined
    if (!entries || !Array.isArray(entries)) {
        return {
            conversationCount: 0,
            totalSize: 0,
            fileTypes: {}
        };
    }

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
                        prompt: { task: '' }, // Le prompt n'est plus directement dans les métadonnées de haut niveau
                        workspace: skeleton.metadata.workspace
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
      for (const locationPath of storageLocations) {
          const taskPath = path.join(locationPath, 'tasks', taskId);
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
                       prompt: { task: '' },
                       workspace: skeleton.metadata.workspace
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
   * Supporte le mode parallèle (ancien + nouveau système) pour validation progressive.
   * Version production avec architecture en deux passes pour reconstruction hiérarchies
   */
  public static async analyzeConversation(
    taskId: string,
    taskPath: string,
    useProductionHierarchy: boolean = true
  ): Promise<ConversationSkeleton | null> {
    const config = getParsingConfig();

    const metadataPath = path.join(taskPath, 'task_metadata.json');
    const apiHistoryPath = path.join(taskPath, 'api_conversation_history.json');
    const uiMessagesPath = path.join(taskPath, 'ui_messages.json');
    const historyItemPath = path.join(taskPath, 'history_item.json');

    // Mode comparaison : exécuter ancien + nouveau
    if (isComparisonMode()) {
      return await this.analyzeWithComparison(
        taskId,
        taskPath,
        useProductionHierarchy,
        { metadataPath, apiHistoryPath, uiMessagesPath, historyItemPath }
      );
    }

    // Mode nouveau système uniquement
    if (shouldUseNewParsing()) {
      return await this.analyzeWithNewSystem(
        taskId,
        taskPath,
        useProductionHierarchy,
        { metadataPath, apiHistoryPath, uiMessagesPath, historyItemPath }
      );
    }

    // Mode ancien système (défaut, legacy)
    return await this.analyzeWithOldSystem(
      taskId,
      taskPath,
      useProductionHierarchy,
      { metadataPath, apiHistoryPath, uiMessagesPath, historyItemPath }
    );
  }

  /**
   * Analyse avec le nouveau système (MessageToSkeletonTransformer)
   */
  private static async analyzeWithNewSystem(
    taskId: string,
    taskPath: string,
    useProductionHierarchy: boolean,
    paths: { metadataPath: string; apiHistoryPath: string; uiMessagesPath: string; historyItemPath: string }
  ): Promise<ConversationSkeleton | null> {
    try {
      // Charger les messages UI
      const messages = await this.loadUIMessages(paths.uiMessagesPath);

      if (messages.length === 0) {
        console.warn(`[NEW PARSING] No messages found for ${taskId}`);
        return null;
      }

      // STRATÉGIE DUAL : Utiliser WorkspaceDetector pour détection intelligente
      const workspaceDetector = new WorkspaceDetector({
        enableCache: true,
        validateExistence: false, // Performance
        normalizePaths: true,
      });

      const workspaceResult = await workspaceDetector.detect(taskPath);
      const detectedWorkspace = workspaceResult.workspace;

      // Logger la source de détection si mode debug
      if (process.env.DEBUG_PARSING === 'true') {
        console.log(`[NEW PARSING] Workspace pour ${taskId}:`, {
          workspace: detectedWorkspace,
          source: workspaceResult.source,
          confidence: workspaceResult.confidence
        });
      }

      // Utiliser le transformer
      const transformer = new MessageToSkeletonTransformer({
        normalizePrefixes: true,
        strictValidation: true,
      });

      const result = await transformer.transform(messages, taskId, detectedWorkspace || undefined);

      // Logger les métadonnées si mode debug
      if (process.env.DEBUG_PARSING === 'true') {
        console.log('[NEW PARSING] Metadata:', result.metadata);
      }

      // Mettre en cache
      await globalCacheManager.set(`conversation-skeleton:${taskId}`, result.skeleton);

      return result.skeleton;
    } catch (error) {
      console.error(`[NEW PARSING] Error for ${taskId}:`, error);
      return null;
    }
  }

  /**
   * Analyse avec l'ancien système (legacy, regex-based)
   */
  private static async analyzeWithOldSystem(
    taskId: string,
    taskPath: string,
    useProductionHierarchy: boolean,
    paths: { metadataPath: string; apiHistoryPath: string; uiMessagesPath: string; historyItemPath: string }
  ): Promise<ConversationSkeleton | null> {
    const { metadataPath, apiHistoryPath, uiMessagesPath, historyItemPath } = paths;

    try {
        const [taskDirStats, metadataStats, apiHistoryStats, uiMessagesStats, historyItemStats] = await Promise.all([
            fs.stat(taskPath).catch(() => null), //
            fs.stat(metadataPath).catch(() => null),
            fs.stat(apiHistoryPath).catch(() => null),
            fs.stat(uiMessagesPath).catch(() => null),
            fs.stat(historyItemPath).catch(() => null)
        ]);

        // Validation robuste : accepter la conversation si au moins UN fichier existe
        if (!apiHistoryStats && !uiMessagesStats && !metadataStats) {
            console.warn(`⚠️ [analyzeConversation] Skipping ${taskId}: NO FILES FOUND`);
            return null;
        }

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

        // 🔄 Lire history_item.json pour parentTaskId/childIds (disponible dans les versions récentes de Roo)
        let historyItemData: { parentTaskId?: string; childIds?: string[] } = {};
        if (historyItemStats) {
            try {
                let historyContent = await fs.readFile(historyItemPath, 'utf-8');
                if (historyContent.charCodeAt(0) === 0xFEFF) {
                    historyContent = historyContent.slice(1);
                }
                const parsed = JSON.parse(historyContent);
                historyItemData = {
                    parentTaskId: parsed.parentTaskId,
                    childIds: Array.isArray(parsed.childIds) ? parsed.childIds : undefined
                };
            } catch (error) {
                // history_item.json is optional, don't fail on parse errors
                console.warn(`[analyzeConversation] Failed to parse history_item.json for ${taskId}:`, error);
            }
        }

        // #975 OOM FIX: Read each file ONCE and pass preloaded content to helpers
        // Previously ui_messages.json was read 3 times and api_conversation_history.json 2 times per task
        let preloadedUiContent: string | undefined = undefined;
        let preloadedApiContent: string | undefined = undefined;
        if (uiMessagesStats) {
            try {
                let raw = await fs.readFile(uiMessagesPath, 'utf-8');
                if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
                preloadedUiContent = raw;
            } catch { /* will be handled by individual callers */ }
        }
        if (apiHistoryStats) {
            try {
                let raw = await fs.readFile(apiHistoryPath, 'utf-8');
                if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
                preloadedApiContent = raw;
            } catch { /* will be handled by individual callers */ }
        }

        // 🚀 PRODUCTION : Logique de reconstruction hiérarchique en deux passes
        // Priorité: task_metadata.json > history_item.json (fallback pour versions récentes de Roo)
        let parentTaskId = rawMetadata.parentTaskId || rawMetadata.parent_task_id || historyItemData.parentTaskId;
        let childTaskInstructionPrefixes: string[] = [];

        if (useProductionHierarchy) {
            // Phase 1: Extraire les préfixes d'instructions de cette tâche
            if (uiMessagesStats) {
                const instructions = await this.extractNewTaskInstructionsFromUI(uiMessagesPath, 0, preloadedUiContent); // Pas de limite

                childTaskInstructionPrefixes = [...new Set(instructions.map(inst => {
                    // 🎯 CORRECTION SDDD Phase 2: Utiliser computeInstructionPrefix pour alignement strict
                    const prefix = computeInstructionPrefix(inst.message, 192);
                    return prefix;
                }).filter(prefix => prefix.length > 10))]; // Filtrer les préfixes trop courts et dédoublonner

                // Log seulement si des instructions trouvées
                if (childTaskInstructionPrefixes.length > 0) {
                    console.log(`[analyzeConversation] ✅ Extracted ${childTaskInstructionPrefixes.length} instruction prefixes for ${taskId.substring(0, 8)}`);
                }
            }

            // Phase 2: Recherche de parent déplacée après calcul de truncatedInstruction
        } else {
            // 🚨 FIX RÉCURSION : Quand useProductionHierarchy = false, pas d'inférence de parent
            // pour éviter la récursion infinie avec findParentByNewTaskInstructions
            console.log(`[analyzeConversation] 🛡️ useProductionHierarchy=false pour ${taskId}, pas d'inférence de parent (évite récursion)`);
        }

        const sequence = await this.buildSequenceFromFiles(apiHistoryPath, uiMessagesPath, preloadedApiContent, preloadedUiContent);

        const messageCount = sequence.filter(s => 'role' in s).length;
        const actionCount = sequence.length - messageCount;
        const totalSize = (metadataStats?.size || 0) + (apiHistoryStats?.size || 0) + (uiMessagesStats?.size || 0);

        // 🚀 NOUVEAU : Détection de la complétion de la tâche
        let isCompleted = false;
        const assistantMessages = sequence.filter(s => 'role' in s && s.role === 'assistant') as MessageSkeleton[];
        if (assistantMessages.length > 0) {
            const lastAssistantMessage = assistantMessages[assistantMessages.length - 1];
            // Recherche de l'outil attempt_completion dans le dernier message assistant
            isCompleted = lastAssistantMessage.content.toLowerCase().includes('attempt_completion');
        }

        // 🔍 EXTRACTION INSTRUCTION INITIALE : Depuis ui_messages.json (premier say/text)
        // L'instruction principale est différente des sous-tâches ([new_task in X: 'Y'])
        // Elle se trouve dans le premier message say/text du fichier ui_messages.json
        let truncatedInstruction: string | undefined;
        if (uiMessagesStats) {
            const mainInstruction = await this.extractMainInstructionFromUI(uiMessagesPath, preloadedUiContent);
            if (mainInstruction) {
                // Normaliser avec computeInstructionPrefix pour cohérence avec les sous-tâches
                truncatedInstruction = computeInstructionPrefix(mainInstruction, 192);

                if (process.env.ROO_DEBUG_INSTRUCTIONS === '1') {
                    console.log(`[analyzeConversation] ✅ Instruction principale pour ${taskId}: "${truncatedInstruction}"`);
                }
            }
        }
        // Extraire les vrais timestamps des fichiers JSON au lieu d'utiliser mtime
        const timestamps: Date[] = [];

        // 1. Lire les timestamps "ts" et extraire le workspace depuis api_conversation_history.json
        // #975 OOM FIX: Reuse preloaded content instead of re-reading the file
        let extractedWorkspace: string | undefined = undefined;
        if (apiHistoryStats && preloadedApiContent) {
            try {
                const apiContent = preloadedApiContent;
                const apiData = JSON.parse(apiContent);
                const messages = Array.isArray(apiData) ? apiData : (apiData?.messages || []);

                // Extraire le workspace en utilisant le regex sur tout le contenu
                const workspaceMatch = apiContent.match(/Current Workspace Directory \(([^)]+)\)/);
                if (workspaceMatch && workspaceMatch[1]) {
                    extractedWorkspace = workspaceMatch[1].trim();
                }

                for (const message of messages) {
                    if (message.ts && typeof message.ts === 'number') {
                        timestamps.push(new Date(message.ts));
                    }
                }
            } catch (error) {
                console.error(`[analyzeConversation] Erreur lors de la lecture des timestamps dans ${apiHistoryPath}:`, error);
            }
        }

        // 2. Lire les timestamps depuis task_metadata.json (files_in_context)
        if (metadataStats && rawMetadata.files_in_context) {
            try {
                for (const file of rawMetadata.files_in_context) {
                    const fileAny = file as any; // Type assertion pour accéder aux propriétés dynamiques
                    if (fileAny.roo_read_date) {
                        timestamps.push(new Date(fileAny.roo_read_date));
                    }
                    if (fileAny.roo_edit_date) {
                        timestamps.push(new Date(fileAny.roo_edit_date));
                    }
                    if (fileAny.user_edit_date) {
                        timestamps.push(new Date(fileAny.user_edit_date));
                    }
                }
            } catch (error) {
                console.error(`[analyzeConversation] Erreur lors de la lecture des timestamps dans task_metadata:`, error);
            }
        }

        // Calculer lastActivity en utilisant le timestamp le plus récent
        let lastActivity: Date;
        let createdAt: Date;

        if (timestamps.length > 0) {
            // Utiliser les timestamps extraits s'ils existent
            timestamps.sort((a, b) => a.getTime() - b.getTime());
            createdAt = timestamps[0];
            lastActivity = timestamps[timestamps.length - 1];
        } else if (taskDirStats) {
            // Fallback robuste sur les dates du répertoire de la tâche
            lastActivity = taskDirStats.mtime;
            createdAt = taskDirStats.birthtime;
        } else {
            // Cas d'échec ultime, peu probable
            lastActivity = new Date();
            createdAt = new Date();
        }

        const skeleton: ConversationSkeleton = {
            taskId,
            parentTaskId: parentTaskId, // Utilise la valeur inférée si disponible
            sequence,
            metadata: {
                title: rawMetadata.title,
                createdAt: createdAt.toISOString(),
                lastActivity: lastActivity.toISOString(),
                mode: rawMetadata.mode,
                messageCount,
                actionCount,
                totalSize,
                workspace: extractedWorkspace || rawMetadata.workspace,
                dataSource: taskPath, // ✅ CRITIQUE: Chemin pour que HierarchyEngine trouve ui_messages.json
            },
            childTaskInstructionPrefixes: childTaskInstructionPrefixes.length > 0 ? childTaskInstructionPrefixes : undefined,
            // 🚀 NOUVEAUX CHAMPS : Ajout des fonctionnalités demandées
            isCompleted,
            truncatedInstruction,
        };

        // 🚀 PRODUCTION : Alimenter l'index radix-tree avec les instructions trouvées
        // SDDD Phase 2: Les préfixes sont déjà normalisés via computeInstructionPrefix,
        // mais addInstruction() passe la valeur RAW au radix tree comme spécifié
        if (useProductionHierarchy && childTaskInstructionPrefixes.length > 0) {
            for (const prefix of childTaskInstructionPrefixes) {
                globalTaskInstructionIndex.addInstruction(taskId, prefix);
            }
        }

        await globalCacheManager.set(`conversation-skeleton:${taskId}`, skeleton);
        return skeleton;

    } catch (error) {
        // Gestion d'erreur spécifique avec plus de contexte
        const errorContext = {
            taskId,
            taskPath,
            error: {
                name: error instanceof Error ? error.name : 'Unknown',
                message: error instanceof Error ? error.message : String(error),
                code: (error as any)?.code || 'NO_CODE'
            }
        };

        if (error instanceof Error) {
            if (error.message.includes('ENOENT')) {
                console.warn(`⚠️ [analyzeConversation] File not found for ${taskId}, skipping`);
            } else if (error.message.includes('JSON')) {
                console.warn(`⚠️ [analyzeConversation] JSON parse error for ${taskId}, creating minimal skeleton`);
                // Retourner un squelette minimal plutôt que null
                return {
                    taskId,
                    parentTaskId: undefined,
                    sequence: [],
                    metadata: {
                        title: `Task ${taskId} (corrupted)`,
                        createdAt: new Date().toISOString(),
                        lastActivity: new Date().toISOString(),
                        mode: 'unknown',
                        messageCount: 0,
                        actionCount: 0,
                        totalSize: 0,
                        workspace: 'unknown',
                    },
                };
            } else {
                console.error(`❌ [analyzeConversation] Unexpected error for ${taskId}:`, errorContext);
            }
        } else {
            console.error(`❌ [analyzeConversation] Non-Error exception for ${taskId}:`, errorContext);
        }

        return null;
    }
  }
  /**
   * Analyse en mode comparaison : ancien + nouveau avec rapport
   */
  private static async analyzeWithComparison(
    taskId: string,
    taskPath: string,
    useProductionHierarchy: boolean,
    paths: { metadataPath: string; apiHistoryPath: string; uiMessagesPath: string; historyItemPath: string }
  ): Promise<ConversationSkeleton | null> {
    const config = getParsingConfig();

    try {
      // Exécuter l'ancien système
      const oldSkeleton = await this.analyzeWithOldSystem(
        taskId,
        taskPath,
        useProductionHierarchy,
        paths
      );

      // Exécuter le nouveau système
      const newSkeleton = await this.analyzeWithNewSystem(
        taskId,
        taskPath,
        useProductionHierarchy,
        paths
      );

      // Si l'un des deux a échoué, retourner celui qui a réussi
      if (!oldSkeleton && !newSkeleton) {
        return null;
      }
      if (!oldSkeleton) {
        console.warn(`[COMPARISON] Old system failed for ${taskId}, using new system`);
        return newSkeleton;
      }
      if (!newSkeleton) {
        console.warn(`[COMPARISON] New system failed for ${taskId}, using old system`);
        return oldSkeleton;
      }

      // Comparer avec validation des améliorations
      const comparator = new SkeletonComparator();
      const comparisonResult = comparator.compareWithImprovements(oldSkeleton, newSkeleton);

      // Logger selon les nouveaux critères
      if (config.logDifferences || !comparisonResult.isValidUpgrade) {
        console.log(`[COMPARISON] Task ${taskId}:`);
        console.log(`Similarité: ${comparisonResult.similarityScore}%`);
        console.log(`Améliorations: ${comparisonResult.improvements.join(', ')}`);
        console.log(`Validation: ${comparisonResult.isValidUpgrade ? '✅ ACCEPTÉ' : '❌ REJETÉ'}`);
        console.log(`Raison: ${comparisonResult.validationReason}`);

        if (!comparisonResult.isValidUpgrade) {
          console.log('--- Rapport détaillé ---');
          console.log(comparator.formatReport(comparisonResult));
        }
      }

      // Retourner selon les critères validés
      if (comparisonResult.isValidUpgrade || config.useNewParsing) {
        return newSkeleton;
      } else {
        console.warn(`[FALLBACK] Utilisation ancien système pour ${taskId} - validation échouée`);
        return oldSkeleton;
      }
    } catch (error) {
      console.error(`[COMPARISON] Error for ${taskId}:`, error);
      return null;
    }
  }

  /**
   * Charge les messages UI depuis le fichier
   */
  private static async loadUIMessages(uiMessagesPath: string): Promise<any[]> {
    try {
      if (!existsSync(uiMessagesPath)) {
        return [];
      }

      let content = await fs.readFile(uiMessagesPath, 'utf8');

      // Nettoyage BOM
      if (content.charCodeAt(0) === 0xFEFF) {
        content = content.slice(1);
      }

      const messages = JSON.parse(content);
      return Array.isArray(messages) ? messages : [];
    } catch (error) {
      console.error(`Error loading ui_messages.json from ${uiMessagesPath}:`, error);
      return [];
    }
  }


  /**
   * @deprecated MÉTHODE CORROMPUE - Violait le principe architectural
   * Les parents doivent être définis par les parents eux-mêmes, pas inférés depuis les enfants
   */
  private static inferParentTaskIdFromContent(
    apiHistoryPath: string,
    uiMessagesPath: string,
    rawMetadata: TaskMetadata,
    currentTaskId: string
  ): Promise<string | undefined> {
    // 🛡️ CORRECTION ARCHITECTURE : Retourner toujours undefined
    // Plus aucune tentative d'inférence inverse
    return Promise.resolve(undefined);
  }

  /**
   * Utilitaire pour traiter des éléments par batches en parallèle
   */
  private static async processBatch<T, R>(
    items: T[],
    processor: (item: T) => Promise<R>,
    batchSize: number = 20,
    onProgress?: (processed: number, total: number) => void
  ): Promise<R[]> {
    const results: R[] = [];

    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      const batchPromises = batch.map(item => processor(item).catch(error => {
        console.warn(`[processBatch] Erreur traitement item:`, error);
        return null;
      }));

      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults.filter(r => r !== null) as R[]);

      if (onProgress) {
        onProgress(Math.min(i + batchSize, items.length), items.length);
      }
    }

    return results;
  }

  /**
   * 🚀 PRODUCTION : Reconstruction complète des hiérarchies par workspace
   * Architecture en deux passes avec index radix-tree intégré
   * @param workspacePath - Chemin du workspace à analyser
   * @param useFullVolume - Traiter toutes les tâches (défaut: true)
   * @returns Promise<ConversationSkeleton[]> - Liste des squelettes avec hiérarchies
   */
  public static async buildHierarchicalSkeletons(
    workspacePath?: string,
    useFullVolume: boolean = true,
    forceRebuild: boolean = false
  ): Promise<ConversationSkeleton[]> {
    console.log(`[buildHierarchicalSkeletons] 🏗️ DÉMARRAGE reconstruction hiérarchique ${workspacePath || 'TOUS WORKSPACES'}`);

    // NOUVEAU : Utiliser le HierarchyReconstructionEngine pour la reconstruction en deux passes
    console.log(`[buildHierarchicalSkeletons] 🚀 Utilisation du nouveau HierarchyReconstructionEngine`);

    try {
      // Lancer la reconstruction avec le nouveau moteur
      const reconstructedSkeletons = await HierarchyReconstructionEngine.reconstructHierarchy(
        workspacePath,
        forceRebuild
      );

      console.log(`[buildHierarchicalSkeletons] ✅ Reconstruction terminée avec ${reconstructedSkeletons.length} squelettes`);

      // Statistiques de validation
      const orphanTasks = reconstructedSkeletons.filter((c: ConversationSkeleton) => !c.parentTaskId);
      const withParents = reconstructedSkeletons.filter((c: ConversationSkeleton) => c.parentTaskId);

      console.log(`[buildHierarchicalSkeletons] 📊 STATISTIQUES:`);
      console.log(`   📋 ${reconstructedSkeletons.length} tâches totales`);
      console.log(`   ✅ ${withParents.length} avec parent dans les métadonnées`);
      console.log(`   ⚠️ ${orphanTasks.length} tâches orphelines ou racines`);

      // Analyser la profondeur de l'arbre
      const treeDepth = this.calculateTreeDepth(reconstructedSkeletons);
      console.log(`   🌳 Profondeur de l'arbre: ${treeDepth}`);

      return reconstructedSkeletons;

    } catch (error) {
      console.error(`[buildHierarchicalSkeletons] ❌ Erreur lors de la reconstruction:`, error);

      // Fallback vers l'ancienne méthode en cas d'erreur
      console.log(`[buildHierarchicalSkeletons] 🔄 Fallback vers l'ancienne méthode`);
      return this.buildHierarchicalSkeletonsLegacy(workspacePath, useFullVolume);
    }
  }

  /**
   * Calcule la profondeur maximale de l'arbre des tâches
   */
  private static calculateTreeDepth(skeletons: ConversationSkeleton[]): number {
    const taskMap = new Map<string, ConversationSkeleton>();
    for (const skeleton of skeletons) {
      taskMap.set(skeleton.taskId, skeleton);
    }

    let maxDepth = 0;

    const calculateDepth = (taskId: string, currentDepth: number = 0): number => {
      const task = taskMap.get(taskId);
      if (!task || !task.parentTaskId) {
        return currentDepth;
      }
      return calculateDepth(task.parentTaskId, currentDepth + 1);
    };

    for (const skeleton of skeletons) {
      const depth = calculateDepth(skeleton.taskId);
      if (depth > maxDepth) {
        maxDepth = depth;
      }
    }

    return maxDepth;
  }

  /**
   * LEGACY : Ancienne méthode de reconstruction (utilisée en fallback)
   */
  private static async buildHierarchicalSkeletonsLegacy(
    workspacePath?: string,
    useFullVolume: boolean = true
  ): Promise<ConversationSkeleton[]> {
    console.log(`[buildHierarchicalSkeletonsLegacy] 📋 Utilisation de l'ancienne méthode`);

    const conversations: ConversationSkeleton[] = [];
    const storageLocations = await this.detectStorageLocations();

    // PHASE 1: Reconstruction de l'index à partir des squelettes existants
    console.log(`[buildHierarchicalSkeletonsLegacy] 📋 PHASE 1: Reconstruction index radix-tree`);
    await this.rebuildIndexFromExistingSkeletons();

    // PHASE 2: Scan et génération des squelettes (PARALLÉLISÉE)
    console.log(`[buildHierarchicalSkeletonsLegacy] 🔄 PHASE 2: Génération squelettes avec hiérarchies en parallèle`);
    // 🔧 CRITICAL FIX : Limiter à 50 tâches max pour éviter timeout dans les tests
    const maxTasks = useFullVolume ? 50 : 50;

    // Collecter toutes les tâches à traiter
    const allTaskEntries: Array<{taskId: string, taskPath: string, locationPath: string}> = [];

    for (const locationPath of storageLocations) {
      const tasksPath = path.join(locationPath, 'tasks');

      try {
        const taskDirs = await fs.readdir(tasksPath, { withFileTypes: true });
        console.log(`[buildHierarchicalSkeletonsLegacy] 📁 Collecte ${taskDirs.length} tâches dans ${locationPath}`);

        for (const entry of taskDirs) {
          if (allTaskEntries.length >= maxTasks) break;
          if (!entry.isDirectory()) continue;

          const taskPath = path.join(tasksPath, entry.name);

          // 🔧 CRITICAL FIX : Filtrage par workspace AVANT d'ajouter à allTaskEntries
          if (workspacePath !== undefined) {
            // Détecter le workspace de cette tâche pour le filtrage
            const taskWorkspace = await this.detectWorkspaceForTask(taskPath);

            // 🎯 CORRECTION WORKSPACE FILTERING : Normaliser workspacePath pour comparaison équitable
            // Le taskWorkspace est déjà normalisé par WorkspaceDetector, mais workspacePath ne l'est pas
            // Normaliser les chemins pour la comparaison (insensible à la casse et aux séparateurs)
            // Convertir les slashes Unix en slashes Windows pour la compatibilité
            // CORRECTION: path.normalize() ajoute .\ devant les chemins absolus sur Windows
            let normalizedWorkspacePath = path.normalize(workspacePath || '').replace(/\//g, '\\').toLowerCase();
            let normalizedTaskWorkspace = path.normalize(taskWorkspace || '').replace(/\//g, '\\').toLowerCase();

            // Enlever le préfixe relatif (.\) pour les chemins absolus normalisés
            if (normalizedWorkspacePath.startsWith('.\\') && path.isAbsolute(workspacePath || '')) {
                normalizedWorkspacePath = normalizedWorkspacePath.substring(2);
            }
            if (normalizedTaskWorkspace.startsWith('.\\') && path.isAbsolute(taskWorkspace || '')) {
                normalizedTaskWorkspace = normalizedTaskWorkspace.substring(2);
            }

            // Utiliser une comparaison plus flexible avec includes() pour supporter les sous-dossiers
            // Logique exacte du test : normalizedTaskWorkspace.includes(normalizedWorkspacePath)
            const isWorkspaceMatch = normalizedTaskWorkspace.includes(normalizedWorkspacePath);

            if (!isWorkspaceMatch) {
              console.log(`[buildHierarchicalSkeletonsLegacy] 🔄 Skip tâche ${entry.name.substring(0,8)} (workspace: ${taskWorkspace} != ${workspacePath})`);
              console.log(`[buildHierarchicalSkeletonsLegacy] 🔍 Normalized: "${normalizedTaskWorkspace}" vs "${normalizedWorkspacePath}"`);
              continue;
            } else {
              // Log de succès pour diagnostic
              if (process.env.DEBUG_WORKSPACE_FILTERING === 'true') {
                console.log(`[buildHierarchicalSkeletonsLegacy] ✅ Match tâche ${entry.name.substring(0,8)}: "${taskWorkspace}"`);
              }
            }
          }

          allTaskEntries.push({
            taskId: entry.name,
            taskPath: taskPath,
            locationPath: locationPath
          });
        }
      } catch (error) {
        console.warn(`[buildHierarchicalSkeletonsLegacy] ⚠️ Impossible de scanner ${tasksPath}:`, error);
      }
    }

    // 📊 DIAGNOSTIC AMÉLIORÉ : Logs détaillés sur le filtrage workspace
    if (workspacePath !== undefined) {
      console.log(`[buildHierarchicalSkeletonsLegacy] 📊 FILTRAGE WORKSPACE:`);
      console.log(`   Workspace cible: "${workspacePath}"`);
      console.log(`   Tâches collectées avant filtrage: ${allTaskEntries.length}`);

      // Analyser la distribution des workspaces détectés pour diagnostic
      const workspaceDistribution = new Map<string, number>();
      for (const entry of allTaskEntries) {
        const ws = await this.detectWorkspaceForTask(entry.taskPath);
        workspaceDistribution.set(ws, (workspaceDistribution.get(ws) || 0) + 1);
      }

      console.log(`   Distribution workspaces détectés:`);
      const sortedWorkspaces = Array.from(workspaceDistribution.entries())
        .sort(([,a], [,b]) => b - a)
        .slice(0, 5);

      for (const [ws, count] of sortedWorkspaces) {
        const isTarget = ws.toLowerCase().includes(workspacePath.toLowerCase()) ||
                       workspacePath.toLowerCase().includes(ws.toLowerCase());
        console.log(`     ${isTarget ? '🎯' : '  '} "${ws}": ${count} tâches`);
      }
    }

    // Traitement parallèle par batches de 20
    console.log(`[buildHierarchicalSkeletonsLegacy] 🚀 Traitement parallèle de ${allTaskEntries.length} tâches (batches de 20)`);

    const processedSkeletons = await this.processBatch(
      allTaskEntries,
      async (taskEntry) => {
        try {
          const skeleton = await this.analyzeConversation(taskEntry.taskId, taskEntry.taskPath, true);
          if (skeleton && (workspacePath === undefined || skeleton.metadata.workspace === workspacePath)) {
            return skeleton;
          }
          return null;
        } catch (error) {
          console.warn(`[buildHierarchicalSkeletonsLegacy] ⚠️ Erreur sur tâche ${taskEntry.taskId}:`, error);
          return null;
        }
      },
      20, // Batch size
      (processed, total) => {
        if (processed % 200 === 0) {
          console.log(`[buildHierarchicalSkeletonsLegacy] 📊 Progression: ${processed}/${total} tâches traitées`);
        }
      }
    );

    conversations.push(...processedSkeletons.filter(s => s !== null) as ConversationSkeleton[]);

    // 📊 DIAGNOSTIC POST-FILTRAGE : Résultats du filtrage workspace
    if (workspacePath !== undefined) {
      const withWorkspaceMatch = conversations.filter(s =>
        s.metadata.workspace && (
          s.metadata.workspace === workspacePath ||
            s.metadata.workspace.toLowerCase().includes(workspacePath.toLowerCase()) ||
            workspacePath.toLowerCase().includes(s.metadata.workspace.toLowerCase())
        )
      ).length;

      console.log(`[buildHierarchicalSkeletonsLegacy] 📊 RÉSULTATS FILTRAGE:`);
      console.log(`   Skeletons générés: ${conversations.length}`);
      console.log(`   Avec workspace match: ${withWorkspaceMatch} (${conversations.length > 0 ? (withWorkspaceMatch/conversations.length*100).toFixed(1) : 0}%)`);
      console.log(`   Taux de correspondance attendu: ≥70%`);

      if (withWorkspaceMatch < conversations.length * 0.7) {
        console.warn(`🚨 TAUX FAIBLE: Seulement ${((withWorkspaceMatch/conversations.length)*100).toFixed(1)}% au lieu de ≥70%`);

        // Analyser les workspaces réels pour diagnostic
        const actualWorkspaces = new Map<string, number>();
        for (const skeleton of conversations) {
          const ws = skeleton.metadata.workspace || '<UNDEFINED>';
          actualWorkspaces.set(ws, (actualWorkspaces.get(ws) || 0) + 1);
        }

        console.log(`   Workspaces réels détectés:`);
        const topWorkspaces = Array.from(actualWorkspaces.entries())
          .sort(([,a], [,b]) => b - a)
          .slice(0, 5);

        for (const [ws, count] of topWorkspaces) {
          const isTarget = ws !== '<UNDEFINED>' && (
            ws.toLowerCase().includes(workspacePath.toLowerCase()) ||
            workspacePath.toLowerCase().includes(ws.toLowerCase())
          );
          console.log(`     ${isTarget ? '🎯' : '  '} "${ws}": ${count} tâches`);
        }
      }
    }

    // � PHASE 3: Résolution strict mode des parents manquants en 2 passes
    console.log(`[buildHierarchicalSkeletonsLegacy] 🔗 PHASE 3: Résolution des parents manquants en mode strict`);
    console.log(`STRICT MODE: pass1 indexing complete`);

    const orphanTasks = conversations.filter(c => !c.parentTaskId);
    let resolvedCount = 0;
    console.log(`STRICT MODE: linking pass2 started`);

    // File de liaisons différées pour les enfants sans parent trouvé en strict pendant passe 1
    const deferredLinkings: Array<{child: ConversationSkeleton, truncatedInstruction: string}> = [];

    // Pass 2: Tentative de résolution strict uniquement via exact prefix matching
    for (const orphan of orphanTasks) {
        if (!orphan.truncatedInstruction) {
            continue; // Skip les tâches sans instruction
        }

        // Utilisation du globalTaskInstructionIndex pour recherche exact prefix
        const exactMatches = globalTaskInstructionIndex.searchExactPrefix(orphan.truncatedInstruction);

        if (exactMatches && exactMatches.length === 1) {
            const candidateParent = exactMatches[0];

            // Validation basique : pas d'auto-référence
            if (candidateParent.taskId !== orphan.taskId) {
                // Vérifier que le parent existe dans notre dataset
                const parentExists = conversations.find(c => c.taskId === candidateParent.taskId);
                if (parentExists) {
                    orphan.parentTaskId = candidateParent.taskId;
                    resolvedCount++;
                    console.log(`STRICT MODE: exact match resolved ${orphan.taskId.substring(0,8)} → ${candidateParent.taskId.substring(0,8)}`);
                } else {
                    console.log(`STRICT MODE: parent candidate ${candidateParent.taskId.substring(0,8)} not in dataset for ${orphan.taskId.substring(0,8)}`);
                }
            }
        } else if (exactMatches && exactMatches.length > 1) {
            console.log(`STRICT MODE: ambiguous matches (${exactMatches.length}) for ${orphan.taskId.substring(0,8)}, skipped`);
        } else {
            // Pas de match exact, ajouter à la file différée
            deferredLinkings.push({ child: orphan, truncatedInstruction: orphan.truncatedInstruction });
        }
    }

    console.log(`STRICT MODE: deferred linkings count: ${deferredLinkings.length}`);
    // Note: Pour cette phase de validation, on ne retraite pas les liaisons différées
    // car le strict mode doit être déterministe et utiliser uniquement exact prefix matching

    const finalOrphansCount = conversations.filter(c => !c.parentTaskId).length;
    console.log(`STRICT MODE: final orphans count: ${finalOrphansCount}`);

    const indexStats = globalTaskInstructionIndex.getStats();
    console.log(`[buildHierarchicalSkeletonsLegacy] ✅ TERMINÉ:`);
    console.log(`   📊 ${conversations.length} squelettes générés`);
    console.log(`   🔗 ${resolvedCount} relations résolues en phase 3`);
    console.log(`   📈 Index: ${indexStats.totalInstructions} instructions, ${indexStats.totalNodes} noeuds`);

    return conversations;
  }

  /**
   * Reconstruction PARALLÉLISÉE de l'index radix-tree à partir des squelettes existants
   */
  private static async rebuildIndexFromExistingSkeletons(): Promise<void> {
    const skeletonPrefixes = new Map<string, string[]>();
    const storageLocations = await this.detectStorageLocations();

    // Collecter tous les chemins de squelettes
    const allSkeletonPaths: string[] = [];

    for (const locationPath of storageLocations) {
      const tasksPath = path.join(locationPath, 'tasks');

      try {
        const taskDirs = await fs.readdir(tasksPath, { withFileTypes: true });

        for (const entry of taskDirs) {
          if (!entry.isDirectory()) continue;

          const skeletonPath = path.join(tasksPath, entry.name, '.skeleton');
          if (existsSync(skeletonPath)) {
            allSkeletonPaths.push(skeletonPath);
          }
        }
      } catch (error) {
        console.warn(`[rebuildIndexFromExistingSkeletons] ⚠️ Erreur scan ${tasksPath}:`, error);
      }
    }

    console.log(`[rebuildIndexFromExistingSkeletons] 📦 Lecture parallèle de ${allSkeletonPaths.length} squelettes existants`);

    // Traitement parallèle des squelettes
    const skeletonData = await this.processBatch(
      allSkeletonPaths,
      async (skeletonPath) => {
        try {
          const skeletonContent = await fs.readFile(skeletonPath, 'utf-8');
          const skeleton: ConversationSkeleton = JSON.parse(skeletonContent);

          if (skeleton.childTaskInstructionPrefixes && skeleton.childTaskInstructionPrefixes.length > 0) {
            return { taskId: skeleton.taskId, prefixes: skeleton.childTaskInstructionPrefixes };
          }
          return null;
        } catch (error) {
          // Continue si le squelette est corrompu
          return null;
        }
      },
      30, // Batch size plus élevé pour la lecture pure
      (processed, total) => {
        if (processed % 300 === 0) {
          console.log(`[rebuildIndexFromExistingSkeletons] 📊 ${processed}/${total} squelettes lus`);
        }
      }
    );

    // Construire la map finale
    for (const data of skeletonData) {
      if (data) {
        skeletonPrefixes.set(data.taskId, data.prefixes);
      }
    }

    console.log(`[rebuildIndexFromExistingSkeletons] 🏗️ Reconstruction index avec ${skeletonPrefixes.size} squelettes`);
    globalTaskInstructionIndex.rebuildFromSkeletons(skeletonPrefixes);
  }

  /**
   * 🔄 MÉTHODE HÉRITÉE : Compatibilité avec l'ancien système
   */
  private static async getAllConversationsInWorkspace(
    workspacePath: string,
    maxTasks: number = 100
  ): Promise<ConversationSkeleton[]> {
    // Rediriger vers la nouvelle méthode de production
    return this.buildHierarchicalSkeletons(workspacePath, maxTasks < 1000);
  }

  /**
   * 🚀 PRODUCTION : Extrait les instructions new_task d'un fichier ui_messages.json
   * @param uiMessagesPath - Chemin vers le fichier ui_messages.json
   * @param maxLines - Limite de lignes (0 = pas de limite pour production)
   * @returns Promise<NewTaskInstruction[]> - Instructions new_task trouvées
   */
  private static async extractNewTaskInstructionsFromUI(
    uiMessagesPath: string,
    maxLines: number = 0,
    preloadedContent?: string
  ): Promise<NewTaskInstruction[]> {
    const instructions: NewTaskInstruction[] = [];

    // 🎯 CORRECTION TESTS XML : Activer TOUS les patterns (XML + JSON)
    // Les tests unitaires prouvent que ui_messages.json contient des balises XML <task> et <new_task>
    // qui doivent être parsées. Le flag onlyJsonFormat=false active tous les patterns de parsing.
    // Cette méthode lit UNIQUEMENT ui_messages.json, donc pas de contamination depuis api_conversation_history.json
    await this.extractFromMessageFile(uiMessagesPath, instructions, maxLines, false, preloadedContent);

    if (process.env.ROO_DEBUG_INSTRUCTIONS === '1') {
      console.log(`[extractNewTaskInstructionsFromUI] ✅ ${instructions.length} instructions trouvées depuis ui_messages.json uniquement`);
    }
    return instructions;
  }
  /**
   * Extrait l'instruction PRINCIPALE d'une tâche depuis ui_messages.json
   * Cherche d'abord dans say/text, puis dans api_req_started si say/text est trop court
   * @param uiMessagesPath Chemin vers ui_messages.json
   * @returns L'instruction principale ou undefined
   */
  public static async extractMainInstructionFromUI(
    uiMessagesPath: string,
    preloadedContent?: string
  ): Promise<string | undefined> {
    try {
      let content: string;
      if (preloadedContent !== undefined) {
        content = preloadedContent;
      } else {
        if (!existsSync(uiMessagesPath)) {
          return undefined;
        }

        content = await fs.readFile(uiMessagesPath, 'utf-8');

        // Nettoyage BOM
        if (content.charCodeAt(0) === 0xFEFF) {
          content = content.slice(1);
        }
      }

      const messages = JSON.parse(content);

      if (!Array.isArray(messages) || messages.length === 0) {
        return undefined;
      }

      // Chercher le premier message say/text
      let firstSayText: string | undefined;
      for (const msg of messages) {
        if (msg.type === 'say' && msg.say === 'text' && typeof msg.text === 'string' && msg.text.trim().length > 0) {
          firstSayText = msg.text.trim();
          break;
        }
      }

      // Si say/text est trop court ou se termine par "...", chercher dans api_req_started
      if (!firstSayText || firstSayText.length < 50 || firstSayText.endsWith('...')) {
        for (const msg of messages) {
          if (msg.type === 'say' && msg.say === 'api_req_started' && typeof msg.text === 'string') {
            try {
              const data = JSON.parse(msg.text);
              if (data.request && typeof data.request === 'string') {
                // Extraire le contenu entre <task> et </task>
                const taskMatch = data.request.match(/<task>\s*([\s\S]*?)\s*<\/task>/);
                if (taskMatch && taskMatch[1]) {
                  return taskMatch[1].trim();
                }
              }
            } catch {
              // Pas du JSON valide, continuer
            }
          }
        }
      }

      return firstSayText;
    } catch (error) {
      if (process.env.ROO_DEBUG_INSTRUCTIONS === '1') {
        console.warn(`[extractMainInstructionFromUI] ⚠️ Erreur pour ${uiMessagesPath}:`, error);
      }
      return undefined;
    }
  }


  private static async extractFromMessageFile(
    filePath: string,
    instructions: NewTaskInstruction[],
    maxLines: number = 0,
    onlyJsonFormat: boolean = false,
    preloadedContent?: string
  ): Promise<void> {
    try {
      let content: string;
      if (preloadedContent !== undefined) {
        content = preloadedContent;
      } else {
        if (!existsSync(filePath)) {
          return;
        }

        content = await fs.readFile(filePath, 'utf-8');

        // Nettoyage BOM
        if (content.charCodeAt(0) === 0xFEFF) {
          content = content.slice(1);
        }
      }

      // ✅ PRODUCTION : Traitement complet du fichier
      let processedContent = content;
      if (maxLines > 0) {
        // Mode test uniquement
        const lines = content.split('\n');
        processedContent = lines.slice(0, maxLines).join('\n');
      }

      let messages: any[] = [];
      try {
        // Tentative 1: JSON standard (tableau)
        const data = JSON.parse(processedContent);
        messages = Array.isArray(data) ? data : [];
      } catch (e1) {
        // Tentative 2: Contenu "presque array" (éléments séparés par des virgules sans [ ])
        let sanitized = processedContent.trim();
        if (!sanitized.startsWith('[') && !sanitized.endsWith(']')) {
          sanitized = `[${sanitized}]`;
        }
        try {
          const data2 = JSON.parse(sanitized);
          messages = Array.isArray(data2) ? data2 : [];
        } catch (e2) {
          // Tentative 3: JSONL (une entrée JSON par ligne)
          const lines = processedContent.split('\n');
          const jsonlItems: any[] = [];
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              jsonlItems.push(JSON.parse(trimmed));
            } catch (_e3) {
              // ignorer les lignes invalides
            }
          }
          if (jsonlItems.length > 0) {
            messages = jsonlItems;
          } else {
            console.warn(`[extractFromMessageFile] ⚠️ Parsing JSON échoué pour ${filePath} (standard/array/JSONL).`);
            return;
          }
        }
      }

      // 🎯 CORRECTION SDDD: Utilisation du coordinateur modulaire pour l'extraction
      let coordinator;
      if (this._coordinatorOverride) {
        coordinator = this._coordinatorOverride;
      } else {
        const module = await import('./message-extraction-coordinator.js');
        coordinator = module.messageExtractionCoordinator;
      }

      const result = coordinator.extractFromMessages(messages, {
        maxLines,
        onlyJsonFormat,
        enableDebug: process.env.ROO_DEBUG_INSTRUCTIONS === '1'
      });

      // Debug forcer pour voir le résultat
      if (process.env.ROO_DEBUG_INSTRUCTIONS === '1') {
        console.log(`[extractFromMessageFile] 📊 RÉSULTAT extraction: ${result.instructions.length} instructions trouvées`);
        console.log(`[extractFromMessageFile] 📋 Instructions:`, JSON.stringify(result.instructions, null, 2));
      }

      // Ajouter les instructions extraites au tableau fourni
      instructions.push(...result.instructions);

      // Logger les erreurs si nécessaire
      if (result.errors.length > 0 && process.env.ROO_DEBUG_INSTRUCTIONS === '1') {
        console.log(`[extractFromMessageFile] ⚠️ Extraction errors for ${filePath}:`, result.errors);
      }

    } catch (error) {
      console.error(`[extractFromMessageFile] ❌ Erreur pour ${filePath}:`, error);
    }
  }

  /**
   * Méthode interne pour extraire les instructions depuis un tableau de messages
   * (Utilisée principalement par les tests unitaires)
   */
  private static async extractNewTaskInstructions(
    messages: any[]
  ): Promise<NewTaskInstruction[]> {
    let coordinator;
    if (this._coordinatorOverride) {
      coordinator = this._coordinatorOverride;
    } else {
      const module = await import('./message-extraction-coordinator.js');
      coordinator = module.messageExtractionCoordinator;
    }

    const result = coordinator.extractFromMessages(messages, {
      enableDebug: process.env.ROO_DEBUG_INSTRUCTIONS === '1'
    });
    return result.instructions;
  }

  /**
   * @deprecated MÉTHODE CORROMPUE - Violait le principe architectural
   * Les relations parent-enfant sont définies par les parents, pas devinées
   */
  private static async analyzeParentForNewTaskInstructions(
    parentTask: ConversationSkeleton,
    childTask: ConversationSkeleton
  ): Promise<boolean> {
    // 🛡️ CORRECTION ARCHITECTURE : Toujours retourner false
    return false;
  }

  /**
   * @deprecated MÉTHODE CORROMPUE - Violait le principe architectural
   * Tentait de retrouver les parents en scannant tout le disque
   */
  private static async findParentByNewTaskInstructions(
    childTaskId: string,
    childMetadata: TaskMetadata
  ): Promise<string | undefined> {
    // 🛡️ CORRECTION ARCHITECTURE : Retourner toujours undefined
    // Les parents sont définis dans les métadonnées ou pas du tout
    return undefined;
  }

  /**
   * Helper: Obtient le chemin d'une tâche par son ID
   */
  private static async getTaskPathById(taskId: string): Promise<string | null> {
    const storageLocations = await this.detectStorageLocations();

    for (const locationPath of storageLocations) {
      const taskPath = path.join(locationPath, 'tasks', taskId);
      try {
        const stats = await fs.stat(taskPath);
        if (stats.isDirectory()) {
          return taskPath;
        }
      } catch (e) {
        // Continue avec l'emplacement suivant
      }
    }
    return null;
  }

  /**
   * @deprecated MÉTHODE CORROMPUE - Violait le principe architectural
   */
  private static async legacyInferParentFromChildContent(
    apiHistoryPath: string,
    uiMessagesPath: string
  ): Promise<string | undefined> {
    // 🛡️ CORRECTION ARCHITECTURE : Retourner toujours undefined
    return undefined;
  }

  /**
   * Extrait le parentTaskId à partir du premier message dans api_conversation_history.json
   */
  private static async extractParentFromApiHistory(apiHistoryPath: string): Promise<string | undefined> {
    try {
      const content = await fs.readFile(apiHistoryPath, 'utf-8');
      const data = JSON.parse(content);
      const messages = Array.isArray(data) ? data : (data?.messages || []);

      // Chercher le premier message utilisateur
      const firstUserMessage = messages.find((msg: any) => msg.role === 'user');
      if (!firstUserMessage?.content) return undefined;

      const messageText = Array.isArray(firstUserMessage.content)
        ? firstUserMessage.content.find((c: any) => c.type === 'text')?.text || ''
        : firstUserMessage.content;

      return this.extractTaskIdFromText(messageText);
    } catch (error) {
      console.error(`[extractParentFromApiHistory] Erreur:`, error);
      return undefined;
    }
  }

  /**
   * Extrait le parentTaskId à partir des messages UI
   */
  private static async extractParentFromUiMessages(uiMessagesPath: string): Promise<string | undefined> {
    try {
      const content = await fs.readFile(uiMessagesPath, 'utf-8');
      const data = JSON.parse(content);
      const messages = Array.isArray(data) ? data : [];

      // Chercher le premier message utilisateur
      const firstMessage = messages.find((msg: any) => msg.type === 'user');
      if (!firstMessage?.content) return undefined;

      return this.extractTaskIdFromText(firstMessage.content);
    } catch (error) {
      console.error(`[extractParentFromUiMessages] Erreur:`, error);
      return undefined;
    }
  }

  /**
   * Extrait un taskId à partir d'un texte en utilisant des patterns
   */
  private static extractTaskIdFromText(text: string): string | undefined {
    if (!text) return undefined;

    // Pattern 1: Rechercher des UUIDs v4 explicites
    const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi;
    const uuids = text.match(uuidPattern);

    if (uuids && uuids.length > 0) {
      // Prendre le premier UUID trouvé comme potentiel parent
      console.log(`[extractTaskIdFromText] UUID trouvé: ${uuids[0]}`);
      return uuids[0];
    }

    // Pattern 2: Rechercher des références explicites à des tâches parentes
    // dans les mots-clés comme "CONTEXTE HÉRITÉ", "ORCHESTRATEUR", etc.
    const contextPatterns = [
      /CONTEXTE HÉRITÉ.*?([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/i,
      /ORCHESTRATEUR.*?([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/i,
      /tâche parent.*?([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/i
    ];

    for (const pattern of contextPatterns) {
      const match = text.match(pattern);
      if (match && match[1]) {
        console.log(`[extractTaskIdFromText] Parent trouvé via pattern: ${match[1]}`);
        return match[1];
      }
    }

    return undefined;
  }

  /**
   * Construit une séquence triée de messages et d'actions à partir des fichiers d'historique.
   * Lit les fichiers ligne par ligne pour minimiser l'utilisation de la mémoire.
   */
  private static async buildSequenceFromFiles(
    apiHistoryPath: string,
    uiMessagesPath: string,
    preloadedApiContent?: string,
    preloadedUiContent?: string
  ): Promise<(MessageSkeleton | ActionMetadata)[]> {
    let combinedItems: any[] = [];
    const MAX_CONTENT_LENGTH = 400;

    // Helper pour lire et parser un fichier JSON en toute sécurité
    const readJsonFile = async (filePath: string, preloadedContent?: string): Promise<any[]> => {
        try {
            let content: string;
            if (preloadedContent !== undefined) {
                content = preloadedContent;
            } else {
                if (!existsSync(filePath)) return [];
                content = await fs.readFile(filePath, 'utf-8');
                if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
            }

            // 1. Tentative de parsing JSON standard (pour api_conversation_history.json)
            try {
                const data = JSON.parse(content);
                const items = Array.isArray(data) ? data : (data?.messages || []);
                if (items.length > 0) {
                    console.log(`[readJsonFile] ✅ Parsed ${items.length} items as standard JSON from ${path.basename(filePath)}`);
                    return items;
                }
            } catch (jsonError) {
                // L'échec est attendu pour les formats non-standards, on continue
            }

            // 2. Traitement des cas mal formés (pour ui_messages.json)
            let sanitizedContent = content.trim();
            if (sanitizedContent.endsWith(',')) {
                sanitizedContent = sanitizedContent.slice(0, -1);
            }

            // Si le contenu n'est pas déjà un tableau, on l'enveloppe
            if (!sanitizedContent.startsWith('[') && !sanitizedContent.endsWith(']')) {
                sanitizedContent = `[${sanitizedContent}]`;
            }

            try {
                const items = JSON.parse(sanitizedContent);
                console.log(`[readJsonFile] ✅ Parsed ${items.length} items as a malformed JSON array from ${path.basename(filePath)}`);
                return Array.isArray(items) ? items : [];
            } catch (error) {
                 console.warn(`[readJsonFile] ⚠️ Failed to parse as malformed array: ${path.basename(filePath)}`, error);
            }

            // 3. Fallback final en mode JSONL
            const lines = content.split('\n');
            const items: any[] = [];
            for (const line of lines) {
                if (line.trim()) {
                    try {
                        items.push(JSON.parse(line));
                    } catch (lineError) {
                       // ignorer la ligne
                    }
                }
            }
            if(items.length > 0) {
                console.log(`[readJsonFile] ✅ Parsed ${items.length} items as JSONL from ${path.basename(filePath)}`);
            }
            return items;

        } catch (e) {
            console.error(`[readJsonFile] ❌ Unrecoverable error reading ${filePath}:`, e);
            return [];
        }
    };

    const apiItems = await readJsonFile(apiHistoryPath, preloadedApiContent);
    const uiItems = await readJsonFile(uiMessagesPath, preloadedUiContent);
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
          // Récupérer TOUS les éléments de type 'text' et les concaténer
          const textElements = content
            .filter((c: any) => c.type === 'text' && c.text)
            .map((c: any) => c.text);

          content = textElements.length > 0
            ? textElements.join('\n\n') // Séparer par double saut de ligne
            : '[contenu non textuel]';
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
        // loc est le chemin de base du stockage, il faut ajouter 'tasks'
        const tasksPath = path.join(loc, 'tasks');
        const stats = await this.getStatsForPath(tasksPath);
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
   * 🔧 FIX CRITIQUE: Calcule breakdown par workspace en scannant directement le disque
   * pour être cohérent avec getStorageStats() qui compte aussi sur le disque
   */
  public static async getWorkspaceBreakdown(): Promise<Record<string, {count: number, totalSize: number, lastActivity: string}>> {
    const locations = await this.detectStorageLocations();
    const workspaceBreakdown: Record<string, {count: number, totalSize: number, lastActivity: string}> = {};

    for (const loc of locations) {
        const tasksPath = path.join(loc, 'tasks');

        try {
            const entries = await fs.readdir(tasksPath, { withFileTypes: true });

            for (const entry of entries) {
                if (entry.isDirectory()) {
                    const taskPath = path.join(tasksPath, entry.name);

                    try {
                        // Détecter le workspace pour cette tâche
                        const workspace = await this.detectWorkspaceForTask(taskPath);

                        const stats = await fs.stat(taskPath);
                        const lastActivity = stats.mtime.toISOString();

                        // Initialiser ou mettre à jour les stats du workspace
                        if (!workspaceBreakdown[workspace]) {
                            workspaceBreakdown[workspace] = {
                                count: 0,
                                totalSize: 0,
                                lastActivity: lastActivity
                            };
                        }

                        workspaceBreakdown[workspace].count++;
                        workspaceBreakdown[workspace].totalSize += stats.size;

                        // Mettre à jour la dernière activité si plus récente
                        if (new Date(lastActivity) > new Date(workspaceBreakdown[workspace].lastActivity)) {
                            workspaceBreakdown[workspace].lastActivity = lastActivity;
                        }

                    } catch (taskError) {
                        // Ignorer les tâches non accessibles
                        console.warn(`Impossible d'analyser tâche ${entry.name}:`, (taskError as Error).message);
                    }
                }
            }
        } catch (dirError) {
            console.warn(`Impossible de lire répertoire ${tasksPath}:`, (dirError as Error).message);
        }
    }

    return workspaceBreakdown;
  }

  /**
   * Détecte le workspace pour une tâche donnée
   * @version 2.0 - Utilise WorkspaceDetector moderne (stratégie dual)
   * @see WorkspaceDetector pour détails stratégie metadata → environment_details fallback
   */
  public static async detectWorkspaceForTask(taskPath: string): Promise<string> {
    try {
      const workspaceDetector = new WorkspaceDetector({
        enableCache: true,
        validateExistence: false, // Performance
        normalizePaths: true,
      });

      const result = await workspaceDetector.detect(taskPath);

      // Log détaillé si mode debug
      if (process.env.DEBUG_WORKSPACE === 'true') {
        console.log(`[detectWorkspaceForTask] ${taskPath}:`, {
          workspace: result.workspace,
          source: result.source,
          confidence: result.confidence
        });
      }

      return result.workspace || 'UNKNOWN';
    } catch (error) {
      console.warn(`[detectWorkspaceForTask] Error for ${taskPath}:`, error);
      return 'UNKNOWN';
    }
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