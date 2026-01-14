/**
 * Types d'erreurs structurés pour RooSync State Manager
 *
 * Ce fichier définit les codes d'erreur et les classes d'erreur
 * pour une gestion explicite et cohérente des erreurs dans tous les services.
 */

/**
 * Classe de base pour toutes les erreurs du State Manager
 */
export class StateManagerError extends Error {
  public readonly code: string;
  public readonly service: string;
  public readonly details?: any;
  public readonly cause?: Error;

  constructor(
    message: string,
    code: string,
    service: string,
    details?: any,
    cause?: Error
  ) {
    super(message);
    this.name = 'StateManagerError';
    this.code = code;
    this.service = service;
    this.details = details;
    this.cause = cause;

    // Maintient la trace de la pile d'appels correcte
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, StateManagerError);
    }
  }

  /**
   * Retourne une représentation JSON de l'erreur
   */
  toJSON(): Record<string, any> {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      service: this.service,
      details: this.details,
      cause: this.cause ? {
        name: this.cause.name,
        message: this.cause.message
      } : undefined
    };
  }
}

/**
 * Codes d'erreur pour ConfigService
 */
export enum ConfigServiceErrorCode {
  CONFIG_NOT_FOUND = 'CONFIG_NOT_FOUND',
  CONFIG_LOAD_FAILED = 'CONFIG_LOAD_FAILED',
  CONFIG_SAVE_FAILED = 'CONFIG_SAVE_FAILED',
  CONFIG_INVALID = 'CONFIG_INVALID',
  CONFIG_VERSION_READ_FAILED = 'CONFIG_VERSION_READ_FAILED',
  CONFIG_PATH_NOT_FOUND = 'CONFIG_PATH_NOT_FOUND',
  SHARED_STATE_PATH_NOT_FOUND = 'SHARED_STATE_PATH_NOT_FOUND'
}

/**
 * Erreur spécifique pour ConfigService
 */
export class ConfigServiceError extends StateManagerError {
  constructor(
    message: string,
    code: ConfigServiceErrorCode,
    details?: any,
    cause?: Error
  ) {
    super(message, code, 'ConfigService', details, cause);
    this.name = 'ConfigServiceError';
  }
}

/**
 * Codes d'erreur pour IdentityManager
 */
export enum IdentityManagerErrorCode {
  REGISTRY_LOAD_FAILED = 'REGISTRY_LOAD_FAILED',
  REGISTRY_SAVE_FAILED = 'REGISTRY_SAVE_FAILED',
  COLLECTION_FAILED = 'COLLECTION_FAILED',
  VALIDATION_FAILED = 'VALIDATION_FAILED',
  IDENTITY_CONFLICT = 'IDENTITY_CONFLICT',
  IDENTITY_NOT_FOUND = 'IDENTITY_NOT_FOUND',
  CLEANUP_FAILED = 'CLEANUP_FAILED',
  PRESENCE_READ_FAILED = 'PRESENCE_READ_FAILED',
  BASELINE_READ_FAILED = 'BASELINE_READ_FAILED',
  DASHBOARD_READ_FAILED = 'DASHBOARD_READ_FAILED'
}

/**
 * Erreur spécifique pour IdentityManager
 */
export class IdentityManagerError extends StateManagerError {
  constructor(
    message: string,
    code: IdentityManagerErrorCode,
    details?: any,
    cause?: Error
  ) {
    super(message, code, 'IdentityManager', details, cause);
    this.name = 'IdentityManagerError';
  }
}

/**
 * Codes d'erreur pour BaselineLoader
 */
export enum BaselineLoaderErrorCode {
  BASELINE_NOT_FOUND = 'BASELINE_NOT_FOUND',
  BASELINE_LOAD_FAILED = 'BASELINE_LOAD_FAILED',
  BASELINE_INVALID = 'BASELINE_INVALID',
  BASELINE_PARSE_FAILED = 'BASELINE_PARSE_FAILED',
  BASELINE_TRANSFORM_FAILED = 'BASELINE_TRANSFORM_FAILED',
  BASELINE_VALIDATION_FAILED = 'BASELINE_VALIDATION_FAILED',
  BASELINE_READ_FAILED = 'BASELINE_READ_FAILED'
}

/**
 * Erreur spécifique pour BaselineLoader
 */
export class BaselineLoaderError extends StateManagerError {
  constructor(
    message: string,
    code: BaselineLoaderErrorCode,
    details?: any,
    cause?: Error
  ) {
    super(message, code, 'BaselineLoader', details, cause);
    this.name = 'BaselineLoaderError';
  }
}

/**
 * Codes d'erreur pour BaselineService (héritage de baseline.ts)
 */
export enum BaselineServiceErrorCode {
  BASELINE_NOT_FOUND = 'BASELINE_NOT_FOUND',
  BASELINE_INVALID = 'BASELINE_INVALID',
  COMPARISON_FAILED = 'COMPARISON_FAILED',
  DECISION_NOT_FOUND = 'DECISION_NOT_FOUND',
  DECISION_INVALID_STATUS = 'DECISION_INVALID_STATUS',
  APPLICATION_FAILED = 'APPLICATION_FAILED',
  INVENTORY_COLLECTION_FAILED = 'INVENTORY_COLLECTION_FAILED',
  ROADMAP_UPDATE_FAILED = 'ROADMAP_UPDATE_FAILED'
}

/**
 * Erreur spécifique pour BaselineService
 */
export class BaselineServiceError extends StateManagerError {
  constructor(
    message: string,
    code: BaselineServiceErrorCode,
    details?: any,
    cause?: Error
  ) {
    super(message, code, 'BaselineService', details, cause);
    this.name = 'BaselineServiceError';
  }
}

/**
 * Codes d'erreur génériques
 */
export enum GenericErrorCode {
  UNKNOWN_ERROR = 'UNKNOWN_ERROR',
  FILE_SYSTEM_ERROR = 'FILE_SYSTEM_ERROR',
  NETWORK_ERROR = 'NETWORK_ERROR',
  PERMISSION_DENIED = 'PERMISSION_DENIED',
  TIMEOUT = 'TIMEOUT',
  INVALID_ARGUMENT = 'INVALID_ARGUMENT'
}

/**
 * Erreur générique
 */
export class GenericError extends StateManagerError {
  constructor(
    message: string,
    code: GenericErrorCode,
    details?: any,
    cause?: Error
  ) {
    super(message, code, 'Generic', details, cause);
    this.name = 'GenericError';
  }
}

/**
 * Fonction utilitaire pour créer une erreur StateManagerError
 * à partir d'une erreur JavaScript standard
 */
export function createErrorFromStandardError(
  error: unknown,
  defaultCode: string,
  service: string,
  defaultMessage?: string
): StateManagerError {
  if (error instanceof StateManagerError) {
    return error;
  }

  if (error instanceof Error) {
    return new StateManagerError(
      defaultMessage || error.message,
      defaultCode,
      service,
      { originalError: error.name },
      error
    );
  }

  return new StateManagerError(
    defaultMessage || String(error),
    defaultCode,
    service,
    { originalValue: error }
  );
}

/**
 * Fonction utilitaire pour vérifier si une erreur est d'un type spécifique
 */
export function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof StateManagerError && error.code === code;
}

/**
 * Fonction utilitaire pour vérifier si une erreur est d'un service spécifique
 */
export function isServiceError(error: unknown, service: string): boolean {
  return error instanceof StateManagerError && error.service === service;
}
