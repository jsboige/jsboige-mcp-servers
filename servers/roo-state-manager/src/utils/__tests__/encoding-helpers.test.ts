/**
 * encoding-helpers.test.ts - Tests pour les utilitaires d'encodage
 *
 * Tests unitaires pour les fonctions de gestion du BOM UTF-8
 * et de lecture de fichiers avec gestion de l'encodage.
 *
 * @module encoding-helpers.test
 * @version 1.0.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { writeFileSync } from 'fs';
import { join } from 'path';
import {
  stripBOM,
  readFileWithoutBOM,
  readFileSyncWithoutBOM,
  parseJSONWithoutBOM,
  readJSONFileWithoutBOM,
  readJSONFileSyncWithoutBOM
} from '../encoding-helpers.js';

describe('encoding-helpers', () => {
  const testDir = join(process.cwd(), 'test-temp-encoding');
  const testFile = join(testDir, 'test.json');
  const testFileWithBOM = join(testDir, 'test-with-bom.json');

  beforeEach(async () => {
    // Créer le répertoire de test
    await fs.mkdir(testDir, { recursive: true });

    // Créer un fichier JSON sans BOM
    const contentWithoutBOM = JSON.stringify({ test: 'data', value: 123 });
    await fs.writeFile(testFile, contentWithoutBOM, 'utf-8');

    // Créer un fichier JSON avec BOM UTF-8
    const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
    const contentWithBOM = Buffer.concat([bom, Buffer.from(contentWithoutBOM, 'utf-8')]);
    await fs.writeFile(testFileWithBOM, contentWithBOM);
  });

  afterEach(async () => {
    // Nettoyer les fichiers de test
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignorer les erreurs de nettoyage
    }
  });

  describe('stripBOM', () => {
    it('devrait supprimer le BOM UTF-8 d\'une chaîne', () => {
      const contentWithBOM = '\uFEFF{"test": "data"}';
      const result = stripBOM(contentWithBOM);
      expect(result).toBe('{"test": "data"}');
    });

    it('ne devrait pas modifier une chaîne sans BOM', () => {
      const contentWithoutBOM = '{"test": "data"}';
      const result = stripBOM(contentWithoutBOM);
      expect(result).toBe('{"test": "data"}');
    });

    it('devrait gérer une chaîne vide', () => {
      const result = stripBOM('');
      expect(result).toBe('');
    });

    it('devrait gérer une chaîne avec seulement le BOM', () => {
      const contentWithOnlyBOM = '\uFEFF';
      const result = stripBOM(contentWithOnlyBOM);
      expect(result).toBe('');
    });

    it('devrait préserver le reste du contenu après le BOM', () => {
      const contentWithBOM = '\uFEFF{"key": "value", "number": 42}';
      const result = stripBOM(contentWithBOM);
      expect(result).toBe('{"key": "value", "number": 42}');
    });
  });

  describe('readFileWithoutBOM', () => {
    it('devrait lire un fichier sans BOM', async () => {
      const content = await readFileWithoutBOM(testFile);
      const parsed = JSON.parse(content);
      expect(parsed).toEqual({ test: 'data', value: 123 });
    });

    it('devrait lire un fichier avec BOM et le supprimer', async () => {
      const content = await readFileWithoutBOM(testFileWithBOM);
      const parsed = JSON.parse(content);
      expect(parsed).toEqual({ test: 'data', value: 123 });
    });

    it('devrait lancer une erreur si le fichier n\'existe pas', async () => {
      const nonExistentFile = join(testDir, 'nonexistent.json');
      await expect(readFileWithoutBOM(nonExistentFile)).rejects.toThrow();
    });

    it('devrait utiliser l\'encodage spécifié', async () => {
      const content = await readFileWithoutBOM(testFile, 'utf-8');
      expect(typeof content).toBe('string');
    });
  });

  describe('readFileSyncWithoutBOM', () => {
    it('devrait lire un fichier sans BOM de manière synchrone', () => {
      const content = readFileSyncWithoutBOM(testFile);
      const parsed = JSON.parse(content);
      expect(parsed).toEqual({ test: 'data', value: 123 });
    });

    it('devrait lire un fichier avec BOM et le supprimer de manière synchrone', () => {
      const content = readFileSyncWithoutBOM(testFileWithBOM);
      const parsed = JSON.parse(content);
      expect(parsed).toEqual({ test: 'data', value: 123 });
    });

    it('devrait lancer une erreur si le fichier n\'existe pas', () => {
      const nonExistentFile = join(testDir, 'nonexistent.json');
      expect(() => readFileSyncWithoutBOM(nonExistentFile)).toThrow();
    });

    it('devrait utiliser l\'encodage spécifié', () => {
      const content = readFileSyncWithoutBOM(testFile, 'utf-8');
      expect(typeof content).toBe('string');
    });
  });

  describe('parseJSONWithoutBOM', () => {
    it('devrait parser du JSON sans BOM', () => {
      const jsonContent = '{"test": "data", "value": 123}';
      const result = parseJSONWithoutBOM(jsonContent);
      expect(result).toEqual({ test: 'data', value: 123 });
    });

    it('devrait parser du JSON avec BOM', () => {
      const jsonContentWithBOM = '\uFEFF{"test": "data", "value": 123}';
      const result = parseJSONWithoutBOM(jsonContentWithBOM);
      expect(result).toEqual({ test: 'data', value: 123 });
    });

    it('devrait lancer une erreur pour du JSON invalide', () => {
      const invalidJson = '{invalid json}';
      expect(() => parseJSONWithoutBOM(invalidJson)).toThrow(SyntaxError);
    });

    it('devrait supporter les types génériques', () => {
      interface TestData {
        test: string;
        value: number;
      }
      const jsonContent = '{"test": "data", "value": 123}';
      const result = parseJSONWithoutBOM<TestData>(jsonContent);
      expect(result.test).toBe('data');
      expect(result.value).toBe(123);
    });

    it('devrait parser des structures JSON complexes', () => {
      const complexJson = '\uFEFF{"nested": {"key": "value"}, "array": [1, 2, 3]}';
      const result = parseJSONWithoutBOM(complexJson);
      expect(result.nested.key).toBe('value');
      expect(result.array).toEqual([1, 2, 3]);
    });
  });

  describe('readJSONFileWithoutBOM', () => {
    it('devrait lire et parser un fichier JSON sans BOM', async () => {
      const result = await readJSONFileWithoutBOM(testFile);
      expect(result).toEqual({ test: 'data', value: 123 });
    });

    it('devrait lire et parser un fichier JSON avec BOM', async () => {
      const result = await readJSONFileWithoutBOM(testFileWithBOM);
      expect(result).toEqual({ test: 'data', value: 123 });
    });

    it('devrait lancer une erreur si le fichier n\'existe pas', async () => {
      const nonExistentFile = join(testDir, 'nonexistent.json');
      await expect(readJSONFileWithoutBOM(nonExistentFile)).rejects.toThrow();
    });

    it('devrait lancer une erreur pour du JSON invalide', async () => {
      const invalidJsonFile = join(testDir, 'invalid.json');
      await fs.writeFile(invalidJsonFile, '{invalid json}', 'utf-8');
      await expect(readJSONFileWithoutBOM(invalidJsonFile)).rejects.toThrow(SyntaxError);
    });

    it('devrait supporter les types génériques', async () => {
      interface TestData {
        test: string;
        value: number;
      }
      const result = await readJSONFileWithoutBOM<TestData>(testFile);
      expect(result.test).toBe('data');
      expect(result.value).toBe(123);
    });
  });

  describe('readJSONFileSyncWithoutBOM', () => {
    it('devrait lire et parser un fichier JSON sans BOM de manière synchrone', () => {
      const result = readJSONFileSyncWithoutBOM(testFile);
      expect(result).toEqual({ test: 'data', value: 123 });
    });

    it('devrait lire et parser un fichier JSON avec BOM de manière synchrone', () => {
      const result = readJSONFileSyncWithoutBOM(testFileWithBOM);
      expect(result).toEqual({ test: 'data', value: 123 });
    });

    it('devrait lancer une erreur si le fichier n\'existe pas', () => {
      const nonExistentFile = join(testDir, 'nonexistent.json');
      expect(() => readJSONFileSyncWithoutBOM(nonExistentFile)).toThrow();
    });

    it('devrait lancer une erreur pour du JSON invalide', () => {
      const invalidJsonFile = join(testDir, 'invalid.json');
      writeFileSync(invalidJsonFile, '{invalid json}', 'utf-8');
      expect(() => readJSONFileSyncWithoutBOM(invalidJsonFile)).toThrow(SyntaxError);
    });

    it('devrait supporter les types génériques', () => {
      interface TestData {
        test: string;
        value: number;
      }
      const result = readJSONFileSyncWithoutBOM<TestData>(testFile);
      expect(result.test).toBe('data');
      expect(result.value).toBe(123);
    });
  });

  describe('Cas d\'intégration', () => {
    it('devrait gérer un fichier JSON réel avec BOM UTF-8', async () => {
      const realWorldFile = join(testDir, 'real-world.json');
      const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
      const realWorldContent = Buffer.concat([
        bom,
        Buffer.from(JSON.stringify({
          config: {
            name: 'test-config',
            version: '1.0.0',
            settings: {
              enabled: true,
              timeout: 5000
            }
          }
        }), 'utf-8')
      ]);
      await fs.writeFile(realWorldFile, realWorldContent);

      const result = await readJSONFileWithoutBOM(realWorldFile);
      expect(result.config.name).toBe('test-config');
      expect(result.config.settings.enabled).toBe(true);
    });

    it('devrait gérer des fichiers avec des caractères Unicode', async () => {
      const unicodeFile = join(testDir, 'unicode.json');
      const unicodeContent = JSON.stringify({
        message: 'Bonjour 世界 🌍',
        emoji: '🚀 🎉',
        special: 'éàüç'
      });
      await fs.writeFile(unicodeFile, unicodeContent, 'utf-8');

      const result = await readJSONFileWithoutBOM(unicodeFile);
      expect(result.message).toBe('Bonjour 世界 🌍');
      expect(result.emoji).toBe('🚀 🎉');
      expect(result.special).toBe('éàüç');
    });

    it('devrait gérer des fichiers avec BOM et caractères Unicode', async () => {
      const unicodeBomFile = join(testDir, 'unicode-bom.json');
      const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
      const unicodeContent = Buffer.concat([
        bom,
        Buffer.from(JSON.stringify({
          message: 'Café ☕',
          symbols: '© ® ™'
        }), 'utf-8')
      ]);
      await fs.writeFile(unicodeBomFile, unicodeContent);

      const result = await readJSONFileWithoutBOM(unicodeBomFile);
      expect(result.message).toBe('Café ☕');
      expect(result.symbols).toBe('© ® ™');
    });
  });
});
