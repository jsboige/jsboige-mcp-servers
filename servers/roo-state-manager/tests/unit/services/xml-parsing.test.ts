/**
 * Tests unitaires pour le parsing XML des sous-tâches
 * Teste les patterns <task> simples et <new_task><mode><message> complexes
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';

// Force use of real fs implementation
vi.mock('fs', async () => {
  return await vi.importActual('fs');
});
vi.mock('fs/promises', async () => {
  return await vi.importActual('fs/promises');
});

// Import de la classe à tester
import { RooStorageDetector } from '../../../src/utils/roo-storage-detector.js';
import { NewTaskInstruction } from '../../../src/types/conversation.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Parsing XML des Sous-tâches', () => {
  const tempDir = path.join(__dirname, 'temp-xml-parsing');

  beforeEach(async () => {
    await fs.mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('Pattern 1: Balises <task> simples', () => {
    test('Doit extraire balise task simple basique', async () => {
      const testContent = [
        {
          ts: Date.now(),
          type: 'say',
          role: 'user',
          content: '<task>\n**MISSION CRITIQUE:** Réparer le système de hiérarchies\n\nTu dois effectuer une réparation complète du système.\n</task>'
        }
      ];

      const filePath = path.join(tempDir, 'ui_messages_simple.json');
      console.log('[TEST DEBUG] Writing to:', filePath);
      await fs.writeFile(filePath, JSON.stringify(testContent));

      const exists = await fs.access(filePath).then(() => true).catch(() => false);
      console.log('[TEST DEBUG] File exists after write:', exists);

      if (exists) {
          const content = await fs.readFile(filePath, 'utf-8');
          console.log('[TEST DEBUG] File content:', content);
      }

      // Test de la méthode d'extraction privée via reflection
      const instructions = await (RooStorageDetector as any).extractNewTaskInstructionsFromUI(filePath);
      console.log('[TEST DEBUG] Instructions found:', instructions);

      expect(instructions).toHaveLength(1);
      expect(instructions[0].mode).toBe('task');
      expect(instructions[0].message).toContain('**MISSION CRITIQUE:** Réparer le système de hiérarchies');
      expect(instructions[0].message.length).toBeLessThanOrEqual(200);
    });

    test('Doit ignorer balises task trop courtes', async () => {
      const testContent = [
        {
          ts: Date.now(),
          type: 'say',
          role: 'user',
          content: '<task>OK</task>' // Trop court (< 20 caractères)
        }
      ];

      const filePath = path.join(tempDir, 'ui_messages_short.json');
      await fs.writeFile(filePath, JSON.stringify(testContent));

      const instructions = await (RooStorageDetector as any).extractNewTaskInstructionsFromUI(filePath);

      expect(instructions).toHaveLength(0);
    });

    test('Doit extraire plusieurs balises task dans le même message', async () => {
      const testContent = [
        {
          ts: Date.now(),
          type: 'say',
          role: 'user',
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
      const testContent = [
        {
          ts: Date.now(),
          type: 'say',
          role: 'user',
          content: [
            {
              type: 'text',
              text: '<task>Mission avec contenu array format OpenAI</task>'
            }
          ]
        }
      ];

      const filePath = path.join(tempDir, 'ui_messages_array.json');
      await fs.writeFile(filePath, JSON.stringify(testContent));

      const instructions = await (RooStorageDetector as any).extractNewTaskInstructionsFromUI(filePath);

      expect(instructions).toHaveLength(1);
      expect(instructions[0].mode).toBe('task');
      expect(instructions[0].message).toContain('Mission avec contenu array format OpenAI');
    });
  });

  describe('Pattern 5: Troncature et validation', () => {
    test('Doit tronquer les messages trop longs à 200 caractères', async () => {
      const longContent = 'Mission très longue'.repeat(20); // > 200 caractères
      const testContent = [
        {
          ts: Date.now(),
          type: 'say',
          role: 'user',
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
        },
        {
          ts: Date.now() + 1000,
          type: 'say',
          role: 'assistant',
          content: '<new_task>\n<mode>debug</mode>\n<message>Diagnostic du système pour mission RadixTree</message>\n</new_task>'
        }
      ];

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
    });
  });

  describe('Performance et robustesse', () => {
    test('Doit gérer un gros fichier avec de nombreuses balises', async () => {
      const largeContent = [];

      // Créer 100 messages avec balises task
      for (let i = 0; i < 100; i++) {
        largeContent.push({
          ts: Date.now() + i,
          type: 'say',
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `<task>Mission numéro ${i} pour test de performance avec contenu</task>`
        });
      }

      const filePath = path.join(tempDir, 'ui_messages_large.json');
      await fs.writeFile(filePath, JSON.stringify(largeContent));

      const startTime = Date.now();
      const instructions = await (RooStorageDetector as any).extractNewTaskInstructionsFromUI(filePath);
      const duration = Date.now() - startTime;

      expect(instructions).toHaveLength(100);
      expect(duration).toBeLessThan(5000); // Moins de 5 secondes

      // Vérifier que toutes les instructions sont correctes
      instructions.forEach((instruction: NewTaskInstruction, index: number) => {
        expect(instruction.mode).toBe('task');
        expect(instruction.message).toContain(`Mission numéro ${index}`);
      });
    });
  });
});

/**
 * Tests d'intégration pour le système complet
 */
describe('Intégration: Système complet de hiérarchies', () => {
  const tempDir = path.join(__dirname, 'temp-integration');

  beforeEach(async () => {
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

    // Tester l'analyse complète de la conversation
    const skeleton = await RooStorageDetector.analyzeConversation('parent-task-123', parentDir, true);

    expect(skeleton).toBeDefined();
    expect(skeleton!.childTaskInstructionPrefixes).toBeDefined();
    expect(skeleton!.childTaskInstructionPrefixes!.length).toBe(3); // 1 mission parent + 2 sous-tâches

    // Vérifier que les préfixes contiennent les bonnes informations
    // Les préfixes sont les contenus des balises <task>, pas les metadata
    const prefixes = skeleton!.childTaskInstructionPrefixes!;

    // Vérifier que nous avons 3 préfixes
    expect(prefixes.length).toBe(3);

    // Vérifier le contenu avec la casse correcte (minuscule)
    expect(prefixes.some(p => p.includes('mission parent de coordination'))).toBe(true);
    expect(prefixes.filter(p => p.startsWith('sous-tâche:')).length).toBe(2);
  });
});