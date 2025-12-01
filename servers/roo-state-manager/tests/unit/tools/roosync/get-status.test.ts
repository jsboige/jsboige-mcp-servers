/**
 * Tests pour roosync_get_status
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Mock pour RooSyncService
const { mockRooSyncService, mockRooSyncServiceError, mockGetRooSyncService } = vi.hoisted(() => {
  // Mock de la classe d'erreur
  const errorClass = class extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'RooSyncServiceError';
    }
  };
  
  const service = {
    resetInstance: vi.fn(),
    getInstance: vi.fn(() => ({
      getConfig: vi.fn().mockReturnValue({
        version: '2.0.0',
        sharedStatePath: '/mock/shared',
        baselinePath: '/mock/baseline',
        machines: {
          'PC-PRINCIPAL': {
            id: 'PC-PRINCIPAL',
            name: 'PC Principal',
            basePath: '/mock/pc-principal',
            lastSync: '2025-10-08T09:00:00Z',
            status: 'online',
            diffsCount: 0,
            pendingDecisions: 0
          },
          'MAC-DEV': {
            id: 'MAC-DEV',
            name: 'Mac Dev',
            basePath: '/mock/mac-dev',
            lastSync: '2025-10-08T08:00:00Z',
            status: 'online',
            diffsCount: 2,
            pendingDecisions: 1
          }
        }
      }),
      getStatus: vi.fn().mockImplementation((filterMachine?: string) => {
        const status = {
          version: '2.0.0',
          lastUpdate: '2025-10-08T10:00:00Z',
          overallStatus: 'synced',
          machines: {
            'PC-PRINCIPAL': {
              id: 'PC-PRINCIPAL',
              name: 'PC Principal',
              lastSync: '2025-10-08T09:00:00Z',
              status: 'online',
              diffsCount: 0,
              pendingDecisions: 0
            },
            'MAC-DEV': {
              id: 'MAC-DEV',
              name: 'Mac Dev',
              lastSync: '2025-10-08T08:00:00Z',
              status: 'online',
              diffsCount: 2,
              pendingDecisions: 1
            },
            'LAPTOP-WORK': {
              id: 'LAPTOP-WORK',
              name: 'Laptop Work',
              lastSync: '2025-10-07T18:00:00Z',
              status: 'offline',
              diffsCount: 5,
              pendingDecisions: 3
            }
          },
          statistics: {
            totalMachines: 3,
            onlineMachines: 2,
            totalDifferences: 7,
            pendingDecisions: 4,
            lastSync: '2025-10-08T09:00:00Z'
          }
        };
        if (filterMachine) {
          if (!(filterMachine in status.machines)) {
            throw new mockRooSyncServiceError(`Machine '${filterMachine}' non trouvée`);
          }
          return {
            ...status,
            machines: { [filterMachine]: status.machines[filterMachine as keyof typeof status.machines] }
          };
        }
        
        return status;
      }),
      loadDashboard: vi.fn().mockResolvedValue({
        version: '2.0.0',
        lastUpdate: '2025-10-08T10:00:00Z',
        overallStatus: 'synced',
        machines: {
          'PC-PRINCIPAL': {
            id: 'PC-PRINCIPAL',
            name: 'PC Principal',
            lastSync: '2025-10-08T09:00:00Z',
            status: 'online',
            diffsCount: 0,
            pendingDecisions: 0
          },
          'MAC-DEV': {
            id: 'MAC-DEV',
            name: 'Mac Dev',
            lastSync: '2025-10-08T08:00:00Z',
            status: 'online',
            diffsCount: 2,
            pendingDecisions: 1
          },
          'LAPTOP-WORK': {
            id: 'LAPTOP-WORK',
            name: 'Laptop Work',
            lastSync: '2025-10-07T18:00:00Z',
            status: 'offline',
            diffsCount: 5,
            pendingDecisions: 3
          }
        }
      })
    }))
  };
  
  // Mock de la fonction getRooSyncService
  const getRooSyncService = vi.fn(() => service.getInstance());
  
  return {
    mockRooSyncService: service,
    mockRooSyncServiceError: errorClass,
    mockGetRooSyncService: getRooSyncService
  };
});

vi.mock('../../../../src/services/RooSyncService.js', () => ({
  RooSyncService: mockRooSyncService,
  RooSyncServiceError: mockRooSyncServiceError,
  getRooSyncService: mockGetRooSyncService
}));

import { RooSyncService } from '../../../../src/services/RooSyncService.js';
import { roosyncGetStatus, type GetStatusArgs } from '../../../../src/tools/roosync/get-status.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('roosync_get_status', () => {
  const testDir = join(__dirname, '../../../fixtures/roosync-get-status-test');
  
  beforeEach(() => {
    // Créer répertoire de test
    try {
      mkdirSync(testDir, { recursive: true });
    } catch (error) {
      // Déjà existant
    }
    
    // Forcer la suppression du fichier baseline forcé utilisé par le système
    try {
      rmSync('g:\\Mon Drive\\Synchronisation\\RooSync\\.shared-state\\sync-config.ref.json', { force: true });
    } catch (error) {
      // Ignorer si le fichier n'existe pas
    }
    
    // Créer dashboard de test
    const dashboard = {
      version: '2.0.0',
      lastUpdate: '2025-10-08T10:00:00Z',
      overallStatus: 'synced',
      machines: {
        'PC-PRINCIPAL': {
          lastSync: '2025-10-08T09:00:00Z',
          status: 'online',
          diffsCount: 0,
          pendingDecisions: 0
        },
        'MAC-DEV': {
          lastSync: '2025-10-08T08:00:00Z',
          status: 'online',
          diffsCount: 2,
          pendingDecisions: 1
        },
        'LAPTOP-WORK': {
          lastSync: '2025-10-07T18:00:00Z',
          status: 'offline',
          diffsCount: 5,
          pendingDecisions: 3
        }
      }
    };
    
    writeFileSync(
      join(testDir, 'sync-dashboard.json'),
      JSON.stringify(dashboard, null, 2),
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
          id: "MAC-DEV",
          modes: ['code', 'architect'],
          mcpServers: ['quickfiles', 'git'],
          hardware: {
            cpu: "Apple M2 Pro",
            ram: "16GB",
            os: "macOS Sonoma",
            architecture: "arm64"
          },
          software: {
            powershell: "7.3.0",
            node: "20.0.0",
            python: "3.11.0"
          }
        },
        {
          id: "LAPTOP-WORK",
          modes: ['code', 'debug'],
          mcpServers: ['quickfiles'],
          hardware: {
            cpu: "Intel i5-1135G7",
            ram: "16GB",
            os: "Windows 10",
            architecture: "x64"
          },
          software: {
            powershell: "5.1.0",
            node: "16.14.0",
            python: "3.9.0"
          }
        }
      ]
    };
    
    writeFileSync(join(testDir, 'sync-config.ref.json'), JSON.stringify(baseline, null, 2), 'utf-8');
    
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

  it('devrait retourner le statut complet sans filtre', async () => {
    // Arrange
    const args: GetStatusArgs = {};
    
    // Act
    const result = await roosyncGetStatus(args);
    
    // Assert
    expect(result.status).toBe('synced');
    expect(result.lastSync).toBe('2025-10-08T10:00:00Z');
    expect(result.machines).toHaveLength(3);
    expect(result.summary).toBeDefined();
    expect(result.summary?.totalMachines).toBe(3);
    expect(result.summary?.onlineMachines).toBe(2);
    expect(result.summary?.totalDiffs).toBe(7); // 0 + 2 + 5
    expect(result.summary?.totalPendingDecisions).toBe(4); // 0 + 1 + 3
  });
  
  it('devrait filtrer par machine spécifique', async () => {
    // Arrange
    const args: GetStatusArgs = { machineFilter: 'MAC-DEV' };
    
    // Act
    const result = await roosyncGetStatus(args);
    
    // Assert
    expect(result.machines).toHaveLength(1);
    expect(result.machines[0].id).toBe('MAC-DEV');
    expect(result.machines[0].diffsCount).toBe(2);
    expect(result.machines[0].pendingDecisions).toBe(1);
    expect(result.summary?.totalMachines).toBe(1);
    expect(result.summary?.totalDiffs).toBe(2);
  });
  
  it('devrait lever une erreur si la machine filtrée n\'existe pas', async () => {
    // Arrange
    const args: GetStatusArgs = { machineFilter: 'NONEXISTENT' };
    
    // Act & Assert
    await expect(roosyncGetStatus(args)).rejects.toThrow('Machine \'NONEXISTENT\' non trouvée');
  });
  
  it('devrait inclure toutes les machines dans le résultat', async () => {
    // Arrange
    const args: GetStatusArgs = {};
    
    // Act
    const result = await roosyncGetStatus(args);
    
    // Assert
    const machineIds = result.machines.map(m => m.id).sort();
    expect(machineIds).toEqual(['LAPTOP-WORK', 'MAC-DEV', 'PC-PRINCIPAL']);
  });
  
  it('devrait calculer correctement les statistiques', async () => {
    // Arrange
    const args: GetStatusArgs = {};
    
    // Act
    const result = await roosyncGetStatus(args);
    
    // Assert
    expect(result.summary).toMatchObject({
      totalMachines: 3, // 3 machines : PC-PRINCIPAL, MAC-DEV, LAPTOP-WORK
      onlineMachines: 2, // PC-PRINCIPAL et MAC-DEV sont online
      totalDiffs: 7, // 0 + 2 + 5 = 7 diffs au total
      totalPendingDecisions: 4 // 0 + 1 + 3 = 4 décisions en attente
    });
  });
});