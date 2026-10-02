import * as path from 'path';
import { existsSync } from 'fs';

/**
 * Détecte la racine roo-extensions en remontant l'arborescence depuis process.cwd().
 * Recherche un répertoire contenant CLAUDE.md (fichier caractéristique de roo-extensions).
 *
 * #2406 P1-c — extraite d'InventoryService : le root portable est partagé entre
 * l'inventaire (scripts, configs) et la normalisation des chemins (%ROO_ROOT%).
 * process.cwd() est le dossier du serveur, PAS la racine du dépôt.
 */
export function findRooExtensionsRoot(): string {
  // Si la variable d'environnement est définie, l'utiliser
  if (process.env.ROO_EXTENSIONS_PATH) {
    return process.env.ROO_EXTENSIONS_PATH;
  }

  let currentPath = process.cwd();

  // Remonter jusqu'à 10 niveaux pour trouver la racine
  for (let i = 0; i < 10; i++) {
    // Vérifier si on est à la racine roo-extensions (présence de CLAUDE.md)
    if (existsSync(path.join(currentPath, 'CLAUDE.md'))) {
      return currentPath;
    }
    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) break; // Atteint la racine du système
    currentPath = parentPath;
  }

  // Fallback au cwd si CLAUDE.md non trouvé
  return process.cwd();
}
