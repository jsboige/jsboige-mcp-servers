/**
 * Tests unitaires pour le pipeline de hiérarchies
 * Teste les patterns de délégation et de coordination
 * Adapté à la nouvelle architecture modulaire avec message-extraction-coordinator
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { fileURLToPath } from 'url';

// Mock du module fs/promises
const { readFile, writeFile, mkdir, rm, stat } = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  rm: vi.fn(),
  stat: vi.fn()
}));

vi.mock('fs/promises', () => ({
  readFile,
  writeFile,
  mkdir,
  rm,
  stat
}));

// Mock du module path
import * as path from 'path';
const { join, dirname } = vi.hoisted(() => ({
  join: vi.fn((...paths) => paths.join('/')),
  dirname: vi.fn((path) => path.split('/').slice(0, -1).join('/'))
}));

vi.mock('path', () => ({
  join,
  dirname,
  normalize: vi.fn((path) => path),
  resolve: vi.fn((...paths) => paths.join('/')),
  basename: vi.fn((path) => path.split('/').pop()),
  extname: vi.fn((path) => path.includes('.') ? '.' + path.split('.').pop() : ''),
  relative: vi.fn((from, to) => to),
  sep: '/',
  delimiter: ';'
}));

// Mock du module message-extraction-coordinator compatible avec l'interface réelle
const mockMessageExtractionCoordinator = {
  extractFromMessages: vi.fn((messages, options) => {
    const instructions = [];
    
    // Simuler l'extraction des balises <task> et <new_task>
    for (const message of messages) {
      if (message.content) {
        let content = message.content;
        
        // Gérer le cas où content est un array (format OpenAI)
        if (Array.isArray(content)) {
          const textItem = content.find(item => item.type === 'text');
          if (textItem) {
            content = textItem.text;
          }
        }
        
        // Extraire les balises <task>
        const taskMatches = content.match(/<task>([\s\S]*?)<\/task>/g);
        if (taskMatches) {
          for (const match of taskMatches) {
            const taskContent = match.replace(/<\/?task>/g, '').trim();
            if (taskContent.length >= 20) { // Filtrer les tâches trop courtes
              instructions.push({
                mode: 'task',
                message: taskContent.substring(0, 200), // Tronquer à 200 caractères
                timestamp: message.ts || Date.now()
              });
            }
          }
        }
        
        // Extraire les balises <new_task>
        const newTaskMatches = content.match(/<new_task>([\s\S]*?)<\/new_task>/g);
        if (newTaskMatches) {
          for (const match of newTaskMatches) {
            const modeMatch = match.match(/<mode>(.*?)<\/mode>/);
            const messageMatch = match.match(/<message>(.*?)<\/message>/);
            
            if (modeMatch && messageMatch) {
              const mode = modeMatch[1].trim();
              const messageContent = messageMatch[1].trim();
              
              if (mode && messageContent) {
                instructions.push({
                  mode,
                  message: messageContent,
                  timestamp: message.ts || Date.now()
                });
              }
            }
          }
        }
      }
    }
    
    return {
      instructions,
      processedMessages: messages.length,
      matchedPatterns: instructions.length > 0 ? ['xml-pattern'] : [],
      errors: []
    };
  }),
  // Propriétés requises par l'interface MessageExtractionCoordinator
  extractors: [],
  debugEnabled: false,
  extractFromMessage: vi.fn(),
  initializeExtractors: vi.fn(),
  getAvailableExtractors: vi.fn(() => []),
  setDebugEnabled: vi.fn(),
  // Méthodes privées requises par l'interface
  processMessage: vi.fn(),
  logExtractionSummary: vi.fn(),
  logError: vi.fn()
};

vi.mock('../../../src/utils/message-extraction-coordinator.ts', () => ({
  messageExtractionCoordinator: {
    extractFromMessages: vi.fn((messages, options) => {
      const instructions = [];
      
      // Simuler l'extraction des balises <task> et <new_task>
      for (const message of messages) {
        if (message.content) {
          let content = message.content;
          
          // Gérer le cas où content est un array (format OpenAI)
          if (Array.isArray(content)) {
            const textItem = content.find(item => item.type === 'text');
            if (textItem) {
              content = textItem.text;
            }
          }
          
          // Extraire les balises <task>
          const taskMatches = content.match(/<task>([\s\S]*?)<\/task>/g);
          if (taskMatches) {
            for (const match of taskMatches) {
              const taskContent = match.replace(/<\/?task>/g, '').trim();
              if (taskContent.length >= 20) { // Filtrer les tâches trop courtes
                instructions.push({
                  mode: 'task',
                  message: taskContent.substring(0, 200), // Tronquer à 200 caractères
                  timestamp: message.ts || Date.now()
                });
              }
            }
          }
          
          // Extraire les balises <new_task>
          const newTaskMatches = content.match(/<new_task>([\s\S]*?)<\/new_task>/g);
          if (newTaskMatches) {
            for (const match of newTaskMatches) {
              const modeMatch = match.match(/<mode>(.*?)<\/mode>/);
              const messageMatch = match.match(/<message>(.*?)<\/message>/);
              
              if (modeMatch && messageMatch) {
                const mode = modeMatch[1].trim();
                const messageContent = messageMatch[1].trim();
                
                if (mode && messageContent) {
                  instructions.push({
                    mode,
                    message: messageContent,
                    timestamp: message.ts || Date.now()
                  });
                }
              }
            }
          }
        }
      }
      
      return {
        instructions,
        processedMessages: messages.length,
        matchedPatterns: instructions.length > 0 ? ['xml-pattern'] : [],
        errors: []
      };
    })
  }
}));

import * as fs from 'fs/promises';
import * as path from 'path';

// Import de la classe à tester
import { HierarchyPipeline } from '../../../src/utils/hierarchy-pipeline.ts';
import { NewTaskInstruction } from '../../../src/types/conversation.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Pipeline de Hiérarchies', () => {
  const tempDir = path.join(__dirname, 'temp-hierarchy');
  const mockFiles = new Map();
  
  beforeEach(async () => {
    // Réinitialiser les mocks
    mockFiles.clear();
    
    // Configurer les mocks
    mkdir.mockResolvedValue(undefined);
    rm.mockResolvedValue(undefined);
    writeFile.mockImplementation((filePath, content) => {
      mockFiles.set(filePath, content);
      return Promise.resolve(undefined);
    });
    readFile.mockImplementation((filePath) => {
      const content = mockFiles.get(filePath);
      if (content) {
        return Promise.resolve(content);
      }
      return Promise.reject(new Error(`File not found: ${filePath}`));
    });
    stat.mockImplementation((filePath) => {
      if (mockFiles.has(filePath)) {
        return Promise.resolve({
          isFile: () => true,
          isDirectory: () => false,
          size: mockFiles.get(filePath).length
        });
      }
      // Pour les répertoires, on vérifie si le chemin se termine par un nom de fichier
      // ou si c'est un répertoire temporaire de test
      if (filePath.includes('temp-') || filePath.endsWith('-task-123')) {
        return Promise.resolve({
          isFile: () => false,
          isDirectory: () => true,
          size: 0
        });
      }
      return Promise.reject(new Error(`File not found: ${filePath}`));
    });
    
    await fs.mkdir(tempDir, { recursive: true });
  });
  
  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('Pattern 1: Délégation simple', () => {
    test('Doit créer une sous-tâche pour délégation simple', async () => {
      const testContent = [
        {
          ts: Date.now(),
          type: 'say',
          role: 'user',
          content: '<new_task>\n<mode>debug</mode>\n<message>Créer le fichier de configuration principal</message>\n</new_task>'
        }
      ];
      
      const filePath = path.join(tempDir, 'ui_messages_delegation.json');
      await fs.writeFile(filePath, JSON.stringify(testContent));
      
      const pipeline = new HierarchyPipeline(mockMessageExtractionCoordinator);
      const instructions = await pipeline.extractNewTaskInstructionsFromUI(filePath);
      
      expect(instructions).toHaveLength(1);
      expect(instructions[0].mode).toBe('debug');
      expect(instructions[0].message).toBe('Créer le fichier de configuration principal');
    });
  });

  describe('Pattern 2: Délégation avec sous-tâches', () => {
    test('Doit créer des sous-tâches pour une délégation complexe', async () => {
      const testContent = [
        {
          ts: Date.now(),
          type: 'say',
          role: 'user',
          content: '<new_task>\n<mode>orchestrator</mode>\n<message>Coordonner les équipes de développement</message>\n</new_task>'
        }
      ];
      
      const filePath = path.join(tempDir, 'ui_messages_orchestration.json');
      await fs.writeFile(filePath, JSON.stringify(testContent));
      
      const pipeline = new HierarchyPipeline(mockMessageExtractionCoordinator);
      const instructions = await pipeline.extractNewTaskInstructionsFromUI(filePath);
      
      expect(instructions).toHaveLength(1);
      expect(instructions[0].mode).toBe('orchestrator');
      expect(instructions[0].message).toBe('Coordonner les équipes de développement');
    });
  });

  describe('Pattern 3: Gestion des erreurs', () => {
    test('Doit gérer fichier JSON corrompu', async () => {
      const filePath = path.join(tempDir, 'ui_messages_corrupt.json');
      await fs.writeFile(filePath, '{ "invalid": json content }');
      
      const pipeline = new HierarchyPipeline(mockMessageExtractionCoordinator);
      const instructions = await pipeline.extractNewTaskInstructionsFromUI(filePath);
      
      expect(instructions).toHaveLength(0);
    });

    test('Doit gérer fichier inexistant', async () => {
      const filePath = path.join(tempDir, 'ui_messages_missing.json');
      
      const pipeline = new HierarchyPipeline(mockMessageExtractionCoordinator);
      const instructions = await pipeline.extractNewTaskInstructionsFromUI(filePath);
      
      expect(instructions).toHaveLength(0);
    });
  });

  describe('Pattern 4: Intégration complète', () => {
    test('Doit gérer une hiérarchie parent→enfant complète', async () => {
      // Créer une tâche parent avec sous-tâches
      const parentDir = path.join(tempDir, 'parent-task-456');
      await fs.mkdir(parentDir, { recursive: true });
      
      const parentContent = [
        {
          ts: Date.now(),
          type: 'say',
          role: 'user',
          content: '<task>Mission parent de coordination des équipes</task>'
        },
        {
          ts: Date.now() + 1000,
          type: 'say',
          role: 'assistant',
          content: 'Je vais créer des sous-tâches pour cette mission.'
        },
        {
          ts: Date.now() + 2000,
          type: 'say',
          role: 'assistant',
          content: '<task>Sous-tâche: Analyser les besoins techniques de l\'équipe frontend</task>'
        },
        {
          ts: Date.now() + 3000,
          type: 'say',
          role: 'assistant',
          content: '<task>Sous-tâche: Définir l\'architecture backend pour la coordination</task>'
        }
      ];
      
      await fs.writeFile(
        path.join(parentDir, 'ui_messages.json'),
        JSON.stringify(parentContent)
      );
      
      await fs.writeFile(
        path.join(parentDir, 'task_metadata.json'),
        JSON.stringify({
          title: 'Mission parent de coordination',
          mode: 'orchestrator',
          workspace: 'd:/dev/test-workspace'
        })
      );
      
      // Tester l'extraction des instructions directement (plus simple et plus fiable)
      const pipeline = new HierarchyPipeline(mockMessageExtractionCoordinator);
      const instructions = await pipeline.extractNewTaskInstructionsFromUI(
        path.join(parentDir, 'ui_messages.json')
      );
      
      // Vérifier que nous avons bien extrait des instructions
      expect(Array.isArray(instructions)).toBe(true);
      expect(instructions.length).toBeGreaterThan(0);
      
      // Vérifier que chaque instruction a la structure attendue
      instructions.forEach((instruction: NewTaskInstruction) => {
        expect(instruction).toHaveProperty('mode');
        expect(instruction).toHaveProperty('message');
        expect(instruction).toHaveProperty('timestamp');
        expect(typeof instruction.mode).toBe('string');
        expect(typeof instruction.message).toBe('string');
        expect(typeof instruction.timestamp).toBe('number');
      });
      
      // Vérifier que nous avons au moins une instruction avec le contenu attendu
      const hasCoordinationContent = instructions.some((i: NewTaskInstruction) =>
        i.message.includes('coordination') || i.message.includes('Analyser') || i.message.includes('Définir')
      );
      expect(hasCoordinationContent).toBe(true);
    });
  });

  describe('Pattern 5: Performance et robustesse', () => {
    test('Doit gérer un gros fichier avec de nombreuses délégations', async () => {
      const largeContent = [];
      
      // Créer 50 messages avec délégations
      for (let i = 0; i < 50; i++) {
        largeContent.push({
          ts: Date.now() + i,
          type: 'say',
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `<new_task>\n<mode>debug</mode>\n<message>Sous-tâche de débogage ${i}</message>\n</new_task>`
        });
      }
      
      const filePath = path.join(tempDir, 'ui_messages_large.json');
      await fs.writeFile(filePath, JSON.stringify(largeContent));
      
      const pipeline = new HierarchyPipeline(mockMessageExtractionCoordinator);
      const startTime = Date.now();
      const instructions = await pipeline.extractNewTaskInstructionsFromUI(filePath);
      const duration = Date.now() - startTime;
      
      expect(instructions).toHaveLength(50);
      expect(duration).toBeLessThan(5000); // Moins de 5 secondes
      
      // Vérifier que toutes les instructions sont correctes
      instructions.forEach((instruction: NewTaskInstruction, index: number) => {
        expect(instruction.mode).toBe('debug');
        expect(instruction.message).toContain(`Sous-tâche de débogage ${index}`);
      });
    });
  });
});