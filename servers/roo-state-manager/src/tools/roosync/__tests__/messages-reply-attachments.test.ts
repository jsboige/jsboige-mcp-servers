/**
 * Tests #3995 — attachments sur reply/amend dans roosync_messages.
 *
 * Avant le fix : le dispatcher acceptait `attachments` (schéma commun à
 * toutes les actions) mais ne les transmettait pas à roosyncSend sur
 * reply/amend → réponse envoyée SANS pièce jointe sous un succès muet
 * (incident terrain 30/09-01/10 : clé servie « en PJ » à po-2027 via
 * action=reply, PJ jamais arrivée, 46 h d'attente).
 *
 * Après le fix :
 *   - reply transmet les attachments et suit le pipeline send
 *     (upload non-fatal + persistance des refs #3256 + rapport au caller) ;
 *   - amend les REJETTE bruyamment au routeur (pas de sémantique
 *     d'attachement sur une mutation — miroir du garde messageId #1170).
 *
 * Scaffold calqué sur messages-reply-idempotent.test.ts (vrai send.ts,
 * services mockés).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
    mockGetMessageManager,
    mockGetLocalFullId,
    mockGetRooSyncService,
    mockGetSharedStatePath,
    mockSendMessage,
    mockGetMessage,
    mockAmendMessage,
    mockUpdateMessageAttachments,
    mockRegisterHeartbeat,
    mockRecordActivity,
    mockUploadAttachment,
} = vi.hoisted(() => ({
    mockGetMessageManager: vi.fn(),
    mockGetLocalFullId: vi.fn(() => 'myia-web1:roo-extensions'),
    mockGetRooSyncService: vi.fn(),
    mockGetSharedStatePath: vi.fn(() => '/tmp/shared'),
    mockSendMessage: vi.fn(),
    mockGetMessage: vi.fn(),
    mockAmendMessage: vi.fn(),
    mockUpdateMessageAttachments: vi.fn(),
    mockRegisterHeartbeat: vi.fn(() => Promise.resolve()),
    mockRecordActivity: vi.fn(),
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

vi.mock('../../../../src/utils/logger.js', () => ({
    createLogger: () => ({
        info: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
    }),
}));

const ORIGINAL = {
    id: 'msg-original-3995',
    from: 'myia-po-2027:roo-extensions',
    to: 'myia-web1:roo-extensions',
    subject: 'Clé MEDIUM #3958',
    body: 'Re-serve la valeur en PJ',
    priority: 'HIGH',
    timestamp: '2026-10-01T21:13:00.000Z',
    status: 'unread',
};

function setupMM() {
    const mm = {
        sendMessage: mockSendMessage,
        getMessage: mockGetMessage,
        amendMessage: mockAmendMessage,
        updateMessageAttachments: mockUpdateMessageAttachments,
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

describe('roosync_messages attachments sur reply/amend (#3995)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setupMM();
        mockGetMessage.mockImplementation(async (id: string) =>
            id === ORIGINAL.id ? { ...ORIGINAL } : null
        );
        mockSendMessage.mockResolvedValue({
            id: 'reply-3995-fresh',
            from: 'myia-web1:roo-extensions',
            to: 'myia-po-2027:roo-extensions',
            subject: `Re: ${ORIGINAL.subject}`,
            body: 'Voici la clé',
            priority: 'HIGH',
            timestamp: '2026-10-02T00:00:00.000Z',
            status: 'unread',
        });
        mockUpdateMessageAttachments.mockResolvedValue(true);
    });

    it('upload et persiste les attachments sur reply, et les rapporte au caller', async () => {
        mockUploadAttachment.mockResolvedValue({
            uuid: 'uuid-aaa',
            filename: 'key.txt',
            sizeBytes: 32,
        });

        const { roosyncMessages } = await import('../../../../src/tools/roosync/messages.js');
        const result = await roosyncMessages({
            action: 'reply',
            message_id: ORIGINAL.id,
            body: 'Voici la clé',
            attachments: [{ path: '/tmp/key.txt', filename: 'key.txt' }],
        } as any);

        // Le reply part bien (from inversé = la machine locale).
        expect(mockSendMessage).toHaveBeenCalledTimes(1);
        // Upload avec l'expéditeur du reply et l'ID du message créé.
        expect(mockUploadAttachment).toHaveBeenCalledWith(
            '/tmp/key.txt',
            'myia-web1:roo-extensions',
            'key.txt',
            'reply-3995-fresh'
        );
        // Les refs sont persistées — source de vérité attachments_list (#3256).
        expect(mockUpdateMessageAttachments).toHaveBeenCalledWith('reply-3995-fresh', [
            { uuid: 'uuid-aaa', filename: 'key.txt', sizeBytes: 32 },
        ]);
        const text = result.content[0].text;
        expect(text).toContain('Pièces jointes');
        expect(text).toContain('uuid-aaa');
        expect(text).toContain('key.txt');
    });

    it('annonce un échec de persistance des refs au lieu d’un succès muet', async () => {
        mockUploadAttachment.mockResolvedValue({
            uuid: 'uuid-bbb',
            filename: 'key.txt',
            sizeBytes: 32,
        });
        mockUpdateMessageAttachments.mockResolvedValue(false);

        const { roosyncMessages } = await import('../../../../src/tools/roosync/messages.js');
        const result = await roosyncMessages({
            action: 'reply',
            message_id: ORIGINAL.id,
            body: 'Voici la clé',
            attachments: [{ path: '/tmp/key.txt', filename: 'key.txt' }],
        } as any);

        const text = result.content[0].text;
        expect(text).toContain('persistance des RÉFÉRENCES a échoué');
        expect(text).toContain('Renvoyez le message');
    });

    it("n'interrompt pas le reply quand l'upload échoue (non-fatal, #3997 pour le rapport)", async () => {
        mockUploadAttachment.mockRejectedValue(new Error('store indisponible'));

        const { roosyncMessages } = await import('../../../../src/tools/roosync/messages.js');
        const result = await roosyncMessages({
            action: 'reply',
            message_id: ORIGINAL.id,
            body: 'Voici la clé',
            attachments: [{ path: '/tmp/key.txt', filename: 'key.txt' }],
        } as any);

        // Le message part quand même, aucune ref persistée.
        expect(mockSendMessage).toHaveBeenCalledTimes(1);
        expect(mockUpdateMessageAttachments).not.toHaveBeenCalled();
        expect(result.content[0].text).toContain('Réponse envoyée avec succès');
        // NB : le succès sans section PJ reste le comportement sur échec
        // d'upload — le rapport de l'échec est le périmètre #3997 item 2.
    });

    it('rejette bruyamment attachments sur amend (jamais droppé en silence)', async () => {
        const { roosyncMessages } = await import('../../../../src/tools/roosync/messages.js');

        // roosyncSend convertit toute erreur en résultat texte d'erreur —
        // le rejet se lit dans le contenu, pas dans une exception.
        const result = await roosyncMessages({
            action: 'amend',
            message_id: 'msg-3995-mine',
            new_content: 'contenu corrigé',
            attachments: [{ path: '/tmp/fix.txt', filename: 'fix.txt' }],
        } as any);

        const text = result.content[0].text;
        expect(text).toContain('Erreur');
        expect(text).toContain('attachments');
        expect(text).toContain('amend');

        // Aucune mutation n'a eu lieu.
        expect(mockAmendMessage).not.toHaveBeenCalled();
        expect(mockUploadAttachment).not.toHaveBeenCalled();
    });
});
