/**
 * Tests unitaires pour roosync_mark_message_read
 *
 * Couvre les scénarios :
 * - Marquer un message unread comme read (succès)
 * - Message déjà marqué read (info)
 * - Message inexistant (erreur)
 * - Persistance du changement de statut
 *
 * Framework: Vitest
 * Coverage cible: >80%
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { markMessageRead } from '../mark_message_read.js';
import { MessageManager } from '../../../services/MessageManager.js';
import { existsSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';

// Désactiver le mock global de fs pour ce test qui utilise le système de fichiers réel
vi.unmock('fs');
import * as serverHelpers from '../../../utils/server-helpers.js';

describe('roosync_mark_message_read', () => {
  let testSharedStatePath: string;
  let messageManager: MessageManager;

  beforeEach(() => {
    testSharedStatePath = join(__dirname, '../../../__test-data__/shared-state-mark-read');

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

  test('should mark unread message as read', async () => {
    // Créer message unread
    const message = await messageManager.sendMessage(
      'machine1',
      'machine2',
      'Test Mark Read',
      'Body',
      'MEDIUM'
    );

    expect(message.status).toBe('unread');

    // Marquer comme read
    const result = await markMessageRead({ message_id: message.id });

    expect(result.content).toBeDefined();
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('Message marqué comme lu');
    expect(result.content[0].text).toContain('UNREAD → ✅ READ');

    // Vérifier que le statut a changé dans MessageManager
    const updatedMessage = await messageManager.getMessage(message.id);
    expect(updatedMessage?.status).toBe('read');
  });

  test('should handle already read message', async () => {
    const message = await messageManager.sendMessage(
      'machine1',
      'machine2',
      'Already Read',
      'Body',
      'MEDIUM'
    );

    await messageManager.markAsRead(message.id);

    const result = await markMessageRead({ message_id: message.id });

    expect(result.content).toBeDefined();
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('Message déjà marqué comme lu');
    expect(result.content[0].text).toContain('✅ READ');
  });

  test('should return error for non-existent message', async () => {
    const result = await markMessageRead({ message_id: 'msg-nonexistent-123' });

    expect(result.content).toBeDefined();
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('Message introuvable');
    expect(result.content[0].text).toContain('msg-nonexistent-123');
  });

  test('should persist status change in JSON file', async () => {
    const message = await messageManager.sendMessage(
      'machine1',
      'machine2',
      'Persist Test',
      'Body',
      'MEDIUM'
    );

    await markMessageRead({ message_id: message.id });

    // Vérifier persistence via MessageManager
    const updatedMessage = await messageManager.getMessage(message.id);
    expect(updatedMessage?.status).toBe('read');

    // Vérifier que le fichier existe toujours dans inbox avec le bon statut
    const inboxPath = join(testSharedStatePath, 'messages/inbox', `${message.id}.json`);
    expect(existsSync(inboxPath)).toBe(true);
  });
});