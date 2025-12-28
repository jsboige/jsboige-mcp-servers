/**
 * Gestionnaire de messages RooSync
 *
 * Responsable de la gestion des messages et notifications :
 * - Envoi de messages
 * - Réception de messages
 * - Parsing des logs et sorties
 */

import { RooSyncConfig } from '../../config/roosync-config.js';

export class MessageHandler {
  constructor(
    private config: RooSyncConfig
  ) {}

  /**
   * Parse les logs depuis une sortie texte (ex: PowerShell)
   */
  public parseLogs(output: string): string[] {
    return output
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0);
  }

  /**
   * Parse les changements depuis une sortie texte
   */
  public parseChanges(output: string): {
    filesModified: string[];
    filesCreated: string[];
    filesDeleted: string[];
  } {
    const changes = {
      filesModified: [] as string[],
      filesCreated: [] as string[],
      filesDeleted: [] as string[]
    };

    // Patterns de détection
    const patterns = {
      modified: /Configuration.*mise à jour|updated|modifié|modified/i,
      created: /créé|created|nouveau|new file/i,
      deleted: /supprimé|deleted|removed/i
    };

    // Détection basique : si Apply-Decisions réussit, sync-config.ref.json est modifié
    if (output.includes('Configuration de référence mise à jour avec succès')) {
      changes.filesModified.push('sync-config.ref.json');
    }

    return changes;
  }
}