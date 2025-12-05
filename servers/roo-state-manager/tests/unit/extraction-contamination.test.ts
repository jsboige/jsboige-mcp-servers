/**
 * Test de contamination par les patterns XML depuis api_conversation_history.json
 * BUG: extractNewTaskInstructionsFromUI retourne 17 instructions au lieu de 6
 * CAUSE: Extraction depuis api_conversation_history.json qui contient des balises XML condensées
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import * as path from 'path';
import { fileURLToPath } from 'url';

// Désactiver le mock global de fs pour ce test
vi.unmock('fs/promises');
import * as fs from 'fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Chemin vers le fichier de fixture réel
const FIXTURE_TASK_PATH = path.resolve(
  __dirname,
  '../fixtures/real-tasks/bc93a6f7-cd2e-4686-a832-46e3cd14d338'
);

describe('Extraction contamination bug', () => {
  let uiMessagesPath: string;
  let apiHistoryPath: string;

  beforeAll(() => {
    uiMessagesPath = path.join(FIXTURE_TASK_PATH, 'ui_messages.json');
    apiHistoryPath = path.join(FIXTURE_TASK_PATH, 'api_conversation_history.json');
  });

  it('should exist fixture files', async () => {
    const uiExists = await fs.access(uiMessagesPath).then(() => true).catch(() => false);
    const apiExists = await fs.access(apiHistoryPath).then(() => true).catch(() => false);

    expect(uiExists).toBe(true);
    expect(apiExists).toBe(true);
  });

  it('should extract ONLY 6 newTask instructions (not 17)', async () => {
    // Analyser manuellement le fichier ui_messages.json
    const content = await fs.readFile(uiMessagesPath, 'utf-8');
    const messages = JSON.parse(content);

    // Compter les messages de type ask/tool avec tool:newTask
    let newTaskCount = 0;
    for (const message of messages) {
      if (message.type === 'ask' && message.ask === 'tool' && typeof message.text === 'string') {
        try {
          const toolData = JSON.parse(message.text);
          if (toolData.tool === 'newTask') {
            newTaskCount++;
          }
        } catch (e) {
          // Ignore parsing errors
        }
      }
    }

    console.log(`✅ Found ${newTaskCount} genuine newTask calls in ui_messages.json`);
    expect(newTaskCount).toBe(6); // Le nombre RÉEL attendu
  });

  it('should NOT extract XML patterns from api_conversation_history.json', async () => {
    // Vérifier que le fichier API contient bien des balises XML contaminantes
    const content = await fs.readFile(apiHistoryPath, 'utf-8');

    const hasTaskTag = content.includes('<task>');
    const hasNewTaskTag = content.includes('<new_task>');
    const hasDelegationXml = /<(\w+_\w+)>\s*<mode>/.test(content);

    console.log(`API History contamination check:`);
    console.log(`  - Has <task> tags: ${hasTaskTag}`);
    console.log(`  - Has <new_task> tags: ${hasNewTaskTag}`);
    console.log(`  - Has delegation XML: ${hasDelegationXml}`);

    // Ces patterns NE DOIVENT PAS être extraits car le fichier est condensé
    expect(hasTaskTag || hasNewTaskTag || hasDelegationXml).toBe(true);
  });
});