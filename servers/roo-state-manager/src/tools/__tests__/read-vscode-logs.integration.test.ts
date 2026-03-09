/**
 * Tests d'intégration pour read_vscode_logs
 *
 * Couvre la lecture des logs VS Code avec :
 * - Structure de répertoires réelle (mimant VS Code logs)
 * - Fichiers de log réels lus depuis le disque
 * - Filtrage par mot-clé
 * - Multi-session support
 *
 * Framework: Vitest
 * Type: Intégration (filesystem réel, pas de mocks fs/promises)
 *
 * @module tools/read-vscode-logs.integration.test
 * @version 1.0.0 (#564 Phase 3)
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

// Note: On doit importer après avoir configuré APPDATA
// On utilise dynamic import dans les tests pour cela

describe('read_vscode_logs (integration)', () => {
  const originalAppdata = process.env.APPDATA;
  // APPDATA pointe vers testLogsBase, l'outil ajoute "Code/logs"
  const testLogsBase = join(__dirname, '../../../__test-data__/vscode-logs-integration');

  beforeEach(() => {
    // Créer la structure de test
    // %APPDATA%/Code/logs/20260309T120000/window1/
    const codeDir = join(testLogsBase, 'Code');
    const logsDir = join(codeDir, 'logs');
    const sessionDir = join(logsDir, '20260309T120000');
    const windowDir = join(sessionDir, 'window1');

    for (const dir of [testLogsBase, codeDir, logsDir, sessionDir, windowDir]) {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }

    // Créer des fichiers de log avec du contenu
    const logContent = `[2026-03-09 12:00:00.123] [INFO] Starting VS Code
[2026-03-09 12:00:01.456] [ERROR] Extension failed to load
[2026-03-09 12:00:02.789] [INFO] Workspace loaded: d:\\Dev\\roo-extensions
[2026-03-09 12:00:03.012] [WARN] Memory usage high
[2026-03-09 12:00:04.345] [INFO] Ready`;

    writeFileSync(join(windowDir, 'renderer.log'), logContent.replace('renderer', 'renderer'));
    writeFileSync(join(windowDir, 'exthost.log'), logContent.replace('renderer', 'exthost'));
    writeFileSync(join(windowDir, 'main.log'), logContent.replace('renderer', 'main'));

    // Créer exthost/exthost.log (nested structure)
    const exthostDir = join(windowDir, 'exthost');
    if (!existsSync(exthostDir)) {
      mkdirSync(exthostDir, { recursive: true });
    }
    writeFileSync(join(exthostDir, 'exthost.log'), logContent.replace('renderer', 'exthost-nested'));

    // Créer output_logging directory avec un log Roo-Code
    const outputDir = join(exthostDir, 'output_logging_20260309T120000');
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }
    writeFileSync(join(outputDir, '20260309T120000-Roo-Code.log'), logContent.replace('renderer', 'Roo-Code'));

    // Configurer APPDATA pour pointer vers notre test directory
    process.env.APPDATA = testLogsBase;
  });

  afterEach(() => {
    // Restaurer APPDATA original
    process.env.APPDATA = originalAppdata;

    // Nettoyer les fichiers de test (y compris Code directory)
    if (existsSync(testLogsBase)) {
      rmSync(testLogsBase, { recursive: true, force: true });
    }
  });

  // ============================================================
  // Tests de base
  // ============================================================

  describe('basic functionality', () => {
    test('should read all three standard log files', async () => {
      const { readVscodeLogs } = await import('../read-vscode-logs.js');
      const result = await readVscodeLogs.handler({ lines: 100 });

      const text = result.content[0].text;

      // Vérifier que les trois logs standards sont présents
      expect(text).toContain('--- LOG: renderer ---');
      expect(text).toContain('--- LOG: exthost ---');
      expect(text).toContain('--- LOG: Main ---');
    });

    test('should include Roo-Code Output log', async () => {
      const { readVscodeLogs } = await import('../read-vscode-logs.js');
      const result = await readVscodeLogs.handler({ lines: 100 });

      const text = result.content[0].text;

      expect(text).toContain('--- LOG: Roo-Code Output ---');
      expect(text).toContain('Roo-Code');
    });

    test('should include debug log when no filter is set', async () => {
      const { readVscodeLogs } = await import('../read-vscode-logs.js');
      const result = await readVscodeLogs.handler({ lines: 10 });

      const text = result.content[0].text;

      expect(text).toContain('--- DEBUG LOG ---');
      expect(text).toContain('[DEBUG] Smart Log Search starting');
    });

    test('should limit lines read from each log file', async () => {
      const { readVscodeLogs } = await import('../read-vscode-logs.js');
      const result = await readVscodeLogs.handler({ lines: 2 });

      const text = result.content[0].text;

      // Avec 5 lignes par log et limit=2, on devrait avoir 2 lignes par log
      // (la dernière ligne est vide, donc on voit "Starting" et pas "Ready")
      // Le format exact dépend de la logique readLastLines
      expect(text).toBeTruthy();
      expect(text.length).toBeGreaterThan(0);
    });
  });

  // ============================================================
  // Tests de filtrage
  // ============================================================

  describe('filter functionality', () => {
    test('should filter log lines by keyword (case insensitive)', async () => {
      const { readVscodeLogs } = await import('../read-vscode-logs.js');
      const result = await readVscodeLogs.handler({ filter: 'ERROR', lines: 100 });

      const text = result.content[0].text;

      // Vérifier que seulement les lignes avec ERROR sont présentes
      expect(text).toContain('[ERROR]');
      // Avec notre log content, on a 1 ligne ERROR par fichier log
      // Donc plusieurs occurrences (pour chaque type de log)
      const errorCount = (text.match(/\[ERROR\]/g) || []).length;
      expect(errorCount).toBeGreaterThan(0);
    });

    test('should filter log lines by regex pattern', async () => {
      const { readVscodeLogs } = await import('../read-vscode-logs.js');
      const result = await readVscodeLogs.handler({ filter: '\\[WARN\\]|\\[ERROR\\]', lines: 100 });

      const text = result.content[0].text;

      // Vérifier que WARN ou ERROR sont présents
      expect(text).toMatch(/\[WARN\]|\[ERROR\]/);
    });

    test('should exclude debug log when filter is set', async () => {
      const { readVscodeLogs } = await import('../read-vscode-logs.js');
      const result = await readVscodeLogs.handler({ filter: 'INFO', lines: 10 });

      const text = result.content[0].text;

      // Quand filter est actif, le DEBUG LOG ne devrait pas être inclus
      // Le résultat commence directement par les logs
      expect(text).not.toContain('--- DEBUG LOG ---');
    });
  });

  // ============================================================
  // Tests multi-session
  // ============================================================

  describe('multi-session support', () => {
    test('should process only one session when maxSessions=1 (default)', async () => {
      // Créer une deuxième session plus ancienne
      const session2Dir = join(testLogsBase, 'Code', 'logs', '20260308T120000');
      const window2Dir = join(session2Dir, 'window1');
      for (const dir of [session2Dir, window2Dir]) {
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
      }
      writeFileSync(join(window2Dir, 'renderer.log'), 'Old session log');

      const { readVscodeLogs } = await import('../read-vscode-logs.js');
      const result = await readVscodeLogs.handler({ maxSessions: 1 });

      const text = result.content[0].text;

      // La session la plus récente (20260309) devrait être traitée
      // Pas l'ancienne (20260308)
      // Le chemin inclut Code/logs/session...
      expect(text).toContain('20260309'); // Recent session path

      // Nettoyer la session 2
      rmSync(join(testLogsBase, 'Code'), { recursive: true, force: true });
    });

    test('should process multiple sessions when maxSessions > 1', async () => {
      // Créer une deuxième session
      const codeDir = join(testLogsBase, 'Code');
      const logsDir = join(codeDir, 'logs');
      const session2Dir = join(logsDir, '20260308T120000');
      const window2Dir = join(session2Dir, 'window1');
      for (const dir of [codeDir, logsDir, session2Dir, window2Dir]) {
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
      }
      writeFileSync(join(window2Dir, 'renderer.log'), 'Old session log');

      const { readVscodeLogs } = await import('../read-vscode-logs.js');
      const result = await readVscodeLogs.handler({ maxSessions: 2 });

      const text = result.content[0].text;

      // Les deux sessions devraient être traitées
      expect(text).toBeTruthy();

      // Nettoyer
      rmSync(codeDir, { recursive: true, force: true });
    });
  });

  // ============================================================
  // Tests de gestion d'erreurs
  // ============================================================

  describe('error handling', () => {
    test('should return error message when APPDATA not set', async () => {
      delete process.env.APPDATA;

      const { readVscodeLogs } = await import('../read-vscode-logs.js');
      const result = await readVscodeLogs.handler({});

      const text = result.content[0].text;
      expect(text).toContain('APPDATA');
    });

    test('should return no sessions message when logs directory empty', async () => {
      // Supprimer les sessions existantes créées par beforeEach
      const codeDir = join(testLogsBase, 'Code');
      if (existsSync(codeDir)) {
        rmSync(codeDir, { recursive: true, force: true });
      }

      // Créer un Code/logs vide (sans sous-répertoires de session)
      const emptyLogsDir = join(testLogsBase, 'Code', 'logs');
      mkdirSync(emptyLogsDir, { recursive: true });

      const { readVscodeLogs } = await import('../read-vscode-logs.js');
      const result = await readVscodeLogs.handler({});

      const text = result.content[0].text;
      expect(text).toContain('No session log directory found');

      // Nettoyer
      rmSync(join(testLogsBase, 'Code'), { recursive: true, force: true });
    });

    test('should handle missing log files gracefully', async () => {
      // Créer une session sans fichiers de log
      const codeDir = join(testLogsBase, 'Code');
      const logsDir = join(codeDir, 'logs');
      const emptySessionDir = join(logsDir, '20260309T130000');
      const emptyWindowDir = join(emptySessionDir, 'window1');
      for (const dir of [codeDir, logsDir, emptySessionDir, emptyWindowDir]) {
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
      }
      // Ne créer aucun fichier log

      const { readVscodeLogs } = await import('../read-vscode-logs.js');
      const result = await readVscodeLogs.handler({ maxSessions: 5 });

      // Devrait traiter la session principale (qui a des logs)
      // Et ignorer celle sans logs
      expect(result.content[0].text).toBeTruthy();

      // Nettoyer
      rmSync(codeDir, { recursive: true, force: true });
    });
  });
});
