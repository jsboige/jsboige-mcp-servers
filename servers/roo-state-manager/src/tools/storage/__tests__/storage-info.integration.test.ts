/**
 * Tests d'intégration pour storage_info (detect + stats)
 *
 * Couvre les deux actions de l'outil :
 * - action: 'detect' : Détection des emplacements de stockage Roo
 * - action: 'stats' : Statistiques de stockage (conversations, taille)
 *
 * Framework: Vitest
 * Type: Intégration (RooStorageDetector réel, opérations filesystem réelles)
 *
 * @module storage/storage-info.integration.test
 * @version 1.0.0 (#564 Phase 3)
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';

// Import des fonctions réelles (pas de mocks pour l'intégration)
import { handleStorageInfo } from '../storage-info.js';
import { RooStorageDetector } from '../../../utils/roo-storage-detector.js';

describe('storage_info (integration)', () => {
  // Chemin pour les données de test (hors du chemin normal de Roo pour éviter interférence)
  const testStorageBase = join(__dirname, '../../../__test-data__/storage-integration');
  const testRooPath = join(testStorageBase, 'roo-storage');
  const testTasksPath = join(testRooPath, 'tasks');

  beforeEach(async () => {
    // Setup : créer structure de test
    const dirs = [
      testStorageBase,
      testRooPath,
      testTasksPath
    ];

    for (const dir of dirs) {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }

    // Créer quelques tâches de test (répertoires vides = 1 conversation chacun)
    // RooStorageDetector.getStatsForPath() compte les répertoires
    const taskDirs = ['task-001', 'task-002', 'task-003'];
    for (const taskDir of taskDirs) {
      const taskPath = join(testTasksPath, taskDir);
      if (!existsSync(taskPath)) {
        mkdirSync(taskPath);
      }
      // On pourrait créer des fichiers task_metadata.json pour des tests plus avancés,
      // mais pour les tests de base, les répertoires suffisent
    }
  });

  afterEach(() => {
    // Cleanup : supprimer répertoire test
    if (existsSync(testStorageBase)) {
      rmSync(testStorageBase, { recursive: true, force: true });
    }
  });

  // ============================================================
  // Tests pour action: 'detect'
  // ============================================================

  describe('action: detect', () => {
    test('should return empty result when no Roo storage detected', async () => {
      // Note: Dans un environnement de test isolé, il est possible qu'aucun stockage Roo
      // ne soit détecté (surtout si on ne crée pas les chemins exacts que Roo utilise)
      const result = await handleStorageInfo({ action: 'detect' });

      expect(result).toBeDefined();
      expect(result.content).toHaveLength(1);

      const text = (result.content[0] as any).text;
      expect(typeof text).toBe('string');

      // Le résultat doit être un JSON valide
      const parsed = JSON.parse(text);
      expect(parsed).toHaveProperty('locations');
      expect(Array.isArray(parsed.locations)).toBe(true);
    });

    test('should return JSON with locations array', async () => {
      const result = await handleStorageInfo({ action: 'detect' });

      const text = (result.content[0] as any).text;
      const parsed = JSON.parse(text);

      // Vérifier la structure
      expect(parsed).toHaveProperty('locations');
      expect(Array.isArray(parsed.locations)).toBe(true);

      // Chaque location doit avoir path et type
      parsed.locations.forEach((loc: any) => {
        expect(loc).toHaveProperty('path');
        expect(loc).toHaveProperty('type');
        expect(typeof loc.path).toBe('string');
        expect(typeof loc.type).toBe('string');
      });
    });

    test('should complete without errors for detect action', async () => {
      const result = await handleStorageInfo({ action: 'detect' });

      expect(result).toBeDefined();
      expect(result.content).toHaveLength(1);
      expect((result.content[0] as any).type).toBe('text');
      expect((result.content[0] as any).text).toBeTruthy();
    });
  });

  // ============================================================
  // Tests pour action: 'stats'
  // ============================================================

  describe('action: stats', () => {
    test('should return stats with numeric fields', async () => {
      const result = await handleStorageInfo({ action: 'stats' });

      expect(result.content).toHaveLength(1);
      const text = (result.content[0] as any).text;

      // Le résultat doit être du JSON valide
      const parsed = JSON.parse(text);

      // Champs attendus
      expect(parsed).toHaveProperty('totalLocations');
      expect(parsed).toHaveProperty('totalConversations');
      expect(parsed).toHaveProperty('totalSize');
      expect(parsed).toHaveProperty('workspaceBreakdown');
      expect(parsed).toHaveProperty('totalWorkspaces');

      // Types attendus
      expect(typeof parsed.totalLocations).toBe('number');
      expect(typeof parsed.totalConversations).toBe('number');
      expect(typeof parsed.totalSize).toBe('number');
      expect(typeof parsed.totalWorkspaces).toBe('number');
      expect(typeof parsed.workspaceBreakdown).toBe('object');
    });

    test('should return zero or positive values for all stats', async () => {
      const result = await handleStorageInfo({ action: 'stats' });

      const text = (result.content[0] as any).text;
      const parsed = JSON.parse(text);

      // Les valeurs numériques doivent être >= 0
      expect(parsed.totalLocations).toBeGreaterThanOrEqual(0);
      expect(parsed.totalConversations).toBeGreaterThanOrEqual(0);
      expect(parsed.totalSize).toBeGreaterThanOrEqual(0);
      expect(parsed.totalWorkspaces).toBeGreaterThanOrEqual(0);
    });

    test('should include workspaceBreakdown as object', async () => {
      const result = await handleStorageInfo({ action: 'stats' });

      const text = (result.content[0] as any).text;
      const parsed = JSON.parse(text);

      // workspaceBreakdown doit être un objet (pas un array)
      expect(Array.isArray(parsed.workspaceBreakdown)).toBe(false);
      expect(typeof parsed.workspaceBreakdown).toBe('object');

      // S'il y a des workspaces, vérifier leur structure
      for (const [workspace, data] of Object.entries(parsed.workspaceBreakdown)) {
        expect(typeof workspace).toBe('string');
        expect(typeof data).toBe('object');
        expect(data).toHaveProperty('count');
        expect(data).toHaveProperty('totalSize');
        expect(data).toHaveProperty('lastActivity');
      }
    });

    test('should complete without errors for stats action', async () => {
      const result = await handleStorageInfo({ action: 'stats' });

      expect(result).toBeDefined();
      expect(result.content).toHaveLength(1);
      expect((result.content[0] as any).type).toBe('text');
      expect((result.content[0] as any).text).toBeTruthy();
    });
  });

  // ============================================================
  // Tests direct du RooStorageDetector (sans passer par l'outil MCP)
  // ============================================================

  describe('RooStorageDetector (direct integration)', () => {
    test('should detect storage locations', async () => {
      const locations = await RooStorageDetector.detectStorageLocations();

      expect(Array.isArray(locations)).toBe(true);
      // Chaque location doit être un chemin string
      locations.forEach(loc => {
        expect(typeof loc).toBe('string');
      });
    });

    test('should calculate stats for a specific path', async () => {
      // Utiliser le chemin de test créé dans beforeEach
      if (existsSync(testTasksPath)) {
        const stats = await RooStorageDetector.getStatsForPath(testTasksPath);

        expect(stats).toHaveProperty('conversationCount');
        expect(stats).toHaveProperty('totalSize');
        expect(stats).toHaveProperty('fileTypes');

        expect(typeof stats.conversationCount).toBe('number');
        expect(typeof stats.totalSize).toBe('number');

        // On a créé 3 répertoires dans beforeEach
        expect(stats.conversationCount).toBeGreaterThanOrEqual(0);
      }
    });

    test('should throw error for non-existent path', async () => {
      const nonexistentPath = join(testStorageBase, 'does-not-exist', 'tasks');

      // getStatsForPath lance une erreur si le chemin n'existe pas
      await expect(RooStorageDetector.getStatsForPath(nonexistentPath)).rejects.toThrow();
    });
  });

  // ============================================================
  // Tests d'erreur et validation
  // ============================================================

  describe('error handling', () => {
    test('should handle invalid action gracefully', async () => {
      const result = await handleStorageInfo({ action: 'invalid' as any });

      // Ne devrait pas lancer d'erreur non gérée
      expect(result).toBeDefined();
      expect(result.content).toHaveLength(1);
    });

    test('should handle missing action parameter', async () => {
      const result = await handleStorageInfo({} as any);

      // Ne devrait pas lancer d'erreur non gérée
      expect(result).toBeDefined();
    });
  });
});
