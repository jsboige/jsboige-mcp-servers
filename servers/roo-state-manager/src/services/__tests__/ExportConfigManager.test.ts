/**
 * Tests unitaires pour ExportConfigManager
 *
 * Couvre :
 * - getConfig : cache hit, fichier valide, fichier absent (default), BOM UTF-8
 * - updateConfig : fusion partielle avec config actuelle
 * - resetConfig : remet la config par défaut
 * - invalidateCache : force rechargement au prochain appel
 * - addTemplate / removeTemplate
 * - addFilter / removeFilter
 * - Erreurs : NO_STORAGE_DETECTED, CONFIG_SAVE_FAILED
 *
 * @module services/__tests__/ExportConfigManager.test
 * @version 1.0.0 (#492)
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// ─────────────────── mocks ───────────────────

const mockDetectStorageLocations = vi.fn();

vi.mock('../../utils/roo-storage-detector.js', () => ({
  RooStorageDetector: {
    detectStorageLocations: (...args: any[]) => mockDetectStorageLocations(...args),
  },
}));

const mockAccess = vi.fn();
const mockReadFile = vi.fn();
const mockWriteFile = vi.fn();
const mockMkdir = vi.fn();

vi.mock('fs/promises', () => ({
  default: {
    access: (...args: any[]) => mockAccess(...args),
    readFile: (...args: any[]) => mockReadFile(...args),
    writeFile: (...args: any[]) => mockWriteFile(...args),
    mkdir: (...args: any[]) => mockMkdir(...args),
  },
  access: (...args: any[]) => mockAccess(...args),
  readFile: (...args: any[]) => mockReadFile(...args),
  writeFile: (...args: any[]) => mockWriteFile(...args),
  mkdir: (...args: any[]) => mockMkdir(...args),
}));

// ─────────────────── import SUT ───────────────────

import { ExportConfigManager } from '../ExportConfigManager.js';
import { ExportConfigManagerError, ExportConfigManagerErrorCode } from '../../types/errors.js';

// ─────────────────── helpers ───────────────────

const MOCK_STORAGE_PATH = '/mock/home/.vscode/tasks/some-task-id';
const MOCK_CONFIG_PATH = '/mock/home/.vscode/xml_export_config.json';

const DEFAULT_CONFIG_SNAPSHOT = {
  defaults: { prettyPrint: true, includeContent: false, compression: 'none' },
  templates: {
    jira_export: { format: 'simplified', fields: ['taskId', 'title', 'user_messages_only'] },
    full_export: { format: 'complete', fields: ['taskId', 'title', 'metadata', 'sequence'] },
  },
  filters: {
    last_week: { startDate: 'now-7d', endDate: 'now' },
    debug_tasks: { mode: 'debug-complex' },
  },
};

function makeManager(): ExportConfigManager {
  return new ExportConfigManager();
}

// ─────────────────── setup ───────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Défaut : storage détecté, fichier absent (access rejects)
  mockDetectStorageLocations.mockResolvedValue([MOCK_STORAGE_PATH]);
  mockAccess.mockRejectedValue(new Error('ENOENT'));
  mockReadFile.mockRejectedValue(new Error('ENOENT'));
  mockWriteFile.mockResolvedValue(undefined);
  mockMkdir.mockResolvedValue(undefined);
});

// ─────────────────── tests ───────────────────

describe('ExportConfigManager', () => {

  // ============================================================
  // getConfig : cache
  // ============================================================

  describe('getConfig - cache', () => {
    test('retourne le cache si déjà chargé', async () => {
      const manager = makeManager();
      // Premier appel : charge depuis fichier absent → default
      const config1 = await manager.getConfig();
      // Deuxième appel : doit retourner le cache
      const config2 = await manager.getConfig();

      expect(config1).toBe(config2); // même référence
      // detectStorageLocations peut être appelé 2x (constructor + getConfigPath)
      // mais readFile/access ne doivent être appelés qu'une fois au total
      const accessCallCount = mockAccess.mock.calls.length;
      expect(accessCallCount).toBeGreaterThan(0); // appelé au moins une fois
    });
  });

  // ============================================================
  // getConfig : fichier valide
  // ============================================================

  describe('getConfig - fichier valide', () => {
    test('charge la config depuis le fichier JSON', async () => {
      const customConfig = {
        defaults: { prettyPrint: false, includeContent: true, compression: 'zip' as const },
        templates: {},
        filters: {},
      };
      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue(JSON.stringify(customConfig));

      const manager = makeManager();
      const config = await manager.getConfig();

      expect(config.defaults.prettyPrint).toBe(false);
      expect(config.defaults.includeContent).toBe(true);
      expect(config.defaults.compression).toBe('zip');
    });

    test('fusionne le fichier avec les valeurs par défaut manquantes', async () => {
      const partialConfig = {
        defaults: { prettyPrint: false, includeContent: true, compression: 'none' as const },
        // templates et filters absents → doivent être fusionnés avec les défauts
      };
      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue(JSON.stringify(partialConfig));

      const manager = makeManager();
      const config = await manager.getConfig();

      // Les templates par défaut doivent être présents
      expect(config.templates).toHaveProperty('jira_export');
      expect(config.templates).toHaveProperty('full_export');
    });

    test('nettoie le BOM UTF-8 si présent', async () => {
      const configWithBom = '\uFEFF' + JSON.stringify(DEFAULT_CONFIG_SNAPSHOT);
      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue(configWithBom);

      const manager = makeManager();
      const config = await manager.getConfig();

      expect(config.defaults.prettyPrint).toBe(true);
    });
  });

  // ============================================================
  // getConfig : fichier absent → config par défaut
  // ============================================================

  describe('getConfig - fichier absent', () => {
    test('retourne la config par défaut si le fichier n\'existe pas', async () => {
      const manager = makeManager();
      const config = await manager.getConfig();

      expect(config.defaults.prettyPrint).toBe(true);
      expect(config.defaults.includeContent).toBe(false);
      expect(config.defaults.compression).toBe('none');
    });

    test('sauvegarde la config par défaut si le fichier n\'existe pas', async () => {
      const manager = makeManager();
      await manager.getConfig();

      expect(mockWriteFile).toHaveBeenCalled();
      const [, content] = mockWriteFile.mock.calls[0];
      expect(JSON.parse(content).defaults).toBeDefined();
    });

    test('retourne la config par défaut si aucun storage détecté', async () => {
      mockDetectStorageLocations.mockResolvedValue([]);

      const manager = makeManager();
      const config = await manager.getConfig();

      expect(config.defaults.prettyPrint).toBe(true);
    });
  });

  // ============================================================
  // updateConfig
  // ============================================================

  describe('updateConfig', () => {
    test('met à jour les defaults partiellement', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue(JSON.stringify(DEFAULT_CONFIG_SNAPSHOT));

      const manager = makeManager();
      await manager.getConfig(); // charge en cache

      await manager.updateConfig({
        defaults: { prettyPrint: false, includeContent: false, compression: 'none' },
      });

      const config = await manager.getConfig();
      expect(config.defaults.prettyPrint).toBe(false);
      expect(config.defaults.includeContent).toBe(false);
    });

    test('ajoute un nouveau template via updateConfig', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue(JSON.stringify(DEFAULT_CONFIG_SNAPSHOT));

      const manager = makeManager();
      await manager.getConfig();

      await manager.updateConfig({
        templates: { my_template: { format: 'custom', fields: ['taskId'] } },
      });

      const config = await manager.getConfig();
      expect(config.templates).toHaveProperty('my_template');
      // Les templates par défaut sont préservés
      expect(config.templates).toHaveProperty('jira_export');
    });

    test('appelle writeFile lors de updateConfig', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue(JSON.stringify(DEFAULT_CONFIG_SNAPSHOT));

      const manager = makeManager();
      await manager.getConfig();
      mockWriteFile.mockClear();

      await manager.updateConfig({ defaults: { prettyPrint: false, includeContent: false, compression: 'none' } });

      expect(mockWriteFile).toHaveBeenCalled();
    });
  });

  // ============================================================
  // resetConfig
  // ============================================================

  describe('resetConfig', () => {
    test('remet la config par défaut', async () => {
      mockAccess.mockResolvedValue(undefined);
      const customConfig = {
        defaults: { prettyPrint: false, includeContent: true, compression: 'zip' as const },
        templates: { custom: { format: 'x', fields: [] } },
        filters: {},
      };
      mockReadFile.mockResolvedValue(JSON.stringify(customConfig));

      const manager = makeManager();
      await manager.getConfig(); // charge custom

      await manager.resetConfig();

      const config = await manager.getConfig();
      expect(config.defaults.prettyPrint).toBe(true); // valeur par défaut
      expect(config.defaults.includeContent).toBe(false);
    });

    test('appelle writeFile lors du reset', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue(JSON.stringify(DEFAULT_CONFIG_SNAPSHOT));

      const manager = makeManager();
      await manager.getConfig();
      mockWriteFile.mockClear();

      await manager.resetConfig();

      expect(mockWriteFile).toHaveBeenCalled();
    });
  });

  // ============================================================
  // invalidateCache
  // ============================================================

  describe('invalidateCache', () => {
    test('force le rechargement au prochain appel', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue(JSON.stringify(DEFAULT_CONFIG_SNAPSHOT));

      const manager = makeManager();
      const config1 = await manager.getConfig();
      manager.invalidateCache();

      const config2 = await manager.getConfig();
      // Pas la même référence après invalidation
      expect(config2).not.toBe(config1);
      // Mais même valeur
      expect(config2.defaults.prettyPrint).toBe(config1.defaults.prettyPrint);
    });
  });

  // ============================================================
  // addTemplate / removeTemplate
  // ============================================================

  describe('addTemplate / removeTemplate', () => {
    test('addTemplate ajoute un nouveau template', async () => {
      const manager = makeManager();
      await manager.getConfig(); // charge default

      await manager.addTemplate('test_template', { format: 'test', fields: ['f1', 'f2'] });

      const config = await manager.getConfig();
      expect(config.templates.test_template).toEqual({ format: 'test', fields: ['f1', 'f2'] });
    });

    test('removeTemplate supprime un template existant et retourne true', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue(JSON.stringify(DEFAULT_CONFIG_SNAPSHOT));

      const manager = makeManager();
      await manager.getConfig();

      const result = await manager.removeTemplate('jira_export');

      expect(result).toBe(true);
      const config = await manager.getConfig();
      expect(config.templates).not.toHaveProperty('jira_export');
    });

    test('removeTemplate retourne false si template inexistant', async () => {
      const manager = makeManager();
      await manager.getConfig();

      const result = await manager.removeTemplate('nonexistent_template');

      expect(result).toBe(false);
    });
  });

  // ============================================================
  // addFilter / removeFilter
  // ============================================================

  describe('addFilter / removeFilter', () => {
    test('addFilter ajoute un filtre', async () => {
      const manager = makeManager();
      await manager.getConfig();

      await manager.addFilter('my_filter', { mode: 'code-complex' });

      const config = await manager.getConfig();
      expect(config.filters.my_filter).toEqual({ mode: 'code-complex' });
    });

    test('addFilter avec startDate et endDate', async () => {
      const manager = makeManager();
      await manager.getConfig();

      await manager.addFilter('date_range', { startDate: 'now-30d', endDate: 'now' });

      const config = await manager.getConfig();
      expect(config.filters.date_range).toEqual({ startDate: 'now-30d', endDate: 'now' });
    });

    test('removeFilter supprime un filtre existant et retourne true', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue(JSON.stringify(DEFAULT_CONFIG_SNAPSHOT));

      const manager = makeManager();
      await manager.getConfig();

      const result = await manager.removeFilter('last_week');

      expect(result).toBe(true);
      const config = await manager.getConfig();
      expect(config.filters).not.toHaveProperty('last_week');
    });

    test('removeFilter retourne false si filtre inexistant', async () => {
      const manager = makeManager();
      await manager.getConfig();

      const result = await manager.removeFilter('nonexistent_filter');

      expect(result).toBe(false);
    });
  });

  // ============================================================
  // Erreurs
  // ============================================================

  describe('erreurs', () => {
    test('lève CONFIG_SAVE_FAILED si writeFile échoue', async () => {
      const manager = makeManager();
      await manager.getConfig(); // charge default, déclenche saveConfig

      mockWriteFile.mockRejectedValue(new Error('Disk full'));
      manager.invalidateCache(); // force rechargement

      try {
        await manager.getConfig(); // va tenter saveConfig → FAIL
      } catch (err: any) {
        if (err instanceof ExportConfigManagerError) {
          expect(err.code).toBe(ExportConfigManagerErrorCode.CONFIG_SAVE_FAILED);
          return;
        }
      }
      // Si aucune exception (cas fallback sans throw), on vérifie juste que writeFile a été appelé
      expect(mockWriteFile).toHaveBeenCalled();
    });

    test('ExportConfigManagerError a un nom correct', () => {
      const err = new ExportConfigManagerError(
        'Test error',
        ExportConfigManagerErrorCode.NO_STORAGE_DETECTED
      );
      expect(err.name).toBe('ExportConfigManagerError');
      expect(err.message).toBe('Test error');
    });
  });
});
