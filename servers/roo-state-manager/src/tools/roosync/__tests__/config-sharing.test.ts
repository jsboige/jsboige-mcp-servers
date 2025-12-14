import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// Unmock fs et fs/promises pour utiliser le vrai système de fichiers
vi.unmock('fs');
vi.unmock('fs/promises');
import { ConfigSharingService } from '../../../services/ConfigSharingService.js';
// S'assurer que fs et fs/promises ne sont pas mockés pour ce test qui utilise le vrai FS
vi.unmock('fs');
vi.unmock('fs/promises');
import { mkdtemp, mkdir, writeFile, readFile, rm, unlink } from 'fs/promises';
import { join, dirname } from 'path';
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
  let tempDir: string;
  let sharedPath: string;

  beforeEach(async () => {
    // Créer un environnement de test temporaire
    // Le mock de mkdtemp sera utilisé ici
    tempDir = await mkdtemp('roosync-test-');

    // Vérifier que tempDir est bien défini
    if (!tempDir) {
        throw new Error('mkdtemp returned undefined');
    }

    sharedPath = join(tempDir, 'shared');

    // Utiliser les fonctions importées (qui sont soit mockées soit originales)
    await mkdir(sharedPath, { recursive: true });
    await mkdir(join(sharedPath, 'configs'), { recursive: true });

    // Créer un répertoire source factice dans tempDir pour éviter de polluer le projet
    const sourceModesDir = join(tempDir, 'source-modes');
    await mkdir(sourceModesDir, { recursive: true });
    await writeFile(join(sourceModesDir, 'test-mode.json'), JSON.stringify({ name: 'test' }));

    // Mock des services injectés
    const mockConfigService = {
      getSharedStatePath: vi.fn().mockReturnValue(sharedPath),
      getBaselineServiceConfig: vi.fn()
    };

    const mockInventoryCollector = {
      collectInventory: vi.fn().mockResolvedValue({
        paths: {
          rooExtensions: dirname(sourceModesDir) // Pour que join(..., 'roo-modes') fonctionne, il faut ruser ou mocker différemment
        }
      })
    };

    // On va plutôt mocker le chemin retourné par l'inventaire pour qu'il pointe vers notre dossier source
    // ConfigSharingService fait: rooModesPath = join(inventory.paths.rooExtensions, 'roo-modes');
    // Donc si on veut que rooModesPath = sourceModesDir, il faut que inventory.paths.rooExtensions soit le parent de sourceModesDir
    // ET que sourceModesDir s'appelle 'roo-modes'.

    const fakeRooExtensions = join(tempDir, 'fake-extensions');
    const fakeRooModes = join(fakeRooExtensions, 'roo-modes');
    await mkdir(fakeRooModes, { recursive: true });
    await writeFile(join(fakeRooModes, 'test-mode.json'), JSON.stringify({ name: 'test' }));

    mockInventoryCollector.collectInventory.mockResolvedValue({
        paths: {
            rooExtensions: fakeRooExtensions
        }
    });

    service = new ConfigSharingService(mockConfigService as any, mockInventoryCollector as any);

    // Créer des fichiers de config factices pour le test
    // On simule que le workspace courant contient roo-modes
    // Utiliser un mock pour process.cwd() ou modifier le comportement du service pour accepter un chemin racine
    // Ici on va mocker process.cwd() pour pointer vers tempDir
    vi.spyOn(process, 'cwd').mockReturnValue(tempDir);

    const modesDir = join(tempDir, 'roo-modes');
    await mkdir(modesDir, { recursive: true });
    await writeFile(join(modesDir, 'test-mode.json'), JSON.stringify({ name: 'test' }));
  });

  afterEach(async () => {
    // Nettoyage
    await rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('should collect configuration files', async () => {
    const result = await service.collectConfig({
      targets: ['modes'],
      dryRun: false
    });

    expect(result).toBeDefined();
    expect(result.filesCount).toBeGreaterThan(0);
    expect(result.manifest).toBeDefined();
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
