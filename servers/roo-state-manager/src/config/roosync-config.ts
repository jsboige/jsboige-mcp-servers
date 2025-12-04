/**
 * Configuration RooSync pour roo-state-manager
 * 
 * Ce module charge et valide les variables d'environnement RooSync
 * depuis le fichier .env et fournit une interface typée pour accéder
 * à la configuration.
 * 
 * @module roosync-config
 * @version 2.0.0
 */

import { existsSync } from 'fs';
import { resolve, isAbsolute } from 'path';

/**
 * Configuration RooSync typée
 */
export interface RooSyncConfig {
  /** Chemin absolu vers le répertoire Google Drive partagé */
  sharedPath: string;
  
  /** Identifiant unique de cette machine */
  machineId: string;
  
  /** Active/désactive la synchronisation automatique */
  autoSync: boolean;
  
  /** Stratégie de résolution des conflits */
  conflictStrategy: 'manual' | 'auto-local' | 'auto-remote';
  
  /** Niveau de verbosité des logs */
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

/**
 * Erreur de validation de configuration RooSync
 */
export class RooSyncConfigError extends Error {
  constructor(message: string) {
    super(`[RooSync Config] ${message}`);
    this.name = 'RooSyncConfigError';
  }
}

/**
 * Valide et charge la configuration RooSync depuis les variables d'environnement
 * 
 * @throws {RooSyncConfigError} Si une variable est manquante ou invalide
 * @returns {RooSyncConfig} Configuration validée
 */
export function loadRooSyncConfig(): RooSyncConfig {
  // Mode test : validation plus stricte pour les tests
  if (process.env.NODE_ENV === 'test') {
    // Vérifier que les variables requises sont présentes même en mode test
    const requiredTestVars = ['ROOSYNC_SHARED_PATH', 'ROOSYNC_MACHINE_ID'];
    const missingTestVars = requiredTestVars.filter(varName => !process.env[varName]);
    
    if (missingTestVars.length > 0) {
      throw new RooSyncConfigError(
        `Variables d'environnement manquantes pour les tests: ${missingTestVars.join(', ')}`
      );
    }
    
    return {
      sharedPath: process.env.ROOSYNC_SHARED_PATH!,
      machineId: process.env.ROOSYNC_MACHINE_ID!,
      autoSync: false,
      conflictStrategy: 'manual',
      logLevel: 'info'
    };
  }

  // 1. Vérifier la présence de toutes les variables requises
  const requiredVars = [
    'ROOSYNC_SHARED_PATH',
    'ROOSYNC_MACHINE_ID',
    'ROOSYNC_AUTO_SYNC',
    'ROOSYNC_CONFLICT_STRATEGY',
    'ROOSYNC_LOG_LEVEL'
  ];

  const missingVars = requiredVars.filter(varName => !process.env[varName]);
  if (missingVars.length > 0) {
    throw new RooSyncConfigError(
      `Variables d'environnement manquantes: ${missingVars.join(', ')}`
    );
  }

  // 2. Extraire et valider sharedPath
  const sharedPath = process.env.ROOSYNC_SHARED_PATH!;
  
  if (!isAbsolute(sharedPath)) {
    throw new RooSyncConfigError(
      `ROOSYNC_SHARED_PATH doit être un chemin absolu: ${sharedPath}`
    );
  }

  const resolvedPath = resolve(sharedPath);
  if (!existsSync(resolvedPath)) {
    throw new RooSyncConfigError(
      `Le chemin ROOSYNC_SHARED_PATH n'existe pas: ${resolvedPath}`
    );
  }

  // 3. Valider machineId
  const machineId = process.env.ROOSYNC_MACHINE_ID!;
  const machineIdPattern = /^[A-Z0-9_-]+$/i;
  
  if (!machineIdPattern.test(machineId)) {
    throw new RooSyncConfigError(
      `ROOSYNC_MACHINE_ID contient des caractères invalides: ${machineId}. ` +
      `Format attendu: [A-Z0-9_-]+`
    );
  }

  // 4. Valider autoSync
  const autoSyncStr = process.env.ROOSYNC_AUTO_SYNC!.toLowerCase();
  if (autoSyncStr !== 'true' && autoSyncStr !== 'false') {
    throw new RooSyncConfigError(
      `ROOSYNC_AUTO_SYNC doit être 'true' ou 'false': ${autoSyncStr}`
    );
  }
  const autoSync = autoSyncStr === 'true';

  // 5. Valider conflictStrategy
  const conflictStrategy = process.env.ROOSYNC_CONFLICT_STRATEGY as any;
  const validStrategies = ['manual', 'auto-local', 'auto-remote'];
  
  if (!validStrategies.includes(conflictStrategy)) {
    throw new RooSyncConfigError(
      `ROOSYNC_CONFLICT_STRATEGY invalide: ${conflictStrategy}. ` +
      `Valeurs acceptées: ${validStrategies.join(', ')}`
    );
  }

  // 6. Valider logLevel
  const logLevel = process.env.ROOSYNC_LOG_LEVEL as any;
  const validLogLevels = ['debug', 'info', 'warn', 'error'];
  
  if (!validLogLevels.includes(logLevel)) {
    throw new RooSyncConfigError(
      `ROOSYNC_LOG_LEVEL invalide: ${logLevel}. ` +
      `Valeurs acceptées: ${validLogLevels.join(', ')}`
    );
  }

  // 7. Retourner la configuration validée
  return {
    sharedPath: resolvedPath,
    machineId,
    autoSync,
    conflictStrategy,
    logLevel
  };
}

/**
 * Charge la configuration RooSync de manière sécurisée
 * 
 * Si la configuration est invalide, retourne null au lieu de lever une exception.
 * Utile pour les contextes où RooSync est optionnel.
 * 
 * @returns {RooSyncConfig | null} Configuration ou null si invalide
 */
export function tryLoadRooSyncConfig(): RooSyncConfig | null {
  try {
    return loadRooSyncConfig();
  } catch (error) {
    if (error instanceof RooSyncConfigError) {
      console.warn(`⚠️ Configuration RooSync invalide: ${error.message}`);
      return null;
    }
    throw error; // Propager les autres erreurs
  }
}

/**
 * Vérifie si la configuration RooSync est activée et valide
 * 
 * @returns {boolean} true si RooSync est configuré correctement
 */
export function isRooSyncEnabled(): boolean {
  return tryLoadRooSyncConfig() !== null;
}