/**
 * Tests unitaires pour roosync_machines
 *
 * ADR 008 Phase 2: offline/warning removed, only unknown/idle/all.
 *
 * Framework: Vitest
 *
 * @module roosync/machines.test
 * @version 2.0.0 (ADR 008 Phase 2)
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock RooSyncService et HeartbeatService
vi.mock('../../../services/RooSyncService.js', () => ({
  getRooSyncService: vi.fn(() => ({
    getHeartbeatService: vi.fn(() => ({
      getUnknownMachines: vi.fn(() => ['machine-3', 'machine-5']),
      getIdleMachines: vi.fn(() => ['machine-4', 'machine-6']),
      getHeartbeatData: vi.fn((machineId) => {
        const data: any = {
          machineId,
          lastHeartbeat: new Date().toISOString(),
          status: (machineId === 'machine-3' || machineId === 'machine-5') ? 'unknown' : 'idle',
          metadata: {
            firstSeen: new Date().toISOString(),
            lastUpdated: new Date().toISOString()
          }
        };

        return data;
      })
    }))
  }))
}));

// Mock ExecutionContext complet
const mockExecutionContext: any = {
  services: {
    storage: { read: vi.fn(), write: vi.fn(), delete: vi.fn() },
    cache: { get: vi.fn(), set: vi.fn(), delete: vi.fn() },
    search: { search: vi.fn(), index: vi.fn() },
    export: { export: vi.fn(), format: vi.fn() },
    summary: { summarize: vi.fn(), aggregate: vi.fn() },
    display: { display: vi.fn(), format: vi.fn() },
    utility: { validate: vi.fn(), transform: vi.fn() }
  },
  security: { validateInput: vi.fn(() => true), sanitizeOutput: vi.fn((x) => x) },
  monitoring: {
    immediate: { logEvent: vi.fn(), logError: vi.fn() },
    background: { logEvent: vi.fn(), logError: vi.fn() }
  },
  cacheManager: { get: vi.fn(), set: vi.fn(), delete: vi.fn() }
};

import { machinesTool, machinesToolMetadata } from '../machines.js';
import { getRooSyncService } from '../../../services/RooSyncService.js';

describe('machinesTool', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  describe('status: unknown', () => {
    test('should return unknown machines', async () => {
      const result = await machinesTool.execute({ status: 'unknown' }, mockExecutionContext);

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data.unknownMachines).toEqual(['machine-3', 'machine-5']);
      expect(result.data.idleMachines).toBeUndefined();
    });

    test('should return unknown machines with details', async () => {
      const result = await machinesTool.execute(
        { status: 'unknown', includeDetails: true },
        mockExecutionContext
      );

      expect(result.success).toBe(true);
      expect(result.data.unknownMachines![0].status).toBe('unknown');
    });

    test('should handle errors gracefully', async () => {
      vi.mocked(getRooSyncService).mockImplementationOnce(() => {
        throw new Error('Heartbeat service error');
      });

      const result = await machinesTool.execute({ status: 'unknown' }, mockExecutionContext);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.code).toBe('MACHINES_COLLECTION_FAILED');
    });
  });

  describe('status: idle', () => {
    test('should return idle machines', async () => {
      const result = await machinesTool.execute({ status: 'idle' }, mockExecutionContext);

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data.idleMachines).toEqual(['machine-4', 'machine-6']);
      expect(result.data.unknownMachines).toBeUndefined();
    });

    test('should return idle machines with details', async () => {
      const result = await machinesTool.execute(
        { status: 'idle', includeDetails: true },
        mockExecutionContext
      );

      expect(result.success).toBe(true);
      expect(result.data.idleMachines![0].status).toBe('idle');
    });
  });

  describe('status: all', () => {
    test('should return both unknown and idle machines', async () => {
      const result = await machinesTool.execute({ status: 'all' }, mockExecutionContext);

      expect(result.success).toBe(true);
      expect(result.data.unknownMachines).toEqual(['machine-3', 'machine-5']);
      expect(result.data.idleMachines).toEqual(['machine-4', 'machine-6']);
    });

    test('should include details when requested', async () => {
      const result = await machinesTool.execute(
        { status: 'all', includeDetails: true },
        mockExecutionContext
      );

      expect(result.data.unknownMachines![0].status).toBe('unknown');
      expect(result.data.idleMachines![0].status).toBe('idle');
    });
  });

  describe('validation', () => {
    test('should have correct metadata', () => {
      expect(machinesToolMetadata.name).toBe('roosync_machines');
      expect(machinesToolMetadata.inputSchema.properties.status.enum).toEqual(['unknown', 'idle', 'all']);
    });

    test('should require status parameter', () => {
      expect(machinesToolMetadata.inputSchema.required).toContain('status');
    });
  });

  describe('integration', () => {
    test('should handle multiple calls with different status', async () => {
      const r1 = await machinesTool.execute({ status: 'unknown' }, mockExecutionContext);
      const r2 = await machinesTool.execute({ status: 'idle' }, mockExecutionContext);
      const r3 = await machinesTool.execute({ status: 'all' }, mockExecutionContext);

      expect(r1.success).toBe(true);
      expect(r2.success).toBe(true);
      expect(r3.success).toBe(true);
    });

    test('should return execution time metrics', async () => {
      const result = await machinesTool.execute({ status: 'unknown' }, mockExecutionContext);

      expect(result.metrics).toBeDefined();
      expect(result.metrics.executionTime).toBeGreaterThanOrEqual(0);
    });
  });
});
