/**
 * Tests unitaires pour roosync_storage_management
 *
 * CONS-#443 Groupe 4 : Consolidation de storage_info + maintenance
 * Couvre toutes les actions de l'outil consolidé :
 * - action: 'storage' (detect, stats)
 * - action: 'maintenance' (cache_rebuild, diagnose_bom, repair_bom)
 *
 * Framework: Vitest
 * Coverage cible: >80%
 *
 * @module roosync/storage-management.test
 * @version 1.0.0 (CONS-#443 Groupe 4)
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { roosyncStorageManagement, type StorageManagementArgs } from '../storage-management.js';
import { HeartbeatServiceError } from '../../../services/roosync/HeartbeatService.js';
import * as storageInfoModule from '../../storage/storage-info.js';
import * as maintenanceModule from '../../maintenance/maintenance.js';

// Mock des modules
vi.mock('../../storage/storage-info.js');
vi.mock('../../maintenance/maintenance.js');

describe('roosyncStorageManagement', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    // ============================================================
    // Tests pour action: 'storage' - storageAction: 'detect'
    // ============================================================

    describe('action: storage - storageAction: detect', () => {
        test('should detect storage successfully', async () => {
            const mockDetectResult = {
                tasksDir: 'C:\\Users\\Test\\AppData\\Roaming\\Code\\User\\globalStorage\\rooveterinaryinc.roo-cline\\tasks',
                exists: true,
                taskCount: 42
            };

            vi.mocked(storageInfoModule.handleStorageInfo).mockResolvedValue({
                content: [{ type: 'text', text: JSON.stringify(mockDetectResult) }]
            });

            const result = await roosyncStorageManagement({
                action: 'storage',
                storageAction: 'detect'
            });

            expect(result.success).toBe(true);
            expect(result.action).toBe('storage');
            expect(result.subAction).toBe('detect');
            expect(result.message).toContain('Inspection du stockage réussie');
            expect(result.data).toEqual(mockDetectResult);
            expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
        });

        test('should handle storage detection error', async () => {
            vi.mocked(storageInfoModule.handleStorageInfo).mockResolvedValue({
                content: [{ type: 'text', text: 'Storage not found' }],
                isError: true
            });

            const result = await roosyncStorageManagement({
                action: 'storage',
                storageAction: 'detect'
            });

            expect(result.success).toBe(false);
            expect(result.message).toContain('Erreur lors de l\'inspection');
        });
    });

    // ============================================================
    // Tests pour action: 'storage' - storageAction: 'stats'
    // ============================================================

    describe('action: storage - storageAction: stats', () => {
        test('should get storage stats successfully', async () => {
            const mockStatsResult = {
                totalConversations: 150,
                totalSize: '2.5 GB',
                workspaceBreakdown: {
                    'workspace1': 50,
                    'workspace2': 100
                },
                totalWorkspaces: 2
            };

            vi.mocked(storageInfoModule.handleStorageInfo).mockResolvedValue({
                content: [{ type: 'text', text: JSON.stringify(mockStatsResult) }]
            });

            const result = await roosyncStorageManagement({
                action: 'storage',
                storageAction: 'stats'
            });

            expect(result.success).toBe(true);
            expect(result.action).toBe('storage');
            expect(result.subAction).toBe('stats');
            expect(result.data).toEqual(mockStatsResult);
            expect(result.data.totalWorkspaces).toBe(2);
        });

        test('should handle non-JSON response gracefully', async () => {
            vi.mocked(storageInfoModule.handleStorageInfo).mockResolvedValue({
                content: [{ type: 'text', text: 'Plain text stats output' }]
            });

            const result = await roosyncStorageManagement({
                action: 'storage',
                storageAction: 'stats'
            });

            expect(result.success).toBe(true);
            expect(result.data).toBe('Plain text stats output');
        });
    });

    // ============================================================
    // Tests pour action: 'storage' - validation
    // ============================================================

    describe('action: storage - validation', () => {
        test('should throw error when storageAction is missing', async () => {
            const args: StorageManagementArgs = {
                action: 'storage'
                // no storageAction
            };

            await expect(roosyncStorageManagement(args)).rejects.toThrow(HeartbeatServiceError);
            await expect(roosyncStorageManagement(args)).rejects.toThrow('storageAction requis');
        });
    });

    // ============================================================
    // Tests pour action: 'maintenance' - maintenanceAction: 'cache_rebuild'
    // ============================================================

    describe('action: maintenance - maintenanceAction: cache_rebuild', () => {
        test('should rebuild cache successfully', async () => {
            const mockCacheResult = {
                rebuilt: true,
                tasksProcessed: 42,
                duration: '5.2s'
            };

            vi.mocked(maintenanceModule.handleMaintenance).mockResolvedValue({
                content: [{ type: 'text', text: JSON.stringify(mockCacheResult) }]
            });

            const conversationCache = new Map();

            const result = await roosyncStorageManagement(
                {
                    action: 'maintenance',
                    maintenanceAction: 'cache_rebuild',
                    force_rebuild: true
                },
                conversationCache
            );

            expect(result.success).toBe(true);
            expect(result.action).toBe('maintenance');
            expect(result.subAction).toBe('cache_rebuild');
            expect(result.message).toContain('Maintenance réussie');
            expect(result.data).toEqual(mockCacheResult);
        });

        test('should rebuild cache with workspace filter', async () => {
            const mockCacheResult = {
                rebuilt: true,
                tasksProcessed: 10,
                workspace: 'my-workspace'
            };

            vi.mocked(maintenanceModule.handleMaintenance).mockResolvedValue({
                content: [{ type: 'text', text: JSON.stringify(mockCacheResult) }]
            });

            const conversationCache = new Map();

            const result = await roosyncStorageManagement(
                {
                    action: 'maintenance',
                    maintenanceAction: 'cache_rebuild',
                    workspace_filter: 'my-workspace'
                },
                conversationCache
            );

            expect(result.success).toBe(true);
            expect(vi.mocked(maintenanceModule.handleMaintenance)).toHaveBeenCalledWith(
                expect.objectContaining({
                    action: 'cache_rebuild',
                    workspace_filter: 'my-workspace'
                }),
                conversationCache,
                undefined
            );
        });

        test('should rebuild cache with specific task IDs', async () => {
            const mockCacheResult = {
                rebuilt: true,
                tasksProcessed: 3
            };

            vi.mocked(maintenanceModule.handleMaintenance).mockResolvedValue({
                content: [{ type: 'text', text: JSON.stringify(mockCacheResult) }]
            });

            const conversationCache = new Map();

            const result = await roosyncStorageManagement(
                {
                    action: 'maintenance',
                    maintenanceAction: 'cache_rebuild',
                    task_ids: ['task1', 'task2', 'task3']
                },
                conversationCache
            );

            expect(result.success).toBe(true);
            expect(vi.mocked(maintenanceModule.handleMaintenance)).toHaveBeenCalledWith(
                expect.objectContaining({
                    task_ids: ['task1', 'task2', 'task3']
                }),
                conversationCache,
                undefined
            );
        });
    });

    // ============================================================
    // Tests pour action: 'maintenance' - maintenanceAction: 'diagnose_bom'
    // ============================================================

    describe('action: maintenance - maintenanceAction: diagnose_bom', () => {
        test('should diagnose BOM issues successfully', async () => {
            const mockDiagnoseResult = {
                filesWithBOM: 5,
                files: ['file1.json', 'file2.json'],
                autoFixed: false
            };

            vi.mocked(maintenanceModule.handleMaintenance).mockResolvedValue({
                content: [{ type: 'text', text: JSON.stringify(mockDiagnoseResult) }]
            });

            const conversationCache = new Map();

            const result = await roosyncStorageManagement(
                {
                    action: 'maintenance',
                    maintenanceAction: 'diagnose_bom'
                },
                conversationCache
            );

            expect(result.success).toBe(true);
            expect(result.subAction).toBe('diagnose_bom');
            expect(result.data.filesWithBOM).toBe(5);
        });

        test('should diagnose and fix BOM issues when fix_found=true', async () => {
            const mockDiagnoseResult = {
                filesWithBOM: 3,
                files: ['file1.json'],
                autoFixed: true
            };

            vi.mocked(maintenanceModule.handleMaintenance).mockResolvedValue({
                content: [{ type: 'text', text: JSON.stringify(mockDiagnoseResult) }]
            });

            const conversationCache = new Map();

            const result = await roosyncStorageManagement(
                {
                    action: 'maintenance',
                    maintenanceAction: 'diagnose_bom',
                    fix_found: true
                },
                conversationCache
            );

            expect(result.success).toBe(true);
            expect(result.data.autoFixed).toBe(true);
            expect(vi.mocked(maintenanceModule.handleMaintenance)).toHaveBeenCalledWith(
                expect.objectContaining({
                    fix_found: true
                }),
                conversationCache,
                undefined
            );
        });
    });

    // ============================================================
    // Tests pour action: 'maintenance' - maintenanceAction: 'repair_bom'
    // ============================================================

    describe('action: maintenance - maintenanceAction: repair_bom', () => {
        test('should repair BOM issues successfully', async () => {
            const mockRepairResult = {
                filesRepaired: 5,
                success: true
            };

            vi.mocked(maintenanceModule.handleMaintenance).mockResolvedValue({
                content: [{ type: 'text', text: JSON.stringify(mockRepairResult) }]
            });

            const conversationCache = new Map();

            const result = await roosyncStorageManagement(
                {
                    action: 'maintenance',
                    maintenanceAction: 'repair_bom'
                },
                conversationCache
            );

            expect(result.success).toBe(true);
            expect(result.subAction).toBe('repair_bom');
            expect(result.data.filesRepaired).toBe(5);
        });

        test('should simulate repair with dry_run=true', async () => {
            const mockRepairResult = {
                filesRepaired: 0,
                filesWouldBeRepaired: 5,
                dryRun: true
            };

            vi.mocked(maintenanceModule.handleMaintenance).mockResolvedValue({
                content: [{ type: 'text', text: JSON.stringify(mockRepairResult) }]
            });

            const conversationCache = new Map();

            const result = await roosyncStorageManagement(
                {
                    action: 'maintenance',
                    maintenanceAction: 'repair_bom',
                    dry_run: true
                },
                conversationCache
            );

            expect(result.success).toBe(true);
            expect(result.data.dryRun).toBe(true);
            expect(vi.mocked(maintenanceModule.handleMaintenance)).toHaveBeenCalledWith(
                expect.objectContaining({
                    dry_run: true
                }),
                conversationCache,
                undefined
            );
        });
    });

    // ============================================================
    // Tests pour action: 'maintenance' - validation
    // ============================================================

    describe('action: maintenance - validation', () => {
        test('should throw error when maintenanceAction is missing', async () => {
            const conversationCache = new Map();

            const args: StorageManagementArgs = {
                action: 'maintenance'
                // no maintenanceAction
            };

            await expect(roosyncStorageManagement(args, conversationCache)).rejects.toThrow(HeartbeatServiceError);
            await expect(roosyncStorageManagement(args, conversationCache)).rejects.toThrow('maintenanceAction requis');
        });

        test('should throw error when conversationCache is missing', async () => {
            const args: StorageManagementArgs = {
                action: 'maintenance',
                maintenanceAction: 'cache_rebuild'
            };

            await expect(roosyncStorageManagement(args)).rejects.toThrow(HeartbeatServiceError);
            await expect(roosyncStorageManagement(args)).rejects.toThrow('conversationCache requis');
        });
    });

    // ============================================================
    // Tests pour gestion des erreurs
    // ============================================================

    describe('error handling', () => {
        test('should throw error for unknown action', async () => {
            const args: any = {
                action: 'unknown'
            };

            await expect(roosyncStorageManagement(args)).rejects.toThrow('non reconnue');
        });

        test('should wrap non-HeartbeatServiceError errors', async () => {
            vi.mocked(storageInfoModule.handleStorageInfo).mockImplementation(() => {
                throw new Error('Internal error');
            });

            const args: StorageManagementArgs = {
                action: 'storage',
                storageAction: 'detect'
            };

            await expect(roosyncStorageManagement(args)).rejects.toThrow(HeartbeatServiceError);
            await expect(roosyncStorageManagement(args)).rejects.toThrow('Erreur lors de l\'opération de gestion du stockage');
        });

        test('should preserve HeartbeatServiceError when thrown', async () => {
            const originalError = new HeartbeatServiceError('Test error', 'TEST_ERROR');

            vi.mocked(storageInfoModule.handleStorageInfo).mockImplementation(() => {
                throw originalError;
            });

            const args: StorageManagementArgs = {
                action: 'storage',
                storageAction: 'detect'
            };

            await expect(roosyncStorageManagement(args)).rejects.toThrow(originalError);
        });

        test('should handle maintenance error gracefully', async () => {
            vi.mocked(maintenanceModule.handleMaintenance).mockResolvedValue({
                content: [{ type: 'text', text: 'Maintenance failed' }],
                isError: true
            });

            const conversationCache = new Map();

            const result = await roosyncStorageManagement(
                {
                    action: 'maintenance',
                    maintenanceAction: 'cache_rebuild'
                },
                conversationCache
            );

            expect(result.success).toBe(false);
            expect(result.message).toContain('Erreur lors de la maintenance');
        });
    });

    // ============================================================
    // Tests pour résultats et format de sortie
    // ============================================================

    describe('output format', () => {
        test('should return complete result structure', async () => {
            vi.mocked(storageInfoModule.handleStorageInfo).mockResolvedValue({
                content: [{ type: 'text', text: '{}' }]
            });

            const result = await roosyncStorageManagement({
                action: 'storage',
                storageAction: 'detect'
            });

            // Vérifier toutes les propriétés requises
            expect(result).toHaveProperty('success');
            expect(result).toHaveProperty('action');
            expect(result).toHaveProperty('timestamp');
            expect(result).toHaveProperty('message');

            // Vérifier le format ISO 8601 du timestamp
            expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        });

        test('should include subAction for all operations', async () => {
            vi.mocked(storageInfoModule.handleStorageInfo).mockResolvedValue({
                content: [{ type: 'text', text: '{}' }]
            });

            const result = await roosyncStorageManagement({
                action: 'storage',
                storageAction: 'stats'
            });

            expect(result.subAction).toBe('stats');
        });

        test('should include data when available', async () => {
            const mockData = { test: 'value' };

            vi.mocked(maintenanceModule.handleMaintenance).mockResolvedValue({
                content: [{ type: 'text', text: JSON.stringify(mockData) }]
            });

            const conversationCache = new Map();

            const result = await roosyncStorageManagement(
                {
                    action: 'maintenance',
                    maintenanceAction: 'cache_rebuild'
                },
                conversationCache
            );

            expect(result.data).toEqual(mockData);
        });
    });

    // ============================================================
    // Tests d'intégration (vérification des appels)
    // ============================================================

    describe('integration with underlying tools', () => {
        test('should call handleStorageInfo with correct arguments', async () => {
            vi.mocked(storageInfoModule.handleStorageInfo).mockResolvedValue({
                content: [{ type: 'text', text: '{}' }]
            });

            await roosyncStorageManagement({
                action: 'storage',
                storageAction: 'detect'
            });

            expect(storageInfoModule.handleStorageInfo).toHaveBeenCalledWith({
                action: 'detect'
            });
        });

        test('should call handleMaintenance with all parameters', async () => {
            vi.mocked(maintenanceModule.handleMaintenance).mockResolvedValue({
                content: [{ type: 'text', text: '{}' }]
            });

            const conversationCache = new Map();
            const state: any = { some: 'state' };

            await roosyncStorageManagement(
                {
                    action: 'maintenance',
                    maintenanceAction: 'cache_rebuild',
                    force_rebuild: true,
                    workspace_filter: 'test-workspace',
                    task_ids: ['id1', 'id2']
                },
                conversationCache,
                state
            );

            expect(maintenanceModule.handleMaintenance).toHaveBeenCalledWith(
                {
                    action: 'cache_rebuild',
                    force_rebuild: true,
                    workspace_filter: 'test-workspace',
                    task_ids: ['id1', 'id2'],
                    fix_found: undefined,
                    dry_run: undefined
                },
                conversationCache,
                state
            );
        });
    });
});
