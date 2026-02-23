/**
 * Tests pour ConfigNormalizationService
 * Issue #507 - Tâche 1: Test de compétence (fix de code)
 *
 * @module services/__tests__/ConfigNormalizationService
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { ConfigNormalizationService, type MachineContext, type ConfigType } from '../../../src/services/ConfigNormalizationService.js';

describe('ConfigNormalizationService', () => {
  let service: ConfigNormalizationService;
  const mockContext: MachineContext = {
    os: 'windows',
    homeDir: 'C:\\Users\\testuser',
    rooRoot: 'd:\\Dev\\roo-extensions',
    envVars: {}
  };

  beforeEach(() => {
    service = new ConfigNormalizationService(mockContext);
  });

  describe('normalize', () => {
    test('devrait normaliser les chemins Windows avec HOME placeholder', async () => {
      const input = {
        configPath: 'C:\\Users\\testuser\\.roo\\config.json'
      };
      const result = await service.normalize(input, 'mcp_config');

      expect(result.configPath).toBe('%USERPROFILE%/.roo/config.json');
    });

    test('devrait normaliser les chemins Windows avec ROO_ROOT placeholder', async () => {
      const input = {
        scriptPath: 'd:\\Dev\\roo-extensions\\scripts\\deploy.ps1'
      };
      const result = await service.normalize(input, 'mode_definition');

      expect(result.scriptPath).toBe('%ROO_ROOT%/scripts/deploy.ps1');
    });

    test('devrait convertir les backslashes en forward slashes', async () => {
      const input = {
        path: 'd:\\Dev\\roo-extensions\\mcps\\internal'
      };
      const result = await service.normalize(input, 'model_config');

      expect(result.path).toBe('%ROO_ROOT%/mcps/internal');
    });

    test('devrait préserver les variables d environnement existantes', async () => {
      const input = {
        appDataPath: '%APPDATA%\\Roo\\config'
      };
      const result = await service.normalize(input, 'rules_config');

      expect(result.appDataPath).toBe('%APPDATA%/Roo/config');
    });

    test('devrait remplacer les clés sensibles par des placeholders', async () => {
      const input = {
        apiKey: 'secret-key-123',
        apiToken: 'token-abc',
        normalField: 'keep-this'
      };
      const result = await service.normalize(input, 'mcp_config');

      expect(result.apiKey).toBe('{{SECRET:apiKey}}');
      expect(result.apiToken).toBe('{{SECRET:apiToken}}');
      expect(result.normalField).toBe('keep-this');
    });

    test('devrait préserver les placeholders de secrets existants', async () => {
      const input = {
        apiKey: '{{SECRET:apiKey}}'
      };
      const result = await service.normalize(input, 'mcp_config');

      expect(result.apiKey).toBe('{{SECRET:apiKey}}');
    });

    test('devrait gérer les objets imbriqués', async () => {
      const input = {
        nested: {
          path: 'C:\\Users\\testuser\\config',
          secret: 'hidden'
        }
      };
      const result = await service.normalize(input, 'mode_definition');

      expect(result.nested.path).toBe('%USERPROFILE%/config');
      expect(result.nested.secret).toBe('{{SECRET:secret}}');
    });

    test('devrait gérer les tableaux', async () => {
      const input = {
        paths: [
          'C:\\Users\\testuser\\path1',
          'd:\\Dev\\roo-extensions\\path2'
        ]
      };
      const result = await service.normalize(input, 'model_config');

      expect(result.paths).toEqual([
        '%USERPROFILE%/path1',
        '%ROO_ROOT%/path2'
      ]);
    });

    test('devrait retourner les valeurs non-string telles quelles', async () => {
      const input = {
        number: 42,
        boolean: true,
        nullValue: null
      };
      const result = await service.normalize(input, 'mcp_config');

      expect(result.number).toBe(42);
      expect(result.boolean).toBe(true);
      expect(result.nullValue).toBe(null);
    });
  });

  describe('denormalize', () => {
    test('devrait remplacer %USERPROFILE% par le home directory', async () => {
      const input = {
        configPath: '%USERPROFILE%/.roo/config.json'
      };
      const result = await service.denormalize(input, 'mcp_config', mockContext);

      expect(result.configPath).toBe('C:\\Users\\testuser\\.roo\\config.json');
    });

    test('devrait remplacer %ROO_ROOT% par le roo root', async () => {
      const input = {
        scriptPath: '%ROO_ROOT%/scripts/deploy.ps1'
      };
      const result = await service.denormalize(input, 'mode_definition', mockContext);

      expect(result.scriptPath).toBe('d:\\Dev\\roo-extensions\\scripts\\deploy.ps1');
    });

    test('devrait utiliser les backslashes sur Windows', async () => {
      const input = {
        path: '%ROO_ROOT%/mcps/internal'
      };
      const result = await service.denormalize(input, 'model_config', mockContext);

      expect(result.path).toBe('d:\\Dev\\roo-extensions\\mcps\\internal');
    });

    test('devrait utiliser les forward slashes sur Linux', async () => {
      const linuxContext: MachineContext = {
        os: 'linux',
        homeDir: '/home/testuser',
        rooRoot: '/home/testuser/roo-extensions',
        envVars: {}
      };

      const input = {
        path: '%ROO_ROOT%/scripts'
      };
      const result = await service.denormalize(input, 'mode_definition', linuxContext);

      expect(result.path).toBe('/home/testuser/roo-extensions/scripts');
    });

    test('devrait utiliser les forward slashes sur macOS', async () => {
      const darwinContext: MachineContext = {
        os: 'darwin',
        homeDir: '/Users/testuser',
        rooRoot: '/Users/testuser/roo-extensions',
        envVars: {}
      };

      const input = {
        path: '%ROO_ROOT%/scripts'
      };
      const result = await service.denormalize(input, 'mode_definition', darwinContext);

      expect(result.path).toBe('/Users/testuser/roo-extensions/scripts');
    });

    test('devrait préserver les clés sensibles en mode denormalize', async () => {
      const input = {
        apiKey: '{{SECRET:apiKey}}'
      };
      const result = await service.denormalize(input, 'mcp_config', mockContext);

      expect(result.apiKey).toBe('{{SECRET:apiKey}}');
    });

    test('devrait gérer les objets imbriqués', async () => {
      const input = {
        nested: {
          path: '%USERPROFILE%/config',
          value: 42
        }
      };
      const result = await service.denormalize(input, 'mode_definition', mockContext);

      expect(result.nested.path).toBe('C:\\Users\\testuser\\config');
      expect(result.nested.value).toBe(42);
    });

    test('devrait gérer les tableaux', async () => {
      const input = {
        paths: [
          '%USERPROFILE%/path1',
          '%ROO_ROOT%/path2'
        ]
      };
      const result = await service.denormalize(input, 'model_config', mockContext);

      expect(result.paths).toEqual([
        'C:\\Users\\testuser\\path1',
        'd:\\Dev\\roo-extensions\\path2'
      ]);
    });
  });

  describe('edge cases', () => {
    test('devrait gérer les chaînes vides', async () => {
      const input = { path: '' };
      const result = await service.normalize(input, 'mcp_config');

      expect(result.path).toBe('');
    });

    test('devrait gérer null', async () => {
      const result = await service.normalize(null, 'mcp_config');

      expect(result).toBe(null);
    });

    test('devrait gérer les valeurs undefined', async () => {
      const input = { value: undefined };
      const result = await service.normalize(input, 'mcp_config');

      expect(result.value).toBe(undefined);
    });

    test('devrait détecter les clés sensibles avec différentes casses', async () => {
      const input = {
        APIKEY: 'value1',
        ApiToken: 'value2',
        PASSWORD: 'value3'
      };
      const result = await service.normalize(input, 'mcp_config');

      expect(result.APIKEY).toBe('{{SECRET:APIKEY}}');
      expect(result.ApiToken).toBe('{{SECRET:ApiToken}}');
      expect(result.PASSWORD).toBe('{{SECRET:PASSWORD}}');
    });
  });

  describe('getCurrentContext', () => {
    test('devrait utiliser le context override si fourni', async () => {
      const customContext: MachineContext = {
        os: 'linux',
        homeDir: '/custom/home',
        rooRoot: '/custom/roo',
        envVars: { CUSTOM_VAR: 'value' }
      };
      const customService = new ConfigNormalizationService(customContext);

      const input = { path: '/custom/home/test' };
      const result = await customService.normalize(input, 'mcp_config');

      expect(result.path).toBe('%USERPROFILE%/test');
    });
  });
});
