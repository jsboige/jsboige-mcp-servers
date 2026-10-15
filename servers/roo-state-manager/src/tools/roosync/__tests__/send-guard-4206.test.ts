/**
 * Tests du garde à l'envoi #4206 — chemin roosyncSend(action:"send")
 *
 * Le refus doit se produire AVANT toute écriture (messageManager.sendMessage
 * jamais appelé) et l'erreur retournée doit dire quoi faire. La passe
 * (`myia-po-2023`) confirme que le garde n'a pas fermé la porte aux
 * destinataires légitimes.
 *
 * Framework: Vitest
 * Issue: #4206
 *
 * @module roosync/send-guard-4206.test
 */

import { describe, test, expect, afterEach, vi } from 'vitest';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';

// Mock getLocalMachineId and getLocalFullId (identité de l'expéditeur)
vi.mock('../../../utils/message-helpers.js', async () => {
  const actual = await vi.importActual('../../../utils/message-helpers.js');
  return {
    ...actual,
    getLocalMachineId: vi.fn(() => 'test-machine'),
    getLocalFullId: vi.fn(() => 'test-machine'),
    getLocalWorkspaceId: vi.fn(() => undefined)
  };
});

// Mock getSharedStatePath
const testSharedStatePath = join(__dirname, '../../../__test-data__/shared-state-send-guard-4206');
vi.mock('../../../utils/server-helpers.js', () => ({
  getSharedStatePath: () => testSharedStatePath
}));

// Mock getMessageManager : instance réelle sur chemin de test, CONSTRUITE
// UNE fois (lazy singleton dans le mock) et instrumentée — le garde doit
// refuser avant que sendMessage soit appelé.
vi.mock('../../../services/MessageManager.js', async () => {
  const actual = await vi.importActual('../../../services/MessageManager.js') as any;
  let instance: any = null;
  const getTestManager = () => {
    if (!instance) {
      instance = new actual.MessageManager(testSharedStatePath);
      instance.__sendMessageCalls = 0;
      const orig = instance.sendMessage.bind(instance);
      instance.sendMessage = async (...a: unknown[]) => {
        instance.__sendMessageCalls++;
        return orig(...a);
      };
    }
    return instance;
  };
  return {
    ...actual,
    getMessageManager: getTestManager,
    __getTestInstance: () => instance
  };
});

// Import après les mocks
import { roosyncSend } from '../send.js';
import * as MessageManagerModule from '../../../services/MessageManager.js';

function sendCalls(): number {
  return (MessageManagerModule as any).__getTestInstance()?.__sendMessageCalls ?? 0;
}

describe('roosyncSend send — garde à l\'envoi #4206', () => {
  afterEach(() => {
    if (existsSync(testSharedStatePath)) {
      rmSync(testSharedStatePath, { recursive: true, force: true });
    }
  });

  test('po-2023 nu → refus avec suggestion myia-po-2023, AVANT écriture', async () => {
    const result = await roosyncSend({
      action: 'send',
      to: 'po-2023',
      subject: 'test',
      body: 'corps'
    } as any);

    const text = result.content[0].text;
    expect(text).toContain('Erreur');
    expect(text).toContain('machine "po-2023" inconnue');
    expect(text).toContain('myia-po-2023');
    expect(sendCalls()).toBe(0);
  });

  test('global (clé de dashboard) → refus actionnable', async () => {
    const result = await roosyncSend({
      action: 'send',
      to: 'global',
      subject: 'test',
      body: 'corps'
    } as any);

    const text = result.content[0].text;
    expect(text).toContain('Erreur');
    expect(text).toContain('clé de dashboard');
    expect(text).toContain('all | myia-po-2023 | myia-po-2023:roo-extensions');
    expect(sendCalls()).toBe(0);
  });

  test('machine répétée myia-ai-01:myia-ai-01:CoursIA-2 → refus avec suggestion dédupliquée', async () => {
    const result = await roosyncSend({
      action: 'send',
      to: 'myia-ai-01:myia-ai-01:CoursIA-2',
      subject: 'test',
      body: 'corps'
    } as any);

    const text = result.content[0].text;
    expect(text).toContain('Erreur');
    expect(text).toContain('machine répétée');
    expect(text).toContain('myia-ai-01:CoursIA-2');
    expect(sendCalls()).toBe(0);
  });

  test('myia-po-2023 (destinataire légitime) → PAS de refus, la porte reste ouverte', async () => {
    const result = await roosyncSend({
      action: 'send',
      to: 'myia-po-2023',
      subject: 'garde 4206 — passe',
      body: 'corps de test'
    } as any);

    const text = result.content[0].text;
    expect(text).not.toContain('Destinataire invalide');
    expect(sendCalls()).toBeGreaterThan(0);
  });
});
