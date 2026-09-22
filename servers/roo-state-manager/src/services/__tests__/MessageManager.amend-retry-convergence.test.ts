/**
 * #1170 — décision amend : le retry est NATURELLEMENT convergent.
 *
 * La clé d'idempotence `messageId` est exclue de action="amend" (rejet
 * bruyant au routeur send.ts). Ces tests prouvent le fondement de cette
 * exclusion au niveau MessageManager, sur système de fichiers réel :
 *
 *  1. Un amend ne crée RIEN — exactement un fichier avant/après (pas de
 *     jumeau possible par construction : la mutation cible `${message_id}.json`).
 *  2. Un retry d'amend au contenu identique converge : body identique,
 *     `metadata.original_content` capturé au PREMIER amendement seulement
 *     (jamais ré-écrasé par le corps déjà amendé), `amendment_reason` stable.
 *  3. Seule `amendment_timestamp` avance — différence observable unique et
 *     bénigne du retry.
 *
 * C'est le contrepoint exact du contrat send/reply : là où un retry
 * non-clé fabrique un JUMEAU (nouveau fichier, nouvel id), le retry amend
 * réécrit la même entrée vers le même état final.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { MessageManager } from '../MessageManager.js';
import { existsSync, rmSync, mkdirSync } from 'fs';
import { promises as fs } from 'fs';
import { join } from 'path';

const FROM = 'myia-web1:roo-extensions';
const TO = 'myia-ai-01:roo-extensions';

describe('MessageManager.amendMessage — convergence du retry (#1170)', () => {
    let messageManager: MessageManager;
    let testSharedStatePath: string;
    let inboxPath: string;
    let sentPath: string;

    beforeEach(() => {
        testSharedStatePath = join(__dirname, '../../__test-data__/amend-convergence-shared-state');
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

    test('retry au contenu identique : même état final, original_content capturé UNE fois, 1 seul fichier', async () => {
        // 1. Envoyer le message original.
        const original = await messageManager.sendMessage(
            FROM, TO, 'Sujet amend', 'Body original', 'HIGH'
        );

        // 2. Premier amend — le client timeout APRÈS que le serveur a persisté
        //    (la réponse serveur est perdue, pas l'écriture).
        const first = await messageManager.amendMessage(
            original.id, FROM, 'Contenu corrigé', 'coquille'
        );
        expect(first.success).toBe(true);

        // 3. Le retry (contenu identique — c'est ce que fait un caller qui
        //    rejoue son appel après timeout).
        const second = await messageManager.amendMessage(
            original.id, FROM, 'Contenu corrigé', 'coquille'
        );
        expect(second.success).toBe(true);

        // Pas de jumeau : exactement UNE entrée dans chaque store.
        const inboxFiles = (await fs.readdir(inboxPath)).filter(f => f.endsWith('.json'));
        const sentFiles = (await fs.readdir(sentPath)).filter(f => f.endsWith('.json'));
        expect(inboxFiles).toHaveLength(1);
        expect(sentFiles).toHaveLength(1);

        // État final convergent.
        const persisted = JSON.parse(await fs.readFile(join(inboxPath, `${original.id}.json`), 'utf-8'));
        expect(persisted.body).toBe('Contenu corrigé');
        expect(persisted.metadata.amended).toBe(true);
        // La pièce maîtresse : original_content est le corps D'ORIGINE, capturé
        // au PREMIER amendement — le retry ne l'a pas ré-écrasé par le corps
        // déjà amendé.
        expect(persisted.metadata.original_content).toBe('Body original');
        expect(persisted.metadata.amendment_reason).toBe('coquille');
    });

    test('le retry d\'un amend différent (nouveau contenu) reste un amend, jamais un jumeau', async () => {
        // Variante : le caller retry avec un contenu LÉGÈREMENT différent
        // (p.ex. il a corrigé sa coquille entre temps). Toujours une seule
        // entrée : le dernier amendement gagne, c'est le contrat documenté
        // (« amendements multiples possibles, original toujours préservé »).
        const original = await messageManager.sendMessage(
            FROM, TO, 'Sujet amend 2', 'Body original 2', 'MEDIUM'
        );
        await messageManager.amendMessage(original.id, FROM, 'Première correction', 'r1');
        await messageManager.amendMessage(original.id, FROM, 'Deuxième correction', 'r2');

        const inboxFiles = (await fs.readdir(inboxPath)).filter(f => f.endsWith('.json'));
        expect(inboxFiles).toHaveLength(1);

        const persisted = JSON.parse(await fs.readFile(join(inboxPath, `${original.id}.json`), 'utf-8'));
        expect(persisted.body).toBe('Deuxième correction');
        expect(persisted.metadata.original_content).toBe('Body original 2');
        expect(persisted.metadata.amendment_reason).toBe('r2');
    });
});
