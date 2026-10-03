/**
 * Tests d'intégration pour roosync_inventory
 *
 * NOTE LIMITATION: Cet outil dépend de PowerShell (Get-MachineInventory.ps1)
 * et du service RooSync. Ces tests vérifient que l'outil ne plante pas.
 *
 * Framework: Vitest
 * Type: Intégration (limité par contrainte PowerShell + RooSync)
 *
 * @module tools/roosync/inventory.integration.test
 * @version 1.0.0 (#564 Phase 3)
 */

import { describe, test, expect, beforeAll, vi } from 'vitest';
import { globalCacheManager } from '../../../utils/cache-manager.js';

// Fix #634: Integration tests need REAL RooSyncService and ConfigService
vi.unmock('../../../services/RooSyncService.js');
vi.unmock('../../../services/ConfigService.js');

// Fix #636 timeout: Use static imports instead of dynamic imports
import { inventoryTool, InventoryArgsSchema, InventoryResultSchema, HeartbeatDataSchema, HeartbeatStatisticsSchema } from '../inventory.js';

describe('roosync_inventory (integration)', () => {
  beforeAll(async () => {
    // Clear cache pour éviter les résultats cachés d'exécutions précédentes
    await globalCacheManager.invalidate({ all: true });
  });

  // ============================================================
  // Tests de validation des entrées
  // ============================================================

  describe('input validation', () => {
    test('should accept type parameter with valid values', async () => {
      // Les valeurs valides sont: machine, heartbeat, all
      const types = ['machine', 'heartbeat', 'all'] as const;

      for (const type of types) {
        const result = await inventoryTool.execute({ type }, null);

        expect(result).toMatchObject({ success: expect.any(Boolean) });
        // Only check data if success is true (error cases don't have data property)
        if (result.success) {
          expect(result.data.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
        }
      }
    }, 30000); // 30 second timeout - each inventory call takes ~8 seconds

    test('should accept optional machineId parameter', async () => {
      // Sans machineId - utilise hostname par défaut
      const result1 = await inventoryTool.execute({ type: 'machine' }, null);

      expect(result1).toMatchObject({ success: expect.any(Boolean) });

      // Avec machineId explicite
      const result2 = await inventoryTool.execute({
        type: 'machine',
        machineId: 'test-machine-id'
      }, null);

      expect(result2).toMatchObject({ success: expect.any(Boolean) });
    });

    test('should accept optional includeHeartbeats parameter', async () => {
      const result = await inventoryTool.execute({
        type: 'heartbeat',
        includeHeartbeats: true
      }, null);

      expect(result).toMatchObject({ success: expect.any(Boolean) });
    });
  });

  // ============================================================
  // Tests de format de réponse
  // ============================================================

  describe('response format', () => {
    test('should have InventoryArgsSchema with proper structure', () => {
      // Vérifier que le schema a la bonne structure : type requis,
      // filtres optionnels (inventory.ts l.26-49)
      const shape = InventoryArgsSchema.shape;
      expect(shape.type.isOptional()).toBe(false);
      expect(shape.machineId.isOptional()).toBe(true);
      expect(shape.includeHeartbeats.isOptional()).toBe(true);
    });

    test('should have InventoryResultSchema with proper structure', () => {
      // Contrat de retour (inventory.ts l.134-156) : success/retrievedAt requis,
      // machineInventory (z.any) et heartbeatState optionnels selon le type
      const shape = InventoryResultSchema.shape;
      expect(shape.success.isOptional()).toBe(false);
      expect(shape.retrievedAt.isOptional()).toBe(false);
      expect(shape.machineInventory.isOptional()).toBe(true);
      expect(shape.heartbeatState.isOptional()).toBe(true);
    });

    test('should include type enum with correct values', () => {
      // Enum type réel du handler (inventory.ts l.27) — 6 types, pas seulement
      // machine/heartbeat/all : machines, status et health (#2224) existent aussi.
      const shape = InventoryArgsSchema.shape;
      expect(shape.type.options).toEqual(['machine', 'heartbeat', 'all', 'machines', 'status', 'health']);
    });

    test('should have HeartbeatDataSchema with required fields', () => {
      // Champs requis du heartbeat (inventory.ts l.89-109)
      const shape = HeartbeatDataSchema.shape;
      expect(shape.machineId.isOptional()).toBe(false);
      expect(shape.lastHeartbeat.isOptional()).toBe(false);
      expect(shape.status.isOptional()).toBe(false);
      expect(shape.metadata.isOptional()).toBe(false);
      expect(shape.status.options).toEqual(['online', 'idle', 'unknown']);
    });

    test('should have HeartbeatStatisticsSchema with required fields', () => {
      // Champs requis des statistiques (inventory.ts l.116-127)
      const shape = HeartbeatStatisticsSchema.shape;
      expect(shape.totalMachines.isOptional()).toBe(false);
      expect(shape.onlineCount.isOptional()).toBe(false);
      expect(shape.idleCount.isOptional()).toBe(false); // ADR 008: idle replaces offline
      expect(shape.unknownCount.isOptional()).toBe(false); // ADR 008: unknown replaces warning
      expect(shape.lastHeartbeatCheck.isOptional()).toBe(false);
    });
  });

  // ============================================================
  // Tests de gestion des types d'inventaire
  // ============================================================

  describe('inventory types', () => {
    test('should handle type=machine', async () => {
      const result = await inventoryTool.execute({ type: 'machine' }, null);

      expect(result).toMatchObject({ success: expect.any(Boolean) });
      // Only check data if success is true (error cases don't have data property)
      if (result.success) {
        expect(Object.keys(result.data)).toEqual(expect.arrayContaining(['retrievedAt', 'machineInventory']));
      }
    });

    test('should handle type=heartbeat', async () => {
      const result = await inventoryTool.execute({
        type: 'heartbeat',
        includeHeartbeats: true
      }, null);

      expect(result).toMatchObject({ success: expect.any(Boolean) });
      // Only check data if success is true (error cases don't have data property)
      if (result.success) {
        // heartbeatState : listes par statut + statistiques + timestamp (InventoryResultSchema)
        expect(result.data.heartbeatState).toMatchObject({
          statistics: expect.any(Object),
          retrievedAt: expect.any(String)
        });
      }
    });

    test('should handle type=all', async () => {
      const result = await inventoryTool.execute({
        type: 'all',
        includeHeartbeats: true
      }, null);

      expect(result).toMatchObject({ success: expect.any(Boolean) });
      // Only check data if success is true (error cases don't have data property)
      if (result.success) {
        // type=all doit retourner les deux inventaires
        expect(Object.keys(result.data)).toEqual(expect.arrayContaining(['machineInventory', 'heartbeatState']));
      }
    });
  });

  // ============================================================
  // Tests de gestion d'erreurs
  // ============================================================

  describe('error handling', () => {
    test('should handle PowerShell script unavailable gracefully', async () => {
      // Si le script PowerShell n'est pas disponible, l'outil doit retourner une erreur cohérente
      const result = await inventoryTool.execute({
        type: 'machine',
        machineId: 'non-existent-machine-for-testing'
      }, null);

      expect(result).toMatchObject({ success: expect.any(Boolean) });

      // Si PowerShell n'est pas disponible, success peut être false
      if (!result.success) {
        expect(result.error).toMatchObject({
          code: expect.any(String),
          message: expect.any(String)
        });
      } else {
        expect(result.data.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      }
    });

    test('should handle RooSync service unavailable gracefully', async () => {
      // Si le service RooSync n'est pas disponible, l'outil doit retourner une erreur cohérente
      const result = await inventoryTool.execute({
        type: 'heartbeat'
      }, null);

      expect(result).toMatchObject({ success: expect.any(Boolean) });

      // Si le service RooSync n'est pas disponible, success peut être false
      if (!result.success) {
        expect(result.error).toMatchObject({
          code: expect.any(String),
          message: expect.any(String)
        });
      } else {
        expect(result.data.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      }
    });
  });

  // ============================================================
  // NOTE: Tests complets de roosync_inventory
  // ============================================================
  /*
   * Les tests suivants nécessitent un environnement complet:
   *
   * - Script PowerShell Get-MachineInventory.ps1 fonctionnel
   * - Service RooSync disponible avec données de heartbeat
   * - Machines enregistrées avec heartbeats actifs
   * - Inventaires machine valides (CPU, RAM, disques, GPU, etc.)
   *
   * Ces tests ne peuvent pas être automatisés sans:
   * 1. Un environnement PowerShell avec le script disponible
   * 2. Un service RooSync avec des données de test
   * 3. Des machines simulées ou réelles pour l'inventaire
   * 4. Un mécanisme pour simuler les heartbeats
   *
   * Pour les tests unitaires de la logique d'inventaire,
   * le fichier InventoryService.test.ts existe déjà.
   */
});
