/**
 * Tests for roosync_storage_management tool
 *
 * Covers: storage (detect/stats), maintenance (cache_rebuild/diagnose_bom/repair_bom),
 * validation, error handling, metadata
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { roosyncStorageManagement, storageManagementToolMetadata } from '../../../../src/tools/roosync/storage-management.js';

const {
    mockHandleStorageInfo,
    mockHandleMaintenance,
} = vi.hoisted(() => ({
    mockHandleStorageInfo: vi.fn(),
    mockHandleMaintenance: vi.fn(),
}));

vi.mock('../../../../src/tools/storage/storage-info.js', () => ({
    handleStorageInfo: mockHandleStorageInfo,
}));

vi.mock('../../../../src/tools/maintenance/maintenance.js', () => ({
    handleMaintenance: mockHandleMaintenance,
}));

vi.mock('../../../../src/services/roosync/HeartbeatService.js', () => ({
    HeartbeatServiceError: class extends Error {
        code: string;
        constructor(msg: string, code: string) {
            super(msg);
            this.code = code;
            this.name = 'HeartbeatServiceError';
        }
    },
}));

function makeStorageResult(data: Record<string, unknown>, isError = false) {
    return {
        content: [{ type: 'text' as const, text: JSON.stringify(data) }],
        isError,
    };
}

describe('roosync_storage_management', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('action=storage', () => {
        it('handles storageAction=detect', async () => {
            mockHandleStorageInfo.mockResolvedValue(
                makeStorageResult({ storagePath: '/tmp/shared', exists: true })
            );
            const result = await roosyncStorageManagement({
                action: 'storage', storageAction: 'detect',
            });
            expect(result.success).toBe(true);
            expect(result.action).toBe('storage');
            expect(result.subAction).toBe('detect');
            expect(result.data.storagePath).toBe('/tmp/shared');
        });

        it('handles storageAction=stats', async () => {
            mockHandleStorageInfo.mockResolvedValue(
                makeStorageResult({ totalFiles: 100, totalSize: 5000000 })
            );
            const result = await roosyncStorageManagement({
                action: 'storage', storageAction: 'stats',
            });
            expect(result.success).toBe(true);
            expect(result.subAction).toBe('stats');
        });

        it('throws when storageAction missing', async () => {
            await expect(roosyncStorageManagement({ action: 'storage' } as any))
                .rejects.toThrow('storageAction requis');
        });

        it('handles error from handleStorageInfo', async () => {
            mockHandleStorageInfo.mockResolvedValue(
                makeStorageResult({ error: 'Not found' }, true)
            );
            const result = await roosyncStorageManagement({
                action: 'storage', storageAction: 'detect',
            });
            expect(result.success).toBe(false);
            expect(result.message).toContain('Erreur');
        });
    });

    describe('action=maintenance', () => {
        it('handles maintenanceAction=cache_rebuild', async () => {
            mockHandleMaintenance.mockResolvedValue(
                makeStorageResult({ rebuiltCount: 50 })
            );
            const cache = new Map();
            const result = await roosyncStorageManagement(
                { action: 'maintenance', maintenanceAction: 'cache_rebuild' },
                cache, {} as any
            );
            expect(result.success).toBe(true);
            expect(result.subAction).toBe('cache_rebuild');
            expect(mockHandleMaintenance).toHaveBeenCalledWith(
                expect.objectContaining({ action: 'cache_rebuild' }),
                cache, expect.anything()
            );
        });

        it('handles maintenanceAction=diagnose_bom', async () => {
            mockHandleMaintenance.mockResolvedValue(
                makeStorageResult({ corruptedFiles: 3 })
            );
            const result = await roosyncStorageManagement(
                { action: 'maintenance', maintenanceAction: 'diagnose_bom', fix_found: true },
                new Map(), {} as any
            );
            expect(result.success).toBe(true);
            expect(mockHandleMaintenance).toHaveBeenCalledWith(
                expect.objectContaining({ action: 'diagnose_bom', fix_found: true }),
                expect.any(Map), expect.anything()
            );
        });

        it('handles maintenanceAction=repair_bom with dry_run', async () => {
            mockHandleMaintenance.mockResolvedValue(
                makeStorageResult({ repairedFiles: 2 })
            );
            const result = await roosyncStorageManagement(
                { action: 'maintenance', maintenanceAction: 'repair_bom', dry_run: true },
                new Map(), {} as any
            );
            expect(result.success).toBe(true);
            expect(mockHandleMaintenance).toHaveBeenCalledWith(
                expect.objectContaining({ action: 'repair_bom', dry_run: true }),
                expect.any(Map), expect.anything()
            );
        });

        it('throws when maintenanceAction missing', async () => {
            await expect(roosyncStorageManagement(
                { action: 'maintenance' } as any, new Map(), {} as any
            )).rejects.toThrow('maintenanceAction requis');
        });

        it('throws when conversationCache missing', async () => {
            await expect(roosyncStorageManagement(
                { action: 'maintenance', maintenanceAction: 'cache_rebuild' }
            )).rejects.toThrow('conversationCache requis');
        });
    });

    describe('error handling', () => {
        it('wraps unexpected errors in HeartbeatServiceError', async () => {
            mockHandleStorageInfo.mockRejectedValue(new Error('Disk failure'));
            await expect(roosyncStorageManagement({
                action: 'storage', storageAction: 'detect',
            })).rejects.toThrow('Disk failure');
        });

        it('re-throws HeartbeatServiceError as-is', async () => {
            const { HeartbeatServiceError } = await import('../../../../src/services/roosync/HeartbeatService.js');
            mockHandleStorageInfo.mockRejectedValue(new HeartbeatServiceError('Custom', 'CUSTOM'));
            await expect(roosyncStorageManagement({
                action: 'storage', storageAction: 'detect',
            })).rejects.toThrow('Custom');
        });
    });

    describe('timestamp', () => {
        it('includes ISO timestamp', async () => {
            mockHandleStorageInfo.mockResolvedValue(
                makeStorageResult({})
            );
            const result = await roosyncStorageManagement({
                action: 'storage', storageAction: 'detect',
            });
            expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        });
    });

    describe('metadata', () => {
        it('has correct tool metadata', () => {
            expect(storageManagementToolMetadata.name).toBe('roosync_storage_management');
            expect(storageManagementToolMetadata.inputSchema.required).toContain('action');
            expect(storageManagementToolMetadata.inputSchema.properties.action.enum).toContain('storage');
            expect(storageManagementToolMetadata.inputSchema.properties.action.enum).toContain('maintenance');
        });
    });
});
