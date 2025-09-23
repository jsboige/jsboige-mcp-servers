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
import { globalTaskInstructionIndex } from './task-instruction-index.js';

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
   * Version production avec architecture en deux passes pour reconstruction hiérarchies
   */
  public static async analyzeConversation(
    taskId: string,
    taskPath: string,
    useProductionHierarchy: boolean = true
  ): Promise<ConversationSkeleton | null> {
    const metadataPath = path.join(taskPath, 'task_metadata.json');
    const apiHistoryPath = path.join(taskPath, 'api_conversation_history.json');
    const uiMessagesPath = path.join(taskPath, 'ui_messages.json');

    try {
        const [taskDirStats, metadataStats, apiHistoryStats, uiMessagesStats] = await Promise.all([
            fs.stat(taskPath).catch(() => null), //
            fs.stat(metadataPath).catch(() => null),
            fs.stat(apiHistoryPath).catch(() => null),
            fs.stat(uiMessagesPath).catch(() => null)
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

        // 🚀 PRODUCTION : Logique de reconstruction hiérarchique en deux passes
        let parentTaskId = rawMetadata.parentTaskId || rawMetadata.parent_task_id;
        let childTaskInstructionPrefixes: string[] = [];
        
        if (useProductionHierarchy) {
            // Phase 1: Extraire les préfixes d'instructions de cette tâche
            if (uiMessagesStats) {
                console.log(`[analyzeConversation] 🔍 DEBUG PHASE 1 - Extracting instructions for ${taskId.substring(0, 8)}`);
                const instructions = await this.extractNewTaskInstructionsFromUI(uiMessagesPath, 0); // Pas de limite
                console.log(`[analyzeConversation] 🔍 DEBUG PHASE 1 - Found ${instructions.length} instructions for ${taskId.substring(0, 8)}`);
                
                childTaskInstructionPrefixes = instructions.map(inst => {
                    // 🎯 CORRECTION CRITIQUE: Stocker seulement le message sans préfixe de mode pour un matching simple
                    const prefix = inst.message.substring(0, 200);
                    console.log(`[analyzeConversation] 🔍 DEBUG PHASE 1 - Created prefix for ${taskId.substring(0, 8)}: "${prefix.substring(0, 60)}..." (mode: ${inst.mode})`);
                    return prefix;
                }).filter(prefix => prefix.length > 10); // Filtrer les préfixes trop courts
                
                console.log(`[analyzeConversation] 🔍 DEBUG PHASE 1 - Final prefixes count for ${taskId.substring(0, 8)}: ${childTaskInstructionPrefixes.length}`);
            }
            
            // Phase 2: Recherche de parent déplacée après calcul de truncatedInstruction
        } else {
            // 🚨 FIX RÉCURSION : Quand useProductionHierarchy = false, pas d'inférence de parent
            // pour éviter la récursion infinie avec findParentByNewTaskInstructions
            console.log(`[analyzeConversation] 🛡️ useProductionHierarchy=false pour ${taskId}, pas d'inférence de parent (évite récursion)`);
        }
        
        const sequence = await this.buildSequenceFromFiles(apiHistoryPath, uiMessagesPath);
        
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

        // 🚀 NOUVEAU : Extraction de l'instruction depuis le premier message utilisateur
        let truncatedInstruction: string | undefined;
        const userMessages = sequence.filter(s => 'role' in s && s.role === 'user') as MessageSkeleton[];
        if (userMessages.length > 0) {
            const firstUserMessage = userMessages[0];
            let instruction = firstUserMessage.content.trim();
            let instructionSource = 'raw';
            
            // 🎯 CORRECTION CRITIQUE : Support patterns XML avancés pour sous-tâches
            // Pattern 1: Balise simple <task>content</task>
            const taskMatch = instruction.match(/<task>([\s\S]*?)<\/task>/i);
            if (taskMatch) {
                instruction = taskMatch[1].trim();
                instructionSource = 'task_tag';
            }
            // Pattern 2: Structures de délégation complexes avec mode et message
            else {
                const delegationPattern = /<(\w+_\w+)>\s*<mode>([^<]+)<\/mode>\s*<message>([^<]+)<\/message>\s*<\/\1>/g;
                const delegationMatch = delegationPattern.exec(instruction);
                if (delegationMatch) {
                    const mode = delegationMatch[2].trim();
                    const taskMessage = delegationMatch[3].trim();
                    
                    // 🛡️ VALIDATION : Vérifier la validité des champs extraits
                    if (mode.length > 0 && taskMessage.length > 0) {
                        instruction = `[${mode}] ${taskMessage}`;
                        instructionSource = 'delegation_xml';
                        console.log(`[analyzeConversation] 🎯 INSTRUCTION DÉLÉGATION extraite pour ${taskId}: ${instruction.substring(0, 50)}...`);
                    }
                }
            }
            
            // Troncature à 200 caractères maximum
            if (instruction.length > 200) {
                instruction = instruction.substring(0, 197) + '...';
            }
            
            truncatedInstruction = instruction.length > 0 ? instruction : undefined;
            
            // 📊 LOG DÉTAILLÉ : Traçabilité de l'extraction
            if (truncatedInstruction) {
                console.log(`[analyzeConversation] ✅ Instruction extraite (${instructionSource}) pour ${taskId}: "${truncatedInstruction}"`);
            }
            
            // 🎯 Phase 2: Si pas de parent trouvé, chercher via l'index radix-tree avec truncatedInstruction
            if (!parentTaskId && rawMetadata.workspace && truncatedInstruction) {
                const childText = truncatedInstruction;
                if (childText.length > 5) {
                    parentTaskId = globalTaskInstructionIndex.findPotentialParent(childText);
                    if (parentTaskId) {
                        console.log(`[analyzeConversation] 🎯 Parent trouvé via radix-tree pour ${taskId}: ${parentTaskId}`);
                    }
                }
            }
        }
        // Extraire les vrais timestamps des fichiers JSON au lieu d'utiliser mtime
        const timestamps: Date[] = [];

        // 1. Lire les timestamps "ts" et extraire le workspace depuis api_conversation_history.json
        let extractedWorkspace: string | undefined = undefined;
        if (apiHistoryStats) {
            try {
                let apiContent = await fs.readFile(apiHistoryPath, 'utf-8');
                // Nettoyage explicite du BOM (Byte Order Mark)
                if (apiContent.charCodeAt(0) === 0xFEFF) {
                    apiContent = apiContent.slice(1);
                }
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
            },
            childTaskInstructionPrefixes: childTaskInstructionPrefixes.length > 0 ? childTaskInstructionPrefixes : undefined,
            // 🚀 NOUVEAUX CHAMPS : Ajout des fonctionnalités demandées
            isCompleted,
            truncatedInstruction,
        };

        // 🚀 PRODUCTION : Alimenter l'index radix-tree avec les instructions trouvées
        if (useProductionHierarchy && childTaskInstructionPrefixes.length > 0) {
            for (const prefix of childTaskInstructionPrefixes) {
                console.log(`[PASS 1 - INDEXING] Task: ${taskId.substring(0,8)} | RAW PREFIX: "${prefix}"`);
                globalTaskInstructionIndex.addInstruction(prefix, taskId);
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
   * Tente d'inférer le parentTaskId à partir du contenu de la conversation
   * quand il n'est pas disponible dans les métadonnées
   */
  private static inferParentTaskIdFromContent(
    apiHistoryPath: string,
    uiMessagesPath: string,
    rawMetadata: TaskMetadata,
    currentTaskId: string
  ): Promise<string | undefined> {
    return new Promise(async (resolve) => {
      try {
        console.log(`[inferParentTaskIdFromContent] 🔍 Nouvelle approche: analyse des instructions new_task pour ${currentTaskId}`);
        
        // 🚀 NOUVELLE LOGIQUE : Analyse des conversations parents pour instructions new_task
        const parentId = await this.findParentByNewTaskInstructions(currentTaskId, rawMetadata);
        if (parentId && parentId !== currentTaskId) {
          console.log(`[inferParentTaskIdFromContent] ✅ Parent trouvé via analyse new_task: ${parentId}`);
          return resolve(parentId);
        }

        // 💾 FALLBACK : Méthode héritée pour compatibilité temporaire
        console.log(`[inferParentTaskIdFromContent] 🔄 Fallback: analyse des conversations enfants`);
        const fallbackParentId = await this.legacyInferParentFromChildContent(apiHistoryPath, uiMessagesPath);
        if (fallbackParentId && fallbackParentId !== currentTaskId) {
          console.log(`[inferParentTaskIdFromContent] ⚡ Parent trouvé via fallback: ${fallbackParentId}`);
          return resolve(fallbackParentId);
        }

        // 3. Si aucune référence trouvée, retourner undefined
        console.log(`[inferParentTaskIdFromContent] Aucun parent inféré`);
        resolve(undefined);
      } catch (error) {
        console.error(`[inferParentTaskIdFromContent] Erreur:`, error);
        resolve(undefined);
      }
    });
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
    useFullVolume: boolean = true
  ): Promise<ConversationSkeleton[]> {
    console.log(`[buildHierarchicalSkeletons] 🏗️ DÉMARRAGE reconstruction hiérarchique ${workspacePath || 'TOUS WORKSPACES'}`);
    
    const conversations: ConversationSkeleton[] = [];
    const storageLocations = await this.detectStorageLocations();
    
    // PHASE 1: Reconstruction de l'index à partir des squelettes existants
    console.log(`[buildHierarchicalSkeletons] 📋 PHASE 1: Reconstruction index radix-tree`);
    await this.rebuildIndexFromExistingSkeletons();

    // PHASE 2: Scan et génération des squelettes (PARALLÉLISÉE)
    console.log(`[buildHierarchicalSkeletons] 🔄 PHASE 2: Génération squelettes avec hiérarchies en parallèle`);
    const maxTasks = useFullVolume ? Number.MAX_SAFE_INTEGER : 100;

    // Collecter toutes les tâches à traiter
    const allTaskEntries: Array<{taskId: string, taskPath: string, locationPath: string}> = [];

    for (const locationPath of storageLocations) {
      const tasksPath = path.join(locationPath, 'tasks');
      
      try {
        const taskDirs = await fs.readdir(tasksPath, { withFileTypes: true });
        console.log(`[buildHierarchicalSkeletons] 📁 Collecte ${taskDirs.length} tâches dans ${locationPath}`);
        
        for (const entry of taskDirs) {
          if (allTaskEntries.length >= maxTasks) break;
          if (!entry.isDirectory()) continue;

          const taskPath = path.join(tasksPath, entry.name);
          allTaskEntries.push({
            taskId: entry.name,
            taskPath: taskPath,
            locationPath: locationPath
          });
        }
      } catch (error) {
        console.warn(`[buildHierarchicalSkeletons] ⚠️ Impossible de scanner ${tasksPath}:`, error);
      }
    }

    // Traitement parallèle par batches de 20
    console.log(`[buildHierarchicalSkeletons] 🚀 Traitement parallèle de ${allTaskEntries.length} tâches (batches de 20)`);
    
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
          console.warn(`[buildHierarchicalSkeletons] ⚠️ Erreur sur tâche ${taskEntry.taskId}:`, error);
          return null;
        }
      },
      20, // Batch size
      (processed, total) => {
        if (processed % 200 === 0) {
          console.log(`[buildHierarchicalSkeletons] 📊 Progression: ${processed}/${total} tâches traitées`);
        }
      }
    );

    conversations.push(...processedSkeletons.filter(s => s !== null) as ConversationSkeleton[]);

    // PHASE 3: Résolution finale des relations manquantes
    console.log(`[buildHierarchicalSkeletons] 🔗 PHASE 3: Résolution finale des relations parent-enfant`);
    const orphanTasks = conversations.filter(c => !c.parentTaskId);
    let resolvedCount = 0;

    for (const orphan of orphanTasks) {
      const childText = `${orphan.metadata.title || ''} ${orphan.metadata.mode || ''}`.trim();
      if (childText.length > 5) {
        const potentialParent = globalTaskInstructionIndex.findPotentialParent(childText);
        if (potentialParent && potentialParent !== orphan.taskId) {
          orphan.parentTaskId = potentialParent;
          resolvedCount++;
        }
      }
    }

    const indexStats = globalTaskInstructionIndex.getStats();
    console.log(`[buildHierarchicalSkeletons] ✅ TERMINÉ:`);
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
    maxLines: number = 0
  ): Promise<NewTaskInstruction[]> {
    const instructions: NewTaskInstruction[] = [];
    
    // 🔧 SYSTÈME HYBRIDE: ui_messages.json PRIORITAIRE (complet) puis api_conversation_history.json (condensé)
    const taskDir = path.dirname(uiMessagesPath);
    const apiHistoryPath = path.join(taskDir, 'api_conversation_history.json');
    
    // PRIORITÉ 1: ui_messages.json (sans condensation, garde TOUTES les sous-tâches)
    await this.extractFromMessageFile(uiMessagesPath, instructions, maxLines);
    const uiInstructions = instructions.length;
    
    // PRIORITÉ 2: api_conversation_history.json (avec condensation, peut manquer des sous-tâches)
    await this.extractFromMessageFile(apiHistoryPath, instructions, maxLines);
    const totalInstructions = instructions.length;
    
    console.log(`[extractNewTaskInstructionsFromUI] ✅ ${totalInstructions} instructions trouvées (UI:${uiInstructions} + API:${totalInstructions - uiInstructions}) - Patterns XML activés`);
    return instructions;
  }

  private static async extractFromMessageFile(
    filePath: string,
    instructions: NewTaskInstruction[],
    maxLines: number = 0
  ): Promise<void> {
    try {
      if (!existsSync(filePath)) {
        console.log(`[extractFromMessageFile] ⚠️ Fichier non trouvé: ${filePath}`);
        return;
      }

      let content = await fs.readFile(filePath, 'utf-8');
      
      // Nettoyage BOM
      if (content.charCodeAt(0) === 0xFEFF) {
        content = content.slice(1);
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
        const data = JSON.parse(processedContent);
        messages = Array.isArray(data) ? data : [];
      } catch (error) {
        console.warn(`[extractFromMessageFile] ⚠️ Parsing JSON échoué pour ${filePath}`);
        return;
      }

      for (const message of messages) {
        // 🎯 EXTRACTION PATTERNS RÉELS - Support contenu string ET array
        let contentText = '';
        
        if (typeof message.content === 'string') {
          contentText = message.content;
        } else if (Array.isArray(message.content)) {
          // Format: [{"type":"text","text":"..."}]
          for (const item of message.content) {
            if (item.type === 'text' && typeof item.text === 'string') {
              contentText += item.text + '\n';
            }
          }
        } else if (message.role && typeof message.text === 'string') {
          // Fallback pour ui_messages.json format
          contentText = message.text;
        }
        
        if (contentText) {
          // 🎯 PATTERN 1: Création délégation XML (assistant)
          if (message.role === 'assistant') {
            const delegationPattern = /<(\w+_\w+)>\s*<mode>([^<]+)<\/mode>\s*<message>([^<]+)<\/message>\s*<\/\1>/g;
            let match;
            while ((match = delegationPattern.exec(contentText)) !== null) {
              const mode = match[2].trim();
              const taskMessage = match[3].trim();
              
              // 🛡️ VALIDATION : Vérifier que mode et message ne sont pas vides
              if (mode.length === 0 || taskMessage.length === 0) {
                console.warn(`[extractFromMessageFile] ⚠️ Délégation XML invalide (mode ou message vide) dans ${path.basename(filePath)}`);
                continue;
              }
              
              const instruction: NewTaskInstruction = {
                timestamp: new Date(message.timestamp || message.ts || 0).getTime(),
                mode: mode,
                message: taskMessage.substring(0, 200), // Troncature sécurisée
              };
              instructions.push(instruction);
              console.log(`[extractFromMessageFile] 🎯 DÉLÉGATION XML ${mode} dans ${path.basename(filePath)}: ${taskMessage.substring(0, 50)}...`);
            }
          }
          
          // 🎯 PATTERN 2: Balises task simples (user/assistant) - NOUVEAU !
          const taskPattern = /<task>([\s\S]*?)<\/task>/gi;
          let taskMatch;
          while ((taskMatch = taskPattern.exec(contentText)) !== null) {
            const taskContent = taskMatch[1].trim();
            console.log(`[extractFromMessageFile] 🔍 DEBUG PARSING - Balise <task> trouvée dans ${path.basename(filePath)}, role: ${message.role}, contenu: "${taskContent.substring(0, 100)}..."`);
            
            if (taskContent.length > 20) { // Filtrer les contenus trop courts
              const instruction: NewTaskInstruction = {
                timestamp: new Date(message.timestamp || message.ts || 0).getTime(),
                mode: 'task', // Mode générique pour balises task simples
                message: taskContent.substring(0, 200), // Troncature sécurisée
              };
              instructions.push(instruction);
              console.log(`[extractFromMessageFile] 🎯 BALISE TASK SIMPLE AJOUTÉE dans ${path.basename(filePath)}: ${taskContent.substring(0, 50)}...`);
            } else {
              console.log(`[extractFromMessageFile] ⚠️ BALISE TASK REJETÉE (trop courte: ${taskContent.length} chars) dans ${path.basename(filePath)}`);
            }
          }
          
          // 🎯 PATTERN 2: Résultats délégation complétée (user)
          if (message.role === 'user') {
            const completedPattern = /\[(\w+_\w+) completed\] Result:\s*([\s\S]*?)(?=\n\n|\n\[|$)/g;
            let match;
            while ((match = completedPattern.exec(contentText)) !== null) {
              const result = match[2].trim();
              console.log(`[extractFromMessageFile] ✅ DÉLÉGATION COMPLÉTÉE dans ${path.basename(filePath)}: ${result.substring(0, 50)}...`);
            }
          }
        }

        // 🔧 LEGACY: Rétrocompatibilité anciens formats
        if (message.type === 'tool_call' && message.content?.tool === 'new_task') {
          const instruction: NewTaskInstruction = {
            timestamp: new Date(message.timestamp || 0).getTime(),
            mode: message.content.mode || 'legacy',
            message: message.content.message || '',
          };
          instructions.push(instruction);
          console.log(`[extractFromMessageFile] 🔄 Legacy tool_call dans ${path.basename(filePath)}`);
        }
      }
      
    } catch (error) {
      console.error(`[extractFromMessageFile] ❌ Erreur pour ${filePath}:`, error);
    }
  }

  /**
   * 🚀 NOUVELLE MÉTHODE : Analyse si une tâche parent correspond à une tâche enfant
   * @param parentTask - Squelette de la tâche parent candidate
   * @param childTask - Squelette de la tâche enfant
   * @returns Promise<boolean> - true si correspondance trouvée
   */
  private static async analyzeParentForNewTaskInstructions(
    parentTask: ConversationSkeleton,
    childTask: ConversationSkeleton
  ): Promise<boolean> {
    const parentTaskPath = await this.getTaskPathById(parentTask.taskId);
    if (!parentTaskPath) return false;

    const uiMessagesPath = path.join(parentTaskPath, 'ui_messages.json');
    const instructions = await this.extractNewTaskInstructionsFromUI(uiMessagesPath);

    if (instructions.length === 0) return false;

    // Calcul de la fenêtre temporelle (±1 heure autour de la création de l'enfant)
    const childCreatedAt = new Date(childTask.metadata.createdAt).getTime();
    const timeWindow = 60 * 60 * 1000; // 1 heure en ms

    for (const instruction of instructions) {
      const instructionTime = instruction.timestamp;
      
      // Vérification temporelle
      if (Math.abs(instructionTime - childCreatedAt) > timeWindow) continue;

      // Correspondance du mode
      if (instruction.mode !== childTask.metadata.mode) continue;

      // Correspondance partielle du message/titre
      if (childTask.metadata.title && instruction.message) {
        const childTitle = childTask.metadata.title.toLowerCase();
        const instructionMessage = instruction.message.toLowerCase();
        
        // Vérification de similarité basique (mots communs)
        const childWords = childTitle.split(/\s+/).filter(w => w.length > 3);
        const instructionWords = instructionMessage.split(/\s+/).filter(w => w.length > 3);
        
        const commonWords = childWords.filter(word =>
          instructionWords.some(iWord => iWord.includes(word) || word.includes(iWord))
        );

        if (commonWords.length > 0) {
          console.log(`[analyzeParentForNewTaskInstructions] ✅ Correspondance trouvée:
            Parent: ${parentTask.taskId}
            Child: ${childTask.taskId}
            Mode: ${instruction.mode}
            Mots communs: ${commonWords.join(', ')}`);
          return true;
        }
      }
    }

    return false;
  }

  /**
   * 🚀 NOUVELLE MÉTHODE PRINCIPALE : Trouve le parent d'une tâche via l'analyse des instructions new_task
   * @param childTaskId - ID de la tâche enfant
   * @param childMetadata - Métadonnées de la tâche enfant
   * @returns Promise<string | undefined> - ID du parent ou undefined
   */
  private static async findParentByNewTaskInstructions(
    childTaskId: string,
    childMetadata: TaskMetadata
  ): Promise<string | undefined> {
    console.log(`[findParentByNewTaskInstructions] 🔍 Recherche parent pour ${childTaskId}`);

    if (!childMetadata.workspace) {
      console.log(`[findParentByNewTaskInstructions] ⚠️ Pas de workspace défini pour ${childTaskId}`);
      return undefined;
    }

    try {
      // 🔧 FIX RÉCURSION : Scan direct du disque sans passer par getAllConversationsInWorkspace
      const storageLocations = await this.detectStorageLocations();
      const potentialParents: ConversationSkeleton[] = [];
      
      // Créer un squelette temporaire pour la tâche enfant
      const childTaskPath = await this.getTaskPathById(childTaskId);
      if (!childTaskPath) {
        console.log(`[findParentByNewTaskInstructions] ⚠️ Impossible de trouver le chemin de ${childTaskId}`);
        return undefined;
      }
      
      const childTask = await this.analyzeConversation(childTaskId, childTaskPath, false);
      if (!childTask) {
        console.log(`[findParentByNewTaskInstructions] ⚠️ Impossible d'analyser ${childTaskId}`);
        return undefined;
      }

      // Scan direct des tâches sur disque
      for (const locationPath of storageLocations) {
        const tasksPath = path.join(locationPath, 'tasks');
        
        try {
          const taskDirs = await fs.readdir(tasksPath, { withFileTypes: true });
          
          for (const entry of taskDirs) {
            if (!entry.isDirectory() || entry.name === childTaskId) continue;
            
            const taskPath = path.join(tasksPath, entry.name);
            const candidate = await this.analyzeConversation(entry.name, taskPath, false);
            
            if (candidate &&
                candidate.metadata.workspace === childMetadata.workspace &&
                new Date(candidate.metadata.createdAt).getTime() < new Date(childTask.metadata.createdAt).getTime()) {
              potentialParents.push(candidate);
            }
          }
        } catch (error) {
          console.warn(`[findParentByNewTaskInstructions] ⚠️ Erreur scan ${tasksPath}:`, error);
        }
      }

      // Obtenir la liste filtrée au lieu des conversations complètes
      const allConversations = potentialParents;
      
      // Trier par proximité temporelle (plus récentes d'abord)
      potentialParents.sort((a, b) =>
        new Date(b.metadata.createdAt).getTime() - new Date(a.metadata.createdAt).getTime()
      );

      console.log(`[findParentByNewTaskInstructions] 📊 ${potentialParents.length} parents candidats à analyser`);

      // Analyser chaque parent candidat
      for (const parentCandidate of potentialParents) {
        const isMatch = await this.analyzeParentForNewTaskInstructions(parentCandidate, childTask);
        if (isMatch) {
          return parentCandidate.taskId;
        }
      }

      console.log(`[findParentByNewTaskInstructions] ❌ Aucun parent trouvé pour ${childTaskId}`);
      return undefined;
      
    } catch (error) {
      console.error(`[findParentByNewTaskInstructions] ❌ Erreur:`, error);
      return undefined;
    }
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
   * 💾 MÉTHODE HÉRITÉE : Ancienne logique d'inférence pour fallback
   * Renommée pour clarifier son rôle de fallback
   */
  private static async legacyInferParentFromChildContent(
    apiHistoryPath: string,
    uiMessagesPath: string
  ): Promise<string | undefined> {
    // 1. Essayer d'extraire depuis api_conversation_history.json
    if (existsSync(apiHistoryPath)) {
      const parentFromApi = await this.extractParentFromApiHistory(apiHistoryPath);
      if (parentFromApi) return parentFromApi;
    }

    // 2. Essayer d'extraire depuis ui_messages.json
    if (existsSync(uiMessagesPath)) {
      const parentFromUi = await this.extractParentFromUiMessages(uiMessagesPath);
      if (parentFromUi) return parentFromUi;
    }

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
    uiMessagesPath: string
  ): Promise<(MessageSkeleton | ActionMetadata)[]> {
    let combinedItems: any[] = [];
    const MAX_CONTENT_LENGTH = 400;

    // Helper pour lire et parser un fichier JSON en toute sécurité
    const readJsonFile = async (filePath: string): Promise<any[]> => {
        if (!existsSync(filePath)) return [];
        try {
            let content = await fs.readFile(filePath, 'utf-8');
            if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);

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