/**
 * Tests pour roosync_apply_decision
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fileURLToPath } from 'url';

// Mock du module fs
const { writeFileSync, mkdirSync, rmSync, readFileSync } = vi.hoisted(() => ({
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
  readFileSync: vi.fn()
}));

vi.mock('fs', () => ({
  writeFileSync,
  mkdirSync,
  rmSync,
  readFileSync
}));

// Mock du module path
const { join, dirname } = vi.hoisted(() => ({
  join: vi.fn((...paths) => paths.join('/')),
  dirname: vi.fn((path) => path.split('/').slice(0, -1).join('/'))
}));

vi.mock('path', () => ({
  join,
  dirname,
  normalize: vi.fn((path) => path),
  resolve: vi.fn((...paths) => paths.join('/')),
  basename: vi.fn((path) => path.split('/').pop()),
  extname: vi.fn((path) => path.includes('.') ? '.' + path.split('.').pop() : ''),
  relative: vi.fn((from, to) => to),
  sep: '/',
  delimiter: ';'
}));

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
      executeDecision: vi.fn().mockResolvedValue({
        success: true,
        logs: ['[MOCK] Exécution simulée réussie'],
        changes: {
          filesModified: ['.config/test.json'],
          filesCreated: [],
          filesDeleted: []
        },
        executionTime: 100
      }),
      createRollbackPoint: vi.fn().mockResolvedValue(undefined),
      getDecision: vi.fn().mockImplementation((decisionId: string) => {
        if (decisionId === 'test-decision-approved') {
          return {
            id: 'test-decision-approved',
            title: 'Décision approuvée prête',
            status: 'approved',
            type: 'config',
            path: '.config/test.json',
            sourceMachine: 'PC-PRINCIPAL',
            targetMachines: ['MAC-DEV'],
            createdAt: '2025-10-08T09:00:00Z',
            approvedAt: '2025-10-08T09:30:00Z',
            approvedBy: 'PC-PRINCIPAL'
          };
        } else if (decisionId === 'test-decision-pending') {
          return {
            id: 'test-decision-pending',
            title: 'Décision pas encore approuvée',
            status: 'pending',
            type: 'file',
            path: 'test.txt',
            sourceMachine: 'PC-PRINCIPAL',
            targetMachines: ['all'],
            createdAt: '2025-10-08T09:00:00Z'
          };
        }
        return null;
      }),
      getConfig: vi.fn().mockReturnValue({
        version: '2.0.0',
        sharedStatePath: '/mock/shared',
        machines: {
          'PC-PRINCIPAL': {
            id: 'PC-PRINCIPAL',
            name: 'PC Principal',
            basePath: '/mock/pc-principal',
            lastSync: '2025-10-08T09:00:00Z',
            status: 'online'
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
import { roosyncApplyDecision } from '../../../../src/tools/roosync/apply-decision.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('roosync_apply_decision', () => {
  const testDir = join(__dirname, '../../../fixtures/roosync-apply-test');
  const mockFiles = new Map();
  
  beforeEach(() => {
    // Réinitialiser les mocks
    mockFiles.clear();
    
    // Configurer les mocks
    mkdirSync.mockImplementation((dir, options) => {
      // Simuler la création de répertoire
      return undefined;
    });
    rmSync.mockImplementation((dir, options) => {
      // Simuler la suppression de répertoire
      return undefined;
    });
    writeFileSync.mockImplementation((filePath, content, encoding) => {
      mockFiles.set(filePath, content);
      return undefined;
    });
    readFileSync.mockImplementation((filePath, encoding) => {
      const content = mockFiles.get(filePath);
      if (content) {
        return content;
      }
      throw new Error(`File not found: ${filePath}`);
    });
    join.mockImplementation((...paths) => paths.join('/'));
    
    // Setup test environment
    mkdirSync(testDir, { recursive: true });
    
    // Create test dashboard and roadmap
    const dashboard = {
      version: '2.0.0',
      lastUpdate: '2025-10-08T10:00:00Z',
      overallStatus: 'diverged',
      machines: {
        'PC-PRINCIPAL': {
          lastSync: '2025-10-08T09:00:00Z',
          status: 'online',
          diffsCount: 1,
          pendingDecisions: 1
        }
      }
    };
    
    const roadmap = `# Roadmap RooSync

## Décisions de Synchronisation

<!-- DECISION_BLOCK_START -->
**ID:** \`test-decision-approved\`
**Titre:** Décision approuvée prête
**Statut:** approved
**Type:** config
**Chemin:** \`.config/test.json\`
**Machine Source:** PC-PRINCIPAL
**Machines Cibles:** MAC-DEV
**Créé:** 2025-10-08T09:00:00Z
**Approuvé le:** 2025-10-08T09:30:00Z
**Approuvé par:** PC-PRINCIPAL
<!-- DECISION_BLOCK_END -->

<!-- DECISION_BLOCK_START -->
**ID:** \`test-decision-pending\`
**Titre:** Décision pas encore approuvée
**Statut:** pending
**Type:** file
**Chemin:** \`test.txt\`
**Machine Source:** PC-PRINCIPAL
**Machines Cibles:** all
**Créé:** 2025-10-08T09:00:00Z
<!-- DECISION_BLOCK_END -->
`;
    
    writeFileSync(join(testDir, 'sync-dashboard.json'), JSON.stringify(dashboard), 'utf-8');
    writeFileSync(join(testDir, 'sync-roadmap.md'), roadmap, 'utf-8');
    
    // Mock environment
    process.env.ROOSYNC_SHARED_PATH = testDir;
    process.env.ROOSYNC_MACHINE_ID = 'PC-PRINCIPAL';
    process.env.ROOSYNC_AUTO_SYNC = 'false';
    process.env.ROOSYNC_CONFLICT_STRATEGY = 'manual';
    process.env.ROOSYNC_LOG_LEVEL = 'info';
    
    RooSyncService.resetInstance();
    
    // Mock executeDecision pour éviter les appels PowerShell réels
    const service = RooSyncService.getInstance();
    vi.spyOn(service, 'executeDecision').mockResolvedValue({
      success: true,
      logs: ['[MOCK] Exécution simulée réussie'],
      changes: {
        filesModified: ['.config/test.json'],
        filesCreated: [],
        filesDeleted: []
      },
      executionTime: 100
    });
    
    // Mock createRollbackPoint pour éviter les appels PowerShell réels
    vi.spyOn(service, 'createRollbackPoint').mockResolvedValue(undefined);
  });
  
  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore
    }
    RooSyncService.resetInstance();
  });

  it('devrait exécuter en mode dry run', async () => {
    const result = await roosyncApplyDecision({
      decisionId: 'test-decision-approved',
      dryRun: true
    });
    
    expect(result.newStatus).toBe('applied');
    expect(result.executionLog.some(log => log.includes('DRY RUN'))).toBe(true);
    expect(result.rollbackAvailable).toBe(false);
  });
  
  it('devrait lever une erreur si décision pas approuvée', async () => {
    await expect(roosyncApplyDecision({
      decisionId: 'test-decision-pending'
    })).rejects.toThrow('pas encore approuvée');
  });
  
  it('devrait inclure les logs d\'exécution', async () => {
    const result = await roosyncApplyDecision({
      decisionId: 'test-decision-approved',
      dryRun: true
    });
    
    expect(result.executionLog.length).toBeGreaterThan(0);
    expect(Array.isArray(result.executionLog)).toBe(true);
  });
  
  it('devrait retourner la structure de changements', async () => {
    const result = await roosyncApplyDecision({
      decisionId: 'test-decision-approved',
      dryRun: true
    });
    
    expect(result.changes).toHaveProperty('filesModified');
    expect(result.changes).toHaveProperty('filesCreated');
    expect(result.changes).toHaveProperty('filesDeleted');
  });
  
  it('devrait lever une erreur si décision introuvable', async () => {
    await expect(roosyncApplyDecision({
      decisionId: 'nonexistent'
    })).rejects.toThrow('introuvable');
  });
  
  it('devrait créer un point de rollback en mode normal', async () => {
    const result = await roosyncApplyDecision({
      decisionId: 'test-decision-approved',
      dryRun: false
    });
    
    expect(result.rollbackAvailable).toBe(true);
    expect(result.executionLog.some(log => log.includes('ROLLBACK'))).toBe(true);
  });
  
  it('devrait mettre à jour sync-roadmap.md en mode normal', async () => {
    const result = await roosyncApplyDecision({
      decisionId: 'test-decision-approved',
      dryRun: false
    });
    
    expect(result.newStatus).toBe('applied');
    expect(result.appliedBy).toBe('PC-PRINCIPAL');
    
    // Vérifier que le fichier a été mis à jour
    const { readFileSync } = await import('fs');
    const roadmapContent = readFileSync(join(testDir, 'sync-roadmap.md'), 'utf-8');
    expect(roadmapContent).toContain('**Statut:** applied');
    expect(roadmapContent).toContain('**Appliqué le:**');
  });
});