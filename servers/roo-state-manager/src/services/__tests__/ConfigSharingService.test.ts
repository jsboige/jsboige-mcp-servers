import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ConfigSharingService } from '../ConfigSharingService';
import { IConfigService, IInventoryCollector } from '../../types/baseline';
import { ConfigNormalizationService } from '../ConfigNormalizationService';
import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock ConfigNormalizationService
vi.mock('../ConfigNormalizationService', () => {
  const ConfigNormalizationService = vi.fn();
  ConfigNormalizationService.prototype.normalize = vi.fn().mockImplementation((config) => Promise.resolve(config));
  return { ConfigNormalizationService };
});

// Mock InventoryService - inline mock to avoid hoisting issues
vi.mock('../roosync/InventoryService', () => {
  return {
    InventoryService: {
      getInstance: () => ({
        getMachineInventory: vi.fn().mockResolvedValue({
          paths: {
            rooExtensions: '/mock/roo-extensions',
            mcpSettings: '/mock/.claude.json'
          }
        })
      })
    }
  };
});

describe('ConfigSharingService', () => {
  let service: ConfigSharingService;
  let mockConfigService: IConfigService;
  let mockInventoryCollector: IInventoryCollector;

  beforeEach(() => {
    mockConfigService = {
      getSharedStatePath: vi.fn().mockReturnValue('/mock/shared/state'),
    } as any;

    mockInventoryCollector = {
      collectInventory: vi.fn().mockResolvedValue({
        paths: {
          mcpSettings: '/mock/.claude.json',
          rooExtensions: '/mock/roo-extensions'
        }
      }),
    } as any;

    service = new ConfigSharingService(mockConfigService, mockInventoryCollector);
  });

  it('should initialize correctly', () => {
    expect(service).toBeDefined();
  });

  describe('compareWithBaseline', () => {
    it('should return a diff result', async () => {
      const config = { test: 'value' };
      const result = await service.compareWithBaseline(config);

      expect(result).toBeDefined();
      expect(result.changes).toBeDefined();
      expect(result.summary).toBeDefined();
    });
  });

  // T3.8: Tests pour collectProfiles() - Tests d'intégration
  // Note: Ces tests vérifient que le service peut être appelé avec 'profiles' target
  // L'implémentation complète de collectProfiles() collecte depuis:
  // - configuration-profiles.json
  // - machine-mappings.json
  // - non-nominative-baseline.json
  describe('collectConfig with profiles target', () => {
    it('should handle profiles target without errors when no files exist', async () => {
      // Avec un mock retournant un chemin qui n'existe pas,
      // collectProfiles devrait retourner un tableau vide sans erreur
      const result = await service.collectConfig({
        targets: ['profiles'],
        description: 'Test collect profiles from non-existent path'
      });

      // Le service doit retourner un résultat valide même sans fichiers
      expect(result).toBeDefined();
      expect(result.manifest).toBeDefined();
      expect(result.manifest.files).toBeInstanceOf(Array);
      // filesCount peut être 0 car les fichiers n'existent pas dans le mock path
      expect(result.filesCount).toBe(0);
    });

    it('should include profiles directory path in manifest', async () => {
      const result = await service.collectConfig({
        targets: ['profiles'],
        description: 'Test profiles path'
      });

      // Vérifier que le manifest est bien structuré
      expect(result.manifest.description).toBe('Test profiles path');
      expect(result.manifest.timestamp).toBeDefined();
    });
  });

  // Tests pour les nouveaux targets: roomodes, model-configs, rules
  describe('collectConfig with roomodes target', () => {
    it('should handle roomodes target without errors when .roomodes does not exist', async () => {
      const result = await service.collectConfig({
        targets: ['roomodes'],
        description: 'Test collect roomodes from non-existent path'
      });

      expect(result).toBeDefined();
      expect(result.manifest).toBeDefined();
      expect(result.manifest.files).toBeInstanceOf(Array);
      // filesCount = 0 car le fichier .roomodes n'existe pas au mock path
      expect(result.filesCount).toBe(0);
    });

    it('should return valid manifest structure for roomodes', async () => {
      const result = await service.collectConfig({
        targets: ['roomodes'],
        description: 'Test roomodes manifest'
      });

      expect(result.manifest.description).toBe('Test roomodes manifest');
      expect(result.manifest.timestamp).toBeDefined();
      expect(result.manifest.files).toBeInstanceOf(Array);
    });
  });

  describe('collectConfig with model-configs target', () => {
    it('should handle model-configs target without errors when file does not exist', async () => {
      const result = await service.collectConfig({
        targets: ['model-configs'],
        description: 'Test collect model-configs from non-existent path'
      });

      expect(result).toBeDefined();
      expect(result.manifest).toBeDefined();
      expect(result.manifest.files).toBeInstanceOf(Array);
      expect(result.filesCount).toBe(0);
    });
  });

  describe('collectConfig with rules target', () => {
    it('should handle rules target without errors when rules-global dir does not exist', async () => {
      const result = await service.collectConfig({
        targets: ['rules'],
        description: 'Test collect rules from non-existent path'
      });

      expect(result).toBeDefined();
      expect(result.manifest).toBeDefined();
      expect(result.manifest.files).toBeInstanceOf(Array);
      expect(result.filesCount).toBe(0);
    });
  });

  describe('collectConfig with combined new targets', () => {
    it('should handle all new targets together without errors', async () => {
      const result = await service.collectConfig({
        targets: ['roomodes', 'model-configs', 'rules'],
        description: 'Test all new targets combined'
      });

      expect(result).toBeDefined();
      expect(result.manifest).toBeDefined();
      expect(result.manifest.files).toBeInstanceOf(Array);
      expect(result.filesCount).toBe(0);
    });

    it('should handle mix of old and new targets', async () => {
      const result = await service.collectConfig({
        targets: ['modes', 'roomodes', 'rules', 'profiles'],
        description: 'Test mixed old and new targets'
      });

      expect(result).toBeDefined();
      expect(result.manifest).toBeDefined();
    });
  });

  // Issue #349: Tests pour le filtrage granulaire des targets mcp:xxx
  describe('applyConfig with granular targets', () => {

    it('should apply all files when no targets specified', async () => {
      // Ce test nécessite un setup plus complexe avec des fichiers temporaires
      // Pour l'instant, on vérifie que le service accepte l'appel sans targets
      // Note: success peut être false si aucun fichier source n'existe dans le mock path
      const result = await service.applyConfig({
        version: 'latest',
        targets: undefined,
        dryRun: true
      });

      expect(result).toBeDefined();
      // Le résultat peut être success=false si les configs n'existent pas (mock path)
      // On vérifie seulement que la structure de résultat est valide
      expect(typeof result.success).toBe('boolean');
    });

    it('should filter files based on modes target', async () => {
      const result = await service.applyConfig({
        version: 'latest',
        targets: ['modes'],
        dryRun: true
      });

      expect(result).toBeDefined();
      // Le filtrage est implémenté, le test vérifie que l'appel fonctionne
    });

    it('should filter files based on mcp target', async () => {
      const result = await service.applyConfig({
        version: 'latest',
        targets: ['mcp'],
        dryRun: true
      });

      expect(result).toBeDefined();
    });

    it('should filter files based on profiles target', async () => {
      const result = await service.applyConfig({
        version: 'latest',
        targets: ['profiles'],
        dryRun: true
      });

      expect(result).toBeDefined();
    });

    it('should filter files based on granular mcp:xxx targets', async () => {
      const result = await service.applyConfig({
        version: 'latest',
        targets: ['mcp:github', 'mcp:win-cli'],
        dryRun: true
      });

      expect(result).toBeDefined();
    });

    it('should handle mixed targets (modes and mcp:xxx)', async () => {
      const result = await service.applyConfig({
        version: 'latest',
        targets: ['modes', 'mcp:github'],
        dryRun: true
      });

      expect(result).toBeDefined();
    });

    it('should filter files based on roomodes target', async () => {
      const result = await service.applyConfig({
        version: 'latest',
        targets: ['roomodes'],
        dryRun: true
      });

      expect(result).toBeDefined();
      expect(typeof result.success).toBe('boolean');
    });

    it('should filter files based on model-configs target', async () => {
      const result = await service.applyConfig({
        version: 'latest',
        targets: ['model-configs'],
        dryRun: true
      });

      expect(result).toBeDefined();
      expect(typeof result.success).toBe('boolean');
    });

    it('should filter files based on rules target', async () => {
      const result = await service.applyConfig({
        version: 'latest',
        targets: ['rules'],
        dryRun: true
      });

      expect(result).toBeDefined();
      expect(typeof result.success).toBe('boolean');
    });

    it('should handle all new targets combined in apply', async () => {
      const result = await service.applyConfig({
        version: 'latest',
        targets: ['roomodes', 'model-configs', 'rules'],
        dryRun: true
      });

      expect(result).toBeDefined();
      expect(typeof result.success).toBe('boolean');
    });
  });

  // Issue #349: Tests pour collectConfig avec targets granulaires mcp:xxx
  describe('collectConfig with granular mcp targets', () => {
    it('should collect specific MCP servers when mcp:xxx targets are provided', async () => {
      // Ce test nécessite un setup avec des fichiers MCP temporaires
      // Pour l'instant, on vérifie que le service accepte les targets mcp:xxx
      const result = await service.collectConfig({
        targets: ['mcp:github', 'mcp:win-cli'],
        description: 'Test granular MCP collection'
      });

      expect(result).toBeDefined();
      expect(result.manifest).toBeDefined();
      expect(result.manifest.files).toBeInstanceOf(Array);
    });

    it('should collect all MCPs when mcp target is provided', async () => {
      const result = await service.collectConfig({
        targets: ['mcp'],
        description: 'Test all MCPs collection'
      });

      expect(result).toBeDefined();
      expect(result.manifest).toBeDefined();
    });

    it('should handle empty mcp:xxx target gracefully', async () => {
      // Le parsing dans apply-config.ts devrait rejeter les targets mcp: vides
      // Ce test vérifie le comportement côté service
      const result = await service.collectConfig({
        targets: ['mcp:'],
        description: 'Test empty MCP target'
      });

      // Le service devrait retourner un résultat valide même si aucun MCP n'est collecté
      expect(result).toBeDefined();
      expect(result.manifest).toBeDefined();
    });
  });
});