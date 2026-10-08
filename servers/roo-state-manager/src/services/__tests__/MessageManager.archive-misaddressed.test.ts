/**
 * #4131 G-A (blocage B8) — l'archivage a la portée de la MACHINE, la lecture non.
 *
 * Un message adressé à `X:<demi-adresse non résoluble>` (clé de dashboard, clé
 * de projet Claude, workspace renommé) est porté par l'inbox de X et n'est
 * lisible par aucun workspace de X : `matchesRecipient` rejette les deux. Comme
 * `archiveMessageFunc` passait par `getMessage` — le contrôle de LECTURE — le
 * message était aussi archivable par personne et devenait immortel dans le
 * store. Mesuré sur ai-01 : `hermes-dm-condense-lock-20260927T1358Z` →
 * `myia-ai-01:workspace-cluster-coordination` (une clé de dashboard, pas un
 * workspace).
 *
 * Ce fichier tient les deux moitiés de la correction, et surtout la seconde :
 * la portée nouvelle est la MACHINE, pas « tout le monde ».
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { MessageManager } from '../MessageManager.js';
import { MessageManagerErrorCode } from '../../types/errors.js';
import { matchesMachineTarget } from '../../utils/message-helpers.js';
import { existsSync, rmSync, mkdirSync } from 'fs';
import { promises as fs } from 'fs';
import { join } from 'path';

vi.unmock('fs');
vi.unmock('fs/promises');

describe('#4131 G-A / B8 — archivage des messages mal adressés', () => {
  let messageManager: MessageManager;
  let root: string;

  beforeEach(async () => {
    // Racine dédiée : `MessageManager.test.ts` utilise `shared-state`, deux
    // fichiers qui la partageraient se marcheraient dessus en parallèle.
    root = join(__dirname, '../../__test-data__/shared-state-b8-archive');
    const dirs = [
      root,
      join(root, 'messages'),
      join(root, 'messages/inbox'),
      join(root, 'messages/sent'),
      join(root, 'messages/archive'),
    ];
    for (const dir of dirs) {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
    messageManager = new MessageManager(root);
  });

  afterEach(async () => {
    if (existsSync(root)) {
      for (let i = 0; i < 3; i++) {
        try {
          rmSync(root, { recursive: true, force: true });
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 50));
        }
      }
    }
  });

  /**
   * Le phantom est écrit directement sur disque : `sendMessage` refuse les
   * adresses non résolubles depuis po-2024 (item 1 de G-A), donc le seul moyen
   * de reproduire l'état mesuré sur ai-01 est de poser le fichier à la main —
   * exactement ce que le runbook d'archive a trouvé dans GDrive.
   */
  async function writeMisaddressed(id: string, to: string): Promise<void> {
    const base = await messageManager.sendMessage(
      'myia-po-2023', 'myia-po-2024', 'Sujet', 'Corps', 'HIGH'
    );
    await fs.writeFile(
      join(root, 'messages/inbox', `${id}.json`),
      JSON.stringify({ ...base, id, to }),
      'utf-8'
    );
  }

  const UNRESOLVABLE = 'myia-ai-01:workspace-cluster-coordination';

  test('lecture : refusée — la moitié workspace ne se résout à rien', async () => {
    await writeMisaddressed('msg-b8-read', UNRESOLVABLE);
    await expect(messageManager.getMessage('msg-b8-read', 'myia-ai-01:roo-extensions'))
      .rejects.toMatchObject({ code: MessageManagerErrorCode.ACCESS_DENIED });
  });

  test('archivage : la MACHINE destinataire peut archiver ce qui est mal adressé', async () => {
    await writeMisaddressed('msg-b8-archive', UNRESOLVABLE);
    const seen = await messageManager.getMessage(
      'msg-b8-archive', 'myia-ai-01:roo-extensions', 'archive'
    );
    expect(seen).not.toBeNull();
    expect(seen!.to).toBe(UNRESOLVABLE);
    // Et l'archivage lui-même aboutit : c'est le geste que le blocage B8
    // décrivait comme impossible (« aucun appelant ne peut l'archiver »).
    expect(await messageManager.archiveMessage('msg-b8-archive')).toBe(true);
  });

  test('archivage : une AUTRE machine reste refusée — la portée est la machine, pas la flotte', async () => {
    await writeMisaddressed('msg-b8-foreign', UNRESOLVABLE);
    await expect(
      messageManager.getMessage('msg-b8-foreign', 'myia-po-2025:roo-extensions', 'archive')
    ).rejects.toMatchObject({ code: MessageManagerErrorCode.ACCESS_DENIED });
  });

  test('archivage : le défaut reste la lecture — omettre la portée ne rouvre pas la porte', async () => {
    await writeMisaddressed('msg-b8-default', UNRESOLVABLE);
    await expect(messageManager.getMessage('msg-b8-default', 'myia-ai-01:roo-extensions'))
      .rejects.toMatchObject({ code: MessageManagerErrorCode.ACCESS_DENIED });
  });

  test('archivage : enveloppe seule — la machine peut archiver ce qu’elle ne peut pas lire', async () => {
    // La frontière inter-workspace est délibérée et testée (machine identique,
    // autre workspace → refus) : le relâchement ne doit pas la déplacer. Il
    // ouvre l'archivage, pas la lecture — donc il rend l'enveloppe, jamais le
    // corps. Un simple drapeau qui retournerait le message entier ferait
    // exactement ce que ce test interdit.
    const msg = await messageManager.sendMessage(
      'myia-po-2023', 'myia-ai-01:autre-workspace', 'Sujet confidentiel', 'Corps confidentiel'
    );

    // 1. La lecture reste refusée, sans drapeau.
    await expect(messageManager.getMessage(msg.id, 'myia-ai-01:roo-extensions'))
      .rejects.toMatchObject({ code: MessageManagerErrorCode.ACCESS_DENIED });

    // 2. Le rapport d'archivage obtient de quoi nommer le message…
    const seen = await messageManager.getMessage(msg.id, 'myia-ai-01:roo-extensions', 'archive');
    expect(seen).not.toBeNull();
    expect(seen!.subject).toBe('Sujet confidentiel');
    expect(seen!.from).toBe('myia-po-2023');
    expect(seen!.to).toBe('myia-ai-01:autre-workspace');

    // 3. …et rien de plus.
    expect(seen!.body).toBe('');
  });

  test('archivage : le corps est également retiré quand l’adresse ne se résout à rien', async () => {
    await writeMisaddressed('msg-b8-envelope', UNRESOLVABLE);
    const seen = await messageManager.getMessage(
      'msg-b8-envelope', 'myia-ai-01:roo-extensions', 'archive'
    );
    expect(seen!.to).toBe(UNRESOLVABLE);
    expect(seen!.body).toBe('');
  });
});

describe('#4131 G-A / item 1 — refus à l’envoi des adresses non résolubles', () => {
  let messageManager: MessageManager;
  let root: string;

  beforeEach(() => {
    root = join(__dirname, '../../__test-data__/shared-state-b8-send');
    for (const dir of [
      root,
      join(root, 'messages'),
      join(root, 'messages/inbox'),
      join(root, 'messages/sent'),
      join(root, 'messages/archive'),
    ]) {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
    messageManager = new MessageManager(root);
  });

  afterEach(() => {
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  });

  test('un second deux-points ne peut correspondre à aucun workspace → refusé', async () => {
    await expect(messageManager.sendMessage('myia-po-2023', 'myia-po-2024:a:b', 'S', 'C'))
      .rejects.toMatchObject({ code: MessageManagerErrorCode.INVALID_RECIPIENT });
  });

  test('une machine vide ne correspond à aucune machine → refusée', async () => {
    await expect(messageManager.sendMessage('myia-po-2023', ':roo-extensions', 'S', 'C'))
      .rejects.toMatchObject({ code: MessageManagerErrorCode.INVALID_RECIPIENT });
  });

  test('les adresses légitimes passent toujours (contrôle positif)', async () => {
    await expect(messageManager.sendMessage('myia-po-2023', 'myia-po-2024', 'S', 'C'))
      .resolves.toBeTruthy();
    await expect(messageManager.sendMessage('myia-po-2023', 'myia-po-2024:roo-extensions', 'S', 'C'))
      .resolves.toBeTruthy();
  });
});

describe('#4131 G-A / B8 — matchesMachineTarget (prédicat pur)', () => {
  test('machine destinataire, demi-adresse non résoluble → vrai', () => {
    expect(matchesMachineTarget('myia-ai-01:workspace-cluster-coordination', 'myia-ai-01')).toBe(true);
    expect(matchesMachineTarget('myia-ai-01:c--dev-roo-extensions', 'myia-ai-01')).toBe(true);
  });

  test('machine destinataire sans workspace → vrai', () => {
    expect(matchesMachineTarget('myia-ai-01', 'myia-ai-01')).toBe(true);
  });

  test('broadcast → vrai (chaque machine porte sa copie)', () => {
    expect(matchesMachineTarget('all', 'myia-po-2023')).toBe(true);
    expect(matchesMachineTarget('All', 'myia-po-2023')).toBe(true);
  });

  test('autre machine → faux', () => {
    expect(matchesMachineTarget('myia-ai-01:roo-extensions', 'myia-po-2023')).toBe(false);
    expect(matchesMachineTarget('myia-ai-01', 'myia-po-2023')).toBe(false);
  });

  test('canonicalisation respectée (formes courtes héritées, #3292)', () => {
    expect(matchesMachineTarget('po-2023:roo-extensions', 'myia-po-2023')).toBe(true);
    expect(matchesMachineTarget('myia-po-2023', 'po-2023')).toBe(true);
  });
});
