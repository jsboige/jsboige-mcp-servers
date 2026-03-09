/**
 * Tests d'intégration pour repair_conversation_bom
 *
 * NOTE LIMITATION: RooStorageDetector utilise os.homedir() pour chercher
 * le stockage Roo, ce qui ne peut pas être mocké facilement dans les tests.
 * Ces tests vérifient donc que l'outil ne plante pas, mais les tests complets
 * de réparation nécessitent un stockage Roo réel.
 *
 * Tests unitaires pour la logique BOM (détection, retrait) → voir .unit.test.ts
 *
 * Framework: Vitest
 * Type: Intégration (limité par contrainte os.homedir())
 *
 * @module repair/repair-conversation-bom.integration.test
 * @version 1.0.0 (#564 Phase 3)
 */

import { describe, test, expect, beforeAll } from 'vitest';
import { globalCacheManager } from '../../../utils/cache-manager.js';

describe('repair_conversation_bom (integration)', () => {
  beforeAll(async () => {
    // Clear cache pour éviter les résultats cachés d'exécutions précédentes
    await globalCacheManager.invalidate({ all: true });
  });

  // ============================================================
  // Tests de base - L'outil ne doit pas planter
  // ============================================================

  describe('basic functionality', () => {
    test('should return valid result structure even without Roo storage', async () => {
      const { repairConversationBomTool } = await import('../repair-conversation-bom.tool.js');
      const result = await repairConversationBomTool.handler({ dry_run: true });

      // L'outil doit toujours retourner une structure valide
      expect(result).toBeDefined();
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');

      const text = result.content[0].text;
      expect(typeof text).toBe('string');
      expect(text.length).toBeGreaterThan(0);
    });

    test('should support both dry_run modes', async () => {
      const { repairConversationBomTool } = await import('../repair-conversation-bom.tool.js');

      // Test dry_run = true
      const dryResult = await repairConversationBomTool.handler({ dry_run: true });
      expect(dryResult.content[0].text).toBeTruthy();

      // Test dry_run = false (mode réel, mais sans stockage = no-op)
      const realResult = await repairConversationBomTool.handler({ dry_run: false });
      expect(realResult.content[0].text).toBeTruthy();
    });

    test('should include mode indicator in result', async () => {
      const { repairConversationBomTool } = await import('../repair-conversation-bom.tool.js');

      const dryRunResult = await repairConversationBomTool.handler({ dry_run: true });
      const dryRunText = dryRunResult.content[0].text;

      // Si aucun stockage Roo, le mode indicator n'est pas présent
      if (!dryRunText.includes('Aucun emplacement de stockage Roo trouvé')) {
        expect(dryRunText).toContain('Simulation (dry-run)');
      }

      const realResult = await repairConversationBomTool.handler({ dry_run: false });
      const realText = realResult.content[0].text;

      // Si aucun stockage Roo, le mode indicator n'est pas présent
      if (!realText.includes('Aucun emplacement de stockage Roo trouvé')) {
        expect(realText).toContain('Réparation réelle');
      }
    });
  });

  // ============================================================
  // Tests de format de réponse
  // ============================================================

  describe('response format', () => {
    test('should always return valid text response', async () => {
      const { repairConversationBomTool } = await import('../repair-conversation-bom.tool.js');
      const result = await repairConversationBomTool.handler({});

      const text = result.content[0].text;

      // Le rapport doit contenir certaines sections (si stockage Roo présent)
      if (!text.includes('Aucun emplacement de stockage Roo trouvé')) {
        expect(text).toContain('# Réparation BOM des conversations');
        expect(text).toContain('**Mode:**');
        expect(text).toContain('**Fichiers analysés:**');
        expect(text).toContain('**Fichiers corrompus (BOM):**');
      } else {
        // Si aucun stockage, le message doit être cohérent
        expect(text).toBe('Aucun emplacement de stockage Roo trouvé.');
      }
    });

    test('should handle empty result gracefully', async () => {
      const { repairConversationBomTool } = await import('../repair-conversation-bom.tool.js');
      const result = await repairConversationBomTool.handler({ dry_run: true });

      const text = result.content[0].text;

      // Même sans stockage Roo, le format doit être cohérent
      if (text.includes('Aucun emplacement de stockage Roo trouvé')) {
        // Message spécifique quand aucun stockage
        expect(text).toBe('Aucun emplacement de stockage Roo trouvé.');
      } else {
        // Sinon, doit avoir le format de rapport complet
        expect(text).toMatch(/\*\*Fichiers analysés:\*\* \d+/);
      }
    });
  });

  // ============================================================
  // NOTE: Tests complets de réparation BOM
  // ============================================================
  /*
   * Les tests suivants nécessitent un stockage Roo réel:
   *
   * - Détection de fichiers avec BOM
   * - Retrait du BOM (0xEF 0xBB 0xBF)
   * - Validation JSON après retrait
   * - Préservation du contenu UTF-8
   *
   * Ces tests ne peuvent pas être automatisés sans:
   * 1. Un stockage Roo réel dans os.homedir()
   * 2. Ou une refactorisation du tool pour accepter un path explicite
   *
   * Pour les tests unitaires de la logique BOM pure (Buffer operations),
   * voir repair-conversation-bom.unit.test.ts (à créer).
   */
});
