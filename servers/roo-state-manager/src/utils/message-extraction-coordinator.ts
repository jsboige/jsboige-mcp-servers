/**
 * Coordinateur d'extraction de messages
 * Orchestre les différents extracteurs de patterns de manière modulaire
 */

import { PatternExtractor } from './message-pattern-extractors.js';
import { NewTaskInstruction } from '../types/conversation.js';

// Import des extracteurs API
import { ApiContentExtractor } from './extractors/api-message-extractor.js';
import { ApiTextExtractor } from './extractors/api-message-extractor.js';

// Import des extracteurs UI
import { UiAskToolExtractor } from './extractors/ui-message-extractor.js';
import { UiObjectExtractor } from './extractors/ui-message-extractor.js';
import { UiXmlPatternExtractor } from './extractors/ui-message-extractor.js';
import { UiSimpleTaskExtractor } from './extractors/ui-message-extractor.js';
import { UiLegacyExtractor } from './extractors/ui-message-extractor.js';

/**
 * Options pour l'extraction de messages
 */
export interface MessageExtractionOptions {
  maxLines?: number;
  onlyJsonFormat?: boolean;
  enableDebug?: boolean;
}

/**
 * Résultat de l'extraction avec métadonnées
 */
export interface ExtractionResult {
  instructions: NewTaskInstruction[];
  processedMessages: number;
  matchedPatterns: string[];
  errors: string[];
}

/**
 * Coordinateur principal pour l'extraction d'instructions depuis les messages
 */
export class MessageExtractionCoordinator {
  private extractors: PatternExtractor[] = [];
  private debugEnabled: boolean = false;

  constructor() {
    this.initializeExtractors();
    this.debugEnabled = process.env.ROO_DEBUG_INSTRUCTIONS === '1';
  }

  /**
   * Extrait les instructions d'un tableau de messages
   */
  extractFromMessages(
    messages: any[],
    options: MessageExtractionOptions = {}
  ): ExtractionResult {
    // Force debug for diagnosis
    if (process.env.ROO_DEBUG_INSTRUCTIONS === '1') {
        this.debugEnabled = true;
        console.log(`[MessageExtractionCoordinator] Processing ${messages.length} messages with ${this.extractors.length} extractors`);
    }

    const result: ExtractionResult = {
      instructions: [],
      processedMessages: 0,
      matchedPatterns: [],
      errors: []
    };

    try {
      for (const message of messages) {
        this.processMessage(message, result, options);
        result.processedMessages++;
      }

      this.logExtractionSummary(result);
    } catch (error) {
      result.errors.push(`Global extraction error: ${error}`);
      this.logError('Global extraction', error);
    }

    return result;
  }

  /**
   * Extrait les instructions d'un message unique
   */
  extractFromMessage(
    message: any,
    options: MessageExtractionOptions = {}
  ): ExtractionResult {
    const result: ExtractionResult = {
      instructions: [],
      processedMessages: 1,
      matchedPatterns: [],
      errors: []
    };

    this.processMessage(message, result, options);
    this.logExtractionSummary(result);

    return result;
  }

  /**
   * Initialise tous les extracteurs disponibles
   */
  private initializeExtractors(): void {
    this.extractors = [
      // Extracteurs API (priorité haute)
      new ApiContentExtractor(),
      new ApiTextExtractor(),

      // Extracteurs UI
      new UiAskToolExtractor(),
      new UiObjectExtractor(),
      new UiXmlPatternExtractor(),
      new UiSimpleTaskExtractor(),
      new UiLegacyExtractor()
    ];

    if (this.debugEnabled) {
      console.log(`[MessageExtractionCoordinator] Initialized ${this.extractors.length} extractors`);
    }
  }

  /**
   * Traite un message individuel avec tous les extracteurs
   */
  private processMessage(
    message: any,
    result: ExtractionResult,
    options: MessageExtractionOptions
  ): void {
    let matched = false;

    for (const extractor of this.extractors) {
      try {
        if (extractor.canHandle(message)) {
          const instructions = extractor.extract(message);

          if (instructions.length > 0) {
            result.instructions.push(...instructions);
            result.matchedPatterns.push(extractor.getPatternName());
            matched = true;

            if (this.debugEnabled) {
              console.log(`[MessageExtractionCoordinator] ✅ ${extractor.getPatternName()} matched: ${instructions.length} instructions`);
            }

            // 🎯 CORRECTION SDDD: Arrêter après le premier extracteur qui trouve des instructions
            // pour éviter les doublons et respecter les attentes des tests
            break;
          }
        }
      } catch (error) {
        const errorMsg = `${extractor.getPatternName()} error: ${error}`;
        result.errors.push(errorMsg);
        this.logError(extractor.getPatternName(), error);
      }
    }

    if (!matched && this.debugEnabled) {
      console.log(`[MessageExtractionCoordinator] ⚪ No extractor matched for message type: ${message.type}`);
    }
  }

  /**
   * Affiche le résumé de l'extraction
   */
  private logExtractionSummary(result: ExtractionResult): void {
    if (!this.debugEnabled) {
      return;
    }

    console.log(`[MessageExtractionCoordinator] 📊 Extraction Summary:`);
    console.log(`  - Messages processed: ${result.processedMessages}`);
    console.log(`  - Instructions found: ${result.instructions.length}`);
    console.log(`  - Patterns matched: ${result.matchedPatterns.join(', ')}`);
    console.log(`  - Errors: ${result.errors.length}`);

    if (result.errors.length > 0) {
      console.log(`  - Error details:`, result.errors);
    }
  }

  /**
   * Affiche les erreurs de manière contrôlée
   */
  private logError(context: string, error: any): void {
    if (this.debugEnabled) {
      console.error(`[MessageExtractionCoordinator] ❌ ${context} error:`, error);
    }
  }

  /**
   * Retourne la liste des extracteurs disponibles (pour debugging)
   */
  getAvailableExtractors(): string[] {
    return this.extractors.map(extractor => extractor.getPatternName());
  }

  /**
   * Active/désactive le mode debug
   */
  setDebugEnabled(enabled: boolean): void {
    this.debugEnabled = enabled;
  }
}

/**
 * Instance singleton du coordinateur
 */
export const messageExtractionCoordinator = new MessageExtractionCoordinator();