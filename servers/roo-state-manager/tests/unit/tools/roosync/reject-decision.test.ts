/**
 * Tests pour roosync_reject_decision
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';

// Désactiver le mock global de fs pour ce test qui utilise le système de fichiers réel
vi.unmock('fs');
// Désactiver le mock global de RooSyncService et ConfigService pour utiliser l'implémentation réelle
vi.unmock('../../../../src/services/RooSyncService.js');
vi.unmock('../../../../src/services/ConfigService.js');

import { tmpdir } from 'os';

// Set environment variables BEFORE the mock
process.env.ROOSYNC_MACHINE_ID = 'PC-PRINCIPAL';
process.env.ROOSYNC_SHARED_PATH = join(tmpdir(), `roosync-reject-test-${Date.now()}`);

// Mock the @/services/RooSyncService.js to ensure the source file's import works correctly
vi.mock('@/services/RooSyncService.js', () => {
  const sharedMockInstance = {
    getConfig: vi.fn(() => ({
      sharedPath: process.env.ROOSYNC_SHARED_PATH || '/mock/roosync/shared-path',
      machineId: process.env.ROOSYNC_MACHINE_ID || 'ci-test-machine',
      autoSync: false,
      conflictStrategy: 'manual',
      logLevel: 'info'
    })),
    loadDashboard: vi.fn(async () => ({ version: '2.1.0', machines: [] })),
    resetInstance: vi.fn(() => undefined),
    getDecision: vi.fn(),
    clearCache: vi.fn(() => undefined)
  };

  return {
    RooSyncService: {
      getInstance: vi.fn(() => sharedMockInstance),
      resetInstance: vi.fn(() => undefined)
    },
    getRooSyncService: vi.fn(() => sharedMockInstance),
    RooSyncServiceError: class extends Error {
      constructor(message: string, code?: string) {
        super(message);
        this.name = 'RooSyncServiceError';
        this.code = code;
      }
    }
  };
});

import { RooSyncService } from '@/services/RooSyncService.js';
import { roosyncRejectDecision, RejectDecisionArgs } from '../../../../src/tools/roosync/reject-decision.js';

// Mock fs module pour contourner le bug Vitest
// Inclure promises avec mockResolvedValue pour le CommitLogService
vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
  existsSync: vi.fn(() => true),
  promises: {
    readFile: vi.fn().mockResolvedValue('{}'),
    writeFile: vi.fn().mockResolvedValue(undefined),
    access: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    readdir: vi.fn().mockResolvedValue([]),
    stat: vi.fn().mockResolvedValue({ isDirectory: () => true, size: 100, mtime: new Date() }),
    rm: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined)
  }
}));

describe('roosync_reject_decision', () => {
  const testDir = join(tmpdir(), `roosync-reject-test-${Date.now()}`);

  beforeEach(async () => {
    // Configurer les mocks fs avant toute utilisation
    const fs = await import('fs');
    const path = await import('path');
    
    // Mock readFileSync pour retourner le contenu du roadmap
    const readFileMock = vi.fn().mockImplementation((filePath: string) => {
      if (filePath.includes('sync-roadmap.md')) {
        return roadmap;
      }
      return '';
    });
    (fs.readFileSync as any) = readFileMock;
    (fs.promises.readFile as any) = readFileMock; // Pour SyncDecisionManager
    
    // Mock writeFileSync pour capturer les écritures
    const writeFileMock = vi.fn().mockImplementation(() => {});
    (fs.writeFileSync as any) = writeFileMock;
    (fs.promises.writeFile as any) = writeFileMock; // Pour SyncDecisionManager
    
    // Mock access pour SyncDecisionManager
    (fs.promises.access as any) = vi.fn().mockResolvedValue(undefined);

    // Mock mkdirSync et rmSync pour éviter les erreurs
    (fs.mkdirSync as any) = vi.fn().mockImplementation(() => {});
    (fs.rmSync as any) = vi.fn().mockImplementation(() => {});
    (path.join as any) = vi.fn().mockImplementation((...args: string[]) => args.join('/'));

    // Créer répertoire de test
    try {
      fs.mkdirSync(testDir, { recursive: true });
    } catch (error) {
      // Déjà existant
    }

    // Mock environnement
    process.env.ROOSYNC_SHARED_PATH = testDir;
    process.env.ROOSYNC_MACHINE_ID = 'PC-PRINCIPAL';

    // Force reset et injection de config
    RooSyncService.resetInstance();
    RooSyncService.getInstance(undefined, {
      sharedPath: testDir,
      machineId: 'PC-PRINCIPAL',
      autoSync: false,
      conflictStrategy: 'manual',
      logLevel: 'info'
    });

    // Créer les décisions de test
    const testDecisions: any[] = [
      {
        id: 'test-decision-001',
        title: 'Mise à jour configuration test',
        status: 'pending',
        type: 'config',
        path: '.config/test.json',
        sourceMachine: 'PC-PRINCIPAL',
        targetMachines: ['MAC-DEV'],
        createdAt: '2025-10-08T09:00:00Z',
        details: 'Synchroniser paramètres de test'
      },
      {
        id: 'test-decision-002',
        title: 'Décision déjà approuvée',
        status: 'approved',
        type: 'file',
        sourceMachine: 'PC-PRINCIPAL',
        targetMachines: ['all'],
        createdAt: '2025-10-08T08:00:00Z'
      }
    ];

    // Mock getDecision pour retourner les décisions de test
    const service = RooSyncService.getInstance();
    (service as any).getDecision = vi.fn().mockImplementation(async (id: string) => {
      const decision = testDecisions.find(d => d.id === id);
      return Promise.resolve(decision || null);
    });

    // Créer dashboard de test
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

    // Créer roadmap avec décision pending
    const roadmap = `# Roadmap RooSync

## Décisions de Synchronisation

<!-- DECISION_BLOCK_START -->
**ID:** \`test-decision-001\`
**Titre:** Mise à jour configuration test
**Statut:** pending
**Type:** config
**Chemin:** \`.config/test.json\`
**Machine Source:** PC-PRINCIPAL
**Machines Cibles:** MAC-DEV
**Créé:** 2025-10-08T09:00:00Z
**Détails:** Synchroniser paramètres de test
<!-- DECISION_BLOCK_END -->

<!-- DECISION_BLOCK_START -->
**ID:** \`test-decision-002\`
**Titre:** Décision déjà approuvée
**Statut:** approved
**Type:** file
**Machine Source:** PC-PRINCIPAL
**Machines Cibles:** all
**Créé:** 2025-10-08T08:00:00Z
<!-- DECISION_BLOCK_END -->
`;

    writeFileSync(join(testDir, 'sync-dashboard.json'), JSON.stringify(dashboard), 'utf-8');
    writeFileSync(join(testDir, 'sync-roadmap.md'), roadmap, 'utf-8');
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore
    }
    RooSyncService.resetInstance();
  });

  it('devrait rejeter une décision pending avec motif', async () => {
    // Arrange
    const args: RejectDecisionArgs = {
      decisionId: 'test-decision-001',
      reason: 'Configuration incompatible avec environnement de test'
    };

    // Act
    const result = await roosyncRejectDecision(args);

    // Assert
    expect(result.decisionId).toBe('test-decision-001');
    expect(result.previousStatus).toBe('pending');
    expect(result.newStatus).toBe('rejected');
    expect(result.rejectedBy).toBe('PC-PRINCIPAL');
    expect(result.reason).toBe('Configuration incompatible avec environnement de test');
    expect(result.nextSteps).toHaveLength(3);

    // Vérifier que writeFileSync a été appelé avec le bon contenu
    expect(writeFileSync).toHaveBeenCalledWith(
      join(testDir, 'sync-roadmap.md'),
      expect.stringContaining('**Statut:** rejected'),
      'utf-8'
    );
    expect(writeFileSync).toHaveBeenCalledWith(
      join(testDir, 'sync-roadmap.md'),
      expect.stringContaining('**Rejeté par:** PC-PRINCIPAL'),
      'utf-8'
    );
    expect(writeFileSync).toHaveBeenCalledWith(
      join(testDir, 'sync-roadmap.md'),
      expect.stringContaining('**Motif:** Configuration incompatible avec environnement de test'),
      'utf-8'
    );
  });

  it('devrait lever une erreur si la décision n\'existe pas', async () => {
    // Arrange
    const args: RejectDecisionArgs = {
      decisionId: 'nonexistent',
      reason: 'Test'
    };

    // Act & Assert
    await expect(roosyncRejectDecision(args)).rejects.toThrow('Décision \'nonexistent\' introuvable');
  });

  it('devrait lever une erreur si la décision est déjà traitée', async () => {
    // Arrange
    const args: RejectDecisionArgs = {
      decisionId: 'test-decision-002',
      reason: 'Test'
    };

    // Act & Assert
    await expect(roosyncRejectDecision(args)).rejects.toThrow('Décision déjà traitée');
  });

  it('devrait inclure la date de rejet au format ISO', async () => {
    // Arrange
    const args: RejectDecisionArgs = {
      decisionId: 'test-decision-001',
      reason: 'Test de format date'
    };

    // Act
    const result = await roosyncRejectDecision(args);

    // Assert
    expect(result.rejectedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('devrait inclure le motif dans le fichier roadmap', async () => {
    // Arrange
    const args: RejectDecisionArgs = {
      decisionId: 'test-decision-001',
      reason: 'Motif spécifique de rejet'
    };

    // Act
    await roosyncRejectDecision(args);

    // Assert
    // Vérifier que writeFileSync a été appelé avec le motif
    expect(writeFileSync).toHaveBeenCalledWith(
      join(testDir, 'sync-roadmap.md'),
      expect.stringContaining('**Motif:** Motif spécifique de rejet'),
      'utf-8'
    );
  });
});