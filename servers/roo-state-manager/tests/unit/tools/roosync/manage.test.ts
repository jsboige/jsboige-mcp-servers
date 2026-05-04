/**
 * Tests for roosync_manage tool
 *
 * Covers: action routing, mark_read, archive, bulk_mark_read,
 * bulk_archive, cleanup, stats, error handling
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { roosyncManage, manageToolMetadata } from '../../../../src/tools/roosync/manage.js';

const {
    mockGetMessageManager,
    mockGetLocalMachineId,
    mockGetRooSyncService,
    mockParseMachineWorkspace,
    mockMarkAsRead,
    mockGetMessage,
    mockArchiveMessage,
    mockBulkOperation,
    mockGetInboxStats,
    mockCleanupExpiredMessages,
    mockSendExpiryReminders,
} = vi.hoisted(() => ({
    mockGetMessageManager: vi.fn(),
    mockGetLocalMachineId: vi.fn(() => 'myia-po-2025'),
    mockGetRooSyncService: vi.fn(),
    mockParseMachineWorkspace: vi.fn((id: string) => ({ machineId: id, workspaceId: 'roo-extensions' })),
    mockMarkAsRead: vi.fn(),
    mockGetMessage: vi.fn(),
    mockArchiveMessage: vi.fn(),
    mockBulkOperation: vi.fn(),
    mockGetInboxStats: vi.fn(),
    mockCleanupExpiredMessages: vi.fn(() => 0),
    mockSendExpiryReminders: vi.fn(() => 0),
}));

vi.mock('../../../../src/services/MessageManager.js', () => ({
    getMessageManager: mockGetMessageManager,
}));

vi.mock('../../../../src/utils/message-helpers.js', () => ({
    getLocalMachineId: mockGetLocalMachineId,
    parseMachineWorkspace: mockParseMachineWorkspace,
    formatDate: vi.fn((d: string) => d?.substring(0, 10) || ''),
    formatDateFull: vi.fn((d: string) => d || ''),
    getPriorityIcon: vi.fn((p: string) => ''),
    getStatusIcon: vi.fn((s: string) => ''),
    getLocalWorkspaceId: vi.fn(() => 'roo-extensions'),
}));

vi.mock('../../../../src/services/lazy-roosync.js', () => ({
    getRooSyncService: mockGetRooSyncService,
}));

vi.mock('../../../../src/tools/roosync/heartbeat-activity.js', () => ({
    recordRooSyncActivityAsync: vi.fn(),
}));

vi.mock('../../../../src/utils/logger.js', () => ({
    createLogger: () => ({
        info: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
    }),
}));

function setupMM() {
    const mm = {
        markAsRead: mockMarkAsRead,
        getMessage: mockGetMessage,
        archiveMessage: mockArchiveMessage,
        bulkOperation: mockBulkOperation,
        getInboxStats: mockGetInboxStats,
        cleanupExpiredMessages: mockCleanupExpiredMessages,
        sendExpiryReminders: mockSendExpiryReminders,
    };
    mockGetMessageManager.mockReturnValue(mm);

    mockGetRooSyncService.mockResolvedValue({
        getHeartbeatService: () => ({
            registerHeartbeat: vi.fn().mockResolvedValue(undefined),
        }),
    });

    return mm;
}

describe('roosync_manage', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setupMM();
    });

    describe('action=mark_read', () => {
        it('marks unread message as read', async () => {
            mockGetMessage.mockResolvedValue({
                id: 'msg-1', subject: 'Test', from: 'ai-01', to: 'po-2025',
                status: 'unread', timestamp: '2026-05-04T00:00:00.000Z',
            });
            const result = await roosyncManage({ action: 'mark_read', message_id: 'msg-1' });
            expect(result.content[0].text).toContain('marqué comme lu');
            expect(mockMarkAsRead).toHaveBeenCalledWith('msg-1', 'myia-po-2025');
        });

        it('returns not found for missing message', async () => {
            mockGetMessage.mockResolvedValue(null);
            const result = await roosyncManage({ action: 'mark_read', message_id: 'missing' });
            expect(result.content[0].text).toContain('introuvable');
        });

        it('returns already read for read message', async () => {
            mockGetMessage.mockResolvedValue({
                id: 'msg-1', subject: 'Test', from: 'ai-01', to: 'po-2025',
                status: 'read', timestamp: '2026-05-04T00:00:00.000Z',
            });
            const result = await roosyncManage({ action: 'mark_read', message_id: 'msg-1' });
            expect(result.content[0].text).toContain('déjà');
        });

        it('handles broadcast messages with per-machine tracking', async () => {
            mockGetMessage.mockResolvedValue({
                id: 'msg-bc', subject: 'Broadcast', from: 'ai-01', to: 'all',
                status: 'unread', timestamp: '2026-05-04T00:00:00.000Z',
                read_by: [],
            });
            const result = await roosyncManage({ action: 'mark_read', message_id: 'msg-bc' });
            expect(result.content[0].text).toContain('marqué comme lu');
        });

        it('handles already-read broadcast', async () => {
            mockGetMessage.mockResolvedValue({
                id: 'msg-bc', subject: 'Broadcast', from: 'ai-01', to: 'all',
                status: 'unread', timestamp: '2026-05-04T00:00:00.000Z',
                read_by: ['myia-po-2025'],
            });
            const result = await roosyncManage({ action: 'mark_read', message_id: 'msg-bc' });
            expect(result.content[0].text).toContain('déjà');
        });

        it('throws when message_id missing', async () => {
            const result = await roosyncManage({ action: 'mark_read' });
            // The top-level handler catches and returns error content
            expect(result.content[0].text).toContain('Erreur');
        });
    });

    describe('action=archive', () => {
        it('archives a read message', async () => {
            mockGetMessage.mockResolvedValue({
                id: 'msg-2', subject: 'Archive me', from: 'ai-01', to: 'po-2025',
                status: 'read', timestamp: '2026-05-04T00:00:00.000Z',
            });
            const result = await roosyncManage({ action: 'archive', message_id: 'msg-2' });
            expect(result.content[0].text).toContain('archivé');
            expect(mockArchiveMessage).toHaveBeenCalledWith('msg-2');
        });

        it('returns already archived for archived message', async () => {
            mockGetMessage.mockResolvedValue({
                id: 'msg-2', subject: 'Done', from: 'ai-01', to: 'po-2025',
                status: 'archived', timestamp: '2026-05-04T00:00:00.000Z',
            });
            const result = await roosyncManage({ action: 'archive', message_id: 'msg-2' });
            expect(result.content[0].text).toContain('déjà archivé');
        });

        it('returns not found for missing message', async () => {
            mockGetMessage.mockResolvedValue(null);
            const result = await roosyncManage({ action: 'archive', message_id: 'missing' });
            expect(result.content[0].text).toContain('introuvable');
        });

        it('throws when message_id missing', async () => {
            const result = await roosyncManage({ action: 'archive' });
            expect(result.content[0].text).toContain('Erreur');
        });
    });

    describe('action=bulk_mark_read', () => {
        it('calls bulk operation with filters', async () => {
            mockBulkOperation.mockResolvedValue({
                operation: 'mark_read', matched: 3, processed: 3, errors: 0, message_ids: ['a', 'b', 'c'], failed_ids: [],
            });
            const result = await roosyncManage({
                action: 'bulk_mark_read', from: 'test-machine', priority: 'LOW',
            });
            expect(result.content[0].text).toContain('3');
            expect(mockBulkOperation).toHaveBeenCalledWith(
                'myia-po-2025', 'mark_read',
                expect.objectContaining({ from: 'test-machine', priority: 'LOW', status: 'unread' })
            );
        });

        it('handles zero matches', async () => {
            mockBulkOperation.mockResolvedValue({
                operation: 'mark_read', matched: 0, processed: 0, errors: 0, message_ids: [], failed_ids: [],
            });
            const result = await roosyncManage({ action: 'bulk_mark_read' });
            expect(result.content[0].text).toContain('0');
        });
    });

    describe('action=bulk_archive', () => {
        it('calls bulk operation with archive operation', async () => {
            mockBulkOperation.mockResolvedValue({
                operation: 'archive', matched: 5, processed: 5, errors: 0, message_ids: ['x1', 'x2', 'x3', 'x4', 'x5'], failed_ids: [],
            });
            const result = await roosyncManage({
                action: 'bulk_archive', before_date: '2026-04-01T00:00:00Z',
            });
            expect(result.content[0].text).toContain('5');
            expect(mockBulkOperation).toHaveBeenCalledWith(
                'myia-po-2025', 'archive',
                expect.objectContaining({ before_date: '2026-04-01T00:00:00Z' })
            );
        });
    });

    describe('action=cleanup', () => {
        it('runs cleanup steps and returns stats', async () => {
            mockCleanupExpiredMessages.mockResolvedValue(2);
            mockSendExpiryReminders.mockResolvedValue(1);
            mockBulkOperation.mockResolvedValue({
                operation: 'mark_read', matched: 3, processed: 3, errors: 0, message_ids: [], failed_ids: [],
            });
            mockGetInboxStats.mockResolvedValue({
                total: 10, unread: 2, read: 8,
                by_priority: { LOW: 2, MEDIUM: 5, HIGH: 3 },
                by_sender: { 'ai-01': 8, 'po-2023': 2 },
            });
            const result = await roosyncManage({ action: 'cleanup' });
            const text = result.content[0].text;
            expect(text).toContain('Cleanup terminé');
            expect(mockCleanupExpiredMessages).toHaveBeenCalled();
            expect(mockSendExpiryReminders).toHaveBeenCalled();
        });

        it('handles empty cleanup', async () => {
            mockBulkOperation.mockResolvedValue({
                operation: 'mark_read', matched: 0, processed: 0, errors: 0, message_ids: [], failed_ids: [],
            });
            mockGetInboxStats.mockResolvedValue({
                total: 0, unread: 0, read: 0,
                by_priority: {}, by_sender: {},
            });
            const result = await roosyncManage({ action: 'cleanup' });
            expect(result.content[0].text).toContain('Aucune action nécessaire');
        });
    });

    describe('action=stats', () => {
        it('returns inbox statistics', async () => {
            mockGetInboxStats.mockResolvedValue({
                total: 15, unread: 3, read: 12,
                oldest_unread: '2026-05-01T00:00:00.000Z',
                by_priority: { LOW: 5, MEDIUM: 7, HIGH: 3 },
                by_sender: { 'ai-01': 10, 'po-2023': 5 },
            });
            const result = await roosyncManage({ action: 'stats' });
            const text = result.content[0].text;
            expect(text).toContain('Statistiques');
            expect(text).toContain('15');
        });
    });

    describe('action validation', () => {
        it('returns error for unknown action', async () => {
            const result = await roosyncManage({ action: 'unknown' as any });
            expect(result.content[0].text).toContain('Erreur');
        });

        it('returns error when no action', async () => {
            const result = await roosyncManage({ action: undefined as any });
            expect(result.content[0].text).toContain('Erreur');
        });
    });

    describe('error handling', () => {
        it('catches and formats exception', async () => {
            mockBulkOperation.mockRejectedValue(new Error('DB connection lost'));
            const result = await roosyncManage({ action: 'bulk_mark_read' });
            expect(result.content[0].text).toContain('Erreur');
            expect(result.content[0].text).toContain('DB connection lost');
        });
    });

    describe('metadata', () => {
        it('has correct tool metadata', () => {
            expect(manageToolMetadata.name).toBe('roosync_manage');
            expect(manageToolMetadata.inputSchema.required).toContain('action');
            expect(manageToolMetadata.inputSchema.properties.action.enum).toContain('cleanup');
            expect(manageToolMetadata.inputSchema.properties.action.enum).toContain('stats');
        });
    });
});
