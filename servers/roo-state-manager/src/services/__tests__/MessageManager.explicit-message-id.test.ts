/**
 * #3654 (review #1157) — persistance RÉELLE du messageId explicite.
 *
 * Le premier push n'utilisait la clé que pour le lookup tool-layer : jamais
 * stockée, elle ne pouvait jamais absorber un retry (le 2e appel cherchait un
 * id absent et re-persistait → jumeau). Ces tests prouvent le contrat fermé
 * bout-en-bout au niveau MessageManager, sur système de fichiers réel :
 *
 *  1. Premier send avec messageId explicite → le message persiste SOUS cet
 *     id (inbox/ et sent/), contenu JSON portant l'id.
 *  2. Second send avec la même clé, même expéditeur → absorbé : retour de
 *     l'entrée existante (timestamp identique), aucun nouveau fichier.
 *  3. Collision inter-expéditeurs → repli sur id auto ; l'entrée étrangère
 *     n'est JAMAIS écrasée (writeFile écraserait `${id}.json`).
 *  4. messageId invalide (séparateur de chemin) → INVALID_MESSAGE_FORMAT,
 *     rien n'est écrit.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { MessageManager } from '../MessageManager.js';
import { MessageManagerError, MessageManagerErrorCode } from '../../types/errors.js';
import { existsSync, rmSync, mkdirSync } from 'fs';
import { promises as fs } from 'fs';
import { join } from 'path';

const FROM = 'myia-web1:roo-extensions';
const TO = 'myia-ai-01:roo-extensions';

describe('MessageManager.sendMessage — messageId explicite (#3654)', () => {
    let messageManager: MessageManager;
    let testSharedStatePath: string;
    let inboxPath: string;
    let sentPath: string;

    beforeEach(() => {
        testSharedStatePath = join(__dirname, '../../__test-data__/explicit-id-shared-state');
        inboxPath = join(testSharedStatePath, 'messages/inbox');
        sentPath = join(testSharedStatePath, 'messages/sent');
        for (const dir of [inboxPath, sentPath, join(testSharedStatePath, 'messages/archive')]) {
            mkdirSync(dir, { recursive: true });
        }
        messageManager = new MessageManager(testSharedStatePath);
    });

    afterEach(() => {
        if (existsSync(testSharedStatePath)) {
            for (let i = 0; i < 3; i++) {
                try {
                    rmSync(testSharedStatePath, { recursive: true, force: true });
                    break;
                } catch (err: unknown) {
                    if (i === 2 && (err as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw err;
                }
            }
        }
    });

    test('premier send : le message persiste SOUS l\'id explicite (inbox + sent + contenu)', async () => {
        const KEY = 'task-3654-first-real-persist';
        const msg = await messageManager.sendMessage(
            FROM, TO, 'Sujet', 'Body', 'HIGH', undefined, undefined, undefined,
            { messageId: KEY }
        );

        // Le retour porte l'id explicite — pas un id auto-généré.
        expect(msg.id).toBe(KEY);

        // Persistance réelle sous cet id, des deux côtés.
        const inboxFile = join(inboxPath, `${KEY}.json`);
        const sentFile = join(sentPath, `${KEY}.json`);
        expect(existsSync(inboxFile)).toBe(true);
        expect(existsSync(sentFile)).toBe(true);

        const persisted = JSON.parse(await fs.readFile(inboxFile, 'utf-8'));
        expect(persisted.id).toBe(KEY);
        expect(persisted.from).toBe(FROM);
        expect(persisted.subject).toBe('Sujet');
    });

    test('second send avec la même clé, même expéditeur : absorbé, aucun jumeau', async () => {
        const KEY = 'task-3654-retry-after-timeout';
        const first = await messageManager.sendMessage(
            FROM, TO, 'Sujet retry', 'Body retry', 'HIGH', undefined, undefined, undefined,
            { messageId: KEY }
        );

        // Le retry (ce que fait un caller après un timeout client #2267) :
        // même clé, même expéditeur, contenu potentiellement identique.
        const second = await messageManager.sendMessage(
            FROM, TO, 'Sujet retry', 'Body retry', 'HIGH', undefined, undefined, undefined,
            { messageId: KEY }
        );

        // Absorption : même entrée, même timestamp — pas de second message.
        expect(second.id).toBe(KEY);
        expect(second.timestamp).toBe(first.timestamp);

        // Exactement UNE entrée dans l'inbox du destinataire : pas de jumeau.
        const inboxFiles = await fs.readdir(inboxPath);
        expect(inboxFiles.filter(f => f.endsWith('.json'))).toHaveLength(1);
        expect(inboxFiles).toContain(`${KEY}.json`);
    });

    test('collision inter-expéditeurs : repli sur id auto, l\'entrée étrangère intacte', async () => {
        const KEY = 'task-3654-colliding-key';
        // Un AUTRE expéditeur a déjà persisté sous cette clé.
        const foreign = {
            id: KEY,
            from: 'myia-po-2026:roo-extensions',
            to: TO,
            subject: 'Entrée étrangère',
            body: 'Ne doit jamais être écrasée',
            priority: 'LOW',
            timestamp: '2026-09-14T10:00:00.000Z',
            status: 'unread'
        };
        await fs.writeFile(join(inboxPath, `${KEY}.json`), JSON.stringify(foreign, null, 2), 'utf-8');

        const msg = await messageManager.sendMessage(
            FROM, TO, 'Mon envoi', 'Body', 'MEDIUM', undefined, undefined, undefined,
            { messageId: KEY }
        );

        // Repli : l'id retourné n'est PAS la clé en collision.
        expect(msg.id).not.toBe(KEY);
        expect(msg.id.length).toBeGreaterThan(0);

        // L'entrée étrangère est intacte — jamais d'écrasement `${id}.json`.
        const after = JSON.parse(await fs.readFile(join(inboxPath, `${KEY}.json`), 'utf-8'));
        expect(after).toEqual(foreign);

        // Le nôtre a bien atterri sous son id auto.
        expect(existsSync(join(inboxPath, `${msg.id}.json`))).toBe(true);
    });

    test('messageId invalide (séparateur de chemin) : rejet INVALID_MESSAGE_FORMAT, rien d\'écrit', async () => {
        await expect(messageManager.sendMessage(
            FROM, TO, 'Sujet', 'Body', 'MEDIUM', undefined, undefined, undefined,
            { messageId: '../traversal' }
        )).rejects.toMatchObject({
            code: MessageManagerErrorCode.INVALID_MESSAGE_FORMAT
        } as Partial<MessageManagerError>);

        // Aucun fichier écrit malgré le rejet.
        const inboxFiles = await fs.readdir(inboxPath);
        expect(inboxFiles.filter(f => f.endsWith('.json'))).toHaveLength(0);
    });

    // #1170 — la forme REPLY du même contrat : reply_to + thread_id posés,
    // même clé d'idempotence. Prouve l'absorption manager-level pour le cas
    // « réponse serveur perdue après persistance » (le tool-layer lookup peut
    // manquer l'entrée si le client a retry depuis un autre process/serveur).
    describe('forme reply (#1170)', () => {
        test('reply réémis avec la même clé : absorbé, aucun jumeau dans le thread', async () => {
            const KEY = 'reply-1170-manager-absorb';
            // Le message original reçu (adressé à FROM pour que le lookup
            // callerId=FROM passe la garde d'accès sender-OR-recipient).
            const original = await messageManager.sendMessage(
                TO, FROM, 'Dispatch', 'Exécute ceci', 'HIGH'
            );

            // Premier reply : forme reply complète (reply_to + thread_id).
            const first = await messageManager.sendMessage(
                FROM, TO, 'Re: Dispatch', 'Réponse livrée', 'HIGH',
                ['reply'], original.id, original.id,
                { messageId: KEY }
            );
            expect(first.id).toBe(KEY);
            expect(first.reply_to).toBe(original.id);
            expect(first.thread_id).toBe(original.id);

            // Retry après réponse serveur perdue : même clé, même expéditeur.
            const second = await messageManager.sendMessage(
                FROM, TO, 'Re: Dispatch', 'Réponse livrée', 'HIGH',
                ['reply'], original.id, original.id,
                { messageId: KEY }
            );

            // Absorption : même entrée, même timestamp.
            expect(second.id).toBe(KEY);
            expect(second.timestamp).toBe(first.timestamp);

            // L'inbox du destinataire contient l'original + UNE réponse.
            const inboxFiles = (await fs.readdir(inboxPath)).filter(f => f.endsWith('.json'));
            expect(inboxFiles).toHaveLength(2);
            expect(inboxFiles).toContain(`${KEY}.json`);
            expect(inboxFiles).toContain(`${original.id}.json`);
        });

        test('collision sur un reply : repli id auto, l\'entrée étrangère intacte', async () => {
            const KEY = 'reply-1170-manager-collision';
            const foreign = {
                id: KEY,
                from: 'myia-po-2023:roo-extensions',
                to: TO,
                subject: 'Re: Dispatch',
                body: 'Réponse d\'un autre siège',
                priority: 'LOW',
                timestamp: '2026-09-22T03:00:00.000Z',
                status: 'unread'
            };
            await fs.writeFile(join(inboxPath, `${KEY}.json`), JSON.stringify(foreign, null, 2), 'utf-8');

            const msg = await messageManager.sendMessage(
                FROM, TO, 'Re: Dispatch', 'Ma réponse', 'HIGH',
                ['reply'], 'msg-original-x', undefined,
                { messageId: KEY }
            );

            // Repli : id auto, l'entrée étrangère jamais écrasée.
            expect(msg.id).not.toBe(KEY);
            const after = JSON.parse(await fs.readFile(join(inboxPath, `${KEY}.json`), 'utf-8'));
            expect(after).toEqual(foreign);
            expect(existsSync(join(inboxPath, `${msg.id}.json`))).toBe(true);
        });
    });
});
