/**
 * Extracteur pour les messages UI (ui_messages.json)
 * Gère les patterns spécifiques aux messages de type UI
 */

import { PatternExtractor, createInstruction, extractTimestamp } from '../message-pattern-extractors.js';
import { NewTaskInstruction } from '../../types/conversation.js';

/**
 * Extracteur pour les messages UI avec champ ask/tool
 */
export class UiAskToolExtractor implements PatternExtractor {
  canHandle(message: any): boolean {
    return message.type === 'ask' && 
           message.ask === 'tool' && 
           typeof message.text === 'string';
  }

  extract(message: any): NewTaskInstruction[] {
    const instructions: NewTaskInstruction[] = [];
    
    try {
      const toolData = JSON.parse(message.text);
      
      if (toolData && toolData.tool === 'newTask') {
        const instruction = createInstruction(
          extractTimestamp(message),
          toolData.mode || 'task',
          toolData.content,
          20
        );
        
        if (instruction) {
          instructions.push(instruction);
          this.debugLog('UI ask/tool', instruction.mode, instruction.message.length);
        }
      }
    } catch (error) {
      this.debugError('UI ask/tool', error);
    }
    
    return instructions;
  }

  getPatternName(): string {
    return 'UI Ask/Tool Extractor';
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
 * Extracteur pour les messages UI avec objet direct dans text/content
 */
export class UiObjectExtractor implements PatternExtractor {
  canHandle(message: any): boolean {
    return (typeof message.text === 'object' || typeof message.content === 'object');
  }

  extract(message: any): NewTaskInstruction[] {
    const instructions: NewTaskInstruction[] = [];
    
    try {
      const obj = typeof message.text === 'object' && message.text
        ? message.text
        : (typeof message.content === 'object' && message.content ? message.content : null);
      
      if (obj && obj.tool === 'newTask') {
        const instruction = createInstruction(
          extractTimestamp(message),
          obj.mode || 'task',
          obj.content,
          20
        );
        
        if (instruction) {
          instructions.push(instruction);
          this.debugLog('UI object', instruction.mode, instruction.message.length);
        }
      }
    } catch (error) {
      this.debugError('UI object', error);
    }
    
    return instructions;
  }

  getPatternName(): string {
    return 'UI Object Extractor';
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
 * Extracteur pour les messages UI avec pattern XML/HTML
 */
export class UiXmlPatternExtractor implements PatternExtractor {
  canHandle(message: any): boolean {
    return message.type === 'tool_result' && 
           typeof message.content === 'string';
  }

  extract(message: any): NewTaskInstruction[] {
    const instructions: NewTaskInstruction[] = [];
    const contentText = message.content;
    
    if (!contentText) {
      return instructions;
    }

    try {
      // Pattern pour new_task avec balises fermées
      const newTaskPattern = /<new_task>\s*<mode>([^<]+)<\/mode>\s*<message>([^<]+)<\/message>\s*<\/new_task>/gi;
      let match;
      
      while ((match = newTaskPattern.exec(contentText)) !== null) {
        const mode = match[1].trim();
        const taskMessage = match[2].trim();
        
        const instruction = createInstruction(
          extractTimestamp(message),
          mode,
          taskMessage,
          10
        );
        
        if (instruction) {
          instructions.push(instruction);
          this.debugLog('UI XML closed', instruction.mode, instruction.message.length);
        }
      }
      
      // Pattern pour new_task avec balises non fermées (legacy)
      const unClosedNewTaskPattern = /<new_task>\s*<mode>([^<]+)<\/mode>\s*<message>([^<]+)<\/message>\s*$/gi;
      let unClosedMatch;
      
      while ((unClosedMatch = unClosedNewTaskPattern.exec(contentText)) !== null) {
        const mode = unClosedMatch[1].trim();
        const taskMessage = unClosedMatch[2].trim();
        
        const instruction = createInstruction(
          extractTimestamp(message),
          mode,
          taskMessage,
          10
        );
        
        if (instruction) {
          instructions.push(instruction);
          this.debugLog('UI XML unclosed', instruction.mode, instruction.message.length);
        }
      }
    } catch (error) {
      this.debugError('UI XML pattern', error);
    }
    
    return instructions;
  }

  getPatternName(): string {
    return 'UI XML Pattern Extractor';
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
 * Extracteur pour les messages UI legacy (tool_call)
 */
export class UiLegacyExtractor implements PatternExtractor {
  canHandle(message: any): boolean {
    return message.type === 'tool_call' && 
           message.content && 
           message.content.tool === 'new_task';
  }

  extract(message: any): NewTaskInstruction[] {
    const instructions: NewTaskInstruction[] = [];
    
    try {
      const instruction = createInstruction(
        extractTimestamp(message),
        message.content.mode || 'legacy',
        message.content.message || '',
        1 // Minimum plus bas pour le legacy
      );
      
      if (instruction) {
        instructions.push(instruction);
        this.debugLog('UI legacy', instruction.mode, instruction.message.length);
      }
    } catch (error) {
      this.debugError('UI legacy', error);
    }
    
    return instructions;
  }

  getPatternName(): string {
    return 'UI Legacy Extractor';
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