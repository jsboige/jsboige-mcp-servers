/**
 * Tests for roosync_refresh_dashboard tool
 *
 * Covers: successful refresh, ROOSYNC_SHARED_PATH validation,
 * script execution, dashboard parsing, error handling
 *
 * #4149 : la frontière mockée est PowerShellExecutor.executeScript (spawn sans
 * shell, argv -File) — plus aucune chaîne de commande interpolée.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    roosyncRefreshDashboard,
} from '../../../../src/tools/roosync/refresh-dashboard.js';

const {
    mockExecuteScript,
    mockReadFile,
} = vi.hoisted(() => ({
    mockExecuteScript: vi.fn(),
    mockReadFile: vi.fn(),
}));

vi.mock('../../../../src/services/PowerShellExecutor.js', () => ({
    PowerShellExecutor: class {
        executeScript = mockExecuteScript;
    },
}));

vi.mock('fs/promises', () => ({
    readFile: mockReadFile,
}));

function mockScriptSuccess(stdout: string) {
    mockExecuteScript.mockResolvedValue({ success: true, stdout, stderr: '', exitCode: 0, executionTime: 10 });
}

/** Args reçus par executeScript : [scriptPath, argv, options]. */
function argvOfCall(i = 0): string[] {
    return mockExecuteScript.mock.calls[i][1] as string[];
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
        mockScriptSuccess(`Some output\nFichier: /tmp/shared/dashboards/mcp-dashboard-2026-05-04_12-00-00.md\nDone`);
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
        mockScriptSuccess(`Fichier: /tmp/shared/dashboards/mcp-dashboard-2026-05-04_12-00-00.md`);
        mockReadFile.mockResolvedValue(DASHBOARD_MD);

        const result = await roosyncRefreshDashboard({ baseline: 'myia-po-2025' });
        expect(result.baseline).toBe('myia-po-2025');
        // #4149 : la valeur est un élément argv distinct, pas une sous-chaîne de commande
        const argv = argvOfCall(0);
        expect(argv[argv.indexOf('-Baseline') + 1]).toBe('myia-po-2025');
    });

    it('uses custom outputDir', async () => {
        mockScriptSuccess(`Fichier: /custom/dir/mcp-dashboard-2026-05-04_12-00-00.md`);
        mockReadFile.mockResolvedValue(DASHBOARD_MD);

        const result = await roosyncRefreshDashboard({ outputDir: '/custom/dir' });
        expect(result.success).toBe(true);
        const argv = argvOfCall(0);
        expect(argv[argv.indexOf('-OutputDir') + 1]).toBe('/custom/dir');
    });

    it('uses default outputDir from ROOSYNC_SHARED_PATH', async () => {
        mockScriptSuccess(`Fichier: /tmp/shared/dashboards/mcp-dashboard-2026-05-04_12-00-00.md`);
        mockReadFile.mockResolvedValue(DASHBOARD_MD);

        await roosyncRefreshDashboard({});
        const argv = argvOfCall(0);
        expect(argv[argv.indexOf('-OutputDir') + 1]).toBe('/tmp/shared/dashboards');
    });

    it('throws when ROOSYNC_SHARED_PATH missing', async () => {
        delete process.env.ROOSYNC_SHARED_PATH;
        await expect(roosyncRefreshDashboard({}))
            .rejects.toThrow('ROOSYNC_SHARED_PATH non configuré');
    });

    it('throws when dashboard path not found in output', async () => {
        mockScriptSuccess('Script ran but no file path in output');
        await expect(roosyncRefreshDashboard({}))
            .rejects.toThrow('Impossible de déterminer le chemin');
    });

    it('throws when script execution fails', async () => {
        mockExecuteScript.mockRejectedValue(new Error('Script crashed'));
        await expect(roosyncRefreshDashboard({}))
            .rejects.toThrow('Script crashed');
    });

    it('handles empty dashboard parsing gracefully', async () => {
        mockScriptSuccess(`Fichier: /tmp/shared/dashboards/mcp-dashboard-2026-05-04_12-00-00.md`);
        mockReadFile.mockResolvedValue('# Empty dashboard\nNo tables');

        const result = await roosyncRefreshDashboard({});
        expect(result.success).toBe(true);
        expect(result.machines).toEqual([]);
        expect(result.metrics.totalMachines).toBe(0);
    });

    it('extracts timestamp from filename', async () => {
        mockScriptSuccess(`Fichier: /tmp/shared/dashboards/mcp-dashboard-2026-05-04_15-30-45.md`);
        mockReadFile.mockResolvedValue(DASHBOARD_MD);

        const result = await roosyncRefreshDashboard({});
        expect(result.timestamp).toBe('2026-05-04_15-30-45');
    });

    it('handles dashboard read failure gracefully', async () => {
        mockScriptSuccess(`Fichier: /tmp/shared/dashboards/mcp-dashboard-2026-05-04_12-00-00.md`);
        mockReadFile.mockRejectedValue(new Error('File not found'));

        const result = await roosyncRefreshDashboard({});
        expect(result.success).toBe(true);
        expect(result.machines).toEqual([]);
    });
});
