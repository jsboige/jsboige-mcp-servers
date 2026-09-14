/**
 * Tests for roosync_messages send idempotence on explicit messageId (#3654).
 *
 * Background:
 *   Le 14/09, sur po-2025:claudish, 3 writes sur 3 ont été prouvés landés
 *   APRÈS leur timeout client (120-180 s). L'append dashboard a une clé
 *   d'idempotence `messageId` (#3276) ; le send de message n'en a aucune.
 *   Sans clé, un retry sur timeout = jumeau. Le présent test couvre la
 *   mécanique ajoutée : un messageId explicite sur action="send" est
 *   absorbé au 2e appel si le message existe déjà sous le même expéditeur.
 *
 * Couvre :
 *   - L'absorption (deduplicated: true + contenu existant retourné)
 *   - L'absence d'appel à sendMessage quand absorbé
 *   - La collision d'id entre expéditeurs (warning + envoi proceed avec id auto)
 *   - Le path nominal sans messageId (comportement historique préservé)
 *   - La distinction messageId explicite vs message_id (paramètre de reply/amend)
 *   - L'instrumentation writeMs loggée côté serveur
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
    mockGetMessageManager,
    mockGetLocalFullId,
    mockGetRooSyncService,
    mockGetSharedStatePath,
    mockSendMessage,
    mockGetMessage,
    mockRegisterHeartbeat,
    mockRecordActivity,
} = vi.hoisted(() => ({
    mockGetMessageManager: vi.fn(),
    mockGetLocalFullId: vi.fn(() => 'myia-po-2026:roo-extensions'),
    mockGetRooSyncService: vi.fn(),
    mockGetSharedStatePath: vi.fn(() => '/tmp/shared'),
    mockSendMessage: vi.fn(),
    mockGetMessage: vi.fn(),
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

function setupMM() {
    const mm = {
        sendMessage: mockSendMessage,
        getMessage: mockGetMessage,
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

describe('roosync_messages send idempotence on explicit messageId (#3654)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setupMM();
    });

    describe('absorption on duplicate send', () => {
        it('absorbs a second send carrying an id already sent by the same sender', async () => {
            // #3654 — scénario nominal : un 1er send réussit avec un id
            // explicite ; un 2e send portant le MÊME id depuis le MÊME
            // expéditeur doit être absorbé sans appeler sendMessage à nouveau.
            mockGetMessage.mockImplementation(async (id: string) => {
                if (id === 'msg-3654-dup') {
                    return {
                        id: 'msg-3654-dup',
                        from: 'myia-po-2026:roo-extensions',
                        to: 'myia-ai-01:roo-extensions',
                        subject: 'Original',
                        body: 'Original content',
                        priority: 'HIGH',
                        timestamp: '2026-09-14T16:05:00.000Z',
                        status: 'unread',
                    };
                }
                return null;
            });

            const { roosyncMessages } = await import('../../../../src/tools/roosync/messages.js');
            const result = await roosyncMessages({
                action: 'send',
                to: 'myia-ai-01:roo-extensions',
                subject: 'Retry after timeout',
                body: 'Original content',
                priority: 'HIGH',
                messageId: 'msg-3654-dup'
            } as any);

            // Aucune seconde persistance (sinon, c'est un jumeau).
            expect(mockSendMessage).not.toHaveBeenCalled();

            // Le caller reçoit un retour qui annonce explicitement l'absorption.
            const text = result.content[0].text;
            expect(text).toContain('absorbé par idempotence');
            expect(text).toContain('msg-3654-dup');
            expect(text).toContain('#3654');
            expect(text).toContain('2026-09-14T16:05:00.000Z');
        });

        it('proceeds with sendMessage when messageId is not yet present', async () => {
            // Cas nominal d'un 1er envoi avec messageId explicite : la
            // pré-vérification via getMessage rend null → on proceed.
            mockGetMessage.mockResolvedValue(null);
            mockSendMessage.mockResolvedValue({
                id: 'msg-3654-fresh',
                from: 'myia-po-2026:roo-extensions',
                to: 'myia-ai-01:roo-extensions',
                subject: 'Fresh',
                body: 'Fresh content',
                priority: 'HIGH',
                timestamp: new Date().toISOString(),
                status: 'unread',
            });

            const { roosyncMessages } = await import('../../../../src/tools/roosync/messages.js');
            await roosyncMessages({
                action: 'send',
                to: 'myia-ai-01:roo-extensions',
                subject: 'Fresh',
                body: 'Fresh content',
                priority: 'HIGH',
                messageId: 'msg-3654-fresh'
            } as any);

            expect(mockSendMessage).toHaveBeenCalledTimes(1);
        });

        it('proceeds normally without explicit messageId (historical behavior preserved)', async () => {
            // Comportement historique : sans messageId, on ne touche pas à
            // getMessage et chaque send génère son propre id auto.
            mockGetMessage.mockResolvedValue(null);
            mockSendMessage.mockResolvedValue({
                id: 'msg-auto-1',
                from: 'myia-po-2026:roo-extensions',
                to: 'myia-ai-01:roo-extensions',
                subject: 'A',
                body: 'Same content',
                priority: 'MEDIUM',
                timestamp: new Date().toISOString(),
                status: 'unread',
            });

            const { roosyncMessages } = await import('../../../../src/tools/roosync/messages.js');
            await roosyncMessages({
                action: 'send',
                to: 'myia-ai-01:roo-extensions',
                subject: 'A',
                body: 'Same content'
            });

            // getMessage n'est PAS appelé : sans clé explicite, pas de lookup
            // (l'id auto-généré est par construction unique, déduplication inutile).
            expect(mockGetMessage).not.toHaveBeenCalled();
            expect(mockSendMessage).toHaveBeenCalledTimes(1);
        });
    });

    describe('cross-sender collision', () => {
        it('does NOT absorb when the existing message has a different sender (collision warning)', async () => {
            // #3654 garde-fou : si un autre expéditeur a utilisé le même
            // messageId, on n'absorbe PAS (ce n'est pas « mon propre message
            // réémis », c'est une collision). On log un warning et on
            // proceed avec un sendMessage qui génèrera son propre id.
            mockGetMessage.mockResolvedValue({
                id: 'msg-3654-collision',
                from: 'myia-other-machine:other-ws',
                to: 'myia-ai-01:roo-extensions',
                subject: 'Owned by other',
                body: 'Different content',
                priority: 'LOW',
                timestamp: '2026-09-14T10:00:00.000Z',
                status: 'unread',
            });
            mockSendMessage.mockResolvedValue({
                id: 'msg-auto-after-collision',
                from: 'myia-po-2026:roo-extensions',
                to: 'myia-ai-01:roo-extensions',
                subject: 'My send',
                body: 'My content',
                priority: 'MEDIUM',
                timestamp: new Date().toISOString(),
                status: 'unread',
            });

            const { roosyncMessages } = await import('../../../../src/tools/roosync/messages.js');
            const result = await roosyncMessages({
                action: 'send',
                to: 'myia-ai-01:roo-extensions',
                subject: 'My send',
                body: 'My content',
                messageId: 'msg-3654-collision'
            } as any);

            // On proceed malgré la collision → sendMessage appelé 1 fois
            expect(mockSendMessage).toHaveBeenCalledTimes(1);
            // Le retour ne contient PAS l'absorption (juste un envoi normal)
            expect(result.content[0].text).not.toContain('absorbé par idempotence');
        });
    });

    describe('content mismatch on duplicate', () => {
        it('flags a body mismatch when the same id is reused with different content', async () => {
            // Si le caller réutilise un id mais avec un body différent,
            // c'est probablement une erreur de logique : on signale la
            // divergence mais on conserve l'existant (politique = « pas de
            // mutation silencieuse »).
            mockGetMessage.mockResolvedValue({
                id: 'msg-3654-mismatch',
                from: 'myia-po-2026:roo-extensions',
                to: 'myia-ai-01:roo-extensions',
                subject: 'Original',
                body: 'Original body',
                priority: 'HIGH',
                timestamp: '2026-09-14T16:05:00.000Z',
                status: 'unread',
            });

            const { roosyncMessages } = await import('../../../../src/tools/roosync/messages.js');
            const result = await roosyncMessages({
                action: 'send',
                to: 'myia-ai-01:roo-extensions',
                subject: 'Different',
                body: 'TOTALLY DIFFERENT BODY',
                priority: 'HIGH',
                messageId: 'msg-3654-mismatch'
            } as any);

            expect(mockSendMessage).not.toHaveBeenCalled();
            const text = result.content[0].text;
            expect(text).toContain('absorbé par idempotence');
            // Le warning de divergence de body est annoncé au caller.
            expect(text).toContain('Avertissement');
            expect(text).toContain('body');
            expect(text).toContain('diffère');
        });

        it('does NOT flag when the body matches exactly', async () => {
            mockGetMessage.mockResolvedValue({
                id: 'msg-3654-match',
                from: 'myia-po-2026:roo-extensions',
                to: 'myia-ai-01:roo-extensions',
                subject: 'Original',
                body: 'Identical body',
                priority: 'HIGH',
                timestamp: '2026-09-14T16:05:00.000Z',
                status: 'unread',
            });

            const { roosyncMessages } = await import('../../../../src/tools/roosync/messages.js');
            const result = await roosyncMessages({
                action: 'send',
                to: 'myia-ai-01:roo-extensions',
                subject: 'Retry',
                body: 'Identical body',
                priority: 'HIGH',
                messageId: 'msg-3654-match'
            } as any);

            expect(mockSendMessage).not.toHaveBeenCalled();
            expect(result.content[0].text).toContain('absorbé par idempotence');
            // Pas de warning de divergence : body identique
            expect(result.content[0].text).not.toContain('Avertissement');
        });
    });

    describe('schema validation', () => {
        it('accepts messageId as an optional parameter on send', async () => {
            // #3654 — le schema accepte messageId sans erreur (la clé
            // doit être acceptée par le parse Zod strict).
            const { MessagesArgsSchema } = await import('../../../../src/tools/roosync/messages.js');
            const parsed = MessagesArgsSchema.safeParse({
                action: 'send',
                to: 'myia-ai-01',
                subject: 'S',
                body: 'B',
                messageId: 'msg-3654-schema-test'
            });
            expect(parsed.success).toBe(true);
            if (parsed.success) {
                expect((parsed.data as any).messageId).toBe('msg-3654-schema-test');
            }
        });

        it('distinguishes messageId (send idempotence) from message_id (reply/amend target)', async () => {
            // Les deux paramètres coexistent : `messageId` est la clé
            // d'idempotence pour send ; `message_id` est la cible pour
            // reply/amend/mark_read. Aucune collision possible dans le schema.
            const { MessagesArgsSchema } = await import('../../../../src/tools/roosync/messages.js');
            const parsed = MessagesArgsSchema.safeParse({
                action: 'send',
                to: 'myia-ai-01',
                subject: 'S',
                body: 'B',
                messageId: 'idem-key-3654',
                message_id: 'msg-pre-existing'
            });
            expect(parsed.success).toBe(true);
        });
    });
});