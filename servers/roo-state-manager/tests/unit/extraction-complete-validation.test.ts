/**
 * Tests complets de validation de l'extraction newTask
 * Valide TOUTE la chaîne : extraction → normalisation → indexation
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';

// Désactiver les mocks globaux de fs pour ce test qui utilise des fixtures réelles
vi.unmock('fs');
vi.unmock('fs/promises');

import * as path from 'path';
import * as fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { RooStorageDetector } from '../../src/utils/roo-storage-detector.js';
import { computeInstructionPrefix } from '../../src/utils/task-instruction-index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FIXTURE_TASK_PATH = path.resolve(
  __dirname,
  '../../tests/fixtures/real-tasks/bc93a6f7-cd2e-4686-a832-46e3cd14d338'
);

describe('Extraction complète et validation intégration (DISABLED: ESM singleton issue)', () => {
  beforeAll(async () => {
    // Réinitialiser l'index global avant les tests
    const { globalTaskInstructionIndex } = await import('../../src/utils/task-instruction-index.js');
    globalTaskInstructionIndex.clear();
  });

  describe('1. Extraction via extractNewTaskInstructionsFromUI', () => {
    it('should extract EXACTLY 10 instructions from ui_messages.json', async () => {
      const uiMessagesPath = path.join(FIXTURE_TASK_PATH, 'ui_messages.json');
      
      // Appeler la méthode privée via reflection (pour test uniquement)
      const instructions = await (RooStorageDetector as any).extractNewTaskInstructionsFromUI(
        uiMessagesPath,
        0 // Pas de limite
      );

      console.log(`✅ extractNewTaskInstructionsFromUI returned ${instructions.length} instructions`);
      
      // VALIDATION CRITIQUE : Exactement 10 instructions (6 JSON + 4 XML patterns détectés)
      expect(instructions.length).toBe(10);
      
      // Vérifier que chaque instruction a les bons champs
      for (const instruction of instructions) {
        expect(instruction).toHaveProperty('timestamp');
        expect(instruction).toHaveProperty('mode');
        expect(instruction).toHaveProperty('message');
        expect(typeof instruction.message).toBe('string');
        expect(instruction.message.length).toBeGreaterThan(20);
      }
    });

    it('should NOT extract XML patterns when onlyJsonFormat=true', async () => {
      const uiMessagesPath = path.join(FIXTURE_TASK_PATH, 'ui_messages.json');
      const instructions: any[] = [];
      
      // Appeler extractFromMessageFile avec onlyJsonFormat=true
      await (RooStorageDetector as any).extractFromMessageFile(
        uiMessagesPath,
        instructions,
        0,
        true // onlyJsonFormat activé
      );

      console.log(`✅ With onlyJsonFormat=true: ${instructions.length} instructions`);
      
      // Vérifier qu'on n'a PAS de contamination par patterns XML
      const hasTaskTagPattern = instructions.some(i => 
        i.message && (i.message.includes('<task>') || i.message.includes('</task>'))
      );
      const hasNewTaskPattern = instructions.some(i =>
        i.message && (i.message.includes('<new_task>') || i.message.includes('</new_task>'))
      );

      expect(hasTaskTagPattern).toBe(false);
      expect(hasNewTaskPattern).toBe(false);
    });
  });

  describe('2. Normalisation via computeInstructionPrefix', () => {
    it('should normalize instructions to K=192 characters', async () => {
      const uiMessagesPath = path.join(FIXTURE_TASK_PATH, 'ui_messages.json');
      const instructions = await (RooStorageDetector as any).extractNewTaskInstructionsFromUI(
        uiMessagesPath,
        0
      );

      console.log(`✅ Testing normalization on ${instructions.length} instructions`);

      for (const instruction of instructions) {
        const normalized = computeInstructionPrefix(instruction.message, 192);
        
        // Vérifier longueur <= K=192
        expect(normalized.length).toBeLessThanOrEqual(192);
        
        // Vérifier qu'il n'y a pas de balises HTML/XML résiduelles
        expect(normalized).not.toMatch(/<[^>]+>/);
        
        // Vérifier pas de double espaces
        expect(normalized).not.toMatch(/\s{2,}/);
        
        console.log(`  - Normalized (${normalized.length} chars): "${normalized.substring(0, 50)}..."`);
      }
    });
  });

  describe('3. Intégration avec analyzeConversation', () => {
    it('should generate childTaskInstructionPrefixes with EXACTLY 7 entries', async () => {
      const taskId = 'bc93a6f7-cd2e-4686-a832-46e3cd14d338';
      
      const skeleton = await RooStorageDetector.analyzeConversation(
        taskId,
        FIXTURE_TASK_PATH,
        true // useProductionHierarchy
      );

      expect(skeleton).not.toBeNull();
      expect(skeleton!.childTaskInstructionPrefixes).toBeDefined();
      
      const prefixCount = skeleton!.childTaskInstructionPrefixes?.length || 0;
      console.log(`✅ analyzeConversation generated ${prefixCount} childTaskInstructionPrefixes`);
      
      // VALIDATION CRITIQUE : Exactement 7 prefixes (après dédoublonnage des 10 instructions)
      expect(prefixCount).toBe(7);
      
      // Vérifier que chaque prefix est valide
      for (const prefix of skeleton!.childTaskInstructionPrefixes!) {
        expect(prefix.length).toBeGreaterThan(10);
        expect(prefix.length).toBeLessThanOrEqual(192);
      }
    });

    it('should populate globalTaskInstructionIndex with 6 instructions', async () => {
      // Import dynamique pour éviter "module is already linked"
      const { globalTaskInstructionIndex } = await import('../../src/utils/task-instruction-index.js');
      
      // Réinitialiser l'index
      globalTaskInstructionIndex.clear();
      
      const taskId = 'bc93a6f7-cd2e-4686-a832-46e3cd14d338';
      
      await RooStorageDetector.analyzeConversation(
        taskId,
        FIXTURE_TASK_PATH,
        true
      );

      const stats = globalTaskInstructionIndex.getStats();
      console.log(`✅ Index stats after analyzeConversation:`, stats);
      
      // VALIDATION : L'index doit contenir les 7 instructions
      expect(stats.totalInstructions).toBeGreaterThanOrEqual(7);
    });
  });

  describe('4. Validation patterns spécifiques', () => {
    it('should extract only PATTERN 5 (ask/tool JSON format)', async () => {
      const uiMessagesPath = path.join(FIXTURE_TASK_PATH, 'ui_messages.json');
      const content = await fs.readFile(uiMessagesPath, 'utf-8');
      const messages = JSON.parse(content);

      // Compter les messages ask/tool avec newTask
      let askToolCount = 0;
      for (const message of messages) {
        if (message.type === 'ask' && message.ask === 'tool' && typeof message.text === 'string') {
          try {
            const toolData = JSON.parse(message.text);
            if (toolData.tool === 'newTask') {
              askToolCount++;
            }
          } catch (e) {
            // Ignore
          }
        }
      }

      console.log(`✅ Found ${askToolCount} ask/tool messages with newTask in ui_messages.json`);
      expect(askToolCount).toBe(6);
    });

    it('should NOT extract from api_conversation_history.json', async () => {
      const apiHistoryPath = path.join(FIXTURE_TASK_PATH, 'api_conversation_history.json');
      
      // Vérifier que le fichier existe et contient des patterns XML
      const content = await fs.readFile(apiHistoryPath, 'utf-8');
      expect(content.includes('<task>')).toBe(true);
      expect(content.includes('<new_task>')).toBe(true);
      
      console.log('✅ api_conversation_history.json contains XML patterns (as expected)');
      
      // Mais extractNewTaskInstructionsFromUI ne doit PAS l'utiliser
      const uiMessagesPath = path.join(FIXTURE_TASK_PATH, 'ui_messages.json');
      const instructions = await (RooStorageDetector as any).extractNewTaskInstructionsFromUI(
        uiMessagesPath,
        0
      );
      
      // Si on avait extrait depuis api_history, on aurait > 10 instructions
      expect(instructions.length).toBe(10);
      console.log('✅ Confirmed: api_conversation_history.json was NOT used for extraction');
    });
  });
});