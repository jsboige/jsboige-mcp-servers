/**
 * #4293 — un envoi persisté ne doit jamais être rapporté en échec parce que le
 * heartbeat post-envoi n'a pas pu résoudre le service RooSync (G: absent).
 *
 * Constaté en sonde E2E : sous CHANNEL_PG_PRIMARY=1 et ROOSYNC_SHARED_PATH
 * inexistant, `MessageManager.sendMessage` écrit bien dans PG, puis
 * `(await getRooSyncService())` jette — le `.catch` ne couvrait que
 * `registerHeartbeat`, pas la résolution du service. Le tool renvoyait
 * « Erreur lors de l'opération RooSync Send » sur un message pourtant livré.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockSendMessage, mockGetRooSyncService } = vi.hoisted(() => ({
  mockSendMessage: vi.fn(),
  mockGetRooSyncService: vi.fn(() => { throw new Error('[RooSync Service] RooSync non disponible: chemin absent'); }),
}));

vi.mock('../../../services/lazy-roosync.js', () => ({
  getRooSyncService: mockGetRooSyncService,
}));

vi.mock('../../../services/MessageManager.js', () => ({
  getMessageManager: () => ({ sendMessage: mockSendMessage }),
}));

import { roosyncSend } from '../send.js';

const WATCHED_ENV = ['ROOSYNC_MACHINE_ID', 'ROOSYNC_WORKSPACE_ID'] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const key of WATCHED_ENV) savedEnv[key] = process.env[key];
  process.env.ROOSYNC_MACHINE_ID = 'myia-ai-01';
  process.env.ROOSYNC_WORKSPACE_ID = 'roo-extensions';
  mockSendMessage.mockReset().mockImplementation(async (from: string, to: string, subject: string, body: string) => ({
    id: 'msg-4293-send',
    from,
    to,
    subject,
    body,
    priority: 'LOW',
    status: 'unread',
    timestamp: '2026-10-20T17:00:00.000Z',
    tags: [],
  }));
  mockGetRooSyncService.mockClear();
});

afterEach(() => {
  for (const key of WATCHED_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('#4293 — heartbeat post-envoi non fatal', () => {
  it('un send persisté reste un succès quand getRooSyncService jette', async () => {
    const result = await roosyncSend({
      action: 'send',
      to: 'myia-ai-01:probe-4293',
      subject: '[PROBE #4293] envoi sous PG_PRIMARY',
      body: 'corps',
      priority: 'LOW',
    } as any);

    const text = result.content[0]!.text;
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(text).toContain('Message envoyé avec succès');
    expect(text).not.toContain('Erreur lors de l\'opération');
    // le heartbeat a bien été TENTÉ — il a seulement échoué sans casser le résultat
    expect(mockGetRooSyncService).toHaveBeenCalled();
  });
});