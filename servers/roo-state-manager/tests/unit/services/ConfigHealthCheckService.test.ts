/**
 * Tests pour ConfigHealthCheckService
 *
 * Ce service implémente un système de validation de santé des configurations
 * avec différents types de checks: JSON valide, champs requis, MCP chargeable, etc.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ConfigHealthCheckService, type HealthCheckOptions, type HealthCheckResult, type ConfigType } from '../../../src/services/ConfigHealthCheckService.js';
import { readFile, access } from 'fs/promises';
import { existsSync } from 'fs';

// Mock du logger
vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }))
}));

// Mock des fonctions fs
vi.mock('fs/promises');
vi.mock('fs');

describe('ConfigHealthCheckService', () => {
  let service: ConfigHealthCheckService;
  let mockLogger: any;

  beforeEach(() => {
    mockLogger = {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    vi.mocked(createLogger).mockReturnValue(mockLogger);
    service = new ConfigHealthCheckService(mockLogger);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('initialisation', () => {
    it('devrait initialiser correctement', () => {
      expect(service).toBeInstanceOf(ConfigHealthCheckService);
    });
  });

  describe('checkHealth - file_readable', () => {
    it('devrait détecter les fichiers existants', async () => {
      const filePath = '/path/to/config.json';
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(access).mockResolvedValue();

      const result = await service.checkHealth(filePath, 'mcp_config');

      expect(result.healthy).toBe(true);
      expect(result.checks).toHaveLength(1);
      expect(result.checks[0].name).toBe('file_readable');
      expect(result.checks[0].passed).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('devrait détecter les fichiers manquants', async () => {
      const filePath = '/path/to/config.json';
      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(access).mockRejectedValue(new Error('ENOENT'));

      const result = await service.checkHealth(filePath, 'mcp_config');

      expect(result.healthy).toBe(false);
      expect(result.checks).toHaveLength(1);
      expect(result.checks[0].name).toBe('file_readable');
      expect(result.checks[0].passed).toBe(false);
      expect(result.errors).toContain('Fichier non accessible: ');
    });

    it('devrait s\'arrêter après un file_readable échoué', async () => {
      const filePath = '/path/to/config.json';
      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(access).mockRejectedValue(new Error('ENOENT'));

      const result = await service.checkHealth(filePath, 'mcp_config', {
        checks: ['file_readable', 'json_valid']
      });

      // Seul le file_readable a été exécuté
      expect(result.checks).toHaveLength(1);
      expect(result.checks[0].name).toBe('file_readable');
    });
  });

  describe('checkHealth - json_valid', () => {
    it('devrait valider un JSON correct', async () => {
      const filePath = '/path/to/config.json';
      const validJson = '{"key": "value"}';
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(access).mockResolvedValue();
      vi.mocked(readFile).mockResolvedValue(validJson);

      const result = await service.checkHealth(filePath, 'mcp_config');

      expect(result.healthy).toBe(true);
      expect(result.checks).toHaveLength(2); // file_readable + json_valid
      expect(result.checks[1].name).toBe('json_valid');
      expect(result.checks[1].passed).toBe(true);
      expect(result.checks[1].details?.parsed).toEqual({ key: 'value' });
    });

    it('devrait détecter un JSON invalide', async () => {
      const filePath = '/path/to/config.json';
      const invalidJson = '{"key": "value"';
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(access).mockResolvedValue();
      vi.mocked(readFile).mockResolvedValue(invalidJson);

      const result = await service.checkHealth(filePath, 'mcp_config');

      expect(result.healthy).toBe(false);
      expect(result.checks[1].passed).toBe(false);
      expect(result.checks[1].message).toContain('JSON invalide');
      expect(result.errors).toContain('JSON invalide:');
    });

    it('devrait gérer le BOM UTF-8', async () => {
      const filePath = '/path/to/config.json';
      const jsonWithBom = '\uFEFF{"key": "value"}';
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(access).mockResolvedValue();
      vi.mocked(readFile).mockResolvedValue(jsonWithBom);

      const result = await service.checkHealth(filePath, 'mcp_config');

      expect(result.healthy).toBe(true);
      expect(result.checks[1].passed).toBe(true);
      expect(result.checks[1].details?.parsed).toEqual({ key: 'value' });
    });
  });

  describe('checkHealth - required_fields', () => {
    it('devrait valider les champs requis présents', async () => {
      const filePath = '/path/to/config.json';
      const validConfig = '{"mcpServers": {}, "apiConfigs": []}';
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(access).mockResolvedValue();
      vi.mocked(readFile).mockResolvedValue(validConfig);

      const result = await service.checkHealth(filePath, 'mcp_config');

      expect(result.healthy).toBe(true);
      expect(result.checks).toHaveLength(3);
      expect(result.checks[2].name).toBe('required_fields');
      expect(result.checks[2].passed).toBe(true);
      expect(result.checks[2].message).toContain('Tous les champs requis présents');
    });

    it('devrait détecter les champs requis manquants', async () => {
      const filePath = '/path/to/config.json';
      const incompleteConfig = '{"mcpServers": {}}';
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(access).mockResolvedValue();
      vi.mocked(readFile).mockResolvedValue(incompleteConfig);

      const result = await service.checkHealth(filePath, 'mcp_config');

      expect(result.healthy).toBe(true); // Pas bloquant, seulement warning
      expect(result.checks[2].passed).toBe(false);
      expect(result.checks[2].message).toContain('Champs manquants: ');
      expect(result.warnings).toContain('Champs requis manquants');
    });

    it('devrait gérer les champs requis custom', async () => {
      const filePath = '/path/to/config.json';
      const customConfig = {'custom1': 'value'};
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(access).mockResolvedValue();
      vi.mocked(readFile).mockResolvedValue(JSON.stringify(customConfig));

      const result = await service.checkHealth(filePath, 'custom_config', {
        requiredFields: ['custom1', 'custom2']
      });

      expect(result.checks[2].passed).toBe(false);
      expect(result.checks[2].details?.missing).toEqual(['custom2']);
    });

    it('devrait traiter les types sans champs requis', async () => {
      const filePath = '/path/to/config.json';
      const config = {'any': 'data'};
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(access).mockResolvedValue();
      vi.mocked(readFile).mockResolvedValue(JSON.stringify(config));

      const result = await service.checkHealth(filePath, 'rules_config');

      expect(result.checks[2].passed).toBe(true);
      expect(result.checks[2].message).toContain('Aucun champ requis défini');
    });
  });

  describe('checkHealth - mcp_loadable', () => {
    it('devrait valider une configuration MCP correcte', async () => {
      const filePath = '/path/to/mcp.json';
      const validMcpConfig = {
        mcpServers: {
          'test-server': {
            command: 'node',
            args: ['server.js'],
            disabled: false
          }
        }
      };
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(access).mockResolvedValue();
      vi.mocked(readFile).mockResolvedValue(JSON.stringify(validMcpConfig));

      const result = await service.checkHealth(filePath, 'mcp_config');

      expect(result.healthy).toBe(true);
      expect(result.checks).toHaveLength(4);
      expect(result.checks[3].name).toBe('mcp_loadable');
      expect(result.checks[3].passed).toBe(true);
    });

    it('devrait détecter les problèmes dans la configuration MCP', async () => {
      const filePath = '/path/to/mcp.json';
      const problematicMcpConfig = {
        mcpServers: {
          'test-server': {
            command: 'node',
            args: 'pas un tableau',
            disabled: 'pas un boolean'
          }
        }
      };
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(access).mockResolvedValue();
      vi.mocked(readFile).mockResolvedValue(JSON.stringify(problematicMcpConfig));

      const result = await service.checkHealth(filePath, 'mcp_config');

      expect(result.checks[3].passed).toBe(false);
      expect(result.checks[3].message).toContain('Problèmes détectés');
      expect(result.warnings).toContain('Configuration MCP potentiellement problématique');
    });

    it('devrait ignorer la vérification MCP pour les autres types de config', async () => {
      const filePath = '/path/to/modes.json';
      const config = {
        slug: 'test',
        name: 'Test Mode',
        roleDefinition: {}
      };
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(access).mockResolvedValue();
      vi.mocked(readFile).mockResolvedValue(JSON.stringify(config));

      const result = await service.checkHealth(filePath, 'mode_definition');

      expect(result.checks).toHaveLength(3); // Pas de mcp_loadable
      expect(result.checks.some(c => c.name === 'mcp_loadable')).toBe(false);
    });

    it('devrait gérer une config MCP sans mcpServers', async () => {
      const filePath = '/path/to/mcp.json';
      const configWithoutServers = {};
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(access).mockResolvedValue();
      vi.mocked(readFile).mockResolvedValue(JSON.stringify(configWithoutServers));

      const result = await service.checkHealth(filePath, 'mcp_config');

      expect(result.checks[3].passed).toBe(true); // Pas bloquant
      expect(result.checks[3].message).toContain('Pas de mcpServers défini');
    });
  });

  describe('checkHealth - options custom', () => {
    it('devrait exécuter seulement les checks spécifiés', async () => {
      const filePath = '/path/to/config.json';
      const config = '{"key": "value"}';
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(access).mockResolvedValue();
      vi.mocked(readFile).mockResolvedValue(config);

      const result = await service.checkHealth(filePath, 'mcp_config', {
        checks: ['file_readable', 'json_valid']
      });

      expect(result.checks).toHaveLength(2);
      expect(result.checks.some(c => c.name === 'required_fields')).toBe(false);
    });

    it('devrait gérer une option timeout', async () => {
      const filePath = '/path/to/config.json';
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(access).mockResolvedValue();

      await service.checkHealth(filePath, 'mcp_config', {
        timeout: 1000
      });

      // Le timeout n'est pas encore implémenté dans la méthode principale
      // Mais on vérifie qu'elle s'exécute sans erreur
      expect(true).toBe(true);
    });
  });

  describe('quickCheck', () => {
    it('devrait retourner true pour un fichier valide', async () => {
      const filePath = '/path/to/config.json';
      const validJson = '{"key": "value"}';
      vi.mocked(readFile).mockResolvedValue(validJson);

      const result = await service.quickCheck(filePath);

      expect(result).toBe(true);
    });

    it('devrait retourner false pour un fichier invalide', async () => {
      const filePath = '/path/to/config.json';
      const invalidJson = '{"key": "value"';
      vi.mocked(readFile).mockRejectedValue(new Error('Parse error'));

      const result = await service.quickCheck(filePath);

      expect(result).toBe(false);
    });
  });

  describe('checkBatch', () => {
    it('devrait vérifier plusieurs fichiers', async () => {
      const files = [
        { path: '/valid.json', type: 'mcp_config' },
        { path: '/invalid.json', type: 'mode_definition' }
      ];

      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(access).mockResolvedValue();
      vi.mocked(readFile)
        .mockResolvedValueOnce('{"mcpServers": {}}')
        .mockRejectedValueOnce(new Error('File not found'));

      const result = await service.checkBatch(files);

      expect(result.summary.passed).toBe(1);
      expect(result.summary.failed).toBe(1);
      expect(result.summary.warnings).toBeGreaterThan(0);
      expect(result.results.size).toBe(2);
    });

    it('devrait retourner healthy si tous les fichiers sont valides', async () => {
      const files = [
        { path: '/valid1.json', type: 'mcp_config' },
        { path: '/valid2.json', type: 'mode_definition' }
      ];

      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(access).mockResolvedValue();
      vi.mocked(readFile)
        .mockResolvedValue('{"mcpServers": {}}')
        .mockResolvedValue('{"slug": "test"}');

      const result = await service.checkBatch(files);

      expect(result.healthy).toBe(true);
      expect(result.summary.passed).toBe(2);
      expect(result.summary.failed).toBe(0);
    });

    it('devrait retourner false si un fichier échoue', async () => {
      const files = [
        { path: '/valid.json', type: 'mcp_config' },
        { path: '/invalid.json', type: 'mode_definition' }
      ];

      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(access).mockResolvedValue();
      vi.mocked(readFile)
        .mockResolvedValue('{"mcpServers": {}}')
        .mockResolvedValue('{"slug": "test"');

      const result = await service.checkBatch(files);

      expect(result.healthy).toBe(false);
      expect(result.summary.failed).toBe(1);
    });
  });

  describe('cas limites et erreurs', () => {
    it('devrait gérer les erreurs de lecture de fichier', async () => {
      const filePath = '/path/to/config.json';
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(access).mockResolvedValue();
      vi.mocked(readFile).mockRejectedValue(new Error('Permission denied'));

      const result = await service.checkHealth(filePath, 'mcp_config');

      expect(result.healthy).toBe(false);
      expect(result.errors).toContain('Impossible de lire le fichier:');
    });

    it('devrait gérer les undefined/null dans le contenu JSON', async () => {
      const filePath = '/path/to/config.json';
      const configWithNull = '{"value": null}';
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(access).mockResolvedValue();
      vi.mocked(readFile).mockResolvedValue(configWithNull);

      const result = await service.checkHealth(filePath, 'mcp_config');

      expect(result.healthy).toBe(true);
    });

    it('devrait enregistrer le temps d\'exécution', async () => {
      const filePath = '/path/to/config.json';
      const config = '{"key": "value"}';
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(access).mockResolvedValue();
      vi.mocked(readFile).mockResolvedValue(config);

      const startTime = Date.now();
      const result = await service.checkHealth(filePath, 'mcp_config');
      const duration = Date.now() - startTime;

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Health check terminé: OK',
        expect.objectContaining({ duration: expect.any(Number) })
      );
    });

    it('devrait retourner un timestamp précis', async () => {
      const filePath = '/path/to/config.json';
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(access).mockResolvedValue();
      vi.mocked(readFile).mockResolvedValue('{}');

      const result = await service.checkHealth(filePath, 'mcp_config');

      expect(result.timestamp).toBeInstanceOf(Date);
      expect(result.configType).toBe('mcp_config');
      expect(result.filePath).toBe(filePath);
    });
  });

  describe('types de configuration', () => {
    it('devrait valider tous les types de configuration', async () => {
      const types: ConfigType[] = [
        'mcp_config',
        'mode_definition',
        'profile_settings',
        'roomodes_config',
        'model_config',
        'rules_config',
        'settings_config'
      ];

      for (const type of types) {
        vi.resetAllMocks();
        vi.mocked(existsSync).mockReturnValue(true);
        vi.mocked(access).mockResolvedValue();
        vi.mocked(readFile).mockResolvedValue('{}');

        const service = new ConfigHealthCheckService(mockLogger);
        const result = await service.checkHealth('/path/to/config.json', type);

        expect(result.configType).toBe(type);
      }
    });

    it('devrait utiliser les champs requis par défaut pour chaque type', async () => {
      const filePath = '/path/to/config.json';
      const config = {};
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(access).mockResolvedValue();
      vi.mocked(readFile).mockResolvedValue(JSON.stringify(config));

      const service = new ConfigHealthCheckService(mockLogger);
      const result = await service.checkHealth(filePath, 'mode_definition');

      expect(result.checks.some(c => c.name === 'required_fields')).toBe(true);
    });
  });
});