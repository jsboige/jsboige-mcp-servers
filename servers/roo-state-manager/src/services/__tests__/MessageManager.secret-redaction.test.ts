/**
 * #3584 — masquage à la frontière de publication : roosync_messages send/reply/amend.
 *
 * L'issue nomme `roosync_messages send` à côté de `roosync_dashboard append` :
 * un DM est persisté vers le store partagé PUIS le miroir PG, exactement comme
 * un dashboard. Le masquage vit dans `utils/secret-redaction.ts` (définition
 * unique) et est câblé à l'ENTRÉE de `sendMessage` (couvre send ET reply) et
 * d'`applyAmendment` (couvre les deux branches d'amend, PG et fichier).
 *
 * Harness : système de fichiers réel (mirroir de MessageManager.test.ts) +
 * secret connu injecté par `process.env`, comme `dashboard-secret-redaction.test.ts`.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync, mkdirSync } from 'fs';
import { promises as fs } from 'fs';
import { join } from 'path';
import { MessageManager } from '../MessageManager.js';

vi.unmock('fs');
vi.unmock('fs/promises');

/** La fuite fondatrice #3584 : une valeur nue, 64 hex, publiée sans nom de
 *  variable — indistinguable par sa forme d'un SHA git (cf. dashboard test). */
const LEAKED_KEY = '89ed6fb1' + 'a1b2c3d4'.repeat(7);
const GIT_SHA = 'b'.repeat(40);

describe('MessageManager — masquage à la publication (#3584)', () => {
  let messageManager: MessageManager;
  let statePath: string;

  const readSent = async (id: string): Promise<{ subject: string; body: string }> =>
    JSON.parse(await fs.readFile(join(statePath, 'messages', 'sent', `${id}.json`), 'utf8'));

  beforeEach(() => {
    statePath = join(__dirname, '../../__test-data__/shared-state-secret-redaction');
    for (const dir of ['', 'messages', 'messages/inbox', 'messages/sent', 'messages/archive']) {
      const p = join(statePath, dir);
      if (!existsSync(p)) mkdirSync(p, { recursive: true });
    }
    messageManager = new MessageManager(statePath);
    // Le secret que cette machine détient — la couche valeur ne masque que ce qu'elle connaît.
    process.env.EMBEDDINGS_API_KEY = LEAKED_KEY;
  });

  afterEach(async () => {
    delete process.env.EMBEDDINGS_API_KEY;
    if (!existsSync(statePath)) return;
    for (let i = 0; i < 3; i++) {
      try {
        rmSync(statePath, { recursive: true, force: true });
        break;
      } catch (err: unknown) {
        if (i === 2 && (err as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw err;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
  });

  test('sendMessage : une valeur nue connue est masquée dans le corps PERSISTÉ', async () => {
    const msg = await messageManager.sendMessage(
      'machine-a:workspace1', 'machine-b:workspace1', 'rotation',
      `clé active : ${LEAKED_KEY} — consommateur non migré`
    );

    const sent = await readSent(msg.id);
    expect(sent.body).not.toContain(LEAKED_KEY);
    expect(sent.body).toContain('<redacted:EMBEDDINGS_API_KEY>');
    // La prose survit — le message reste utile.
    expect(sent.body).toContain('consommateur non migré');
  });

  test('sendMessage : le SUJET est masqué aussi', async () => {
    const msg = await messageManager.sendMessage(
      'machine-a:workspace1', 'machine-b:workspace1', `clé ${LEAKED_KEY}`, 'corps anodin'
    );

    const sent = await readSent(msg.id);
    expect(sent.subject).not.toContain(LEAKED_KEY);
    expect(sent.subject).toContain('<redacted:EMBEDDINGS_API_KEY>');
  });

  test('sendMessage : les formes auto-descriptives sont masquées (couche forme, tout détenteur)', async () => {
    const msg = await messageManager.sendMessage(
      'machine-a:workspace1', 'machine-b:workspace1', 'rotation',
      `Authorization: Bearer ${'z'.repeat(32)} et PASSWORD=hunter2selftest`
    );

    const sent = await readSent(msg.id);
    expect(sent.body).not.toContain('z'.repeat(32));
    expect(sent.body).not.toContain('hunter2selftest');
  });

  test("sendMessage : un SHA git de 40 hex n'est PAS masqué (anti-sur-masquage)", async () => {
    const msg = await messageManager.sendMessage(
      'machine-a:workspace1', 'machine-b:workspace1', 'build',
      `gitlink == ${GIT_SHA} sur main`
    );

    const sent = await readSent(msg.id);
    expect(sent.body).toContain(GIT_SHA);
  });

  test('sendMessage : un message ordinaire reste byte-for-byte intact', async () => {
    const body = '[DONE] aucun secret ici — travail livré, PR #1234 mergée';
    const msg = await messageManager.sendMessage(
      'machine-a:workspace1', 'machine-b:workspace1', 'rapport', body
    );

    const sent = await readSent(msg.id);
    expect(sent.body).toBe(body);
  });

  test('amendMessage : le nouveau contenu est masqué', async () => {
    const msg = await messageManager.sendMessage(
      'machine-a:workspace1', 'machine-b:workspace1', 'rotation', 'corps initial anodin'
    );

    await messageManager.amendMessage(
      msg.id, 'machine-a:workspace1', `correction : ${LEAKED_KEY} est la clé`, 'complément'
    );

    const sent = await readSent(msg.id);
    expect(sent.body).not.toContain(LEAKED_KEY);
    expect(sent.body).toContain('<redacted:EMBEDDINGS_API_KEY>');
  });
});
