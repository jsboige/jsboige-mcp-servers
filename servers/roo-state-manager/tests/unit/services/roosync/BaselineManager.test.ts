import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BaselineManager } from '../../../../src/services/roosync/BaselineManager.js';
import { RooSyncConfig } from '../../../../src/config/roosync-config.js';
import { BaselineService } from '../../../../src/services/BaselineService.js';
import { ConfigComparator } from '../../../../src/services/roosync/ConfigComparator.js';
import { existsSync, readFileSync } from 'fs';
import { promises as fs } from 'fs';

vi.mock('fs', () => ({
    constants: {
        R_OK: 4,
        W_OK: 2,
        F_OK: 0
    },
    promises: {
        access: vi.fn(),
        readFile: vi.fn(),
        writeFile: vi.fn(),
        mkdir: vi.fn(),
        copyFile: vi.fn(),
        readdir: vi.fn(),
        stat: vi.fn(),
        unlink: vi.fn(),
    },
    existsSync: vi.fn(),
    readFileSync: vi.fn()
}));

vi.mock('../../../../src/services/BaselineService.js');
vi.mock('../../../../src/services/roosync/ConfigComparator.js');

describe('BaselineManager', () => {
    let manager: BaselineManager;
    let mockConfig: RooSyncConfig;
    let mockBaselineService: any;
    let mockConfigComparator: any;

    beforeEach(() => {
        mockConfig = {
            machineId: 'test-machine',
            sharedPath: '/tmp/shared'
        } as RooSyncConfig;

        mockBaselineService = {
            loadBaseline: vi.fn()
        };

        mockConfigComparator = {
            listDiffs: vi.fn()
        };

        manager = new BaselineManager(
            mockConfig,
            mockBaselineService as unknown as BaselineService,
            mockConfigComparator as unknown as ConfigComparator
        );
    });

    describe('loadDashboard', () => {
        it('should load existing dashboard', async () => {
            (existsSync as any).mockReturnValue(true);
            (readFileSync as any).mockReturnValue(JSON.stringify({
                machines: { 'test-machine': {} }
            }));

            const cacheCallback = vi.fn().mockImplementation((key, fn) => fn());
            const dashboard = await manager.loadDashboard(cacheCallback);

            expect(dashboard.machines['test-machine']).toBeDefined();
        });

        it('should calculate dashboard if not exists', async () => {
            (existsSync as any).mockReturnValue(false);
            mockBaselineService.loadBaseline.mockResolvedValue({ machineId: 'baseline' });
            mockConfigComparator.listDiffs.mockResolvedValue({ totalDiffs: 0 });

            const cacheCallback = vi.fn().mockImplementation((key, fn) => fn());
            const dashboard = await manager.loadDashboard(cacheCallback);

            expect(dashboard.machines['test-machine']).toBeDefined();
            expect(dashboard.overallStatus).toBe('synced');
        });
    });

    describe('getStatus', () => {
        it('should return status for current machine', async () => {
            const dashboardLoader = vi.fn().mockResolvedValue({
                overallStatus: 'synced',
                machines: {
                    'test-machine': {
                        lastSync: '2023-01-01',
                        pendingDecisions: 0,
                        diffsCount: 0
                    }
                }
            });

            const status = await manager.getStatus(dashboardLoader);
            expect(status.machineId).toBe('test-machine');
            expect(status.overallStatus).toBe('synced');
        });

        it('should throw error if machine not found in dashboard', async () => {
            const dashboardLoader = vi.fn().mockResolvedValue({
                machines: {}
            });

            await expect(manager.getStatus(dashboardLoader)).rejects.toThrow('non trouvée dans le dashboard');
        });
    });

    describe('createRollbackPoint', () => {
        it('should create rollback point', async () => {
            (fs.mkdir as any).mockResolvedValue(undefined);
            (existsSync as any).mockReturnValue(true);
            (fs.copyFile as any).mockResolvedValue(undefined);
            (fs.writeFile as any).mockResolvedValue(undefined);

            await manager.createRollbackPoint('decision-1');

            expect(fs.mkdir).toHaveBeenCalled();
            expect(fs.copyFile).toHaveBeenCalled();
            expect(fs.writeFile).toHaveBeenCalled();
        });
    });

    describe('restoreFromRollbackPoint', () => {
        it('should restore from rollback point', async () => {
            // Mock existsSync pour retourner true pour tous les chemins nécessaires
            (existsSync as any).mockReturnValue(true);
            (fs.readdir as any).mockResolvedValue(['decision-1_timestamp']);
            (fs.readFile as any).mockResolvedValue(JSON.stringify({ files: ['file1'], timestamp: '2023-01-01', machine: 'test-machine' }));
            (fs.copyFile as any).mockResolvedValue(undefined);
            (fs.access as any).mockResolvedValue(undefined);
            (fs.stat as any).mockResolvedValue({ size: 100 });
            (fs.unlink as any).mockResolvedValue(undefined);

            const clearCacheCallback = vi.fn();
            const result = await manager.restoreFromRollbackPoint('decision-1', clearCacheCallback);

            expect(result.success).toBe(true);
            expect(result.restoredFiles).toContain('file1');
            expect(clearCacheCallback).toHaveBeenCalled();
            expect(result.logs).toContain('[ROLLBACK] ✅ Restauré: file1');
            expect(result.logs).toContain('[ROLLBACK] ✅ Intégrité vérifiée: file1 (100 bytes)');
        });

        it('should handle no rollback found', async () => {
            (existsSync as any).mockReturnValue(true);
            (fs.readdir as any).mockResolvedValue([]);

            const result = await manager.restoreFromRollbackPoint('decision-1', vi.fn());
            expect(result.success).toBe(false);
            expect(result.error).toContain('No rollback found');
            expect(result.logs).toContain('[ROLLBACK] ❌ Aucun rollback trouvé pour la décision decision-1');
        });

        it('should handle missing source file gracefully', async () => {
            (existsSync as any).mockImplementation((path: string) => {
                // Le fichier source n'existe PAS pour file1 (dans le backup)
                if (path.includes('decision-1_timestamp') && path.includes('file1')) return false;
                // Tout le reste existe
                return true;
            });
            (fs.readdir as any).mockResolvedValue(['decision-1_timestamp']);
            (fs.readFile as any).mockResolvedValue(JSON.stringify({ files: ['file1', 'file2'] }));
            (fs.copyFile as any).mockResolvedValue(undefined);
            (fs.access as any).mockResolvedValue(undefined);
            (fs.stat as any).mockResolvedValue({ size: 100 });
            (fs.unlink as any).mockResolvedValue(undefined);

            const clearCacheCallback = vi.fn();
            const result = await manager.restoreFromRollbackPoint('decision-1', clearCacheCallback);

            expect(result.success).toBe(true); // file2 est restauré avec succès
            expect(result.restoredFiles).not.toContain('file1');
            expect(result.restoredFiles).toContain('file2');
            expect(result.logs.some(log => log.includes('[ROLLBACK] ⚠️ Fichier source introuvable: file1'))).toBe(true);
        });

        it('should handle integrity check failure', async () => {
            // Mock existsSync pour retourner true pour tous les chemins nécessaires
            (existsSync as any).mockReturnValue(true);
            (fs.readdir as any).mockResolvedValue(['decision-1_timestamp']);
            (fs.readFile as any).mockResolvedValue(JSON.stringify({ files: ['file1'] }));
            (fs.copyFile as any).mockResolvedValue(undefined);
            (fs.access as any).mockResolvedValue(undefined);
            (fs.stat as any).mockRejectedValue(new Error('Stat failed'));
            (fs.unlink as any).mockResolvedValue(undefined);

            const clearCacheCallback = vi.fn();
            const result = await manager.restoreFromRollbackPoint('decision-1', clearCacheCallback);

            expect(result.success).toBe(false);
            expect(result.restoredFiles).not.toContain('file1');
            expect(result.logs.some(log => log.includes('[ROLLBACK] ❌ Erreur vérification intégrité: file1'))).toBe(true);
            expect(result.logs.some(log => log.includes('[ROLLBACK] 🔄 Backup restauré: file1'))).toBe(true);
        });

        it('should handle partial rollback success', async () => {
            // Mock existsSync pour retourner true pour tous les chemins nécessaires
            (existsSync as any).mockReturnValue(true);
            (fs.readdir as any).mockResolvedValue(['decision-1_timestamp']);
            (fs.readFile as any).mockResolvedValue(JSON.stringify({ files: ['file1', 'file2'] }));
            (fs.copyFile as any).mockResolvedValue(undefined);
            (fs.access as any).mockResolvedValue(undefined);
            (fs.stat as any).mockResolvedValue({ size: 100 });
            (fs.unlink as any).mockResolvedValue(undefined);

            const clearCacheCallback = vi.fn();
            const result = await manager.restoreFromRollbackPoint('decision-1', clearCacheCallback);

            expect(result.success).toBe(true);
            expect(result.restoredFiles).toContain('file1');
            expect(result.restoredFiles).toContain('file2');
            expect(result.logs).toContain('[ROLLBACK] ✅ Restauration terminée avec succès (2 fichier(s))');
        });

        it('should create backup before restoration', async () => {
            // Mock existsSync pour retourner true pour tous les chemins nécessaires
            (existsSync as any).mockReturnValue(true);
            (fs.readdir as any).mockResolvedValue(['decision-1_timestamp']);
            (fs.readFile as any).mockResolvedValue(JSON.stringify({ files: ['file1'] }));
            (fs.copyFile as any).mockResolvedValue(undefined);
            (fs.access as any).mockResolvedValue(undefined);
            (fs.stat as any).mockResolvedValue({ size: 100 });
            (fs.unlink as any).mockResolvedValue(undefined);

            const clearCacheCallback = vi.fn();
            const result = await manager.restoreFromRollbackPoint('decision-1', clearCacheCallback);

            expect(result.success).toBe(true);
            expect(result.logs).toContain('[ROLLBACK] ✅ Restauré: file1');
            expect(result.logs).toContain('[ROLLBACK] ✅ Intégrité vérifiée: file1 (100 bytes)');
        });
    });
});
