/**
 * Tests pour roosync-parsers.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  parseRoadmapMarkdown,
  parseDashboardJson,
  parseConfigJson,
  filterDecisionsByStatus,
  filterDecisionsByMachine,
  findDecisionById,
  RooSyncParseError,
  type RooSyncDecision,
  type RooSyncDashboard
} from '../../../src/utils/roosync-parsers';

describe('RooSync Parsers', () => {
  const testDir = join(__dirname, '../../fixtures/roosync-test');
  
  beforeEach(() => {
    // Créer le répertoire de test
    try {
      mkdirSync(testDir, { recursive: true });
    } catch (error) {
      // Déjà existant
    }
  });
  
  afterEach(() => {
    // Nettoyer le répertoire de test
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore
    }
  });

  describe('parseRoadmapMarkdown', () => {
    it('devrait parser un fichier Markdown avec des décisions valides', () => {
      // Arrange
      const markdown = `# Roadmap RooSync

<!-- DECISION_BLOCK_START -->
**ID:** \`decision-001\`
**Titre:** Mise à jour configuration
**Statut:** pending
**Type:** config
**Chemin:** \`.config/settings.json\`
**Machine Source:** PC-PRINCIPAL
**Machines Cibles:** MAC-DEV, LAPTOP-WORK
**Créé:** 2025-10-07T10:00:00Z
**Créé par:** user@example.com
**Détails:** Synchroniser les paramètres de l'éditeur
<!-- DECISION_BLOCK_END -->

Texte entre les décisions

<!-- DECISION_BLOCK_START -->
**ID:** \`decision-002\`
**Titre:** Ajout d'un fichier
**Statut:** approved
**Type:** file
**Machine Source:** MAC-DEV
**Machines Cibles:** all
**Créé:** 2025-10-07T11:00:00Z
<!-- DECISION_BLOCK_END -->
`;
      
      const filePath = join(testDir, 'test-roadmap.md');
      writeFileSync(filePath, markdown, 'utf-8');
      
      // Act
      const decisions = parseRoadmapMarkdown(filePath);
      
      // Assert
      expect(decisions).toHaveLength(2);
      
      expect(decisions[0].id).toBe('decision-001');
      expect(decisions[0].title).toBe('Mise à jour configuration');
      expect(decisions[0].status).toBe('pending');
      expect(decisions[0].type).toBe('config');
      expect(decisions[0].path).toBe('.config/settings.json');
      expect(decisions[0].sourceMachine).toBe('PC-PRINCIPAL');
      expect(decisions[0].targetMachines).toEqual(['MAC-DEV', 'LAPTOP-WORK']);
      expect(decisions[0].createdBy).toBe('user@example.com');
      
      expect(decisions[1].id).toBe('decision-002');
      expect(decisions[1].status).toBe('approved');
      expect(decisions[1].targetMachines).toEqual(['all']);
    });
    
    it('devrait retourner un tableau vide si aucune décision', () => {
      // Arrange
      const markdown = '# Roadmap vide\n\nPas de décisions ici.';
      const filePath = join(testDir, 'empty-roadmap.md');
      writeFileSync(filePath, markdown, 'utf-8');
      
      // Act
      const decisions = parseRoadmapMarkdown(filePath);
      
      // Assert
      expect(decisions).toHaveLength(0);
    });
    
    it('devrait lever une erreur si le fichier n\'existe pas', () => {
      // Arrange
      const filePath = join(testDir, 'nonexistent.md');
      
      // Act & Assert
      expect(() => parseRoadmapMarkdown(filePath)).toThrow(RooSyncParseError);
    });
  });

  describe('parseDashboardJson', () => {
    it('devrait parser un fichier JSON dashboard valide', () => {
      // Arrange
      const dashboard: RooSyncDashboard = {
        version: '2.0.0',
        lastUpdate: '2025-10-07T12:00:00Z',
        lastSync: '2025-10-07T12:00:00Z',
        overallStatus: 'synced',
        status: 'synced',
        machines: {
          'PC-PRINCIPAL': {
            lastSync: '2025-10-07T11:00:00Z',
            status: 'online',
            diffsCount: 0,
            pendingDecisions: 0
          },
          'MAC-DEV': {
            lastSync: '2025-10-07T10:00:00Z',
            status: 'online',
            diffsCount: 2,
            pendingDecisions: 1
          }
        },
        stats: {
          totalDiffs: 2,
          totalDecisions: 1,
          appliedDecisions: 0,
          pendingDecisions: 1
        }
      };
      
      const filePath = join(testDir, 'dashboard.json');
      writeFileSync(filePath, JSON.stringify(dashboard, null, 2), 'utf-8');
      
      // Act
      const parsed = parseDashboardJson(filePath);
      
      // Assert
      expect(parsed.version).toBe('2.0.0');
      expect(parsed.overallStatus).toBe('synced');
      expect(Object.keys(parsed.machines)).toHaveLength(2);
      expect(parsed.machines['PC-PRINCIPAL'].diffsCount).toBe(0);
      expect(parsed.machines['MAC-DEV'].pendingDecisions).toBe(1);
      expect(parsed.stats?.totalDiffs).toBe(2);
    });
    
    it('devrait lever une erreur si le JSON est invalide', () => {
      // Arrange
      const filePath = join(testDir, 'invalid.json');
      writeFileSync(filePath, '{ invalid json }', 'utf-8');
      
      // Act & Assert
      expect(() => parseDashboardJson(filePath)).toThrow(RooSyncParseError);
    });
  });

  describe('parseConfigJson', () => {
    it('devrait parser un fichier JSON de configuration', () => {
      // Arrange
      const config = {
        version: '2.0.0',
        sharedStatePath: '/path/to/shared'
      };
      
      const filePath = join(testDir, 'config.json');
      writeFileSync(filePath, JSON.stringify(config), 'utf-8');
      
      // Act
      const parsed = parseConfigJson(filePath);
      
      // Assert
      expect(parsed.version).toBe('2.0.0');
      expect(parsed.sharedStatePath).toBe('/path/to/shared');
    });
  });

  describe('filterDecisionsByStatus', () => {
    it('devrait filtrer les décisions par statut', () => {
      // Arrange
      const decisions: RooSyncDecision[] = [
        {
          id: 'd1',
          title: 'Decision 1',
          status: 'pending',
          type: 'config',
          sourceMachine: 'M1',
          targetMachines: [],
          createdAt: '2025-10-07T10:00:00Z'
        },
        {
          id: 'd2',
          title: 'Decision 2',
          status: 'approved',
          type: 'file',
          sourceMachine: 'M1',
          targetMachines: [],
          createdAt: '2025-10-07T11:00:00Z'
        },
        {
          id: 'd3',
          title: 'Decision 3',
          status: 'pending',
          type: 'setting',
          sourceMachine: 'M2',
          targetMachines: [],
          createdAt: '2025-10-07T12:00:00Z'
        }
      ];
      
      // Act
      const pending = filterDecisionsByStatus(decisions, 'pending');
      const approved = filterDecisionsByStatus(decisions, 'approved');
      
      // Assert
      expect(pending).toHaveLength(2);
      expect(pending[0].id).toBe('d1');
      expect(pending[1].id).toBe('d3');
      expect(approved).toHaveLength(1);
      expect(approved[0].id).toBe('d2');
    });
  });

  describe('filterDecisionsByMachine', () => {
    it('devrait filtrer les décisions par machine cible', () => {
      // Arrange
      const decisions: RooSyncDecision[] = [
        {
          id: 'd1',
          title: 'Decision 1',
          status: 'pending',
          type: 'config',
          sourceMachine: 'M1',
          targetMachines: ['M2', 'M3'],
          createdAt: '2025-10-07T10:00:00Z'
        },
        {
          id: 'd2',
          title: 'Decision 2',
          status: 'pending',
          type: 'file',
          sourceMachine: 'M1',
          targetMachines: ['all'],
          createdAt: '2025-10-07T11:00:00Z'
        },
        {
          id: 'd3',
          title: 'Decision 3',
          status: 'pending',
          type: 'setting',
          sourceMachine: 'M2',
          targetMachines: ['M4'],
          createdAt: '2025-10-07T12:00:00Z'
        }
      ];
      
      // Act
      const forM2 = filterDecisionsByMachine(decisions, 'M2');
      const forM4 = filterDecisionsByMachine(decisions, 'M4');
      
      // Assert
      expect(forM2).toHaveLength(2); // d1 (ciblé) + d2 (all)
      expect(forM2.map(d => d.id)).toContain('d1');
      expect(forM2.map(d => d.id)).toContain('d2');
      
      expect(forM4).toHaveLength(2); // d2 (all) + d3 (ciblé)
      expect(forM4.map(d => d.id)).toContain('d2');
      expect(forM4.map(d => d.id)).toContain('d3');
    });
  });

  describe('findDecisionById', () => {
    it('devrait trouver une décision par ID', () => {
      // Arrange
      const decisions: RooSyncDecision[] = [
        {
          id: 'd1',
          title: 'Decision 1',
          status: 'pending',
          type: 'config',
          sourceMachine: 'M1',
          targetMachines: [],
          createdAt: '2025-10-07T10:00:00Z'
        },
        {
          id: 'd2',
          title: 'Decision 2',
          status: 'approved',
          type: 'file',
          sourceMachine: 'M1',
          targetMachines: [],
          createdAt: '2025-10-07T11:00:00Z'
        }
      ];
      
      // Act
      const found = findDecisionById(decisions, 'd2');
      const notFound = findDecisionById(decisions, 'd999');
      
      // Assert
      expect(found).toBeDefined();
      expect(found?.id).toBe('d2');
      expect(found?.title).toBe('Decision 2');
      expect(notFound).toBeUndefined();
    });
  });
});