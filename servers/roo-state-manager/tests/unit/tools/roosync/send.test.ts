/**
 * Tests for roosync_send tool
 *
 * Covers: send, reply, amend actions, validation,
 * auto-destruct, attachments, error handling
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { roosyncSend, sendToolMetadata } from '../../../../src/tools/roosync/send.js';

const {
    mockGetMessageManager,
    mockGetLocalMachineId,
    mockGetLocalFullId,
    mockGetRooSyncService,
    mockGetSharedStatePath,
    mockSendMessage,
    mockGetMessage,
    mockAmendMessage,
    mockUpdateMessageAttachments,
    mockRegisterHeartbeat,
    mockRecordActivity,
    mockUpdateDashboardActivity,
    mockUploadAttachment,
} = vi.hoisted(() => ({
    mockGetMessageManager: vi.fn(),
    mockGetLocalMachineId: vi.fn(() => 'myia-po-2025'),
    mockGetLocalFullId: vi.fn(() => 'myia-po-2025|roo-extensions'),
    mockGetRooSyncService: vi.fn(),
    mockGetSharedStatePath: vi.fn(() => '/tmp/shared'),
    mockSendMessage: vi.fn(),
    mockGetMessage: vi.fn(),
    mockAmendMessage: vi.fn(),
    mockUpdateMessageAttachments: vi.fn(),
    mockRegisterHeartbeat: vi.fn(() => Promise.resolve()),
    mockRecordActivity: vi.fn(),
    mockUpdateDashboardActivity: vi.fn(() => Promise.resolve()),
    mockUploadAttachment: vi.fn(),
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
    getLocalFullId: mockGetLocalFullId,
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

vi.mock('../../../../src/utils/dashboard-helpers.js', () => ({
    updateDashboardActivityAsync: mockUpdateDashboardActivity,
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
        uploadAttachment = mockUploadAttachment;
    },
}));

function setupMM() {
    const mm = {
        sendMessage: mockSendMessage,
        getMessage: mockGetMessage,
        amendMessage: mockAmendMessage,
        updateMessageAttachments: mockUpdateMessageAttachments,
    };
    mockGetMessageManager.mockReturnValue(mm);

    mockGetRooSyncService.mockResolvedValue({
        getHeartbeatService: () => ({
            registerHeartbeat: mockRegisterHeartbeat,
        }),
    });

    return mm;
}

describe('roosync_send', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setupMM();
    });

    describe('action=send', () => {
        it('sends a message successfully', async () => {
            mockSendMessage.mockResolvedValue({
                id: 'msg-new', from: 'myia-po-2025|roo-extensions', to: 'myia-ai-01',
                subject: 'Hello', priority: 'MEDIUM', timestamp: '2026-05-04T00:00:00.000Z',
            });
            const result = await roosyncSend({
                action: 'send', to: 'myia-ai-01', subject: 'Hello', body: 'World',
            });
            expect(result.content[0].text).toContain('envoyé');
            expect(result.content[0].text).toContain('msg-new');
            expect(mockSendMessage).toHaveBeenCalledWith(
                'myia-po-2025|roo-extensions', 'myia-ai-01', 'Hello', 'World',
                'MEDIUM', undefined, undefined, undefined, undefined
            );
        });

        it('sends with priority and tags', async () => {
            mockSendMessage.mockResolvedValue({
                id: 'msg-prio', from: 'myia-po-2025|roo-extensions', to: 'myia-ai-01',
                subject: 'Urgent', priority: 'URGENT', timestamp: '2026-05-04T00:00:00.000Z',
            });
            await roosyncSend({
                action: 'send', to: 'myia-ai-01', subject: 'Urgent', body: 'Now!',
                priority: 'URGENT', tags: ['TASK', 'BLOCKED'],
            });
            expect(mockSendMessage).toHaveBeenCalledWith(
                expect.any(String), 'myia-ai-01', 'Urgent', 'Now!',
                'URGENT', ['TASK', 'BLOCKED'], undefined, undefined, undefined
            );
        });

        it('sends with auto-destruct options', async () => {
            mockSendMessage.mockResolvedValue({
                id: 'msg-ad', from: 'myia-po-2025|roo-extensions', to: 'myia-ai-01',
                subject: 'Secret', priority: 'MEDIUM', timestamp: '2026-05-04T00:00:00.000Z',
                auto_destruct: true, destruct_after: '30m', expires_at: '2026-05-04T00:30:00.000Z',
            });
            const result = await roosyncSend({
                action: 'send', to: 'myia-ai-01', subject: 'Secret', body: 'Burn after reading',
                auto_destruct: true, destruct_after: '30m',
            });
            expect(result.content[0].text).toContain('Auto-destruction');
            expect(mockSendMessage).toHaveBeenCalledWith(
                expect.any(String), 'myia-ai-01', 'Secret', 'Burn after reading',
                'MEDIUM', undefined, undefined, undefined,
                { auto_destruct: true, destruct_after_read_by: undefined, destruct_after: '30m' }
            );
        });

        it('throws when "to" missing', async () => {
            const result = await roosyncSend({
                action: 'send', subject: 'Hello', body: 'World',
            } as any);
            expect(result.content[0].text).toContain('Erreur');
        });

        it('throws when "subject" missing', async () => {
            const result = await roosyncSend({
                action: 'send', to: 'myia-ai-01', body: 'World',
            } as any);
            expect(result.content[0].text).toContain('Erreur');
        });

        it('throws when "body" missing', async () => {
            const result = await roosyncSend({
                action: 'send', to: 'myia-ai-01', subject: 'Hello',
            } as any);
            expect(result.content[0].text).toContain('Erreur');
        });
    });

    describe('action=reply', () => {
        it('replies to a message successfully', async () => {
            mockGetMessage.mockResolvedValue({
                id: 'msg-orig', from: 'myia-ai-01', to: 'myia-po-2025',
                subject: 'Hello', priority: 'HIGH', timestamp: '2026-05-04T00:00:00.000Z',
            });
            mockSendMessage.mockResolvedValue({
                id: 'msg-reply', from: 'myia-po-2025|roo-extensions', to: 'myia-ai-01',
                subject: 'Re: Hello', priority: 'HIGH', timestamp: '2026-05-04T00:01:00.000Z',
            });
            const result = await roosyncSend({
                action: 'reply', message_id: 'msg-orig', body: 'Thanks!',
            });
            expect(result.content[0].text).toContain('Réponse envoyée');
            expect(mockSendMessage).toHaveBeenCalledWith(
                'myia-po-2025|roo-extensions', 'myia-ai-01',
                'Re: Hello', 'Thanks!', 'HIGH', ['reply'], 'msg-orig', 'msg-orig'
            );
        });

        it('preserves Re: prefix if already present', async () => {
            mockGetMessage.mockResolvedValue({
                id: 'msg-re', from: 'myia-ai-01', to: 'myia-po-2025',
                subject: 'Re: Original', priority: 'MEDIUM', timestamp: '2026-05-04T00:00:00.000Z',
            });
            mockSendMessage.mockResolvedValue({
                id: 'msg-r2', from: 'myia-po-2025|roo-extensions', to: 'myia-ai-01',
                subject: 'Re: Original', priority: 'MEDIUM', timestamp: '2026-05-04T00:02:00.000Z',
            });
            await roosyncSend({ action: 'reply', message_id: 'msg-re', body: 'OK' });
            expect(mockSendMessage).toHaveBeenCalledWith(
                expect.any(String), expect.any(String),
                'Re: Original', 'OK', 'MEDIUM', ['reply'], 'msg-re', 'msg-re'
            );
        });

        it('returns not found when original missing', async () => {
            mockGetMessage.mockResolvedValue(null);
            const result = await roosyncSend({
                action: 'reply', message_id: 'missing', body: 'Reply',
            });
            expect(result.content[0].text).toContain('introuvable');
        });

        it('throws when message_id missing', async () => {
            const result = await roosyncSend({
                action: 'reply', body: 'Reply',
            } as any);
            expect(result.content[0].text).toContain('Erreur');
        });

        it('throws when body missing', async () => {
            const result = await roosyncSend({
                action: 'reply', message_id: 'msg-1',
            } as any);
            expect(result.content[0].text).toContain('Erreur');
        });
    });

    describe('action=amend', () => {
        it('amends a message successfully', async () => {
            mockAmendMessage.mockResolvedValue({
                message_id: 'msg-1', amended_at: '2026-05-04T01:00:00.000Z',
                reason: 'Typo fix', original_content_preserved: true,
            });
            const result = await roosyncSend({
                action: 'amend', message_id: 'msg-1', new_content: 'Fixed content', reason: 'Typo fix',
            });
            expect(result.content[0].text).toContain('amendé');
            expect(result.content[0].text).toContain('Typo fix');
            expect(mockAmendMessage).toHaveBeenCalledWith(
                'msg-1', 'myia-po-2025|roo-extensions', 'Fixed content', 'Typo fix'
            );
        });

        it('throws when message_id missing', async () => {
            const result = await roosyncSend({
                action: 'amend', new_content: 'New',
            } as any);
            expect(result.content[0].text).toContain('Erreur');
        });

        it('throws when new_content missing', async () => {
            const result = await roosyncSend({
                action: 'amend', message_id: 'msg-1',
            } as any);
            expect(result.content[0].text).toContain('Erreur');
        });
    });

    describe('validation', () => {
        it('returns error when action missing', async () => {
            const result = await roosyncSend({ action: undefined as any });
            expect(result.content[0].text).toContain('Erreur');
        });

        it('returns error for invalid action', async () => {
            const result = await roosyncSend({ action: 'invalid' as any });
            expect(result.content[0].text).toContain('Erreur');
        });
    });

    describe('error handling', () => {
        it('catches and formats send error', async () => {
            mockSendMessage.mockRejectedValue(new Error('Network failure'));
            const result = await roosyncSend({
                action: 'send', to: 'myia-ai-01', subject: 'Test', body: 'Body',
            });
            expect(result.content[0].text).toContain('Erreur');
            expect(result.content[0].text).toContain('Network failure');
        });

        it('catches and formats reply error', async () => {
            mockGetMessage.mockRejectedValue(new Error('Disk full'));
            const result = await roosyncSend({
                action: 'reply', message_id: 'msg-1', body: 'Reply',
            });
            expect(result.content[0].text).toContain('Erreur');
        });

        it('catches non-Error exceptions', async () => {
            mockSendMessage.mockRejectedValue('string error');
            const result = await roosyncSend({
                action: 'send', to: 'myia-ai-01', subject: 'Test', body: 'Body',
            });
            expect(result.content[0].text).toContain('Erreur');
        });
    });

    describe('activity recording', () => {
        it('records activity after successful send', async () => {
            mockSendMessage.mockResolvedValue({
                id: 'msg-act', from: 'myia-po-2025|roo-extensions', to: 'myia-ai-01',
                subject: 'Test', priority: 'MEDIUM', timestamp: '2026-05-04T00:00:00.000Z',
            });
            await roosyncSend({
                action: 'send', to: 'myia-ai-01', subject: 'Test', body: 'Body',
            });
            expect(mockRecordActivity).toHaveBeenCalledWith('send', { action: 'send' });
        });
    });

    describe('metadata', () => {
        it('has correct tool metadata', () => {
            expect(sendToolMetadata.name).toBe('roosync_send');
            expect(sendToolMetadata.inputSchema.required).toContain('action');
            expect(sendToolMetadata.inputSchema.properties.action.enum).toContain('send');
            expect(sendToolMetadata.inputSchema.properties.action.enum).toContain('reply');
            expect(sendToolMetadata.inputSchema.properties.action.enum).toContain('amend');
        });
    });
});
