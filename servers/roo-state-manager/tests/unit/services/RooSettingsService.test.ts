/**
 * Tests pour RooSettingsService
 *
 * Ce service gère la lecture/écriture des paramètres Roo Code depuis state.vscdb,
 * avec gestion des paramètres synchronisables exclus.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
    RooSettingsService,
    type FilterMode,
    type RooSettingsExtract,
    type InjectOptions,
    type InjectResult,
    SYNC_SAFE_KEYS,
    EXCLUDED_KEYS
} from '../../../src/services/RooSettingsService.js';
import { existsSync, copyFileSync } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import sqlite3 from 'sqlite3';
import { promises as fs } from 'fs';

// Mock des dépendances
vi.mock('fs');
vi.mock('fs/promises');
vi.mock('sqlite3');

// Mock du logger
vi.mock('../../../src/utils/logger.js', () => ({
    createLogger: vi.fn(() => ({
        info: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    }))
}));

describe('RooSettingsService', () => {
  let service: RooSettingsService;
  let mockDb: any;
  let mockExistsSync: any;
  let mockCopyFileSync: any;

  beforeEach(() => {
    service = new RooSettingsService();
    mockDb = {
      get: vi.fn(),
      run: vi.fn(),
      close: vi.fn()
    };
    mockExistsSync = vi.mocked(existsSync);
    mockCopyFileSync = vi.mocked(copyFileSync);

    // Mock sqlite3
    vi.mocked(sqlite3.Database).mockImplementation((path: string, mode: number, callback: any) => {
      setImmediate(() => callback(null));
      return mockDb as any;
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('initialisation', () => {
    it('devrait initialiser correctement', () => {
      expect(service).toBeInstanceOf(RooSettingsService);
    });

    it('devrait retourner le chemin correct de state.vscdb', () => {
      const path = service.getStateDbPath();
      expect(path).toContain(join('AppData', 'Roaming', 'Code', 'User', 'globalStorage', 'state.vscdb'));
      expect(path).toContain(homedir());
    });
  });

  describe('isAvailable', () => {
    it('devrait retourner true si state.vscdb existe', () => {
      mockExistsSync.mockReturnValue(true);
      expect(service.isAvailable()).toBe(true);
    });

    it('devrait retourner false si state.vscdb n\'existe pas', () => {
      mockExistsSync.mockReturnValue(false);
      expect(service.isAvailable()).toBe(false);
    });
  });

  describe('extractSettings', () => {
    beforeEach(() => {
      mockExistsSync.mockReturnValue(true);
      vi.mocked(fs.unlink).mockResolvedValue();
    });

    it('devrait extraire les paramètres en mode safe', async () => {
      // Mock la lecture de la base de données
      mockDb.get.mockImplementation((sql: string, params: any[], callback: any) => {
        setImmediate(() => {
          callback(null, { value: JSON.stringify({
            autoCondenseContext: true,
            customModes: [],
            // Clés incluses
            apiProvider: 'openai',
            // Clés exclues
            id: 'machine-123'
          }) });
        });
      });

      const result = await service.extractSettings('safe');

      expect(result.metadata.mode).toBe('safe');
      expect(result.metadata.keysCount).toBeGreaterThan(0);
      expect(result.settings.apiProvider).toBe('openai');
      expect(result.settings.id).toBeUndefined(); // Exclue
    });

    it('devrait extraire tous les paramètres en mode full', async () => {
      mockDb.get.mockImplementation((sql: string, params: any[], callback: any) => {
        setImmediate(() => {
          callback(null, { value: JSON.stringify({
            autoCondenseContext: true,
            customModes: [],
            id: 'machine-123' // Inclus en mode full
          }) });
        });
      });

      const result = await service.extractSettings('full');

      expect(result.metadata.mode).toBe('full');
      expect(result.settings.id).toBe('machine-123');
    });

    it('devrait gérer l\'absence de state.vscdb', async () => {
      mockExistsSync.mockReturnValue(false);

      await expect(service.extractSettings('safe')).rejects.toThrow('state.vscdb not found');
    });

    it('devrait gérer une clé manquante dans la base de données', async () => {
      mockDb.get.mockImplementation((sql: string, params: any[], callback: any) => {
        setImmediate(() => callback(null, null));
      });

      await expect(service.extractSettings('safe')).rejects.toThrow('Key \'RooVeterinaryInc.roo-cline\' not found');
    });

    it('devrait gérer les valeurs Buffer', async () => {
      mockDb.get.mockImplementation((sql: string, params: any[], callback: any) => {
        setImmediate(() => {
          callback(null, { value: Buffer.from(JSON.stringify({ test: 'value' })) });
        });
      });

      const result = await service.extractSettings('safe');
      expect(result.settings.test).toBe('value');
    });
  });

  describe('injectSettings', () => {
    beforeEach(() => {
      mockExistsSync.mockReturnValue(true);
      vi.mocked(fs.unlink).mockResolvedValue();
    });

    it('devrait injecter des paramètres synchronisables', async () => {
      const currentSettings = {
        apiProvider: 'openai',
        customModes: [],
        id: 'old-id' // Non synchronisable
      };

      const newSettings = {
        apiProvider: 'anthropic',
        customModes: [{ name: 'test' }],
        temperature: 0.5 // Paramètre valide
      };

      mockDb.get.mockImplementation((sql: string, params: any[], callback: any) => {
        setImmediate(() => {
          callback(null, { value: JSON.stringify(currentSettings) });
        });
      });

      mockDb.run.mockImplementation((sql: string, params: any[], callback: any) => {
        setImmediate(() => callback(null));
      });

      const result = await service.injectSettings(newSettings);

      expect(result.applied).toBe(2); // apiProvider et temperature
      expect(result.changes).toHaveLength(2);
      expect(result.changes[0].key).toBe('apiProvider');
      expect(result.changes[0].newValue).toBe('anthropic');
      expect(result.changes[1].key).toBe('temperature');
    });

    it('devrait faire un dry run sans appliquer les changements', async () => {
      mockDb.get.mockImplementation((sql: string, params: any[], callback: any) => {
        setImmediate(() => {
          callback(null, { value: JSON.stringify({ apiProvider: 'openai' }) });
        });
      });

      const result = await service.injectSettings({ apiProvider: 'anthropic' }, { dryRun: true });

      expect(result.dryRun).toBe(true);
      expect(result.applied).toBe(0);
      expect(mockDb.run).not.toHaveBeenCalled();
    });

    it('devrait injecter seulement les clés spécifiées', async () => {
      mockDb.get.mockImplementation((sql: string, params: any[], callback: any) => {
        setImmediate(() => {
          callback(null, { value: JSON.stringify({ apiProvider: 'openai' }) });
        });
      });

      mockDb.run.mockImplementation((sql: string, params: any[], callback: any) => {
        setImmediate(() => callback(null));
      });

      await service.injectSettings({
        apiProvider: 'anthropic',
        id: 'new-id' // Non synchronisable
      }, { keys: ['apiProvider'] });

      expect(mockDb.run).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE ItemTable SET value = ?'),
        [expect.any(String), 'RooVeterinaryInc.roo-cline'],
        expect.any(Function)
      );
    });

    it('devrait ignorer les paramètres inchangés', async () => {
      mockDb.get.mockImplementation((sql: string, params: any[], callback: any) => {
        setImmediate(() => {
          callback(null, { value: JSON.stringify({ apiProvider: 'openai' }) });
        });
      });

      const result = await service.injectSettings({ apiProvider: 'openai' });

      expect(result.applied).toBe(0);
      expect(result.changes).toHaveLength(0);
    });

    it('devrait créer une sauvegarde avant injection', async () => {
      mockDb.get.mockImplementation((sql: string, params: any[], callback: any) => {
        setImmediate(() => {
          callback(null, { value: JSON.stringify({}) });
        });
      });

      mockDb.run.mockImplementation((sql: string, params: any[], callback: any) => {
        setImmediate(() => callback(null));
      });

      await service.injectSettings({ apiProvider: 'anthropic' });

      expect(mockCopyFileSync).toHaveBeenCalledTimes(1);
      expect(mockCopyFileSync.mock.calls[0][1]).toMatch(/\.backup_/);
    });
  });

  describe('getSetting', () => {
    it('devrait récupérer un paramètre spécifique', async () => {
      mockExistsSync.mockReturnValue(true);
      vi.mocked(fs.unlink).mockResolvedValue();

      mockDb.get.mockImplementation((sql: string, params: any[], callback: any) => {
        setImmediate(() => {
          callback(null, { value: JSON.stringify({ apiProvider: 'anthropic' }) });
        });
      });

      const value = await service.getSetting('apiProvider');
      expect(value).toBe('anthropic');
    });

    it('devrait retourner undefined pour un paramètre inexistant', async () => {
      mockExistsSync.mockReturnValue(true);
      vi.mocked(fs.unlink).mockResolvedValue();

      mockDb.get.mockImplementation((sql: string, params: any[], callback: any) => {
        setImmediate(() => {
          callback(null, { value: JSON.stringify({}) });
        });
      });

      const value = await service.getSetting('nonexistent');
      expect(value).toBeUndefined();
    });
  });

  describe('filtres de paramètres', () => {
    it('devrait filtrer correctement les paramètres en mode safe', () => {
      const allSettings = {
        // Sync-safe
        apiProvider: 'openai',
        customModes: [],
        // Excluded
        id: 'machine-123',
        taskHistory: [],
        // Sync-safe mais non présent dans SYNC_SAFE_KEYS
        unknownSetting: 'value'
      };

      const filtered = (service as any).filterSettings(allSettings, 'safe');

      expect(filtered.apiProvider).toBe('openai');
      expect(filtered.customModes).toEqual([]);
      expect(filtered.id).toBeUndefined();
      expect(filtered.taskHistory).toBeUndefined();
      expect(filtered.unknownSetting).toBeUndefined();
    });

    it('devrait inclure plus de paramètres en mode full', () => {
      const allSettings = {
        apiProvider: 'openai',
        id: 'machine-123',
        taskHistory: []
      };

      const fullFiltered = (service as any).filterSettings(allSettings, 'full');
      const safeFiltered = (service as any).filterSettings(allSettings, 'safe');

      expect(fullFiltered.id).toBe('machine-123');
      expect(fullFiltered.taskHistory).toEqual([]);
      expect(safeFiltered.id).toBeUndefined();
      expect(safeFiltered.taskHistory).toBeUndefined();
    });
  });

  describe('cas limites et erreurs', () => {
    it('devrait gérer les erreurs de lecture de la base de données', async () => {
      mockExistsSync.mockReturnValue(true);
      vi.mocked(fs.unlink).mockResolvedValue();

      mockDb.get.mockImplementation((sql: string, params: any[], callback: any) => {
        setImmediate(() => callback(new Error('Database error')));
      });

      await expect(service.extractSettings('safe')).rejects.toThrow('Cannot open state.vscdb');
    });

    it('devrait gérer les erreurs d\'écriture dans la base de données', async () => {
      mockExistsSync.mockReturnValue(true);
      vi.mocked(fs.unlink).mockResolvedValue();

      mockDb.get.mockImplementation((sql: string, params: any[], callback: any) => {
        setImmediate(() => {
          callback(null, { value: JSON.stringify({}) });
        });
      });

      mockDb.run.mockImplementation((sql: string, params: any[], callback: any) => {
        setImmediate(() => callback(new Error('Write error')));
      });

      await expect(service.injectSettings({ apiProvider: 'anthropic' })).rejects.toThrow('Write error');
    });

    it('devrait gérer JSON invalide', async () => {
      mockExistsSync.mockReturnValue(true);
      vi.mocked(fs.unlink).mockResolvedValue();

      mockDb.get.mockImplementation((sql: string, params: any[], callback: any) => {
        setImmediate(() => {
          callback(null, { value: 'invalid json' });
        });
      });

      await expect(service.extractSettings('safe')).rejects.toThrow('Unexpected token');
    });

    it('devrait nettoyer les fichiers temporaires', async () => {
      mockExistsSync.mockReturnValue(true);
      vi.mocked(fs.unlink).mockResolvedValue();

      mockDb.get.mockImplementation((sql: string, params: any[], callback: any) => {
        setImmediate(() => {
          callback(null, { value: JSON.stringify({}) });
        });
      });

      await service.extractSettings('safe');

      expect(fs.unlink).toHaveBeenCalledTimes(1);
    });

    it('devrait ignorer les erreurs de nettoyage', async () => {
      mockExistsSync.mockReturnValue(true);
      vi.mocked(fs.unlink).mockRejectedValue(new Error('Permission denied'));

      mockDb.get.mockImplementation((sql: string, params: any[], callback: any) => {
        setImmediate(() => {
          callback(null, { value: JSON.stringify({}) });
        });
      });

      // Ne pas lever d'erreur
      await expect(service.extractSettings('safe')).resolves.not.toThrow();
    });
  });

  describe('constantes d\'export', () => {
    it('devrait exporter SYNC_SAFE_KEYS', () => {
      expect(SYNC_SAFE_KEYS).toBeDefined();
      expect(SYNC_SAFE_KEYS.has('apiProvider')).toBe(true);
      expect(SYNC_SAFE_KEYS.has('customModes')).toBe(true);
      expect(SYNC_SAFE_KEYS.size).toBeGreaterThan(80);
    });

    it('devrait exporter EXCLUDED_KEYS', () => {
      expect(EXCLUDED_KEYS).toBeDefined();
      expect(EXCLUDED_KEYS.has('id')).toBe(true);
      expect(EXCLUDED_KEYS.has('taskHistory')).toBe(true);
      expect(EXCLUDED_KEYS.has('clerk-auth-state')).toBe(true);
    });
  });

  describe('intention des paramètres', () => {
    it('devrait exclure les paramètres sensibles', () => {
      const sensitiveKeys = ['id', 'taskHistory', 'clerk-auth-state'];
      sensitiveKeys.forEach(key => {
        expect(EXCLUDED_KEYS.has(key)).toBe(true);
        expect(SYNC_SAFE_KEYS.has(key)).toBe(false);
      });
    });

    it('devrait inclure les paramètres de configuration légitimes', () => {
      const configKeys = ['apiProvider', 'customModes', 'temperature'];
      configKeys.forEach(key => {
        expect(SYNC_SAFE_KEYS.has(key)).toBe(true);
        expect(EXCLUDED_KEYS.has(key)).toBe(false);
      });
    });

    it('devrait exclure les paramètres UI/state', () => {
      const uiKeys = ['hasOpenedModeSelector', 'dismissedUpsells', 'lastShownAnnouncementId'];
      uiKeys.forEach(key => {
        expect(EXCLUDED_KEYS.has(key)).toBe(true);
        expect(SYNC_SAFE_KEYS.has(key)).toBe(false);
      });
    });
  });

  describe('méthodes privées', () => {
    it('devrait créer le chemin correct vers la base de données', () => {
      const dbPath = service.getStateDbPath();
      expect(dbPath).toEqual(join(homedir(), 'AppData', 'Roaming', 'Code', 'User', 'globalStorage', 'state.vscdb'));
    });

    it('devrait gérer les métadonnées d\'extraction', async () => {
      mockExistsSync.mockReturnValue(true);
      vi.mocked(fs.unlink).mockResolvedValue();

      mockDb.get.mockImplementation((sql: string, params: any[], callback: any) => {
        setImmediate(() => {
          callback(null, { value: JSON.stringify({}) });
        });
      });

      const result = await service.extractSettings('safe');

      expect(result.metadata).toEqual({
        machine: expect.any(String),
        timestamp: expect.any(String),
        mode: 'safe',
        keysCount: 0,
        totalKeys: 0
      });
    });
  });
});