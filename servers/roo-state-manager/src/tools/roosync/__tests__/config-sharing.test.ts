import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ConfigSharingService } from '../../../services/ConfigSharingService.js';
import { mkdtemp, mkdir, writeFile, readFile, rm, unlink } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { existsSync } from 'fs';

// Mock RooSyncService uniquement
vi.mock('../../../services/RooSyncService.js', () => {
  return {
    RooSyncService: {
      getInstance: vi.fn()
    },
    getRooSyncService: vi.fn()
  };
});

describe('ConfigSharingService', () => {
  let service: ConfigSharingService;
  let mockRooSyncService: any;
  let tempDir: string;
  let sharedPath: string;

  beforeEach(async () => {
    // Créer un environnement de test temporaire
    tempDir = await mkdtemp(join(tmpdir(), 'roosync-test-'));
    sharedPath = join(tempDir, 'shared');
    await mkdir(sharedPath, { recursive: true });
    await mkdir(join(sharedPath, 'configs'), { recursive: true });

    // Mock des services
    const mockConfigService = {
      getSharedStatePath: vi.fn().mockReturnValue(sharedPath),
      getBaselineServiceConfig: vi.fn()
    };

    const mockInventoryCollector = {
      collectInventory: vi.fn()
    };

    service = new ConfigSharingService(mockConfigService as any, mockInventoryCollector as any);
    
    // Créer des fichiers de config factices pour le test
    // On simule que le workspace courant contient roo-modes
    const modesDir = join(process.cwd(), 'roo-modes');
    if (!existsSync(modesDir)) {
        await mkdir(modesDir, { recursive: true });
    }
    await writeFile(join(modesDir, 'test-mode.json'), JSON.stringify({ name: 'test' }));
  });

  afterEach(async () => {
    // Nettoyage
    await rm(tempDir, { recursive: true, force: true });
    // Nettoyage des fichiers factices
    const modesDir = join(process.cwd(), 'roo-modes');
    if (existsSync(join(modesDir, 'test-mode.json'))) {
        await unlink(join(modesDir, 'test-mode.json'));
    }
  });

  it('should collect configuration files', async () => {
    const result = await service.collectConfig({
      targets: ['modes'],
      dryRun: false
    });

    expect(result).toBeDefined();
    expect(result.filesCount).toBeGreaterThan(0);
    expect(result.manifest).toBeDefined();
    // L'auteur est pris de process.env.COMPUTERNAME
    expect(result.manifest.author).toBeDefined();
    
    // Vérifier que le package a été créé
    const packageExists = existsSync(result.packagePath);
    expect(packageExists).toBe(true);
    
    // Vérifier le manifeste
    const manifestPath = join(result.packagePath, 'manifest.json');
    const manifestContent = JSON.parse(await readFile(manifestPath, 'utf-8'));
    expect(manifestContent.files.length).toBeGreaterThan(0);
  });

  it('should publish configuration', async () => {
    // D'abord collecter
    const collectResult = await service.collectConfig({
      targets: ['modes'],
      dryRun: false
    });
    
    // Ensuite publier
    const version = '1.0.0-test';
    const description = 'Test publication';
    
    const result = await service.publishConfig({
      packagePath: collectResult.packagePath,
      version,
      description
    });

    // Vérifier que le dossier cible existe
    const targetExists = existsSync(result.path);
    expect(targetExists).toBe(true);
    expect(result.path).toContain(`baseline-v${version}`);

    // Vérifier que le manifeste a été mis à jour
    const manifestPath = join(result.path, 'manifest.json');
    const manifestContent = JSON.parse(await readFile(manifestPath, 'utf-8'));
    expect(manifestContent.version).toBe(version);
    expect(manifestContent.description).toBe(description);
  });
});