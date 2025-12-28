/**
 * Extracteur pour les messages API (api_conversation_history.json)
 * Gère les patterns spécifiques aux messages de type API
 */

import { PatternExtractor, createInstruction, extractTimestamp } from '../message-pattern-extractors.js';
import { NewTaskInstruction } from '../../types/conversation.js';

/**
 * Extracteur pour les messages API avec champ content
 */
export class ApiContentExtractor implements PatternExtractor {
  canHandle(message: any): boolean {
    return message.type === 'api_req_started' && 
           message.content && 
           typeof message.content === 'object' &&
           message.content.tool === 'newTask';
  }

  extract(message: any): NewTaskInstruction[] {
    const instructions: NewTaskInstruction[] = [];
    
    try {
      // 🎯 CORRECTION SDDD: Validation explicite du contenu pour générer une erreur si invalide
      if (!message.content || typeof message.content !== 'object') {
        throw new Error('Invalid message content structure');
      }
      
      const content = message.content.content || message.content.message;
      if (!content || typeof content !== 'string') {
        throw new Error('Invalid content in message');
      }
      
      const instruction = createInstruction(
        extractTimestamp(message),
        message.content.mode || 'task',
        content,
        20
      );
      
      if (instruction) {
        instructions.push(instruction);
        this.debugLog('API content', instruction.mode, instruction.message.length);
      }
    } catch (error) {
      this.debugError('API content', error);
      // 🎯 CORRECTION SDDD: Relancer l'erreur pour qu'elle soit capturée par le coordinateur
      throw error;
    }
    
    return instructions;
  }

  getPatternName(): string {
    return 'API Content Extractor';
  }

  private debugLog(source: string, mode: string, length: number): void {
    if (process.env.ROO_DEBUG_INSTRUCTIONS === '1') {
      console.log(`[extractFromMessageFile] ✅ ${source}: mode=${mode}, len=${length}`);
    }
  }

  private debugError(source: string, error: any): void {
    if (process.env.ROO_DEBUG_INSTRUCTIONS === '1') {
      console.log(`[extractFromMessageFile] ⚠️ Failed to parse ${source} message:`, error);
    }
  }
}

/**
 * Extracteur pour les messages API avec champ text (JSON string)
 */
export class ApiTextExtractor implements PatternExtractor {
  canHandle(message: any): boolean {
    return (message.type === 'api_req_started' || (message.type === 'say' && message.say === 'api_req_started')) &&
           typeof message.text === 'string';
  }

  extract(message: any): NewTaskInstruction[] {
    const instructions: NewTaskInstruction[] = [];
    
    try {
      const toolData = JSON.parse(message.text);
      
      // Support pour le format direct {request: "..."} dans ui_messages.json
      if (toolData.request && typeof toolData.request === 'string') {
        // Essayer d'extraire le pattern [new_task in X: 'Y'] depuis la requête
        const pattern = /\[new_task in ([^:]+):\s*['"](.+?)['"]\]/s;
        const match = toolData.request.match(pattern);
        
        if (match) {
          const mode = match[1].trim();
          const content = match[2].trim();
          
          const instruction = createInstruction(
            extractTimestamp(message),
            mode,
            content,
            20
          );
          
          if (instruction) {
            instructions.push(instruction);
            this.debugLog('API text (request)', instruction.mode, instruction.message.length);
          }
        }
      } else if (toolData && toolData.tool === 'newTask') {
        const instruction = createInstruction(
          extractTimestamp(message),
          toolData.mode || 'task',
          toolData.content || toolData.message,
          20
        );
        
        if (instruction) {
          instructions.push(instruction);
          this.debugLog('API text', instruction.mode, instruction.message.length);
        }
      }
    } catch (error) {
      this.debugError('API text', error);
    }
    
    return instructions;
  }

  getPatternName(): string {
    return 'API Text Extractor';
  }

  private debugLog(source: string, mode: string, length: number): void {
    if (process.env.ROO_DEBUG_INSTRUCTIONS === '1') {
      console.log(`[extractFromMessageFile] ✅ ${source}: mode=${mode}, len=${length}`);
    }
  }

  private debugError(source: string, error: any): void {
    if (process.env.ROO_DEBUG_INSTRUCTIONS === '1') {
      console.log(`[extractFromMessageFile] ⚠️ Failed to parse ${source} message:`, error);
    }
  }
}