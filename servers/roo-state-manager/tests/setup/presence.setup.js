/**
 * Setup spécifique pour les tests d'intégration de PresenceManager
 * 
 * Ce fichier désactive le mock de fs pour les tests d'intégration
 * car PresenceManager a besoin du vrai système de fichiers pour créer
 * et manipuler les fichiers de présence.
 */

import { vi, beforeAll } from 'vitest';

beforeAll(() => {
  // Désactiver le mock de fs pour les tests d'intégration de PresenceManager
  // car nous avons besoin du vrai système de fichiers
  vi.unmock('fs');
  vi.unmock('fs/promises');
});
