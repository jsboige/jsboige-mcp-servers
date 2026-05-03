/**
 * #1863 Phase A — Tool Fusions Test Matrix
 *
 * 3 fusions × 2 scenarios = 6 test cases:
 *   Fusion A1: decision_info → decision(action: "info")
 *   Fusion A2: machines → inventory(type: "machines")
 *   Fusion A3: cleanup → manage redirect
 *
 * Scenarios per fusion:
 *   1. Canonical call — new API path works
 *   2. Error case — invalid input handled correctly
 *
 * Note: Backward-compat definitions (roosync_decision_info, roosync_machines,
 * roosync_cleanup_messages) were removed in #1922 Pass 4 — 644 tokens saved.
 */

import { describe, it, expect } from 'vitest';
import { RooSyncDecisionArgsSchema } from '../../../../src/tools/roosync/decision.js';
import { InventoryArgsSchema } from '../../../../src/tools/roosync/inventory.js';
import {
  allToolDefinitions,
  roosyncDecisionDefinition,
  roosyncInventoryDefinition,
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

  describe('Scenario 2: Error case — invalid info parameters', () => {
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

  describe('Scenario 2: Error case — invalid machines parameters', () => {
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
  describe('Canonical call via manage(bulk_mark_read/bulk_archive)', () => {
    it('should have bulk_mark_read in manage definition action enum', () => {
      const actionEnum = (allToolDefinitions.find(d => d.name === 'roosync_manage')!.inputSchema as any).properties.action.enum;
      expect(actionEnum).toContain('bulk_mark_read');
      expect(actionEnum).toContain('bulk_archive');
    });
  });
});

// ============================================================
// Cross-cutting: Definition count and deprecation removal verification
// ============================================================
describe('#1863 Cross-cutting: tool count and deprecation markers', () => {
  it('allToolDefinitions should contain 23 tools (3 deprecated #1863 + 6 low-usage #1841 + 1 Cluster D fusion removed)', () => {
    // Before: 33 tools → #1922 Pass 4 removed 3 deprecated → 30
    // #1841 removed 6 low-usage (get_mcp_best_practices, export_config, view_task_details,
    //   get_raw_conversation, refresh_dashboard, update_dashboard) → 24
    // Cluster D (#1935) fused analyze_roosync_problems → roosync_diagnose(action: "analyze"): 24 → 23
    // Backward compat redirect handlers in registry.ts are preserved
    expect(allToolDefinitions.length).toBe(23);
  });

  it('deprecated tools should NOT be in allToolDefinitions', () => {
    const names = allToolDefinitions.map(d => d.name);
    expect(names).not.toContain('roosync_decision_info');
    expect(names).not.toContain('roosync_machines');
    expect(names).not.toContain('roosync_cleanup_messages');
  });

  it('canonical tools should not be deprecated', () => {
    expect(roosyncDecisionDefinition.description).not.toContain('DEPRECATED');
    expect(roosyncInventoryDefinition.description).not.toContain('DEPRECATED');
  });

  it('deprecated tool names should NOT appear in tools/list', () => {
    const names = allToolDefinitions.map(d => d.name);
    expect(names).not.toContain('roosync_decision_info');
    expect(names).not.toContain('roosync_machines');
    expect(names).not.toContain('roosync_cleanup_messages');
    expect(names).not.toContain('analyze_roosync_problems'); // #1935 Cluster D
  });
});
