/**
 * Tests d'intégration pour handleTouchMcpSettings
 *
 * Couvre la mise à jour du timestamp de mcp_settings.json :
 * - Structure de répertoires réelle (mimant APPDATA)
 * - Fichier réel créé sur disque
 * - Modification de timestamp via fs.utimes
 * - Gestion d'erreurs (fichier inexistant)
 *
 * Framework: Vitest
 * Type: Intégration (filesystem réel, pas de mocks fs/promises)
 *
 * @module utils/touch-mcp-settings.integration.test
 * @version 1.0.0 (#564 Phase 3)
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync, mkdirSync, writeFileSync, statSync } from 'fs';
import { join } from 'path';
import { handleTouchMcpSettings } from '../server-helpers.js';

describe('handleTouchMcpSettings (integration)', () => {
  const originalAppdata = process.env.APPDATA;
  // APPDATA pointe vers testSettingsBase, l'outil ajoute "Code/User/globalStorage/..."
  const testSettingsBase = join(__dirname, '../../../__test-data__/mcp-settings-integration');

  beforeEach(() => {
    // Créer la structure de test
    // %APPDATA%/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json
    const codeDir = join(testSettingsBase, 'Code');
    const userDir = join(codeDir, 'User');
    const globalStorageDir = join(userDir, 'globalStorage');
    const rooDir = join(globalStorageDir, 'rooveterinaryinc.roo-cline');
    const settingsDir = join(rooDir, 'settings');

    for (const dir of [testSettingsBase, codeDir, userDir, globalStorageDir, rooDir, settingsDir]) {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }

    // Créer un fichier mcp_settings.json avec du contenu
    const settingsPath = join(settingsDir, 'mcp_settings.json');
    writeFileSync(settingsPath, JSON.stringify({ mcpServers: {}, test: true }, null, 2));

    // Configurer APPDATA pour pointer vers notre test directory
    process.env.APPDATA = testSettingsBase;
  });

  afterEach(() => {
    // Restaurer APPDATA original
    process.env.APPDATA = originalAppdata;

    // Nettoyer les fichiers de test (y compris Code directory)
    if (existsSync(testSettingsBase)) {
      rmSync(testSettingsBase, { recursive: true, force: true });
    }
  });

  // ============================================================
  // Tests de base
  // ============================================================

  describe('basic functionality', () => {
    test('should touch the mcp_settings.json file successfully', async () => {
      const settingsPath = join(testSettingsBase, 'Code', 'User', 'globalStorage', 'rooveterinaryinc.roo-cline', 'settings', 'mcp_settings.json');

      // Obtenir le timestamp avant
      const statsBefore = statSync(settingsPath);
      const mtimeBefore = statsBefore.mtimeMs;

      // Attendre un petit moment pour garantir différence de timestamp
      await new Promise(resolve => setTimeout(resolve, 100));

      // Toucher le fichier
      const result = await handleTouchMcpSettings();

      // Vérifier le résultat
      // Note: isError n'est pas défini en cas de succès (implicite false)
      // Seuls les cas d'erreur définissent isError: true
      expect(result.isError).toBeUndefined();
      expect(result.content).toHaveLength(1);

      const text = (result.content[0] as any).text;
      const parsed = JSON.parse(text);

      expect(parsed.success).toBe(true);
      expect(parsed.message).toContain('touché avec succès');
      expect(parsed.path).toContain('mcp_settings.json');

      // Vérifier que le timestamp a changé
      const statsAfter = statSync(settingsPath);
      const mtimeAfter = statsAfter.mtimeMs;

      expect(mtimeAfter).toBeGreaterThan(mtimeBefore);
    });

    test('should return error when mcp_settings.json does not exist', async () => {
      // Supprimer le fichier créé par beforeEach
      const settingsDir = join(testSettingsBase, 'Code', 'User', 'globalStorage', 'rooveterinaryinc.roo-cline', 'settings');
      const settingsPath = join(settingsDir, 'mcp_settings.json');
      if (existsSync(settingsPath)) {
        rmSync(settingsPath);
      }

      // Tenter de toucher un fichier inexistant
      const result = await handleTouchMcpSettings();

      // Vérifier l'erreur
      expect(result.isError).toBe(true);
      expect(result.content).toHaveLength(1);

      const text = (result.content[0] as any).text;
      const parsed = JSON.parse(text);

      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('Fichier mcp_settings.json introuvable');
    });

    test('should work when APPDATA is not set (fallback to homedir)', async () => {
      // SAFETY: Save and restore APPDATA immediately.
      // Never leave APPDATA deleted — other parallel tests may write to the REAL
      // mcp_settings.json if APPDATA is unset (incident 2026-03-08, 2026-04-03).
      const savedAppdata = process.env.APPDATA;
      try {
        delete process.env.APPDATA;

        // handleTouchMcpSettings should not crash — it will try homedir fallback
        const result = await handleTouchMcpSettings();

        // Should return an error (file not found in homedir path)
        expect(result).toBeDefined();
        expect(result.content).toHaveLength(1);
      } finally {
        // ALWAYS restore — even if the test fails
        process.env.APPDATA = savedAppdata;
      }
    });
  });

  // ============================================================
  // Tests de structure
  // ============================================================

  describe('path resolution', () => {
    test('should resolve correct path from APPDATA', async () => {
      const result = await handleTouchMcpSettings();

      const text = (result.content[0] as any).text;
      const parsed = JSON.parse(text);

      // Le chemin doit contenir les composants attendus
      expect(parsed.path).toContain('Code');
      expect(parsed.path).toContain('User');
      expect(parsed.path).toContain('globalStorage');
      expect(parsed.path).toContain('rooveterinaryinc.roo-cline');
      expect(parsed.path).toContain('settings');
      expect(parsed.path).toContain('mcp_settings.json');
    });
  });

  // ============================================================
  // Tests de format de réponse
  // ============================================================

  describe('response format', () => {
    test('should return valid JSON response', async () => {
      const result = await handleTouchMcpSettings();

      const text = (result.content[0] as any).text;

      // Doit être du JSON valide
      expect(() => JSON.parse(text)).not.toThrow();

      const parsed = JSON.parse(text);
      expect(parsed).toHaveProperty('success');
      expect(parsed).toHaveProperty('message');
      expect(parsed).toHaveProperty('path');
    });

    test('should include ISO timestamp in success message', async () => {
      const result = await handleTouchMcpSettings();

      const text = (result.content[0] as any).text;
      const parsed = JSON.parse(text);

      // Le message doit contenir un timestamp ISO
      expect(parsed.message).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z/);
    });
  });

  // ============================================================
  // Tests d'erreur
  // ============================================================

  describe('error handling', () => {
    test('should return isError=true when file not found', async () => {
      // Supprimer le fichier
      const settingsPath = join(testSettingsBase, 'Code', 'User', 'globalStorage', 'rooveterinaryinc.roo-cline', 'settings', 'mcp_settings.json');
      if (existsSync(settingsPath)) {
        rmSync(settingsPath);
      }

      const result = await handleTouchMcpSettings();

      expect(result.isError).toBe(true);
    });

    test('should return structured error response', async () => {
      // Supprimer le fichier
      const settingsPath = join(testSettingsBase, 'Code', 'User', 'globalStorage', 'rooveterinaryinc.roo-cline', 'settings', 'mcp_settings.json');
      if (existsSync(settingsPath)) {
        rmSync(settingsPath);
      }

      const result = await handleTouchMcpSettings();

      const text = (result.content[0] as any).text;
      const parsed = JSON.parse(text);

      expect(parsed).toHaveProperty('success', false);
      expect(parsed).toHaveProperty('error');
      expect(typeof parsed.error).toBe('string');
      expect(parsed.error.length).toBeGreaterThan(0);
    });
  });
});
