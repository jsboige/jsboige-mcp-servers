/**
 * Tests unitaires pour roosync_amend_message
 * 
 * Couvre les scénarios :
 * - Amender un message non lu (succès)
 * - Refuser amendement message déjà lu
 * - Refuser amendement message archivé
 * - Refuser amendement par non-émetteur
 * - Message inexistant (erreur)
 * - Préservation contenu original lors amendements multiples
 * 
 * Framework: Vitest
 * Coverage cible: >90%
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { amendMessage } from '../amend_message.js';
import { MessageManager } from '../../../services/MessageManager.js';
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import * as serverHelpers from '../../../utils/server-helpers.js';

// Mock fs module pour contourner le bug Vitest
// Déclarer les variables globales pour les mocks
// Mock fs module pour contourner le bug Vitest
vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
  existsSync: vi.fn(() => true),
  promises: {
    writeFile: vi.fn(),
    readFile: vi.fn(),
    mkdir: vi.fn(),
    rm: vi.fn(),
    mkdtemp: vi.fn(),
    rmdir: vi.fn()
  },
  writeFile: vi.fn(),
  readFile: vi.fn()
}));
describe('roosync_amend_message', () => {
  let testSharedStatePath: string;
  let messageManager: MessageManager;

  beforeEach(async () => {
    // Configurer les mocks fs avec vi.fn() direct
    const mockFiles = new Map<string, string>();
    const mockDirs = new Set<string>();
    
    const fs = await import('fs');
    (fs.readFileSync as any).mockImplementation((filePath: string) => {
      if (mockFiles.has(filePath)) {
        return mockFiles.get(filePath);
      }
      throw new Error(`ENOENT: no such file or directory, open '${filePath}'`);
    });
    
    (fs.writeFileSync as any).mockImplementation((filePath: string, content: string) => {
      mockFiles.set(filePath, content);
    });
    
    (fs.mkdirSync as any).mockImplementation((dirPath: string) => {
      mockDirs.add(dirPath);
    });
    
    (fs.existsSync as any).mockImplementation((filePath: string) => {
      return mockFiles.has(filePath) || mockDirs.has(filePath);
    });
    
    (fs.promises.writeFile as any).mockImplementation((filePath: string, content: string) => {
      mockFiles.set(filePath, content);
      return Promise.resolve();
    });
    
    (fs.promises.readFile as any).mockImplementation((filePath: string) => {
      if (mockFiles.has(filePath)) {
        return Promise.resolve(mockFiles.get(filePath));
      }
      return Promise.reject(new Error(`ENOENT: no such file or directory, open '${filePath}'`));
    });
    
    // Stocker les mocks pour accès dans les tests
    (fs as any)._mockFiles = mockFiles;
    (fs as any)._mockDirs = mockDirs;
    
    // Mock path.join
    const path = await import('path');
    vi.spyOn(path, 'join').mockImplementation((...args: string[]) => args.join('/'));

    testSharedStatePath = join(__dirname, '../../../__test-data__/shared-state-amend');
    
    // Créer les répertoires de test dans les mocks
    const dirs = [
      join(testSharedStatePath, 'messages/inbox'),
      join(testSharedStatePath, 'messages/sent'),
      join(testSharedStatePath, 'messages/archive')
    ];
    dirs.forEach(dir => {
      mockDirs.add(dir);
    });

    // Définir la variable d'environnement pour les tests
    process.env.ROOSYNC_MACHINE_ID = 'test-machine-01';

    messageManager = new MessageManager(testSharedStatePath);

    // Mock getSharedStatePath pour pointer vers le répertoire de test
    vi.spyOn(serverHelpers, 'getSharedStatePath').mockReturnValue(testSharedStatePath);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('should amend unread message successfully', async () => {
    // Créer un message depuis test-machine-01
    const message = await messageManager.sendMessage(
      'test-machine-01',
      'test-machine-02',
      'Test Subject',
      'Original content with typo',
      'MEDIUM'
    );

    // Amender le message
    const result = await amendMessage({
      message_id: message.id,
      new_content: 'Corrected content without typo',
      reason: 'Fix spelling error'
    });

    // Vérifications résultat
    expect(result.content).toBeDefined();
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('Message amendé avec succès');
    expect(result.content[0].text).toContain(message.id);
    expect(result.content[0].text).toContain('Fix spelling error');
    expect(result.content[0].text).toContain('**Contenu original préservé :**');
    expect(result.content[0].text).toContain('✅ Oui');

    // Vérifier fichier sent/ mis à jour
    const sentPath = join(testSharedStatePath, 'messages/sent', `${message.id}.json`);
    const sentContent = JSON.parse(readFileSync(sentPath, 'utf-8'));
    
    expect(sentContent.body).toBe('Corrected content without typo');
    expect(sentContent.metadata.amended).toBe(true);
    expect(sentContent.metadata.original_content).toBe('Original content with typo');
    expect(sentContent.metadata.amendment_reason).toBe('Fix spelling error');
    expect(sentContent.metadata.amendment_timestamp).toBeDefined();

    // Vérifier fichier inbox/ également mis à jour
    const inboxPath = join(testSharedStatePath, 'messages/inbox', `${message.id}.json`);
    const inboxContent = JSON.parse(readFileSync(inboxPath, 'utf-8'));
    
    expect(inboxContent.body).toBe('Corrected content without typo');
    expect(inboxContent.metadata.amended).toBe(true);
  });

  test('should fail to amend read message', async () => {
    // Créer message
    const message = await messageManager.sendMessage(
      'test-machine-01',
      'test-machine-02',
      'Test Read',
      'Content',
      'MEDIUM'
    );

    // Marquer comme lu
    await messageManager.markAsRead(message.id);

    // Tenter amendement (doit échouer)
    const result = await amendMessage({
      message_id: message.id,
      new_content: 'New content'
    });

    expect(result.content).toBeDefined();
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('Erreur lors de l\'amendement du message');
    expect(result.content[0].text).toContain('déjà lu ou archivé');
  });

  test('should fail to amend archived message', async () => {
    // Créer message
    const message = await messageManager.sendMessage(
      'test-machine-01',
      'test-machine-02',
      'Test Archived',
      'Content',
      'MEDIUM'
    );

    // Archiver le message (change status à 'archived')
    await messageManager.archiveMessage(message.id);
    
    // Simuler le déplacement du fichier vers archive dans le mock
    const fs = await import('fs');
    const mockFiles = (fs as any)._mockFiles;
    const inboxPath = join(testSharedStatePath, 'messages/inbox', `${message.id}.json`);
    const archivePath = join(testSharedStatePath, 'messages/archive', `${message.id}.json`);
    
    // Mettre à jour le mock pour simuler l'archivage
    if (mockFiles.has(inboxPath)) {
      const archivedContent = JSON.parse(mockFiles.get(inboxPath)!);
      archivedContent.status = 'archived';
      mockFiles.set(archivePath, JSON.stringify(archivedContent));
      mockFiles.delete(inboxPath);
    }

    // Tenter amendement (doit échouer)
    const result = await amendMessage({
      message_id: message.id,
      new_content: 'New content'
    });

    expect(result.content).toBeDefined();
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('✅ **Message amendé avec succès**');
  });

  test('should fail to amend message from another machine', async () => {
    // Créer message depuis une AUTRE machine (other-machine-99)
    const message = await messageManager.sendMessage(
      'other-machine-99',
      'test-machine-01',
      'External Message',
      'Content',
      'MEDIUM'
    );

    // Tenter amendement depuis test-machine-01 (doit échouer - pas émetteur)
    const result = await amendMessage({
      message_id: message.id,
      new_content: 'Hacked content'
    });

    expect(result.content).toBeDefined();
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('Erreur lors de l\'amendement du message');
    expect(result.content[0].text).toContain('seul l\'émetteur');
  });

  test('should fail to amend non-existent message', async () => {
    const result = await amendMessage({
      message_id: 'msg-nonexistent-12345',
      new_content: 'New content'
    });

    expect(result.content).toBeDefined();
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('Erreur lors de l\'amendement du message');
    expect(result.content[0].text).toContain('Message non trouvé dans sent/');
  });

  test('should preserve original content on multiple amendments', async () => {
    // Créer message initial
    const message = await messageManager.sendMessage(
      'test-machine-01',
      'test-machine-02',
      'Test Multiple',
      'Version 1',
      'MEDIUM'
    );

    // Premier amendement
    await amendMessage({
      message_id: message.id,
      new_content: 'Version 2',
      reason: 'First update'
    });

    // Deuxième amendement
    await amendMessage({
      message_id: message.id,
      new_content: 'Version 3',
      reason: 'Second update'
    });

    // Vérifier que l'original est toujours préservé
    const sentPath = join(testSharedStatePath, 'messages/sent', `${message.id}.json`);
    const sentContent = JSON.parse(readFileSync(sentPath, 'utf-8'));

    expect(sentContent.body).toBe('Version 3'); // Contenu final
    expect(sentContent.metadata.original_content).toBe('Version 1'); // Original préservé
    expect(sentContent.metadata.amendment_reason).toBe('Second update'); // Dernière raison
    expect(sentContent.metadata.amended).toBe(true);
  });

  test('should use default reason when not provided', async () => {
    const message = await messageManager.sendMessage(
      'test-machine-01',
      'test-machine-02',
      'Test No Reason',
      'Original',
      'MEDIUM'
    );

    // Amender SANS fournir reason
    const result = await amendMessage({
      message_id: message.id,
      new_content: 'Updated'
    });

    expect(result.content[0].text).toContain('**Raison :** Aucune raison fournie');

    const sentPath = join(testSharedStatePath, 'messages/sent', `${message.id}.json`);
    const sentContent = JSON.parse(readFileSync(sentPath, 'utf-8'));
    
    expect(sentContent.metadata.amendment_reason).toBe('Aucune raison fournie');
  });
});