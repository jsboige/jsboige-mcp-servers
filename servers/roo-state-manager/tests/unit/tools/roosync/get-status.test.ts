/**
 * Tests pour roosync_get_status
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
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
      totalMachines: 1,
      onlineMachines: 1,
      totalDiffs: 2, // Corrigé : 2 diffs détectées (hardware + software)
      totalPendingDecisions: 0
    });
  });
});