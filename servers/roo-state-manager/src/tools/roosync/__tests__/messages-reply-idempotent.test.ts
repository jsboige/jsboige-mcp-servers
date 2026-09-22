/**
 * Tests for roosync_messages REPLY idempotence on explicit messageId (#1170).
 *
 * Background:
 *   #1157/#3654 ont donné à action="send" une clé d'idempotence persistée
 *   (tool-layer lookup + manager-layer absorption). Le chemin action="reply"
 *   n'en transmettait AUCUNE : un timeout client suivi d'un retry fabriquait
 *   une réponse jumelle dans le thread. #1170 étend le même contrat :
 *
 *   - lookup tool-layer (getMessage) : absorb si l'id existe sous NOTRE
 *     expéditeur, warning + id auto si collision d'un autre expéditeur ;
 *   - la clé VOYAGE jusqu'à sendMessage (options.messageId — leçon review
 *     #1157 : consultée seule, elle ne pouvait jamais absorber un retry) ;
 *   - decision EXPLICITE pour amend : exclusion + rejet bruyant (#3177 —
 *     un paramètre fourni doit être honoré ou rejeté, jamais ignoré).
 *
 * Couvre :
 *   - L'absorption d'un reply réémis (pas de sendMessage, retour #1170)
 *   - Le path nominal avec clé (la clé voyage en 9e argument de sendMessage)
 *   - Le comportement historique sans clé (aucun lookup, pas d'options)
 *   - La collision inter-expéditeurs (proceed, pas d'absorption)
 *   - Le rejet bruyant messageId+amend
 *   - Le schema Zod accepte messageId avec action="reply"
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
    mockRegisterHeartbeat,
    mockRecordActivity,
} = vi.hoisted(() => ({
    mockGetMessageManager: vi.fn(),
    mockGetLocalFullId: vi.fn(() => 'myia-po-2026:roo-extensions'),
    mockGetRooSyncService: vi.fn(),
    mockGetSharedStatePath: vi.fn(() => '/tmp/shared'),
    mockSendMessage: vi.fn(),
    mockGetMessage: vi.fn(),
    mockAmendMessage: vi.fn(),
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
    MessageManagerErrorCode: {
        INVALID_MESSAGE_FORMAT: 'INVALID_MESSAGE_FORMAT',
        INVALID_RECIPIENT: 'INVALID_RECIPIENT',
    },
}));

vi.mock('../../../../src/utils/message-helpers.js', () => {
    const helpers: Record<string, unknown> = {
        getLocalMachineId: vi.fn(() => 'myia-po-2026'),
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

// L'original auquel on répond : adressé à NOTRE machine (sinon getMessage
// sans callerId le trouve quand même via les chemins locaux, mais gardons
// le scénario réaliste d'un DM reçu).
const ORIGINAL = {
    id: 'msg-original-1170',
    from: 'myia-ai-01:roo-extensions',
    to: 'myia-po-2026:roo-extensions',
    subject: 'Dispatch 17:01Z',
    body: 'Exécute #1170',
    priority: 'HIGH',
    timestamp: '2026-09-21T17:01:00.000Z',
    status: 'unread',
};

function setupMM() {
    const mm = {
        sendMessage: mockSendMessage,
        getMessage: mockGetMessage,
        amendMessage: mockAmendMessage,
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

describe('roosync_messages reply idempotence on explicit messageId (#1170)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setupMM();
        // Par défaut : l'original existe, aucune entrée sous la clé de retry.
        mockGetMessage.mockImplementation(async (id: string) =>
            id === ORIGINAL.id ? { ...ORIGINAL } : null
        );
    });

    it('absorbs a second reply carrying an id already sent by the same sender', async () => {
        // Timeout client (#2267) sur un reply → retry avec la même clé :
        // l'entrée existe déjà sous NOTRE expéditeur → absorption, aucun
        // second sendMessage (sinon jumeau dans le thread).
        mockGetMessage.mockImplementation(async (id: string) => {
            if (id === ORIGINAL.id) return { ...ORIGINAL };
            if (id === 'reply-1170-retry') {
                return {
                    id: 'reply-1170-retry',
                    from: 'myia-po-2026:roo-extensions',
                    to: 'myia-ai-01:roo-extensions',
                    subject: 'Re: Dispatch 17:01Z',
                    body: 'Réponse livrée',
                    priority: 'HIGH',
                    timestamp: '2026-09-22T04:50:00.000Z',
                    status: 'unread',
                    thread_id: 'msg-original-1170',
                    reply_to: 'msg-original-1170',
                };
            }
            return null;
        });

        const { roosyncMessages } = await import('../../../../src/tools/roosync/messages.js');
        const result = await roosyncMessages({
            action: 'reply',
            message_id: 'msg-original-1170',
            body: 'Réponse livrée',
            priority: 'HIGH',
            messageId: 'reply-1170-retry'
        } as any);

        expect(mockSendMessage).not.toHaveBeenCalled();
        const text = result.content[0].text;
        expect(text).toContain('absorbée par idempotence');
        expect(text).toContain('#1170');
        expect(text).toContain('reply-1170-retry');
        expect(text).toContain('2026-09-22T04:50:00.000Z');
        // Contexte reply annoncé : le thread et le message d'origine.
        expect(text).toContain('msg-original-1170');
    });

    it('passes the key through to sendMessage options on a fresh reply (review #1157 lesson)', async () => {
        // Premier reply avec clé : le lookup rend null → envoi normal, MAIS
        // la clé doit VOYAGER jusqu'à la persistance (9e argument), sinon
        // elle ne peut jamais absorber un retry après restart serveur.
        mockSendMessage.mockResolvedValue({
            id: 'reply-1170-fresh',
            from: 'myia-po-2026:roo-extensions',
            to: 'myia-ai-01:roo-extensions',
            subject: 'Re: Dispatch 17:01Z',
            body: 'Réponse fraîche',
            priority: 'HIGH',
            timestamp: new Date().toISOString(),
            status: 'unread',
        });

        const { roosyncMessages } = await import('../../../../src/tools/roosync/messages.js');
        await roosyncMessages({
            action: 'reply',
            message_id: 'msg-original-1170',
            body: 'Réponse fraîche',
            messageId: 'reply-1170-fresh'
        } as any);

        expect(mockSendMessage).toHaveBeenCalledTimes(1);
        const call = mockSendMessage.mock.calls[0];
        // Signature du reply : from inversé, reply_to = l'original.
        expect(call[0]).toBe('myia-po-2026:roo-extensions');
        expect(call[1]).toBe('myia-ai-01:roo-extensions');
        expect(call[7]).toBe('msg-original-1170');
        // La clé voyage en options — le contresens #1157 ne revient pas.
        expect(call[8]).toMatchObject({ messageId: 'reply-1170-fresh' });
    });

    it('keeps the historical behavior without a key: no lookup, no options', async () => {
        mockSendMessage.mockResolvedValue({
            id: 'reply-auto-1170',
            from: 'myia-po-2026:roo-extensions',
            to: 'myia-ai-01:roo-extensions',
            subject: 'Re: Dispatch 17:01Z',
            body: 'Réponse sans clé',
            priority: 'MEDIUM',
            timestamp: new Date().toISOString(),
            status: 'unread',
        });

        const { roosyncMessages } = await import('../../../../src/tools/roosync/messages.js');
        await roosyncMessages({
            action: 'reply',
            message_id: 'msg-original-1170',
            body: 'Réponse sans clé'
        } as any);

        // Seul l'original a été lu — aucun lookup idempotence (getMessage
        // appelé exactement 1 fois, pour l'original).
        expect(mockGetMessage).toHaveBeenCalledTimes(1);
        expect(mockGetMessage).toHaveBeenCalledWith('msg-original-1170');
        expect(mockSendMessage).toHaveBeenCalledTimes(1);
        expect(mockSendMessage.mock.calls[0][8]).toBeUndefined();
    });

    it('does NOT absorb when the existing id belongs to a different sender (collision)', async () => {
        // Garde-fou : un autre siège a utilisé la même clé. Ce n'est pas
        // « mon reply réémis », c'est une collision → warning + envoi avec
        // id auto (le manager-layer refait sa propre garde).
        mockGetMessage.mockImplementation(async (id: string) => {
            if (id === ORIGINAL.id) return { ...ORIGINAL };
            if (id === 'reply-1170-collided') {
                return {
                    id: 'reply-1170-collided',
                    from: 'myia-po-2023:roo-extensions',
                    to: 'myia-ai-01:roo-extensions',
                    subject: 'Re: Dispatch 17:01Z',
                    body: 'Réponse d\'un autre siège',
                    priority: 'LOW',
                    timestamp: '2026-09-22T03:00:00.000Z',
                    status: 'unread',
                };
            }
            return null;
        });
        mockSendMessage.mockResolvedValue({
            id: 'reply-auto-after-collision',
            from: 'myia-po-2026:roo-extensions',
            to: 'myia-ai-01:roo-extensions',
            subject: 'Re: Dispatch 17:01Z',
            body: 'Ma réponse',
            priority: 'HIGH',
            timestamp: new Date().toISOString(),
            status: 'unread',
        });

        const { roosyncMessages } = await import('../../../../src/tools/roosync/messages.js');
        const result = await roosyncMessages({
            action: 'reply',
            message_id: 'msg-original-1170',
            body: 'Ma réponse',
            messageId: 'reply-1170-collided'
        } as any);

        expect(mockSendMessage).toHaveBeenCalledTimes(1);
        expect(result.content[0].text).not.toContain('absorbée par idempotence');
    });

    it('flags a body mismatch when the same reply id is reused with different content', async () => {
        mockGetMessage.mockImplementation(async (id: string) => {
            if (id === ORIGINAL.id) return { ...ORIGINAL };
            if (id === 'reply-1170-mismatch') {
                return {
                    id: 'reply-1170-mismatch',
                    from: 'myia-po-2026:roo-extensions',
                    to: 'myia-ai-01:roo-extensions',
                    subject: 'Re: Dispatch 17:01Z',
                    body: 'Contenu initial du reply',
                    priority: 'HIGH',
                    timestamp: '2026-09-22T04:50:00.000Z',
                    status: 'unread',
                };
            }
            return null;
        });

        const { roosyncMessages } = await import('../../../../src/tools/roosync/messages.js');
        const result = await roosyncMessages({
            action: 'reply',
            message_id: 'msg-original-1170',
            body: 'CONTENU TOTALEMENT DIFFÉRENT',
            messageId: 'reply-1170-mismatch'
        } as any);

        expect(mockSendMessage).not.toHaveBeenCalled();
        const text = result.content[0].text;
        expect(text).toContain('absorbée par idempotence');
        expect(text).toContain('Avertissement');
        expect(text).toContain('diffère');
    });

    it('rejects messageId on action="amend" loudly (documented exclusion, #3177)', async () => {
        // Amend ne CRÉE pas de message : une clé d'idempotence n'a pas de
        // cible, et un retry au contenu identique est naturellement convergent
        // (prouvé au manager-level dans MessageManager.amend-retry-convergence).
        // Le paramètre doit être rejeté bruyamment, pas ignoré en silence.
        const { roosyncMessages } = await import('../../../../src/tools/roosync/messages.js');
        const result = await roosyncMessages({
            action: 'amend',
            message_id: 'msg-original-1170',
            new_content: 'Contenu corrigé',
            messageId: 'amend-key-should-reject'
        } as any);

        expect(mockAmendMessage).not.toHaveBeenCalled();
        const text = result.content[0].text;
        expect(text).toContain('sans effet sur action="amend"');
        expect(text).toContain('#1170');
        expect(text).toContain('Retirez "messageId"');
    });

    describe('schema validation', () => {
        it('accepts messageId with action="reply" (MessagesArgsSchema)', async () => {
            const { MessagesArgsSchema } = await import('../../../../src/tools/roosync/messages.js');
            const parsed = MessagesArgsSchema.safeParse({
                action: 'reply',
                message_id: 'msg-original-1170',
                body: 'B',
                messageId: 'reply-1170-schema'
            });
            expect(parsed.success).toBe(true);
            if (parsed.success) {
                expect((parsed.data as any).messageId).toBe('reply-1170-schema');
            }
        });
    });
});
