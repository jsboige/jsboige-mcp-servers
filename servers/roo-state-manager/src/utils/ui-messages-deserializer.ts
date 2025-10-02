import * as fs from 'fs/promises';
import {
  UIMessage,
  ToolCallInfo,
  ApiReqInfo,
  NewTaskInfo,
  ToolMessage
} from './message-types.js';

/**
 * Désérialise les fichiers ui_messages.json de manière sécurisée
 * 
 * Inspiré de roo-code/src/core/task-persistence/taskMessages.ts
 * Documentation: docs/roo-code/ui-messages-deserialization.md lignes 47-85
 * 
 * Approche:
 * - JSON.parse() direct (pas de regex fragile)
 * - safeJsonParse() pour JSON imbriqué dans champ text
 * - Types stricts basés sur roo-code
 * - Gestion d'erreurs robuste
 */
export class UIMessagesDeserializer {
  /**
   * Parse JSON sécurisé avec fallback
   * Inspiré de roo-code/src/shared/safeJsonParse.ts lignes 73-84
   * 
   * @param jsonString - Chaîne JSON à parser
   * @param defaultValue - Valeur par défaut si parsing échoue
   * @returns Objet parsé ou defaultValue
   */
  safeJsonParse<T>(jsonString: string | null | undefined, defaultValue?: T): T | undefined {
    if (!jsonString) {
      return defaultValue;
    }
    
    try {
      return JSON.parse(jsonString) as T;
    } catch (error) {
      console.error('JSON parse error:', error);
      return defaultValue;
    }
  }

  /**
   * Lit ui_messages.json et retourne tableau de messages
   * Inspiré de roo-code/src/core/task-persistence/taskMessages.ts lignes 49-62
   * 
   * IMPORTANT: Cette méthode charge le fichier complet en mémoire.
   * Pour les gros fichiers (>100MB), utiliser une approche streaming externe.
   * 
   * @param uiMessagesPath - Chemin vers ui_messages.json
   * @returns Tableau de messages UI
   */
  async readTaskMessages(uiMessagesPath: string): Promise<UIMessage[]> {
    try {
      // Vérifier existence du fichier
      const fileExists = await fs.access(uiMessagesPath)
        .then(() => true)
        .catch(() => false);
      
      if (!fileExists) {
        return [];
      }

      // Lire et parser le fichier
      const content = await fs.readFile(uiMessagesPath, 'utf8');
      const parsed = JSON.parse(content);
      
      // Retourner tableau (gérer cas où parsed n'est pas un array)
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      console.error(`Error reading ${uiMessagesPath}:`, error);
      return [];
    }
  }

  /**
   * Extrait les tool calls depuis les messages ask:tool
   * Documentation: docs/roo-code lignes 339-344
   * 
   * Filtre les messages avec ask='tool' et parse le JSON dans text
   * 
   * @param messages - Tableau de messages UI
   * @returns Tableau de tool calls
   */
  extractToolCalls(messages: UIMessage[]): ToolCallInfo[] {
    const results: ToolCallInfo[] = [];
    
    for (const m of messages) {
      if (m.ask === 'tool' && m.text) {
        const toolData = this.safeJsonParse<ToolMessage>(m.text);
        if (toolData?.tool) {
          results.push({
            tool: toolData.tool,
            mode: toolData.mode,
            // Supporter les deux champs: message ou content
            message: toolData.message || toolData.content,
            timestamp: m.ts
          });
        }
      }
    }
    
    return results;
  }

  /**
   * Extrait les API requests depuis les messages say:api_req_started
   * Documentation: docs/roo-code lignes 180-195
   * 
   * Ces messages contiennent des informations cruciales sur les requêtes:
   * - request: Contenu de la requête (peut contenir instructions newTask)
   * - cost: Coût estimé
   * - cancelReason: Raison d'annulation
   * 
   * @param messages - Tableau de messages UI
   * @returns Tableau d'informations API
   */
  extractApiRequests(messages: UIMessage[]): ApiReqInfo[] {
    return messages
      .filter(m => m.say === 'api_req_started' && m.text)
      .map(m => this.safeJsonParse<ApiReqInfo>(m.text!))
      .filter((item): item is ApiReqInfo => item !== null);
  }

  /**
   * Extrait les nouvelles tâches depuis tool:newTask
   * Documentation: docs/roo-code lignes 494-510
   * 
   * Approche recommandée roo-code (ligne 453-458):
   * - Pas de regex fragile
   * - Filtrage structuré par type
   * - Utilisation du système de types
   * 
   * @param messages - Tableau de messages UI
   * @returns Tableau d'instructions de nouvelles tâches
   */
  extractNewTasks(messages: UIMessage[]): NewTaskInfo[] {
    const toolCalls = this.extractToolCalls(messages);
    
    return toolCalls
      .filter(tool => tool.tool === 'new_task' && tool.mode && tool.message)
      .map(tool => ({
        mode: tool.mode!,
        message: tool.message!,
        timestamp: tool.timestamp
      }));
  }

  /**
   * Extrait les messages utilisateur (type: ask, pas d'ask spécifique)
   * Utile pour récupérer l'instruction initiale de la tâche
   * 
   * @param messages - Tableau de messages UI
   * @returns Tableau de messages utilisateur
   */
  extractUserMessages(messages: UIMessage[]): UIMessage[] {
    return messages.filter(m => m.type === 'ask' && !m.ask);
  }

  /**
   * Extrait les messages d'erreur
   * 
   * @param messages - Tableau de messages UI
   * @returns Tableau de messages d'erreur
   */
  extractErrors(messages: UIMessage[]): UIMessage[] {
    return messages.filter(m => m.say === 'error');
  }

  /**
   * Extrait le premier message utilisateur (instruction initiale)
   * Utile pour obtenir le contexte de démarrage d'une tâche
   * 
   * @param messages - Tableau de messages UI
   * @returns Premier message utilisateur ou undefined
   */
  getInitialInstruction(messages: UIMessage[]): string | undefined {
    const userMessages = this.extractUserMessages(messages);
    return userMessages.length > 0 ? userMessages[0].text : undefined;
  }

  /**
   * Compte les messages par type
   * Utile pour statistiques/diagnostics
   * 
   * @param messages - Tableau de messages UI
   * @returns Objet avec compteurs par type
   */
  getMessageStats(messages: UIMessage[]): {
    total: number;
    askMessages: number;
    sayMessages: number;
    toolCalls: number;
    apiRequests: number;
    newTasks: number;
    errors: number;
  } {
    return {
      total: messages.length,
      askMessages: messages.filter(m => m.type === 'ask').length,
      sayMessages: messages.filter(m => m.type === 'say').length,
      toolCalls: this.extractToolCalls(messages).length,
      apiRequests: this.extractApiRequests(messages).length,
      newTasks: this.extractNewTasks(messages).length,
      errors: this.extractErrors(messages).length,
    };
  }
}