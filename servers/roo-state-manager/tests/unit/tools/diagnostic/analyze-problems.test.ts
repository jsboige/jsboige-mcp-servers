/**
 * Tests unitaires pour analyze_roosync_problems
 * Analyse le fichier sync-roadmap.md pour détecter les problèmes
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fs/promises et server-helpers avec vi.hoisted
const { mockAccess, mockReadFile, mockStat, mockMkdir, mockWriteFile } = vi.hoisted(() => ({
    mockAccess: vi.fn(),
    mockReadFile: vi.fn(),
    mockStat: vi.fn(),
    mockMkdir: vi.fn(),
    mockWriteFile: vi.fn()
}));

vi.mock('fs/promises', () => ({
    access: mockAccess,
    readFile: mockReadFile,
    stat: mockStat,
    mkdir: mockMkdir,
    writeFile: mockWriteFile
}));

vi.mock('../../../../src/utils/server-helpers.js', () => ({
    getSharedStatePath: vi.fn(() => '/mock/shared-state')
}));

import { analyzeRooSyncProblems } from '../../../../src/tools/diagnostic/analyze_problems.js';

// Helper: generate a decision block
function makeDecisionBlock(id: string, status: string, extras: string = ''): string {
    return `<!-- DECISION_BLOCK_START -->
**ID:** \`${id}\`
**Statut:** ${status}
${extras}
<!-- DECISION_BLOCK_END -->`;
}

describe('analyze_roosync_problems', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Reset env vars
        delete process.env.ROOSYNC_SHARED_PATH;
        delete process.env.SHARED_STATE_PATH;
    });

    it('should return error when no roadmap file is found', async () => {
        mockAccess.mockRejectedValue(new Error('ENOENT'));

        const result = await analyzeRooSyncProblems();
        const data = JSON.parse((result.content[0] as any).text);

        expect(data.success).toBe(false);
        expect(data.error).toContain('introuvable');
    });

    it('should analyze a roadmap with no decisions', async () => {
        const emptyContent = '# Sync Roadmap\n\nNo decisions yet.';

        mockStat.mockResolvedValue({ size: emptyContent.length });
        mockReadFile.mockResolvedValue(emptyContent);

        const result = await analyzeRooSyncProblems({ roadmapPath: '/test/sync-roadmap.md' });
        const data = JSON.parse((result.content[0] as any).text);

        expect(data.success).toBe(true);
        expect(data.totalDecisions).toBe(0);
        expect(data.pendingDecisions).toBe(0);
        expect(data.approvedDecisions).toBe(0);
        expect(data.issues).toHaveLength(0);
    });

    it('should count pending and approved decisions', async () => {
        const content = [
            makeDecisionBlock('DEC-001', 'Pending'),
            makeDecisionBlock('DEC-002', 'Approved', '**Approuvé le:** 2025-01-15'),
            makeDecisionBlock('DEC-003', 'Pending'),
        ].join('\n\n');

        mockStat.mockResolvedValue({ size: content.length });
        mockReadFile.mockResolvedValue(content);

        const result = await analyzeRooSyncProblems({ roadmapPath: '/test/sync-roadmap.md' });
        const data = JSON.parse((result.content[0] as any).text);

        expect(data.totalDecisions).toBe(3);
        expect(data.pendingDecisions).toBe(2);
        expect(data.approvedDecisions).toBe(1);
        expect(data.issues).toHaveLength(0);
    });

    it('should detect duplicate decision IDs', async () => {
        const content = [
            makeDecisionBlock('DEC-001', 'Pending'),
            makeDecisionBlock('DEC-001', 'Approved', '**Approuvé le:** 2025-01-15'),
        ].join('\n\n');

        mockStat.mockResolvedValue({ size: content.length });
        mockReadFile.mockResolvedValue(content);

        const result = await analyzeRooSyncProblems({ roadmapPath: '/test/sync-roadmap.md' });
        const data = JSON.parse((result.content[0] as any).text);

        expect(data.duplicateIds).toContain('DEC-001');
        expect(data.issues.some((i: any) => i.type === 'DUPLICATE_DECISIONS')).toBe(true);
        expect(data.issues.find((i: any) => i.type === 'DUPLICATE_DECISIONS')?.severity).toBe('HIGH');
    });

    it('should detect corrupted hardware data (zero values)', async () => {
        const content = makeDecisionBlock('DEC-001', 'Pending', '**Valeur Source:** 0');

        mockStat.mockResolvedValue({ size: content.length });
        mockReadFile.mockResolvedValue(content);

        const result = await analyzeRooSyncProblems({ roadmapPath: '/test/sync-roadmap.md' });
        const data = JSON.parse((result.content[0] as any).text);

        expect(data.corruptedHardware).toHaveLength(1);
        expect(data.corruptedHardware[0].type).toBe('ZERO_VALUE');
        expect(data.issues.some((i: any) => i.type === 'CORRUPTED_HARDWARE_DATA')).toBe(true);
    });

    it('should detect corrupted hardware data (unknown values)', async () => {
        const content = makeDecisionBlock('DEC-001', 'Pending', '**Valeur Source:** "Unknown"');

        mockStat.mockResolvedValue({ size: content.length });
        mockReadFile.mockResolvedValue(content);

        const result = await analyzeRooSyncProblems({ roadmapPath: '/test/sync-roadmap.md' });
        const data = JSON.parse((result.content[0] as any).text);

        expect(data.corruptedHardware).toHaveLength(1);
        expect(data.corruptedHardware[0].type).toBe('UNKNOWN_VALUE');
    });

    it('should detect status inconsistencies (approved without approval date)', async () => {
        const content = makeDecisionBlock('DEC-001', 'Approved');

        mockStat.mockResolvedValue({ size: content.length });
        mockReadFile.mockResolvedValue(content);

        const result = await analyzeRooSyncProblems({ roadmapPath: '/test/sync-roadmap.md' });
        const data = JSON.parse((result.content[0] as any).text);

        expect(data.statusInconsistencies).toHaveLength(1);
        expect(data.statusInconsistencies[0].type).toBe('MISSING_APPROVAL_METADATA');
        expect(data.issues.some((i: any) => i.type === 'STATUS_INCONSISTENCIES')).toBe(true);
    });

    it('should use ROOSYNC_SHARED_PATH env var for auto-detection', async () => {
        process.env.ROOSYNC_SHARED_PATH = '/env/shared';
        mockAccess.mockResolvedValue(undefined);
        mockStat.mockResolvedValue({ size: 10 });
        mockReadFile.mockResolvedValue('');

        await analyzeRooSyncProblems();

        // Should have tried to access the env-based path
        expect(mockAccess).toHaveBeenCalled();
    });

    it('should return isError on filesystem errors', async () => {
        mockStat.mockRejectedValue(new Error('Permission denied'));

        const result = await analyzeRooSyncProblems({ roadmapPath: '/test/sync-roadmap.md' });

        expect(result.isError).toBe(true);
        const data = JSON.parse((result.content[0] as any).text);
        expect(data.success).toBe(false);
        expect(data.error).toContain('Permission denied');
    });

    it('should detect multiple issues simultaneously', async () => {
        const content = [
            makeDecisionBlock('DEC-001', 'Pending', '**Valeur Source:** 0'),
            makeDecisionBlock('DEC-001', 'Approved'),
            makeDecisionBlock('DEC-002', 'Pending', '**Valeur Source:** "Unknown"'),
        ].join('\n\n');

        mockStat.mockResolvedValue({ size: content.length });
        mockReadFile.mockResolvedValue(content);

        const result = await analyzeRooSyncProblems({ roadmapPath: '/test/sync-roadmap.md' });
        const data = JSON.parse((result.content[0] as any).text);

        expect(data.issues.length).toBeGreaterThanOrEqual(3);
        const issueTypes = data.issues.map((i: any) => i.type);
        expect(issueTypes).toContain('DUPLICATE_DECISIONS');
        expect(issueTypes).toContain('CORRUPTED_HARDWARE_DATA');
        expect(issueTypes).toContain('STATUS_INCONSISTENCIES');
    });
});
