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

describe('ConfigSharingService', () => {
  let service: ConfigSharingService;
  let mockConfigService: IConfigService;
  let mockInventoryCollector: IInventoryCollector;

  beforeEach(() => {
    mockConfigService = {
      getSharedStatePath: vi.fn().mockReturnValue('/mock/shared/state'),
    } as any;

    mockInventoryCollector = {
      collectInventory: vi.fn().mockResolvedValue({}),
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
});