/**
 * Setup pour les tests E2E sur machines réelles
 *
 * Ce fichier de setup NE DOIT PAS contenir de mocks car nous voulons
 * tester les outils RooSync sur des machines réelles.
 *
 * @module tests/e2e/setup-real-machines
 */

import { beforeAll, afterEach } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';

// Configuration de test globale
beforeAll(() => {
  // S'assurer que l'environnement de test est propre
  console.log('[SETUP REAL MACHINES] Configuration de test E2E initialisée');
  console.log('[SETUP REAL MACHINES] ATTENTION: Tests sur machines réelles - PAS de mocks');

  // Configurer les variables d'environnement pour RooSync
  // Utiliser un répertoire temporaire pour les tests
  const testSharedPath = join(tmpdir(), 'roosync-test-shared');
  process.env.ROOSYNC_SHARED_PATH = testSharedPath;
  process.env.ROOSYNC_MACHINE_ID = 'myia-ai-01';

  console.log(`[SETUP REAL MACHINES] ROOSYNC_SHARED_PATH: ${testSharedPath}`);
  console.log(`[SETUP REAL MACHINES] ROOSYNC_MACHINE_ID: ${process.env.ROOSYNC_MACHINE_ID}`);
});

// Nettoyage après chaque test
afterEach(() => {
  // Nettoyer l'état entre les tests
  console.log('[SETUP REAL MACHINES] Nettoyage après test');
});
