/**
 * Tests for #1935 Cluster B: refresh sub-action in roosync_dashboard.
 *
 * #3549: update a quitté ce cluster — il est v3-native (même chemin de clé que
 * read/write/append) et est couvert par dashboard-update-v3.test.ts. La
 * délégation legacy vers update-dashboard.js (DASHBOARD.md monolithique) est
 * supprimée avec le module.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { roosyncDashboard } from '../dashboard.js';

// Mock refresh-dashboard module
const mockRefreshDashboard = vi.fn();
vi.mock('../refresh-dashboard.js', () => ({
  roosyncRefreshDashboard: (...args: any[]) => mockRefreshDashboard(...args),
  RefreshDashboardArgsSchema: {},
  RefreshDashboardResultSchema: {}
}));

// Mock OpenAI for condensation
vi.mock('@/services/openai', () => ({
  getChatOpenAIClient: () => { throw new Error('No chat API key configured'); },
  resetChatOpenAIClient: vi.fn(),
  getLLMModelId: () => 'test-model',
  // #2719: no fallback key here either — condensation degrades to the
  // deterministic path exactly as before, keeping these assertions valid.
  getFallbackChatOpenAIClient: () => null,
  getFallbackLLMModelId: () => 'test-fallback-model',
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
});
