/**
 * Tests #3997 — échecs d'upload d'attachments rapportés au caller sur send.
 *
 * Avant le fix : un échec d'upload était `logger.warn` uniquement — le caller
 * recevait « Message envoyé avec succès » sans aucune trace du fichier manquant
 * (incident po-2027 30/09 : clé servie « en PJ », upload échoué, 46 h perdues).
 *
 * Après le fix : le message part toujours (non-fatal), mais le résultat liste
 * chaque fichier NON joint (`Pièces jointes en échec : N/M`) avec son erreur.
 *
 * Scaffold calqué sur messages-reply-attachments.test.ts (#3995) : vrai
 * messages.ts dispatcher + vrai send.ts, services mockés.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
    mockGetMessageManager,
    mockGetLocalFullId,
    mockGetRooSyncService,
    mockGetSharedStatePath,
    mockSendMessage,
    mockUpdateMessageAttachments,
    mockRegisterHeartbeat,
    mockRecordActivity,
    mockUploadAttachment,
    mockUpdateDashboardActivity,
} = vi.hoisted(() => ({
    mockGetMessageManager: vi.fn(),
    mockGetLocalFullId: vi.fn(() => 'myia-web1:roo-extensions'),
    mockGetRooSyncService: vi.fn(),
    mockGetSharedStatePath: vi.fn(() => '/tmp/shared'),
    mockSendMessage: vi.fn(),
    mockUpdateMessageAttachments: vi.fn(),
    mockRegisterHeartbeat: vi.fn(() => Promise.resolve()),
    mockRecordActivity: vi.fn(),
    mockUploadAttachment: vi.fn(),
    mockUpdateDashboardActivity: vi.fn(() => Promise.resolve()),
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
    MessageManagerErrorCode: {
        INVALID_MESSAGE_FORMAT: 'INVALID_MESSAGE_FORMAT',
        INVALID_RECIPIENT: 'INVALID_RECIPIENT',
    },
}));

vi.mock('../../../../src/services/roosync/AttachmentManager.js', () => ({
    AttachmentManager: class {
        constructor(_sharedStatePath: string) {}
        uploadAttachment(...args: unknown[]) { return mockUploadAttachment(...args); }
    },
}));

vi.mock('../../../../src/utils/message-helpers.js', () => {
    const helpers: Record<string, unknown> = {
        getLocalMachineId: vi.fn(() => 'myia-web1'),
        getLocalFullId: mockGetLocalFullId,
        getLocalWorkspaceId: vi.fn(() => 'roo-extensions'),
        formatDate: vi.fn((d: string) => d?.substring(0, 10) || ''),
        formatDateFull: vi.fn((d: string) => d || ''),
        getPriorityIcon: vi.fn(() => '📌'),
        getStatusIcon: vi.fn(() => ''),
        parseMachineWorkspace: vi.fn((id: string) => {
            const idx = id.indexOf(':');
            if (idx === -1) return { machineId: id };
            return { machineId: id.substring(0, idx), workspaceId: id.substring(idx + 1) };
        }),
    };
    return {
        ...helpers,
        resolveCallerIdentity: vi.fn((as?: string) => {
            if (!as) {
                return {
                    machineId: (helpers.getLocalMachineId as () => string)(),
                    workspaceId: (helpers.getLocalWorkspaceId as () => string)(),
                    fullId: (helpers.getLocalFullId as () => string)(),
                };
            }
            const idx = as.indexOf(':');
            return idx === -1
                ? { machineId: as, workspaceId: undefined, fullId: as }
                : { machineId: as.substring(0, idx), workspaceId: as.substring(idx + 1), fullId: as };
        }),
    };
});

vi.mock('../../../../src/services/lazy-roosync.js', () => ({
    getRooSyncService: mockGetRooSyncService,
}));

vi.mock('../../../../src/utils/shared-state-path.js', () => ({
    getSharedStatePath: mockGetSharedStatePath,
    assertSharedStoreAccessible: () => {},
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

function setupMM() {
    const mm = {
        sendMessage: mockSendMessage,
        getMessage: vi.fn().mockResolvedValue(null),
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

function sentMessage() {
    return {
        id: 'msg-3997-fresh',
        from: 'myia-web1:roo-extensions',
        to: 'myia-po-2027:roo-extensions',
        subject: 'Clé MEDIUM',
        body: 'Voici la clé',
        priority: 'HIGH',
        timestamp: '2026-10-02T00:00:00.000Z',
        status: 'unread',
    };
}

describe('roosync send — échecs d’upload d’attachments rapportés (#3997)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setupMM();
        mockSendMessage.mockResolvedValue(sentMessage());
        mockUpdateMessageAttachments.mockResolvedValue(true);
    });

    it('rapporte un échec total : le message part, la section échec liste le fichier et l’erreur', async () => {
        mockUploadAttachment.mockRejectedValue(new Error('ENOENT: no such file or directory'));

        const { roosyncMessages } = await import('../../../../src/tools/roosync/messages.js');
        const result = await roosyncMessages({
            action: 'send',
            to: 'myia-po-2027:roo-extensions',
            subject: 'Clé MEDIUM',
            body: 'Voici la clé',
            attachments: [{ path: '/tmp/missing-key.txt', filename: 'key.txt' }],
        } as any);

        // Non-fatal : le message est bien parti.
        expect(mockSendMessage).toHaveBeenCalledTimes(1);
        const text = result.content[0].text;
        expect(text).toContain('Message envoyé avec succès');
        // La section échec existe, avec le ratio, le chemin et l'erreur.
        expect(text).toContain('Pièces jointes en échec');
        expect(text).toContain('1/1 fichier(s) NON joint(s)');
        expect(text).toContain('/tmp/missing-key.txt');
        expect(text).toContain('ENOENT');
        // Aucune section succès PJ ne doit se faire passer pour complète.
        expect(text).not.toContain('fichier(s) attaché(s)');
        // Aucune ref persistée — rien n'a été uploadé.
        expect(mockUpdateMessageAttachments).not.toHaveBeenCalled();
    });

    it('rapporte un échec partiel : succès et échec coexistent, ratio 1/2', async () => {
        mockUploadAttachment
            .mockResolvedValueOnce({ uuid: 'uuid-ok', filename: 'ok.txt', sizeBytes: 32 })
            .mockRejectedValueOnce(new Error('store indisponible'));

        const { roosyncMessages } = await import('../../../../src/tools/roosync/messages.js');
        const result = await roosyncMessages({
            action: 'send',
            to: 'myia-po-2027:roo-extensions',
            subject: 'Clé MEDIUM',
            body: 'Voici la clé',
            attachments: [
                { path: '/tmp/ok.txt', filename: 'ok.txt' },
                { path: '/tmp/broken.txt', filename: 'broken.txt' },
            ],
        } as any);

        const text = result.content[0].text;
        expect(text).toContain('1 fichier(s) attaché(s)');
        expect(text).toContain('uuid-ok');
        expect(text).toContain('Pièces jointes en échec');
        expect(text).toContain('1/2 fichier(s) NON joint(s)');
        expect(text).toContain('/tmp/broken.txt');
        expect(text).toContain('store indisponible');
        // Le succès partiel persiste bien ses refs.
        expect(mockUpdateMessageAttachments).toHaveBeenCalledWith('msg-3997-fresh', [
            { uuid: 'uuid-ok', filename: 'ok.txt', sizeBytes: 32 },
        ]);
    });

    it('garde un succès complet muet sur les échecs : aucune section échec quand tout passe', async () => {
        mockUploadAttachment.mockResolvedValue({ uuid: 'uuid-all', filename: 'key.txt', sizeBytes: 32 });

        const { roosyncMessages } = await import('../../../../src/tools/roosync/messages.js');
        const result = await roosyncMessages({
            action: 'send',
            to: 'myia-po-2027:roo-extensions',
            subject: 'Clé MEDIUM',
            body: 'Voici la clé',
            attachments: [{ path: '/tmp/key.txt', filename: 'key.txt' }],
        } as any);

        const text = result.content[0].text;
        expect(text).toContain('1 fichier(s) attaché(s)');
        expect(text).not.toContain('Pièces jointes en échec');
    });
});
