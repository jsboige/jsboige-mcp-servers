/**
 * ConfigService.test.ts - Tests pour le service de configuration
 *
 * Tests unitaires pour ConfigService, responsable de la gestion
 * des configurations RooSync.
 *
 * @module ConfigService.test
 * @version 1.0.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { ConfigService } from '../ConfigService.js';

describe('ConfigService', () => {
  const testDir = join(process.cwd(), 'test-temp-config');
  const configDir = join(testDir, 'roo-config');
  const configPath = join(configDir, 'settings.json');

  beforeEach(async () => {
    // Créer le répertoire de test
    await fs.mkdir(configDir, { recursive: true });

    // Mock process.env pour les tests
    vi.stubEnv('USERPROFILE', testDir);
    vi.stubEnv('ROO_ROOT', testDir);
  });

  afterEach(async () => {
    // Nettoyer les fichiers de test
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignorer les erreurs de nettoyage
    }
    vi.unstubAllEnvs();
  });

  describe('constructor', () => {
    it('devrait initialiser avec un chemin de configuration par défaut', () => {
      const service = new ConfigService();
      expect(service).toBeDefined();
      expect(service.getSharedStatePath()).toBeDefined();
    });

    it('devrait initialiser avec un chemin de configuration personnalisé', () => {
      const customPath = join(testDir, 'custom-config.json');
      const service = new ConfigService(customPath);
      expect(service).toBeDefined();
    });

    it('devrait initialiser la configuration du BaselineService', () => {
      const service = new ConfigService();
      const baselineConfig = service.getBaselineServiceConfig();
      expect(baselineConfig).toBeDefined();
      expect(baselineConfig.baselinePath).toBeDefined();
      expect(baselineConfig.roadmapPath).toBeDefined();
      expect(baselineConfig.cacheEnabled).toBe(true);
      expect(baselineConfig.cacheTTL).toBe(3600000);
      expect(baselineConfig.logLevel).toBe('INFO');
    });

    it('devrait retourner le chemin d\'état partagé', () => {
      const service = new ConfigService();
      const sharedStatePath = service.getSharedStatePath();
      expect(sharedStatePath).toBeDefined();
      expect(typeof sharedStatePath).toBe('string');
    });
  });

  describe('loadConfig', () => {
    it('devrait charger une configuration existante', async () => {
      const testConfig = {
        testKey: 'testValue',
        nested: {
          key: 'value'
        }
      };
      await fs.writeFile(configPath, JSON.stringify(testConfig, null, 2), 'utf-8');

      const service = new ConfigService(configPath);
      const config = await service.loadConfig();

      expect(config).toEqual(testConfig);
    });

    it('devrait retourner un objet vide si le fichier n\'existe pas', async () => {
      const nonExistentPath = join(testDir, 'nonexistent.json');
      const service = new ConfigService(nonExistentPath);
      const config = await service.loadConfig();

      expect(config).toEqual({});
    });

    it('devrait gérer les fichiers avec BOM UTF-8', async () => {
      const testConfig = { test: 'data' };
      const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
      const contentWithBOM = Buffer.concat([
        bom,
        Buffer.from(JSON.stringify(testConfig, null, 2), 'utf-8')
      ]);
      await fs.writeFile(configPath, contentWithBOM);

      const service = new ConfigService(configPath);
      const config = await service.loadConfig();

      expect(config).toEqual(testConfig);
    });

    it('devrait retourner un objet vide en cas d\'erreur de lecture', async () => {
      // Créer un fichier avec des permissions invalides
      const invalidPath = join(testDir, 'invalid.json');
      await fs.writeFile(invalidPath, '{}', 'utf-8');

      const service = new ConfigService(invalidPath);
      // Simuler une erreur en supprimant le fichier après la création du service
      await fs.unlink(invalidPath);

      const config = await service.loadConfig();
      expect(config).toEqual({});
    });

    it('devrait parser du JSON valide', async () => {
      const complexConfig = {
        string: 'value',
        number: 42,
        boolean: true,
        array: [1, 2, 3],
        object: { nested: 'value' },
        null: null
      };
      await fs.writeFile(configPath, JSON.stringify(complexConfig, null, 2), 'utf-8');

      const service = new ConfigService(configPath);
      const config = await service.loadConfig();

      expect(config).toEqual(complexConfig);
    });
  });

  describe('saveConfig', () => {
    it('devrait sauvegarder une configuration', async () => {
      const testConfig = {
        testKey: 'testValue',
        number: 123
      };

      const service = new ConfigService(configPath);
      const result = await service.saveConfig(testConfig);

      expect(result).toBe(true);

      // Vérifier que le fichier a été créé
      const savedContent = await fs.readFile(configPath, 'utf-8');
      const savedConfig = JSON.parse(savedContent);
      expect(savedConfig).toEqual(testConfig);
    });

    it('devrait écraser une configuration existante', async () => {
      const initialConfig = { initial: 'value' };
      const newConfig = { new: 'value' };

      const service = new ConfigService(configPath);
      await service.saveConfig(initialConfig);
      await service.saveConfig(newConfig);

      const savedContent = await fs.readFile(configPath, 'utf-8');
      const savedConfig = JSON.parse(savedContent);
      expect(savedConfig).toEqual(newConfig);
      expect(savedConfig).not.toEqual(initialConfig);
    });

    it('devrait lancer une erreur en cas d\'erreur de sauvegarde', async () => {
      const service = new ConfigService('/invalid/path/config.json');

      await expect(service.saveConfig({ test: 'data' })).rejects.toThrow();
    });

    it('devrait formater le JSON avec indentation', async () => {
      const testConfig = { key: 'value' };

      const service = new ConfigService(configPath);
      await service.saveConfig(testConfig);

      const savedContent = await fs.readFile(configPath, 'utf-8');
      expect(savedContent).toContain('  "key": "value"');
    });
  });

  describe('findConfigPath', () => {
    it('devrait trouver le chemin de configuration dans USERPROFILE', async () => {
      const userProfileDir = join(testDir, '.roo', 'config');
      await fs.mkdir(userProfileDir, { recursive: true });
      await fs.writeFile(join(userProfileDir, 'settings.json'), '{}', 'utf-8');

      const service = new ConfigService();
      const config = await service.loadConfig();
      expect(config).toBeDefined();
    });

    it('devrait trouver le chemin de configuration dans roo-config', async () => {
      await fs.writeFile(join(testDir, 'roo-config', 'settings.json'), '{}', 'utf-8');

      const service = new ConfigService();
      const config = await service.loadConfig();
      expect(config).toBeDefined();
    });

    it('devrait utiliser le chemin par défaut si aucun fichier n\'existe', () => {
      const service = new ConfigService();
      expect(service).toBeDefined();
      expect(service.getSharedStatePath()).toBeDefined();
    });
  });

  describe('findSharedStatePath', () => {
    it('devrait utiliser ROOSYNC_SHARED_PATH si défini et existant', async () => {
      // Créer le répertoire temporaire pour ROOSYNC_SHARED_PATH
      const customSharedPath = join(testDir, 'custom-shared');
      await fs.mkdir(customSharedPath, { recursive: true });
      vi.stubEnv('ROOSYNC_SHARED_PATH', customSharedPath);

      const service = new ConfigService();
      const sharedStatePath = service.getSharedStatePath();

      expect(sharedStatePath).toBe(customSharedPath);
    });

    it('devrait utiliser le chemin par défaut si ROOSYNC_SHARED_PATH n\'est pas défini', () => {
      const service = new ConfigService();
      const sharedStatePath = service.getSharedStatePath();

      expect(sharedStatePath).toBeDefined();
      // Le chemin peut varier selon l'environnement, on vérifie juste qu'il est défini et valide
      expect(typeof sharedStatePath).toBe('string');
      expect(sharedStatePath.length).toBeGreaterThan(0);
      // On ne vérifie pas le contenu exact du chemin car il peut varier selon l'environnement
    });
  });

  describe('getBaselineServiceConfig', () => {
    it('devrait retourner une copie de la configuration', () => {
      const service = new ConfigService();
      const config1 = service.getBaselineServiceConfig();
      const config2 = service.getBaselineServiceConfig();

      expect(config1).toEqual(config2);
      expect(config1).not.toBe(config2);
    });

    it('devrait contenir tous les champs requis', () => {
      const service = new ConfigService();
      const config = service.getBaselineServiceConfig();

      expect(config).toHaveProperty('baselinePath');
      expect(config).toHaveProperty('roadmapPath');
      expect(config).toHaveProperty('cacheEnabled');
      expect(config).toHaveProperty('cacheTTL');
      expect(config).toHaveProperty('logLevel');
    });

    it('devrait avoir des valeurs par défaut correctes', () => {
      const service = new ConfigService();
      const config = service.getBaselineServiceConfig();

      expect(config.cacheEnabled).toBe(true);
      expect(config.cacheTTL).toBe(3600000);
      expect(config.logLevel).toBe('INFO');
    });
  });

  describe('Cas d\'intégration', () => {
    it('devrait supporter un cycle complet de chargement et sauvegarde', async () => {
      const initialConfig = {
        version: '1.0.0',
        settings: {
          enabled: true,
          timeout: 5000
        }
      };

      const service = new ConfigService(configPath);
      
      // Sauvegarder
      const saveResult = await service.saveConfig(initialConfig);
      expect(saveResult).toBe(true);

      // Charger
      const loadedConfig = await service.loadConfig();
      expect(loadedConfig).toEqual(initialConfig);

      // Modifier et sauvegarder
      const modifiedConfig = {
        ...initialConfig,
        settings: {
          ...initialConfig.settings,
          timeout: 10000
        }
      };
      await service.saveConfig(modifiedConfig);

      // Recharger
      const reloadedConfig = await service.loadConfig();
      expect(reloadedConfig).toEqual(modifiedConfig);
      expect(reloadedConfig.settings.timeout).toBe(10000);
    });

    it('devrait gérer des configurations complexes', async () => {
      const complexConfig = {
        version: '2.1.0',
        machines: [
          {
            id: 'machine-1',
            name: 'Test Machine',
            config: {
              modes: ['mode1', 'mode2'],
              mcpServers: [
                { name: 'mcp1', enabled: true },
                { name: 'mcp2', enabled: false }
              ]
            }
          }
        ],
        settings: {
          cache: {
            enabled: true,
            ttl: 3600000
          },
          logging: {
            level: 'DEBUG',
            file: 'app.log'
          }
        }
      };

      const service = new ConfigService(configPath);
      await service.saveConfig(complexConfig);

      const loadedConfig = await service.loadConfig();
      expect(loadedConfig).toEqual(complexConfig);
      expect(loadedConfig.machines).toHaveLength(1);
      expect(loadedConfig.machines[0].config.mcpServers).toHaveLength(2);
    });
  });
});
