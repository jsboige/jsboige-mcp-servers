/**
 * Tests for #1935 Cluster B: refresh/update sub-actions in roosync_dashboard
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { roosyncDashboard } from '../dashboard.js';

// Mock refresh-dashboard module
const mockRefreshDashboard = vi.fn();
vi.mock('../refresh-dashboard.js', () => ({
  roosyncRefreshDashboard: (...args: any[]) => mockRefreshDashboard(...args),
  RefreshDashboardArgsSchema: {},
  RefreshDashboardResultSchema: {},
  refreshDashboardToolMetadata: { name: 'roosync_refresh_dashboard' }
}));

// Mock update-dashboard module
const mockUpdateDashboard = vi.fn();
vi.mock('../update-dashboard.js', () => ({
  roosyncUpdateDashboard: (...args: any[]) => mockUpdateDashboard(...args),
  UpdateDashboardArgsSchema: {},
  UpdateDashboardResultSchema: {},
  updateDashboardToolMetadata: { name: 'roosync_update_dashboard' }
}));

// Mock OpenAI for condensation
vi.mock('@/services/openai', () => ({
  getChatOpenAIClient: () => { throw new Error('No chat API key configured'); },
  resetChatOpenAIClient: vi.fn(),
  getLLMModelId: () => 'test-model',
}));

// Mock heartbeat-activity
vi.mock('../heartbeat-activity.js', () => ({
  recordRooSyncActivityAsync: vi.fn(),
}));

describe('roosync_dashboard Cluster B (#1935)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ROOSYNC_SHARED_PATH = '/tmp/test-shared';
    process.env.ROOSYNC_MACHINE_ID = 'test-machine';
    process.env.ROOSYNC_WORKSPACE_ID = 'test-workspace';
  });

  describe('action: refresh', () => {
    it('should delegate to roosyncRefreshDashboard', async () => {
      mockRefreshDashboard.mockResolvedValue({
        success: true,
        dashboardPath: '/tmp/dashboard.md',
        timestamp: '2026-05-03',
        baseline: 'myia-ai-01',
        machines: [
          { id: 'myia-ai-01', status: '✅ OK', diffs: '0' }
        ],
        metrics: { totalMachines: 1, machinesWithInventory: 1, machinesWithoutInventory: 0 }
      });

      const result = await roosyncDashboard({
        action: 'refresh',
        baseline: 'myia-ai-01'
      });

      expect(result.success).toBe(true);
      expect(result.action).toBe('refresh');
      expect(mockRefreshDashboard).toHaveBeenCalledWith({
        baseline: 'myia-ai-01',
        outputDir: undefined
      });
    });

    it('should pass outputDir when provided', async () => {
      mockRefreshDashboard.mockResolvedValue({
        success: true,
        dashboardPath: '/custom/dir/dashboard.md',
        timestamp: '2026-05-03',
        baseline: 'myia-ai-01',
        machines: [],
        metrics: { totalMachines: 0, machinesWithInventory: 0, machinesWithoutInventory: 0 }
      });

      const result = await roosyncDashboard({
        action: 'refresh',
        baseline: 'myia-po-2026',
        outputDir: '/custom/dir'
      });

      expect(result.success).toBe(true);
      expect(mockRefreshDashboard).toHaveBeenCalledWith({
        baseline: 'myia-po-2026',
        outputDir: '/custom/dir'
      });
    });

    it('should handle refresh failure gracefully', async () => {
      mockRefreshDashboard.mockRejectedValue(new Error('PowerShell not found'));

      await expect(roosyncDashboard({ action: 'refresh' })).rejects.toThrow('PowerShell not found');
    });
  });

  describe('action: update', () => {
    it('should delegate to roosyncUpdateDashboard', async () => {
      mockUpdateDashboard.mockResolvedValue({
        success: true,
        dashboardPath: '/tmp/DASHBOARD.md',
        section: 'machine',
        mode: 'replace',
        timestamp: '2026-05-03T20:00:00Z'
      });

      const result = await roosyncDashboard({
        action: 'update',
        section: 'machine',
        content: '## Status\nAll good',
        machineId: 'test-machine',
        workspace: 'roo-extensions',
        mode: 'replace'
      });

      expect(result.success).toBe(true);
      expect(result.action).toBe('update');
      expect(mockUpdateDashboard).toHaveBeenCalledWith({
        section: 'machine',
        content: '## Status\nAll good',
        machine: 'test-machine',
        workspace: 'roo-extensions',
        mode: 'replace'
      });
    });

    it('should reject missing section', async () => {
      await expect(roosyncDashboard({
        action: 'update',
        content: 'test'
      })).rejects.toThrow('section');
    });

    it('should reject invalid section values', async () => {
      await expect(roosyncDashboard({
        action: 'update',
        section: 'status',
        content: 'test'
      })).rejects.toThrow('section');
    });

    it('should reject missing content', async () => {
      await expect(roosyncDashboard({
        action: 'update',
        section: 'global'
      })).rejects.toThrow('content');
    });

    it('should handle all valid sections', async () => {
      const sections = ['machine', 'global', 'intercom', 'decisions', 'metrics'] as const;
      mockUpdateDashboard.mockResolvedValue({
        success: true,
        dashboardPath: '/tmp/DASHBOARD.md',
        section: 'global',
        mode: 'replace',
        timestamp: '2026-05-03T20:00:00Z'
      });

      for (const section of sections) {
        const result = await roosyncDashboard({
          action: 'update',
          section,
          content: `Content for ${section}`
        });
        expect(result.success).toBe(true);
      }
    });

    it('should map machineId to machine param', async () => {
      mockUpdateDashboard.mockResolvedValue({
        success: true,
        dashboardPath: '/tmp/DASHBOARD.md',
        section: 'machine',
        mode: 'replace',
        timestamp: '2026-05-03T20:00:00Z'
      });

      await roosyncDashboard({
        action: 'update',
        section: 'machine',
        content: 'test',
        machineId: 'myia-po-2026'
      });

      expect(mockUpdateDashboard).toHaveBeenCalledWith(
        expect.objectContaining({ machine: 'myia-po-2026' })
      );
    });
  });
});
