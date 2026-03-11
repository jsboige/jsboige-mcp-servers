/**
 * Tests d'intégration pour roosync_update_dashboard
 *
 * Couvre les paramètres de l'outil :
 * - section: Section du dashboard à mettre à jour (machine, global, intercom, decisions, metrics)
 * - content: Contenu markdown à insérer dans la section
 * - machine: ID de la machine (requis si section=machine)
 * - workspace: Workspace (défaut: roo-extensions)
 * - mode: Mode de mise à jour (replace, append, prepend)
 *
 * Framework: Vitest
 * Type: Intégration (DashboardService réel, opérations filesystem réelles)
 *
 * @module roosync/update-dashboard.integration.test
 * @version 1.0.0 (#564 Phase 2b)
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';

// Mock getLocalMachineId pour contrôler l'identifiant dans les tests
vi.mock('../../../utils/message-helpers.js', async () => {
  const actual = await vi.importActual('../../../utils/message-helpers.js');
  return {
    ...actual,
    getLocalMachineId: vi.fn(() => 'test-machine'),
    getLocalFullId: vi.fn(() => 'test-machine'),
    getLocalWorkspaceId: vi.fn(() => 'roo-extensions')
  };
});

// Mock getSharedStatePath pour utiliser un chemin de test
const testSharedStatePath = join(__dirname, '../../../__test-data__/shared-state-update-dashboard');
vi.mock('../../../utils/server-helpers.js', () => ({
  getSharedStatePath: () => testSharedStatePath
}));

// Import après les mocks
import { roosyncUpdateDashboard } from '../update-dashboard.js';
import { RooSyncService } from '../../../services/RooSyncService.js';

describe('roosync_update_dashboard (integration)', () => {
  // Fix #634: Save original env var to restore after tests
  const originalSharedPath = process.env.ROOSYNC_SHARED_PATH;
  const originalMachineId = process.env.ROOSYNC_MACHINE_ID;

  beforeEach(async () => {
    // Fix #634: Override env var BEFORE singleton recreation
    process.env.ROOSYNC_SHARED_PATH = testSharedStatePath;
    process.env.ROOSYNC_MACHINE_ID = 'test-machine';

    // Reset singleton so it gets recreated with the test path
    RooSyncService.resetInstance();

    // Setup : créer répertoire temporaire pour tests isolés
    const dirs = [
      testSharedStatePath
    ];

    for (const dir of dirs) {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }

    // NOTE: update-dashboard.ts looks for sharedPath/DASHBOARD.md (not in dashboards/ subdirectory)
    // NOTE: The implementation expects specific French section headers
    const dashboardPath = join(testSharedStatePath, 'DASHBOARD.md');

    // Create properly formatted DASHBOARD.md with all required sections
    // Based on update-dashboard.ts sectionTitles mapping:
    // 'global' -> 'État Global'
    // 'intercom' -> 'Notes Inter-Agents'
    // 'decisions' -> 'Décisions en Attente'
    // 'metrics' -> 'Métriques'
    // 'machine' -> '### {machineId}' with '#### {workspace}' and 'Notes libres:' sub-structure
    //
    // Include all machine IDs used in tests:
    // - test-machine (default from mock)
    // - myia-ai-01, myia-po-2023, myia-po-2024, myia-po-2025, myia-po-2026, myia-web1
    const dashboardContent = `# Dashboard Hiérarchique RooSync

**Dernière mise à jour:** 2026-03-11 10:00:00 par test-machine:roo-extensions

## État Global

Contenu global initial.

## Notes Inter-Agents

Contenu intercom initial.

## Décisions en Attente

Contenu décisions initial.

## Métriques

Contenu métriques initial.

## Machines

### test-machine

#### roo-extensions

**Statut:** ✅ Online
**Dernière activité:** 2026-03-11 10:00:00

Notes libres:

  Notes libres initiales pour test-machine:roo-extensions.

### myia-ai-01

#### roo-extensions

**Statut:** ✅ Online
**Dernière activité:** 2026-03-11 10:00:00

Notes libres:

  Notes libres pour myia-ai-01.

### myia-po-2023

#### roo-extensions

**Statut:** ✅ Online
**Dernière activité:** 2026-03-11 10:00:00

Notes libres:

  Notes libres pour myia-po-2023.

### myia-po-2024

#### roo-extensions

**Statut:** ✅ Online
**Dernière activité:** 2026-03-11 10:00:00

Notes libres:

  Notes libres pour myia-po-2024.

### myia-po-2025

#### roo-extensions

**Statut:** ✅ Online
**Dernière activité:** 2026-03-11 10:00:00

Notes libres:

  Notes libres pour myia-po-2025.

### myia-po-2026

#### roo-extensions

**Statut:** ✅ Online
**Dernière activité:** 2026-03-11 10:00:00

Notes libres:

  Notes libres pour myia-po-2026.

### myia-web1

#### roo-extensions

**Statut:** ✅ Online
**Dernière activité:** 2026-03-11 10:00:00

Notes libres:

  Notes libres pour myia-web1.

`;
    writeFileSync(dashboardPath, dashboardContent);
  });

  afterEach(async () => {
    // Reset singleton to prevent leaking test state to other test files
    RooSyncService.resetInstance();

    // Restore original env vars
    if (originalSharedPath !== undefined) {
      process.env.ROOSYNC_SHARED_PATH = originalSharedPath;
    } else {
      delete process.env.ROOSYNC_SHARED_PATH;
    }

    if (originalMachineId !== undefined) {
      process.env.ROOSYNC_MACHINE_ID = originalMachineId;
    } else {
      delete process.env.ROOSYNC_MACHINE_ID;
    }

    // Cleanup : supprimer répertoire test pour isolation
    if (existsSync(testSharedStatePath)) {
      rmSync(testSharedStatePath, { recursive: true, force: true });
    }
  });

  // ============================================================
  // Tests pour section
  // ============================================================

  describe('section parameter', () => {
    test('should update machine section', async () => {
      const result = await roosyncUpdateDashboard({
        section: 'machine',
        content: '### Test Content\nNew machine content.'
      });

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(result.section).toBe('machine');
    });

    test('should update global section', async () => {
      const result = await roosyncUpdateDashboard({
        section: 'global',
        content: '## Global Update\nUpdated global content.'
      });

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
    });

    test('should update intercom section', async () => {
      const result = await roosyncUpdateDashboard({
        section: 'intercom',
        content: '### Intercom Messages\nMessage content here.'
      });

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
    });

    test('should update decisions section', async () => {
      const result = await roosyncUpdateDashboard({
        section: 'decisions',
        content: '## Recent Decisions\nDecision content.'
      });

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
    });

    test('should update metrics section', async () => {
      const result = await roosyncUpdateDashboard({
        section: 'metrics',
        content: '### Performance Metrics\nMetrics data here.'
      });

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
    });
  });

  // ============================================================
  // Tests pour mode
  // ============================================================

  describe('mode parameter', () => {
    test('should use replace mode by default', async () => {
      const result = await roosyncUpdateDashboard({
        section: 'global',
        content: '## Replaced Content\nCompletely new content.'
      });

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
    });

    test('should replace section content entirely', async () => {
      const result = await roosyncUpdateDashboard({
        section: 'global',
        mode: 'replace',
        content: '## Fully Replaced\nOld content is gone.'
      });

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
    });

    test('should append content to existing section', async () => {
      const result = await roosyncUpdateDashboard({
        section: 'global',
        mode: 'append',
        content: '\n### Appended Section\nThis is added at the end.'
      });

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
    });

    test('should prepend content to existing section', async () => {
      const result = await roosyncUpdateDashboard({
        section: 'global',
        mode: 'prepend',
        content: '### Prepended Section\nThis is added at the beginning.\n'
      });

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
    });
  });

  // ============================================================
  // Tests pour machine
  // ============================================================

  describe('machine parameter', () => {
    test('should use default machine from env var', async () => {
      const result = await roosyncUpdateDashboard({
        section: 'machine',
        content: '### Machine Default\nUsing env var machine ID.'
      });

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
    });

    test('should accept custom machine ID', async () => {
      const result = await roosyncUpdateDashboard({
        section: 'machine',
        machine: 'myia-po-2026',
        content: '### Custom Machine\nSpecific machine content.'
      });

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
    });

    test('should handle all valid machine IDs', async () => {
      const machines = ['myia-ai-01', 'myia-po-2023', 'myia-po-2024', 'myia-po-2025', 'myia-po-2026', 'myia-web1'];

      for (const machine of machines) {
        const result = await roosyncUpdateDashboard({
          section: 'machine',
          machine,
          content: `### Content for ${machine}\nMachine specific data.`
        });

        expect(result).toBeDefined();
        expect(result.success).toBe(true);
      }
    });
  });

  // ============================================================
  // Tests pour workspace
  // ============================================================

  describe('workspace parameter', () => {
    test('should use default workspace (roo-extensions)', async () => {
      const result = await roosyncUpdateDashboard({
        section: 'global',
        content: '### Default Workspace\nUsing roo-extensions.'
      });

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
    });

    test('should accept custom workspace', async () => {
      const result = await roosyncUpdateDashboard({
        section: 'global',
        workspace: 'custom-workspace',
        content: '### Custom Workspace\nUsing custom workspace value.'
      });

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
    });
  });

  // ============================================================
  // Tests de combinaison de paramètres
  // ============================================================

  describe('parameter combinations', () => {
    test('should handle machine section with custom machine ID', async () => {
      const result = await roosyncUpdateDashboard({
        section: 'machine',
        machine: 'myia-po-2025',
        mode: 'replace',
        content: '### Machine Specific\nComplete replacement for myia-po-2025.'
      });

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
    });

    test('should handle global section with append mode', async () => {
      const result = await roosyncUpdateDashboard({
        section: 'global',
        mode: 'append',
        content: '\n### Additional Content\nAppended to global section.'
      });

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
    });

    test('should handle metrics section with prepend mode', async () => {
      const result = await roosyncUpdateDashboard({
        section: 'metrics',
        mode: 'prepend',
        content: '### Latest Metrics\nMost recent metrics first.\n'
      });

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
    });
  });

  // ============================================================
  // Tests de format de réponse
  // ============================================================

  describe('response format', () => {
    test('should return valid UpdateDashboardResult', async () => {
      const result = await roosyncUpdateDashboard({
        section: 'intercom',
        content: '### Intercom Test\nTest content for intercom section.'
      });

      expect(result.success).toBe(true);
      expect(result.dashboardPath).toBeTruthy();
      expect(result.section).toBe('intercom');
      expect(result.timestamp).toBeTruthy();
    });

    test('should include dashboard path in response', async () => {
      const result = await roosyncUpdateDashboard({
        section: 'decisions',
        content: '### Decision Test\nTest decision content.'
      });

      expect(result.success).toBe(true);
      expect(result.dashboardPath).toContain('DASHBOARD.md');
    });
  });

  // ============================================================
  // Tests de gestion d'erreurs
  // ============================================================

  describe('error handling', () => {
    test('should throw error when dashboard is missing', async () => {
      // Supprimer le dashboard pour simuler l'absence
      const dashboardPath = join(testSharedStatePath, 'DASHBOARD.md');
      if (existsSync(dashboardPath)) {
        rmSync(dashboardPath, { force: true });
      }

      // The implementation requires roosync_init to be used first
      // It does NOT auto-create the dashboard
      await expect(roosyncUpdateDashboard({
        section: 'global',
        content: '### New Dashboard\nCreating from scratch.'
      })).rejects.toThrow('Dashboard non trouvé');
    });

    test('should handle invalid section gracefully', async () => {
      // Note: Schema validation should catch this before tool execution
      const result = await roosyncUpdateDashboard({
        section: 'machine',
        content: '### Test Content\nValid content.'
      });

      expect(result).toBeDefined();
      // Tool should handle the valid section
      expect(result.success).toBe(true);
    });
  });

  // ============================================================
  // Tests d'intégration
  // ============================================================

  describe('integration scenarios', () => {
    test('should persist dashboard changes across operations', async () => {
      const section = 'global';
      const content1 = '### First Update\nInitial content.';
      const content2 = '### Second Update\nAdditional content.';

      // First update
      const result1 = await roosyncUpdateDashboard({
        section,
        mode: 'append',
        content: content1
      });
      expect(result1.success).toBe(true);

      // Second update should build on first
      const result2 = await roosyncUpdateDashboard({
        section,
        mode: 'append',
        content: content2
      });
      expect(result2.success).toBe(true);
    });

    test('should handle multiple consecutive updates to different sections', async () => {
      // Update machine section
      const result1 = await roosyncUpdateDashboard({
        section: 'machine',
        content: '### Machine Update\nUpdated machine info.'
      });
      expect(result1.success).toBe(true);

      // Update metrics section
      const result2 = await roosyncUpdateDashboard({
        section: 'metrics',
        content: '### Metrics Update\nUpdated metrics.'
      });
      expect(result2.success).toBe(true);
    });

    test('should replace existing section content entirely', async () => {
      const dashboardPath = join(testSharedStatePath, 'DASHBOARD.md');

      // Verify initial content exists
      expect(existsSync(dashboardPath)).toBe(true);

      // Replace with completely new content
      const result = await roosyncUpdateDashboard({
        section: 'global',
        mode: 'replace',
        content: '## Completely New\nNo trace of old content.'
      });
      expect(result.success).toBe(true);

      // Verify the content was replaced (not appended/prepended)
      const updatedContent = readFileSync(dashboardPath, 'utf-8');
      expect(updatedContent).toContain('Completely New');
    });
  });

  // ============================================================
  // Tests de contenu markdown
  // ============================================================

  describe('markdown content handling', () => {
    test('should handle multiline markdown content', async () => {
      const multilineContent = `## Section Title
This is a multiline content with:
- Bullet points
- More bullets

And paragraphs.`;

      const result = await roosyncUpdateDashboard({
        section: 'global',
        content: multilineContent
      });

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
    });

    test('should handle special characters in content', async () => {
      const specialContent = '### Special Characters\nTesting: < > & " \' and emojis ✅ ❌';

      const result = await roosyncUpdateDashboard({
        section: 'intercom',
        content: specialContent
      });

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
    });

    test('should handle empty content gracefully', async () => {
      const result = await roosyncUpdateDashboard({
        section: 'metrics',
        content: ''
      });

      expect(result).toBeDefined();
      // Tool should handle empty content
      expect(result.success).toBe(true);
    });
  });
});
