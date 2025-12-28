import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConfigComparator } from '../../../../src/services/roosync/ConfigComparator.js';
import { RooSyncConfig } from '../../../../src/config/roosync-config.js';
import { BaselineService } from '../../../../src/services/BaselineService.js';
import { existsSync } from 'fs';

vi.mock('fs', () => ({
    promises: {
        access: vi.fn(),
        readFile: vi.fn(),
    },
    existsSync: vi.fn()
}));

vi.mock('../../../../src/services/BaselineService.js');

describe('ConfigComparator', () => {
    let comparator: ConfigComparator;
    let mockConfig: RooSyncConfig;
    let mockBaselineService: any;

    beforeEach(() => {
        mockConfig = {
            machineId: 'test-machine',
            sharedPath: '/tmp/shared'
        } as RooSyncConfig;

        mockBaselineService = {
            loadBaseline: vi.fn(),
            compareWithBaseline: vi.fn()
        };

        comparator = new ConfigComparator(mockConfig, mockBaselineService as unknown as BaselineService);
        vi.clearAllMocks();
    });

    describe('compareConfig', () => {
        it('should compare config with target machine', async () => {
            (existsSync as any).mockReturnValue(true);
            const dashboardLoader = vi.fn().mockResolvedValue({
                machines: {
                    'test-machine': {},
                    'other-machine': {}
                }
            });

            const result = await comparator.compareConfig(dashboardLoader, 'other-machine');
            
            expect(result.localMachine).toBe('test-machine');
            expect(result.targetMachine).toBe('other-machine');
        });

        it('should throw error if sync-config.json does not exist', async () => {
            (existsSync as any).mockReturnValue(false);
            const dashboardLoader = vi.fn();

            await expect(comparator.compareConfig(dashboardLoader)).rejects.toThrow('Fichier RooSync introuvable');
        });
    });

    describe('listDiffs', () => {
        it('should list differences from baseline', async () => {
            mockBaselineService.loadBaseline.mockResolvedValue({ machineId: 'baseline-machine' });
            mockBaselineService.compareWithBaseline.mockResolvedValue({
                differences: [
                    { category: 'config', path: 'setting1', description: 'Diff 1' }
                ]
            });

            const result = await comparator.listDiffs('all');
            
            expect(result.totalDiffs).toBe(1);
            expect(result.diffs[0].type).toBe('config');
            expect(result.diffs[0].machines).toContain('baseline-machine');
        });

        it('should filter differences by type', async () => {
            mockBaselineService.loadBaseline.mockResolvedValue({ machineId: 'baseline-machine' });
            mockBaselineService.compareWithBaseline.mockResolvedValue({
                differences: [
                    { category: 'config', path: 'setting1', description: 'Diff 1' },
                    { category: 'hardware', path: 'cpu', description: 'Diff 2' }
                ]
            });

            const result = await comparator.listDiffs('config');
            
            expect(result.totalDiffs).toBe(1);
            expect(result.diffs[0].type).toBe('config');
        });
    });

    describe('compareRealConfigurations', () => {
        it('should compare real configurations between two machines', async () => {
            mockBaselineService.loadBaseline.mockResolvedValue({});
            mockBaselineService.compareWithBaseline.mockImplementation(async (machineId: string) => {
                if (machineId === 'source-machine') {
                    return { differences: [{ severity: 'CRITICAL', description: 'Diff 1' }] };
                }
                return { differences: [] };
            });

            const result = await comparator.compareRealConfigurations('source-machine', 'target-machine');
            
            expect(result.sourceMachine).toBe('source-machine');
            expect(result.targetMachine).toBe('target-machine');
            expect(result.summary.critical).toBe(1);
        });

        it('should handle comparison failure', async () => {
            mockBaselineService.loadBaseline.mockResolvedValue({});
            mockBaselineService.compareWithBaseline.mockResolvedValue(null);

            const result = await comparator.compareRealConfigurations('source', 'target');
            expect(result).toBeNull();
        });
    });
});