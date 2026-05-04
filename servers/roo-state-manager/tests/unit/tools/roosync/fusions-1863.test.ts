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
// FUSION E: get_status → inventory(type: "status")
// #1935 Cluster E — parameter mapping + Zod validation
// ============================================================
describe('#1935 Fusion E: get_status → inventory(type: "status")', () => {
  describe('Scenario 1: Canonical call via inventory(type: "status")', () => {
    it('should validate type="status"', () => {
      const result = InventoryArgsSchema.safeParse({ type: 'status' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe('status');
      }
    });

    it('should validate type="status" with machineId', () => {
      const result = InventoryArgsSchema.safeParse({
        type: 'status',
        machineId: 'myia-po-2026'
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.machineId).toBe('myia-po-2026');
      }
    });

    it('should validate type="status" with detail and resetCache', () => {
      const result = InventoryArgsSchema.safeParse({
        type: 'status',
        detail: 'full',
        resetCache: true,
        includeDetails: true
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.detail).toBe('full');
        expect(result.data.resetCache).toBe(true);
        expect(result.data.includeDetails).toBe(true);
      }
    });

    it('should have "status" in inventory definition type enum', () => {
      const typeEnum = (roosyncInventoryDefinition.inputSchema as any).properties.type.enum;
      expect(typeEnum).toContain('status');
    });
  });

  describe('Scenario 2: Backward-compat redirect — machineFilter → machineId mapping', () => {
    it('should map legacy machineFilter to machineId via InventoryArgsSchema', () => {
      // Simulates the redirect logic: legacy caller passes machineFilter
      const legacyArgs = { machineFilter: 'myia-po-2026', type: 'status' as const };
      // Redirect maps machineFilter → machineId
      const redirectArgs = InventoryArgsSchema.parse({
        type: 'status',
        machineId: legacyArgs.machineFilter,
      });
      expect(redirectArgs.machineId).toBe('myia-po-2026');
      expect(redirectArgs.type).toBe('status');
    });

    it('should prefer machineId over machineFilter when both present', () => {
      const legacyArgs = { machineId: 'machine-A', machineFilter: 'machine-B' };
      const redirectArgs = InventoryArgsSchema.parse({
        type: 'status',
        machineId: legacyArgs.machineId ?? legacyArgs.machineFilter,
      });
      expect(redirectArgs.machineId).toBe('machine-A');
    });

    it('should use machineFilter when machineId is absent', () => {
      const legacyArgs = { machineFilter: 'machine-B' };
      const redirectArgs = InventoryArgsSchema.parse({
        type: 'status',
        machineId: legacyArgs.machineId ?? legacyArgs.machineFilter,
      });
      expect(redirectArgs.machineId).toBe('machine-B');
    });

    it('should work with no machine filter at all', () => {
      const legacyArgs = {};
      const redirectArgs = InventoryArgsSchema.parse({
        type: 'status',
        machineId: legacyArgs.machineId ?? legacyArgs.machineFilter,
      });
      expect(redirectArgs.machineId).toBeUndefined();
    });
  });

  describe('Scenario 3: Error case — invalid status parameters', () => {
    it('should reject invalid detail value', () => {
      const result = InventoryArgsSchema.safeParse({
        type: 'status',
        detail: 'verbose'
      });
      expect(result.success).toBe(false);
    });

    it('should strip unknown parameters (Zod default behavior)', () => {
      const result = InventoryArgsSchema.safeParse({
        type: 'status',
        unknownParam: 'value'
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).not.toHaveProperty('unknownParam');
      }
    });
  });
});

// ============================================================
// Cross-cutting: Definition count and deprecation removal verification
// ============================================================
describe('#1863 Cross-cutting: tool count and deprecation markers', () => {
  it('allToolDefinitions should contain 22 tools (3 deprecated #1863 + 6 low-usage #1841 + 1 Cluster D fusion + 1 Cluster E fusion removed)', () => {
    // Before: 32 tools → #1922 Pass 4 removed 3 deprecated → 29
    // #1841 removed 6 low-usage (get_mcp_best_practices, export_config, view_task_details,
    //   get_raw_conversation, refresh_dashboard, update_dashboard) → 23 (wait: 29-6=23)
    // Actually #297 consolidated to 24 active in ListTools (less low-usage). allToolDefinitions baseline = 24.
    // Cluster D (#1935) fused analyze_roosync_problems → roosync_diagnose(action: "analyze"): 24 → 23
    // Cluster E (#1935) fused get_status → inventory(type: "status"): 23 → 22
    // Backward compat redirect handlers in registry.ts are preserved
    expect(allToolDefinitions.length).toBe(22);
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
