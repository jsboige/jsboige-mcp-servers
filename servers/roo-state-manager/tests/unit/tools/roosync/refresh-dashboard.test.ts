/**
 * Tests for roosync_refresh_dashboard tool
 *
 * Covers: successful refresh, ROOSYNC_SHARED_PATH validation,
 * script execution, dashboard parsing, error handling
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    roosyncRefreshDashboard,
    refreshDashboardToolMetadata,
} from '../../../../src/tools/roosync/refresh-dashboard.js';

const {
    mockExec,
    mockReadFile,
} = vi.hoisted(() => ({
    mockExec: vi.fn(),
    mockReadFile: vi.fn(),
}));

vi.mock('child_process', () => ({
    exec: mockExec,
}));

vi.mock('util', () => ({
    promisify: () => mockExec,
}));

vi.mock('fs/promises', () => ({
    readFile: mockReadFile,
}));

function mockExecSuccess(stdout: string) {
    mockExec.mockResolvedValue({ stdout, stderr: '' });
}

const DASHBOARD_MD = `# MCP Dashboard

| Machine | Status | Diffs |
|---------|--------|-------|
| myia-ai-01 | ✅ Online | 0 |
| myia-po-2025 | ✅ Online | 2 |
| myia-po-2023 | ❌ Offline | N/A |
`;

describe('roosync_refresh_dashboard', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        process.env.ROOSYNC_SHARED_PATH = '/tmp/shared';
    });

    it('refreshes dashboard successfully', async () => {
        mockExecSuccess(`Some output\nFichier: /tmp/shared/dashboards/mcp-dashboard-2026-05-04_12-00-00.md\nDone`);
        mockReadFile.mockResolvedValue(DASHBOARD_MD);

        const result = await roosyncRefreshDashboard({});
        expect(result.success).toBe(true);
        expect(result.baseline).toBe('myia-ai-01');
        expect(result.dashboardPath).toContain('mcp-dashboard-2026-05-04_12-00-00.md');
        expect(result.metrics.totalMachines).toBe(3);
        expect(result.metrics.machinesWithInventory).toBe(2);
        expect(result.metrics.machinesWithoutInventory).toBe(1);
    });

    it('uses custom baseline', async () => {
        mockExecSuccess(`Fichier: /tmp/shared/dashboards/mcp-dashboard-2026-05-04_12-00-00.md`);
        mockReadFile.mockResolvedValue(DASHBOARD_MD);

        const result = await roosyncRefreshDashboard({ baseline: 'myia-po-2025' });
        expect(result.baseline).toBe('myia-po-2025');
        const cmd = mockExec.mock.calls[0][0];
        expect(cmd).toContain('myia-po-2025');
    });

    it('uses custom outputDir', async () => {
        mockExecSuccess(`Fichier: /custom/dir/mcp-dashboard-2026-05-04_12-00-00.md`);
        mockReadFile.mockResolvedValue(DASHBOARD_MD);

        const result = await roosyncRefreshDashboard({ outputDir: '/custom/dir' });
        expect(result.success).toBe(true);
        const cmd = mockExec.mock.calls[0][0];
        expect(cmd).toContain('/custom/dir');
    });

    it('uses default outputDir from ROOSYNC_SHARED_PATH', async () => {
        mockExecSuccess(`Fichier: /tmp/shared/dashboards/mcp-dashboard-2026-05-04_12-00-00.md`);
        mockReadFile.mockResolvedValue(DASHBOARD_MD);

        await roosyncRefreshDashboard({});
        const cmd = mockExec.mock.calls[0][0];
        expect(cmd).toContain('/tmp/shared/dashboards');
    });

    it('throws when ROOSYNC_SHARED_PATH missing', async () => {
        delete process.env.ROOSYNC_SHARED_PATH;
        await expect(roosyncRefreshDashboard({}))
            .rejects.toThrow('ROOSYNC_SHARED_PATH non configuré');
    });

    it('throws when dashboard path not found in output', async () => {
        mockExecSuccess('Script ran but no file path in output');
        await expect(roosyncRefreshDashboard({}))
            .rejects.toThrow('Impossible de déterminer le chemin');
    });

    it('throws when script execution fails', async () => {
        mockExec.mockRejectedValue(new Error('Script crashed'));
        await expect(roosyncRefreshDashboard({}))
            .rejects.toThrow('Script crashed');
    });

    it('handles empty dashboard parsing gracefully', async () => {
        mockExecSuccess(`Fichier: /tmp/shared/dashboards/mcp-dashboard-2026-05-04_12-00-00.md`);
        mockReadFile.mockResolvedValue('# Empty dashboard\nNo tables');

        const result = await roosyncRefreshDashboard({});
        expect(result.success).toBe(true);
        expect(result.machines).toEqual([]);
        expect(result.metrics.totalMachines).toBe(0);
    });

    it('extracts timestamp from filename', async () => {
        mockExecSuccess(`Fichier: /tmp/shared/dashboards/mcp-dashboard-2026-05-04_15-30-45.md`);
        mockReadFile.mockResolvedValue(DASHBOARD_MD);

        const result = await roosyncRefreshDashboard({});
        expect(result.timestamp).toBe('2026-05-04_15-30-45');
    });

    it('handles dashboard read failure gracefully', async () => {
        mockExecSuccess(`Fichier: /tmp/shared/dashboards/mcp-dashboard-2026-05-04_12-00-00.md`);
        mockReadFile.mockRejectedValue(new Error('File not found'));

        const result = await roosyncRefreshDashboard({});
        expect(result.success).toBe(true);
        expect(result.machines).toEqual([]);
    });

    describe('metadata', () => {
        it('has correct tool metadata', () => {
            expect(refreshDashboardToolMetadata.name).toBe('roosync_refresh_dashboard');
            expect(refreshDashboardToolMetadata.inputSchema.properties.baseline).toBeDefined();
            expect(refreshDashboardToolMetadata.inputSchema.properties.outputDir).toBeDefined();
        });
    });
});
