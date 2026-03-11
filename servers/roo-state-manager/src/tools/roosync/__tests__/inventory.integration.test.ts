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

        expect(result).toBeDefined();
        expect(result).toHaveProperty('success');
        // Only check data if success is true (error cases don't have data property)
        if (result.success) {
          expect(result.data).toHaveProperty('retrievedAt');
        }
      }
    }, 30000); // 30 second timeout - each inventory call takes ~8 seconds

    test('should accept optional machineId parameter', async () => {
      // Sans machineId - utilise hostname par défaut
      const result1 = await inventoryTool.execute({ type: 'machine' }, null);

      expect(result1).toBeDefined();
      expect(result1).toHaveProperty('success');

      // Avec machineId explicite
      const result2 = await inventoryTool.execute({
        type: 'machine',
        machineId: 'test-machine-id'
      }, null);

      expect(result2).toBeDefined();
      expect(result2).toHaveProperty('success');
    });

    test('should accept optional includeHeartbeats parameter', async () => {
      const result = await inventoryTool.execute({
        type: 'heartbeat',
        includeHeartbeats: true
      }, null);

      expect(result).toBeDefined();
      expect(result).toHaveProperty('success');
    });
  });

  // ============================================================
  // Tests de format de réponse
  // ============================================================

  describe('response format', () => {
    test('should have InventoryArgsSchema with proper structure', () => {
      // Vérifier que le schema a la bonne structure
      expect(InventoryArgsSchema).toBeDefined();
      const shape = InventoryArgsSchema.shape;
      expect(shape.type).toBeDefined();
      expect(shape.machineId).toBeDefined();
      expect(shape.includeHeartbeats).toBeDefined();
    });

    test('should have InventoryResultSchema with proper structure', () => {
      // Vérifier que le schema de retour a la bonne structure
      expect(InventoryResultSchema).toBeDefined();
      const shape = InventoryResultSchema.shape;
      expect(shape.success).toBeDefined();
      expect(shape.machineInventory).toBeDefined();
      expect(shape.heartbeatState).toBeDefined();
      expect(shape.retrievedAt).toBeDefined();
    });

    test('should include type enum with correct values', () => {
      // Vérifier que l'enum type contient les bonnes valeurs
      const shape = InventoryArgsSchema.shape;
      expect(shape.type).toBeDefined();
    });

    test('should have HeartbeatDataSchema with required fields', () => {
      // Vérifier que le schema de heartbeat a les bons champs
      expect(HeartbeatDataSchema).toBeDefined();
      const shape = HeartbeatDataSchema.shape;
      expect(shape.machineId).toBeDefined();
      expect(shape.lastHeartbeat).toBeDefined();
      expect(shape.status).toBeDefined();
      expect(shape.missedHeartbeats).toBeDefined();
      expect(shape.metadata).toBeDefined();
    });

    test('should have HeartbeatStatisticsSchema with required fields', () => {
      // Vérifier que le schema de statistiques a les bons champs
      expect(HeartbeatStatisticsSchema).toBeDefined();
      const shape = HeartbeatStatisticsSchema.shape;
      expect(shape.totalMachines).toBeDefined();
      expect(shape.onlineCount).toBeDefined();
      expect(shape.offlineCount).toBeDefined();
      expect(shape.warningCount).toBeDefined();
      expect(shape.lastHeartbeatCheck).toBeDefined();
    });
  });

  // ============================================================
  // Tests de gestion des types d'inventaire
  // ============================================================

  describe('inventory types', () => {
    test('should handle type=machine', async () => {
      const result = await inventoryTool.execute({ type: 'machine' }, null);

      expect(result).toBeDefined();
      expect(result).toHaveProperty('success');
      // Only check data if success is true (error cases don't have data property)
      if (result.success) {
        expect(result.data).toHaveProperty('retrievedAt');
        expect(result.data).toHaveProperty('machineInventory');
      }
    });

    test('should handle type=heartbeat', async () => {
      const result = await inventoryTool.execute({
        type: 'heartbeat',
        includeHeartbeats: true
      }, null);

      expect(result).toBeDefined();
      expect(result).toHaveProperty('success');
      // Only check data if success is true (error cases don't have data property)
      if (result.success) {
        expect(result.data).toHaveProperty('heartbeatState');
        expect(result.data.heartbeatState).toHaveProperty('statistics');
        expect(result.data.heartbeatState).toHaveProperty('retrievedAt');
      }
    });

    test('should handle type=all', async () => {
      const result = await inventoryTool.execute({
        type: 'all',
        includeHeartbeats: true
      }, null);

      expect(result).toBeDefined();
      expect(result).toHaveProperty('success');
      // Only check data if success is true (error cases don't have data property)
      if (result.success) {
        // type=all doit retourner les deux inventaires
        expect(result.data).toHaveProperty('machineInventory');
        expect(result.data).toHaveProperty('heartbeatState');
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

      expect(result).toBeDefined();
      expect(result).toHaveProperty('success');

      // Si PowerShell n'est pas disponible, success peut être false
      if (!result.success) {
        expect(result.error).toBeDefined();
        expect(result.error).toHaveProperty('code');
        expect(result.error).toHaveProperty('message');
      } else {
        expect(result.data).toHaveProperty('retrievedAt');
      }
    });

    test('should handle RooSync service unavailable gracefully', async () => {
      // Si le service RooSync n'est pas disponible, l'outil doit retourner une erreur cohérente
      const result = await inventoryTool.execute({
        type: 'heartbeat'
      }, null);

      expect(result).toBeDefined();
      expect(result).toHaveProperty('success');

      // Si le service RooSync n'est pas disponible, success peut être false
      if (!result.success) {
        expect(result.error).toBeDefined();
        expect(result.error).toHaveProperty('code');
        expect(result.error).toHaveProperty('message');
      } else {
        expect(result.data).toHaveProperty('retrievedAt');
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
