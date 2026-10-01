/**
 * Shared file-path validation for export handlers.
 *
 * #4005 fix: Replaces the duplicated validation that lived in
 * export-data.ts (validateExportFilePath) and XmlExporterService (validateFilePath).
 * Centralizing avoids silent divergence of the two implementations.
 */

import { StateManagerError } from '../types/errors.js';

/** Maximum allowed file-path length (Windows MAX_PATH) */
export const MAX_EXPORT_FILE_PATH_LENGTH = 260;

/** Patterns considered dangerous: traversal, absolute paths, Windows forbidden chars */
const DANGEROUS_PATTERNS: ReadonlyArray<RegExp> = [
  /\.\./,          // Directory traversal
  /^[\/\\]/,       // Absolute paths
  /[<>:"|?*]/,     // Windows forbidden characters
];

/**
 * Validate that a file path is safe for export.
 *
 * Throws StateManagerError with code PATH_TRAVERSAL_DETECTED or PATH_TOO_LONG
 * on failure. Used by JSON/CSV/XML/JSON export handlers.
 *
 * @param filePath Candidate output path
 * @param sourceTag Logical origin of the call (e.g. 'ExportDataTool', 'XmlExporterService')
 */
export function validateExportFilePath(filePath: string, sourceTag: string): void {
  if (DANGEROUS_PATTERNS.some(pattern => pattern.test(filePath))) {
    throw new StateManagerError(
      `Unsafe file path: ${filePath}`,
      'PATH_TRAVERSAL_DETECTED',
      sourceTag,
      { filePath }
    );
  }

  if (filePath.length > MAX_EXPORT_FILE_PATH_LENGTH) {
    throw new StateManagerError(
      `File path too long (${filePath.length} chars, max ${MAX_EXPORT_FILE_PATH_LENGTH})`,
      'PATH_TOO_LONG',
      sourceTag,
      { filePath, length: filePath.length, maxLength: MAX_EXPORT_FILE_PATH_LENGTH }
    );
  }
}