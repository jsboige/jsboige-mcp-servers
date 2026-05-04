/**
 * Tests for roosync_read tool
 *
 * Covers: inbox mode, message mode, attachments mode,
 * validation, error handling, pagination, auto-destruct
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { roosyncRead, readToolMetadata } from '../../../../src/tools/roosync/read.js';

const {
    mockGetMessageManager,
    mockGetLocalMachineId,
    mockGetLocalWorkspaceId,
    mockGetRooSyncService,
    mockGetSharedStatePath,
    mockReadInbox,
    mockGetFilteredCount,
    mockGetMessage,
    mockMarkAsRead,
    mockAutoArchiveOld,
    mockCleanupExpiredMessages,
    mockSendExpiryReminders,
    mockRegisterHeartbeat,
    mockListAttachments,
    mockRecordActivity,
} = vi.hoisted(() => ({
    mockGetMessageManager: vi.fn(),
    mockGetLocalMachineId: vi.fn(() => 'myia-po-2025'),
    mockGetLocalWorkspaceId: vi.fn(() => 'roo-extensions'),
    mockGetRooSyncService: vi.fn(),
    mockGetSharedStatePath: vi.fn(() => '/tmp/shared'),
    mockReadInbox: vi.fn(),
    mockGetFilteredCount: vi.fn(),
    mockGetMessage: vi.fn(),
    mockMarkAsRead: vi.fn(),
    mockAutoArchiveOld: vi.fn(() => Promise.resolve(0)),
    mockCleanupExpiredMessages: vi.fn(() => Promise.resolve(0)),
    mockSendExpiryReminders: vi.fn(() => Promise.resolve(0)),
    mockRegisterHeartbeat: vi.fn(() => Promise.resolve()),
    mockListAttachments: vi.fn(),
    mockRecordActivity: vi.fn(),
}));

vi.mock('../../../../src/services/MessageManager.js', () => ({
    getMessageManager: mockGetMessageManager,
    MessageManagerError: class extends Error {
        code: string;
        constructor(msg: string, code: string) {
            super(msg);
            this.code = code;
            this.name = 'MessageManagerError';
        }
    },
    MessageManagerErrorCode: { INVALID_MESSAGE_FORMAT: 'INVALID_MESSAGE_FORMAT' },
}));

vi.mock('../../../../src/utils/message-helpers.js', () => ({
    getLocalMachineId: mockGetLocalMachineId,
    getLocalWorkspaceId: mockGetLocalWorkspaceId,
    formatDate: vi.fn((d: string) => d?.substring(0, 10) || ''),
    formatDateFull: vi.fn((d: string) => d || ''),
    getPriorityIcon: vi.fn((p: string) => ''),
    getStatusIcon: vi.fn((s: string) => ''),
}));

vi.mock('../../../../src/services/lazy-roosync.js', () => ({
    getRooSyncService: mockGetRooSyncService,
}));

vi.mock('../../../../src/utils/shared-state-path.js', () => ({
    getSharedStatePath: mockGetSharedStatePath,
}));

vi.mock('../../../../src/tools/roosync/heartbeat-activity.js', () => ({
    recordRooSyncActivityAsync: mockRecordActivity,
}));

vi.mock('../../../../src/utils/logger.js', () => ({
    createLogger: () => ({
        info: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
    }),
}));

vi.mock('../../../../src/services/roosync/AttachmentManager.js', () => ({
    AttachmentManager: class {
        listAttachments = mockListAttachments;
    },
}));

function setupMM() {
    const mm = {
        readInbox: mockReadInbox,
        getFilteredCount: mockGetFilteredCount,
        getMessage: mockGetMessage,
        markAsRead: mockMarkAsRead,
        autoArchiveOld: mockAutoArchiveOld,
        cleanupExpiredMessages: mockCleanupExpiredMessages,
        sendExpiryReminders: mockSendExpiryReminders,
    };
    mockGetMessageManager.mockReturnValue(mm);

    mockGetRooSyncService.mockResolvedValue({
        getHeartbeatService: () => ({
            registerHeartbeat: mockRegisterHeartbeat,
        }),
    });

    return mm;
}

describe('roosync_read', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setupMM();
    });

    describe('mode=inbox', () => {
        it('returns empty inbox message when no messages', async () => {
            mockGetFilteredCount.mockResolvedValue({ total: 0, unread: 0, read: 0 });
            mockReadInbox.mockResolvedValue([]);
            const result = await roosyncRead({ mode: 'inbox' });
            expect(result.content[0].text).toContain('Aucun message');
            expect(result.content[0].text).toContain('myia-po-2025');
        });

        it('returns formatted inbox with messages', async () => {
            mockGetFilteredCount.mockResolvedValue({ total: 5, unread: 2, read: 3 });
            mockReadInbox.mockResolvedValue([
                { id: 'msg-1', from: 'ai-01', subject: 'Test message', priority: 'MEDIUM', status: 'unread', timestamp: '2026-05-04T00:00:00.000Z', preview: 'Hello...' },
                { id: 'msg-2', from: 'po-2023', subject: 'Another message', priority: 'HIGH', status: 'read', timestamp: '2026-05-03T00:00:00.000Z', preview: 'World...' },
            ]);
            const result = await roosyncRead({ mode: 'inbox' });
            const text = result.content[0].text;
            expect(text).toContain('msg-1');
            expect(text).toContain('5');
            expect(text).toContain('Aperçu');
        });

        it('filters by status', async () => {
            mockGetFilteredCount.mockResolvedValue({ total: 2, unread: 2, read: 0 });
            mockReadInbox.mockResolvedValue([]);
            await roosyncRead({ mode: 'inbox', status: 'unread' });
            expect(mockReadInbox).toHaveBeenCalledWith(
                'myia-po-2025', 'unread', undefined, 'roo-extensions', undefined, undefined
            );
        });

        it('passes limit parameter', async () => {
            mockGetFilteredCount.mockResolvedValue({ total: 10, unread: 5, read: 5 });
            mockReadInbox.mockResolvedValue([]);
            await roosyncRead({ mode: 'inbox', limit: 5 });
            expect(mockReadInbox).toHaveBeenCalledWith(
                'myia-po-2025', 'all', 5, 'roo-extensions', undefined, undefined
            );
        });

        it('passes pagination parameters', async () => {
            mockGetFilteredCount.mockResolvedValue({ total: 50, unread: 10, read: 40 });
            mockReadInbox.mockResolvedValue([]);
            await roosyncRead({ mode: 'inbox', page: 2, per_page: 20 });
            expect(mockReadInbox).toHaveBeenCalledWith(
                'myia-po-2025', 'all', undefined, 'roo-extensions', 2, 20
            );
            const result = await roosyncRead({ mode: 'inbox', page: 2, per_page: 20 });
            expect(result.content[0].text).toContain('Page');
        });

        it('overrides machine with to_machine', async () => {
            mockGetFilteredCount.mockResolvedValue({ total: 0, unread: 0, read: 0 });
            mockReadInbox.mockResolvedValue([]);
            await roosyncRead({ mode: 'inbox', to_machine: 'myia-ai-01' });
            expect(mockReadInbox).toHaveBeenCalledWith(
                'myia-ai-01', expect.any(String), undefined, 'roo-extensions', undefined, undefined
            );
        });

        it('overrides workspace with workspace param', async () => {
            mockGetFilteredCount.mockResolvedValue({ total: 0, unread: 0, read: 0 });
            mockReadInbox.mockResolvedValue([]);
            await roosyncRead({ mode: 'inbox', workspace: 'other-workspace' });
            expect(mockReadInbox).toHaveBeenCalledWith(
                'myia-po-2025', expect.any(String), undefined, 'other-workspace', undefined, undefined
            );
        });

        it('registers heartbeat on inbox read', async () => {
            mockGetFilteredCount.mockResolvedValue({ total: 0, unread: 0, read: 0 });
            mockReadInbox.mockResolvedValue([]);
            await roosyncRead({ mode: 'inbox' });
            // heartbeat is fire-and-forget, so we wait a tick
            await new Promise(r => setTimeout(r, 10));
            expect(mockRegisterHeartbeat).toHaveBeenCalledWith('myia-po-2025', expect.objectContaining({ lastActivity: 'roosync_read_inbox' }));
        });

        it('shows auto-destruct indicator', async () => {
            mockGetFilteredCount.mockResolvedValue({ total: 1, unread: 1, read: 0 });
            mockReadInbox.mockResolvedValue([
                { id: 'msg-ad', from: 'ai-01', subject: 'Auto destruct msg', priority: 'LOW', status: 'unread', timestamp: '2026-05-04T00:00:00.000Z', preview: 'test', auto_destruct: true },
            ]);
            const result = await roosyncRead({ mode: 'inbox' });
            expect(result.content[0].text).toContain('⏳');
        });

        it('shows empty filter message when filter yields no results but total > 0', async () => {
            mockGetFilteredCount.mockResolvedValue({ total: 5, unread: 0, read: 5 });
            mockReadInbox.mockResolvedValue([]);
            const result = await roosyncRead({ mode: 'inbox', status: 'unread' });
            expect(result.content[0].text).toContain('Aucun message pour le filtre');
        });
    });

    describe('mode=message', () => {
        it('returns message details', async () => {
            mockGetMessage.mockResolvedValue({
                id: 'msg-1', from: 'ai-01', to: 'po-2025', subject: 'Test', priority: 'HIGH',
                status: 'unread', timestamp: '2026-05-04T00:00:00.000Z', body: 'Hello world',
                tags: ['TASK'], thread_id: 'thread-1', reply_to: 'msg-0',
            });
            const result = await roosyncRead({ mode: 'message', message_id: 'msg-1' });
            const text = result.content[0].text;
            expect(text).toContain('Hello world');
            expect(text).toContain('TASK');
            expect(text).toContain('thread-1');
            expect(text).toContain('msg-0');
        });

        it('returns not found for missing message', async () => {
            mockGetMessage.mockResolvedValue(null);
            const result = await roosyncRead({ mode: 'message', message_id: 'missing' });
            expect(result.content[0].text).toContain('introuvable');
        });

        it('marks message as read when mark_as_read=true', async () => {
            mockGetMessage.mockResolvedValue({
                id: 'msg-2', from: 'ai-01', to: 'po-2025', subject: 'Read me', priority: 'MEDIUM',
                status: 'unread', timestamp: '2026-05-04T00:00:00.000Z', body: 'Content',
            });
            const result = await roosyncRead({ mode: 'message', message_id: 'msg-2', mark_as_read: true });
            expect(mockMarkAsRead).toHaveBeenCalledWith('msg-2', 'myia-po-2025');
            expect(result.content[0].text).toContain('READ');
        });

        it('does not mark read when already read', async () => {
            mockGetMessage.mockResolvedValue({
                id: 'msg-3', from: 'ai-01', to: 'po-2025', subject: 'Already read', priority: 'LOW',
                status: 'read', timestamp: '2026-05-04T00:00:00.000Z', body: 'Content',
            });
            await roosyncRead({ mode: 'message', message_id: 'msg-3', mark_as_read: true });
            expect(mockMarkAsRead).not.toHaveBeenCalled();
        });

        it('shows auto-destruct info', async () => {
            mockGetMessage.mockResolvedValue({
                id: 'msg-ad', from: 'ai-01', to: 'po-2025', subject: 'Destruct', priority: 'MEDIUM',
                status: 'unread', timestamp: '2026-05-04T00:00:00.000Z', body: 'Secret',
                auto_destruct: true, expires_at: '2099-01-01T00:00:00.000Z',
            });
            const result = await roosyncRead({ mode: 'message', message_id: 'msg-ad' });
            expect(result.content[0].text).toContain('Auto-destruct');
            expect(result.content[0].text).toContain('Expiration');
        });

        it('shows destroyed placeholder', async () => {
            mockGetMessage.mockResolvedValue({
                id: 'msg-dest', from: 'ai-01', to: 'po-2025', subject: 'Destroyed', priority: 'MEDIUM',
                status: 'read', timestamp: '2026-05-04T00:00:00.000Z', body: 'Old content',
                destroyed_at: '2026-05-04T12:00:00.000Z', destroyed_reason: 'auto-destruct',
            });
            const result = await roosyncRead({ mode: 'message', message_id: 'msg-dest' });
            expect(result.content[0].text).toContain('détruit');
            expect(result.content[0].text).not.toContain('Old content');
        });

        it('shows read_by tracking', async () => {
            mockGetMessage.mockResolvedValue({
                id: 'msg-rb', from: 'ai-01', to: 'all', subject: 'Broadcast', priority: 'LOW',
                status: 'read', timestamp: '2026-05-04T00:00:00.000Z', body: 'Content',
                read_by: ['po-2025', 'po-2023'],
                acknowledged_at: { 'po-2025': '2026-05-04T01:00:00.000Z' },
            });
            const result = await roosyncRead({ mode: 'message', message_id: 'msg-rb' });
            expect(result.content[0].text).toContain('Lu par');
            expect(result.content[0].text).toContain('po-2025');
            expect(result.content[0].text).toContain('po-2023');
        });
    });

    describe('mode=attachments', () => {
        it('returns empty when no attachments', async () => {
            mockListAttachments.mockResolvedValue([]);
            const result = await roosyncRead({ mode: 'attachments', message_id: 'msg-1' });
            expect(result.content[0].text).toContain('pièce jointe');
        });

        it('returns formatted attachment list', async () => {
            mockListAttachments.mockResolvedValue([
                { uuid: 'att-1', originalName: 'report.md', mimeType: 'text/markdown', sizeBytes: 2048, uploadedAt: '2026-05-04T00:00:00.000Z', uploaderMachineId: 'ai-01' },
                { uuid: 'att-2', originalName: 'data.json', mimeType: 'application/json', sizeBytes: 1536000, uploadedAt: '2026-05-04T00:00:00.000Z', uploaderMachineId: 'po-2023' },
            ]);
            const result = await roosyncRead({ mode: 'attachments', message_id: 'msg-1' });
            const text = result.content[0].text;
            expect(text).toContain('att-1');
            expect(text).toContain('report.md');
            expect(text).toContain('2');
            expect(text).toContain('1.5 MB');
            expect(mockGetSharedStatePath).toHaveBeenCalled();
        });

        it('shows small file sizes in bytes', async () => {
            mockListAttachments.mockResolvedValue([
                { uuid: 'att-sm', originalName: 'tiny.txt', mimeType: 'text/plain', sizeBytes: 512, uploadedAt: '2026-05-04T00:00:00.000Z', uploaderMachineId: 'ai-01' },
            ]);
            const result = await roosyncRead({ mode: 'attachments', message_id: 'msg-1' });
            expect(result.content[0].text).toContain('512 B');
        });
    });

    describe('validation', () => {
        it('returns error when mode is missing', async () => {
            const result = await roosyncRead({ mode: undefined as any });
            expect(result.content[0].text).toContain('Erreur');
        });

        it('returns error for invalid mode', async () => {
            const result = await roosyncRead({ mode: 'invalid' as any });
            expect(result.content[0].text).toContain('Erreur');
        });

        it('returns error when message_id missing for message mode', async () => {
            const result = await roosyncRead({ mode: 'message' });
            expect(result.content[0].text).toContain('Erreur');
        });

        it('returns error when message_id missing for attachments mode', async () => {
            const result = await roosyncRead({ mode: 'attachments' });
            expect(result.content[0].text).toContain('Erreur');
        });
    });

    describe('error handling', () => {
        it('catches and formats exception in inbox mode', async () => {
            mockGetFilteredCount.mockRejectedValue(new Error('Disk full'));
            const result = await roosyncRead({ mode: 'inbox' });
            expect(result.content[0].text).toContain('Erreur');
            expect(result.content[0].text).toContain('Disk full');
        });

        it('catches and formats exception in message mode', async () => {
            mockGetMessage.mockRejectedValue(new Error('Corrupted'));
            const result = await roosyncRead({ mode: 'message', message_id: 'msg-1' });
            expect(result.content[0].text).toContain('Erreur');
        });

        it('catches and formats exception in attachments mode', async () => {
            mockListAttachments.mockRejectedValue(new Error('Permission denied'));
            const result = await roosyncRead({ mode: 'attachments', message_id: 'msg-1' });
            expect(result.content[0].text).toContain('Erreur');
        });

        it('handles non-Error exceptions', async () => {
            mockGetFilteredCount.mockRejectedValue('string error');
            const result = await roosyncRead({ mode: 'inbox' });
            expect(result.content[0].text).toContain('Erreur');
        });
    });

    describe('activity recording', () => {
        it('records activity after successful read', async () => {
            mockGetFilteredCount.mockResolvedValue({ total: 0, unread: 0, read: 0 });
            mockReadInbox.mockResolvedValue([]);
            await roosyncRead({ mode: 'inbox' });
            expect(mockRecordActivity).toHaveBeenCalledWith('read', { mode: 'inbox' });
        });
    });

    describe('metadata', () => {
        it('has correct tool metadata', () => {
            expect(readToolMetadata.name).toBe('roosync_read');
            expect(readToolMetadata.inputSchema.required).toContain('mode');
            expect(readToolMetadata.inputSchema.properties.mode.enum).toContain('inbox');
            expect(readToolMetadata.inputSchema.properties.mode.enum).toContain('message');
            expect(readToolMetadata.inputSchema.properties.mode.enum).toContain('attachments');
        });
    });
});
