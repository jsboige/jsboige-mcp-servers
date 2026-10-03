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
  patterns?: string[];
  minLength?: number;
  maxLength?: number;
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

    this.debugEnabled = options.enableDebug || false;
    
    // Debug forcer pour voir les messages
    if (this.debugEnabled) {
      console.log(`[MessageExtractionCoordinator] 🚀 DÉMARRAGE extraction avec ${messages.length} messages`);
      console.log(`[MessageExtractionCoordinator] 📋 Extracteurs disponibles: ${this.extractors.map(e => e.getPatternName()).join(', ')}`);
    }

    try {
      for (const message of messages) {
        if (this.debugEnabled) {
          console.log(`[MessageExtractionCoordinator] 🔍 Traitement message: type=${message.type}, role=${message.role}, text=${typeof message.text === 'string' ? message.text.substring(0, 50) + '...' : 'N/A'}`);
        }
        this.processMessage(message, result, options);
        result.processedMessages++;
      }

      // #4037 : une même délégation est enregistrée deux fois dans ui_messages.json —
      // l'appel d'outil (ask/tool newTask, enregistrement faisant foi) puis l'écho
      // `[new_task in X mode: '...']` dans la requête API suivante. Dédupe sur
      // (mode, message) en gardant la PREMIÈRE occurrence : l'appel d'outil précède
      // toujours son écho dans le fichier.
      result.instructions = MessageExtractionCoordinator.dedupeInstructions(result.instructions);

      this.logExtractionSummary(result);
    } catch (error) {
      result.errors.push(`Global extraction error: ${error}`);
      this.logError('Global extraction', error);
    }

    return result;
  }

  /**
   * Dédupe les instructions par (mode, message) en conservant la première occurrence.
   * Les deux occurrences d'une même délégation passent par createInstruction (même
   * normalisation, même troncature), donc l'appel d'outil et son écho produisent des
   * clés identiques — ce qui est exactement ce que le squelette dédupliquait déjà
   * au niveau préfixe (childTaskInstructionPrefixes est un Set).
   */
  private static dedupeInstructions(instructions: NewTaskInstruction[]): NewTaskInstruction[] {
    const seen = new Set<string>();
    const deduped: NewTaskInstruction[] = [];
    for (const instruction of instructions) {
      const key = `${instruction.mode}\u0000${instruction.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(instruction);
    }
    return deduped;
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

      // Extracteurs UI - Ordre optimisé pour les tests
      new UiSimpleTaskExtractor(), // Premier pour les balises <task> simples
      new UiXmlPatternExtractor(), // Pour les balises <new_task>
      new UiAskToolExtractor(), // Pour les messages ask/tool
      new UiObjectExtractor(), // Pour les objets JSON
      new UiLegacyExtractor() // Pour les messages legacy
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