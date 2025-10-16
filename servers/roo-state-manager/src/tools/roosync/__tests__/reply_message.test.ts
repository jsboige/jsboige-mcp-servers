/**
 * Tests unitaires pour roosync_reply_message
 * 
 * Couvre les scénarios :
 * - Répondre à un message (succès)
 * - Message original inexistant (erreur)
 * - Vérifier inversion from/to
 * - Vérifier héritage thread_id (avec et sans thread)
 * - Vérifier ajout automatique tag "reply"
 * - Vérifier héritage/override priorité
 * - Vérifier sujet "Re:"
 * 
 * Framework: Vitest
 * Coverage cible: >80%
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { replyMessage } from '../reply_message.js';
import { MessageManager } from '../../../services/MessageManager.js';
import { existsSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import * as serverHelpers from '../../../utils/server-helpers.js';

describe('roosync_reply_message', () => {
  let testSharedStatePath: string;
  let messageManager: MessageManager;

  beforeEach(() => {
    testSharedStatePath = join(__dirname, '../../../__test-data__/shared-state-reply');
    
    const dirs = [
      join(testSharedStatePath, 'messages/inbox'),
      join(testSharedStatePath, 'messages/sent'),
      join(testSharedStatePath, 'messages/archive')
    ];
    dirs.forEach(dir => {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    });

    messageManager = new MessageManager(testSharedStatePath);

    // Mock getSharedStatePath pour pointer vers le répertoire de test
    vi.spyOn(serverHelpers, 'getSharedStatePath').mockReturnValue(testSharedStatePath);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (existsSync(testSharedStatePath)) {
      rmSync(testSharedStatePath, { recursive: true, force: true });
    }
  });

  test('should reply to message successfully', async () => {
    const original = await messageManager.sendMessage(
      'machine1',
      'machine2',
      'Original Message',
      'Original body',
      'HIGH'
    );

    const result = await replyMessage({
      message_id: original.id,
      body: 'This is my reply'
    });

    expect(result.content).toBeDefined();
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('Réponse envoyée avec succès');
    expect(result.content[0].text).toContain('Message Original');
    expect(result.content[0].text).toContain('Votre Réponse');
    expect(result.content[0].text).toContain('This is my reply');
  });

  test('should return error for non-existent message', async () => {
    const result = await replyMessage({
      message_id: 'msg-nonexistent-123',
      body: 'Reply'
    });

    expect(result.content).toBeDefined();
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('Message original introuvable');
    expect(result.content[0].text).toContain('msg-nonexistent-123');
  });

  test('should invert from and to', async () => {
    const original = await messageManager.sendMessage(
      'machineA',
      'machineB',
      'Test',
      'Body',
      'MEDIUM'
    );

    const result = await replyMessage({
      message_id: original.id,
      body: 'Reply body'
    });

    expect(result.content[0].text).toContain('**De :** machineB');
    expect(result.content[0].text).toContain('**À :** machineA');
    expect(result.content[0].text).toContain('(inversé)');
  });

  test('should inherit thread_id when original has no thread', async () => {
    const original = await messageManager.sendMessage(
      'machine1',
      'machine2',
      'No Thread',
      'Body',
      'MEDIUM'
    );

    const result = await replyMessage({
      message_id: original.id,
      body: 'Reply'
    });

    expect(result.content[0].text).toContain('Thread ID');
    expect(result.content[0].text).toContain(original.id);
  });

  test('should inherit thread_id when original has thread', async () => {
    const original = await messageManager.sendMessage(
      'machine1',
      'machine2',
      'Has Thread',
      'Body',
      'MEDIUM',
      undefined,
      'thread-123'
    );

    const result = await replyMessage({
      message_id: original.id,
      body: 'Reply'
    });

    expect(result.content[0].text).toContain('Thread ID');
    expect(result.content[0].text).toContain('thread-123');
  });

  test('should automatically add reply tag', async () => {
    const original = await messageManager.sendMessage(
      'machine1',
      'machine2',
      'Test',
      'Body',
      'MEDIUM'
    );

    const result = await replyMessage({
      message_id: original.id,
      body: 'Reply',
      tags: ['custom']
    });

    expect(result.content[0].text).toContain('Tags :');
    expect(result.content[0].text).toContain('`reply`');
    expect(result.content[0].text).toContain('`custom`');
  });

  test('should inherit priority when not specified', async () => {
    const original = await messageManager.sendMessage(
      'machine1',
      'machine2',
      'Test',
      'Body',
      'URGENT'
    );

    const result = await replyMessage({
      message_id: original.id,
      body: 'Reply'
    });

    // Vérifier dans la section "Votre Réponse" que la priorité est URGENT
    const responseSection = result.content[0].text.split('Votre Réponse')[1];
    expect(responseSection).toContain('URGENT');
  });

  test('should override priority when specified', async () => {
    const original = await messageManager.sendMessage(
      'machine1',
      'machine2',
      'Test',
      'Body',
      'LOW'
    );

    const result = await replyMessage({
      message_id: original.id,
      body: 'Reply',
      priority: 'HIGH'
    });

    // Vérifier que le message original a LOW
    const originalSection = result.content[0].text.split('Message Original')[1].split('Votre Réponse')[0];
    expect(originalSection).toContain('LOW');

    // Vérifier que la réponse a HIGH
    const responseSection = result.content[0].text.split('Votre Réponse')[1];
    expect(responseSection).toContain('HIGH');
  });

  test('should prefix subject with Re:', async () => {
    const original = await messageManager.sendMessage(
      'machine1',
      'machine2',
      'Important Topic',
      'Body',
      'MEDIUM'
    );

    const result = await replyMessage({
      message_id: original.id,
      body: 'Reply'
    });

    expect(result.content[0].text).toContain('**Sujet :** Re: Important Topic');
  });
});