/**
 * Tests d'intégration pour PresenceManager avec FileLockManager.simple
 *
 * Ce fichier teste l'intégration du système de verrouillage simple
 * dans PresenceManager.
 *
 * @module PresenceManager.integration.test
 * @version 1.0.0
 */

// Importer le setup spécifique pour désactiver le mock de fs
import '../../../setup/presence.setup.js';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { PresenceManager } from '@/services/roosync/PresenceManager';
import { RooSyncConfig } from '@/config/roosync-config';

/**
 * Classe de test pour PresenceManager
 */
describe('PresenceManager Integration with FileLockManager.simple', () => {
  let presenceManager: PresenceManager;
  let testDir: string;
  let config: RooSyncConfig;

  /**
   * Configuration avant chaque test
   */
  beforeEach(async () => {
    // Créer un répertoire de test dans le workspace
    testDir = join(process.cwd(), 'test-presence-integration-' + Date.now());
    await fs.mkdir(testDir, { recursive: true });
    
    // Configuration de test
    config = {
      machineId: 'test-machine',
      sharedPath: testDir,
      autoSync: false,
      conflictStrategy: 'manual',
      logLevel: 'info'
    };
    
    // Créer une instance de PresenceManager
    presenceManager = new PresenceManager(config);
  });

  /**
   * Nettoyage après chaque test
   */
  afterEach(async () => {
    // Nettoyer le répertoire de test
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch (error) {
      // Ignorer les erreurs de nettoyage
    }
  });

  /**
   * Test: Mise à jour de présence avec verrouillage
   */
  it('should update presence with lock', async () => {
    const result = await presenceManager.updatePresence('test-machine', {
      status: 'online',
      mode: 'code'
    });

    expect(result.success).toBe(true);
    expect(result.conflictDetected).toBe(false);

    // Vérifier que le fichier a été créé
    const presenceFile = join(testDir, 'presence', 'test-machine.json');
    const exists = await fs.access(presenceFile).then(() => true).catch(() => false);
    expect(exists).toBe(true);

    // Vérifier le contenu
    const content = await fs.readFile(presenceFile, 'utf-8');
    const data = JSON.parse(content);
    expect(data.id).toBe('test-machine');
    expect(data.status).toBe('online');
  });

  /**
   * Test: Lecture de présence
   */
  it('should read presence', async () => {
    // D'abord créer une présence
    await presenceManager.updatePresence('test-machine', {
      status: 'online',
      mode: 'code'
    });

    // Puis la lire
    const presence = await presenceManager.readPresence('test-machine');

    expect(presence).not.toBeNull();
    expect(presence?.id).toBe('test-machine');
    expect(presence?.status).toBe('online');
  });

  /**
   * Test: Suppression de présence avec verrouillage
   */
  it('should remove presence with lock', async () => {
    // D'abord créer une présence
    await presenceManager.updatePresence('test-machine', {
      status: 'online',
      mode: 'code'
    });

    // Puis la supprimer
    const result = await presenceManager.removePresence('test-machine');

    expect(result).toBe(true);

    // Vérifier que le fichier a été supprimé
    const presenceFile = join(testDir, 'presence', 'test-machine.json');
    const exists = await fs.access(presenceFile).then(() => true).catch(() => false);
    expect(exists).toBe(false);
  });

  /**
   * Test: Mise à jour de présence courante
   */
  it('should update current presence', async () => {
    const result = await presenceManager.updateCurrentPresence('online', 'code');

    expect(result.success).toBe(true);
    expect(result.conflictDetected).toBe(false);

    // Vérifier le contenu
    const presenceFile = join(testDir, 'presence', 'test-machine.json');
    const content = await fs.readFile(presenceFile, 'utf-8');
    const data = JSON.parse(content);
    expect(data.id).toBe('test-machine');
    expect(data.status).toBe('online');
    expect(data.mode).toBe('code');
  });

  /**
   * Test: Lister toutes les présences
   */
  it('should list all presence', async () => {
    // Créer plusieurs présences
    await presenceManager.updatePresence('test-machine', { status: 'online', mode: 'code' });
    await presenceManager.updatePresence('test-machine-2', { status: 'offline', mode: 'code' });

    const allPresence = await presenceManager.listAllPresence();

    expect(allPresence).toHaveLength(2);
    expect(allPresence[0].id).toBe('test-machine');
    expect(allPresence[1].id).toBe('test-machine-2');
  });
});
