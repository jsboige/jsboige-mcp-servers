/**
 * #1863 Phase A — Tool Fusions Test Matrix
 *
 * 3 fusions × 3 scenarios = 9 test cases:
 *   Fusion A1: decision_info → decision(action: "info")
 *   Fusion A2: machines → inventory(type: "machines")
 *   Fusion A3: cleanup → manage redirect
 *
 * Scenarios per fusion:
 *   1. Canonical call — new API path works
 *   2. Redirected call — old tool name still works via backward-compat
 *   3. Error case — invalid input handled correctly
 */

import { describe, it, expect } from 'vitest';
import { RooSyncDecisionArgsSchema } from '../../../../src/tools/roosync/decision.js';
import { InventoryArgsSchema } from '../../../../src/tools/roosync/inventory.js';
import {
  allToolDefinitions,
  roosyncDecisionDefinition,
  roosyncInventoryDefinition,
  roosyncDecisionInfoDefinition,
  roosyncMachinesDefinition,
  roosyncCleanupMessagesDefinition
} from '../../../../src/tools/tool-definitions.js';

// ============================================================
// FUSION A1: decision_info → decision(action: "info")
// ============================================================
describe('#1863 Fusion A1: decision_info → decision(action: "info")', () => {
  describe('Scenario 1: Canonical call via decision(action: "info")', () => {
    it('should validate action="info" with decisionId', () => {
      const result = RooSyncDecisionArgsSchema.safeParse({
        action: 'info',
        decisionId: 'DEC-001'
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.action).toBe('info');
        expect(result.data.decisionId).toBe('DEC-001');
      }
    });

    it('should validate action="info" with optional includeHistory', () => {
      const result = RooSyncDecisionArgsSchema.safeParse({
        action: 'info',
        decisionId: 'DEC-001',
        includeHistory: false
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.includeHistory).toBe(false);
      }
    });

    it('should default includeHistory and includeLogs to true for info action', () => {
      const result = RooSyncDecisionArgsSchema.safeParse({
        action: 'info',
        decisionId: 'DEC-001'
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.includeHistory).toBe(true);
        expect(result.data.includeLogs).toBe(true);
      }
    });
  });

  describe('Scenario 2: Redirected call — backward-compat definition exists', () => {
    it('should have roosync_decision_info in allToolDefinitions for backward compat', () => {
      const names = allToolDefinitions.map(d => d.name);
      expect(names).toContain('roosync_decision_info');
    });

    it('should have "info" in decision definition action enum', () => {
      const actionEnum = (roosyncDecisionDefinition.inputSchema as any).properties.action.enum;
      expect(actionEnum).toContain('info');
    });

    it('should have includeHistory and includeLogs in decision definition', () => {
      const props = (roosyncDecisionDefinition.inputSchema as any).properties;
      expect(props).toHaveProperty('includeHistory');
      expect(props).toHaveProperty('includeLogs');
    });
  });

  describe('Scenario 3: Error case — invalid info parameters', () => {
    it('should reject info action without decisionId', () => {
      const result = RooSyncDecisionArgsSchema.safeParse({
        action: 'info'
      });
      expect(result.success).toBe(false);
    });

    it('should reject non-boolean includeHistory', () => {
      const result = RooSyncDecisionArgsSchema.safeParse({
        action: 'info',
        decisionId: 'DEC-001',
        includeHistory: 'yes'
      });
      expect(result.success).toBe(false);
    });
  });
});

// ============================================================
// FUSION A2: machines → inventory(type: "machines")
// ============================================================
describe('#1863 Fusion A2: machines → inventory(type: "machines")', () => {
  describe('Scenario 1: Canonical call via inventory(type: "machines")', () => {
    it('should validate type="machines"', () => {
      const result = InventoryArgsSchema.safeParse({
        type: 'machines'
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe('machines');
      }
    });

    it('should validate type="machines" with status="offline"', () => {
      const result = InventoryArgsSchema.safeParse({
        type: 'machines',
        status: 'offline'
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.status).toBe('offline');
      }
    });

    it('should validate type="machines" with includeDetails=true', () => {
      const result = InventoryArgsSchema.safeParse({
        type: 'machines',
        includeDetails: true
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.includeDetails).toBe(true);
      }
    });

    it('should validate type="machines" with status="all" and includeDetails=true', () => {
      const result = InventoryArgsSchema.safeParse({
        type: 'machines',
        status: 'all',
        includeDetails: true
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.status).toBe('all');
        expect(result.data.includeDetails).toBe(true);
      }
    });
  });

  describe('Scenario 2: Redirected call — backward-compat definition exists', () => {
    it('should have roosync_machines in allToolDefinitions for backward compat', () => {
      const names = allToolDefinitions.map(d => d.name);
      expect(names).toContain('roosync_machines');
    });

    it('should have "machines" in inventory definition type enum', () => {
      const typeEnum = (roosyncInventoryDefinition.inputSchema as any).properties.type.enum;
      expect(typeEnum).toContain('machines');
    });

    it('should have status and includeDetails in inventory definition', () => {
      const props = (roosyncInventoryDefinition.inputSchema as any).properties;
      expect(props).toHaveProperty('status');
      expect(props).toHaveProperty('includeDetails');
    });
  });

  describe('Scenario 3: Error case — invalid machines parameters', () => {
    it('should reject invalid status value', () => {
      const result = InventoryArgsSchema.safeParse({
        type: 'machines',
        status: 'invalid'
      });
      expect(result.success).toBe(false);
    });

    it('should reject missing type', () => {
      const result = InventoryArgsSchema.safeParse({});
      expect(result.success).toBe(false);
    });
  });
});

// ============================================================
// FUSION A3: cleanup → manage redirect
// ============================================================
describe('#1863 Fusion A3: cleanup → manage redirect', () => {
  describe('Scenario 1: Canonical call via manage(bulk_mark_read/bulk_archive)', () => {
    it('should have bulk_mark_read in manage definition action enum', () => {
      const actionEnum = (allToolDefinitions.find(d => d.name === 'roosync_manage')!.inputSchema as any).properties.action.enum;
      expect(actionEnum).toContain('bulk_mark_read');
      expect(actionEnum).toContain('bulk_archive');
    });
  });

  describe('Scenario 2: Redirected call — backward-compat definition exists', () => {
    it('should have roosync_cleanup_messages in allToolDefinitions for backward compat', () => {
      const names = allToolDefinitions.map(d => d.name);
      expect(names).toContain('roosync_cleanup_messages');
    });

    it('cleanup definition should be marked as deprecated in description', () => {
      expect(roosyncCleanupMessagesDefinition.description).toContain('DEPRECATED');
    });

    it('cleanup definition should reference manage in description', () => {
      expect(roosyncCleanupMessagesDefinition.description).toContain('roosync_manage');
    });
  });

  describe('Scenario 3: Error case — redirect mapping validation', () => {
    it('should have operation enum with mark_read and archive in cleanup definition', () => {
      const opEnum = (roosyncCleanupMessagesDefinition.inputSchema as any).properties.operation.enum;
      expect(opEnum).toContain('mark_read');
      expect(opEnum).toContain('archive');
    });

    it('should require operation in cleanup definition', () => {
      const required = (roosyncCleanupMessagesDefinition.inputSchema as any).required;
      expect(required).toContain('operation');
    });
  });
});

// ============================================================
// Cross-cutting: Definition count and deprecation markers
// ============================================================
describe('#1863 Cross-cutting: tool count and deprecation markers', () => {
  it('allToolDefinitions should still contain all 33 tools (3 deprecated but kept)', () => {
    // Before fusions: 33 tools in allToolDefinitions (heartbeat removed in #1609)
    // After fusions: still 33 (deprecated tools kept for backward compat, not removed from list)
    expect(allToolDefinitions.length).toBe(33);
  });

  it('deprecated definitions should have DEPRECATED in description', () => {
    expect(roosyncDecisionInfoDefinition.description).toContain('DEPRECATED');
    expect(roosyncMachinesDefinition.description).toContain('DEPRECATED');
    expect(roosyncCleanupMessagesDefinition.description).toContain('DEPRECATED');
  });

  it('canonical tools should not be deprecated', () => {
    expect(roosyncDecisionDefinition.description).not.toContain('DEPRECATED');
    expect(roosyncInventoryDefinition.description).not.toContain('DEPRECATED');
  });
});
