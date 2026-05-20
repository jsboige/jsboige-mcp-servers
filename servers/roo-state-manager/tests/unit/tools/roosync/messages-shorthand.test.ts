/**
 * Tests for roosync_messages shorthand resolution (#2241)
 *
 * Covers: SHORTHAND_MAP, resolveAddressShorthand(),
 * integration with roosyncMessages send action
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
    mockGetMessageManager,
    mockGetLocalFullId,
    mockGetRooSyncService,
    mockGetSharedStatePath,
    mockSendMessage,
    mockRegisterHeartbeat,
    mockRecordActivity,
} = vi.hoisted(() => ({
    mockGetMessageManager: vi.fn(),
    mockGetLocalFullId: vi.fn(() => 'myia-po-2026:roo-extensions'),
    mockGetRooSyncService: vi.fn(),
    mockGetSharedStatePath: vi.fn(() => '/tmp/shared'),
    mockSendMessage: vi.fn(),
    mockRegisterHeartbeat: vi.fn(() => Promise.resolve()),
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
    getLocalMachineId: vi.fn(() => 'myia-po-2026'),
    getLocalFullId: mockGetLocalFullId,
    getLocalWorkspaceId: vi.fn(() => 'roo-extensions'),
    formatDate: vi.fn((d: string) => d?.substring(0, 10) || ''),
    formatDateFull: vi.fn((d: string) => d || ''),
    getPriorityIcon: vi.fn(() => ''),
    getStatusIcon: vi.fn(() => ''),
    parseMachineWorkspace: vi.fn((id: string) => {
        const idx = id.indexOf(':');
        if (idx === -1) return { machineId: id };
        return { machineId: id.substring(0, idx), workspaceId: id.substring(idx + 1) };
    }),
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

function setupMM() {
    const mm = {
        sendMessage: mockSendMessage,
        getMessage: vi.fn().mockResolvedValue(null),
        markAsRead: vi.fn(),
    };
    mockGetMessageManager.mockReturnValue(mm);

    mockGetRooSyncService.mockResolvedValue({
        getHeartbeatService: () => ({
            registerHeartbeat: mockRegisterHeartbeat,
        }),
    });

    return mm;
}

describe('roosync_messages shorthand resolution (#2241)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setupMM();
    });

    describe('hermes shorthand', () => {
        it('resolves "hermes" to "myia-po-2026:hermes-agent"', async () => {
            mockSendMessage.mockResolvedValue({
                id: 'msg-test-1',
                from: 'myia-po-2026:roo-extensions',
                to: 'myia-po-2026:hermes-agent',
                subject: 'Test',
                body: 'Hello',
                priority: 'MEDIUM',
                timestamp: new Date().toISOString(),
                status: 'unread',
            });

            const { roosyncMessages } = await import('../../../../src/tools/roosync/messages.js');
            await roosyncMessages({
                action: 'send',
                to: 'hermes',
                subject: 'Test',
                body: 'Hello',
            });

            expect(mockSendMessage).toHaveBeenCalledWith(
                'myia-po-2026:roo-extensions',
                'myia-po-2026:hermes-agent',
                'Test',
                'Hello',
                'MEDIUM',
                undefined,
                undefined,
                undefined,
                undefined
            );
        });

        it('resolves "Hermes" case-insensitively', async () => {
            mockSendMessage.mockResolvedValue({
                id: 'msg-test-2',
                from: 'myia-po-2026:roo-extensions',
                to: 'myia-po-2026:hermes-agent',
                subject: 'Test',
                body: 'Hello',
                priority: 'MEDIUM',
                timestamp: new Date().toISOString(),
                status: 'unread',
            });

            const { roosyncMessages } = await import('../../../../src/tools/roosync/messages.js');
            await roosyncMessages({
                action: 'send',
                to: 'Hermes',
                subject: 'Test',
                body: 'Hello',
            });

            expect(mockSendMessage).toHaveBeenCalledWith(
                expect.any(String),
                'myia-po-2026:hermes-agent',
                expect.any(String),
                expect.any(String),
                expect.any(String),
                undefined, undefined, undefined, undefined
            );
        });
    });

    describe('nanoclaw shorthand', () => {
        it('resolves "nanoclaw" to "myia-ai-01:nanoclaw"', async () => {
            mockSendMessage.mockResolvedValue({
                id: 'msg-test-3',
                from: 'myia-po-2026:roo-extensions',
                to: 'myia-ai-01:nanoclaw',
                subject: 'Test',
                body: 'Hello NanoClaw',
                priority: 'MEDIUM',
                timestamp: new Date().toISOString(),
                status: 'unread',
            });

            const { roosyncMessages } = await import('../../../../src/tools/roosync/messages.js');
            await roosyncMessages({
                action: 'send',
                to: 'nanoclaw',
                subject: 'Test',
                body: 'Hello NanoClaw',
            });

            expect(mockSendMessage).toHaveBeenCalledWith(
                expect.any(String),
                'myia-ai-01:nanoclaw',
                expect.any(String),
                expect.any(String),
                expect.any(String),
                undefined, undefined, undefined, undefined
            );
        });
    });

    describe('passthrough for non-shorthand addresses', () => {
        it('passes through full machine:workspace address unchanged', async () => {
            mockSendMessage.mockResolvedValue({
                id: 'msg-test-4',
                from: 'myia-po-2026:roo-extensions',
                to: 'myia-ai-01:roo-extensions',
                subject: 'Test',
                body: 'Hello',
                priority: 'MEDIUM',
                timestamp: new Date().toISOString(),
                status: 'unread',
            });

            const { roosyncMessages } = await import('../../../../src/tools/roosync/messages.js');
            await roosyncMessages({
                action: 'send',
                to: 'myia-ai-01:roo-extensions',
                subject: 'Test',
                body: 'Hello',
            });

            expect(mockSendMessage).toHaveBeenCalledWith(
                expect.any(String),
                'myia-ai-01:roo-extensions',
                expect.any(String),
                expect.any(String),
                expect.any(String),
                undefined, undefined, undefined, undefined
            );
        });

        it('passes through bare machine ID unchanged', async () => {
            mockSendMessage.mockResolvedValue({
                id: 'msg-test-5',
                from: 'myia-po-2026:roo-extensions',
                to: 'myia-po-2023',
                subject: 'Test',
                body: 'Hello',
                priority: 'MEDIUM',
                timestamp: new Date().toISOString(),
                status: 'unread',
            });

            const { roosyncMessages } = await import('../../../../src/tools/roosync/messages.js');
            await roosyncMessages({
                action: 'send',
                to: 'myia-po-2023',
                subject: 'Test',
                body: 'Hello',
            });

            expect(mockSendMessage).toHaveBeenCalledWith(
                expect.any(String),
                'myia-po-2023',
                expect.any(String),
                expect.any(String),
                expect.any(String),
                undefined, undefined, undefined, undefined
            );
        });

        it('returns undefined when to is undefined', async () => {
            // resolveAddressShorthand should handle undefined gracefully
            // The send action will fail with validation error before reaching sendMessage
            const { roosyncMessages } = await import('../../../../src/tools/roosync/messages.js');
            const result = await roosyncMessages({
                action: 'send',
                to: undefined as any,
                subject: 'Test',
                body: 'Hello',
            });
            // Should error out due to missing "to"
            expect(result.content[0].text).toContain('Erreur');
        });
    });
});
