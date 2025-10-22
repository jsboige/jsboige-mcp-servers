/**
 * Tests pour roosync_list_diffs
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
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
      expect(diff.type).toBe('file');
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
      expect(diff.type).toBe('setting');
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
      } else if (diff.type === 'file') {
        expect(diff.severity).toBe('medium');
      } else {
        expect(diff.severity).toBe('low');
      }
    });
  });
});