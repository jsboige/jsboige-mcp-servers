import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { RooStorageDetector } from '../../src/utils/roo-storage-detector.js';
import * as fs from 'fs/promises';
import * as path from 'path';

describe('extractMainInstructionFromUI - Fallback Logic', () => {
  const testDataDir = path.join(__dirname, '../test-data/main-instruction-fallback');

  beforeAll(async () => {
    // Créer le répertoire de test
    await fs.mkdir(testDataDir, { recursive: true });
  });

  afterAll(async () => {
    // Nettoyer
    await fs.rm(testDataDir, { recursive: true, force: true });
  });

  it('devrait extraire depuis say/text si l\'instruction est complète', async () => {
    const uiMessagesPath = path.join(testDataDir, 'complete-instruction.json');
    
    const messages = [
      {
        ts: 1759082704597,
        type: 'say',
        say: 'text',
        text: 'Ceci est une instruction complète et suffisamment longue pour être utilisée directement'
      }
    ];

    await fs.writeFile(uiMessagesPath, JSON.stringify(messages, null, 2));

    const result = await RooStorageDetector.extractMainInstructionFromUI(uiMessagesPath);

    expect(result).toBeDefined();
    expect(result).toContain('instruction complète');
    expect(result!.length).toBeGreaterThan(50);
  });

  it('devrait utiliser le fallback api_req_started si say/text est trop court', async () => {
    const uiMessagesPath = path.join(testDataDir, 'truncated-instruction.json');
    
    const messages = [
      {
        ts: 1759082704597,
        type: 'say',
        say: 'text',
        text: 'MISSION ARCHITECTURALE CRITIQUE...'
      },
      {
        ts: 1759082711779,
        type: 'say',
        say: 'api_req_started',
        text: JSON.stringify({
          request: '<task>\nMISSION ARCHITECTURALE CRITIQUE : Refactoriser le système de cache pour améliorer les performances\n</task>\n\n<environment_details>\n# VSCode Visible Files\n\n\n# VSCode Open Tabs\n</environment_details>',
          apiProtocol: 'openai',
          tokensIn: 56553,
          tokensOut: 413
        })
      }
    ];

    await fs.writeFile(uiMessagesPath, JSON.stringify(messages, null, 2));

    const result = await RooStorageDetector.extractMainInstructionFromUI(uiMessagesPath);

    expect(result).toBeDefined();
    expect(result).toContain('Refactoriser le système de cache');
    expect(result).not.toContain('<task>');
    expect(result).not.toContain('</task>');
    expect(result).not.toContain('CRITIQUE...');
  });

  it('devrait utiliser le fallback api_req_started si say/text se termine par ...', async () => {
    const uiMessagesPath = path.join(testDataDir, 'ellipsis-instruction.json');
    
    const messages = [
      {
        ts: 1759082704597,
        type: 'say',
        say: 'text',
        text: 'Cette instruction est suffisamment longue mais se termine par des points de suspension...'
      },
      {
        ts: 1759082711779,
        type: 'say',
        say: 'api_req_started',
        text: JSON.stringify({
          request: '<task>\nCette instruction est suffisamment longue mais se termine par des points de suspension et contient la suite complète du texte avec tous les détails nécessaires\n</task>',
          apiProtocol: 'openai'
        })
      }
    ];

    await fs.writeFile(uiMessagesPath, JSON.stringify(messages, null, 2));

    const result = await RooStorageDetector.extractMainInstructionFromUI(uiMessagesPath);

    expect(result).toBeDefined();
    expect(result).toContain('suite complète');
    expect(result).not.toContain('...');
  });

  it('devrait retourner say/text si api_req_started n\'existe pas', async () => {
    const uiMessagesPath = path.join(testDataDir, 'no-api-req.json');
    
    const messages = [
      {
        ts: 1759082704597,
        type: 'say',
        say: 'text',
        text: 'Courte instruction'
      }
    ];

    await fs.writeFile(uiMessagesPath, JSON.stringify(messages, null, 2));

    const result = await RooStorageDetector.extractMainInstructionFromUI(uiMessagesPath);

    expect(result).toBe('Courte instruction');
  });

  it('devrait retourner undefined si aucun message say/text n\'existe', async () => {
    const uiMessagesPath = path.join(testDataDir, 'no-say-text.json');
    
    const messages = [
      {
        ts: 1759082711779,
        type: 'say',
        say: 'api_req_started',
        text: JSON.stringify({
          request: '<task>\nInstruction dans api_req_started seulement\n</task>'
        })
      }
    ];

    await fs.writeFile(uiMessagesPath, JSON.stringify(messages, null, 2));

    const result = await RooStorageDetector.extractMainInstructionFromUI(uiMessagesPath);

    expect(result).toBeDefined();
    expect(result).toContain('api_req_started seulement');
  });

  it('devrait gérer le cas où le JSON de api_req_started est invalide', async () => {
    const uiMessagesPath = path.join(testDataDir, 'invalid-json.json');
    
    const messages = [
      {
        ts: 1759082704597,
        type: 'say',
        say: 'text',
        text: 'Court'
      },
      {
        ts: 1759082711779,
        type: 'say',
        say: 'api_req_started',
        text: 'INVALID JSON HERE'
      }
    ];

    await fs.writeFile(uiMessagesPath, JSON.stringify(messages, null, 2));

    const result = await RooStorageDetector.extractMainInstructionFromUI(uiMessagesPath);

    expect(result).toBe('Court');
  });
});