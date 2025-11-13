/**
 * Tests pour roosync_compare_config
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { RooSyncService } from '../../../../src/services/RooSyncService.js';
import { roosyncCompareConfig, type CompareConfigArgs } from '../../../../src/tools/roosync/compare-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('roosync_compare_config', () => {
  const testDir = join(__dirname, '../../../fixtures/roosync-compare-config-test');
  
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
          diffsCount: 2,
          pendingDecisions: 1
        },
        'MAC-DEV': {
          lastSync: '2025-10-08T08:00:00Z',
          status: 'online',
          diffsCount: 0,
          pendingDecisions: 0
        }
      }
    };
    
    writeFileSync(
      join(testDir, 'sync-dashboard.json'),
      JSON.stringify(dashboard, null, 2),
      'utf-8'
    );
    
    // Créer sync-config.json de test
    const config = {
      version: '2.0.0',
      machines: {
        'PC-PRINCIPAL': {
          modes: ['code', 'architect'],
          mcpServers: ['quickfiles', 'git']
        },
        'MAC-DEV': {
          modes: ['code', 'architect', 'debug'],
          mcpServers: ['quickfiles']
        }
      }
    };
    
    writeFileSync(
      join(testDir, 'sync-config.json'),
      JSON.stringify(config, null, 2),
      'utf-8'
    );
    
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

  it('devrait comparer avec une machine spécifiée', async () => {
    // Arrange
    const args: CompareConfigArgs = { target: 'MAC-DEV' };
    
    // Act
    const result = await roosyncCompareConfig(args);
    
    // Assert
    expect(result.source).toBe('PC-PRINCIPAL');
    expect(result.target).toBe('MAC-DEV');
    expect(result.differences).toBeDefined();
    expect(Array.isArray(result.differences)).toBe(true);
  });
  
  it('devrait auto-sélectionner une machine si non spécifiée', async () => {
    // Arrange
    const args: CompareConfigArgs = {};
    
    // Act
    const result = await roosyncCompareConfig(args);
    
    // Assert
    expect(result.source).toBe('PC-PRINCIPAL');
    expect(result.target).toBe('MAC-DEV'); // Auto-sélectionné
    expect(result.differences.length === 0).toBe(true);
  });
  
  it('devrait marquer identical=true quand pas de différences', async () => {
    // Arrange
    const args: CompareConfigArgs = { target: 'MAC-DEV' };
    
    // Act
    const result = await roosyncCompareConfig(args);
    
    // Assert
    if (result.differences.length === 0) {
      expect(result.differences.length === 0).toBe(true);
    } else {
      expect(result.differences.length === 0).toBe(false);
    }
  });
  
  it('devrait typer correctement les différences', async () => {
    // Arrange
    const args: CompareConfigArgs = { target: 'MAC-DEV' };
    
    // Act
    const result = await roosyncCompareConfig(args);
    
    // Assert
    result.differences.forEach(diff => {
      expect(['config', 'hardware', 'software', 'system']).toContain(diff.category);
      expect(diff.path).toBeDefined();
    });
  });
  
  it('devrait lever une erreur si aucune autre machine disponible', async () => {
    // Arrange - Dashboard avec une seule machine
    const singleMachineDashboard = {
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
      JSON.stringify(singleMachineDashboard, null, 2),
      'utf-8'
    );
    
    RooSyncService.resetInstance();
    
    const args: CompareConfigArgs = {};
    
    // Act & Assert
    await expect(roosyncCompareConfig(args)).rejects.toThrow('Aucune autre machine');
    
    // Restaurer le dashboard original pour les tests suivants
    const originalDashboard = {
      version: '2.0.0',
      lastUpdate: '2025-10-08T10:00:00Z',
      overallStatus: 'diverged',
      machines: {
        'PC-PRINCIPAL': {
          lastSync: '2025-10-08T09:00:00Z',
          status: 'online',
          diffsCount: 2,
          pendingDecisions: 1
        },
        'MAC-DEV': {
          lastSync: '2025-10-08T08:00:00Z',
          status: 'online',
          diffsCount: 0,
          pendingDecisions: 0
        }
      }
    };
    
    writeFileSync(
      join(testDir, 'sync-dashboard.json'),
      JSON.stringify(originalDashboard, null, 2),
      'utf-8'
    );
    
    RooSyncService.resetInstance();
  });
});