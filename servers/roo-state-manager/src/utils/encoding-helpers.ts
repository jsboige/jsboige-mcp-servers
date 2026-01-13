/**
 * encoding-helpers.ts - Utilitaires pour la gestion de l'encodage des fichiers
 *
 * Ce module fournit des fonctions utilitaires pour gérer les problèmes d'encodage
 * courants lors de la lecture de fichiers, notamment le BOM UTF-8.
 *
 * @module encoding-helpers
 * @version 1.0.0
 */

/**
 * Supprime le BOM UTF-8 (Byte Order Mark) d'une chaîne de caractères
 *
 * Le BOM UTF-8 est la séquence de bytes: 0xEF 0xBB 0xBF
 * qui apparaît comme le caractère Unicode U+FEFF au début du fichier.
 *
 * Certains éditeurs de texte et outils Windows ajoutent automatiquement
 * ce BOM, ce qui peut causer des erreurs de parsing JSON.
 *
 * @param content - Le contenu du fichier à nettoyer
 * @returns Le contenu sans le BOM UTF-8
 *
 * @example
 * ```typescript
 * const content = await fs.readFile('file.json', 'utf-8');
 * const cleanContent = stripBOM(content);
 * const data = JSON.parse(cleanContent);
 * ```
 */
export function stripBOM(content: string): string {
  // Le BOM UTF-8 est le caractère Unicode U+FEFF (0xFEFF en hexadécimal)
  if (content.charCodeAt(0) === 0xFEFF) {
    return content.slice(1);
  }
  return content;
}

/**
 * Lit un fichier et supprime automatiquement le BOM UTF-8 si présent
 *
 * Cette fonction combine la lecture du fichier et le nettoyage du BOM
 * en une seule opération pour simplifier le code.
 *
 * @param filePath - Le chemin du fichier à lire
 * @param encoding - L'encodage du fichier (défaut: 'utf-8')
 * @returns Le contenu du fichier sans BOM UTF-8
 *
 * @example
 * ```typescript
 * const content = await readFileWithoutBOM('config.json');
 * const data = JSON.parse(content);
 * ```
 */
export async function readFileWithoutBOM(
  filePath: string,
  encoding: BufferEncoding = 'utf-8'
): Promise<string> {
  const fs = await import('fs/promises');
  const content = await fs.readFile(filePath, encoding);
  return stripBOM(content);
}

/**
 * Lit un fichier de manière synchrone et supprime le BOM UTF-8 si présent
 *
 * Version synchrone de readFileWithoutBOM pour les cas où l'async n'est pas nécessaire.
 *
 * @param filePath - Le chemin du fichier à lire
 * @param encoding - L'encodage du fichier (défaut: 'utf-8')
 * @returns Le contenu du fichier sans BOM UTF-8
 *
 * @example
 * ```typescript
 * const content = readFileSyncWithoutBOM('config.json');
 * const data = JSON.parse(content);
 * ```
 */
export function readFileSyncWithoutBOM(
  filePath: string,
  encoding: BufferEncoding = 'utf-8'
): string {
  const fs = require('fs');
  const content = fs.readFileSync(filePath, encoding);
  return stripBOM(content);
}

/**
 * Parse un contenu JSON en supprimant automatiquement le BOM UTF-8
 *
 * Cette fonction combine le nettoyage du BOM et le parsing JSON
 * en une seule opération pour simplifier le code.
 *
 * @param content - Le contenu JSON à parser
 * @returns L'objet JavaScript parsé
 * @throws {SyntaxError} Si le contenu n'est pas du JSON valide
 *
 * @example
 * ```typescript
 * const content = await fs.readFile('file.json', 'utf-8');
 * const data = parseJSONWithoutBOM(content);
 * ```
 */
export function parseJSONWithoutBOM<T = any>(content: string): T {
  const cleanContent = stripBOM(content);
  return JSON.parse(cleanContent) as T;
}

/**
 * Lit et parse un fichier JSON en supprimant automatiquement le BOM UTF-8
 *
 * Cette fonction combine la lecture du fichier, le nettoyage du BOM
 * et le parsing JSON en une seule opération.
 *
 * @param filePath - Le chemin du fichier JSON à lire
 * @param encoding - L'encodage du fichier (défaut: 'utf-8')
 * @returns L'objet JavaScript parsé
 * @throws {SyntaxError} Si le fichier n'est pas du JSON valide
 *
 * @example
 * ```typescript
 * const config = await readJSONFileWithoutBOM('config.json');
 * ```
 */
export async function readJSONFileWithoutBOM<T = any>(
  filePath: string,
  encoding: BufferEncoding = 'utf-8'
): Promise<T> {
  const content = await readFileWithoutBOM(filePath, encoding);
  return JSON.parse(content) as T;
}

/**
 * Lit et parse un fichier JSON de manière synchrone en supprimant le BOM UTF-8
 *
 * Version synchrone de readJSONFileWithoutBOM.
 *
 * @param filePath - Le chemin du fichier JSON à lire
 * @param encoding - L'encodage du fichier (défaut: 'utf-8')
 * @returns L'objet JavaScript parsé
 * @throws {SyntaxError} Si le fichier n'est pas du JSON valide
 *
 * @example
 * ```typescript
 * const config = readJSONFileSyncWithoutBOM('config.json');
 * ```
 */
export function readJSONFileSyncWithoutBOM<T = any>(
  filePath: string,
  encoding: BufferEncoding = 'utf-8'
): T {
  const content = readFileSyncWithoutBOM(filePath, encoding);
  return JSON.parse(content) as T;
}
