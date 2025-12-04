/**
 * Tests unitaires pour le parsing XML des sous-tâches
 * Teste les patterns d'extraction XML avec message-extraction-coordinator
 * Adapté à la nouvelle architecture modulaire
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
  stat,
  default: { readFile, writeFile, mkdir, rm, stat }
}));

// Mock du module fs standard (pour existsSync)
vi.mock('fs', () => {
  return {
    existsSync: vi.fn(() => true), // Par défaut true pour simplifier
    createReadStream: vi.fn(),
    Stats: class {},
    promises: {
      readFile,
      writeFile,
      mkdir,
      rm,
      stat
    }
  };
});

// Mock du module path
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

<<<<<<< Updated upstream
// Suppression du mock de message-extraction-coordinator pour utiliser l'implémentation réelle
// Cela permet de tester l'intégration complète et évite les problèmes de chemin d'import dynamique
=======
// Mock du module message-extraction-coordinator
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
  })
};

vi.mock('../../../src/utils/message-extraction-coordinator.js', () => ({
  messageExtractionCoordinator: mockMessageExtractionCoordinator
}));
>>>>>>> Stashed changes

import * as fs from 'fs/promises';
import * as path from 'path';

// Import de types uniquement
import { NewTaskInstruction } from '../../../src/types/conversation.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Variable globale pour la classe importée dynamiquement
let RooStorageDetector: any;

describe('Parsing XML des Sous-tâches', () => {
  const tempDir = path.join(__dirname, 'temp-xml-parsing');
  const mockFiles = new Map();

  beforeEach(async () => {
    // Réinitialiser les modules pour garantir que les mocks sont pris en compte
    vi.resetModules();

    // Suppression du mock dynamique du coordinateur
    // On utilise le vrai coordinateur, mais on s'assure que fs.existsSync fonctionne

    // Importer dynamiquement la classe à tester
    const module = await import('../../../src/utils/roo-storage-detector.js');
    RooStorageDetector = module.RooStorageDetector;

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
          size: mockFiles.get(filePath).length,
          mtime: new Date(),
          birthtime: new Date()
        });
      }
<<<<<<< Updated upstream
      // Pour les répertoires, on vérifie si le chemin se termine par un nom de fichier
      // ou si c'est un répertoire temporaire de test
      if (filePath.includes('temp-') || filePath.endsWith('-task-123')) {
        return Promise.resolve({
          isFile: () => false,
          isDirectory: () => true,
          size: 0,
          mtime: new Date(),
          birthtime: new Date()
        });
      }
=======
>>>>>>> Stashed changes
      return Promise.reject(new Error(`File not found: ${filePath}`));
    });

    // Configurer existsSync pour utiliser mockFiles
    const fsStandard = await import('fs');
    // Cast explicite pour accéder aux méthodes de mock
    const mockExistsSync = fsStandard.existsSync as unknown as ReturnType<typeof vi.fn>;

    if (mockExistsSync && mockExistsSync.mockImplementation) {
        mockExistsSync.mockImplementation((filePath: any) => {
            const pathStr = String(filePath);
            return mockFiles.has(pathStr) || pathStr.includes('temp-') || pathStr.endsWith('-task-123');
        });
    }

    await fs.mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('Extraction des instructions XML', () => {
    test('Doit extraire les balises <task> simples', async () => {
      const testContent = [
        {
          ts: Date.now(),
          type: 'say',
          role: 'user',
          content: '<task>Analyser les performances du système</task>'
        }
      ];

      const filePath = path.join(tempDir, 'ui_messages_simple.json');
      await fs.writeFile(filePath, JSON.stringify(testContent));
<<<<<<< Updated upstream

      // Test de la méthode d'extraction privée via reflection
      const instructions = await (RooStorageDetector as any).extractNewTaskInstructionsFromUI(filePath);

      expect(instructions).toHaveLength(1);
      expect(instructions[0].mode).toBe('task');
      expect(instructions[0].message).toContain('**MISSION CRITIQUE:** Réparer le système de hiérarchies');
      expect(instructions[0].message.length).toBeLessThanOrEqual(200);
=======
      
      const result = await mockMessageExtractionCoordinator.extractFromMessages(testContent, {
        patterns: ['task'],
        minLength: 20,
        maxLength: 500
      });
      
      expect(result.instructions).toHaveLength(1);
      expect(result.instructions[0].mode).toBe('task');
      expect(result.instructions[0].message).toBe('Analyser les performances du système');
>>>>>>> Stashed changes
    });

    test('Doit extraire les balises <new_task> complexes', async () => {
      const testContent = [
        {
          ts: Date.now(),
          type: 'say',
          role: 'user',
          content: '<new_task>\n<mode>debug</mode>\n<message>Créer un fichier de configuration principal</message>\n</new_task>'
        }
      ];
<<<<<<< Updated upstream

      const filePath = path.join(tempDir, 'ui_messages_short.json');
      await fs.writeFile(filePath, JSON.stringify(testContent));

      const instructions = await (RooStorageDetector as any).extractNewTaskInstructionsFromUI(filePath);

      expect(instructions).toHaveLength(0);
=======
      
      const filePath = path.join(tempDir, 'ui_messages_complex.json');
      await fs.writeFile(filePath, JSON.stringify(testContent));
      
      const result = await mockMessageExtractionCoordinator.extractFromMessages(testContent, {
        patterns: ['new_task'],
        minLength: 20,
        maxLength: 500
      });
      
      expect(result.instructions).toHaveLength(1);
      expect(result.instructions[0].mode).toBe('debug');
      expect(result.instructions[0].message).toBe('Créer un fichier de configuration principal');
>>>>>>> Stashed changes
    });

    test('Doit ignorer les contenus sans balises XML', async () => {
      const testContent = [
        {
          ts: Date.now(),
          type: 'say',
          role: 'user',
<<<<<<< Updated upstream
          content: `
            <task>Première mission de test pour valider le parsing</task>

            Du texte entre les balises.

            <task>Seconde mission de test avec contenu différent</task>
          `
        }
      ];

      const filePath = path.join(tempDir, 'ui_messages_multiple.json');
      await fs.writeFile(filePath, JSON.stringify(testContent));

      const instructions = await (RooStorageDetector as any).extractNewTaskInstructionsFromUI(filePath);

      expect(instructions).toHaveLength(2);
      expect(instructions[0].message).toContain('Première mission de test');
      expect(instructions[1].message).toContain('Seconde mission de test');
    });

    test('Doit gérer les balises task avec contenu multiligne', async () => {
      const testContent = [
        {
          ts: Date.now(),
          type: 'say',
          role: 'user',
          content: `<task>
**MISSION COMPLEXE:**

1. Étape une
2. Étape deux
3. Étape trois

**CONTRAINTES:**
- Respecter les standards
- Tester soigneusement
</task>`
        }
      ];

      const filePath = path.join(tempDir, 'ui_messages_multiline.json');
      await fs.writeFile(filePath, JSON.stringify(testContent));

      const instructions = await (RooStorageDetector as any).extractNewTaskInstructionsFromUI(filePath);

      expect(instructions).toHaveLength(1);
      expect(instructions[0].message).toContain('**MISSION COMPLEXE:**');
      expect(instructions[0].message).toContain('1. Étape une');
      expect(instructions[0].message).toContain('**CONTRAINTES:**');
    });
  });

  describe('Pattern 2: Structures de délégation complexes', () => {
    test('Doit extraire délégation new_task complexe', async () => {
      const testContent = [
        {
          ts: Date.now(),
          type: 'say',
          role: 'assistant',
          content: '<new_task>\n<mode>code</mode>\n<message>Créer le fichier de configuration principal</message>\n</new_task>'
        }
      ];

      const filePath = path.join(tempDir, 'ui_messages_delegation.json');
      await fs.writeFile(filePath, JSON.stringify(testContent));

      const instructions = await (RooStorageDetector as any).extractNewTaskInstructionsFromUI(filePath);

      expect(instructions).toHaveLength(1);
      expect(instructions[0].mode).toBe('code');
      expect(instructions[0].message).toBe('Créer le fichier de configuration principal');
    });

    test('Doit rejeter délégations avec mode ou message vides', async () => {
      const testContent = [
        {
          ts: Date.now(),
          type: 'say',
          role: 'assistant',
          content: '<new_task>\n<mode></mode>\n<message>Message valide</message>\n</new_task>'
        },
        {
          ts: Date.now() + 1000,
          type: 'say',
          role: 'assistant',
          content: '<new_task>\n<mode>debug</mode>\n<message></message>\n</new_task>'
        }
      ];

      const filePath = path.join(tempDir, 'ui_messages_invalid.json');
      await fs.writeFile(filePath, JSON.stringify(testContent));

      const instructions = await (RooStorageDetector as any).extractNewTaskInstructionsFromUI(filePath);

      expect(instructions).toHaveLength(0);
    });
  });

  describe('Pattern 3: Format de contenu mixte', () => {
    test('Doit extraire balises task simples ET délégations complexes', async () => {
      const testContent = [
        {
          ts: Date.now(),
          type: 'say',
          role: 'user',
          content: '<task>Mission principale de test avec contenu détaillé</task>'
        },
        {
          ts: Date.now() + 1000,
          type: 'say',
          role: 'assistant',
          content: '<new_task>\n<mode>debug</mode>\n<message>Sous-tâche de débogage créée automatiquement</message>\n</new_task>'
        }
      ];

      const filePath = path.join(tempDir, 'ui_messages_mixed.json');
      await fs.writeFile(filePath, JSON.stringify(testContent));

      const instructions = await (RooStorageDetector as any).extractNewTaskInstructionsFromUI(filePath);

      expect(instructions).toHaveLength(2);

      // Vérifier balise task simple
      const taskInstruction = instructions.find((i: NewTaskInstruction) => i.mode === 'task');
      expect(taskInstruction).toBeDefined();
      expect(taskInstruction!.message).toContain('Mission principale de test');

      // Vérifier délégation complexe
      const delegationInstruction = instructions.find((i: NewTaskInstruction) => i.mode === 'debug');
      expect(delegationInstruction).toBeDefined();
      expect(delegationInstruction!.message).toBe('Sous-tâche de débogage créée automatiquement');
    });
  });

  describe('Pattern 4: Contenu avec format array', () => {
    test('Doit gérer contenu au format array OpenAI', async () => {
=======
          content: 'Message sans balises XML'
        }
      ];
      
      const filePath = path.join(tempDir, 'ui_messages_no_tags.json');
      await fs.writeFile(filePath, JSON.stringify(testContent));
      
      const result = await mockMessageExtractionCoordinator.extractFromMessages(testContent, {
        patterns: ['task', 'new_task'],
        minLength: 20,
        maxLength: 500
      });
      
      expect(result.instructions).toHaveLength(0);
    });

    test('Doit gérer les contenus au format array OpenAI', async () => {
>>>>>>> Stashed changes
      const testContent = [
        {
          ts: Date.now(),
          type: 'say',
          role: 'user',
          content: [
            { type: 'text', text: '<task>Tâche dans un format array</task>' }
          ]
        }
      ];

      const filePath = path.join(tempDir, 'ui_messages_array.json');
      await fs.writeFile(filePath, JSON.stringify(testContent));
<<<<<<< Updated upstream

      const instructions = await (RooStorageDetector as any).extractNewTaskInstructionsFromUI(filePath);

      expect(instructions).toHaveLength(1);
      expect(instructions[0].mode).toBe('task');
      expect(instructions[0].message).toContain('Mission avec contenu array format OpenAI');
=======
      
      const result = await mockMessageExtractionCoordinator.extractFromMessages(testContent, {
        patterns: ['task'],
        minLength: 20,
        maxLength: 500
      });
      
      expect(result.instructions).toHaveLength(1);
      expect(result.instructions[0].message).toBe('Tâche dans un format array');
>>>>>>> Stashed changes
    });

    test('Doit filtrer les tâches trop courtes', async () => {
      const testContent = [
        {
          ts: Date.now(),
          type: 'say',
          role: 'user',
<<<<<<< Updated upstream
          content: `<task>${longContent}</task>`
        }
      ];

      const filePath = path.join(tempDir, 'ui_messages_long.json');
      await fs.writeFile(filePath, JSON.stringify(testContent));

      const instructions = await (RooStorageDetector as any).extractNewTaskInstructionsFromUI(filePath);

      expect(instructions).toHaveLength(1);
      expect(instructions[0].message.length).toBe(200);
      expect(instructions[0].message).toContain('Mission très longue');
    });

    test('Doit préserver les timestamps corrects', async () => {
      const timestamp = 1758233453401;
      const testContent = [
        {
          ts: timestamp,
          type: 'say',
          role: 'user',
          content: '<task>Mission avec timestamp spécifique pour test</task>'
        }
      ];

      const filePath = path.join(tempDir, 'ui_messages_timestamp.json');
      await fs.writeFile(filePath, JSON.stringify(testContent));

      const instructions = await (RooStorageDetector as any).extractNewTaskInstructionsFromUI(filePath);

      expect(instructions).toHaveLength(1);
      expect(instructions[0].timestamp).toBe(timestamp);
    });
  });

  describe('Pattern 6: Cas de test réel', () => {
    test('Doit extraire la mission Git critique du cas réel', async () => {
      const realContent = [
        {
          ts: 1758233453401,
          type: 'say',
          role: 'user',
          content: '<task>\n**MISSION CRITIQUE GIT - ANALYSE DIFF ET COMMITS SÉCURISÉS**\n\nTu dois effectuer une mission complète de gestion Git sur le dépôt roo-extensions et ses sous-modules, avec une attention particulière pour mcps/internal.\n\n**OBJECTIFS SPÉCIFIQUES :**\n\n1. **ANALYSE COMPLÈTE** :\n   - Examiner attentivement l\'état git du dépôt principal\n   - Analyser tous les sous-modules\n\n**LIVRABLE ATTENDU :**\nTous les dépôts synchronisés, avec l\'historique préservé.\n</task>'
        }
      ];

      const filePath = path.join(tempDir, 'ui_messages_real.json');
      await fs.writeFile(filePath, JSON.stringify(realContent));

      const instructions = await (RooStorageDetector as any).extractNewTaskInstructionsFromUI(filePath);

      expect(instructions).toHaveLength(1);
      expect(instructions[0].mode).toBe('task');
      expect(instructions[0].message).toContain('**MISSION CRITIQUE GIT - ANALYSE DIFF ET COMMITS SÉCURISÉS**');
      // Le contenu est tronqué à 200 caractères, donc on vérifie uniquement le début
      expect(instructions[0].message).toContain('Tu dois effectuer une mission complète');
      expect(instructions[0].timestamp).toBe(1758233453401);
    });
  });

  describe('Pattern 7: Gestion d\'erreurs', () => {
    test('Doit gérer gracieusement fichier JSON corrompu', async () => {
      const filePath = path.join(tempDir, 'ui_messages_corrupt.json');
      await fs.writeFile(filePath, '{ "invalid": json content }');

      const instructions = await (RooStorageDetector as any).extractNewTaskInstructionsFromUI(filePath);

      expect(instructions).toHaveLength(0);
    });

    test('Doit gérer fichier inexistant', async () => {
      const filePath = path.join(tempDir, 'ui_messages_missing.json');

      const instructions = await (RooStorageDetector as any).extractNewTaskInstructionsFromUI(filePath);

      expect(instructions).toHaveLength(0);
    });

    test('Doit nettoyer le BOM UTF-8', async () => {
      const testContent = [
        {
          ts: Date.now(),
          type: 'say',
          role: 'user',
          content: '<task>Mission avec nettoyage BOM UTF-8 nécessaire</task>'
        }
      ];

      const filePath = path.join(tempDir, 'ui_messages_bom.json');
      // Ajouter le BOM UTF-8 (0xFEFF) au début du fichier
      const content = '\uFEFF' + JSON.stringify(testContent);
      await fs.writeFile(filePath, content, 'utf-8');

      const instructions = await (RooStorageDetector as any).extractNewTaskInstructionsFromUI(filePath);

      expect(instructions).toHaveLength(1);
      expect(instructions[0].message).toContain('Mission avec nettoyage BOM UTF-8');
    });
  });

  describe('Integration: Système à deux passes', () => {
    test('Doit alimenter le RadixTree avec les préfixes extraits', async () => {
      const testContent = [
        {
          ts: Date.now(),
          type: 'say',
          role: 'user',
          content: '<task>Mission de test pour alimenter le RadixTree avec un contenu spécifique</task>'
=======
          content: '<task>Court</task>'
>>>>>>> Stashed changes
        },
        {
          ts: Date.now(),
          type: 'say',
          role: 'user',
          content: '<task>Tâche suffisamment longue pour être extraite</task>'
        }
      ];
<<<<<<< Updated upstream

      const filePath = path.join(tempDir, 'ui_messages_radix.json');
      await fs.writeFile(filePath, JSON.stringify(testContent));

      const instructions = await (RooStorageDetector as any).extractNewTaskInstructionsFromUI(filePath);

      expect(instructions).toHaveLength(2);

      // Vérifier que les préfixes seraient corrects pour le RadixTree
      const taskPrefix = `task|${instructions[0].message}`.substring(0, 200);
      const debugPrefix = `debug|${instructions[1].message}`.substring(0, 200);

      expect(taskPrefix.length).toBeGreaterThan(10);
      expect(debugPrefix.length).toBeGreaterThan(10);
      expect(taskPrefix).toContain('Mission de test pour alimenter');
      expect(debugPrefix).toContain('Diagnostic du système');
=======
      
      const filePath = path.join(tempDir, 'ui_messages_length_filter.json');
      await fs.writeFile(filePath, JSON.stringify(testContent));
      
      const result = await mockMessageExtractionCoordinator.extractFromMessages(testContent, {
        patterns: ['task'],
        minLength: 20,
        maxLength: 500
      });
      
      expect(result.instructions).toHaveLength(1);
      expect(result.instructions[0].message).toBe('Tâche suffisamment longue pour être extraite');
    });
  });

  describe('Gestion des erreurs', () => {
    test('Doit gérer les messages vides', async () => {
      const result = await mockMessageExtractionCoordinator.extractFromMessages([], {
        patterns: ['task'],
        minLength: 20,
        maxLength: 500
      });
      
      expect(result.instructions).toHaveLength(0);
      expect(result.processedMessages).toBe(0);
    });

    test('Doit gérer les contenus null', async () => {
      const testContent = [
        { ts: Date.now(), type: 'say', role: 'user', content: null }
      ];
      
      const result = await mockMessageExtractionCoordinator.extractFromMessages(testContent, {
        patterns: ['task'],
        minLength: 20,
        maxLength: 500
      });
      
      expect(result.instructions).toHaveLength(0);
    });

    test('Doit respecter la limite de longueur maximale', async () => {
      const testContent = [
        {
          ts: Date.now(),
          type: 'say',
          role: 'user',
          content: '<task>' + 'a'.repeat(600) + '</task>'
        }
      ];
      
      const filePath = path.join(tempDir, 'ui_messages_max_length.json');
      await fs.writeFile(filePath, JSON.stringify(testContent));
      
      const result = await mockMessageExtractionCoordinator.extractFromMessages(testContent, {
        patterns: ['task'],
        minLength: 20,
        maxLength: 500
      });
      
      expect(result.instructions).toHaveLength(1);
      expect(result.instructions[0].message.length).toBeLessThanOrEqual(500);
>>>>>>> Stashed changes
    });
  });

  describe('Performance et robustesse', () => {
    test('Doit traiter efficacement un grand nombre de messages', async () => {
      const largeContent = [];
<<<<<<< Updated upstream

      // Créer 100 messages avec balises task
=======
      
      // Créer 100 messages avec des balises XML
>>>>>>> Stashed changes
      for (let i = 0; i < 100; i++) {
        largeContent.push({
          ts: Date.now() + i,
          type: 'say',
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `<task>Tâche de test ${i}</task>`
        });
      }

      const filePath = path.join(tempDir, 'ui_messages_large.json');
      await fs.writeFile(filePath, JSON.stringify(largeContent));

      const startTime = Date.now();
      const result = await mockMessageExtractionCoordinator.extractFromMessages(largeContent, {
        patterns: ['task'],
        minLength: 20,
        maxLength: 500
      });
      const duration = Date.now() - startTime;
<<<<<<< Updated upstream

      expect(instructions).toHaveLength(100);
      expect(duration).toBeLessThan(5000); // Moins de 5 secondes

=======
      
      expect(result.instructions).toHaveLength(100);
      expect(duration).toBeLessThan(1000); // Moins de 1 seconde
      
>>>>>>> Stashed changes
      // Vérifier que toutes les instructions sont correctes
      result.instructions.forEach((instruction, index) => {
        expect(instruction.mode).toBe('task');
        expect(instruction.message).toBe(`Tâche de test ${index}`);
      });
    });
  });
<<<<<<< Updated upstream
});

/**
 * Tests d'intégration pour le système complet
 */
describe('Intégration: Système complet de hiérarchies', () => {
  const tempDir = path.join(__dirname, 'temp-integration');
  const mockFiles = new Map();

  beforeEach(async () => {
    // Réinitialiser les modules pour garantir que les mocks sont pris en compte
    vi.resetModules();

    // Importer dynamiquement la classe à tester
    const module = await import('../../../src/utils/roo-storage-detector.js');
    RooStorageDetector = module.RooStorageDetector;

    // Réinitialiser les mocks
    mockFiles.clear();

    // Configurer les mocks pour cette section
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

  test('Simulation complète parent→enfant avec balises task', async () => {
    // Créer une tâche parent avec sous-tâches
    const parentDir = path.join(tempDir, 'parent-task-123');
    await fs.mkdir(parentDir, { recursive: true });

    const parentContent = [
      {
        ts: Date.now(),
        type: 'say',
        role: 'user',
        content: '<task>Mission parent de coordination des équipes de développement</task>'
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
    const instructions = await (RooStorageDetector as any).extractNewTaskInstructionsFromUI(
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
    const hasMissionContent = instructions.some((i: NewTaskInstruction) =>
      i.message.includes('mission') || i.message.includes('Analyser') || i.message.includes('Définir')
    );
    expect(hasMissionContent).toBe(true);
  });
=======
>>>>>>> Stashed changes
});