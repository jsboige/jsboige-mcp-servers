/**
 * Setup spécifique pour les tests de FileLockManager
 * 
 * Ce fichier désactive le mock de fs pour les tests de FileLockManager
 * car proper-lockfile a besoin du vrai système de fichiers.
 */

import { vi, beforeAll } from 'vitest';

beforeAll(() => {
  // Désactiver le mock de fs pour les tests de FileLockManager
  // car proper-lockfile a besoin du vrai système de fichiers
  vi.unmock('fs');
  vi.unmock('fs/promises');
});
