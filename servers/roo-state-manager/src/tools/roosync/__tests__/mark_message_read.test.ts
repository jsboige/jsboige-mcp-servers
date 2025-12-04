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
import * as serverHelpers from '../../../utils/server-helpers.js';

// Mock fs module
vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
  readdirSync: vi.fn(),
  statSync: vi.fn(),
  unlinkSync: vi.fn(),
  promises: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    readdir: vi.fn(),
    stat: vi.fn(),
    mkdir: vi.fn(),
    rm: vi.fn(),
    unlink: vi.fn()
  }
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  readdir: vi.fn(),
  stat: vi.fn(),
  mkdir: vi.fn(),
  rm: vi.fn(),
  unlink: vi.fn(),
  mkdtemp: vi.fn(),
  rmdir: vi.fn()
}));

describe('roosync_mark_message_read', () => {
  let testSharedStatePath: string;
  let messageManager: MessageManager;
  let mockFiles: Map<string, string>;
  let mockDirs: Set<string>;

  beforeEach(async () => {
    // Initialiser les mocks
    mockFiles = new Map<string, string>();
    mockDirs = new Set<string>();
    
    testSharedStatePath = join(__dirname, '../../../__test-data__/shared-state-mark-read');
    
    const dirs = [
      join(testSharedStatePath, 'messages/inbox'),
      join(testSharedStatePath, 'messages/sent'),
      join(testSharedStatePath, 'messages/archive')
    ];
    dirs.forEach(dir => {
      mockDirs.add(dir);
    });

    // Configurer les mocks fs
    const fs = await import('fs');
    (fs.existsSync as any).mockImplementation((path: string) => {
      return mockDirs.has(path) || mockFiles.has(path);
    });
    
    (fs.mkdirSync as any).mockImplementation((path: string, options?: any) => {
      mockDirs.add(path);
    });
    
    (fs.readFileSync as any).mockImplementation((path: string) => {
      if (mockFiles.has(path)) {
        return mockFiles.get(path)!;
      }
      throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    });
    
    (fs.writeFileSync as any).mockImplementation((path: string, content: string) => {
      mockFiles.set(path, content);
    });
    
    (fs.readdirSync as any).mockImplementation((path: string) => {
      const files: string[] = [];
      for (const [filePath] of mockFiles) {
        if (filePath.startsWith(path)) {
          const fileName = filePath.substring(path.length + 1);
          if (fileName.includes('/')) continue;
          files.push(fileName);
        }
      }
      return files;
    });
    
    (fs.rmSync as any).mockImplementation((path: string, options?: any) => {
      if (options?.recursive) {
        // Supprimer récursivement
        for (const [filePath] of mockFiles) {
          if (filePath.startsWith(path)) {
            mockFiles.delete(filePath);
          }
        }
        mockDirs.delete(path);
      } else {
        mockFiles.delete(path);
        mockDirs.delete(path);
      }
    });

    // Configurer les mocks fs.promises
    const fsPromises = fs.promises as any;
    fsPromises.readFile.mockImplementation((path: string) => {
      if (mockFiles.has(path)) {
        return Promise.resolve(mockFiles.get(path)!);
      }
      return Promise.reject(new Error(`ENOENT: no such file or directory, open '${path}'`));
    });
    
    fsPromises.writeFile.mockImplementation((path: string, content: string) => {
      mockFiles.set(path, content);
      return Promise.resolve();
    });
    
    fsPromises.readdir.mockImplementation((path: string) => {
      const files: string[] = [];
      for (const [filePath] of mockFiles) {
        if (filePath.startsWith(path)) {
          const fileName = filePath.substring(path.length + 1);
          if (fileName.includes('/')) continue;
          files.push(fileName);
        }
      }
      return Promise.resolve(files);
    });
    
    fsPromises.unlink.mockImplementation((path: string) => {
      mockFiles.delete(path);
      return Promise.resolve();
    });

    messageManager = new MessageManager(testSharedStatePath);

    // Mock getSharedStatePath pour pointer vers le répertoire de test
    vi.spyOn(serverHelpers, 'getSharedStatePath').mockReturnValue(testSharedStatePath);
  });

  afterEach(() => {
    vi.restoreAllMocks();
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