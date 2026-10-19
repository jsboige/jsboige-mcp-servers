/**
 * ms#1339 — send/reply sans `as` : l'ack EXPOSE la dérivation process.
 *
 * Miroir messages du même défaut que dashboard-author-resolution : la lane
 * hermes-cluster-tour (03/10) a posté des messages estampillés passerelle
 * sans le savoir — `as` omis, ack muet. `resolveCallerIdentity` porte
 * désormais `derived: true` quand l'identité vient du process hôte, et les
 * acks send/reply affichent la note ⚠️ correspondante.
 *
 * Bite-test : retirer la note de send.ts fait échouer le premier test ;
 * l'afficher aussi quand `as` est asserté fait échouer le second.
 *
 * Harnais : miroir de send.smoke.test.ts (env + MessageManager routé sur
 * ROOSYNC_SHARED_PATH tmpdir, aucun mock de message-helpers — les
 * getLocal* réels lisent l'environnement).
 *
 * @module tools/roosync/__tests__/send-derived-identity-1339
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../../services/MessageManager.js', async () => {
  const actual = await vi.importActual('../../../services/MessageManager.js') as any;
  return {
    ...actual,
    getMessageManager: () => {
      const sharedPath = process.env.ROOSYNC_SHARED_PATH || os.tmpdir();
      return new actual.MessageManager(sharedPath);
    },
  };
});

import { roosyncSend } from '../send.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('roosync_send — expéditeur dérivé visible dans l\'ack (ms#1339)', () => {
  const testMessagesPath = path.join(os.tmpdir(), '.test-messages-1339');
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.ROOSYNC_SHARED_PATH = testMessagesPath;
    process.env.ROOSYNC_MACHINE_ID = 'smoke-test-sender';
    process.env.ROOSYNC_WORKSPACE_ID = 'smoke-test-ws';
    process.env.ROO_MENTION_EXTRA_RECIPIENTS = 'test-machine-1339';
    delete process.env.ROOSYNC_TRUSTED_CALLER_IDS;
    for (const dir of ['messages/sent', 'messages/inbox', 'messages/archive']) {
      const d = path.join(testMessagesPath, dir);
      if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    }
  });

  afterEach(() => {
    process.env = originalEnv;
    if (fs.existsSync(testMessagesPath)) {
      fs.rmSync(testMessagesPath, { recursive: true, force: true });
    }
  });

  function ackText(result: unknown): string {
    return ((result as { content?: Array<{ text?: string }> }).content ?? [])[0]?.text ?? '';
  }

  it("send sans `as` => l'ack porte la note ⚠️ « Expéditeur résolu du process hôte »", async () => {
    const result = await roosyncSend({
      action: 'send',
      to: 'test-machine-1339',
      subject: 'ms#1339 derived sender ack',
      body: 'le siège passerelle doit voir la dérivation au moment du geste',
    });
    const text = ackText(result);
    expect(text).toContain('Message envoyé avec succès');
    expect(text).toContain('⚠️ **Expéditeur résolu du process hôte**');
    expect(text).toContain('`as` absent');
    // La note dit quoi faire (remède #3591) :
    expect(text).toContain('as: "<machine>:<workspace>"');
  });

  it("send AVEC `as` asserté (trusted) => note délibérément absente", async () => {
    process.env.ROOSYNC_TRUSTED_CALLER_IDS = 'smoke-test-sender';
    const result = await roosyncSend({
      action: 'send',
      to: 'test-machine-1339',
      subject: 'ms#1339 asserted sender ack',
      body: 'pas de bruit quand le siège asserte son identité',
      as: 'smoke-test-sender',
    });
    const text = ackText(result);
    expect(text).toContain('Message envoyé avec succès');
    expect(text).not.toContain('Expéditeur résolu du process hôte');
  });
});
