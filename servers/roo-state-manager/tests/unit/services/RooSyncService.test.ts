/**
 * Tests pour RooSyncService.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RooSyncService, getRooSyncService, RooSyncServiceError } from '../../../src/services/RooSyncService.js';

// Variables globales pour les mocks (accessibles depuis les fonctions mock)
declare global {
  var __mockFiles: Map<string, string> | undefined;
  var __mockDirs: Set<string> | undefined;
}

// Initialiser les variables globales
if (!global.__mockFiles) {
  global.__mockFiles = new Map<string, string>();
}
if (!global.__mockDirs) {
  global.__mockDirs = new Set<string>();
}

// Mock du module fs
vi.mock('fs', () => ({
  existsSync: vi.fn((path: string) => {
    return global.__mockDirs!.has(path) || global.__mockFiles!.has(path);
  }),
  mkdirSync: vi.fn((path: string, options?: any) => {
    if (options?.recursive) {
      // Créer les répertoires parents récursivement
      const parts = path.split('/');
      let currentPath = '';
      for (const part of parts) {
        currentPath += (currentPath ? '/' : '') + part;
        if (!global.__mockDirs!.has(currentPath)) {
          global.__mockDirs!.add(currentPath);
        }
      }
    } else {
      global.__mockDirs!.add(path);
    }
  }),
  rmSync: vi.fn((path: string, options?: any) => {
    if (options?.recursive) {
      // Supprimer récursivement
      const keysToDelete: string[] = [];
      for (const key of global.__mockFiles!.keys()) {
        if (key.startsWith(path)) {
          keysToDelete.push(key);
        }
      }
      for (const key of keysToDelete) {
        global.__mockFiles!.delete(key);
      }
      for (const dir of global.__mockDirs!) {
        if (dir.startsWith(path)) {
          global.__mockDirs!.delete(dir);
        }
      }
    } else {
      global.__mockFiles!.delete(path);
      global.__mockDirs!.delete(path);
    }
  }),
  readFileSync: vi.fn((path: string, encoding?: string) => {
    if (global.__mockFiles!.has(path)) {
      return global.__mockFiles!.get(path)!;
    }
    throw new Error(`File not found: ${path}`);
  }),
  writeFileSync: vi.fn((path: string, content: string, encoding?: string) => {
    // S'assurer que le répertoire parent existe
    const dir = path.substring(0, path.lastIndexOf('/'));
    if (dir && !global.__mockDirs!.has(dir)) {
      global.__mockDirs!.add(dir);
    }
    global.__mockFiles!.set(path, content);
  }),
  promises: {
    readFile: vi.fn(async (path: string, encoding?: string) => {
      if (global.__mockFiles!.has(path)) {
        return global.__mockFiles!.get(path)!;
      }
      throw new Error(`File not found: ${path}`);
    }),
    writeFile: vi.fn(async (path: string, content: string, encoding?: string) => {
      // S'assurer que le répertoire parent existe
      const dir = path.substring(0, path.lastIndexOf('/'));
      if (dir && !global.__mockDirs!.has(dir)) {
        global.__mockDirs!.add(dir);
      }
      global.__mockFiles!.set(path, content);
    }),
    mkdir: vi.fn(async (path: string, options?: any) => {
      if (options?.recursive) {
        // Créer les répertoires parents récursivement
        const parts = path.split('/');
        let currentPath = '';
        for (const part of parts) {
          currentPath += (currentPath ? '/' : '') + part;
          if (!global.__mockDirs!.has(currentPath)) {
            global.__mockDirs!.add(currentPath);
          }
        }
      } else {
        global.__mockDirs!.add(path);
      }
    }),
    readdir: vi.fn(async (path: string) => {
      const items: string[] = [];
      const prefix = path.endsWith('/') ? path : path + '/';
      
      for (const file of global.__mockFiles!.keys()) {
        if (file.startsWith(prefix)) {
          const relativePath = file.substring(prefix.length);
          const firstPart = relativePath.includes('/') ? relativePath.split('/')[0] : relativePath;
          if (!items.includes(firstPart)) {
            items.push(firstPart);
          }
        }
      }
      
      for (const dir of global.__mockDirs!) {
        if (dir.startsWith(prefix) && dir !== prefix) {
          const relativePath = dir.substring(prefix.length);
          const firstPart = relativePath.includes('/') ? relativePath.split('/')[0] : relativePath;
          if (!items.includes(firstPart)) {
            items.push(firstPart);
          }
        }
      }
      
      return items;
    }),
    copyFile: vi.fn(async (source: string, dest: string) => {
      if (global.__mockFiles!.has(source)) {
        const content = global.__mockFiles!.get(source)!;
        // S'assurer que le répertoire de destination existe
        const dir = dest.substring(0, dest.lastIndexOf('/'));
        if (dir && !global.__mockDirs!.has(dir)) {
          global.__mockDirs!.add(dir);
        }
        global.__mockFiles!.set(dest, content);
      } else {
        throw new Error(`Source file not found: ${source}`);
      }
    })
  }
}));

// Mock du module path
vi.mock('path', () => ({
  join: vi.fn((...paths: string[]) => {
    return paths.join('/').replace(/\/+/g, '/');
  }),
  normalize: vi.fn((path: string) => {
    return path.replace(/\/+/g, '/');
  }),
  dirname: vi.fn((path: string) => {
    const parts = path.split('/');
    parts.pop();
    return parts.join('/');
  }),
  resolve: vi.fn((...paths: string[]) => {
    return paths.join('/').replace(/\/+/g, '/');
  }),
  default: {
    join: vi.fn((...paths: string[]) => {
      return paths.join('/').replace(/\/+/g, '/');
    }),
    normalize: vi.fn((path: string) => {
      return path.replace(/\/+/g, '/');
    }),
    dirname: vi.fn((path: string) => {
      const parts = path.split('/');
      parts.pop();
      return parts.join('/');
    }),
    resolve: vi.fn((...paths: string[]) => {
      return paths.join('/').replace(/\/+/g, '/');
    })
  }
}));

// Importer les fonctions après les mocks
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

describe('RooSyncService', () => {
  const testDir = join(__dirname, '../../fixtures/roosync-service-test');

  beforeEach(() => {
    // Réinitialiser l'état des mocks avant chaque test
    global.__mockFiles!.clear();
    global.__mockDirs!.clear();
    // Créer le répertoire de test
    try {
      mkdirSync(testDir, { recursive: true });
    } catch (error) {
      // Déjà existant
    }

    // Créer des fichiers de test
    const dashboard = {
      version: '2.0.0',
      lastUpdate: '2025-10-07T12:00:00Z',
      overallStatus: 'synced',
      machines: {
        'PC-PRINCIPAL': {
          lastSync: '2025-10-07T11:00:00Z',
          status: 'online',
          diffsCount: 0,
          pendingDecisions: 0
        }
      }
    };

    const roadmap = `# Roadmap

<!-- DECISION_BLOCK_START -->
**ID:** \`d1\`
**Titre:** Test Decision
**Statut:** pending
**Type:** config
**Machine Source:** PC-PRINCIPAL
**Machines Cibles:** all
**Créé:** 2025-10-07T10:00:00Z
<!-- DECISION_BLOCK_END -->
`;

    const config = {
      version: '2.0.0',
      sharedStatePath: testDir
    };

    writeFileSync(join(testDir, 'sync-dashboard.json'), JSON.stringify(dashboard), 'utf-8');
    writeFileSync(join(testDir, 'sync-roadmap.md'), roadmap, 'utf-8');
    writeFileSync(join(testDir, 'sync-config.json'), JSON.stringify(config), 'utf-8');

    // Mock de l'environnement
    process.env.ROOSYNC_SHARED_PATH = testDir;
    process.env.ROOSYNC_MACHINE_ID = 'PC-PRINCIPAL';
    process.env.ROOSYNC_AUTO_SYNC = 'false';
    process.env.ROOSYNC_CONFLICT_STRATEGY = 'manual';
    process.env.ROOSYNC_LOG_LEVEL = 'info';

    // Réinitialiser le singleton
    RooSyncService.resetInstance();
  });

  afterEach(() => {
    // Nettoyer
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore
    }

    RooSyncService.resetInstance();
  });

  describe('Singleton Pattern', () => {
    it('devrait retourner la même instance', () => {
      // Act
      const instance1 = getRooSyncService();
      const instance2 = getRooSyncService();

      // Assert
      expect(instance1).toBe(instance2);
    });

    it('devrait permettre de réinitialiser l\'instance', () => {
      // Arrange
      const instance1 = getRooSyncService();

      // Act
      RooSyncService.resetInstance();
      const instance2 = getRooSyncService();

      // Assert
      expect(instance1).not.toBe(instance2);
    });
  });

  describe('loadDashboard', () => {
    it('devrait charger le dashboard avec succès', async () => {
      // Arrange
      const service = getRooSyncService();

      // Act
      const dashboard = await service.loadDashboard();

      // Assert
      expect(dashboard.version).toBe('2.0.0');
      expect(dashboard.machines['PC-PRINCIPAL']).toBeDefined();
      expect(dashboard.machines['PC-PRINCIPAL'].diffsCount).toBe(0);
    });

    it('devrait utiliser le cache', async () => {
      // Arrange
      const service = getRooSyncService({ ttl: 60000 });

      // Act
      const dashboard1 = await service.loadDashboard();

      // Modifier le fichier
      const newDashboard = JSON.parse(readFileSync(join(testDir, 'sync-dashboard.json'), 'utf-8'));
      newDashboard.overallStatus = 'diverged';
      writeFileSync(join(testDir, 'sync-dashboard.json'), JSON.stringify(newDashboard), 'utf-8');

      const dashboard2 = await service.loadDashboard();

      // Assert
      expect(dashboard1.overallStatus).toBe('synced');
      expect(dashboard2.overallStatus).toBe('synced'); // Toujours en cache
    });

    it('devrait retourner un dashboard par défaut si le fichier n\'existe pas', async () => {
      // Arrange
      rmSync(join(testDir, 'sync-dashboard.json'));
      const service = getRooSyncService();

      // Act
      const dashboard = await service.loadDashboard();

      // Assert
      expect(dashboard).toBeDefined();
      expect(dashboard.version).toBe('2.1.0');
      expect(dashboard.overallStatus).toBeDefined();
    });
  });

  describe('loadDecisions', () => {
    it('devrait charger toutes les décisions', async () => {
      // Arrange
      const service = getRooSyncService();

      // Act
      const decisions = await service.loadDecisions();

      // Assert
      expect(decisions).toHaveLength(1);
      expect(decisions[0].id).toBe('d1');
      expect(decisions[0].title).toBe('Test Decision');
    });
  });

  describe('getDecision', () => {
    it('devrait récupérer une décision par ID', async () => {
      // Arrange
      const service = getRooSyncService();

      // Act
      const decision = await service.getDecision('d1');

      // Assert
      expect(decision).not.toBeNull();
      expect(decision?.id).toBe('d1');
    });

    it('devrait retourner null si la décision n\'existe pas', async () => {
      // Arrange
      const service = getRooSyncService();

      // Act
      const decision = await service.getDecision('nonexistent');

      // Assert
      expect(decision).toBeNull();
    });
  });

  describe('getStatus', () => {
    it('devrait retourner l\'état de synchronisation', async () => {
      // Arrange
      const service = getRooSyncService();

      // Act
      const status = await service.getStatus();

      // Assert
      expect(status.machineId).toBe('PC-PRINCIPAL');
      expect(status.overallStatus).toBe('synced');
      expect(status.diffsCount).toBe(0);
      expect(status.pendingDecisions).toBe(0);
    });
  });

  describe('clearCache', () => {
    it('devrait vider le cache', async () => {
      // Arrange
      const service = getRooSyncService();
      await service.loadDashboard(); // Mettre en cache

      // Act
      service.clearCache();

      // Modifier le fichier
      const newDashboard = JSON.parse(readFileSync(join(testDir, 'sync-dashboard.json'), 'utf-8'));
      newDashboard.overallStatus = 'diverged';
      writeFileSync(join(testDir, 'sync-dashboard.json'), JSON.stringify(newDashboard), 'utf-8');

      const dashboard = await service.loadDashboard();

      // Assert
      expect(dashboard.overallStatus).toBe('diverged'); // Pas en cache
    });
  });
});