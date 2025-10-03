/**
 * MessageToSkeletonTransformer - Phase 2a
 * 
 * Transforme les messages UI désérialisés en ConversationSkeleton
 * Compatible avec le système de cache existant
 * 
 * Architecture: docs/architecture/message-to-skeleton-transformer.md
 */

import { UIMessage, ToolCallInfo, ApiReqInfo, NewTaskInfo } from './message-types.js';
import { UIMessagesDeserializer } from './ui-messages-deserializer.js';
import { ConversationSkeleton } from '../types/conversation.js';
import { computeInstructionPrefix } from './task-instruction-index.js';
import { WorkspaceDetector } from './workspace-detector.js';

/**
 * Options de configuration du transformer
 */
export interface TransformerOptions {
  /** Normaliser les prefixes pour RadixTree */
  normalizePrefixes?: boolean;
  /** Inclure les métadonnées additionnelles */
  includeMetadata?: boolean;
  /** Mode strict de validation */
  strictValidation?: boolean;
}

/**
 * Résultat de la transformation avec métadonnées
 */
export interface TransformationResult {
  skeleton: ConversationSkeleton;
  metadata: {
    messageCount: number;
    userMessageCount: number;
    toolCallCount: number;
    newTaskCount: number;
    hasInitialInstruction: boolean;
    processingTimeMs: number;
  };
}

/**
 * Transforme les messages UI en skeleton de conversation
 * Compatible avec le système de cache existant
 */
export class MessageToSkeletonTransformer {
  private deserializer: UIMessagesDeserializer;
  private workspaceDetector: WorkspaceDetector;
  private options: Required<TransformerOptions>;

  constructor(options: TransformerOptions = {}) {
    this.deserializer = new UIMessagesDeserializer();
    this.workspaceDetector = new WorkspaceDetector({
      enableCache: true,
      validateExistence: false, // Pour performance
      normalizePaths: true,
    });
    this.options = {
      normalizePrefixes: options.normalizePrefixes ?? true,
      includeMetadata: options.includeMetadata ?? false,
      strictValidation: options.strictValidation ?? false,
    };
  }

  /**
   * Transforme les messages en skeleton avec auto-détection du workspace
   */
  async transform(
    messages: UIMessage[],
    taskId: string,
    workspace?: string
  ): Promise<TransformationResult> {
    const startTime = Date.now();
    
    // 1. Auto-détection du workspace si pas fourni
    const detectedWorkspace = workspace || await this.autoDetectWorkspace(messages);
    
    // 2. Extraire les données structurées
    const toolCalls = this.deserializer.extractToolCalls(messages);
    const newTasks = this.deserializer.extractNewTasks(messages);
    const apiReqs = this.deserializer.extractApiRequests(messages);
    const userMessages = this.extractUserMessages(messages);

    // 3. Construire l'instruction principale
    const { instruction, truncatedInstruction } = this.buildMainInstruction(
      messages,
      apiReqs
    );

    // 4. Construire les prefixes de sous-tâches
    const childTaskInstructionPrefixes = this.buildChildTaskPrefixes(newTasks);

    // 5. Détecter la complétion
    const isCompleted = this.detectCompletion(messages, toolCalls);

    // 6. Calculer les timestamps
    const { startedAt, completedAt } = this.extractTimestamps(messages, isCompleted);

    // 7. Construire le skeleton
    const skeleton: ConversationSkeleton = {
      taskId,
      sequence: [], // Simplifié pour Phase 2a
      metadata: {
        workspace: detectedWorkspace || undefined,
        createdAt: new Date(startedAt).toISOString(),
        lastActivity: new Date(completedAt || startedAt).toISOString(),
        messageCount: messages.length,
        actionCount: toolCalls.length,
        totalSize: JSON.stringify(messages).length,
      },
      childTaskInstructionPrefixes: childTaskInstructionPrefixes.length > 0 
        ? childTaskInstructionPrefixes 
        : undefined,
      truncatedInstruction: instruction,
      isCompleted,
    };

    // 7. Valider si mode strict
    if (this.options.strictValidation) {
      this.validateSkeletonCompatibility(skeleton);
    }

    // 8. Construire le résultat avec métadonnées
    const result: TransformationResult = {
      skeleton,
      metadata: {
        messageCount: messages.length,
        userMessageCount: userMessages.length,
        toolCallCount: toolCalls.length,
        newTaskCount: newTasks.length,
        hasInitialInstruction: !!instruction,
        processingTimeMs: Date.now() - startTime,
      },
    };

    return result;
  }

  /**
   * Extrait les messages utilisateur (type: 'ask', sans ask: 'tool')
   */
  private extractUserMessages(messages: UIMessage[]): UIMessage[] {
    return messages.filter(
      m => m.type === 'ask' && m.ask !== 'tool' && m.text
    );
  }

  /**
   * Construit l'instruction principale de la tâche
   */
  private buildMainInstruction(
    messages: UIMessage[],
    apiReqs: ApiReqInfo[]
  ): { instruction: string; truncatedInstruction: boolean } {
    // Stratégie 1 : Premier api_req_started avec request
    const firstApiReq = apiReqs.find(req => req.request);
    if (firstApiReq?.request) {
      // Extraire le contenu de <task>...</task>
      const taskMatch = firstApiReq.request.match(/<task>([\s\S]*?)<\/task>/i);
      if (taskMatch) {
        const rawInstruction = taskMatch[1].trim();
        const normalized = this.options.normalizePrefixes
          ? computeInstructionPrefix(rawInstruction, 192)
          : rawInstruction.substring(0, 192);
        
        return {
          instruction: normalized,
          truncatedInstruction: false,
        };
      }
    }

    // Stratégie 2 : Premier message utilisateur
    const userMessages = this.extractUserMessages(messages);
    if (userMessages.length > 0 && userMessages[0].text) {
      const rawInstruction = userMessages[0].text;
      const normalized = this.options.normalizePrefixes
        ? computeInstructionPrefix(rawInstruction, 192)
        : rawInstruction.substring(0, 192);
      
      return {
        instruction: normalized,
        truncatedInstruction: false,
      };
    }

    // Fallback : Pas d'instruction trouvée
    return {
      instruction: '',
      truncatedInstruction: true,
    };
  }

  /**
   * Construit les prefixes normalisés pour les sous-tâches
   */
  private buildChildTaskPrefixes(newTasks: NewTaskInfo[]): string[] {
    if (newTasks.length === 0) return [];

    const prefixes = newTasks
      .map(task => {
        if (this.options.normalizePrefixes) {
          // Normalisation active : utiliser computeInstructionPrefix qui tronque à 192
          return computeInstructionPrefix(task.message, 192);
        } else {
          // Normalisation désactivée : garder le texte brut sans troncature
          // La validation stricte détectera les préfixes trop longs
          return task.message.trim();
        }
      })
      .filter(prefix => prefix.length > 0); // Éliminer les prefixes vides

    // Dédupliquer
    return [...new Set(prefixes)];
  }

  /**
   * Détecte si la tâche est complétée
   */
  private detectCompletion(
    messages: UIMessage[],
    toolCalls: ToolCallInfo[]
  ): boolean {
    // Critère 1 : Présence d'un attempt_completion
    const hasCompletion = toolCalls.some(
      tool => tool.tool === 'attempt_completion'
    );
    if (hasCompletion) return true;

    // Critère 2 : Dernier message est un 'say' de type final
    const lastMessage = messages[messages.length - 1];
    if (lastMessage?.type === 'say') {
      const finalSayTypes = ['completion_result', 'error', 'user_feedback'];
      return finalSayTypes.includes(lastMessage.say || '');
    }

    return false;
  }

  /**
   * Extrait les timestamps de début et fin
   */
  private extractTimestamps(
    messages: UIMessage[],
    isCompleted: boolean
  ): { startedAt: number; completedAt: number | null } {
    if (messages.length === 0) {
      return { startedAt: Date.now(), completedAt: null };
    }

    const startedAt = messages[0].ts;
    const completedAt = isCompleted ? messages[messages.length - 1].ts : null;

    return { startedAt, completedAt };
  }

  /**
   * Valide la compatibilité du skeleton avec le système existant
   */
  private validateSkeletonCompatibility(skeleton: ConversationSkeleton): void {
    // Validation 1 : taskId requis
    if (!skeleton.taskId) {
      throw new Error('Skeleton validation failed: taskId is required');
    }

    // Validation 2 : createdAt valide
    if (!skeleton.metadata.createdAt) {
      throw new Error('Skeleton validation failed: invalid createdAt timestamp');
    }

    // Validation 3 : lastActivity cohérent
    const createdAt = new Date(skeleton.metadata.createdAt).getTime();
    const lastActivity = new Date(skeleton.metadata.lastActivity).getTime();
    if (lastActivity < createdAt) {
      throw new Error('Skeleton validation failed: lastActivity before createdAt');
    }

    // Validation 4 : isCompleted cohérent
    if (skeleton.isCompleted && !skeleton.metadata.lastActivity) {
      throw new Error('Skeleton validation failed: isCompleted but no lastActivity');
    }

    // Validation 5 : Prefixes valides
    if (skeleton.childTaskInstructionPrefixes) {
      if (skeleton.childTaskInstructionPrefixes.some(p => p.length === 0)) {
        throw new Error('Skeleton validation failed: empty prefix detected');
      }
      if (skeleton.childTaskInstructionPrefixes.some(p => p.length > 192)) {
        throw new Error('Skeleton validation failed: prefix exceeds 192 chars');
      }
    }

    // Validation 6 : truncatedInstruction valide
    if (skeleton.truncatedInstruction && skeleton.truncatedInstruction.length > 192) {
      throw new Error('Skeleton validation failed: truncatedInstruction exceeds 192 chars');
    }
  }

  /**
   * Auto-détection du workspace depuis les messages UI
   * Utilise la stratégie dual du WorkspaceDetector sans filesystem
   */
  private async autoDetectWorkspace(messages: UIMessage[]): Promise<string | null> {
    try {
      // Parcourir les messages pour chercher des environment_details
      for (const message of messages) {
        let textContent = '';
        
        // Extraire le texte selon le type de message
        if (message.type === 'say' && typeof message.text === 'string') {
          textContent = message.text;
        } else if (message.type === 'ask' && typeof message.text === 'string') {
          textContent = message.text;
        }

        if (!textContent) {
          continue;
        }

        // Chercher le pattern "Current Workspace Directory"
        const workspaceMatch = textContent.match(/# Current Workspace Directory \(([^)]+)\) Files/i);
        if (workspaceMatch && workspaceMatch[1]) {
          const workspace = workspaceMatch[1].trim();
          
          // Validation basique du chemin
          if (this.isValidWorkspacePath(workspace)) {
            return workspace;
          }
        }
      }

      return null;
    } catch (error) {
      console.warn('[MessageToSkeletonTransformer] Erreur auto-détection workspace:', error);
      return null;
    }
  }

  /**
   * Validation basique du format d'un chemin workspace
   */
  private isValidWorkspacePath(workspace: string): boolean {
    if (!workspace || workspace.length < 3) {
      return false;
    }

    // Patterns valides: C:/, d:/, /home/, ./relative, etc.
    const validPathPatterns = [
      /^[a-zA-Z]:[\/\\]/,    // Windows: C:/ ou D:\
      /^\/[^\/]/,           // Unix: /home, /usr, etc.
      /^\.{1,2}[\/\\]/,     // Relatif: ./ ou ../
    ];

    return validPathPatterns.some(pattern => pattern.test(workspace));
  }
}