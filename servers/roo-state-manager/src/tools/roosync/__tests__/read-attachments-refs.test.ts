/**
 * Tests #3997 — mode lecture attachments (roosync_read mode="attachments") sur
 * le chemin ciblé #3256 (refs du message) au lieu du scan legacy du store.
 *
 * Avant le fix : `listAttachments(messageId)` parcourait le pool complet —
 * coût proportionnel à la flotte sur les grosses inboxes.
 * Après le fix : un message connu répond depuis SES refs (O(k)) ; seul un
 * message introuvable retombe sur le scan historique.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
    mockGetMessageManager,
    mockGetMessage,
    mockListAttachments,
    mockListByRefs,
    mockGetRooSyncService,
    mockRecordActivity,
} = vi.hoisted(() => ({
    mockGetMessageManager: vi.fn(),
    mockGetMessage: vi.fn(),
    mockListAttachments: vi.fn(),
    mockListByRefs: vi.fn(),
    mockGetRooSyncService: vi.fn(),
    mockRecordActivity: vi.fn(),
}));

vi.mock('../../../../src/services/MessageManager.js', () => ({
    getMessageManager: mockGetMessageManager,
    MessageManager: class {},
    MessageManagerError: class extends Error {
        code: string;
        constructor(msg: string, code: string) {
            super(msg);
            this.code = code;
            this.name = 'MessageManagerError';
        }
    },
    MessageManagerErrorCode: {
        INVALID_MESSAGE_FORMAT: 'INVALID_MESSAGE_FORMAT',
    },
}));

vi.mock('../../../../src/services/roosync/AttachmentManager.js', () => ({
    AttachmentManager: class {
        constructor(_sharedStatePath: string) {}
        listAttachments(...args: unknown[]) { return mockListAttachments(...args); }
        listAttachmentsByRefs(...args: unknown[]) { return mockListByRefs(...args); }
    },
}));

vi.mock('../../../../src/utils/message-helpers.js', () => ({
    getLocalMachineId: vi.fn(() => 'myia-web1'),
    getLocalFullId: vi.fn(() => 'myia-web1:roo-extensions'),
    getLocalWorkspaceId: vi.fn(() => 'roo-extensions'),
    formatDate: vi.fn((d: string) => d?.substring(0, 10) || ''),
    formatDateFull: vi.fn((d: string) => d || ''),
    getPriorityIcon: vi.fn(() => '📌'),
    getStatusIcon: vi.fn(() => ''),
    resolveCallerIdentity: vi.fn(() => ({ machineId: 'myia-web1', workspaceId: 'roo-extensions', fullId: 'myia-web1:roo-extensions' })),
}));

vi.mock('../../../../src/services/lazy-roosync.js', () => ({
    getRooSyncService: mockGetRooSyncService,
}));

vi.mock('../../../../src/utils/shared-state-path.js', () => ({
    getSharedStatePath: vi.fn(() => '/tmp/shared'),
    assertSharedStoreAccessible: () => {},
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

const META = (uuid: string) => ({
    uuid,
    originalName: `${uuid}.txt`,
    sizeBytes: 128,
    mimeType: 'text/plain',
    uploadedAt: '2026-10-01T12:00:00.000Z',
    uploaderMachineId: 'myia-po-2027',
    messageId: 'msg-known',
});

describe('roosync_read mode="attachments" — chemin refs #3256 (#3997)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetMessageManager.mockReturnValue({ getMessage: mockGetMessage });
    });

    it('un message connu répond depuis ses refs, sans scan du store', async () => {
        mockGetMessage.mockResolvedValue({
            id: 'msg-known',
            attachments: [
                { uuid: 'uuid-a', filename: 'a.txt', sizeBytes: 128 },
                { uuid: 'uuid-b', filename: 'b.txt', sizeBytes: 256 },
            ],
        });
        mockListByRefs.mockResolvedValue([META('uuid-a'), META('uuid-b')]);

        const { roosyncRead } = await import('../../../../src/tools/roosync/read.js');
        const result = await roosyncRead({ mode: 'attachments', message_id: 'msg-known' } as any);

        expect(mockListByRefs).toHaveBeenCalledWith(['uuid-a', 'uuid-b'], expect.anything());
        expect(mockListAttachments).not.toHaveBeenCalled();
        const text = result.content[0].text;
        expect(text).toContain('uuid-a');
        expect(text).toContain('uuid-b');
        expect(text).toContain('Total :** 2');
    });

    it('message connu sans refs = miss définitif : réponse directe, aucun scan', async () => {
        mockGetMessage.mockResolvedValue({ id: 'msg-known', attachments: [] });
        mockListByRefs.mockResolvedValue([]);

        const { roosyncRead } = await import('../../../../src/tools/roosync/read.js');
        const result = await roosyncRead({ mode: 'attachments', message_id: 'msg-known' } as any);

        expect(mockListByRefs).toHaveBeenCalledWith([], expect.anything());
        expect(mockListAttachments).not.toHaveBeenCalled();
        expect(result.content[0].text).toContain('Aucune pièce jointe');
    });

    it('message introuvable : fallback sur le scan historique filtré', async () => {
        mockGetMessage.mockResolvedValue(null);
        mockListAttachments.mockResolvedValue([META('uuid-legacy')]);

        const { roosyncRead } = await import('../../../../src/tools/roosync/read.js');
        const result = await roosyncRead({ mode: 'attachments', message_id: 'msg-unknown' } as any);

        expect(mockListAttachments).toHaveBeenCalledWith('msg-unknown', expect.anything());
        expect(mockListByRefs).not.toHaveBeenCalled();
        expect(result.content[0].text).toContain('uuid-legacy');
    });

    it('liste partielle : les entrées omises se déclarent (#3013)', async () => {
        mockGetMessage.mockResolvedValue({
            id: 'msg-known',
            attachments: [
                { uuid: 'uuid-a', filename: 'a.txt', sizeBytes: 128 },
                { uuid: 'ghost', filename: 'ghost.txt', sizeBytes: 64 },
            ],
        });
        mockListByRefs.mockImplementation(async (_uuids: string[], stats: { missingMetadata: number }) => {
            stats.missingMetadata += 1;
            return [META('uuid-a')];
        });

        const { roosyncRead } = await import('../../../../src/tools/roosync/read.js');
        const result = await roosyncRead({ mode: 'attachments', message_id: 'msg-known' } as any);

        const text = result.content[0].text;
        expect(text).toContain('uuid-a');
        expect(text).toContain('1 entrée(s) omise(s)');
        expect(text).toContain('metadata absente 1');
    });
});
