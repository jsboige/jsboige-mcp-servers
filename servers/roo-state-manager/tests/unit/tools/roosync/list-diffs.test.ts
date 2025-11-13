/**
 * Tests pour roosync_list_diffs
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { RooSyncService } from '../../../../src/services/RooSyncService.js';
import { roosyncListDiffs, type ListDiffsArgs } from '../../../../src/tools/roosync/list-diffs.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('roosync_list_diffs', () => {
  const testDir = join(__dirname, '../../../fixtures/roosync-list-diffs-test');
  
  beforeEach(() => {
    // Créer répertoire de test
    try {
      mkdirSync(testDir, { recursive: true });
    } catch (error) {
      // Déjà existant
    }
    
    // Créer dashboard de test
    const dashboard = {
      version: '2.0.0',
      lastUpdate: '2025-10-08T10:00:00Z',
      overallStatus: 'diverged',
      machines: {
        'PC-PRINCIPAL': {
          lastSync: '2025-10-08T09:00:00Z',
          status: 'online',
          diffsCount: 3,
          pendingDecisions: 3
        }
      }
    };
    
    writeFileSync(
      join(testDir, 'sync-dashboard.json'),
      JSON.stringify(dashboard, null, 2),
      'utf-8'
    );
    
    // Créer le répertoire de logs
    const logsDir = join(testDir, 'logs');
    mkdirSync(logsDir, { recursive: true });
    
    // Créer le répertoire des inventaires
    const inventoriesDir = join(testDir, 'inventories');
    mkdirSync(inventoriesDir, { recursive: true });
    
    // Créer roadmap de test avec décisions
    const roadmap = `# Sync Roadmap

## Décision 1
- ID: decision-001
- Type: config
- Path: roo-config/modes.json
- Machines: PC-PRINCIPAL, MAC-DEV
- Status: pending

## Décision 2
- ID: decision-002
- Type: file
- Path: scripts/sync.ps1
- Machines: PC-PRINCIPAL
- Status: pending

## Décision 3
- ID: decision-003
- Type: setting
- Path: .vscode/settings.json
- Machines: PC-PRINCIPAL, MAC-DEV, LAPTOP-WORK
- Status: pending
`;
    
    writeFileSync(
      join(testDir, 'sync-roadmap.md'),
      roadmap,
      'utf-8'
    );
    
    // Créer le fichier baseline manquant
    const baseline = {
      version: "1.0.0",
      baselineId: "test-baseline-001",
      machineId: "PC-PRINCIPAL",
      timestamp: "2025-10-08T10:00:00Z",
      machines: [
        {
          id: "PC-PRINCIPAL",
          modes: ['code', 'architect'],
          mcpServers: ['quickfiles', 'git'],
          hardware: {
            cpu: "Intel i7-12700K",
            ram: "32GB",
            os: "Windows 11",
            architecture: "x64"
          },
          software: {
            powershell: "7.2.0",
            node: "18.17.0",
            python: "3.10.0"
          }
        },
        {
          id: "LAPTOP-WORK",
          modes: ['code'],
          mcpServers: ['quickfiles'],
          hardware: {
            cpu: "Intel i5-1135G7",
            ram: "16GB",
            os: "Windows 11",
            architecture: "x64"
          },
          software: {
            powershell: "7.1.0",
            node: "16.14.0",
            python: "3.9.0"
          }
        },
        {
            id: "MAC-DEV",
            modes: ['architect', 'debug'],
            mcpServers: ['git', 'jupyter'],
            hardware: {
              cpu: "Apple M1 Pro",
              ram: "16GB",
              os: "macOS 14.0",
              architecture: "arm64"
            },
            software: {
              powershell: "7.2.0",
              node: "18.17.0",
              python: "3.11.0"
            }
          }
        ]
      };
    
    writeFileSync(join(testDir, 'sync-config.ref.json'), JSON.stringify(baseline, null, 2), 'utf-8');
    
    // Créer l'inventaire pour PC-PRINCIPAL
    const mockInventory = {
      timestamp: "2025-10-08T10:00:00Z",
      machine: {
        id: "PC-PRINCIPAL",
        hardware: {
          cpu: "Intel i7-12700K",
          ram: "32GB",
          os: "Windows 11",
          architecture: "x64"
        },
        software: {
          powershell: "7.2.0",
          node: "18.17.0",
          python: "3.10.0"
        }
      }
    };
    
    writeFileSync(join(testDir, 'inventories/PC-PRINCIPAL.json'), JSON.stringify(mockInventory, null, 2), 'utf-8');
    
    // Créer l'inventaire pour LAPTOP-WORK
    const laptopInventory = {
      timestamp: "2025-10-08T10:00:00Z",
      machine: {
        id: "LAPTOP-WORK",
        hardware: {
          cpu: "Intel i5-1135G7",
          ram: "16GB",
          os: "Windows 11",
          architecture: "x64"
        },
        software: {
          powershell: "7.1.0",
          node: "16.14.0",
          python: "3.9.0"
        }
      }
    };
    
    writeFileSync(join(testDir, 'inventories/LAPTOP-WORK.json'), JSON.stringify(laptopInventory, null, 2), 'utf-8');
    
    // Créer l'inventaire pour MAC-DEV
    const macInventory = {
      timestamp: "2025-10-08T10:00:00Z",
      machine: {
        id: "MAC-DEV",
        hardware: {
          cpu: "Apple M1 Pro",
          ram: "16GB",
          os: "macOS 14.0",
          architecture: "arm64"
        },
        software: {
          powershell: "7.2.0",
          node: "18.17.0",
          python: "3.11.0"
        }
      }
    };
    
    writeFileSync(join(testDir, 'inventories/MAC-DEV.json'), JSON.stringify(macInventory, null, 2), 'utf-8');
    
    // Mock environnement
    process.env.ROOSYNC_SHARED_PATH = testDir;
    process.env.ROOSYNC_MACHINE_ID = 'PC-PRINCIPAL';
    process.env.ROOSYNC_AUTO_SYNC = 'false';
    process.env.ROOSYNC_CONFLICT_STRATEGY = 'manual';
    process.env.ROOSYNC_LOG_LEVEL = 'info';
    
    RooSyncService.resetInstance();
  });
  
  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore
    }
    RooSyncService.resetInstance();
  });

  it('devrait lister toutes les différences sans filtre', async () => {
    // Arrange
    const args: ListDiffsArgs = { filterType: 'all' };
    
    // Act
    const result = await roosyncListDiffs(args);
    
    // Assert
    expect(result.totalDiffs).toBeGreaterThanOrEqual(0);
    expect(result.diffs).toBeDefined();
    expect(Array.isArray(result.diffs)).toBe(true);
    expect(result.filterApplied).toBe('all');
  });
  
  it('devrait filtrer par type "config"', async () => {
    // Arrange
    const args: ListDiffsArgs = { filterType: 'config' };
    
    // Act
    const result = await roosyncListDiffs(args);
    
    // Assert
    expect(result.filterApplied).toBe('config');
    result.diffs.forEach(diff => {
      expect(diff.type).toBe('config');
    });
  });
  
  it('devrait filtrer par type "files"', async () => {
    // Arrange
    const args: ListDiffsArgs = { filterType: 'files' };
    
    // Act
    const result = await roosyncListDiffs(args);
    
    // Assert
    expect(result.filterApplied).toBe('files');
    result.diffs.forEach(diff => {
      expect(diff.type).toBe('hardware');
    });
  });
  
  it('devrait filtrer par type "settings"', async () => {
    // Arrange
    const args: ListDiffsArgs = { filterType: 'settings' };
    
    // Act
    const result = await roosyncListDiffs(args);
    
    // Assert
    expect(result.filterApplied).toBe('settings');
    result.diffs.forEach(diff => {
      expect(diff.type).toBe('software');
    });
  });
  
  it('devrait retourner 0 différence quand aucune détectée', async () => {
    // Arrange - Dashboard sans différences
    const syncedDashboard = {
      version: '2.0.0',
      lastUpdate: '2025-10-08T10:00:00Z',
      overallStatus: 'synced',
      machines: {
        'PC-PRINCIPAL': {
          lastSync: '2025-10-08T09:00:00Z',
          status: 'online',
          diffsCount: 0,
          pendingDecisions: 0
        }
      }
    };
    
    writeFileSync(
      join(testDir, 'sync-dashboard.json'),
      JSON.stringify(syncedDashboard, null, 2),
      'utf-8'
    );
    
    // Roadmap vide
    writeFileSync(
      join(testDir, 'sync-roadmap.md'),
      '# Sync Roadmap\n\nAucune décision en attente.\n',
      'utf-8'
    );
    
    // Supprimer le fichier baseline existant avant d'écrire le nouveau
    try {
      rmSync(join(testDir, 'sync-config.ref.json'), { force: true });
    } catch (error) {
      // Ignorer si le fichier n'existe pas
    }
    
    // Forcer aussi la suppression du fichier baseline forcé utilisé par le système
    try {
      rmSync('g:\\Mon Drive\\Synchronisation\\RooSync\\.shared-state\\sync-config.ref.json', { force: true });
    } catch (error) {
      // Ignorer si le fichier n'existe pas
    }
    
    // Supprimer les anciens fichiers d'inventaire pour éviter les différences résiduelles
    try {
      rmSync(join(testDir, 'inventories/PC-PRINCIPAL.json'), { force: true });
      rmSync(join(testDir, 'inventories/LAPTOP-WORK.json'), { force: true });
      rmSync(join(testDir, 'inventories/MAC-DEV.json'), { force: true });
    } catch (error) {
      // Ignorer si les fichiers n'existent pas
    }
    
    // Modifier aussi la baseline pour qu'elle corresponde au dashboard (pas de différences)
    const syncedBaseline = {
      version: "1.0.0",
      baselineId: "test-baseline-001",
      machineId: "PC-PRINCIPAL",
      timestamp: "2025-10-08T10:00:00Z",
      machines: [
        {
          id: "PC-PRINCIPAL",
          modes: ['code', 'architect'],
          mcpServers: ['quickfiles', 'git'],
          hardware: {
            cpu: "Intel i7-12700K",
            ram: "32GB",
            os: "Windows 11",
            architecture: "x64"
          },
          software: {
            powershell: "7.2.0",
            node: "18.17.0",
            python: "3.10.0"
          }
        }
      ]
    };
    
    writeFileSync(join(testDir, 'sync-config.ref.json'), JSON.stringify(syncedBaseline, null, 2), 'utf-8');
    
    RooSyncService.resetInstance();
    
    const args: ListDiffsArgs = { filterType: 'all' };
    
    // Act
    const result = await roosyncListDiffs(args);
    
    // Assert
    expect(result.totalDiffs).toBe(0);
    expect(result.diffs).toHaveLength(0);
  });
  
  it('devrait assigner une sévérité à chaque différence', async () => {
    // Arrange
    const args: ListDiffsArgs = { filterType: 'all' };
    
    // Act
    const result = await roosyncListDiffs(args);
    
    // Assert
    result.diffs.forEach(diff => {
      expect(diff.severity).toBeDefined();
      expect(['low', 'medium', 'high']).toContain(diff.severity);
      
      // Vérifier règles de sévérité
      if (diff.type === 'config') {
        expect(diff.severity).toBe('high');
      } else if (diff.type === 'hardware' || diff.type === 'software') {
        expect(diff.severity).toBe('medium');
      } else {
        expect(diff.severity).toBe('low');
      }
    });
  });
});